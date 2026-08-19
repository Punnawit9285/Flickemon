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

function docUrl(uid) {
    return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}` +
           `/databases/(default)/documents/${SAVES_COLLECTION}/${uid}`;
}

/**
 * Reads the student's cloud save.
 * Returns null when they have no save yet (first device) — not an error.
 */
export async function pullState() {
    const auth = await getIdToken();
    if (!auth) return { signedIn: false, state: null };

    const res = await fetch(docUrl(auth.uid), {
        headers: { Authorization: `Bearer ${auth.idToken}` },
    });

    if (res.status === 404) return { signedIn: true, state: null };
    if (!res.ok) throw new Error(`Cloud read failed (${res.status})`);

    const doc = await res.json();
    const raw = doc.fields?.state?.stringValue;
    if (!raw) return { signedIn: true, state: null };

    try {
        return { signedIn: true, state: JSON.parse(raw) };
    } catch {
        // Corrupt blob shouldn't wipe local progress — treat as "no cloud save".
        console.warn('[Flickémon] Cloud save was unreadable, ignoring it');
        return { signedIn: true, state: null };
    }
}

/** Writes the student's cloud save, replacing the whole document. */
export async function pushState(state) {
    const auth = await getIdToken();
    if (!auth) return { signedIn: false };

    const caughtCount = (state.pokedex || []).filter(e => e.caught).length;

    const body = {
        fields: {
            // Queryable columns for the admin monitoring portal.
            email: { stringValue: auth.email || '' },
            updatedAt: { integerValue: String(Date.now()) },
            totalMinutesWatched: { doubleValue: state.totalMinutesWatched || 0 },
            caughtCount: { integerValue: String(caughtCount) },
            // Full save.
            state: { stringValue: JSON.stringify(state) },
        },
    };

    const res = await fetch(docUrl(auth.uid), {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${auth.idToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Cloud write failed (${res.status})`);
    return { signedIn: true, ok: true };
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
