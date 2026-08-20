/**
 * Flickémon Background Service Worker
 * ───────────────────────────────────
 * Owns every network call. Content scripts run inside docchula.com's page
 * context, so routing auth + Firestore traffic through here keeps the
 * extension's credentials away from the host page and sidesteps host-page CSP.
 *
 * MV3 evicts this worker after ~30s idle, so it holds NO durable state; tokens
 * live in chrome.storage.local and every handler re-reads what it needs.
 * Periodic polling is driven by the content script, which outlives this worker.
 */

import { isConfigured } from './firebase-config.js';
import { signIn, signOut, getStatus, switchAccount } from './auth.js';
import { pullState, pushState, checkAdmin } from './firestore.js';
import { codeForUid, openLobby, readBattle, joinBattle, submitAction, commitTurn, closeLobby } from './pvp.js';

/** Offline pushes park here until connectivity returns. */
const PENDING_KEY = 'flickemon_pending_push_v1';

async function queuePendingPush(state) {
    await chrome.storage.local.set({ [PENDING_KEY]: { state, queuedAt: Date.now() } });
}

async function takePendingPush() {
    const data = await chrome.storage.local.get([PENDING_KEY]);
    const pending = data && data[PENDING_KEY];
    if (pending) await chrome.storage.local.remove([PENDING_KEY]);
    return pending || null;
}

async function hasPendingPush() {
    const data = await chrome.storage.local.get([PENDING_KEY]);
    return Boolean(data && data[PENDING_KEY]);
}

/**
 * Pushes state, parking it for later if the network is down. A queued push is
 * always the newest state, so a single slot is enough — no unbounded queue.
 */
async function pushWithRetry(state) {
    try {
        const result = await pushState(state);
        if (!result.signedIn) return { ok: false, reason: 'signed-out' };

        // Drain anything queued earlier; the state we just wrote supersedes it.
        await takePendingPush();
        return { ok: true, syncedAt: Date.now() };
    } catch (err) {
        await queuePendingPush(state);
        return { ok: false, reason: 'offline', error: String(err.message || err) };
    }
}

const handlers = {
    async SYNC_CONFIGURED() {
        return { configured: isConfigured() };
    },

    async AUTH_STATUS() {
        const status = await getStatus();
        return {
            configured: isConfigured(),
            signedIn: Boolean(status),
            email: status?.email || null,
            uid: status?.uid || null,
            pending: await hasPendingPush(),
        };
    },

    async AUTH_SIGN_IN(msg) {
        // `prompt` lets the caller force Google's account chooser (switch account).
        const { uid, email } = await signIn({ prompt: msg.prompt });
        return { ok: true, uid, email };
    },

    async AUTH_SIGN_OUT() {
        await signOut();
        return { ok: true };
    },

    async AUTH_SWITCH() {
        await switchAccount();
        return { ok: true };
    },

    async AUTH_IS_ADMIN() {
        return await checkAdmin();
    },

    // ── PVP ──
    async PVP_MY_CODE() {
        const status = await getStatus();
        if (!status) return { signedIn: false, code: null };
        return { signedIn: true, code: codeForUid(status.uid), uid: status.uid, email: status.email };
    },
    async PVP_OPEN(msg)   { return await openLobby(msg.payload); },
    async PVP_READ(msg)   { return { battle: await readBattle(msg.code) }; },
    async PVP_JOIN(msg)   { return await joinBattle(msg.code, msg.payload); },
    async PVP_ACTION(msg) { return await submitAction(msg.code, msg.action); },
    async PVP_COMMIT(msg) { return await commitTurn(msg.code, msg.state); },
    async PVP_CLOSE(msg)  { return await closeLobby(msg.code); },

    async CLOUD_PULL() {
        return await pullState();
    },

    async CLOUD_PUSH(msg) {
        return await pushWithRetry(msg.state);
    },

    /** Retries a push parked while offline. Called opportunistically. */
    async CLOUD_FLUSH_PENDING() {
        const pending = await takePendingPush();
        if (!pending) return { ok: true, flushed: false };

        const result = await pushWithRetry(pending.state);
        return { ...result, flushed: result.ok };
    },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = handlers[msg?.type];
    if (!handler) return false;

    handler(msg)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: String(err.message || err) }));

    return true; // keep the message channel open for the async response
});
