/**
 * Firebase Configuration
 * ──────────────────────
 * FILL THESE IN — see SETUP-SYNC.md for where to find each value.
 *
 * These values are NOT secrets. Firebase web API keys are public by design;
 * access is controlled by the Firestore security rules in firestore.rules,
 * which restrict every student to their own save document.
 */

export const FIREBASE_CONFIG = {
    // Firebase console → Project settings → General → Web API Key
    apiKey: 'AIzaSyD-wuNcQDX8yndxnmoZVvz8v2c6WPksz0U',

    // Firebase console → Project settings → General → Project ID
    projectId: 'flickemon-83a1b',
};

/** Sync is inert until both values above are provided. */
export function isConfigured() {
    return Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}

// Firestore collection holding one save document per student, keyed by Firebase uid.
export const SAVES_COLLECTION = 'saves';

// ─────────────────────── OAuth client ───────────────────────
//
// Auth uses chrome.identity.launchWebAuthFlow, which needs a **Web application**
// OAuth client (not a Chrome Extension one). getAuthToken was replaced because
// it can only offer Google accounts already signed into the Chrome profile —
// a student whose Chrome holds their personal Gmail could never reach their
// faculty account, which a mandatory email domain makes fatal.
//
// This defaults to the web client Firebase created for this project. Whichever
// client you use, it MUST list this exact redirect URI:
//
//     https://joaglgcgbblaoiioeebpjlbjlahiagcm.chromiumapp.org/
//
// (chrome.identity.getRedirectURL() derives it from the extension ID.)
export const WEB_OAUTH_CLIENT_ID =
    '228657760659-l874kp90l9pm0875vkku5q9pq6jvb91m.apps.googleusercontent.com';

// ─────────────────────── Who may sign in ───────────────────────
//
// ⚠️ CONFIRM THIS LIST before rolling out — an empty or wrong entry locks out
// every legitimate student. Add every domain your students' accounts actually
// use (e.g. a university domain as well as the faculty one).
//
// This list is only the friendly front door: it produces a clear error instead
// of a cryptic permission failure. It is NOT the security boundary, because
// anyone can edit an unpacked extension's JavaScript. The authoritative check
// is the matching domain rule in firestore.rules, which runs on Google's
// servers. Keep the two in sync.
export const ALLOWED_EMAIL_DOMAINS = [
    'docchula.com',
];

/** True when this address belongs to a domain permitted to sign in. */
export function isAllowedEmail(email) {
    if (!email) return false;
    const domain = String(email).toLowerCase().split('@').pop();
    return ALLOWED_EMAIL_DOMAINS.some(d => domain === d.toLowerCase());
}

// Write/read cadence (debounce intervals, local-save interval) is tuned in
// content/flickemon-engine.js, not here — this file loads as an ES module
// (background service worker), while the engine loads as a classic content
// script and can't import it.
