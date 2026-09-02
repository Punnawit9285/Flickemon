/**
 * Local PVP sandbox — a stand-in for the extension, not part of it.
 * ────────────────────────────────────────────────────────────────
 * Loads the REAL content scripts (config, battle, engine, ui, pvp, trade) and
 * fakes only the two things a plain web page cannot have: the `chrome.*` APIs
 * and the service worker behind them. Everything you click is the shipping
 * code; nothing here is bundled into the extension.
 *
 * Two tabs, two players. `?p=a` and `?p=b` pick a save and an identity, so the
 * two tabs are as separate as two Chrome profiles would be — separate parties,
 * separate uids, separate 6-digit codes.
 *
 * The battle document lives in localStorage instead of Firestore. That is a
 * fair substitute for what PVP actually needs from it: both clients read and
 * write one shared record, with a version to detect a lost race. The PVP client
 * polls rather than subscribes, so no cross-tab eventing is needed either.
 *
 * WHAT THIS DOES NOT TEST: Firestore rules, real auth, network latency and its
 * retries, and the service worker sleeping mid-battle. Two signed-in Chrome
 * profiles on the real site remain the only way to check those.
 */
(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const who = (params.get('p') || 'a').toLowerCase();
    const PLAYER = {
        uid: `sandbox-uid-${who}`,
        email: `player-${who}@sandbox.test`,
        name: `Player ${who.toUpperCase()}`,
    };
    const SAVE_NS = `flickemon-sandbox-save-${who}`;
    const LOBBIES = 'flickemon-sandbox-lobbies';   // shared by both tabs

    // ── the shared "Firestore" ──────────────────────────────────────────────
    const lobbies = {
        all() {
            try { return JSON.parse(localStorage.getItem(LOBBIES) || '{}'); }
            catch { return {}; }
        },
        write(all) { localStorage.setItem(LOBBIES, JSON.stringify(all)); },
        get(code) { return this.all()[code] || null; },
        put(code, doc) { const a = this.all(); a[code] = doc; this.write(a); },
        drop(code) { const a = this.all(); delete a[code]; this.write(a); },
    };

    // Same FNV-1a as background/pvp.js: the code must be derived from the uid,
    // not allocated, or the two tabs would not agree on where to look.
    function codeForUid(uid) {
        let h = 2166136261;
        for (let i = 0; i < uid.length; i++) {
            h ^= uid.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return String((h >>> 0) % 1000000).padStart(6, '0');
    }

    // Read-modify-write with the same version check the real transport uses, so
    // a lost race here fails the way it would in production rather than
    // silently clobbering.
    function mutate(code, fn) {
        const before = lobbies.get(code);
        if (!before) throw new Error('No battle with that code. Check the digits.');
        const next = fn(before);
        const now = lobbies.get(code);
        if ((now?.version || 0) !== (before.version || 0)) {
            throw new Error('That battle moved on — try again.');
        }
        lobbies.put(code, { ...next, version: (before.version || 0) + 1, updatedAt: Date.now() });
    }

    const handlers = {
        // ── auth ──
        async AUTH_STATUS() {
            return { configured: true, signedIn: true, email: PLAYER.email,
                     uid: PLAYER.uid, pending: false };
        },
        async AUTH_SIGN_IN() { return { ok: true, email: PLAYER.email, uid: PLAYER.uid }; },
        async AUTH_SIGN_OUT() { return { ok: true }; },
        async AUTH_SWITCH() { return { ok: true, email: PLAYER.email, uid: PLAYER.uid }; },
        // On, so the admin panel is available to build a party in seconds
        // instead of watching twenty-five minutes of fake video.
        async AUTH_IS_ADMIN() { return { isAdmin: true, admin: true, ok: true }; },

        // ── cloud save: local-only here, so these are no-ops that succeed ──
        async CLOUD_PUSH() { return { ok: true }; },
        async CLOUD_PULL() { return { ok: true, state: null }; },
        async CLOUD_FLUSH_PENDING() { return { ok: true }; },

        // ── PVP: mirrors background/pvp.js ──
        async PVP_MY_CODE() {
            return { signedIn: true, code: codeForUid(PLAYER.uid),
                     uid: PLAYER.uid, email: PLAYER.email };
        },

        async PVP_OPEN(msg) {
            const { displayName, team, mode, rulesVersion } = msg.payload;
            const code = codeForUid(PLAYER.uid);
            lobbies.put(code, {
                host: PLAYER.uid,
                hostName: displayName || PLAYER.name,
                guest: '', guestName: '',
                version: 0,
                updatedAt: Date.now(),
                state: {
                    phase: 'waiting', turn: 0,
                    mode, rulesVersion,
                    hostTeam: team, guestTeam: null,
                    hostIndex: 0, guestIndex: 0,
                    log: [],
                },
            });
            return { code, uid: PLAYER.uid };
        },

        async PVP_READ(msg) {
            const doc = lobbies.get(msg.code);
            return { battle: doc ? { ...doc, code: msg.code, me: PLAYER.uid } : null };
        },

        async PVP_JOIN(msg) {
            const { displayName, team, rulesVersion } = msg.payload;
            mutate(msg.code, (battle) => {
                if (battle.host === PLAYER.uid) {
                    throw new Error("That's your own code — share it with someone else.");
                }
                if (battle.guest && battle.guest !== PLAYER.uid) {
                    throw new Error('That trainer is already in a battle.');
                }
                const theirs = battle.state?.rulesVersion || 1;
                if (theirs !== rulesVersion) {
                    throw new Error(theirs < rulesVersion
                        ? 'That trainer is on an older Flickémon. Ask them to update.'
                        : 'That trainer is on a newer Flickémon. Update yours to battle them.');
                }
                return {
                    ...battle,
                    guest: PLAYER.uid,
                    guestName: displayName || PLAYER.name,
                    state: {
                        ...battle.state,
                        phase: 'battling', turn: 1,
                        guestTeam: team,
                        hostIndex: 0, guestIndex: 0,
                        hostAction: null, guestAction: null,
                        log: [`${battle.hostName} vs ${displayName}!`],
                    },
                };
            });
            return { code: msg.code, uid: PLAYER.uid, role: 'guest' };
        },

        async PVP_ACTION(msg) {
            mutate(msg.code, (battle) => {
                const isHost = battle.host === PLAYER.uid;
                const state = { ...battle.state };
                state[isHost ? 'hostAction' : 'guestAction'] = { ...msg.action, turn: state.turn };
                return { ...battle, state };
            });
            return { ok: true };
        },

        async PVP_COMMIT(msg) {
            mutate(msg.code, (battle) => ({ ...battle, state: msg.state }));
            return { ok: true };
        },

        async PVP_CLOSE(msg) { lobbies.drop(msg.code); return { ok: true }; },
    };

    // ── the chrome shim ─────────────────────────────────────────────────────
    const store = {
        read() {
            try { return JSON.parse(localStorage.getItem(SAVE_NS) || '{}'); }
            catch { return {}; }
        },
        write(o) { localStorage.setItem(SAVE_NS, JSON.stringify(o)); },
    };

    window.chrome = {
        runtime: {
            id: 'flickemon-pvp-sandbox',
            lastError: null,
            // Sprites are served from the repo root; this page lives two levels
            // down inside tests/.
            getURL: (path) => `../../${path}`,
            async sendMessage(msg) {
                const handler = handlers[msg?.type];
                if (!handler) return undefined;          // same as "no listener"
                try { return await handler(msg); }
                catch (err) { return { ok: false, error: String(err.message || err) }; }
            },
            onMessage: { addListener() {} },
        },
        storage: {
            local: {
                async get(keys) {
                    const all = store.read();
                    if (keys == null) return all;
                    const wanted = Array.isArray(keys) ? keys
                                 : typeof keys === 'string' ? [keys]
                                 : Object.keys(keys);
                    const out = {};
                    for (const k of wanted) if (k in all) out[k] = all[k];
                    return out;
                },
                async set(obj) { store.write({ ...store.read(), ...obj }); },
                async remove(keys) {
                    const all = store.read();
                    for (const k of (Array.isArray(keys) ? keys : [keys])) delete all[k];
                    store.write(all);
                },
                async clear() { store.write({}); },
            },
            onChanged: { addListener() {} },
        },
    };

    window.FLICKEMON_SANDBOX = { player: PLAYER, lobbies, codeForUid, store };
})();
