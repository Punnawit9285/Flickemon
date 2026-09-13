/**
 * Firebase Auth via Google Sign-In (REST, no SDK)
 * ───────────────────────────────────────────────
 * MV3 forbids remote code, so the Firebase SDK can't be loaded from a CDN.
 * This talks to Firebase's REST endpoints with plain fetch() instead, which
 * keeps the extension build-step-free.
 *
 * Flow:
 *   1. chrome.identity.launchWebAuthFlow → Google OAuth access token
 *   2. accounts:signInWithIdp            → Firebase idToken + refreshToken + uid
 *   3. securetoken refresh               → new idToken when the old one expires
 *
 * launchWebAuthFlow rather than getAuthToken: the latter can only return
 * accounts already signed into the Chrome profile, so a student whose Chrome
 * holds a personal Gmail could never reach their faculty account. This opens a
 * real Google chooser, so any account is reachable, and it accepts an `hd`
 * hint to pre-filter to the permitted domain.
 *
 * Tokens live in chrome.storage.local, NOT in memory: an MV3 service worker is
 * evicted after ~30s idle, so anything held in a module variable is lost.
 */

import {
    FIREBASE_CONFIG, isConfigured, isAllowedEmail, ALLOWED_EMAIL_DOMAINS, WEB_OAUTH_CLIENT_ID,
} from './firebase-config.js';
import { createMemoCache } from './cache.js';

const AUTH_KEY = 'flickemon_auth_v1';

// Refresh slightly early so a request never races token expiry.
const EXPIRY_SKEW_MS = 60000;

// A single PVP or trade action calls auth() two or three times over — once
// directly, once inside the read it performs — and the poll loop repeats that
// every couple of seconds. Each call was a storage round-trip for a value that
// changes only at sign-in, sign-out and token refresh, all of which go through
// writeAuth/clearAuth below and clear this. The worker's own eviction bounds
// how long a cached copy can live.
const authMemo = createMemoCache(30000);
const AUTH_MEMO = 'auth';

async function readAuth() {
    return await authMemo.through(AUTH_MEMO, async () => {
        const data = await chrome.storage.local.get([AUTH_KEY]);
        // through() skips caching undefined, so absence is stored as null.
        return (data && data[AUTH_KEY]) || null;
    });
}

async function writeAuth(auth) {
    authMemo.delete(AUTH_MEMO);
    await chrome.storage.local.set({ [AUTH_KEY]: auth });
    authMemo.set(AUTH_MEMO, auth);
}

async function clearAuth() {
    authMemo.delete(AUTH_MEMO);
    await chrome.storage.local.remove([AUTH_KEY]);
}

/**
 * The redirect Google must have on file, derived from the extension ID.
 *
 * Worth surfacing rather than burying: the ID is not the same in a build loaded
 * unpacked and the same code installed from the Web Store, so this value
 * differs between the machine a change is tested on and every machine it ships
 * to. When only one of the two is registered, sign-in fails for everyone else
 * with a Google error page the extension never gets to see.
 */
export function getRedirectUri() {
    return chrome.identity.getRedirectURL();
}

/** What to check when sign-in fails for a reason Google won't hand back. */
export function getAuthDiagnostics() {
    return {
        configured: isConfigured(),
        extensionId: chrome.runtime.id,
        redirectUri: getRedirectUri(),
        clientId: WEB_OAUTH_CLIENT_ID,
        allowedDomains: ALLOWED_EMAIL_DOMAINS,
    };
}

/**
 * launchWebAuthFlow cannot tell "the student closed the window" apart from
 * "Google refused the request and the student closed the error page": both end
 * with no redirect and the same lastError. So the misconfiguration that cannot
 * be detected is named in the message instead, with the value needed to fix it.
 */
function signInFailure(reason) {
    return new Error(
        `${reason} If Google showed "Error 400: redirect_uri_mismatch", this ` +
        `extension's OAuth client is missing the redirect URI ${getRedirectUri()}`
    );
}

/**
 * Same person? Case and space only.
 *
 * Gmail's dot-and-plus aliasing is deliberately NOT normalised away: faculty
 * Workspace domains do not apply those rules, and quietly treating two distinct
 * addresses as one is the wrong failure for a guard about who is who.
 */
function sameAddress(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens Google's account chooser and returns an OAuth access token.
 *
 * The chooser is forced on EVERY sign-in, not just when switching. Students
 * are usually browsing signed into a personal Google account while needing to
 * use their faculty one; without this, Google silently reuses whichever session
 * it already has and the student never gets to pick, then hits a confusing
 * "this account can't be used" rejection from the domain check.
 */
function launchGoogleAuth({ prompt, loginHint } = {}) {
    const state = randomState();
    const redirectUri = chrome.identity.getRedirectURL();

    const params = new URLSearchParams({
        client_id: WEB_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: 'openid email profile',
        state,
        include_granted_scopes: 'true',
    });
    if (prompt) params.set('prompt', prompt);

    // Pre-selects the Flick account in Google's chooser. On a library PC that
    // chooser lists every account the machine has ever used, and the student's
    // own is rarely first. It is a HINT ONLY -- Google still lets any account be
    // picked -- so it saves a misclick but decides nothing. requireEmail below
    // is what actually holds.
    if (loginHint) params.set('login_hint', loginHint);

    // Domain hint: pre-filters the chooser when exactly one domain is allowed.
    // It is only a hint — Google does not enforce it, so the real checks in
    // signIn() and firestore.rules still do the work.
    if (ALLOWED_EMAIL_DOMAINS.length === 1) params.set('hd', ALLOWED_EMAIL_DOMAINS[0]);

    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();

    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
            if (chrome.runtime.lastError || !responseUrl) {
                const reason = chrome.runtime.lastError?.message || 'Sign-in was cancelled.';
                reject(signInFailure(reason.endsWith('.') ? reason : reason + '.'));
                return;
            }

            // Implicit flow returns the token in the URL fragment.
            const fragment = new URL(responseUrl).hash.replace(/^#/, '');
            const out = new URLSearchParams(fragment);

            const err = out.get('error');
            if (err) return reject(signInFailure(`Google rejected the sign-in: ${err}.`));

            if (out.get('state') !== state) {
                return reject(new Error('Sign-in response did not match the request'));
            }

            const token = out.get('access_token');
            if (!token) return reject(new Error('Google returned no access token'));
            resolve(token);
        });
    });
}

/** Trade a Google access token for Firebase credentials. */
async function exchangeForFirebase(googleToken) {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                postBody: `access_token=${googleToken}&providerId=google.com`,
                requestUri: 'http://localhost',
                returnIdpCredential: true,
                returnSecureToken: true,
            }),
        }
    );

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Firebase sign-in failed (${res.status}): ${detail}`);
    }

    const body = await res.json();
    return {
        uid: body.localId,
        email: body.email || null,
        idToken: body.idToken,
        refreshToken: body.refreshToken,
        expiresAt: Date.now() + Number(body.expiresIn || 3600) * 1000,
    };
}

/** Swap an expired idToken for a fresh one without re-prompting the student. */
async function refreshIdToken(auth) {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
    });

    if (!res.ok) {
        // Refresh token revoked or expired — force a fresh interactive sign-in.
        await clearAuth();
        throw new Error('Session expired, please sign in again');
    }

    const body = await res.json();
    const updated = {
        ...auth,
        idToken: body.id_token,
        refreshToken: body.refresh_token || auth.refreshToken,
        expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
    };
    await writeAuth(updated);
    return updated;
}

/**
 * Interactive sign-in. Only call in response to a user gesture — Chrome
 * suppresses the account chooser otherwise.
 */
export async function signIn({ prompt = 'select_account', requireEmail = null } = {}) {
    if (!isConfigured()) throw new Error('Cloud sync is not configured yet (see SETUP-SYNC.md)');

    const googleToken = await launchGoogleAuth({ prompt, loginHint: requireEmail });
    const auth = await exchangeForFirebase(googleToken);

    // Shared-machine binding: the Google account must be the one already signed
    // in to Flick on this computer.
    //
    // A faculty library PC has a dozen Google accounts live in one Chrome
    // profile, and every one of them is @docchula.com -- so the domain check
    // below waves them all through, and firestore.rules cannot help either,
    // because a Firebase token says nothing about a Flick session. Without this
    // a student can sign in as whoever Chrome happened to offer first, and that
    // account then collects their study time.
    //
    // Checked AFTER the exchange, on the address Google itself returned, rather
    // than trusting the login_hint we asked for: the hint is advisory and the
    // student can pick past it. Nothing is persisted before it passes.
    if (requireEmail && !sameAddress(auth.email, requireEmail)) {
        await clearAuth();
        throw new Error(
            `Flick is signed in as ${requireEmail}, so Flickémon has to use that ` +
            `account too — you picked ${auth.email || 'a different account'}. ` +
            `Choose ${requireEmail} in Google's list, or sign in to Flick as ` +
            `yourself first.`
        );
    }

    // Only permitted domains may hold a save. Reject before persisting anything.
    // The student can retry immediately with a different account, because every
    // sign-in opens Google's chooser rather than reusing a cached token.
    if (!isAllowedEmail(auth.email)) {
        await clearAuth();
        const allowed = ALLOWED_EMAIL_DOMAINS.map(d => '@' + d).join(' or ');
        throw new Error(
            `${auth.email || 'That account'} can't be used. Sign in with your ${allowed} account.`
        );
    }

    await writeAuth({ ...auth, googleToken });
    return { uid: auth.uid, email: auth.email };
}

/**
 * Forgets the current account. The next sign-in passes prompt=select_account,
 * so Google shows its chooser instead of silently reusing the same session.
 */
export async function switchAccount() {
    await clearAuth();
}

export async function signOut() {
    await clearAuth();
}

/** Current session without prompting. Returns null when signed out. */
export async function getStatus() {
    if (!isConfigured()) return null;
    const auth = await readAuth();
    if (!auth) return null;
    return { uid: auth.uid, email: auth.email };
}

/**
 * A valid Firebase idToken, refreshed on demand.
 * Returns null when the student simply isn't signed in (not an error).
 */
export async function getIdToken() {
    if (!isConfigured()) return null;

    let auth = await readAuth();
    if (!auth) return null;

    if (Date.now() >= auth.expiresAt - EXPIRY_SKEW_MS) {
        auth = await refreshIdToken(auth);
    }
    return { idToken: auth.idToken, uid: auth.uid, email: auth.email };
}
