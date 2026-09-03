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
import { openTrade, readTrade, joinTrade, offerPokemon, confirmTrade, acknowledgeTrade, closeTrade } from './trade.js';
import { claimUsername, releaseUsername, writeProfile, lookup,
         requestFriend, acceptFriend, removeFriend, listFriendships,
         publishFeed, readFeeds, publishLeaderboard, readLeaderboard } from './friends.js';

/**
 * The music tab's id, in storage because this worker is evicted after ~30s
 * idle and a module variable would not survive to the next lecture.
 */
const MUSIC_TAB_KEY = 'flickemon_music_tab_v1';

async function getMusicTabId() {
    const data = await chrome.storage.local.get([MUSIC_TAB_KEY]);
    const id = data && data[MUSIC_TAB_KEY];
    return Number.isInteger(id) ? id : null;
}

async function setMusicTabId(id) {
    if (id === null) await chrome.storage.local.remove([MUSIC_TAB_KEY]);
    else await chrome.storage.local.set({ [MUSIC_TAB_KEY]: id });
}

// Forget the tab as soon as it closes, so reopening does not try to focus a
// tab that is not there.
if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(async (tabId) => {
        if (await getMusicTabId() === tabId) await setMusicTabId(null);
    });
}

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

    async TRADE_OPEN(msg)    { return await openTrade(msg.payload || {}); },
    async TRADE_READ(msg)    { return { trade: await readTrade(msg.code) }; },
    async TRADE_JOIN(msg)    { return await joinTrade(msg.code, msg.payload || {}); },
    async TRADE_OFFER(msg)   { return await offerPokemon(msg.code, msg.offer); },
    async TRADE_CONFIRM(msg) { return await confirmTrade(msg.code, msg.confirmed); },
    async TRADE_ACK(msg)     { return await acknowledgeTrade(msg.code); },
    async TRADE_CLOSE(msg)   { return await closeTrade(msg.code); },

    async FRIEND_CLAIM_NAME(msg)  { return await claimUsername(msg.name); },
    async FRIEND_RELEASE_NAME(msg){ return await releaseUsername(msg.name); },
    async FRIEND_PROFILE(msg)     { return await writeProfile(msg.payload || {}); },
    async FRIEND_LOOKUP(msg)      { return await lookup(msg.query || {}); },
    async FRIEND_REQUEST(msg)     { return await requestFriend(msg.uid); },
    async FRIEND_ACCEPT(msg)      { return await acceptFriend(msg.uid); },
    async FRIEND_REMOVE(msg)      { return await removeFriend(msg.uid); },
    async FRIEND_LIST(msg)        { return await listFriendships({ fresh: msg.fresh === true }); },
    async FRIEND_PUBLISH(msg)     { return await publishFeed(msg.payload || {}); },
    async FRIEND_FEEDS(msg)       { return await readFeeds(msg.uids || [], { fresh: msg.fresh === true }); },
    async FRIEND_BOARD_PUBLISH(msg) { return await publishLeaderboard(msg.payload || {}); },
    async FRIEND_BOARD_READ(msg)  { return await readLeaderboard(msg.dayKey); },

    /**
     * Opens the standalone music tab, or focuses the one already open.
     *
     * The tab's id is remembered rather than found with tabs.query({url}),
     * which would require the "tabs" permission and show every student a
     * "read your browsing history" warning at install. A music player has no
     * business asking for that.
     */
    async MUSIC_OPEN_TAB() {
        const known = await getMusicTabId();
        if (known !== null) {
            try {
                await chrome.tabs.get(known);            // throws if it is gone
                await chrome.tabs.update(known, { active: true });
                return { ok: true, focused: true };
            } catch {
                await setMusicTabId(null);
            }
        }
        // Pinned and inactive: a background player should not steal the tab
        // from the lecture the student is already reading.
        const tab = await chrome.tabs.create({
            url: chrome.runtime.getURL('player/player.html'),
            pinned: true,
            active: false,
        });
        await setMusicTabId(tab.id);
        return { ok: true, created: true };
    },

    /**
     * Relays "a lecture started" to the music tab.
     *
     * A content script cannot message another tab, and the music tab is not
     * listening to the lecture page's <video> — this worker is the only thing
     * that sits between them.
     */
    async MUSIC_LECTURE_STARTED() {
        const id = await getMusicTabId();
        if (id === null) return { ok: true, notified: 0 };
        try {
            await chrome.tabs.sendMessage(id, { type: 'MUSIC_LECTURE_STARTED' });
            return { ok: true, notified: 1 };
        } catch {
            // Closed, or not listening yet. Forget it so the next open is clean.
            await setMusicTabId(null);
            return { ok: true, notified: 0 };
        }
    },

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
