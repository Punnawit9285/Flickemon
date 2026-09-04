/**
 * Firestore REST Client (no SDK)
 * ──────────────────────────────
 * One document per student at saves/{uid}.
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

function docUrl(uid) {
    return `${BASE()}/${SAVES_COLLECTION}/${uid}`;
}

/** The resource name a commit addresses, which is the URL without the host. */
function docName(uid) {
    return `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents` +
           `/${SAVES_COLLECTION}/${uid}`;
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
export async function pullState({ since } = {}) {
    const auth = await getIdToken();
    if (!auth) return { signedIn: false, state: null };

    if (since) {
        const fresh = await fetch(`${docUrl(auth.uid)}?mask.fieldPaths=serverAt`, {
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

    const res = await fetch(docUrl(auth.uid), {
        headers: { Authorization: `Bearer ${auth.idToken}` },
    });

    if (res.status === 404) return { signedIn: true, state: null };
    if (!res.ok) throw new Error(`Cloud read failed (${res.status})`);

    const doc = await res.json();
    const serverAt = doc.fields?.serverAt?.timestampValue || null;
    const raw = doc.fields?.state?.stringValue;
    if (!raw) return { signedIn: true, state: null, serverAt };

    try {
        return { signedIn: true, state: JSON.parse(raw), serverAt };
    } catch {
        // Corrupt blob shouldn't wipe local progress — treat as "no cloud save".
        console.warn('[Flickémon] Cloud save was unreadable, ignoring it');
        return { signedIn: true, state: null };
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
export async function pushState(state) {
    const auth = await getIdToken();
    if (!auth) return { signedIn: false };

    const caughtCount = (state.pokedex || []).filter(e => e.caught).length;

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
                name: docName(auth.uid),
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

    if (!res.ok) throw new Error(`Cloud write failed (${res.status})`);

    // commitTime is the same clock serverAt was stamped from, so recording it
    // stops the next poll pulling back the document this device just wrote.
    const out = await res.json().catch(() => null);
    return { signedIn: true, ok: true, serverAt: out?.commitTime || null };
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
