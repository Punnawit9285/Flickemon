/**
 * Trading over Firestore REST
 * ───────────────────────────
 * One document at trades/{code}, where {code} is the HOST's 6-digit code — the
 * same derived code PVP uses, so a student has one number to share for both.
 *
 * The flow mirrors a link trade: both sides put a Pokémon on the table, both
 * see both offers, and nothing moves until both have confirmed. Changing your
 * offer clears both confirmations, so you can never confirm against an offer
 * that has since changed underneath you.
 *
 * ⚠️ There is no server referee, and that has a limit worth stating plainly.
 * Each client applies the trade to its own save after reading `phase: 'done'`.
 * If one side's browser dies in the window between those two things, that side
 * keeps what it had while the other has already swapped — a duplicate on one
 * account and a loss on the other. The document is therefore kept until BOTH
 * sides acknowledge, so a client that comes back finishes the trade instead of
 * missing it, and engine.applyTrade is idempotent on tradeId so a replay cannot
 * charge twice. A genuinely atomic swap needs a Cloud Function, which the free
 * tier and the no-build-step constraint both rule out for now.
 *
 * The offer itself is unvalidated: a modified client can put a level-100 shiny
 * on the table that it never owned. Same trust model as PVP — this is for
 * trading with the person sitting next to you.
 */

import { FIREBASE_CONFIG, TRADES_COLLECTION } from './firebase-config.js';
import { getIdToken } from './auth.js';
import { codeForUid } from './pvp.js';

function docUrl(code) {
    return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}` +
           `/databases/(default)/documents/${TRADES_COLLECTION}/${code}`;
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
    if (!a) throw new Error('Sign in to trade.');
    return a;
}

async function write(code, data, idToken) {
    const res = await fetch(docUrl(code), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toFields(data)),
    });
    if (!res.ok) throw new Error(`Could not update the trade (${res.status})`);
}

/** Opens (or replaces) this student's own trade table. */
export async function openTrade({ displayName }) {
    const a = await auth();
    const code = codeForUid(a.uid);

    await write(code, {
        host: a.uid,
        hostName: displayName || a.email || 'Trainer',
        guest: '',
        guestName: '',
        state: {
            phase: 'waiting',
            hostOffer: null, guestOffer: null,
            hostConfirmed: false, guestConfirmed: false,
            hostApplied: false, guestApplied: false,
            tradeId: null,
        },
    }, a.idToken);

    return { code, uid: a.uid };
}

/** Reads a trade. Returns null when the code has no table open. */
export async function readTrade(code) {
    const a = await auth();
    const res = await fetch(docUrl(code), { headers: { Authorization: `Bearer ${a.idToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not read the trade (${res.status})`);
    return { ...fromDoc(await res.json()), code, me: a.uid };
}

/** Sits down at someone else's table. */
export async function joinTrade(code, { displayName }) {
    const a = await auth();
    const trade = await readTrade(code);

    if (!trade) throw new Error(`No trainer is waiting on code ${code}.`);
    if (trade.host === a.uid) throw new Error("That's your own code — share it with someone else.");
    if (trade.guest && trade.guest !== a.uid) throw new Error('That trainer is already trading.');

    await write(code, {
        ...trade,
        guest: a.uid,
        guestName: displayName || a.email || 'Trainer',
        state: { ...trade.state, phase: 'offering' },
    }, a.idToken);

    return { code, uid: a.uid, role: 'guest' };
}

/**
 * Puts a Pokémon on the table, or takes it back with `offer: null`.
 *
 * Changing what is on offer clears BOTH confirmations. Without that, a trainer
 * could confirm, wait for the other to confirm, then swap in something worthless
 * and let the trade complete against an offer nobody agreed to.
 */
export async function offerPokemon(code, offer) {
    const a = await auth();
    const trade = await readTrade(code);
    if (!trade) throw new Error('That trade has ended.');

    const isHost = trade.host === a.uid;
    const state = {
        ...trade.state,
        [isHost ? 'hostOffer' : 'guestOffer']: offer,
        hostConfirmed: false,
        guestConfirmed: false,
    };

    await write(code, { ...trade, state }, a.idToken);
    return { ok: true };
}

/** Confirms, or withdraws a confirmation. */
export async function confirmTrade(code, confirmed) {
    const a = await auth();
    const trade = await readTrade(code);
    if (!trade) throw new Error('That trade has ended.');

    const isHost = trade.host === a.uid;
    const state = { ...trade.state, [isHost ? 'hostConfirmed' : 'guestConfirmed']: confirmed !== false };

    // Both sides in with something on the table: seal it. The tradeId is what
    // makes applying it idempotent on each account.
    if (state.hostConfirmed && state.guestConfirmed && state.hostOffer && state.guestOffer) {
        state.phase = 'done';
        state.tradeId = state.tradeId || `${code}-${Date.now()}-${trade.host.slice(0, 6)}`;
    }

    await write(code, { ...trade, state }, a.idToken);
    return { ok: true, sealed: state.phase === 'done' };
}

/**
 * Records that this side has applied the swap to its own save. The document
 * survives until both have, so a client that dropped out can come back and
 * finish rather than silently losing the trade.
 */
export async function acknowledgeTrade(code) {
    const a = await auth();
    const trade = await readTrade(code);
    if (!trade) return { ok: true, gone: true };

    const isHost = trade.host === a.uid;
    const state = { ...trade.state, [isHost ? 'hostApplied' : 'guestApplied']: true };
    await write(code, { ...trade, state }, a.idToken);
    return { ok: true, bothApplied: Boolean(state.hostApplied && state.guestApplied) };
}

/** Host clears the table. */
export async function closeTrade(code) {
    const a = await auth();
    const res = await fetch(docUrl(code), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${a.idToken}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Could not close the trade (${res.status})`);
    return { ok: true };
}
