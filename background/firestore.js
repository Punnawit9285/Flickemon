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

import { FIREBASE_CONFIG, SAVES_COLLECTION } from './firebase-config.js';
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
