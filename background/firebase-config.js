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

// ─────────────────────────── Tuning ───────────────────────────

/** Local disk writes coalesce into at most one per this interval. */
export const LOCAL_SAVE_DEBOUNCE_MS = 1000;

/** Routine cloud pushes coalesce into at most one per this interval. */
export const CLOUD_PUSH_DEBOUNCE_MS = 45000;

/** How often an active tab re-checks the cloud for progress from another device. */
export const CLOUD_POLL_INTERVAL_MS = 90000;
