/**
 * Flickemon Core Engine (Chrome Extension)
 * ─────────────────────────────────────────
 * Port of FlickemonService.
 * Manages: Game state, Party, Pokédex, Wild battles, Defeat-only EXP, Evolution, and local chrome.storage.local persistence.
 */

// This file is loaded as a classic content script (see manifest.json), so it
// can't `import` background/firebase-config.js the way the service worker
// does — these mirror the same tuning intent for the content-script side.
//
// ─────────────────────── Firestore free-tier budget ───────────────────────
//
// Spark plan allows 50,000 document reads and 20,000 writes per day across
// every user combined. Sized for 100 students on a heavy exam-cram day —
// 8 hours with the tab open, 5 hours of it actually watching:
//
//   reads   100 x 8h x (3600/300s)          =  9,600   19% of 50,000
//   writes  100 x 5h x (3600/180s)          = 10,000   50% of 20,000
//
// leaving roughly 4x headroom on reads and 2x on writes before anything
// throttles, with PVP (budgeted separately in flickemon-pvp.js) on top.
//
// Two things keep the real numbers below even these:
//   - polling only runs while the tab is VISIBLE, so a tab left open in the
//     background costs nothing;
//   - a push whose payload is byte-identical to the last one is dropped, so
//     an idle tab with a paused video writes nothing at all.
//
// Local saves are unaffected by any of this: chrome.storage.local is free and
// unmetered, and it runs at 1s so a crash can never cost more than a second.
const CLOUD_PUSH_DEBOUNCE_MS = 180000;
const CLOUD_POLL_INTERVAL_MS = 300000;
const LOCAL_SAVE_DEBOUNCE_MS = 1000;

class FlickemonEngine {
    constructor() {
        this.STORAGE_KEY = 'flickemon_ext_save_v2';
        // Last state before anything destructive, so progress is recoverable.
        this.BACKUP_KEY = 'flickemon_ext_save_backup_v1';
        this.config = window.FlickemonConfig;

        this.gameState = this.createEmptyState();
        this.isLoaded = false;
        // Contents of the last document actually written, so an unchanged save
        // can be dropped instead of spending a write. See flushCloud.
        this.lastPushedFingerprint = null;
        this.wildOpponent = null;
        this.wildHpAcc = 0;
        this.respawnTimer = null;

        this.stateListeners = [];
        this.wildListeners = [];
        this.encounterListeners = [];
        this.evolutionListeners = [];
        this.adminDamageMultiplier = 1;
    }

    adminInstantKillOpponent() {
        if (this.wildOpponent && (this.wildOpponent.status === 'fighting' || this.wildOpponent.status === 'battling')) {
            this.wildHpAcc = 0;
            this.onVideoProgress(0.001);
        }
    }

    adminSetDamageMultiplier(multiplier) {
        this.adminDamageMultiplier = Math.max(1, multiplier);
    }

    adminGetDamageMultiplier() {
        return this.adminDamageMultiplier;
    }

    async adminSetPokemonLevel(level) {
        const active = this.getActivePokemon();
        if (!active) return;

        const targetLevel = Math.min(100, Math.max(1, level));
        active.level = targetLevel;
        active.totalExp = this.config.expForLevel(targetLevel);

        const evolution = this.config.canEvolveAt(active.speciesId, active.level);
        if (evolution) {
            const fromSpecies = this.config.getSpeciesById(active.speciesId);
            const toSpecies = this.config.getSpeciesById(evolution.toId);
            if (fromSpecies && toSpecies) {
                active.speciesId = evolution.toId;
                this.updatePokedex(evolution.toId, true);
                this.evolutionListeners.forEach(cb => cb({ from: fromSpecies, to: toSpecies }));
            }
        }

        this.emitState();
        await this.saveGameState({ immediate: true });
    }

    createEmptyState() {
        return {
            // Bumped only when the shape changes in a way normalizeState()
            // cannot infer. Present so future migrations have something to key off.
            schemaVersion: 1,
            hasStarted: false,
            // 'capture' (defeated Pokémon join the party) or 'exp' (no capture,
            // higher EXP). See BATTLE_MODES in flickemon-config.js.
            battleMode: 'capture',
            // speciesId lists. Deliberately not instanceIds: those are generated
            // per device, so they would not survive a cross-device merge.
            favouriteIds: [],
            teamIds: [],
            isHidden: false,
            activeInstanceId: null,
            party: [],
            pokedex: [],
            totalMinutesWatched: 0,
            lastSyncedAt: 0,
            wildOpponent: null,
            // Firebase uid this save belongs to; guards against one student's
            // progress leaking into another's account on a shared device.
            ownerUid: null,
        };
    }

    /**
     * Reconciles a stored save with the current state shape.
     *
     * Saves written by an older version are missing fields the current code
     * assumes exist — a save without `pokedex` used to throw inside init(),
     * which left the widget unrendered and looked exactly like lost progress.
     * Everything is layered over createEmptyState() so every field is present,
     * then obviously-bad values are repaired rather than trusted.
     */
    normalizeState(raw) {
        const base = this.createEmptyState();
        if (!raw || typeof raw !== 'object') return base;

        const s = { ...base, ...raw };

        s.party = Array.isArray(s.party) ? s.party : [];
        s.pokedex = Array.isArray(s.pokedex) ? s.pokedex : [];

        // Drop entries that would break lookups later.
        s.party = s.party.filter(p => p && p.instanceId && Number.isFinite(p.speciesId));
        s.pokedex = s.pokedex.filter(e => e && Number.isFinite(e.speciesId));

        s.party.forEach(p => {
            if (!Number.isFinite(p.level)) p.level = 1;
            if (!Number.isFinite(p.totalExp)) p.totalExp = this.config.expForLevel(p.level);
        });

        if (s.battleMode !== this.config.BATTLE_MODES.EXP) s.battleMode = this.config.BATTLE_MODES.CAPTURE;

        const ownedSpecies = new Set(s.party.map(p => p.speciesId));
        const cleanIds = list => Array.isArray(list)
            ? [...new Set(list.filter(id => Number.isFinite(id) && ownedSpecies.has(id)))]
            : [];
        s.favouriteIds = cleanIds(s.favouriteIds);
        s.teamIds = cleanIds(s.teamIds).slice(0, this.config.MAX_TEAM_SIZE);
        if (!Number.isFinite(s.totalMinutesWatched) || s.totalMinutesWatched < 0) s.totalMinutesWatched = 0;
        if (!Number.isFinite(s.lastSyncedAt)) s.lastSyncedAt = 0;

        // The active pointer must name a party member that actually exists.
        if (!s.party.some(p => p.instanceId === s.activeInstanceId)) {
            s.activeInstanceId = s.party.length ? s.party[0].instanceId : null;
        }
        // "Started" without a partner is unplayable; treat it as not started.
        if (s.hasStarted && s.party.length === 0) s.hasStarted = false;

        return s;
    }

    /** Snapshots the current save so a destructive action stays recoverable. */
    async backupState() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        if (!this.gameState || !this.gameState.hasStarted) return; // nothing worth keeping
        try {
            await chrome.storage.local.set({
                [this.BACKUP_KEY]: { state: this.gameState, savedAt: Date.now() },
            });
        } catch (err) {
            console.warn('[Flickémon] Could not write backup:', err);
        }
    }

    /** Most recent pre-destructive snapshot, or null. */
    async peekBackup() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
        const data = await chrome.storage.local.get([this.BACKUP_KEY]);
        return (data && data[this.BACKUP_KEY]) || null;
    }

    /** Restores the snapshot and pushes it upstream. */
    async restoreBackup() {
        const backup = await this.peekBackup();
        if (!backup || !backup.state) return false;

        this.gameState = this.normalizeState(backup.state);
        this.wildOpponent = null;
        if (this.respawnTimer) clearTimeout(this.respawnTimer);

        this.writeLocal();
        this.emitState();
        this.emitWild();
        if (this.gameState.hasStarted) this.spawnWildOpponent();

        this.cloudDirty = true;
        await this.flushCloud();
        return true;
    }

    async init() {
        if (typeof chrome === 'undefined' || !chrome.storage) return;

        // 1. Optimistic UI: Fast load from local storage
        if (chrome.storage.local) {
            const localData = await chrome.storage.local.get([this.STORAGE_KEY]);
            if (localData && localData[this.STORAGE_KEY]) {
                this.gameState = this.normalizeState(localData[this.STORAGE_KEY]);
                this.emitState();
            }
        }

        this.isLoaded = true;

        if (this.gameState.hasStarted) {
            if (this.gameState.wildOpponent && this.gameState.wildOpponent.status === 'fighting') {
                this.wildOpponent = this.gameState.wildOpponent;
                this.wildHpAcc = this.wildOpponent.currentHp;
                this.emitWild();
            } else if (!this.wildOpponent) {
                this.spawnWildOpponent();
            }
        }

        // 2. Cloud: adopt progress made on the student's other devices.
        //    Never blocks gameplay — a failure here just leaves us local-only.
        this.pullFromCloud().catch(() => {});
        this.startCloudPolling();
    }

    // ─────────────────────── Cloud Sync (Firestore) ───────────────────────

    async sendToWorker(message) {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return null;
        try {
            return await chrome.runtime.sendMessage(message);
        } catch {
            return null; // worker asleep / extension reloading
        }
    }

    async getSyncStatus() {
        const status = await this.sendToWorker({ type: 'AUTH_STATUS' });
        // `reachable: false` means the service worker never answered, which is
        // NOT the same as sync being unconfigured — conflating them would let a
        // transient worker hiccup silently drop a student into local-only play.
        if (!status) {
            return { reachable: false, configured: false, signedIn: false, email: null, pending: false };
        }
        return { reachable: true, ...status };
    }

    /**
     * Server-verified admin check. Returns false on any failure, so a network
     * problem denies access rather than granting it.
     */
    async isAdmin() {
        const res = await this.sendToWorker({ type: 'AUTH_IS_ADMIN' });
        // Strict `=== true`: only an explicit server affirmative grants access.
        // A truthy-but-malformed value must not be mistaken for a yes.
        return res?.isAdmin === true;
    }

    async signIn({ prompt } = {}) {
        const res = await this.sendToWorker({ type: 'AUTH_SIGN_IN', prompt });
        if (!res || res.ok === false) {
            throw new Error(res?.error || 'Sign-in failed');
        }

        // Shared-device guard. On a faculty lab PC, student B signing in after
        // student A would otherwise merge A's still-resident local party into
        // B's account (the merge is monotonic, so it keeps everything it sees).
        // Discard the previous owner's state before pulling B's save.
        //
        // ownerUid is absent for a save made before sign-in existed; that one is
        // deliberately kept, so a student's pre-existing local progress is
        // adopted into their account rather than thrown away.
        if (this.gameState.ownerUid && this.gameState.ownerUid !== res.uid) {
            this.discardLocalState();
        }

        // An unowned save was made before signing in (either a legacy save, or
        // one from "continue without signing in"). If the account already has a
        // save, that account is the source of truth and the local one is
        // dropped — merging it is what produces a second starter. Only when the
        // account is empty is the local save adopted.
        if (!this.gameState.ownerUid && this.gameState.hasStarted) {
            const existing = await this.sendToWorker({ type: 'CLOUD_PULL' });
            if (existing && existing.signedIn && existing.state && existing.state.hasStarted) {
                this.discardLocalState();
            }
        }

        this.gameState.ownerUid = res.uid;

        await this.pullFromCloud();
        await this.flushCloud();
        return res;
    }

    /** Wipes this device's save without touching anything in the cloud. */
    discardLocalState() {
        // Snapshot first — this wipes a student's device-local progress, and if
        // it had not yet reached the cloud there would otherwise be no copy.
        this.backupState();

        // Drop any pending push first: it carries the state we're discarding,
        // and letting it land would write the previous owner's progress into
        // the account that just signed in.
        this.cloudDirty = false;
        this.cloudQueuedWhileInFlight = false;
        if (this.cloudPushTimer) {
            clearTimeout(this.cloudPushTimer);
            this.cloudPushTimer = null;
        }
        // The fingerprint describes the outgoing account's save. Leaving it set
        // could suppress the next account's first write.
        this.lastPushedFingerprint = null;

        this.gameState = this.createEmptyState();
        this.wildOpponent = null;
        if (this.respawnTimer) clearTimeout(this.respawnTimer);
        this.emitWild();
    }

    /**
     * Sign out and immediately offer a different account. Local state is
     * discarded rather than kept: the next student to sign in must not inherit
     * this one's party, and whatever is here has already been pushed upstream.
     */
    async switchAccount() {
        await this.flushCloud();
        await this.sendToWorker({ type: 'AUTH_SWITCH' });
        this.discardLocalState();
        this.writeLocal();
        this.emitState();
        // Force Google's chooser, otherwise it silently reuses the same session.
        return await this.signIn({ prompt: 'select_account' });
    }

    async signOut() {
        // Don't strand unsaved progress in the cloud queue.
        await this.flushCloud();
        await this.sendToWorker({ type: 'AUTH_SIGN_OUT' });
        this.emitState();
    }

    /** Pulls the cloud save and merges it into local state. */
    async pullFromCloud() {
        const res = await this.sendToWorker({ type: 'CLOUD_PULL' });
        if (!res || !res.signedIn) return false;

        // Retry anything parked while offline now that we know we're online.
        this.sendToWorker({ type: 'CLOUD_FLUSH_PENDING' });

        if (!res.state) {
            // Account has no save yet — this device seeds it.
            if (this.gameState.hasStarted) await this.flushCloud();
            return true;
        }

        const changed = this.mergeCloudState(res.state);
        if (changed) {
            this.writeLocal();
            this.emitState();
            if (this.gameState.hasStarted && !this.wildOpponent) {
                this.spawnWildOpponent();
            }
        }
        return true;
    }

    /** Re-checks the cloud while this tab is open and visible. */
    startCloudPolling() {
        if (typeof document === 'undefined' || this.cloudPollTimer) return;

        this.cloudPollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') {
                this.pullFromCloud().catch(() => {});
            }
        }, CLOUD_POLL_INTERVAL_MS);

        // Returning to the tab is the moment a stale save is most visible.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.pullFromCloud().catch(() => {});
            } else {
                this.flushCloud(); // leaving — don't lose the last stretch
            }
        });

        // Last chance to persist before the tab goes away.
        window.addEventListener('pagehide', () => this.flushCloud());
    }

    /** State shared across devices. Battle state is deliberately device-local. */
    /**
     * Identity of a payload's *contents*, for skipping pointless writes.
     * lastSyncedAt is stamped on every save and would defeat the comparison.
     */
    cloudFingerprint(payload) {
        const { lastSyncedAt, ...content } = payload;
        return JSON.stringify(content);
    }

    buildCloudPayload() {
        return {
            hasStarted: this.gameState.hasStarted,
            activeInstanceId: this.gameState.activeInstanceId,
            party: this.gameState.party,
            pokedex: this.gameState.pokedex,
            totalMinutesWatched: this.gameState.totalMinutesWatched,
            battleMode: this.gameState.battleMode,
            favouriteIds: this.gameState.favouriteIds,
            teamIds: this.gameState.teamIds,
            lastSyncedAt: this.gameState.lastSyncedAt,
        };
    }

    /**
     * Merges a cloud save into local state. Every rule is monotonic — progress
     * can only move forward — so a stale device can never erase a newer one.
     * Returns whether anything actually changed.
     */
    mergeCloudState(cloud) {
        if (!cloud) return false;
        const before = JSON.stringify(this.buildCloudPayload());

        this.gameState.hasStarted = this.gameState.hasStarted || Boolean(cloud.hasStarted);
        this.gameState.totalMinutesWatched = Math.max(
            this.gameState.totalMinutesWatched || 0,
            cloud.totalMinutesWatched || 0
        );

        // Pokédex: union. Caught outranks merely seen.
        for (const entry of cloud.pokedex || []) {
            this.updatePokedex(entry.speciesId, Boolean(entry.caught));
        }

        // Party: one instance per species (the game already enforces this),
        // so reconcile by species and keep whichever is further along.
        for (const remote of cloud.party || []) {
            const local = this.gameState.party.find(p => p.speciesId === remote.speciesId);
            if (!local) {
                this.gameState.party.push({ ...remote });
            } else if ((remote.totalExp || 0) > (local.totalExp || 0)) {
                local.level = remote.level;
                local.totalExp = remote.totalExp;
            }
        }

        // Active partner: follow the cloud's choice, matched by species since
        // instanceIds are generated per-device and won't line up.
        const remoteActive = (cloud.party || []).find(p => p.instanceId === cloud.activeInstanceId);
        if (remoteActive) {
            const localMatch = this.gameState.party.find(p => p.speciesId === remoteActive.speciesId);
            if (localMatch) this.gameState.activeInstanceId = localMatch.instanceId;
        }
        if (!this.getActivePokemon() && this.gameState.party.length > 0) {
            this.gameState.activeInstanceId = this.gameState.party[0].instanceId;
        }

        // Battle mode is a preference, so the newer write wins. Everything else
        // here is monotonic, but "most recently chosen" is the right rule for a
        // setting — max() would be meaningless for a string.
        if ((cloud.lastSyncedAt || 0) > (this.gameState.lastSyncedAt || 0)) {
            if (cloud.battleMode) {
                this.gameState.battleMode = cloud.battleMode === this.config.BATTLE_MODES.EXP
                    ? this.config.BATTLE_MODES.EXP
                    : this.config.BATTLE_MODES.CAPTURE;
            }
            if (Array.isArray(cloud.favouriteIds)) this.gameState.favouriteIds = [...cloud.favouriteIds];
            if (Array.isArray(cloud.teamIds)) this.gameState.teamIds = [...cloud.teamIds];
        }

        this.gameState.lastSyncedAt = Math.max(this.gameState.lastSyncedAt || 0, cloud.lastSyncedAt || 0);

        return JSON.stringify(this.buildCloudPayload()) !== before;
    }

    /** Pushes local state up right now, cancelling any pending debounced push. */
    async flushCloud() {
        if (!this.isLoaded || !this.cloudDirty) return;

        if (this.cloudPushTimer) {
            clearTimeout(this.cloudPushTimer);
            this.cloudPushTimer = null;
        }

        if (this.cloudInFlight) {
            this.cloudQueuedWhileInFlight = true;
            return;
        }

        const payload = this.buildCloudPayload();

        // saveGameState runs on every video tick, so the dirty flag says only
        // that *something* called it — not that anything actually changed. A
        // paused video, an open menu or a idle tab would otherwise write an
        // identical document every few minutes, for nothing. lastSyncedAt is
        // excluded because it moves on every call by definition.
        const fingerprint = this.cloudFingerprint(payload);
        if (fingerprint === this.lastPushedFingerprint) {
            this.cloudDirty = false;
            return;
        }

        this.cloudDirty = false;
        this.cloudInFlight = true;
        try {
            const res = await this.sendToWorker({ type: 'CLOUD_PUSH', state: payload });
            if (res && res.ok) {
                this.lastCloudSyncAt = res.syncedAt;
                this.lastPushedFingerprint = fingerprint;
            } else if (res && res.reason === 'offline') {
                this.cloudDirty = true; // worker parked it; keep our own flag set too
            }
        } finally {
            this.cloudInFlight = false;
            if (this.cloudQueuedWhileInFlight) {
                this.cloudQueuedWhileInFlight = false;
                this.cloudDirty = true;
                this.scheduleCloudPush(false);
            }
        }
    }

    scheduleCloudPush(immediate) {
        this.cloudDirty = true;
        if (immediate) {
            this.flushCloud();
            return;
        }
        if (this.cloudPushTimer) return; // already coalescing
        this.cloudPushTimer = setTimeout(() => {
            this.cloudPushTimer = null;
            this.flushCloud();
        }, CLOUD_PUSH_DEBOUNCE_MS);
    }

    /** Manual "Sync now" from Settings: pull, then push. */
    async forceCloudSync() {
        const status = await this.getSyncStatus();
        if (!status.signedIn) return false;

        await this.pullFromCloud();
        this.cloudDirty = true;
        await this.flushCloud();
        return true;
    }

    onStateChange(cb) { this.stateListeners.push(cb); cb(this.gameState); return () => this.stateListeners = this.stateListeners.filter(l => l !== cb); }
    onWildChange(cb) { this.wildListeners.push(cb); cb(this.wildOpponent); return () => this.wildListeners = this.wildListeners.filter(l => l !== cb); }
    onEncounter(cb) { this.encounterListeners.push(cb); return () => this.encounterListeners = this.encounterListeners.filter(l => l !== cb); }
    onEvolution(cb) { this.evolutionListeners.push(cb); return () => this.evolutionListeners = this.evolutionListeners.filter(l => l !== cb); }

    emitState() { this.stateListeners.forEach(cb => cb({ ...this.gameState })); }
    emitWild() { this.wildListeners.forEach(cb => cb(this.wildOpponent ? { ...this.wildOpponent } : null)); }

    /**
     * Records a state change. Writes are tiered because `onVideoProgress` runs
     * on every `timeupdate` (~4x/sec): local writes coalesce to ~1/sec, and
     * cloud pushes coalesce to ~45s unless the change is worth keeping now
     * (catch, evolution, starter choice, reset).
     */
    async saveGameState(opts = {}) {
        if (!this.isLoaded) return; // Prevent clobbering a save mid-load

        this.gameState.lastSyncedAt = Date.now();
        this.emitState();

        this.scheduleLocalSave();
        this.scheduleCloudPush(opts.immediate === true);
    }

    writeLocal() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        const result = chrome.storage.local.set({ [this.STORAGE_KEY]: this.gameState });
        if (result && typeof result.catch === 'function') {
            result.catch(err => console.warn('[Flickémon] Local save failed:', err));
        }
    }

    scheduleLocalSave() {
        if (this.localSaveTimer) return; // coalesce into the pending write
        this.localSaveTimer = setTimeout(() => {
            this.localSaveTimer = null;
            this.writeLocal();
        }, LOCAL_SAVE_DEBOUNCE_MS);
    }

    hasStarted() { return this.gameState.hasStarted; }

    getBattleMode() {
        return this.gameState.battleMode === this.config.BATTLE_MODES.EXP
            ? this.config.BATTLE_MODES.EXP
            : this.config.BATTLE_MODES.CAPTURE;
    }

    isCaptureMode() { return this.getBattleMode() === this.config.BATTLE_MODES.CAPTURE; }

    /** EXP multiplier for a won battle, which depends on the active mode. */
    getWinExpBonus() {
        return this.isCaptureMode()
            ? this.config.BATTLE_WIN_EXP_BONUS
            : this.config.EXP_MODE_WIN_EXP_BONUS;
    }

    async setBattleMode(mode) {
        const next = mode === this.config.BATTLE_MODES.EXP
            ? this.config.BATTLE_MODES.EXP
            : this.config.BATTLE_MODES.CAPTURE;
        if (next === this.gameState.battleMode) return;
        this.gameState.battleMode = next;
        this.emitState();
        await this.saveGameState({ immediate: true });
    }
    getGameState() { return { ...this.gameState }; }

    async chooseStarter(speciesId) {
        const starterSpecies = this.config.getSpeciesById(speciesId);
        if (!starterSpecies) return;

        const starterInstance = {
            instanceId: this.generateId(),
            speciesId,
            level: 5,
            totalExp: this.config.expForLevel(5),
        };

        this.gameState.hasStarted = true;
        this.gameState.party = [starterInstance];
        this.gameState.activeInstanceId = starterInstance.instanceId;
        this.updatePokedex(speciesId, true);

        await this.saveGameState({ immediate: true });
        this.spawnWildOpponent();
    }

    getActivePokemon() {
        if (!this.gameState.activeInstanceId || this.gameState.party.length === 0) return null;
        return this.gameState.party.find(p => p.instanceId === this.gameState.activeInstanceId) || this.gameState.party[0];
    }

    getSpeciesForPokemon(pokemon) {
        return this.config.getSpeciesById(pokemon.speciesId);
    }

    async switchActivePokemon(instanceId) {
        const target = this.gameState.party.find(p => p.instanceId === instanceId);
        if (target) {
            this.gameState.activeInstanceId = instanceId;
            await this.saveGameState();
        }
    }

    getParty() { return [...this.gameState.party]; }

    // ─────────────────────────── PVP ───────────────────────────

    async pvpMyCode()        { return await this.sendToWorker({ type: 'PVP_MY_CODE' }); }
    async pvpOpen(payload)   { return await this.sendToWorker({ type: 'PVP_OPEN', payload }); }
    async pvpRead(code)      { return await this.sendToWorker({ type: 'PVP_READ', code }); }
    async pvpJoin(code, p)   { return await this.sendToWorker({ type: 'PVP_JOIN', code, payload: p }); }
    async pvpAction(code, a) { return await this.sendToWorker({ type: 'PVP_ACTION', code, action: a }); }
    async pvpCommit(code, st){ return await this.sendToWorker({ type: 'PVP_COMMIT', code, state: st }); }
    async pvpClose(code)     { return await this.sendToWorker({ type: 'PVP_CLOSE', code }); }

    /**
     * The team taken into a PVP battle, as plain battle-ready combatants.
     * Sent over the wire so the opponent can render and simulate it without
     * needing to look anything up.
     */
    buildPvpTeam() {
        const B = window.FlickemonBattle;
        const ids = this.getTeam();
        const out = [];
        for (const speciesId of ids) {
            const member = this.gameState.party.find(p => p.speciesId === speciesId);
            const species = this.config.getSpeciesById(speciesId);
            if (member && species) out.push(B.toCombatant(member, species, this.config));
        }
        return out;
    }

    // ─────────────────────── Favourites & Team ───────────────────────

    isFavourite(speciesId) { return (this.gameState.favouriteIds || []).includes(speciesId); }

    async toggleFavourite(speciesId) {
        const list = this.gameState.favouriteIds || (this.gameState.favouriteIds = []);
        const i = list.indexOf(speciesId);
        if (i >= 0) list.splice(i, 1); else list.push(speciesId);
        this.emitState();
        await this.saveGameState();
    }

    /**
     * Species training together. The active partner is always a member — it is
     * implicit rather than stored, so switching partners can never leave the
     * team in a state where the Pokémon actually battling is excluded.
     */
    getTeam() {
        const active = this.getActivePokemon();
        const stored = (this.gameState.teamIds || []).filter(id => !active || id !== active.speciesId);
        const team = active ? [active.speciesId, ...stored] : stored;
        return team.slice(0, this.config.MAX_TEAM_SIZE);
    }

    isOnTeam(speciesId) { return this.getTeam().includes(speciesId); }

    isTeamFull() { return this.getTeam().length >= this.config.MAX_TEAM_SIZE; }

    /**
     * Returns { ok, reason }. The reason matters: rejecting because a Pokémon is
     * the active partner is a different situation from a full team, and showing
     * "team is full" for both is actively misleading.
     */
    async toggleTeamMember(speciesId) {
        const active = this.getActivePokemon();
        if (active && speciesId === active.speciesId) {
            return { ok: false, reason: 'active' }; // the partner is always aboard
        }

        const list = this.gameState.teamIds || (this.gameState.teamIds = []);
        const i = list.indexOf(speciesId);
        if (i >= 0) {
            list.splice(i, 1);
        } else {
            if (this.isTeamFull()) return { ok: false, reason: 'full' };
            list.push(speciesId);
        }
        this.emitState();
        await this.saveGameState();
        return { ok: true };
    }
    getPokedex() { return [...this.gameState.pokedex]; }
    getCaughtCount() { return this.gameState.pokedex.filter(p => p.caught).length; }

    getExpProgress(pokemon) {
        const currentLevelExp = this.config.expForLevel(pokemon.level);
        const nextLevelExp = this.config.expForLevel(pokemon.level + 1);
        const current = pokemon.totalExp - currentLevelExp;
        const needed = nextLevelExp - currentLevelExp;
        const percent = Math.min(100, Math.round((current / needed) * 100));
        return { current, needed, percent };
    }

    async resetGameState() {
        await this.backupState();
        this.gameState = this.createEmptyState();
        this.wildOpponent = null;
        if (this.respawnTimer) clearTimeout(this.respawnTimer);
        this.emitWild();
        await this.saveGameState({ immediate: true });
    }

    async onVideoProgress(secondsWatched) {
        const active = this.getActivePokemon();
        if (!this.gameState.hasStarted || !active) return;

        let capturedThisTick = false;

        if (!this.wildOpponent) {
            this.spawnWildOpponent();
        }

        if (this.wildOpponent && this.wildOpponent.status === 'fighting') {
            this.wildOpponent.fightDurationSeconds += secondsWatched;

            // Escaped check if wildLevel >= active.level + 4 after 90s
            const levelDiff = this.wildOpponent.wildLevel - active.level;
            if (levelDiff >= 4 && this.wildOpponent.fightDurationSeconds >= 90) {
                this.wildOpponent.status = 'escaped';
                const partialExp = Math.round(
                    this.wildOpponent.wildLevel * this.config.ESCAPE_EXP_MULTIPLIER
                );
                this.wildOpponent.expGained = partialExp;
                this.addExpToActive(partialExp);

                this.encounterListeners.forEach(cb => cb({
                    wildSpecies: this.wildOpponent.wildSpecies,
                    wildLevel: this.wildOpponent.wildLevel,
                    won: false,
                    captured: false,
                    expGained: partialExp,
                    evolved: false,
                }));

                if (this.respawnTimer) clearTimeout(this.respawnTimer);
                this.respawnTimer = setTimeout(() => this.spawnWildOpponent(), 3000);
                this.emitWild();
                // Encounter resolved with EXP gained — worth persisting now.
                await this.saveGameState({ immediate: true });
                return;
            }

            // Damage calculation (~150 seconds / 2.5 mins to defeat)
            const TARGET_BATTLE_SECONDS = 150;
            const damagePerSec = (this.wildOpponent.maxHp / TARGET_BATTLE_SECONDS) * this.adminDamageMultiplier;
            this.wildHpAcc -= secondsWatched * damagePerSec;
            this.wildOpponent.currentHp = Math.max(0, Math.ceil(this.wildHpAcc));

            if (this.wildOpponent.currentHp === 0) {
                // Battle won. Worth pushing to the cloud right away.
                capturedThisTick = true;

                const captured = this.isCaptureMode();
                this.wildOpponent.status = captured ? 'captured' : 'defeated';
                const winExp = Math.round(this.wildOpponent.wildLevel * this.getWinExpBonus());
                this.wildOpponent.expGained = winExp;

                if (captured) {
                    if (!this.gameState.party.some(p => p.speciesId === this.wildOpponent.wildSpecies.id)) {
                        this.gameState.party.push({
                            instanceId: this.generateId(),
                            speciesId: this.wildOpponent.wildSpecies.id,
                            level: this.wildOpponent.wildLevel,
                            totalExp: this.config.expForLevel(this.wildOpponent.wildLevel),
                        });
                    }
                    this.updatePokedex(this.wildOpponent.wildSpecies.id, true);
                } else {
                    // EXP mode: the encounter still counts as SEEN — the student
                    // did meet it — but it is not added to the party or marked caught.
                    this.updatePokedex(this.wildOpponent.wildSpecies.id, false);
                }

                const evoResult = this.addExpToActive(winExp);

                this.encounterListeners.forEach(cb => cb({
                    wildSpecies: this.wildOpponent.wildSpecies,
                    wildLevel: this.wildOpponent.wildLevel,
                    won: true,
                    captured,
                    expGained: winExp,
                    evolved: !!evoResult,
                    evolvedInto: evoResult || undefined,
                }));

                if (this.respawnTimer) clearTimeout(this.respawnTimer);
                this.respawnTimer = setTimeout(() => this.spawnWildOpponent(), 3000);
            }

            this.emitWild();
        }

        this.gameState.wildOpponent = this.wildOpponent;
        this.gameState.totalMinutesWatched += secondsWatched / 60;
        await this.saveGameState({ immediate: capturedThisTick });
    }

    spawnWildOpponent() {
        const active = this.getActivePokemon();
        const activeLevel = active ? active.level : 5;

        const wildSpecies = this.rollWildPokemon();
        const wildLevel = this.rollWildLevel(activeLevel);
        const maxHp = this.config.calculateRealMaxHp(wildSpecies.baseStats.hp, wildLevel);
        this.wildHpAcc = maxHp;

        this.wildOpponent = {
            wildSpecies,
            wildLevel,
            maxHp,
            currentHp: maxHp,
            status: 'fighting',
            fightDurationSeconds: 0,
        };

        this.gameState.wildOpponent = this.wildOpponent;
        this.updatePokedex(wildSpecies.id, false);
        this.emitWild();
        this.saveGameState();
    }

    rollWildPokemon() {
        const active = this.getActivePokemon();
        const activeLevel = active ? active.level : 5;

        // Legendary check (Lv40+, 1% rate)
        if (activeLevel >= 40 && Math.random() <= 0.01) {
            const legendaries = this.config.POKEMON_REGISTRY.filter(s => s.isLegendary);
            if (legendaries.length > 0) {
                return legendaries[Math.floor(Math.random() * legendaries.length)];
            }
        }

        const nonLegendaries = this.config.POKEMON_REGISTRY.filter(s => !s.isLegendary);
        const roll = Math.random();
        let cumulative = 0;
        let selectedStage = 1;

        for (const entry of this.config.ENCOUNTER_STAGE_WEIGHTS) {
            cumulative += entry.weight;
            if (roll <= cumulative) {
                selectedStage = entry.stage;
                break;
            }
        }

        // Stage 3 locked until Level 30+
        if (selectedStage === 3 && activeLevel < 30) {
            selectedStage = Math.random() <= 0.85 ? 1 : 2;
        }

        const candidates = nonLegendaries.filter(s => s.evolutionStage === selectedStage);
        if (candidates.length === 0) {
            const fallback = nonLegendaries.filter(s => s.evolutionStage === 1);
            return fallback[Math.floor(Math.random() * fallback.length)];
        }

        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    rollWildLevel(playerLevel) {
        const variance = Math.floor(playerLevel * 0.3) + 2;
        const minLevel = Math.max(1, playerLevel - variance);
        const maxLevel = Math.min(this.config.MAX_LEVEL, playerLevel + variance);
        return Math.floor(Math.random() * (maxLevel - minLevel + 1)) + minLevel;
    }

    addExpToActive(exp) {
        const active = this.getActivePokemon();
        if (!active || active.level >= this.config.MAX_LEVEL) return null;

        active.totalExp += exp;
        const newLevel = Math.min(this.config.MAX_LEVEL, this.config.levelFromExp(active.totalExp));
        if (newLevel > active.level) {
            active.level = newLevel;
        }

        // Everyone else on the team trains alongside, at a reduced rate.
        this.shareExpWithTeam(exp, active.speciesId);

        const evolution = this.config.canEvolveAt(active.speciesId, active.level);
        if (evolution) {
            const fromSpecies = this.config.getSpeciesById(active.speciesId);
            const toSpecies = this.config.getSpeciesById(evolution.toId);
            if (fromSpecies && toSpecies) {
                const tIdx = (this.gameState.teamIds || []).indexOf(active.speciesId);
                const fIdx = (this.gameState.favouriteIds || []).indexOf(active.speciesId);
                active.speciesId = evolution.toId;
                if (tIdx >= 0) this.gameState.teamIds[tIdx] = evolution.toId;
                if (fIdx >= 0) this.gameState.favouriteIds[fIdx] = evolution.toId;
                this.updatePokedex(evolution.toId, true);
                this.evolutionListeners.forEach(cb => cb({ from: fromSpecies, to: toSpecies }));
                this.emitState();
                return toSpecies;
            }
        }

        this.emitState();
        return null;
    }

    /**
     * Awards TEAM_EXP_SHARE of `exp` to every team member except the partner,
     * who already received the full amount.
     *
     * Team members evolve too, but silently: the evolution overlay is a
     * five-second fullscreen takeover, and several members crossing a threshold
     * on the same battle would stack them. The Pokédex is still updated, so the
     * change is visible in the party list and dex.
     */
    shareExpWithTeam(exp, activeSpeciesId) {
        const shared = Math.round(exp * this.config.TEAM_EXP_SHARE);
        if (shared <= 0) return;

        for (const speciesId of this.getTeam()) {
            if (speciesId === activeSpeciesId) continue;

            const member = this.gameState.party.find(p => p.speciesId === speciesId);
            if (!member || member.level >= this.config.MAX_LEVEL) continue;

            member.totalExp += shared;
            member.level = Math.min(
                this.config.MAX_LEVEL,
                this.config.levelFromExp(member.totalExp)
            );

            const evo = this.config.canEvolveAt(member.speciesId, member.level);
            if (evo) {
                const to = this.config.getSpeciesById(evo.toId);
                if (to) {
                    // Keep teamIds pointing at the species that now exists.
                    const idx = (this.gameState.teamIds || []).indexOf(member.speciesId);
                    const favIdx = (this.gameState.favouriteIds || []).indexOf(member.speciesId);
                    member.speciesId = evo.toId;
                    if (idx >= 0) this.gameState.teamIds[idx] = evo.toId;
                    if (favIdx >= 0) this.gameState.favouriteIds[favIdx] = evo.toId;
                    this.updatePokedex(evo.toId, true);
                }
            }
        }
    }

    updatePokedex(speciesId, caught) {
        const existing = this.gameState.pokedex.find(e => e.speciesId === speciesId);
        if (existing) {
            if (caught) existing.caught = true;
            existing.seen = true;
        } else {
            this.gameState.pokedex.push({ speciesId, caught, seen: true });
        }
    }

    getStarterOptions() {
        return this.config.STARTER_OPTIONS.map(id => this.config.getSpeciesById(id)).filter(Boolean);
    }

    generateId() {
        return 'pk_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    }
}

window.flickemonEngine = new FlickemonEngine();
