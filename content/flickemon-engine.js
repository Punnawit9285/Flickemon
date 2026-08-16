/**
 * Flickemon Core Engine (Chrome Extension)
 * ─────────────────────────────────────────
 * Port of FlickemonService.
 * Manages: Game state, Party, Pokédex, Wild battles, Defeat-only EXP, Evolution, and local chrome.storage.local persistence.
 */

class FlickemonEngine {
    constructor() {
        this.STORAGE_KEY = 'flickemon_ext_save_v2';
        this.config = window.FlickemonConfig;

        this.gameState = this.createEmptyState();
        this.isLoaded = false;
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
            hasStarted: false,
            isHidden: false,
            activeInstanceId: null,
            party: [],
            pokedex: [],
            totalMinutesWatched: 0,
            lastSyncedAt: 0,
            wildOpponent: null,
        };
    }

    async init() {
        if (typeof chrome === 'undefined' || !chrome.storage) return;

        // 1. Optimistic UI: Fast load from local storage
        if (chrome.storage.local) {
            const localData = await chrome.storage.local.get([this.STORAGE_KEY]);
            if (localData && localData[this.STORAGE_KEY]) {
                this.gameState = localData[this.STORAGE_KEY];
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
        return status || { configured: false, signedIn: false, email: null, pending: false };
    }

    async signIn() {
        const res = await this.sendToWorker({ type: 'AUTH_SIGN_IN' });
        if (!res || res.ok === false) {
            throw new Error(res?.error || 'Sign-in failed');
        }
        // First sign-in on this device: reconcile local progress with the account.
        await this.pullFromCloud();
        await this.flushCloud();
        return res;
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

        const POLL_MS = 90000;
        this.cloudPollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') {
                this.pullFromCloud().catch(() => {});
            }
        }, POLL_MS);

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
    buildCloudPayload() {
        return {
            hasStarted: this.gameState.hasStarted,
            activeInstanceId: this.gameState.activeInstanceId,
            party: this.gameState.party,
            pokedex: this.gameState.pokedex,
            totalMinutesWatched: this.gameState.totalMinutesWatched,
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

        this.cloudDirty = false;
        this.cloudInFlight = true;
        try {
            const res = await this.sendToWorker({ type: 'CLOUD_PUSH', state: this.buildCloudPayload() });
            if (res && res.ok) {
                this.lastCloudSyncAt = res.syncedAt;
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
        }, 45000);
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
        }, 1000);
    }

    hasStarted() { return this.gameState.hasStarted; }
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
                const partialExp = Math.round(this.wildOpponent.wildLevel * 10);
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
                // Defeated & Captured! Worth pushing to the cloud right away.
                capturedThisTick = true;
                this.wildOpponent.status = 'captured';
                const winExp = Math.round(this.wildOpponent.wildLevel * this.config.BATTLE_WIN_EXP_BONUS);
                this.wildOpponent.expGained = winExp;

                if (!this.gameState.party.some(p => p.speciesId === this.wildOpponent.wildSpecies.id)) {
                    this.gameState.party.push({
                        instanceId: this.generateId(),
                        speciesId: this.wildOpponent.wildSpecies.id,
                        level: this.wildOpponent.wildLevel,
                        totalExp: this.config.expForLevel(this.wildOpponent.wildLevel),
                    });
                }
                this.updatePokedex(this.wildOpponent.wildSpecies.id, true);

                const evoResult = this.addExpToActive(winExp);

                this.encounterListeners.forEach(cb => cb({
                    wildSpecies: this.wildOpponent.wildSpecies,
                    wildLevel: this.wildOpponent.wildLevel,
                    won: true,
                    captured: true,
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

        const evolution = this.config.canEvolveAt(active.speciesId, active.level);
        if (evolution) {
            const fromSpecies = this.config.getSpeciesById(active.speciesId);
            const toSpecies = this.config.getSpeciesById(evolution.toId);
            if (fromSpecies && toSpecies) {
                active.speciesId = evolution.toId;
                this.updatePokedex(evolution.toId, true);
                this.evolutionListeners.forEach(cb => cb({ from: fromSpecies, to: toSpecies }));
                return toSpecies;
            }
        }

        this.emitState();
        return null;
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
