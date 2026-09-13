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
 * ── Reading order ──
 *
 * Flick is an Ionic/Angular app and its storage keys are not part of any
 * contract, so this does not depend on one key existing. It tries the narrow,
 * certain sources first and the broad, heuristic ones last, and reports WHICH
 * one answered, so a break shows up as "source changed" rather than silence.
 */
(function () {
    'use strict';

    // Deliberately permissive: this validates shape, not deliverability. A
    // stricter pattern would reject real addresses and fail closed on a
    // student who has done nothing wrong.
    const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
    const EMAIL_SCAN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

    /**
     * Keys Flick is known to keep the signed-in user under.
     *
     * Empty until confirmed against the live site — a guessed key that never
     * matches is worse than none, because it reads as "checked and fine". The
     * heuristic probes below cover the same ground less precisely; pinning the
     * real key here makes the read exact and skips them.
     */
    const KNOWN_KEYS = [];

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
     * Returns { email, source } or null. Null means "could not tell", which the
     * caller must NOT read as "nobody is signed in" — the two are different, and
     * conflating them is how a shared-machine guard turns into a lockout.
     */
    function readFlickIdentity(sources) {
        const {
            localStorage: local,
            sessionStorage: session,
            document: doc,
            atob: decodeBase64,
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

        // 1. A key confirmed against the live site. Exact, so it wins outright.
        for (const key of KNOWN_KEYS) {
            for (const entry of entries) {
                if (entry.key !== key) continue;
                const direct = normalise(entry.value)
                    || emailFromObject(parseJson(entry.value))
                    || (decoder && emailFromJwt(entry.value, decoder));
                if (direct) return { email: direct, source: `${entry.name}:${entry.key}` };
            }
        }

        // 2. A structured value with a recognised field. Still precise: the
        //    address is where a user record says it is, not merely nearby.
        for (const entry of entries) {
            const found = emailFromObject(parseJson(entry.value));
            if (found) return { email: found, source: `${entry.name}:${entry.key}` };
        }

        // 3. A JWT's claims.
        if (decoder) {
            for (const entry of entries) {
                const found = emailFromJwt(entry.value, decoder);
                if (found) return { email: found, source: `${entry.name}:${entry.key}:jwt` };
            }
        }

        // 4. The page itself, last and least. Flick renders the signed-in
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

        // 5. A bare address in a plain storage value. Broadest of all, so it
        //    runs only once everything structured has declined to answer.
        for (const entry of entries) {
            const scan = entry.value.match(EMAIL_SCAN_RE);
            const found = scan && normalise(scan[0]);
            if (found) return { email: found, source: `${entry.name}:${entry.key}:scan` };
        }

        return null;
    }

    /** The live page's sources, for callers that are actually in a browser. */
    function currentSources() {
        const sources = { atob: typeof atob === 'function' ? atob : null };
        try { sources.localStorage = window.localStorage; } catch { sources.localStorage = null; }
        try { sources.sessionStorage = window.sessionStorage; } catch { sources.sessionStorage = null; }
        try { sources.document = document; } catch { sources.document = null; }
        return sources;
    }

    /** Convenience wrapper: read the running page. Never throws. */
    function currentFlickIdentity() {
        try { return readFlickIdentity(currentSources()); } catch { return null; }
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

    const api = { readFlickIdentity, currentFlickIdentity, currentSources, sameAccount };

    if (typeof window !== 'undefined') window.FlickemonFlickIdentity = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
