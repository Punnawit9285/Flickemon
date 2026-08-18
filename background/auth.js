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

const AUTH_KEY = 'flickemon_auth_v1';

// Refresh slightly early so a request never races token expiry.
const EXPIRY_SKEW_MS = 60000;

async function readAuth() {
    const data = await chrome.storage.local.get([AUTH_KEY]);
    return (data && data[AUTH_KEY]) || null;
}

async function writeAuth(auth) {
    await chrome.storage.local.set({ [AUTH_KEY]: auth });
}

async function clearAuth() {
    await chrome.storage.local.remove([AUTH_KEY]);
}

function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens Google's account chooser and returns an OAuth access token.
 *
 * `prompt: 'select_account'` forces the chooser even when Google already has a
 * session, which is what makes "switch account" work — otherwise Google would
 * silently reuse the signed-in account.
 */
function launchGoogleAuth({ prompt } = {}) {
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

    // Domain hint: pre-filters the chooser when exactly one domain is allowed.
    // It is only a hint — Google does not enforce it, so the real checks in
    // signIn() and firestore.rules still do the work.
    if (ALLOWED_EMAIL_DOMAINS.length === 1) params.set('hd', ALLOWED_EMAIL_DOMAINS[0]);

    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();

    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
            if (chrome.runtime.lastError || !responseUrl) {
                reject(new Error(chrome.runtime.lastError?.message || 'Sign-in was cancelled'));
                return;
            }

            // Implicit flow returns the token in the URL fragment.
            const fragment = new URL(responseUrl).hash.replace(/^#/, '');
            const out = new URLSearchParams(fragment);

            const err = out.get('error');
            if (err) return reject(new Error(`Google rejected the sign-in: ${err}`));

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
export async function signIn({ prompt } = {}) {
    if (!isConfigured()) throw new Error('Cloud sync is not configured yet (see SETUP-SYNC.md)');

    const googleToken = await launchGoogleAuth({ prompt });
    const auth = await exchangeForFirebase(googleToken);

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
