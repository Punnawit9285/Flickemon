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
    apiKey: '',

    // Firebase console → Project settings → General → Project ID
    projectId: '',
};

/** Sync is inert until both values above are provided. */
export function isConfigured() {
    return Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}

// Firestore collection holding one save document per student, keyed by Firebase uid.
export const SAVES_COLLECTION = 'saves';

// Write/read cadence (debounce intervals, local-save interval) is tuned in
// content/flickemon-engine.js, not here — this file loads as an ES module
// (background service worker), while the engine loads as a classic content
// script and can't import it.
