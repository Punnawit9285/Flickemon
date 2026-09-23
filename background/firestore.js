/**
 * Firestore REST Client (no SDK)
 * ──────────────────────────────
 * One document per save slot. Slot 1 is saves/{uid}, where every save lived
 * before there were slots, so nobody's had to move; slots 2-6 are
 * saves/{uid}/slots/{n}.
 *
 * Quota: only the slot being played is ever polled or pushed, so six slots
 * cost exactly what one did. Listing them is the only new traffic -- a masked
 * read of each document that exists, at most six, and only when the student
 * opens the save screen.
 *
 * The full game state rides as a JSON string in `state`. Firestore's 1MB
 * document limit leaves enormous headroom (a maxed save is ~50KB), and the
 * blob avoids hand-writing a serializer for Firestore's verbose typed-value
 * format. The scalar fields alongside it stay queryable so the admin
 * monitoring portal can read them without parsing every blob.
 */

import { FIREBASE_CONFIG, SAVES_COLLECTION, ADMINS_COLLECTION } from './firebase-config.js';
import { getIdToken } from './auth.js';

const BASE = () => `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}` +
                   `/databases/(default)/documents`;

export const SLOT_COUNT = 6;

/** A slot number the rules will accept, or null. */
export function validSlot(slot) {
    const n = Number(slot === undefined || slot === null ? 1 : slot);
    return Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT ? n : null;
}

/** Where a slot lives, relative to the database root. */
function slotPath(uid, slot) {
    return slot === 1
        ? `${SAVES_COLLECTION}/${uid}`
        : `${SAVES_COLLECTION}/${uid}/slots/${slot}`;
}

function docUrl(uid, slot = 1) {
    return `${BASE()}/${slotPath(uid, slot)}`;
}

/** The resource name a commit addresses, which is the URL without the host. */
function docName(uid, slot = 1) {
    return `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents` +
           `/${slotPath(uid, slot)}`;
}

/**
 * A new run's name. Random rather than a counter: two devices starting a game
 * in the same empty slot must not agree by accident.
 */
export function newGeneration() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** An HTTP failure that keeps its status, so a refusal is not mistaken for being offline. */
function httpError(message, status) {
    const err = new Error(`${message} (${status})`);
    err.status = status;
    return err;
}

/**
 * Is `a` a moment strictly after `b`? Both are Firestore RFC3339 timestamps.
 *
 * Deliberately generous about saying yes. Firestore's fractional precision is
 * not fixed, so two strings for the same instant can differ, and Date.parse
 * throws sub-millisecond detail away — two writes inside one millisecond would
 * compare equal. Anything this cannot rule out is treated as CHANGED, because
 * the cost of a wrong "yes" is one wasted fetch and the cost of a wrong "no" is
 * a device that silently stops seeing the other one.
 */
export function isNewer(a, b) {
    if (!a || !b) return true;
    if (a === b) return false;
    const ta = Date.parse(a), tb = Date.parse(b);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
    if (ta === tb) return true;      // same millisecond, different strings
    return ta > tb;
}

/**
 * Reads the student's cloud save.
 * Returns null when they have no save yet (first device) — not an error.
 *
 * With `since`, the write time is checked FIRST, using a field mask, and the
 * body is only fetched when it has actually moved on. A save is around 39 KiB
 * on the wire and the poll runs every five minutes, so a ten-hour day was
 * downloading close to five megabytes per student to discover, almost every
 * time, that nothing had happened. Three hundred students doing that was 1.9
 * GiB a day and 83% of the whole Firestore bill.
 *
 * It does NOT reduce the number of reads: a masked get is billed exactly like a
 * full one. This buys bytes, not quota.
 *
 * Every unexpected answer falls through to the full fetch. A freshness check
 * that guesses wrong stops a device seeing the other one's progress and says
 * nothing about it, which is a far worse failure than fetching too much.
 */
export async function pullState({ since, slot: rawSlot } = {}) {
    const slot = validSlot(rawSlot);
    if (!slot) throw new Error('No such save slot');
    const auth = await getIdToken();
    if (!auth) return { signedIn: false, state: null };

    if (since) {
        const fresh = await fetch(`${docUrl(auth.uid, slot)}?mask.fieldPaths=serverAt`, {
            headers: { Authorization: `Bearer ${auth.idToken}` },
        });
        if (fresh.status === 404) return { signedIn: true, state: null };
        if (fresh.ok) {
            const head = await fresh.json().catch(() => null);
            const stamp = head?.fields?.serverAt?.timestampValue;
            // A save written before serverAt existed has nothing to compare, so
            // it falls through and is fetched in full, as it always was.
            if (stamp && !isNewer(stamp, since)) {
                return { signedIn: true, unchanged: true, serverAt: stamp, state: null };
            }
        }
        // Any other status: fall through and read the document properly rather
        // than reporting "no change" on the strength of a failed request.
    }

    const res = await fetch(docUrl(auth.uid, slot), {
        headers: { Authorization: `Bearer ${auth.idToken}` },
    });

    if (res.status === 404) return { signedIn: true, state: null };
    if (!res.ok) throw new Error(`Cloud read failed (${res.status})`);

    const doc = await res.json();
    const serverAt = doc.fields?.serverAt?.timestampValue || null;
    // Which run this is. Absent on a save written before there were slots.
    const generation = doc.fields?.generation?.stringValue || null;
    // An administrator deleted this slot. See wipeSlot.
    const wiped = Boolean(doc.fields?.wipedAt?.timestampValue);
    const raw = doc.fields?.state?.stringValue;
    if (!raw) return { signedIn: true, state: null, serverAt, generation, wiped };

    try {
        return { signedIn: true, state: JSON.parse(raw), serverAt, generation, wiped };
    } catch {
        // Corrupt blob shouldn't wipe local progress — treat as "no cloud save".
        console.warn('[Flickémon] Cloud save was unreadable, ignoring it');
        return { signedIn: true, state: null, generation };
    }
}

/**
 * Writes the student's cloud save, replacing the whole document.
 *
 * Sent as a commit rather than a PATCH for one reason: `updateTransforms` is
 * the only way a REST client can ask Firestore to stamp a field with the
 * SERVER's clock. That stamp is what makes the wallet rule in firestore.rules
 * enforceable — a rate limit measured against a timestamp the client wrote
 * would be a rate limit the client sets, and a client with a skewed clock
 * would be locked out of syncing entirely. See the rule for the full argument.
 */
export async function pushState(state, { slot: rawSlot, generation } = {}) {
    const slot = validSlot(rawSlot);
    if (!slot) throw new Error('No such save slot');
    const auth = await getIdToken();
    if (!auth) return { signedIn: false };

    const caughtCount = (state.pokedex || []).filter(e => e.caught).length;
    // What the save screen shows for this slot, readable without the blob.
    const party = Array.isArray(state.party) ? state.party : [];
    const partner = party.find(p => p && p.instanceId === state.activeInstanceId) || party[0] || null;

    // Hoisted out of the blob so security rules can see them. Rules cannot read
    // inside a JSON string, so a number that has to be constrained server-side
    // has to be a field of its own — see the saves/{uid} rule for what the
    // constraint is and, just as importantly, what it is not.
    let moneyEarned = 0;
    let moneySpent = 0;
    for (const bucket of Object.values(state.shopWallet || {})) {
        moneyEarned += Number(bucket && bucket.earned) || 0;
        moneySpent += Number(bucket && bucket.spent) || 0;
    }

    const body = {
        writes: [{
            update: {
                name: docName(auth.uid, slot),
                fields: {
                    // Queryable columns for the admin monitoring portal.
                    email: { stringValue: auth.email || '' },
                    // The device's own clock, kept because the portal has always
                    // shown it. NOT the field the wallet rule trusts.
                    updatedAt: { integerValue: String(Date.now()) },
                    totalMinutesWatched: { doubleValue: state.totalMinutesWatched || 0 },
                    caughtCount: { integerValue: String(caughtCount) },
                    moneyEarned: { doubleValue: moneyEarned },
                    moneySpent: { doubleValue: moneySpent },
                    // For the save screen, so listing slots never downloads one.
                    hasStarted: { booleanValue: state.hasStarted === true },
                    partnerSpecies: { integerValue: String(Number(partner && partner.speciesId) || 0) },
                    partnerLevel: { integerValue: String(Number(partner && partner.level) || 0) },
                    partnerShiny: { booleanValue: Boolean(partner && partner.shiny) },
                    // The run. The rules refuse any change to it but an admin's
                    // wipe, which is what keeps a student from deleting a save
                    // by writing a new game over it.
                    ...(generation ? { generation: { stringValue: String(generation) } } : {}),
                    // Full save.
                    state: { stringValue: JSON.stringify(state) },
                },
            },
            // Stamped by the server, and required by the rules to equal the
            // commit time — so it cannot be back-dated to widen the next
            // write's allowance.
            updateTransforms: [
                { fieldPath: 'serverAt', setToServerValue: 'REQUEST_TIME' },
            ],
        }],
    };

    const res = await fetch(`${BASE()}:commit`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${auth.idToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) throw httpError('Cloud write failed', res.status);

    // commitTime is the same clock serverAt was stamped from, so recording it
    // stops the next poll pulling back the document this device just wrote.
    const out = await res.json().catch(() => null);
    return { signedIn: true, ok: true, serverAt: out?.commitTime || null };
}

const SUMMARY_FIELDS = ['serverAt', 'updatedAt', 'hasStarted', 'caughtCount',
                        'totalMinutesWatched', 'partnerSpecies', 'partnerLevel',
                        'partnerShiny', 'generation', 'wipedAt'];

/** One slot's document, reduced to what the save screen shows. */
function summarize(slot, doc) {
    const f = (doc && doc.fields) || {};
    const num = v => Number(v && (v.integerValue ?? v.doubleValue)) || 0;
    return {
        slot,
        exists: Boolean(doc),
        hasStarted: f.hasStarted?.booleanValue === true
            // A save written before this field existed: it has a wallet or a
            // Pokédex, so a game was started in it.
            || (f.hasStarted === undefined && Boolean(doc) && !f.wipedAt
                && (num(f.caughtCount) > 0 || num(f.totalMinutesWatched) > 0)),
        caughtCount: num(f.caughtCount),
        totalMinutesWatched: num(f.totalMinutesWatched),
        partnerSpecies: num(f.partnerSpecies) || null,
        partnerLevel: num(f.partnerLevel) || null,
        partnerShiny: f.partnerShiny?.booleanValue === true,
        updatedAt: num(f.updatedAt) || null,
        generation: f.generation?.stringValue || null,
        wiped: Boolean(f.wipedAt),
    };
}

/**
 * Every slot, summarised, without downloading a single save.
 *
 * Two requests and at most six billed reads: slot 1 by itself, and slots 2-6
 * in one listing. Both are field-masked, so the blob -- ~39 KiB each -- never
 * travels. Only the save screen calls this.
 */
export async function listSlots() {
    const auth = await getIdToken();
    if (!auth) return { signedIn: false, slots: [] };

    const mask = SUMMARY_FIELDS.map(f => `mask.fieldPaths=${f}`).join('&');
    const headers = { Authorization: `Bearer ${auth.idToken}` };
    const [first, rest] = await Promise.all([
        fetch(`${docUrl(auth.uid, 1)}?${mask}`, { headers }),
        fetch(`${BASE()}/${SAVES_COLLECTION}/${auth.uid}/slots?pageSize=${SLOT_COUNT}&${mask}`,
              { headers }),
    ]);
    if (!first.ok && first.status !== 404) throw httpError('Could not list saves', first.status);
    if (!rest.ok && rest.status !== 404) throw httpError('Could not list saves', rest.status);

    const docs = { 1: first.ok ? await first.json() : null };
    const listing = rest.ok ? await rest.json().catch(() => ({})) : {};
    for (const doc of listing.documents || []) {
        const n = validSlot(String(doc.name || '').split('/').pop());
        if (n && n !== 1) docs[n] = doc;
    }

    const slots = [];
    for (let n = 1; n <= SLOT_COUNT; n++) slots.push(summarize(n, docs[n] || null));
    return { signedIn: true, slots };
}

/**
 * Deletes a slot. Administrators only -- the rules refuse everyone else,
 * including a student deleting their own.
 *
 * Written as an empty save under a new generation rather than a deleted
 * document. Every other device still holds a copy of the old run, and a device
 * that found the document missing would re-create it from that copy on its
 * next push, undoing the delete. Finding a generation it does not know, it
 * lets its copy go instead.
 */
export async function wipeSlot({ slot: rawSlot } = {}) {
    const slot = validSlot(rawSlot);
    if (!slot) throw new Error('No such save slot');
    const auth = await getIdToken();
    if (!auth) return { signedIn: false, ok: false };

    const generation = newGeneration();
    const res = await fetch(`${BASE()}:commit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            writes: [{
                update: {
                    name: docName(auth.uid, slot),
                    fields: { generation: { stringValue: generation } },
                },
                updateTransforms: [
                    { fieldPath: 'wipedAt', setToServerValue: 'REQUEST_TIME' },
                    { fieldPath: 'serverAt', setToServerValue: 'REQUEST_TIME' },
                ],
            }],
        }),
    });
    if (res.status === 403) return { signedIn: true, ok: false, reason: 'forbidden' };
    if (!res.ok) throw httpError('Could not delete the save', res.status);
    const out = await res.json().catch(() => null);
    return { signedIn: true, ok: true, slot, generation, serverAt: out?.commitTime || null };
}

/**
 * Whether the signed-in student is an administrator.
 *
 * Admin status is a document at admins/{uid} that only the Firebase console can
 * create — security rules deny all client writes. That makes this a real check
 * rather than a shared secret: the extension's code is on the user's disk and
 * can be edited freely, so anything meaningful must be decided by the server.
 *
 * Note what this does and does not buy. It authoritatively protects anything
 * the SERVER does. It cannot stop someone editing the extension to reveal the
 * panel locally — but those tools only alter that person's own save, which they
 * could already do by editing chrome.storage directly.
 */
export async function checkAdmin() {
    const auth = await getIdToken();
    if (!auth) return { signedIn: false, isAdmin: false };

    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}` +
                `/databases/(default)/documents/${ADMINS_COLLECTION}/${auth.uid}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${auth.idToken}` } });

    // 404 = no admin document = ordinary student. 403 = rules deny = not admin.
    if (res.status === 404 || res.status === 403) return { signedIn: true, isAdmin: false };
    if (!res.ok) throw new Error(`Admin check failed (${res.status})`);

    return { signedIn: true, isAdmin: true, email: auth.email };
}
