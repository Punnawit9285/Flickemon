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
export async function openLobby({ displayName, team }) {
    const a = await auth();
    const code = codeForUid(a.uid);

    const body = toFields({
        host: a.uid,
        hostName: displayName || a.email || 'Trainer',
        guest: '',
        guestName: '',
        state: { phase: 'waiting', turn: 0, hostTeam: team, guestTeam: null, log: [] },
    });

    const res = await fetch(docUrl(code), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${a.idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Could not open lobby (${res.status})`);
    return { code, uid: a.uid };
}

/** Reads a battle. Returns null when the code has no lobby. */
export async function readBattle(code) {
    const a = await auth();
    const res = await fetch(docUrl(code), { headers: { Authorization: `Bearer ${a.idToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not read battle (${res.status})`);
    return { ...fromDoc(await res.json()), code, me: a.uid };
}

async function write(code, data, idToken) {
    const res = await fetch(docUrl(code), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toFields(data)),
    });
    if (!res.ok) throw new Error(`Could not update battle (${res.status})`);
}

/** Joins someone else's lobby by their code. */
export async function joinBattle(code, { displayName, team }) {
    const a = await auth();
    const battle = await readBattle(code);

    if (!battle) throw new Error(`No trainer is waiting on code ${code}.`);
    if (battle.host === a.uid) throw new Error("That's your own code — share it with someone else.");
    if (battle.guest && battle.guest !== a.uid) throw new Error('That trainer is already in a battle.');

    const state = {
        ...battle.state,
        phase: 'battling',
        turn: 1,
        guestTeam: team,
        hostAction: null,
        guestAction: null,
        log: [`${battle.hostName} vs ${displayName}!`],
    };

    await write(code, {
        ...battle,
        guest: a.uid,
        guestName: displayName || a.email || 'Trainer',
        state,
    }, a.idToken);

    return { code, uid: a.uid, role: 'guest' };
}

/** Submits this player's action for the current turn. */
export async function submitAction(code, action) {
    const a = await auth();
    const battle = await readBattle(code);
    if (!battle) throw new Error('That battle has ended.');

    const isHost = battle.host === a.uid;
    const state = { ...battle.state };
    state[isHost ? 'hostAction' : 'guestAction'] = { ...action, turn: state.turn };

    await write(code, { ...battle, state }, a.idToken);
    return { ok: true };
}

/** Publishes the agreed post-turn state. Either client may write it; both compute the same thing. */
export async function commitTurn(code, state) {
    const a = await auth();
    const battle = await readBattle(code);
    if (!battle) throw new Error('That battle has ended.');
    await write(code, { ...battle, state }, a.idToken);
    return { ok: true };
}

/** Host tears the lobby down when leaving. */
export async function closeLobby(code) {
    const a = await auth();
    const res = await fetch(docUrl(code), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${a.idToken}` },
    });
    // 404 just means it was already gone.
    if (!res.ok && res.status !== 404) throw new Error(`Could not close lobby (${res.status})`);
    return { ok: true };
}
