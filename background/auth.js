/**
 * Firebase Auth via Google Sign-In (REST, no SDK)
 * ───────────────────────────────────────────────
 * MV3 forbids remote code, so the Firebase SDK can't be loaded from a CDN.
 * This talks to Firebase's REST endpoints with plain fetch() instead, which
 * keeps the extension build-step-free.
 *
 * Flow:
 *   1. chrome.identity.getAuthToken  → Google OAuth access token
 *   2. accounts:signInWithIdp        → Firebase idToken + refreshToken + uid
 *   3. securetoken refresh           → new idToken when the old one expires
 *
 * Tokens live in chrome.storage.local, NOT in memory: an MV3 service worker is
 * evicted after ~30s idle, so anything held in a module variable is lost.
 */

import { FIREBASE_CONFIG, isConfigured } from './firebase-config.js';

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

/** Google OAuth access token for the profile signed into this Chrome. */
function getGoogleToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, (token) => {
            if (chrome.runtime.lastError || !token) {
                reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in was cancelled'));
                return;
            }
            resolve(token);
        });
    });
}

/** Drop a Google token Chrome has cached, so the next sign-in re-prompts. */
function revokeGoogleToken(token) {
    return new Promise((resolve) => {
        if (!token) return resolve();
        chrome.identity.removeCachedAuthToken({ token }, () => resolve());
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
export async function signIn() {
    if (!isConfigured()) throw new Error('Cloud sync is not configured yet (see SETUP-SYNC.md)');

    const googleToken = await getGoogleToken(true);
    const auth = await exchangeForFirebase(googleToken);
    await writeAuth({ ...auth, googleToken });
    return { uid: auth.uid, email: auth.email };
}

export async function signOut() {
    const auth = await readAuth();
    await revokeGoogleToken(auth?.googleToken);
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
