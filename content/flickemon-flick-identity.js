/**
 * Who is signed in to Flick itself
 * ────────────────────────────────
 * The problem this solves is a faculty library PC. Chrome there is signed in to
 * half a dozen Google accounts at once, and Google's chooser offers all of them.
 * A student who opens Flick with their own account can then sign in to Flickémon
 * as somebody else — by accident, from a chooser where their own name is third
 * in a list, or deliberately. Either way the wrong account collects their study
 * time, and the previous student's party, Pokédex and friends are on screen.
 *
 * The domain check in firebase-config.js cannot help: on a faculty machine every
 * one of those accounts is @docchula.com. Nor can firestore.rules, which knows
 * the Firebase token and nothing whatsoever about a Flick session.
 *
 * So the rule is: the Google account signing in to Flickémon must be the account
 * already signed in to Flick on this machine. Flick has authenticated them
 * already; this reads that answer rather than asking a second, weaker question.
 *
 * ── What this file is, and is not ──
 *
 * It is a pure parser: sources in, an email out, no side effects and no game
 * state. That is what lets it be tested against fixture objects with no browser,
 * which matters for a reader whose whole risk is Flick changing underneath it.
 *
 * It is NOT a security boundary. Anyone running the extension unpacked can edit
 * this file out, exactly as they can edit out ALLOWED_EMAIL_DOMAINS. It stops
 * the accident and the casual opportunist on a shared machine, which is the
 * threat that actually exists in a library. A student determined to attribute
 * study time to their own account can simply watch the lecture.
 *
 * ── Where Flick keeps it ──
 *
 * Flick signs in with Firebase Auth, set up by AngularFire's plain getAuth().
 * That persists the user to IndexedDB first, and to localStorage only where
 * IndexedDB is unavailable: database `firebaseLocalStorageDb`, object store
 * `firebaseLocalStorage`, one record `{ fbase_key, value }` whose key is
 * `firebase:authUser:<apiKey>:[DEFAULT]` and whose value is the signed-in
 * user, `email` included. The record is deleted when Flick signs out.
 *
 * The first release read only localStorage, sessionStorage and the page, so it
 * found nothing and refused every sign-in. That record is now read first, and
 * because it is async, so is currentFlickIdentity().
 *
 * ── Reading order ──
 *
 * Flick's storage is not a contract, so the record above is not the only
 * thing tried. The reader goes from narrow, certain sources to broad,
 * heuristic ones, and reports WHICH one answered, so a break shows up as
 * "source changed" rather than silence.
 */
(function () {
    'use strict';

    // Deliberately permissive: this validates shape, not deliverability. A
    // stricter pattern would reject real addresses and fail closed on a
    // student who has done nothing wrong.
    const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
    const EMAIL_SCAN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

    /**
     * The key Firebase Auth keeps Flick's signed-in user under, in IndexedDB
     * or, where IndexedDB is unavailable, in localStorage. `[DEFAULT]` is the
     * Firebase app Flick initialises; any other app on the page is not Flick's
     * sign-in.
     */
    const FIREBASE_USER_KEY = /^firebase:authUser:[^:]+:\[DEFAULT\]$/;

    /** Firebase Auth's IndexedDB layout (@firebase/auth, indexeddb persistence). */
    const FIREBASE_DB = 'firebaseLocalStorageDb';
    const FIREBASE_STORE = 'firebaseLocalStorage';

    /** How long an IndexedDB read may take before it counts as unreadable. */
    const IDB_TIMEOUT_MS = 3000;

    /** Fields that carry an address, in the order they should be believed. */
    const EMAIL_FIELDS = [
        'email', 'userEmail', 'user_email', 'mail',
        'preferred_username', 'upn', 'username',
    ];

    /** Storage this extension owns. Reading our own writes back would be circular. */
    const OWN_PREFIX = /^flickemon/i;

    function normalise(value) {
        if (typeof value !== 'string') return null;
        const email = value.trim().toLowerCase();
        return EMAIL_RE.test(email) ? email : null;
    }

    /** Pull an address out of a decoded object, preferring the named fields. */
    function emailFromObject(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 4) return null;

        for (const field of EMAIL_FIELDS) {
            const found = normalise(obj[field]);
            if (found) return found;
        }
        // Flick nests the user under a session/profile wrapper in some shapes,
        // so descend rather than only reading the top level.
        for (const value of Object.values(obj)) {
            if (value && typeof value === 'object') {
                const found = emailFromObject(value, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    function parseJson(raw) {
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
        try { return JSON.parse(trimmed); } catch { return null; }
    }

    /** base64url -> object, for the payload segment of a JWT. */
    function decodeSegment(segment, decodeBase64) {
        if (typeof segment !== 'string' || segment.length < 8) return null;
        try {
            const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(decodeBase64(padded));
        } catch {
            return null;
        }
    }

    /**
     * A bearer token's middle segment. Flick authenticates with a JWT, and an
     * OIDC-issued one carries the address in its claims, so the token is often
     * the only place the email exists client-side at all.
     */
    function emailFromJwt(raw, decodeBase64) {
        if (typeof raw !== 'string') return null;
        // The token may be the whole value or a field inside a JSON blob, so
        // scan for anything token-shaped rather than requiring an exact match.
        const candidates = raw.match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g);
        if (!candidates) return null;

        for (const token of candidates) {
            const payload = decodeSegment(token.split('.')[1], decodeBase64);
            const found = emailFromObject(payload);
            if (found) return found;
        }
        return null;
    }

    /**
     * Reads the Flick account from whatever the page has.
     *
     * `sources` is passed in rather than reached for, so the whole thing runs
     * under a test with plain objects. Every field is optional; a missing or
     * throwing source is treated as absent, never as an answer.
     *
     * `firebaseUsers` is what readFirebaseUsers() got out of IndexedDB: an
     * array of `{ fbase_key, value }` records when Firebase's database could
     * be read, null when it could not or does not exist.
     *
     * Returns one of:
     *   { email, source }                  -- the account Flick is signed in as
     *   { email: null, source, signedOut } -- Firebase says nobody is signed in
     *   null                               -- could not tell
     * The last two both block sign-in, but null must NOT be read as "nobody is
     * signed in" -- conflating them is how a shared-machine guard turns into a
     * lockout, and it is what a student is told to fix.
     */
    function readFlickIdentity(sources) {
        const {
            localStorage: local,
            sessionStorage: session,
            document: doc,
            atob: decodeBase64,
            firebaseUsers,
        } = sources || {};

        const decoder = typeof decodeBase64 === 'function'
            ? decodeBase64
            : (typeof atob === 'function' ? atob : null);

        const stores = [
            ['localStorage', local],
            ['sessionStorage', session],
        ];

        /** Every readable key/value pair, with our own writes excluded. */
        const entries = [];
        for (const [name, store] of stores) {
            if (!store) continue;
            let keys;
            try { keys = Object.keys(store); } catch { continue; }
            for (const key of keys) {
                if (OWN_PREFIX.test(key)) continue;
                let value;
                try {
                    value = typeof store.getItem === 'function' ? store.getItem(key) : store[key];
                } catch { continue; }
                if (typeof value === 'string') entries.push({ name, key, value });
            }
        }

        // 1. Firebase Auth's own record of Flick's user. Exact, so it wins
        //    outright. Only `email` is read: the record's other fields hold
        //    Flick's tokens, which this has no business looking through.
        if (Array.isArray(firebaseUsers)) {
            for (const record of firebaseUsers) {
                if (!record || !FIREBASE_USER_KEY.test(String(record.fbase_key))) continue;
                const email = normalise(record.value && record.value.email);
                if (email) return { email, source: 'indexedDB:firebase:authUser' };
            }
        }

        // 2. The same record where Firebase falls back to Web Storage, when
        //    IndexedDB is unavailable.
        for (const entry of entries) {
            if (!FIREBASE_USER_KEY.test(entry.key)) continue;
            const user = parseJson(entry.value);
            const email = normalise(user && user.email);
            if (email) return { email, source: `${entry.name}:firebase:authUser` };
        }

        // 3. Firebase's database was read and holds no user: Flick is signed
        //    out. That is definitive, so the guesses below are not consulted --
        //    on a shared PC, an address one of them turned up would most likely
        //    be the previous student's.
        if (Array.isArray(firebaseUsers)) {
            return { email: null, source: 'indexedDB:firebase', signedOut: true };
        }

        // 4. A structured value with a recognised field. Still precise: the
        //    address is where a user record says it is, not merely nearby.
        for (const entry of entries) {
            const found = emailFromObject(parseJson(entry.value));
            if (found) return { email: found, source: `${entry.name}:${entry.key}` };
        }

        // 5. A JWT's claims.
        if (decoder) {
            for (const entry of entries) {
                const found = emailFromJwt(entry.value, decoder);
                if (found) return { email: found, source: `${entry.name}:${entry.key}:jwt` };
            }
        }

        // 6. The page itself, last and least. Flick renders the signed-in
        //    address in its account menu; markup moves, so this is a fallback
        //    rather than the plan.
        if (doc && typeof doc.querySelector === 'function') {
            let link = null;
            try { link = doc.querySelector('a[href^="mailto:"]'); } catch { link = null; }
            const href = link && typeof link.getAttribute === 'function'
                ? link.getAttribute('href') : null;
            const mailto = normalise(String(href || '').replace(/^mailto:/i, '').split('?')[0]);
            if (mailto) return { email: mailto, source: 'dom:mailto' };
        }

        // 7. A bare address in a plain storage value. Broadest of all, so it
        //    runs only once everything structured has declined to answer.
        for (const entry of entries) {
            const scan = entry.value.match(EMAIL_SCAN_RE);
            const found = scan && normalise(scan[0]);
            if (found) return { email: found, source: `${entry.name}:${entry.key}:scan` };
        }

        return null;
    }

    /**
     * Firebase Auth's records from IndexedDB: an array, or null when the
     * database is absent or cannot be read. Never throws, never hangs.
     *
     * The database is opened without a version and never created. Opening a
     * name that does not exist would otherwise create it empty, and Firebase,
     * finding no object store in it, deletes and rebuilds it -- under Flick's
     * feet. So creation is aborted, and an absent database reads as null.
     */
    function readFirebaseUsers(idb, { timeoutMs = IDB_TIMEOUT_MS } = {}) {
        if (!idb || typeof idb.open !== 'function') return Promise.resolve(null);

        return new Promise((resolve) => {
            let settled = false;
            let db = null;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // Closed at once: an open connection would hold up Firebase if
                // it ever needs to delete or upgrade its own database.
                try { if (db) db.close(); } catch { /* already closed */ }
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);

            let request;
            try { request = idb.open(FIREBASE_DB); } catch { finish(null); return; }

            request.onupgradeneeded = () => {
                // Only reached when the database does not exist yet.
                try { request.transaction.abort(); } catch { /* aborting anyway */ }
                finish(null);
            };
            request.onerror = () => finish(null);
            request.onblocked = () => finish(null);
            request.onsuccess = () => {
                db = request.result;
                if (settled) { finish(null); return; }
                try {
                    if (!db.objectStoreNames.contains(FIREBASE_STORE)) { finish(null); return; }
                    const all = db.transaction(FIREBASE_STORE, 'readonly')
                        .objectStore(FIREBASE_STORE).getAll();
                    all.onsuccess = () => finish(Array.isArray(all.result) ? all.result : null);
                    all.onerror = () => finish(null);
                } catch {
                    finish(null);
                }
            };
        });
    }

    /** The live page's sources, for callers that are actually in a browser. */
    function currentSources() {
        const sources = { atob: typeof atob === 'function' ? atob : null };
        try { sources.localStorage = window.localStorage; } catch { sources.localStorage = null; }
        try { sources.sessionStorage = window.sessionStorage; } catch { sources.sessionStorage = null; }
        try { sources.document = document; } catch { sources.document = null; }
        try { sources.indexedDB = window.indexedDB; } catch { sources.indexedDB = null; }
        return sources;
    }

    /**
     * Convenience wrapper: read the running page. Async, because Firebase keeps
     * the user in IndexedDB. Never rejects.
     */
    async function currentFlickIdentity() {
        try {
            const sources = currentSources();
            sources.firebaseUsers = await readFirebaseUsers(sources.indexedDB);
            return readFlickIdentity(sources);
        } catch {
            return null;
        }
    }

    /**
     * Do these two addresses belong to the same person?
     *
     * Case and surrounding space only. Gmail's dots-and-plus aliasing is
     * deliberately NOT normalised away: faculty Workspace domains do not
     * generally apply those rules, and quietly treating two distinct addresses
     * as one is the wrong failure for a guard about account identity.
     */
    function sameAccount(a, b) {
        const left = normalise(a), right = normalise(b);
        return Boolean(left && right && left === right);
    }

    const api = {
        readFlickIdentity, readFirebaseUsers, currentFlickIdentity, currentSources, sameAccount,
    };

    if (typeof window !== 'undefined') window.FlickemonFlickIdentity = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
