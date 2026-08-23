/**
 * PVP transport over Firestore REST
 * ─────────────────────────────────
 * A battle is one document at battles/{code}, where {code} is the HOST's
 * 6-digit code. Both players read and write it; there is no server referee.
 *
 * Neither client trusts the other's arithmetic: each submits only its chosen
 * action, and both replay the turn locally through the same seeded RNG (see
 * flickemon-battle.js). Identical seeds mean identical results, so a desync
 * would require one side to run modified code — and that only corrupts their
 * own view of a friendly match.
 *
 * Polling rather than listening: Firestore's realtime channel is not reachable
 * over plain REST, and adding the SDK would break the extension's no-build-step
 * setup (MV3 forbids remote code). Turn-based play tolerates a ~1.5s poll.
 */

import { FIREBASE_CONFIG, BATTLES_COLLECTION } from './firebase-config.js';
import { getIdToken } from './auth.js';
import { readDoc, mutateDoc, invalidateDoc } from './cache.js';

function docUrl(code) {
    return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}` +
           `/databases/(default)/documents/${BATTLES_COLLECTION}/${code}`;
}

/**
 * A stable 6-digit code for a uid.
 *
 * Derived rather than allocated: no reservation, no collision bookkeeping, and
 * a student's code never changes, so it can be shared once. FNV-1a over the uid
 * gives a well-spread value; across a cohort of a few hundred the chance of a
 * clash in a million-wide space is negligible.
 */
export function codeForUid(uid) {
    let h = 2166136261;
    for (let i = 0; i < uid.length; i++) {
        h ^= uid.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return String((h >>> 0) % 1000000).padStart(6, '0');
}

function toFields(obj) {
    return {
        host:      { stringValue: obj.host || '' },
        hostName:  { stringValue: obj.hostName || '' },
        guest:     { stringValue: obj.guest || '' },
        guestName: { stringValue: obj.guestName || '' },
        updatedAt: { integerValue: String(Date.now()) },
        state:     { stringValue: JSON.stringify(obj.state || {}) },
    };
}

function fromDoc(doc) {
    const f = doc.fields || {};
    let state = {};
    try { state = JSON.parse(f.state?.stringValue || '{}'); } catch { state = {}; }
    return {
        host: f.host?.stringValue || '',
        hostName: f.hostName?.stringValue || '',
        guest: f.guest?.stringValue || '',
        guestName: f.guestName?.stringValue || '',
        updatedAt: Number(f.updatedAt?.integerValue || 0),
        state,
    };
}

async function auth() {
    const a = await getIdToken();
    if (!a) throw new Error('Sign in to use PVP.');
    return a;
}

/** Creates or replaces the caller's own lobby, ready for a challenger. */
export async function openLobby({ displayName, team, mode, rulesVersion }) {
    const a = await auth();
    const code = codeForUid(a.uid);

    const body = toFields({
        host: a.uid,
        hostName: displayName || a.email || 'Trainer',
        guest: '',
        guestName: '',
        state: {
            phase: 'waiting',
            turn: 0,
            // The host's choice of format, and the resolution contract they will
            // play it under. Both are read by the guest before they commit.
            mode,
            rulesVersion,
            hostTeam: team,
            guestTeam: null,
            hostIndex: 0,
            guestIndex: 0,
            log: [],
        },
    });

    // A fresh lobby replaces whatever was there, so this write is
    // unconditional — and any cached copy of the old document must go.
    invalidateDoc(docUrl(code));
    const res = await fetch(docUrl(code), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${a.idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: body }),
    });
    if (!res.ok) throw new Error(`Could not open lobby (${res.status})`);
    invalidateDoc(docUrl(code));
    return { code, uid: a.uid };
}

/** Reads a battle. Returns null when the code has no lobby. */
export async function readBattle(code, { fresh = true } = {}) {
    const a = await auth();
    // The poll wants the truth every time; the operations below reuse what the
    // poll just fetched, because their writes are version-checked anyway.
    const current = await readDoc(docUrl(code), a.idToken, { fresh });
    if (!current) return null;
    return { ...fromDoc(current.doc), code, me: a.uid };
}

/**
 * Read-modify-write on the shared battle.
 *
 * The write carries the version it was built from, so an action based on a
 * cached read cannot overwrite the move the opponent submitted a moment ago —
 * the server rejects it and mutateDoc rebuilds from a fresh copy.
 */
async function mutate(code, idToken, transform) {
    const res = await mutateDoc(docUrl(code), idToken, (current) => {
        if (!current) return null;
        const next = transform({ ...fromDoc(current.doc), code });
        return next ? toFields(next) : null;
    });
    if (res.aborted) throw new Error('That battle has ended.');
    if (res.conflict) throw new Error('The battle moved on. Try again.');
    return res;
}

/**
 * Joins someone else's lobby by their code.
 *
 * The rules-version check is the one thing worth failing loudly over. Nothing
 * about the document format has ever broken across releases, but turn
 * resolution runs locally on both clients from a shared seed, so two builds
 * that disagree about (say) what a fainted Pokémon does will quietly compute
 * different battles from the same moves. Refusing the match is far kinder than
 * letting them play one that only one of them can see correctly.
 */
export async function joinBattle(code, { displayName, team, rulesVersion }) {
    const a = await auth();

    await mutate(code, a.idToken, (battle) => {
        if (battle.host === a.uid) throw new Error("That's your own code — share it with someone else.");
        if (battle.guest && battle.guest !== a.uid) throw new Error('That trainer is already in a battle.');

        const theirs = battle.state?.rulesVersion || 1;
        if (theirs !== rulesVersion) {
            throw new Error(theirs < rulesVersion
                ? 'That trainer is on an older Flickémon. Ask them to update.'
                : 'That trainer is on a newer Flickémon. Update yours to battle them.');
        }

        return {
            ...battle,
            guest: a.uid,
            guestName: displayName || a.email || 'Trainer',
            state: {
                ...battle.state,
                phase: 'battling',
                turn: 1,
                guestTeam: team,
                hostIndex: 0,
                guestIndex: 0,
                hostAction: null,
                guestAction: null,
                log: [`${battle.hostName} vs ${displayName}!`],
            },
        };
    });

    return { code, uid: a.uid, role: 'guest' };
}

/** Submits this player's action for the current turn. */
export async function submitAction(code, action) {
    const a = await auth();

    await mutate(code, a.idToken, (battle) => {
        const isHost = battle.host === a.uid;
        const state = { ...battle.state };
        state[isHost ? 'hostAction' : 'guestAction'] = { ...action, turn: state.turn };
        return { ...battle, state };
    });
    return { ok: true };
}

/** Publishes the agreed post-turn state. Either client may write it; both compute the same thing. */
export async function commitTurn(code, state) {
    const a = await auth();
    await mutate(code, a.idToken, (battle) => ({ ...battle, state }));
    return { ok: true };
}

/** Host tears the lobby down when leaving. */
export async function closeLobby(code) {
    const a = await auth();
    invalidateDoc(docUrl(code));
    const res = await fetch(docUrl(code), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${a.idToken}` },
    });
    // 404 just means it was already gone.
    if (!res.ok && res.status !== 404) throw new Error(`Could not close lobby (${res.status})`);
    return { ok: true };
}
