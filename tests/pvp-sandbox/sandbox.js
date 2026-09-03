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
        // Trades share this, so the noun follows the key rather than being
        // hardcoded to "battle" — "No battle with that code" in a trade dialog
        // is the kind of wrong that makes people think they used the wrong screen.
        const noun = String(code).startsWith('t:') ? 'trade' : 'battle';
        const before = lobbies.get(code);
        if (!before) throw new Error(`No ${noun} with that code. Check the digits.`);
        const next = fn(before);
        const now = lobbies.get(code);
        if ((now?.version || 0) !== (before.version || 0)) {
            throw new Error(`That ${noun} moved on — try again.`);
        }
        lobbies.put(code, { ...next, version: (before.version || 0) + 1, updatedAt: Date.now() });
    }

    // Battles and trades share one store and one 6-digit code, so trades are
    // namespaced. Without this, opening a trade would evict your own PVP lobby.
    const tradeKey = (code) => `t:${code}`;

    // Friend documents share the same store, each under its own prefix.
    const nameKey    = (name) => `n:${name}`;
    const emailKeyOf = (mail) => `e:${String(mail || '').trim().toLowerCase()}`;
    const profileKey = (uid)  => `p:${uid}`;
    const feedKey    = (uid)  => `d:${uid}`;
    const boardKey   = (uid)  => `b:${uid}`;
    // Sorted, so both tabs address one document rather than two.
    const friendKey  = (a, b) => `f:${[a, b].sort().join('_')}`;

    const handlers = {
        // Firebase is "configured" here in the sense the caller means: there is
        // a working backend behind these routes. Found missing by the route
        // sweep in test_sandbox.js, which is what that sweep is for.
        async SYNC_CONFIGURED() { return { configured: true }; },

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

        // ── Trading: mirrors background/trade.js ──
        //
        // These were missing entirely, and the shim answers an unknown type
        // with `undefined` — the same thing Chrome returns when no listener
        // exists. So every trade call came back empty and the UI said "Could
        // not open a trade", which looked like a broken feature rather than a
        // missing test double.
        //
        // Trades live in the same store as battles, under a "t:" prefix. Same
        // 6-digit code as PVP, as in the real thing.
        async TRADE_OPEN(msg) {
            const code = codeForUid(PLAYER.uid);
            lobbies.put(tradeKey(code), {
                host: PLAYER.uid,
                hostName: msg.payload?.displayName || PLAYER.email,
                guest: '', guestName: '',
                state: {
                    phase: 'waiting',
                    hostOffer: null, guestOffer: null,
                    hostConfirmed: false, guestConfirmed: false,
                    hostApplied: false, guestApplied: false,
                    tradeId: null,
                },
                version: 0, updatedAt: Date.now(),
            });
            return { code, uid: PLAYER.uid };
        },

        async TRADE_READ(msg) {
            const t = lobbies.get(tradeKey(msg.code));
            return { trade: t ? { ...t, code: msg.code, me: PLAYER.uid } : null };
        },

        async TRADE_JOIN(msg) {
            mutate(tradeKey(msg.code), (t) => {
                if (t.host === PLAYER.uid) throw new Error("That's your own code — share it with someone else.");
                if (t.guest && t.guest !== PLAYER.uid) throw new Error('That trainer is already trading.');
                return {
                    ...t,
                    guest: PLAYER.uid,
                    guestName: msg.payload?.displayName || PLAYER.email,
                    state: { ...t.state, phase: 'offering' },
                };
            });
            return { code: msg.code, uid: PLAYER.uid, role: 'guest' };
        },

        // Changing an offer clears BOTH confirmations, or a trainer could
        // confirm, wait, then swap in something worthless.
        async TRADE_OFFER(msg) {
            mutate(tradeKey(msg.code), (t) => {
                const isHost = t.host === PLAYER.uid;
                return { ...t, state: {
                    ...t.state,
                    [isHost ? 'hostOffer' : 'guestOffer']: msg.offer,
                    hostConfirmed: false, guestConfirmed: false,
                } };
            });
            return { ok: true };
        },

        async TRADE_CONFIRM(msg) {
            let sealed = false;
            mutate(tradeKey(msg.code), (t) => {
                const isHost = t.host === PLAYER.uid;
                const state = {
                    ...t.state,
                    [isHost ? 'hostConfirmed' : 'guestConfirmed']: msg.confirmed !== false,
                };
                if (state.hostConfirmed && state.guestConfirmed
                    && state.hostOffer && state.guestOffer) {
                    state.phase = 'done';
                    state.tradeId = state.tradeId
                        || `${msg.code}-${Date.now()}-${t.host.slice(0, 6)}`;
                }
                sealed = state.phase === 'done';
                return { ...t, state };
            });
            return { ok: true, sealed };
        },

        // The table survives until BOTH sides have applied the swap, so a tab
        // that reloaded mid-trade comes back and finishes instead of losing it.
        async TRADE_ACK(msg) {
            let bothApplied = false;
            try {
                mutate(tradeKey(msg.code), (t) => {
                    const isHost = t.host === PLAYER.uid;
                    const state = { ...t.state, [isHost ? 'hostApplied' : 'guestApplied']: true };
                    bothApplied = Boolean(state.hostApplied && state.guestApplied);
                    return { ...t, state };
                });
            } catch {
                return { ok: true, gone: true };
            }
            return { ok: true, bothApplied };
        },

        async TRADE_CLOSE(msg) { lobbies.drop(tradeKey(msg.code)); return { ok: true }; },

        // ── Friends: mirrors background/friends.js ──
        //
        // Everything lives in the same shared store under its own prefix, so
        // the two tabs see one another's names, requests and feeds exactly as
        // two Chrome profiles would.
        //
        // The one thing this CANNOT stand in for is the part that matters most:
        // firestore.rules. Here a feed is readable because this shim hands it
        // over; in production it is readable because `audience` names you. So
        // the audience is still checked below — not because it protects
        // anything locally, but so that a bug in how the audience is built
        // shows up here rather than only in production.

        async FRIEND_CLAIM_NAME(msg) {
            const key = String(msg.name || '').trim().toLowerCase();
            if (!key) return { ok: false, reason: 'empty' };
            const held = lobbies.get(nameKey(key));
            if (held && held.uid !== PLAYER.uid) return { ok: false, reason: 'taken' };
            lobbies.put(nameKey(key), { uid: PLAYER.uid, name: key });
            const profile = lobbies.get(profileKey(PLAYER.uid)) || {};
            lobbies.put(profileKey(PLAYER.uid), { ...profile, uid: PLAYER.uid, username: key });
            // Parity with background/friends.js, where claimUsername calls
            // writeProfile which calls ensureEmailKey. Without this you could
            // be found by name here and by email in production, which is
            // exactly the kind of difference a sandbox exists to not have.
            lobbies.put(emailKeyOf(PLAYER.email), { uid: PLAYER.uid });
            return { ok: true, name: key };
        },

        async FRIEND_RELEASE_NAME(msg) {
            const key = String(msg.name || '').trim().toLowerCase();
            const held = key && lobbies.get(nameKey(key));
            if (held && held.uid === PLAYER.uid) lobbies.drop(nameKey(key));
            return { ok: true };
        },

        async FRIEND_PROFILE(msg) {
            const before = lobbies.get(profileKey(PLAYER.uid)) || {};
            lobbies.put(profileKey(PLAYER.uid), { ...before, ...(msg.payload || {}), uid: PLAYER.uid });
            // Findable by address. Plain here rather than hashed because a
            // sandbox has nothing to protect and a readable key is debuggable.
            lobbies.put(emailKeyOf(PLAYER.email), { uid: PLAYER.uid });
            return { ok: true };
        },

        async FRIEND_LOOKUP(msg) {
            const q = msg.query || {};
            let uid = '';
            if (q.username) {
                const hit = lobbies.get(nameKey(String(q.username).trim().toLowerCase()));
                uid = hit ? hit.uid : '';
            } else if (q.email) {
                const hit = lobbies.get(emailKeyOf(q.email));
                uid = hit ? hit.uid : '';
            }
            if (!uid) return { found: false, reason: 'no-such-name' };
            if (uid === PLAYER.uid) return { found: false, reason: 'self' };
            return { found: true, uid, profile: lobbies.get(profileKey(uid)) || null };
        },

        async FRIEND_REQUEST(msg) {
            const other = msg.uid;
            if (!other || other === PLAYER.uid) return { ok: false, reason: 'self' };
            const key = friendKey(PLAYER.uid, other);
            const existing = lobbies.get(key);

            if (existing) {
                if (existing.accepted) return { ok: true, outcome: 'already' };
                // They asked first and we are asking back, which is an accept.
                // Without this, two people adding each other at the same moment
                // deadlock on two pending requests.
                if (existing.requestedBy !== PLAYER.uid) {
                    lobbies.put(key, { ...existing, accepted: true });
                    return { ok: true, outcome: 'accepted' };
                }
                return { ok: true, outcome: 'pending' };
            }
            lobbies.put(key, {
                members: [PLAYER.uid, other].sort(),
                requestedBy: PLAYER.uid, accepted: false,
                blockedBy: [], createdAt: Date.now(),
            });
            return { ok: true, outcome: 'requested' };
        },

        async FRIEND_ACCEPT(msg) {
            const key = friendKey(PLAYER.uid, msg.uid);
            const existing = lobbies.get(key);
            // Accepting your own request would make anyone a friend of anyone.
            if (!existing || existing.accepted || existing.requestedBy === PLAYER.uid) {
                return { ok: false };
            }
            lobbies.put(key, { ...existing, accepted: true });
            return { ok: true };
        },

        async FRIEND_REMOVE(msg) {
            lobbies.drop(friendKey(PLAYER.uid, msg.uid));
            return { ok: true };
        },

        async FRIEND_LIST() {
            const out = [];
            for (const [key, doc] of Object.entries(lobbies.all())) {
                if (!key.startsWith('f:') || !doc || !Array.isArray(doc.members)) continue;
                if (!doc.members.includes(PLAYER.uid)) continue;
                const other = doc.members.find(m => m !== PLAYER.uid);
                if (!other) continue;
                out.push({
                    ...doc, pairKey: key, uid: other,
                    incoming: !doc.accepted && doc.requestedBy !== PLAYER.uid,
                    outgoing: !doc.accepted && doc.requestedBy === PLAYER.uid,
                    blockedByThem: (doc.blockedBy || []).includes(other),
                });
            }
            return { ok: true, friendships: out, me: PLAYER.uid };
        },

        async FRIEND_PUBLISH(msg) {
            const p = msg.payload || {};
            lobbies.put(feedKey(PLAYER.uid), {
                uid: PLAYER.uid,
                audience: p.audience || [],
                payload: p.payload || {},
                updatedAt: Date.now(),
            });
            return { ok: true };
        },

        async FRIEND_FEEDS(msg) {
            const out = {};
            for (const uid of msg.uids || []) {
                const doc = lobbies.get(feedKey(uid));
                // The audience check production does in a security rule. A feed
                // whose audience does not name us reads as nothing at all.
                out[uid] = doc && (doc.audience || []).includes(PLAYER.uid) ? doc : null;
            }
            return { ok: true, feeds: out };
        },

        async FRIEND_BOARD_PUBLISH(msg) {
            const p = msg.payload || {};
            // Leaving DELETES the row. A row that does not exist cannot be
            // ranked or brought back, which is a stronger promise than a flag.
            if (!p.joined) { lobbies.drop(boardKey(PLAYER.uid)); return { ok: true, joined: false }; }
            lobbies.put(boardKey(PLAYER.uid), {
                uid: PLAYER.uid,
                label: String(p.label || '').split('@')[0].slice(0, 24),
                dayKey: p.dayKey, todayExp: p.todayExp || 0,
                levels: p.levels || 0, streak: p.streak || 0,
            });
            return { ok: true, joined: true };
        },

        async FRIEND_BOARD_READ(msg) {
            const rows = Object.entries(lobbies.all())
                .filter(([k]) => k.startsWith('b:'))
                .map(([, v]) => v)
                .filter(r => r && r.dayKey === msg.dayKey)
                .sort((x, y) => (y.todayExp || 0) - (x.todayExp || 0))
                .slice(0, 25);
            return { ok: true, board: rows, me: PLAYER.uid };
        },
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
