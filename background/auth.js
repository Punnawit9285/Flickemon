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
 * How long a sign-in with no window may take. Google's silent answer is a
 * couple of redirects; a page that would need a person is given up on.
 */
const SILENT_TIMEOUT_MS = 10000;

/**
 * Asks Google for an OAuth access token.
 *
 * `prompt` is passed through: 'select_account' opens the account chooser,
 * 'none' asks for an answer without any page at all. `interactive: false`
 * opens no window, and fails rather than show one.
 *
 * Without a prompt and with a `loginHint`, Google goes straight to that one
 * account -- its consent page, its password page, or nothing at all if it is
 * signed in and has already said yes. See signIn for why that, and not the
 * chooser, is now the default.
 */
function launchGoogleAuth({ prompt, loginHint, interactive = true } = {}) {
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

    // The Flick account. Without a prompt it is where Google goes directly;
    // with the chooser it is the one pre-selected in a list that, on a library
    // PC, holds every account the machine has ever used. Either way it is a
    // HINT ONLY -- the address Google returns is checked in signIn() below, and
    // that check is what actually holds.
    if (loginHint) params.set('login_hint', loginHint);

    // Domain hint: pre-filters the chooser when exactly one domain is allowed.
    // It is only a hint — Google does not enforce it, so the real checks in
    // signIn() and firestore.rules still do the work.
    if (ALLOWED_EMAIL_DOMAINS.length === 1) params.set('hd', ALLOWED_EMAIL_DOMAINS[0]);

    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();

    // A silent attempt may pass through a page or two of Google's own redirects
    // before it lands, so it is not abandoned at the first page load.
    const details = interactive ? { url, interactive: true } : {
        url, interactive: false,
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: SILENT_TIMEOUT_MS,
    };

    return new Promise((resolve, reject) => {
        const start = (d) => chrome.identity.launchWebAuthFlow(d, (responseUrl) => {
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
        try {
            start(details);
        } catch (err) {
            // A Chrome too old for the two silent options refuses the object
            // outright. Without them a silent attempt just gives up sooner.
            if (interactive) throw err;
            start({ url, interactive: false });
        }
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
export async function signIn({ prompt, requireEmail = null, silent = false } = {}) {
    if (!isConfigured()) throw new Error('Cloud sync is not configured yet (see SETUP-SYNC.md)');

    const googleToken = await requestGoogleToken({ prompt, requireEmail, silent });
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
 * Which way to ask Google, in order.
 *
 * When Flick's account is known -- and sign-in is refused when it is not -- the
 * question is not "which account?", it is "may we have THIS one?", and the
 * chooser was the wrong way to ask it. On a library PC it lists a dozen
 * @docchula.com accounts; the right one is rarely first, the wrong pick is
 * refused afterwards, and a student can go round that loop until they give up.
 * So:
 *
 *   1. Silently, for exactly that account: no window at all. Anyone signed in
 *      to Google as the Flick account who has used Flickémon before is simply
 *      signed in.
 *   2. Interactively, but pointed at that account rather than at a list:
 *      Google shows its password or consent page for it, or nothing if it can.
 *
 * An explicit prompt -- "Use a different Google account" -- still opens the
 * chooser, and with no Flick account to aim at, so does a plain sign-in.
 */
async function requestGoogleToken({ prompt, requireEmail, silent }) {
    if (silent) {
        if (!requireEmail) throw new Error('A silent sign-in needs the Flick account to ask for.');
        return await launchGoogleAuth({ prompt: 'none', loginHint: requireEmail, interactive: false });
    }
    if (prompt) return await launchGoogleAuth({ prompt, loginHint: requireEmail });
    if (!requireEmail) return await launchGoogleAuth({ prompt: 'select_account' });

    try {
        return await launchGoogleAuth({ prompt: 'none', loginHint: requireEmail, interactive: false });
    } catch {
        return await launchGoogleAuth({ loginHint: requireEmail });
    }
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
