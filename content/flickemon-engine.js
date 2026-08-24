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
        // Deliberately outside the game state: it identifies the device, not
        // the account, so it must not sync and must survive a progress reset.
        this.DEVICE_KEY = 'flickemon_device_id_v1';
        this.deviceId = null;
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

    /**
     * Replaces the current encounter with a chosen species, shiny or not.
     *
     * Admin-only, and gated on the server the same way every other admin tool
     * is: the caller checks isAdmin() first, and that answer comes from a
     * document no client can write. This only touches the wild slot — nothing
     * is added to the party until the student actually wins the battle, so a
     * summon still has to be earned.
     */
    async adminSummonOpponent(speciesId, { shiny = false, level } = {}) {
        const species = this.config.getSpeciesById(Number(speciesId));
        if (!species) return { ok: false, reason: 'unknown-species' };

        const active = this.getActivePokemon();
        const wildLevel = Number.isFinite(level) && level > 0
            ? Math.min(this.config.MAX_LEVEL, Math.round(level))
            : (active ? active.level : 5);

        const maxHp = this.config.calculateRealMaxHp(species.baseStats.hp, wildLevel);
        if (this.respawnTimer) clearTimeout(this.respawnTimer);
        this.wildHpAcc = maxHp;
        this.wildOpponent = {
            wildSpecies: species,
            wildLevel,
            maxHp,
            currentHp: maxHp,
            status: 'fighting',
            fightDurationSeconds: 0,
            shiny: shiny === true,
        };

        this.gameState.wildOpponent = this.wildOpponent;
        this.updatePokedex(species.id, false);
        this.emitWild();
        await this.saveGameState();
        return { ok: true, species, level: wildLevel, shiny: shiny === true };
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
                this.updatePokedex(evolution.toId, true, active.shiny === true);
                this.evolutionListeners.forEach(cb => cb({
                    from: fromSpecies, to: toSpecies, shiny: active.shiny === true,
                }));
            }
        }

        this.emitState();
        await this.saveGameState({ immediate: true });
    }

    createEmptyState() {
        return {
            // Bumped only when the shape changes in a way normalizeState()
            // cannot infer. Present so future migrations have something to key off.
            // 1 = team/favourites keyed by speciesId, one party slot per species.
            // 2 = keyed by instanceId, duplicates allowed. mergeCloudState reads
            //     this to know which reconciliation rule a remote save wants.
            schemaVersion: 2,
            hasStarted: false,
            // 'capture' (defeated Pokémon join the party) or 'exp' (no capture,
            // higher EXP). See BATTLE_MODES in flickemon-config.js.
            battleMode: 'capture',
            // instanceId lists. These were speciesId lists while one party slot
            // per species was guaranteed; now that catching a duplicate makes a
            // second, separate Pokémon, only the instanceId identifies which one
            // you starred or put on the team. instanceIds travel with the save,
            // so they still line up across devices — see mergeCloudState.
            favouriteIds: [],
            teamIds: [],
            // The PVP line-up, kept apart from teamIds on purpose. The EXP team
            // decides who shares the partner's study EXP, which is a long-term
            // commitment; a battle line-up is picked to beat the trainer in
            // front of you and changed again next match. Tying them together
            // meant every PVP tweak quietly re-routed EXP for the rest of the
            // day. Ordered — slot 1 leads — and persisted, so a line-up that
            // worked is still there next time.
            pvpTeamIds: [],
            isHidden: false,
            activeInstanceId: null,
            party: [],
            // instanceIds this account has traded away. mergeCloudState only
            // ever adds party members, so without a tombstone a device that had
            // not synced since the trade would hand the Pokémon straight back —
            // and the student would end up with both halves of the trade.
            releasedIds: [],
            // tradeIds already applied on this account, so a replayed trade
            // cannot run twice. Bounded — only the recent ones can still replay.
            appliedTrades: [],
            // { type, expiresAt } from a PVP win. One at a time, by design —
            // see REWARD_DURATION_MS in flickemon-config.js.
            activeReward: null,
            // Set on a PVP loss; wins earn nothing until it passes. See
            // PVP_LOSS_LOCKOUT_MS in flickemon-config.js.
            rewardLockUntil: 0,
            pokedex: [],
            // Derived — the sum of studyMinutes below. Kept as a field because
            // the admin portal queries it as a column, and because every older
            // save has it.
            totalMinutesWatched: 0,
            // Study time credited per source, so two devices watching in the
            // same period ADD UP. This used to be one cumulative number merged
            // with Math.max, which silently discarded the smaller side: a
            // student watching 30 minutes on a laptop and 40 on a desktop
            // between syncs was credited 40, not 70.
            //
            // `legacy` holds the pre-migration figure, still merged with max
            // because it is already a merged number and the lost time cannot be
            // recovered retroactively. Every other key is a source — a device,
            // or one day something that is not this extension at all.
            studyMinutes: {},
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
        s.releasedIds = Array.isArray(s.releasedIds)
            ? [...new Set(s.releasedIds.filter(id => typeof id === 'string'))]
            : [];
        // A reward that expired while the tab was closed is simply over.
        if (!s.activeReward || typeof s.activeReward !== 'object'
            || !Number.isFinite(s.activeReward.expiresAt)
            || s.activeReward.expiresAt <= Date.now()
            || !Object.values(this.config.REWARDS).includes(s.activeReward.type)) {
            s.activeReward = null;
        }

        s.appliedTrades = Array.isArray(s.appliedTrades)
            ? [...new Set(s.appliedTrades.filter(id => typeof id === 'string'))].slice(-50)
            : [];

        // Drop entries that would break lookups later.
        s.party = s.party.filter(p => p && p.instanceId && Number.isFinite(p.speciesId));
        s.pokedex = s.pokedex.filter(e => e && Number.isFinite(e.speciesId));

        s.party.forEach(p => {
            if (!Number.isFinite(p.level)) p.level = 1;
            if (!Number.isFinite(p.totalExp)) p.totalExp = this.config.expForLevel(p.level);
            // Saves from before shinies existed have no flag; absent means no.
            p.shiny = p.shiny === true;
        });

        if (s.battleMode !== this.config.BATTLE_MODES.EXP) s.battleMode = this.config.BATTLE_MODES.CAPTURE;

        // Anything traded away is gone, whichever list it turns up in.
        const released = new Set(s.releasedIds);
        s.party = s.party.filter(p => !released.has(p.instanceId));

        // Two party entries sharing an instanceId is corruption, not a duplicate
        // catch — a real duplicate gets its own id.
        const owned = new Set();
        s.party = s.party.filter(p => {
            if (owned.has(p.instanceId)) return false;
            owned.add(p.instanceId);
            return true;
        });
        s.party = s.party.slice(0, this.config.MAX_PARTY_SIZE);

        // A number in either list is a save from schema 1, when these held
        // speciesIds. Resolve each to a party member of that species, taking a
        // different one per entry so a v1 team of six stays a team of six.
        const migrateIds = (list) => {
            if (!Array.isArray(list)) return [];
            const out = [];
            const seenSpecies = new Set();
            for (const id of list) {
                if (typeof id === 'string') {
                    if (owned.has(id) && !out.includes(id)) out.push(id);
                    continue;
                }
                if (!Number.isFinite(id)) continue;
                // v1 guaranteed one party slot per species and deduped these
                // lists, so the same speciesId appearing twice was redundancy in
                // the list — not a claim to two Pokémon.
                if (seenSpecies.has(id)) continue;
                seenSpecies.add(id);
                const match = s.party.find(p => p.speciesId === id);
                if (match && !out.includes(match.instanceId)) out.push(match.instanceId);
            }
            return out;
        };
        s.favouriteIds = migrateIds(s.favouriteIds);
        s.teamIds = migrateIds(s.teamIds).slice(0, this.config.MAX_TEAM_SIZE);
        s.pvpTeamIds = migrateIds(s.pvpTeamIds).slice(0, this.config.MAX_TEAM_SIZE);

        // A lockout that ran out while the tab was closed is simply over.
        if (!Number.isFinite(s.rewardLockUntil) || s.rewardLockUntil <= Date.now()) {
            s.rewardLockUntil = 0;
        }
        s.schemaVersion = 2;
        if (!Number.isFinite(s.totalMinutesWatched) || s.totalMinutesWatched < 0) s.totalMinutesWatched = 0;

        // Migrate a pre-split save: whatever it accumulated becomes `legacy`.
        // The test is "no buckets yet", not "field missing" — createEmptyState
        // supplies an empty object, so a missing-field check never fires and
        // the student's whole history would be dropped on load.
        if (!s.studyMinutes || typeof s.studyMinutes !== 'object' || Array.isArray(s.studyMinutes)) {
            s.studyMinutes = {};
        }
        if (Object.keys(s.studyMinutes).length === 0 && s.totalMinutesWatched > 0) {
            s.studyMinutes = { legacy: s.totalMinutesWatched };
        }
        for (const [source, minutes] of Object.entries(s.studyMinutes)) {
            if (!Number.isFinite(minutes) || minutes < 0) delete s.studyMinutes[source];
        }
        s.totalMinutesWatched = this.sumStudyMinutes(s.studyMinutes);
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

        await this.loadDeviceId();

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
            // Tells the receiving device how to read party/teamIds/favouriteIds.
            schemaVersion: this.gameState.schemaVersion || 2,
            hasStarted: this.gameState.hasStarted,
            releasedIds: this.gameState.releasedIds || [],
            appliedTrades: this.gameState.appliedTrades || [],
            activeReward: this.gameState.activeReward || null,
            activeInstanceId: this.gameState.activeInstanceId,
            party: this.gameState.party,
            pokedex: this.gameState.pokedex,
            totalMinutesWatched: this.gameState.totalMinutesWatched,
            studyMinutes: this.gameState.studyMinutes || {},
            battleMode: this.gameState.battleMode,
            favouriteIds: this.gameState.favouriteIds,
            teamIds: this.gameState.teamIds,
            pvpTeamIds: this.gameState.pvpTeamIds || [],
            rewardLockUntil: this.gameState.rewardLockUntil || 0,
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
        // Study time merges per source and then sums. Each source is monotonic
        // on its own, so max() per key is still right — but taking the max of
        // the TOTALS, as this used to, threw away whatever the other device had
        // watched in the same period.
        const cloudMinutes = (cloud.studyMinutes && typeof cloud.studyMinutes === 'object')
            ? cloud.studyMinutes
            // A save from before the split contributes its total as `legacy`.
            : (cloud.totalMinutesWatched ? { legacy: cloud.totalMinutesWatched } : {});

        const merged = { ...(this.gameState.studyMinutes || {}) };
        for (const [source, minutes] of Object.entries(cloudMinutes)) {
            if (!Number.isFinite(minutes) || minutes < 0) continue;
            merged[source] = Math.max(merged[source] || 0, minutes);
        }
        this.gameState.studyMinutes = merged;
        this.gameState.totalMinutesWatched = this.sumStudyMinutes(merged);

        // Pokédex: union. Caught outranks merely seen.
        for (const entry of cloud.pokedex || []) {
            this.updatePokedex(entry.speciesId, Boolean(entry.caught), Boolean(entry.shiny));
        }

        // Party reconciliation depends on which schema wrote the remote save.
        //
        // Schema 2 identifies a Pokémon by instanceId. That id is generated once
        // and then travels with the save, so the same catch arriving from
        // another device lands on the same entry, while two genuinely separate
        // catches of one species stay two party members.
        //
        // Schema 1 saves were written while one party slot per species was
        // guaranteed, and their instanceIds were minted per device — the same
        // Pikachu carries a different id on each. Merging those by instanceId
        // would duplicate a student's entire party the first time their second
        // device synced, so a v1 remote is still reconciled by species. One push
        // later the cloud is v2 and this path stops being reachable.
        const remoteSchema = Number(cloud.schemaVersion) || 1;

        // Tombstones are monotonic and merge as a union: once either side has
        // seen a Pokémon leave, it stays gone everywhere.
        const released = new Set([...(this.gameState.releasedIds || []),
                                  ...(Array.isArray(cloud.releasedIds) ? cloud.releasedIds : [])]);
        this.gameState.releasedIds = [...released];
        this.gameState.appliedTrades = [...new Set([
            ...(this.gameState.appliedTrades || []),
            ...(Array.isArray(cloud.appliedTrades) ? cloud.appliedTrades : []),
        ])].slice(-50);
        if (this.gameState.party.some(p => released.has(p.instanceId))) {
            this.gameState.party = this.gameState.party.filter(p => !released.has(p.instanceId));
        }

        if (remoteSchema >= 2) {
            const byInstance = new Map(this.gameState.party.map(p => [p.instanceId, p]));
            for (const remote of cloud.party || []) {
                if (!remote || !remote.instanceId) continue;
                if (released.has(remote.instanceId)) continue;   // traded away
                const local = byInstance.get(remote.instanceId);
                if (!local) {
                    if (this.gameState.party.length >= this.config.MAX_PARTY_SIZE) break;
                    const copy = { ...remote };
                    this.gameState.party.push(copy);
                    byInstance.set(copy.instanceId, copy);
                } else if ((remote.totalExp || 0) > (local.totalExp || 0)) {
                    local.level = remote.level;
                    local.totalExp = remote.totalExp;
                    // Evolution is a species change on a stable instance, so the
                    // further-along copy also carries the newer form.
                    if (Number.isFinite(remote.speciesId)) local.speciesId = remote.speciesId;
                }
            }
        } else {
            for (const remote of cloud.party || []) {
                const local = this.gameState.party.find(p => p.speciesId === remote.speciesId);
                if (!local) {
                    this.gameState.party.push({ ...remote });
                } else if ((remote.totalExp || 0) > (local.totalExp || 0)) {
                    local.level = remote.level;
                    local.totalExp = remote.totalExp;
                }
            }
        }

        // Active partner: instanceIds line up under schema 2. A v1 remote needs
        // the species fallback, for the same reason its party does.
        const remoteActive = (cloud.party || []).find(p => p.instanceId === cloud.activeInstanceId);
        if (remoteActive) {
            const localMatch = remoteSchema >= 2
                ? this.gameState.party.find(p => p.instanceId === remoteActive.instanceId)
                : this.gameState.party.find(p => p.speciesId === remoteActive.speciesId);
            if (localMatch) this.gameState.activeInstanceId = localMatch.instanceId;
        }
        if (!this.getActivePokemon() && this.gameState.party.length > 0) {
            this.gameState.activeInstanceId = this.gameState.party[0].instanceId;
        }

        // A running reward follows the student to whichever device they open
        // next. The later expiry wins: a device that has been closed all hour
        // must not cut short a boost earned somewhere else.
        const localReward = this.gameState.activeReward;
        const cloudReward = cloud.activeReward;
        if (cloudReward && Number.isFinite(cloudReward.expiresAt)
            && cloudReward.expiresAt > Date.now()
            && (!localReward || cloudReward.expiresAt > localReward.expiresAt)) {
            this.gameState.activeReward = { ...cloudReward };
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
            // These lists speak the remote's schema: v2 sends instanceIds, v1
            // sent speciesIds. Either way, only ids naming a Pokémon this device
            // actually has are adopted.
            const adopt = (list) => {
                if (!Array.isArray(list)) return null;
                const out = [];
                for (const id of list) {
                    // A v1 remote names species, and named each at most once.
                    const match = remoteSchema >= 2
                        ? this.gameState.party.find(p => p.instanceId === id)
                        : this.gameState.party.find(p => p.speciesId === id);
                    if (match && !out.includes(match.instanceId)) out.push(match.instanceId);
                }
                return out;
            };
            const fav = adopt(cloud.favouriteIds);
            if (fav) this.gameState.favouriteIds = fav;
            const team = adopt(cloud.teamIds);
            if (team) this.gameState.teamIds = team.slice(0, this.config.MAX_TEAM_SIZE);
            const pvpTeam = adopt(cloud.pvpTeamIds);
            if (pvpTeam) this.gameState.pvpTeamIds = pvpTeam.slice(0, this.config.MAX_TEAM_SIZE);
        }

        // The LATER lockout wins, unlike the preferences above, and it is taken
        // regardless of which save is newer. A lockout is a penalty, so the
        // merge rule that matters is the one a student cannot game: picking up
        // a second device must never be a way to shed a loss.
        if (Number.isFinite(cloud.rewardLockUntil)) {
            this.gameState.rewardLockUntil =
                Math.max(this.gameState.rewardLockUntil || 0, cloud.rewardLockUntil);
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
            // The games roll for the starter as well, and a shiny one is the
            // kind of thing a student tells people about.
            shiny: this.config.rollShiny(),
            level: 5,
            totalExp: this.config.expForLevel(5),
        };

        this.gameState.hasStarted = true;
        this.gameState.party = [starterInstance];
        this.gameState.activeInstanceId = starterInstance.instanceId;
        this.updatePokedex(speciesId, true, starterInstance.shiny);

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

    // ── Trading bridge (see background/trade.js) ──
    async tradeOpen(payload)        { return await this.sendToWorker({ type: 'TRADE_OPEN', payload }); }
    async tradeRead(code)           { return await this.sendToWorker({ type: 'TRADE_READ', code }); }
    async tradeJoin(code, payload)  { return await this.sendToWorker({ type: 'TRADE_JOIN', code, payload }); }
    async tradeOffer(code, offer)   { return await this.sendToWorker({ type: 'TRADE_OFFER', code, offer }); }
    async tradeConfirm(code, c)     { return await this.sendToWorker({ type: 'TRADE_CONFIRM', code, confirmed: c }); }
    async tradeAck(code)            { return await this.sendToWorker({ type: 'TRADE_ACK', code }); }
    async tradeClose(code)          { return await this.sendToWorker({ type: 'TRADE_CLOSE', code }); }

    // ─────────────────────── PVP line-up ───────────────────────
    //
    // Stored separately from the EXP team (see pvpTeamIds in createEmptyState).
    // Any party member may be picked, not only the six sharing study EXP, and
    // the order is the order they were added — slot 1 leads.

    /** The saved PVP line-up as instanceIds, dropping anything no longer owned. */
    getPvpTeam() {
        const owned = new Set(this.gameState.party.map(p => p.instanceId));
        const stored = (this.gameState.pvpTeamIds || []).filter(id => owned.has(id));

        // An account that has never opened PVP starts from its EXP team rather
        // than from nothing — an empty line-up on first visit reads as a bug,
        // and the EXP team is the best guess at who this student battles with.
        // Not written back: the first real edit is what makes it a saved
        // line-up, and until then the two should keep tracking each other.
        if (stored.length === 0) return this.getTeam();

        return stored.slice(0, this.config.MAX_TEAM_SIZE);
    }

    isOnPvpTeam(instanceId) { return this.getPvpTeam().includes(instanceId); }

    isPvpTeamFull() { return this.getPvpTeam().length >= this.config.MAX_TEAM_SIZE; }

    /**
     * Adds or removes one Pokémon from the PVP line-up.
     *
     * Returns { ok, reason }. Unlike the EXP team there is no protected member:
     * the active partner has no special standing in a battle line-up, which is
     * the whole reason these are two lists. Removing everyone is allowed right
     * up to the last one, since a line-up of nobody cannot enter a match.
     */
    async togglePvpTeamMember(instanceId) {
        const list = this.getPvpTeam().slice();   // materialises the EXP-team seed
        const i = list.indexOf(instanceId);

        if (i >= 0) {
            if (list.length <= 1) return { ok: false, reason: 'last' };
            list.splice(i, 1);
        } else {
            if (list.length >= this.config.MAX_TEAM_SIZE) return { ok: false, reason: 'full' };
            if (!this.gameState.party.some(p => p.instanceId === instanceId)) {
                return { ok: false, reason: 'unknown' };
            }
            list.push(instanceId);
        }

        this.gameState.pvpTeamIds = list;
        this.emitState();
        await this.saveGameState();
        return { ok: true };
    }

    /**
     * The team taken into a PVP battle, as plain battle-ready combatants.
     * Sent over the wire so the opponent can render and simulate it without
     * needing to look anything up.
     *
     * `size` is the format's team size, and the cut is taken from the front of
     * the line-up — so in 1v1 slot 1 is the entrant.
     */
    buildPvpTeam(size = this.config.MAX_TEAM_SIZE) {
        const B = window.FlickemonBattle;
        const out = [];
        for (const instanceId of this.getPvpTeam()) {
            const member = this.gameState.party.find(p => p.instanceId === instanceId);
            if (!member) continue;
            const species = this.config.getSpeciesById(member.speciesId);
            // Two of the same species are two distinct combatants, each built
            // from its own level and moveset.
            if (species) out.push(B.toCombatant(member, species, this.config));
        }
        return out.slice(0, Math.max(1, size));
    }

    // ─────────────────────── PVP victory rewards ───────────────────────

    /** The running boost, or null. Expiry is checked on read, never on a timer. */
    getActiveReward() {
        const r = this.gameState.activeReward;
        if (!r) return null;
        if (r.expiresAt <= Date.now()) {
            this.gameState.activeReward = null;
            return null;
        }
        return { ...r, msLeft: r.expiresAt - Date.now() };
    }

    /** Milliseconds left on the post-loss lockout, or 0 when there is none. */
    getRewardLock() {
        const until = this.gameState.rewardLockUntil || 0;
        if (until <= Date.now()) {
            if (until) this.gameState.rewardLockUntil = 0;
            return 0;
        }
        return until - Date.now();
    }

    /**
     * Starts the no-reward window after a defeat.
     *
     * Extends rather than replaces, so losing twice in a row cannot shorten the
     * lockout the first loss started.
     */
    async recordPvpLoss() {
        const until = Date.now() + this.config.PVP_LOSS_LOCKOUT_MS;
        this.gameState.rewardLockUntil = Math.max(this.gameState.rewardLockUntil || 0, until);
        this.emitState();
        await this.saveGameState({ immediate: true });
        return { lockedForMs: this.getRewardLock() };
    }

    /**
     * Grants a random boost for winning a PVP battle.
     *
     * Refuses while one is already running, and that refusal is the feature: it
     * caps what battling can be worth per hour, so the way to benefit from a
     * reward is to spend the hour watching lectures rather than queueing for
     * another match.
     */
    async grantPvpReward(durationMs = this.config.REWARD_DURATION_MS) {
        const running = this.getActiveReward();
        if (running) return { granted: false, reason: 'active', reward: running };

        // A recent loss pays nothing, however the next match went.
        const lockMsLeft = this.getRewardLock();
        if (lockMsLeft > 0) return { granted: false, reason: 'locked', msLeft: lockMsLeft };

        // The caller passes the format's duration. Clamped rather than trusted:
        // this figure decides how long a boost runs, and it arrives from the
        // battle document, which the opponent can also write.
        const ms = Number.isFinite(durationMs)
            ? Math.min(this.config.PVP_MODES[this.config.PVP_MODES.length - 1].rewardMs,
                       Math.max(this.config.PVP_MODES[0].rewardMs, durationMs))
            : this.config.REWARD_DURATION_MS;

        const type = this.config.rollReward();
        this.gameState.activeReward = { type, expiresAt: Date.now() + ms, durationMs: ms };
        this.emitState();
        await this.saveGameState({ immediate: true });
        return { granted: true, reward: this.getActiveReward() };
    }

    /** Multiplier applied to every EXP gain while the EXP boost is running. */
    rewardExpMultiplier() {
        const r = this.getActiveReward();
        return r && r.type === this.config.REWARDS.EXP ? this.config.REWARD_EXP_MULTIPLIER : 1;
    }

    rewardLegendaryMultiplier() {
        const r = this.getActiveReward();
        return r && r.type === this.config.REWARDS.LEGENDARY
            ? this.config.REWARD_LEGENDARY_MULTIPLIER : 1;
    }

    rewardShinyMultiplier() {
        const r = this.getActiveReward();
        return r && r.type === this.config.REWARDS.SHINY
            ? this.config.REWARD_SHINY_MULTIPLIER : 1;
    }

    // ─────────────────────────── Trading ───────────────────────────

    /** Party members this account may put up for trade. */
    tradableParty() {
        // Trading away your last Pokémon would leave nothing to play with, so
        // the final one is never on offer — the same rule the games use.
        if (this.gameState.party.length <= 1) return [];
        return [...this.gameState.party];
    }

    /**
     * Applies one completed trade: `givenId` leaves, `received` arrives.
     *
     * Idempotent on tradeId. Each side applies the trade from its own copy of
     * the shared document, and a client that reconnects mid-trade replays it —
     * without the guard, that would run twice and cost the student a Pokémon.
     */
    async applyTrade(tradeId, givenId, received) {
        if (!tradeId || !givenId || !received || !received.speciesId) {
            return { ok: false, reason: 'malformed' };
        }
        this.gameState.appliedTrades = this.gameState.appliedTrades || [];
        if (this.gameState.appliedTrades.includes(tradeId)) {
            return { ok: true, alreadyApplied: true };
        }

        const given = this.gameState.party.find(p => p.instanceId === givenId);
        if (!given) return { ok: false, reason: 'missing' };

        const wasActive = this.gameState.activeInstanceId === givenId;

        // The arriving Pokémon gets a fresh instanceId. The sender's id is now
        // tombstoned on their account, and reusing it here would collide with
        // that tombstone the moment either save reached a shared device.
        const arrival = {
            instanceId: this.generateId(),
            speciesId: received.speciesId,
            level: Math.max(1, Math.min(this.config.MAX_LEVEL, Number(received.level) || 1)),
            totalExp: Number.isFinite(received.totalExp)
                ? received.totalExp
                : this.config.expForLevel(Number(received.level) || 1),
            shiny: received.shiny === true,
        };

        this.gameState.party = this.gameState.party.filter(p => p.instanceId !== givenId);
        this.gameState.releasedIds = [...new Set([...(this.gameState.releasedIds || []), givenId])];
        this.gameState.party.push(arrival);

        // The departed Pokémon cannot stay on either team or in the favourites.
        this.gameState.teamIds = (this.gameState.teamIds || []).filter(id => id !== givenId);
        this.gameState.pvpTeamIds = (this.gameState.pvpTeamIds || []).filter(id => id !== givenId);
        this.gameState.favouriteIds = (this.gameState.favouriteIds || []).filter(id => id !== givenId);
        if (wasActive) this.gameState.activeInstanceId = arrival.instanceId;

        this.updatePokedex(arrival.speciesId, true, arrival.shiny);
        this.gameState.appliedTrades = [...this.gameState.appliedTrades, tradeId].slice(-50);

        this.emitState();
        await this.saveGameState({ immediate: true });   // never risk losing a trade
        return { ok: true, received: arrival };
    }

    // ─────────────────────── Favourites & Team ───────────────────────

    isFavourite(instanceId) { return (this.gameState.favouriteIds || []).includes(instanceId); }

    async toggleFavourite(instanceId) {
        const list = this.gameState.favouriteIds || (this.gameState.favouriteIds = []);
        const i = list.indexOf(instanceId);
        if (i >= 0) list.splice(i, 1); else list.push(instanceId);
        this.emitState();
        await this.saveGameState();
    }

    /**
     * Species training together. The active partner is always a member — it is
     * implicit rather than stored, so switching partners can never leave the
     * team in a state where the Pokémon actually battling is excluded.
     */
    /** The team as instanceIds, partner first. Computed, never stored. */
    getTeam() {
        const active = this.getActivePokemon();
        const stored = (this.gameState.teamIds || [])
            .filter(id => !active || id !== active.instanceId);
        const team = active ? [active.instanceId, ...stored] : stored;
        return team.slice(0, this.config.MAX_TEAM_SIZE);
    }

    isOnTeam(instanceId) { return this.getTeam().includes(instanceId); }

    isTeamFull() { return this.getTeam().length >= this.config.MAX_TEAM_SIZE; }

    /**
     * Returns { ok, reason }. The reason matters: rejecting because a Pokémon is
     * the active partner is a different situation from a full team, and showing
     * "team is full" for both is actively misleading.
     */
    async toggleTeamMember(instanceId) {
        const active = this.getActivePokemon();
        if (active && instanceId === active.instanceId) {
            return { ok: false, reason: 'active' }; // the partner is always aboard
        }

        const list = this.gameState.teamIds || (this.gameState.teamIds = []);
        const i = list.indexOf(instanceId);
        if (i >= 0) {
            list.splice(i, 1);
        } else {
            if (this.isTeamFull()) return { ok: false, reason: 'full' };
            list.push(instanceId);
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
                    // Catching a species you already own gives you a second,
                    // separate Pokémon with its own level — both show in the
                    // party and either can go on a PVP team. Previously the
                    // duplicate was dropped on the floor while the widget still
                    // announced a capture, so beating a Lv.40 of something you
                    // held at Lv.5 was worth nothing but the EXP.
                    const atCapacity = this.gameState.party.length >= this.config.MAX_PARTY_SIZE;
                    const isNewSpecies = !this.gameState.party
                        .some(p => p.speciesId === this.wildOpponent.wildSpecies.id);

                    // At the backstop, a species you have never owned still gets
                    // in — losing a Pokédex entry matters, losing a duplicate
                    // does not.
                    if (!atCapacity || isNewSpecies) {
                        this.gameState.party.push({
                            instanceId: this.generateId(),
                            speciesId: this.wildOpponent.wildSpecies.id,
                            level: this.wildOpponent.wildLevel,
                            totalExp: this.config.expForLevel(this.wildOpponent.wildLevel),
                            shiny: this.wildOpponent.shiny === true,
                        });
                    }
                    this.updatePokedex(this.wildOpponent.wildSpecies.id, true,
                                       this.wildOpponent.shiny === true);
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
        this.creditStudyMinutes(this.studySource(), secondsWatched / 60);
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
            // Decided at encounter, not at capture, so the widget shows the
            // alternate colouring for the whole fight — the tell that makes a
            // student look up from their notes.
            shiny: Math.random() < this.config.SHINY_CHANCE * this.rewardShinyMultiplier(),
        };

        this.gameState.wildOpponent = this.wildOpponent;
        this.updatePokedex(wildSpecies.id, false);
        this.emitWild();
        this.saveGameState();
    }

    rollWildPokemon() {
        const active = this.getActivePokemon();
        const activeLevel = active ? active.level : 5;

        // Legendary check (Lv40+, 1% base, multiplied while the radar is running)
        const legendaryChance = Math.min(0.5, 0.01 * this.rewardLegendaryMultiplier());
        if (activeLevel >= 40 && Math.random() <= legendaryChance) {
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

    addExpToActive(rawExp) {
        const active = this.getActivePokemon();
        if (!active || active.level >= this.config.MAX_LEVEL) return null;

        // Every EXP gain in the game funnels through here — battle wins, escape
        // consolation, and by extension the team's share — so the PVP boost is
        // applied once, at the source.
        const exp = Math.round(rawExp * this.rewardExpMultiplier());

        active.totalExp += exp;
        const newLevel = Math.min(this.config.MAX_LEVEL, this.config.levelFromExp(active.totalExp));
        if (newLevel > active.level) {
            active.level = newLevel;
        }

        // Everyone else on the team trains alongside, at a reduced rate.
        this.shareExpWithTeam(exp, active.instanceId);

        const evolution = this.config.canEvolveAt(active.speciesId, active.level);
        if (evolution) {
            const fromSpecies = this.config.getSpeciesById(active.speciesId);
            const toSpecies = this.config.getSpeciesById(evolution.toId);
            if (fromSpecies && toSpecies) {
                // Team and favourites hold instanceIds, and an evolution keeps
                // the instance — so, unlike the speciesId lists this replaced,
                // there is nothing to rewrite here.
                active.speciesId = evolution.toId;
                this.updatePokedex(evolution.toId, true, active.shiny === true);
                this.evolutionListeners.forEach(cb => cb({
                    from: fromSpecies, to: toSpecies, shiny: active.shiny === true,
                }));
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
     * Team members evolve too, and now announce it. They used to do so silently,
     * because the overlay was a five-second takeover and several members
     * crossing a threshold on the same battle would have stacked on top of each
     * other. The overlay queues since then — one at a time, with a backlog
     * count — so the reason for hiding them is gone, and an evolution the
     * student earned should not happen off-screen.
     */
    shareExpWithTeam(exp, activeInstanceId) {
        const shared = Math.round(exp * this.config.TEAM_EXP_SHARE);
        if (shared <= 0) return;

        for (const instanceId of this.getTeam()) {
            if (instanceId === activeInstanceId) continue;

            // By instanceId, so one of your two Pikachu can be on the team and
            // train while the other sits in the party untouched.
            const member = this.gameState.party.find(p => p.instanceId === instanceId);
            if (!member || member.level >= this.config.MAX_LEVEL) continue;

            member.totalExp += shared;
            member.level = Math.min(
                this.config.MAX_LEVEL,
                this.config.levelFromExp(member.totalExp)
            );

            const evo = this.config.canEvolveAt(member.speciesId, member.level);
            if (evo) {
                const from = this.config.getSpeciesById(member.speciesId);
                const to = this.config.getSpeciesById(evo.toId);
                if (from && to) {
                    // The instance keeps its id through an evolution, so the
                    // team and favourite lists still point at it.
                    member.speciesId = evo.toId;
                    this.updatePokedex(evo.toId, true, member.shiny === true);
                    // `benched` lets the overlay say whose evolution this is —
                    // without it, a student watching their Charizard fight sees
                    // a Bulbasaur evolving and has no idea why.
                    this.evolutionListeners.forEach(cb => cb({
                        from, to, shiny: member.shiny === true, benched: true,
                    }));
                }
            }
        }
    }

    // ─────────────────────── Study time ───────────────────────

    sumStudyMinutes(buckets) {
        return Object.values(buckets || {})
            .reduce((total, m) => total + (Number.isFinite(m) && m > 0 ? m : 0), 0);
    }

    /**
     * Which bucket this device's watching goes into.
     *
     * Per device, not per account: two devices watching in the same period must
     * land in different buckets or their totals compete instead of adding. The
     * id lives outside the game state so a reset or a sign-out cannot merge two
     * devices' histories into one bucket.
     */
    studySource() {
        return this.deviceId || 'unknown-device';
    }

    async loadDeviceId() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
            this.deviceId = 'unknown-device';
            return this.deviceId;
        }
        const data = await chrome.storage.local.get([this.DEVICE_KEY]);
        let id = data && data[this.DEVICE_KEY];
        if (typeof id !== 'string' || !id) {
            id = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
            await chrome.storage.local.set({ [this.DEVICE_KEY]: id });
        }
        this.deviceId = id;
        return id;
    }

    /**
     * Credits study time to a named source.
     *
     * Public because the source does not have to be this extension. Anything
     * that can prove the student was watching — a Safari extension on an iPad,
     * a companion page, a figure from the lecture platform itself — can write
     * into its own bucket and have it add to the total rather than compete with
     * it. Each bucket is monotonic, which is what keeps the cross-device merge
     * safe.
     */
    creditStudyMinutes(source, minutes) {
        if (!source || !Number.isFinite(minutes) || minutes <= 0) return;
        this.gameState.studyMinutes = this.gameState.studyMinutes || {};
        this.gameState.studyMinutes[source] = (this.gameState.studyMinutes[source] || 0) + minutes;
        this.gameState.totalMinutesWatched = this.sumStudyMinutes(this.gameState.studyMinutes);
    }

    updatePokedex(speciesId, caught, shiny = false) {
        const existing = this.gameState.pokedex.find(e => e.speciesId === speciesId);
        if (existing) {
            if (caught) existing.caught = true;
            // Monotonic: once a shiny of this species has been caught, the dex
            // keeps saying so even when ordinary ones are caught afterwards.
            if (shiny && caught) existing.shiny = true;
            existing.seen = true;
        } else {
            this.gameState.pokedex.push({
                speciesId, caught, seen: true, shiny: Boolean(shiny && caught),
            });
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
