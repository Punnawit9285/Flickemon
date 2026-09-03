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

// How rarely the friend feed may be republished. See publishFriendFeed: this
// number was chosen from a measurement, not an estimate.
const FEED_PUBLISH_FLOOR_MS = 600000;

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
    async adminSummonOpponent(speciesId, { shiny = false, level, megaForm = null } = {}) {
        const species = this.config.getSpeciesById(Number(speciesId));
        if (!species) return { ok: false, reason: 'unknown-species' };

        // A mega can only be summoned for a species that actually has that form.
        const forms = this.config.megaFormsFor(species.id);
        const mega = megaForm ? forms.find(f => f.key === megaForm) : null;
        if (megaForm && !mega) return { ok: false, reason: 'unknown-mega' };

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
            megaForm: mega ? mega.key : null,
        };

        this.gameState.wildOpponent = this.wildOpponent;
        this.updatePokedex(species.id, false);
        this.emitWild();
        await this.saveGameState();
        return { ok: true, species, level: wildLevel, shiny: shiny === true, mega: mega || null };
    }

    /**
     * Writes off the EXP debt an instant capture ran up.
     *
     * The debt is the whole cost of that button, so clearing it is the one
     * admin tool that hands out something the game charges for. It is here for
     * testing the instant-capture path without then having to win ten battles
     * to get back to a normal state.
     *
     * Reports what it cleared rather than just succeeding, so an admin can see
     * whether there was anything to clear at all.
     */
    async adminClearExpDebt() {
        const cleared = this.getExpDebt();
        if (cleared === 0) return { ok: true, cleared: 0 };

        this.gameState.expDebt = 0;
        this.emitState();
        await this.saveGameState({ immediate: true });
        return { ok: true, cleared };
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
                // A stone carried since before this form could use it wakes up
                // here. It rides the same listener, so the queue plays the mega
                // scene directly after the evolution scene rather than at once.
                const woke = this.wakeDormantMega(active);
                if (woke && this.claimMegaScene(active, woke.key)) {
                    this.evolutionListeners.forEach(cb => cb({
                        kind: 'mega', form: woke, species: toSpecies,
                        shiny: active.shiny === true,
                    }));
                }
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
            // Wins still owed to an instant capture. Counts DOWN, one per win.
            // See INSTANT_CAPTURE_EXP_DEBT in flickemon-config.js.
            expDebt: 0,
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

            // ── Friends ──
            //
            // Game progress per day, per source. Feeds the friends screen and
            // the streak, and deliberately measures EXP rather than minutes:
            // the ask was to show how much someone LEARNED, and a figure in
            // hours turns a study tool into a competition about sitting still.
            //
            // Bucketed by source for exactly the reason studyMinutes above is.
            // A single number merged with Math.max silently discarded whatever
            // the other device had earned in the same period; two devices in
            // one evening must ADD UP.
            //
            //   { '2026-09-03': { 'device-abc': { exp, levels, caught } } }
            //
            // Pruned to DAILY_HISTORY_DAYS, so it can never become the largest
            // thing in the save.
            dailyProgress: {},
            // The name other students see. Claimed in usernames/{name}; held
            // here so the panel can render before the network answers.
            username: '',
            // Which of FRIEND_FIELDS this account publishes. Absent from the
            // feed document entirely when off — see publishFriendFeed.
            friendPrivacy: null,
            // Friends who see nothing: kept out of the feed's audience list, so
            // the refusal happens at the server rather than in our renderer.
            blockedUids: [],
            // Opt-in, and off until the student presses JOIN. No row exists on
            // the global board until this is true.
            onLeaderboard: false,

            // ── Shop ──
            //
            // The wallet is two counters PER DEVICE, never one balance, and it
            // is the same trick studyMinutes above uses for the same reason.
            // mergeCloudState is monotonic in every other rule so a stale
            // device can never erase a newer one — but a balance goes DOWN when
            // you spend, and neither max() (which would refund every purchase)
            // nor last-writer-wins (which would drop a whole evening's
            // earnings) is correct for that.
            //
            // Earned and spent each only ever count up, so max() per device is
            // right for both, and the balance is the difference of the sums.
            //
            //   { [deviceId]: { earned, spent } }
            shopWallet: {},
            // Eggs bought, hatched or not. What is INSIDE is rolled at purchase
            // and stored here, so a second device hatches the same Pokémon
            // rather than a different one — see buyEgg.
            //   { eggId, itemId, speciesId, shiny, encountersLeft, hatched }
            eggs: [],
            // Which egg is in the incubator. One slot; the rest wait in the bag.
            incubatingId: null,
            // Mega forms owned at ACCOUNT level. A stone bought in the mart is
            // bound to a species, unlike a PVP stone which lands on one
            // individual in party[].megaStones — so every Pokémon of that line
            // can use it, including ones caught later. Unions on merge.
            megaSpecies: [],
            // Permanent boost tiers, { exp, shiny, legendary } -> 0..3. Tiers
            // only ever go up, so max() per key.
            shopBoosts: {},

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

            // Mega stones this individual owns, as form keys.
            //
            // Sorted, because mergeCloudState decides "did anything change" by
            // comparing JSON of the whole payload — an unstable array order
            // would report a change on every merge and spend a Firestore write
            // on nothing.
            //
            // Deliberately NOT filtered against MEGA_FORMS. An older client
            // opening a save written by a newer one with a larger roster would
            // otherwise delete stones it merely does not recognise. Unknown
            // keys round-trip untouched and are ignored only at the point of
            // use, by activeMegaForm.
            p.megaStones = Array.isArray(p.megaStones)
                ? [...new Set(p.megaStones.filter(k => typeof k === 'string'))].sort()
                : [];
            // Nulled only when the stone is not owned — never because the
            // current species has no such form, or a dormant stone held by a
            // pre-evolution would be destroyed on the next load.
            if (typeof p.megaActive !== 'string' || !p.megaStones.includes(p.megaActive)) {
                p.megaActive = null;
            }
            if (!Number.isFinite(p.megaActiveAt)) p.megaActiveAt = 0;
            // Which transformations this Pokemon has already been given a scene
            // for. Unfiltered against MEGA_FORMS for the same reason as
            // megaStones above: an older client must not forget that a newer
            // one already played something, or the scene replays on every
            // device that has not seen it.
            p.megaSeen = Array.isArray(p.megaSeen)
                ? [...new Set(p.megaSeen.filter(k => typeof k === 'string'))].sort()
                : [];
        });

        if (s.battleMode !== this.config.BATTLE_MODES.EXP) s.battleMode = this.config.BATTLE_MODES.CAPTURE;

        // Whole, non-negative, and not unbounded: the debt stacks, so a save
        // that has been round-tripped through something that mangled it should
        // not be able to owe a thousand wins.
        s.expDebt = Number.isFinite(s.expDebt) && s.expDebt > 0
            ? Math.min(Math.floor(s.expDebt), this.config.INSTANT_CAPTURE_EXP_DEBT * 10)
            : 0;

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

        // ── Shop ──
        if (!s.shopWallet || typeof s.shopWallet !== 'object' || Array.isArray(s.shopWallet)) {
            s.shopWallet = {};
        }
        for (const [device, bucket] of Object.entries(s.shopWallet)) {
            if (!bucket || typeof bucket !== 'object') { delete s.shopWallet[device]; continue; }
            const clean = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
            s.shopWallet[device] = { earned: clean(bucket.earned), spent: clean(bucket.spent) };
        }

        // Hatched eggs stay as tombstones so a device that has not synced since
        // cannot put one back in the bag. Bounded like appliedTrades, and the
        // unhatched ones are kept whatever happens — those are things a student
        // paid for.
        s.eggs = Array.isArray(s.eggs) ? s.eggs.filter(e =>
            e && typeof e.eggId === 'string' && Number.isFinite(e.speciesId)) : [];
        s.eggs.forEach(e => {
            e.hatched = e.hatched === true;
            e.shiny = e.shiny === true;
            e.encountersLeft = Number.isFinite(e.encountersLeft)
                ? Math.max(0, Math.floor(e.encountersLeft)) : 0;
        });
        // Sorted, for the reason party[].megaStones is: the cloud fingerprint
        // is JSON of the whole payload, so two devices that merged the same
        // eggs in a different order would look different forever and spend a
        // Firestore write on every sync.
        const byId = (a, b) => (a.eggId < b.eggId ? -1 : a.eggId > b.eggId ? 1 : 0);
        const hatched = s.eggs.filter(e => e.hatched).sort(byId).slice(-50);
        s.eggs = [...s.eggs.filter(e => !e.hatched).sort(byId), ...hatched];
        if (!s.eggs.some(e => e.eggId === s.incubatingId && !e.hatched)) s.incubatingId = null;

        // Deliberately NOT filtered against MEGA_FORMS, for the reason
        // party[].megaStones is not: an older client must round-trip a key it
        // does not recognise rather than delete something that was paid for.
        s.megaSpecies = Array.isArray(s.megaSpecies)
            ? [...new Set(s.megaSpecies.filter(k => typeof k === 'string'))].sort()
            : [];

        if (!s.shopBoosts || typeof s.shopBoosts !== 'object' || Array.isArray(s.shopBoosts)) {
            s.shopBoosts = {};
        }
        for (const kind of Object.keys(s.shopBoosts)) {
            if (!Object.values(this.config.REWARDS).includes(kind)) { delete s.shopBoosts[kind]; continue; }
            const tier = Math.floor(Number(s.shopBoosts[kind]) || 0);
            if (tier <= 0) delete s.shopBoosts[kind];
            else s.shopBoosts[kind] = Math.min(this.config.SHOP_MAX_BOOST_TIER, tier);
        }

        // ── Friends ──
        if (!s.dailyProgress || typeof s.dailyProgress !== 'object'
            || Array.isArray(s.dailyProgress)) {
            s.dailyProgress = {};
        }
        s.dailyProgress = this.pruneDailyProgress(s.dailyProgress);
        s.username = this.config.normaliseUsername(s.username);
        if (!s.friendPrivacy || typeof s.friendPrivacy !== 'object'
            || Array.isArray(s.friendPrivacy)) {
            // Null means "never chosen", which is not the same as "chose to
            // share nothing" — a new account starts sharing with the friends it
            // has explicitly accepted, and has none yet.
            s.friendPrivacy = this.config.defaultFriendPrivacy();
        } else {
            // A field this build does not know about is dropped; one it knows
            // about that is missing defaults to shared. Booleans only, so a
            // hand-edited save cannot smuggle an object in.
            const clean = {};
            for (const f of this.config.FRIEND_FIELDS) {
                clean[f.key] = s.friendPrivacy[f.key] !== false;
            }
            s.friendPrivacy = clean;
        }
        s.blockedUids = Array.isArray(s.blockedUids)
            ? [...new Set(s.blockedUids.filter(id => typeof id === 'string'))]
            : [];
        s.onLeaderboard = s.onLeaderboard === true;

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
     * Sign out and immediately offer a different account.
     *
     * The local save is deliberately NOT discarded here.
     *
     * It used to be wiped before Google's account chooser even opened, which
     * made the chooser the point of no return: cancelling it, dismissing it,
     * being offline, or picking the wrong account and backing out all left the
     * student looking at an empty game. A snapshot was taken, but the only
     * control that restores one is behind the admin unlock — so for an ordinary
     * student the progress was simply gone, from a single unconfirmed tap on a
     * button labelled "Switch account".
     *
     * signIn() already carries the guard this was reaching for: it discards
     * when the account signing in is not the one that owns the save, and it
     * does that AFTER the sign-in has actually succeeded. Signing back in as
     * the same person keeps everything, which is also the right answer.
     *
     * flushCloud() still runs first, while this student is still the
     * authenticated one, so their progress lands in their own account and not
     * in whichever account signs in next.
     */
    async switchAccount() {
        await this.flushCloud();
        await this.sendToWorker({ type: 'AUTH_SWITCH' });
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
            dailyProgress: this.gameState.dailyProgress || {},
            username: this.gameState.username || '',
            friendPrivacy: this.gameState.friendPrivacy || this.config.defaultFriendPrivacy(),
            blockedUids: this.gameState.blockedUids || [],
            onLeaderboard: this.gameState.onLeaderboard === true,
            battleMode: this.gameState.battleMode,
            favouriteIds: this.gameState.favouriteIds,
            teamIds: this.gameState.teamIds,
            pvpTeamIds: this.gameState.pvpTeamIds || [],
            rewardLockUntil: this.gameState.rewardLockUntil || 0,
            expDebt: this.getExpDebt(),
            shopWallet: this.gameState.shopWallet || {},
            eggs: this.gameState.eggs || [],
            incubatingId: this.gameState.incubatingId || null,
            megaSpecies: this.gameState.megaSpecies || [],
            shopBoosts: this.gameState.shopBoosts || {},
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

        // Daily progress merges the same way and for the same reason: max per
        // (day, source), because each source only ever counts up on its own,
        // and summing across sources afterwards. Taking the max of the day
        // TOTALS would throw away a whole device's evening.
        this.gameState.dailyProgress = this.pruneDailyProgress(
            this.mergeDailyProgress(this.gameState.dailyProgress, cloud.dailyProgress));

        // A name is claimed in Firestore, so the cloud copy is the true one --
        // but only when there IS one. A device that has not seen the claim yet
        // must not erase it.
        const cloudName = this.config.normaliseUsername(cloud.username);
        if (cloudName) this.gameState.username = cloudName;

        // Privacy: the more private answer wins whenever two devices disagree.
        // A student who turned sharing off on their phone and has not synced
        // the laptop should not have the laptop turn it back on.
        if (cloud.friendPrivacy && typeof cloud.friendPrivacy === 'object') {
            const mine = this.gameState.friendPrivacy || this.config.defaultFriendPrivacy();
            const out = {};
            for (const f of this.config.FRIEND_FIELDS) {
                out[f.key] = mine[f.key] !== false && cloud.friendPrivacy[f.key] !== false;
            }
            this.gameState.friendPrivacy = out;
        }
        // Blocks union, for the same reason: a block made anywhere holds
        // everywhere, and unblocking is a deliberate act on a synced device.
        if (Array.isArray(cloud.blockedUids)) {
            this.gameState.blockedUids = [...new Set([
                ...(this.gameState.blockedUids || []),
                ...cloud.blockedUids.filter(id => typeof id === 'string'),
            ])];
        }
        // Being ON the board is the less private state, so it needs BOTH sides
        // to agree — leaving on one device takes effect everywhere.
        if (typeof cloud.onLeaderboard === 'boolean') {
            this.gameState.onLeaderboard = this.gameState.onLeaderboard === true
                                        && cloud.onLeaderboard === true;
        }

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
                    continue;
                }
                if ((remote.totalExp || 0) > (local.totalExp || 0)) {
                    local.level = remote.level;
                    local.totalExp = remote.totalExp;
                    // Evolution is a species change on a stable instance, so the
                    // further-along copy also carries the newer form.
                    if (Number.isFinite(remote.speciesId)) local.speciesId = remote.speciesId;
                }

                // Stones union UNCONDITIONALLY — outside the totalExp check
                // above. A stone won on a device that has not studied since is
                // still a stone, and gating it on progress would throw it away.
                if (Array.isArray(remote.megaStones) && remote.megaStones.length) {
                    local.megaStones = [...new Set([
                        ...(local.megaStones || []),
                        ...remote.megaStones.filter(k => typeof k === 'string'),
                    ])].sort();
                }

                // Seen-scenes union for the same reason, and because the
                // alternative is worse in an obvious way: a transformation
                // watched on a laptop replaying on a phone is exactly the
                // repetition the once-only rule exists to prevent.
                if (Array.isArray(remote.megaSeen) && remote.megaSeen.length) {
                    local.megaSeen = [...new Set([
                        ...(local.megaSeen || []),
                        ...remote.megaSeen.filter(k => typeof k === 'string'),
                    ])].sort();
                }

                // The toggle is a preference, so last writer wins — but per
                // member, on its own timestamp, not on the save-wide
                // lastSyncedAt used for battleMode and the team lists. A device
                // syncing later for an unrelated reason must not silently
                // revert a mega it never touched.
                if ((remote.megaActiveAt || 0) > (local.megaActiveAt || 0)) {
                    local.megaActive = typeof remote.megaActive === 'string' ? remote.megaActive : null;
                    local.megaActiveAt = remote.megaActiveAt || 0;
                }
                if (local.megaActive && !(local.megaStones || []).includes(local.megaActive)) {
                    local.megaActive = null;
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
            // Newest write, NOT max(). max() would be the harsher rule and
            // therefore the tempting one, but it can never reach zero: a device
            // that still remembers a debt already paid off elsewhere would keep
            // reimposing it forever.
            if (Number.isFinite(cloud.expDebt)) {
                this.gameState.expDebt = Math.max(0, Math.floor(cloud.expDebt));
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

        // ── Shop ──
        //
        // The wallet merges exactly like studyMinutes: max() per device per
        // counter, then sum. Each counter is monotonic on its own, so max is
        // safe, and summing across devices is what makes two devices earning in
        // the same evening add up instead of competing.
        if (cloud.shopWallet && typeof cloud.shopWallet === 'object') {
            const wallet = { ...(this.gameState.shopWallet || {}) };
            for (const [device, bucket] of Object.entries(cloud.shopWallet)) {
                if (!bucket || typeof bucket !== 'object') continue;
                const mine = wallet[device] || { earned: 0, spent: 0 };
                wallet[device] = {
                    earned: Math.max(mine.earned || 0, Number(bucket.earned) || 0),
                    spent: Math.max(mine.spent || 0, Number(bucket.spent) || 0),
                };
            }
            this.gameState.shopWallet = wallet;
        }

        // Eggs union by eggId. Incubation counts DOWN, so the smaller number is
        // the further-along one and min() is the monotonic rule here; hatched
        // is a one-way door and ORs.
        if (Array.isArray(cloud.eggs)) {
            if (!Array.isArray(this.gameState.eggs)) this.gameState.eggs = [];
            const byId = new Map(this.gameState.eggs.map(e => [e.eggId, e]));
            for (const remote of cloud.eggs) {
                if (!remote || typeof remote.eggId !== 'string') continue;
                const local = byId.get(remote.eggId);
                if (!local) {
                    const copy = { ...remote };
                    this.gameState.eggs.push(copy);
                    byId.set(copy.eggId, copy);
                    continue;
                }
                local.encountersLeft = Math.min(local.encountersLeft || 0,
                                                Number(remote.encountersLeft) || 0);
                local.hatched = local.hatched === true || remote.hatched === true;
            }
        }

        // Stones bought in the mart union unconditionally, for the reason the
        // per-member ones at the party merge above do: a purchase made on a
        // device that has not studied since is still a purchase.
        if (Array.isArray(cloud.megaSpecies) && cloud.megaSpecies.length) {
            this.gameState.megaSpecies = [...new Set([
                ...(this.gameState.megaSpecies || []),
                ...cloud.megaSpecies.filter(k => typeof k === 'string'),
            ])].sort();
        }

        // Tiers only ever go up, so the higher one is the true one.
        if (cloud.shopBoosts && typeof cloud.shopBoosts === 'object') {
            const boosts = { ...(this.gameState.shopBoosts || {}) };
            for (const [kind, tier] of Object.entries(cloud.shopBoosts)) {
                const t = Math.floor(Number(tier) || 0);
                if (t > 0) boosts[kind] = Math.max(boosts[kind] || 0, t);
            }
            this.gameState.shopBoosts = boosts;
        }

        // Which egg is being carried is a preference, not progress, so it
        // follows the newest write like battleMode does — but only to an egg
        // this device actually has and has not already hatched.
        if ((cloud.lastSyncedAt || 0) > (this.gameState.lastSyncedAt || 0)
            && typeof cloud.incubatingId === 'string'
            && (this.gameState.eggs || []).some(e => e.eggId === cloud.incubatingId && !e.hatched)) {
            this.gameState.incubatingId = cloud.incubatingId;
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

    /**
     * Announces a hatch on the evolution channel.
     *
     * Deliberately not a fourth listener list. The overlay queue already solves
     * the hard part — one scene at a time, suspended in fullscreen and replayed
     * on exit — and a separate channel would need all of that again, or hatches
     * would play on top of an evolution.
     */
    emitHatch(result) {
        if (!result) return;
        this.evolutionListeners.forEach(cb => cb({
            kind: 'hatch',
            species: result.species,
            shiny: result.shiny === true,
        }));
    }

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
            megaStones: [],
            megaSeen: [],
            megaActive: null,
            megaActiveAt: 0,
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

    // ─────────────────────────── Friends ───────────────────────────

    async friendClaimName(name)   { return await this.sendToWorker({ type: 'FRIEND_CLAIM_NAME', name }); }
    async friendReleaseName(name) { return await this.sendToWorker({ type: 'FRIEND_RELEASE_NAME', name }); }
    async friendWriteProfile(p)   { return await this.sendToWorker({ type: 'FRIEND_PROFILE', payload: p }); }
    async friendLookup(query)     { return await this.sendToWorker({ type: 'FRIEND_LOOKUP', query }); }
    // These three change who may read this account's feed, so each one drops
    // the cached list and republishes. Without the republish, accepting someone
    // would leave them unable to see anything until the next five-minute tick,
    // and removing someone would leave them able to see everything until then —
    // which is the half that actually matters.
    async friendRequest(uid) {
        const res = await this.sendToWorker({ type: 'FRIEND_REQUEST', uid });
        await this.afterFriendChange();
        return res;
    }

    async friendAccept(uid) {
        const res = await this.sendToWorker({ type: 'FRIEND_ACCEPT', uid });
        await this.afterFriendChange();
        return res;
    }

    async friendRemove(uid) {
        const res = await this.sendToWorker({ type: 'FRIEND_REMOVE', uid });
        await this.afterFriendChange();
        return res;
    }

    async afterFriendChange() {
        this.invalidateFriends();
        await this.loadFriends({ fresh: true }).catch(() => {});
        await this.publishFriendFeed({ force: true }).catch(() => {});
    }
    async friendList(opts = {})   { return await this.sendToWorker({ type: 'FRIEND_LIST', fresh: opts.fresh === true }); }
    async friendFeeds(uids, opts = {}) { return await this.sendToWorker({ type: 'FRIEND_FEEDS', uids, fresh: opts.fresh === true }); }
    async friendBoardRead(dayKey) { return await this.sendToWorker({ type: 'FRIEND_BOARD_READ', dayKey }); }

    // ─────────────────── What this account shares ───────────────────

    getFriendPrivacy() {
        return { ...(this.gameState.friendPrivacy || this.config.defaultFriendPrivacy()) };
    }

    async setFriendPrivacy(key, on) {
        if (!this.config.FRIEND_FIELDS.some(f => f.key === key)) return { ok: false };
        this.gameState.friendPrivacy = {
            ...this.getFriendPrivacy(), [key]: on !== false,
        };
        this.emitState();
        await this.saveGameState({ immediate: true });
        // Republished at once and unconditionally: turning sharing OFF must
        // take the data down now, not at the next five-minute tick. This is the
        // one place the rate limit is deliberately bypassed.
        await this.publishFriendFeed({ force: true }).catch(() => {});
        return { ok: true };
    }

    isBlocked(uid) { return (this.gameState.blockedUids || []).includes(uid); }

    async setBlocked(uid, blocked) {
        const list = new Set(this.gameState.blockedUids || []);
        if (blocked) list.add(uid); else list.delete(uid);
        this.gameState.blockedUids = [...list];
        this.emitState();
        await this.saveGameState({ immediate: true });
        // A block is only real once the audience list no longer names them, so
        // this write is the block. Same reasoning as above.
        await this.publishFriendFeed({ force: true }).catch(() => {});
        return { ok: true };
    }

    getUsername() { return this.gameState.username || ''; }

    /** Claims a name, and only records it locally once the server agreed. */
    async setUsername(raw) {
        const check = this.config.validateUsername(raw);
        if (!check.ok) return { ok: false, reason: check.reason };

        const previous = this.gameState.username || '';
        if (previous === check.name) return { ok: true, name: check.name };

        const res = await this.friendClaimName(check.name);
        if (!res || !res.ok) {
            return { ok: false, reason: res && res.reason === 'taken'
                ? 'Somebody already has that name.'
                : 'Could not claim that name. Try again.' };
        }

        this.gameState.username = check.name;
        this.emitState();
        await this.saveGameState({ immediate: true });
        // Best effort, and after the claim: an old name left behind is untidy,
        // a lost new claim would be a bug.
        if (previous) this.friendReleaseName(previous).catch(() => {});
        await this.publishFriendFeed({ force: true }).catch(() => {});
        return { ok: true, name: check.name };
    }

    isOnLeaderboard() { return this.gameState.onLeaderboard === true; }

    /**
     * Joins or leaves the global board.
     *
     * Leaving DELETES the row rather than hiding it — a document that does not
     * exist cannot be ranked, read, or brought back by a later bug.
     */
    async setOnLeaderboard(joined, email) {
        this.gameState.onLeaderboard = joined === true;
        this.emitState();
        await this.saveGameState({ immediate: true });

        const today = this.todayProgress();
        const res = await this.sendToWorker({
            type: 'FRIEND_BOARD_PUBLISH',
            payload: {
                joined: joined === true,
                label: this.config.leaderboardLabel(this.getUsername(), email),
                dayKey: this.today(),
                todayExp: today.exp,
                levels: today.levels,
                streak: this.currentStreak(),
            },
        });
        return res || { ok: false };
    }

    /**
     * The feed document's contents: exactly what the student has chosen to
     * share, and nothing else.
     *
     * A disabled field is ABSENT rather than blank. There is nothing here for a
     * modified client to reveal, because the information never left this device.
     */
    buildFriendPayload() {
        const privacy = this.getFriendPrivacy();
        const payload = { username: this.getUsername() };

        if (privacy.active) {
            // WHEN, not whether.
            //
            // Publishing a boolean would mean writing a document just to say "I
            // stopped" — and going idle is the one state change nobody is
            // around to trigger a write for, so it would be the least reliable
            // and most expensive thing here. A timestamp goes stale correctly
            // by itself: the reader compares it to the window and sees someone
            // stop without anybody writing anything.
            //
            // Bucketed to five minutes so that time passing does not by itself
            // make the payload different and spend a write on every tick.
            const last = this.lastStudyTickAt || 0;
            payload.activeAt = last > 0 ? Math.floor(last / 300000) * 300000 : 0;
        }

        if (privacy.mon) {
            const active = this.getActivePokemon();
            const species = active && this.config.getSpeciesById(active.speciesId);
            if (species) {
                const form = this.activeMegaForm(active);
                payload.mon = {
                    speciesId: species.id,
                    spriteId: this.spriteIdFor(active),
                    name: form ? form.name : species.name,
                    level: active.level,
                    shiny: active.shiny === true,
                    legendary: species.isLegendary === true,
                    types: [...species.types],
                    stats: {
                        hp: this.config.calculateRealMaxHp(species.baseStats.hp, active.level),
                        attack: this.config.calculateRealStat(species.baseStats.attack, active.level),
                        defense: this.config.calculateRealStat(species.baseStats.defense, active.level),
                        speed: this.config.calculateRealStat(species.baseStats.speed, active.level),
                    },
                };
            }
        }

        if (privacy.today) {
            const today = this.todayProgress();
            payload.today = {
                // Rounded down to a step so an EXP figure creeping up by tens
                // does not make every tick a new document. This is the single
                // biggest saving in the whole feature.
                exp: Math.floor(today.exp / 100) * 100,
                levels: today.levels,
                caught: today.caught,
            };
            payload.streak = this.currentStreak();
            payload.dayKey = this.today();
        }

        return payload;
    }

    /**
     * Loads the friendship list and keeps it for the session.
     *
     * Cached because it changes only when somebody is added, accepted or
     * removed — all of which go through this file and refresh it. Re-reading it
     * on every panel refresh would double the feature's read cost for a list
     * that is almost always identical.
     */
    async loadFriends({ fresh = false } = {}) {
        if (!fresh && Array.isArray(this.friendCache)) {
            return { ok: true, friendships: this.friendCache, cached: true };
        }
        const res = await this.friendList({ fresh });
        if (res && res.ok) {
            this.friendCache = res.friendships || [];
            this.myUid = res.me || this.myUid;
        }
        return res || { ok: false };
    }

    /** Drops the cached list, so the next read goes to the server. */
    invalidateFriends() { this.friendCache = null; }

    /** Accepted friends, minus anyone blocked. Absence IS the block. */
    friendAudience() {
        return (this.friendCache || [])
            .filter(f => f.accepted && !this.isBlocked(f.uid))
            .map(f => f.uid)
            .slice(0, this.config.FRIEND_MAX);
    }

    /**
     * Writes the feed, unless nothing a friend would see has changed.
     *
     * The feed is a SECOND document, so it is a write the game did not
     * previously make — left uncontrolled it would double the whole faculty's
     * write usage. Two things hold it down, both borrowed from the cloud save:
     * a fingerprint, so an unchanged payload costs nothing at all, and a floor
     * on how often a changed one may go up.
     */
    async publishFriendFeed({ force = false } = {}) {
        if (!Array.isArray(this.friendCache)) return { ok: false, reason: 'no-friends-loaded' };

        const audience = this.friendAudience();
        const payload = this.buildFriendPayload();
        const fingerprint = JSON.stringify({ audience, payload });

        if (!force && fingerprint === this.lastFeedFingerprint) {
            return { ok: true, skipped: 'unchanged' };
        }
        // Ten minutes, measured rather than guessed: a five-minute floor came out
        // at 60 writes per student per day, which put the faculty at 80% of the
        // free tier's writes once the existing save is counted. Ten halves it.
        //
        // Nothing is lost by the wait. The only figure that moves continuously
        // is today's EXP, and it is published rounded to the nearest hundred
        // anyway; going idle needs no write at all now that `activeAt` is a
        // timestamp the reader ages by itself.
        const since = Date.now() - (this.lastFeedPublishAt || 0);
        if (!force && since < FEED_PUBLISH_FLOOR_MS) return { ok: true, skipped: 'too-soon' };

        // Nobody to publish to and nothing on the board: the write would be a
        // document only its author can read.
        if (audience.length === 0 && !this.isOnLeaderboard()) {
            this.lastFeedFingerprint = fingerprint;
            return { ok: true, skipped: 'no-audience' };
        }

        const res = await this.sendToWorker({
            type: 'FRIEND_PUBLISH', payload: { audience, payload },
        });
        if (res && res.ok) {
            this.lastFeedFingerprint = fingerprint;
            this.lastFeedPublishAt = Date.now();
        }
        return res || { ok: false };
    }

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

    /**
     * Whether this account can actually field a given format.
     *
     * A format is a promise about the shape of the match. Letting someone bring
     * two Pokémon to a 3v3 hands them a match their opponent cannot lose fairly
     * — the other side simply outlasts them — so the roster has to be exact
     * rather than "up to".
     *
     * Returns { ok, have, need }: the caller needs the numbers to say what is
     * missing, not just that something is.
     */
    canFieldPvpMode(modeId) {
        const mode = this.config.getPvpMode(modeId);
        const have = this.buildPvpTeam(this.config.MAX_TEAM_SIZE).length;
        return { ok: have >= mode.size, have, need: mode.size, mode };
    }

    // ─────────────────────── Daily progress ledger ───────────────────────
    //
    // What the friends screen shows, and the only new thing the game measures.
    // Deliberately EXP and levels rather than minutes: the ask was to show how
    // much someone has learned, and a number in hours turns a study tool into a
    // competition about sitting still.

    /** Today, on Bangkok time — the same day boundary for every student. */
    today() { return this.config.dayKeyFor(); }

    /**
     * Credits progress to today's ledger, under this device's own bucket.
     *
     * Per-source for the same reason studyMinutes is: two devices in one
     * evening must add up rather than one overwriting the other.
     */
    creditDailyProgress({ exp = 0, levels = 0, caught = 0 } = {}) {
        if (!exp && !levels && !caught) return;
        const day = this.today();
        const source = this.deviceId || 'unknown';

        const days = this.gameState.dailyProgress || (this.gameState.dailyProgress = {});
        const bySource = days[day] || (days[day] = {});
        const row = bySource[source] || (bySource[source] = { exp: 0, levels: 0, caught: 0 });

        row.exp += Math.max(0, Math.round(exp));
        row.levels += Math.max(0, Math.round(levels));
        row.caught += Math.max(0, Math.round(caught));

        // Only when the day count changes, which is at most once a day — the
        // cost of pruning on every EXP tick would be real.
        if (Object.keys(days).length > this.config.DAILY_HISTORY_DAYS) {
            this.gameState.dailyProgress = this.pruneDailyProgress(days);
        }
    }

    /** Keeps only the most recent days, newest first by key order. */
    pruneDailyProgress(days) {
        if (!days || typeof days !== 'object' || Array.isArray(days)) return {};
        const out = {};
        // Keys are YYYY-MM-DD, so lexicographic order IS chronological order.
        const keys = Object.keys(days)
            .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
            .sort()
            .slice(-this.config.DAILY_HISTORY_DAYS);

        for (const key of keys) {
            const sources = days[key];
            if (!sources || typeof sources !== 'object' || Array.isArray(sources)) continue;
            const clean = {};
            for (const [source, row] of Object.entries(sources)) {
                if (!row || typeof row !== 'object') continue;
                const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
                clean[source] = { exp: num(row.exp), levels: num(row.levels), caught: num(row.caught) };
            }
            if (Object.keys(clean).length) out[key] = clean;
        }
        return out;
    }

    /** Max per (day, source) — each source only counts up, so this loses nothing. */
    mergeDailyProgress(mine, theirs) {
        const out = JSON.parse(JSON.stringify(mine || {}));
        if (!theirs || typeof theirs !== 'object' || Array.isArray(theirs)) return out;

        for (const [day, sources] of Object.entries(theirs)) {
            if (!sources || typeof sources !== 'object' || Array.isArray(sources)) continue;
            const target = out[day] || (out[day] = {});
            for (const [source, row] of Object.entries(sources)) {
                if (!row || typeof row !== 'object') continue;
                const a = target[source] || { exp: 0, levels: 0, caught: 0 };
                target[source] = {
                    exp: Math.max(a.exp || 0, Number(row.exp) || 0),
                    levels: Math.max(a.levels || 0, Number(row.levels) || 0),
                    caught: Math.max(a.caught || 0, Number(row.caught) || 0),
                };
            }
        }
        return out;
    }

    /** One row per day with every source summed. What the UI and streak read. */
    dailyTotals(days = this.gameState.dailyProgress) {
        const out = {};
        for (const [day, sources] of Object.entries(days || {})) {
            const row = { exp: 0, levels: 0, caught: 0 };
            for (const s of Object.values(sources || {})) {
                row.exp += Number(s.exp) || 0;
                row.levels += Number(s.levels) || 0;
                row.caught += Number(s.caught) || 0;
            }
            out[day] = row;
        }
        return out;
    }

    /** Today's figures, summed across every device this account studies on. */
    todayProgress() {
        return this.dailyTotals()[this.today()] || { exp: 0, levels: 0, caught: 0 };
    }

    /** Consecutive days of progress ending today. */
    currentStreak() {
        return this.config.streakFrom(this.dailyTotals(), this.today());
    }

    // ─────────────────────────── Mega Evolution ───────────────────────────
    //
    // A stone belongs to one party member, forever. Mega is a persistent toggle
    // on that member rather than a per-battle activation: once switched on it
    // stays on until the trainer switches it off, which is what the request
    // asked for and what keeps it feeling like a permanent upgrade rather than
    // a consumable.

    /**
     * The form a member is currently transformed into, or null.
     *
     * The single gate everything reads — sprite, display name, badges, damage.
     * Three conditions, all required: a form is selected, its stone is actually
     * owned, and the member's CURRENT species is the one that has that form.
     * The last is what makes a dormant stone dormant: a Charmander holding
     * Charizardite X owns it, keeps it through evolution, and starts using it
     * the moment it becomes a Charizard, with no separate bookkeeping.
     */
    activeMegaForm(member) {
        if (!member || !member.megaActive) return null;
        if (!this.ownedStoneKeys(member).has(member.megaActive)) return null;
        return this.config.megaFormsFor(member.speciesId)
            .find(f => f.key === member.megaActive) || null;
    }

    /** Every form this member could switch to right now, in roster order. */
    availableMegaForms(member) {
        if (!member) return [];
        const owned = this.ownedStoneKeys(member);
        return this.config.megaFormsFor(member.speciesId).filter(f => owned.has(f.key));
    }

    /** Stones owned but not yet usable, because the member has not evolved far enough. */
    dormantMegaStones(member) {
        if (!member) return [];
        const usable = new Set(this.config.megaFormsFor(member.speciesId).map(f => f.key));
        const source = this.config.megaSourceFor(member.speciesId);
        const forms = source === null ? [] : this.config.megaFormsFor(source);
        return [...this.ownedStoneKeys(member)]
            .filter(k => !usable.has(k))
            .map(k => forms.find(f => f.key === k) || { key: k, stone: k, name: k });
    }

    /** The sprite id to draw for a member — the mega form's, or its own species'. */
    spriteIdFor(member) {
        const form = this.activeMegaForm(member);
        return form ? form.spriteId : (member ? member.speciesId : null);
    }

    /**
     * Cycles a member through its owned forms and then back to normal.
     *
     * A cycle rather than a switch because nine species have more than one form
     * and Tatsugiri has three: off -> first -> second -> ... -> off. Passing an
     * explicit key jumps straight to it instead, which is what the admin tool
     * and the first-time grant use.
     */
    async toggleMega(instanceId, formKey) {
        const member = this.gameState.party.find(p => p.instanceId === instanceId);
        if (!member) return { ok: false, reason: 'unknown' };

        const forms = this.availableMegaForms(member);
        if (forms.length === 0) {
            // Owning a stone the current form cannot use is a real state, and
            // it needs its own answer — "you have no stone" would be a lie.
            return { ok: false, reason: this.dormantMegaStones(member).length ? 'dormant' : 'no-stone' };
        }

        let next;
        if (formKey === null || formKey === undefined) {
            const i = forms.findIndex(f => f.key === member.megaActive);
            next = i < 0 ? forms[0].key : (i + 1 < forms.length ? forms[i + 1].key : null);
        } else {
            if (!forms.some(f => f.key === formKey)) return { ok: false, reason: 'not-owned' };
            next = member.megaActive === formKey ? null : formKey;
        }

        member.megaActive = next;
        member.megaActiveAt = Date.now();
        const form = this.activeMegaForm(member);

        // Switching a form on for the first time is a first transformation and
        // earns the scene, wherever the stone came from. Without this, a stone
        // that arrived while its holder could not use it -- a trade, a bench
        // member's evolution, a cloud sync -- would never be shown at all.
        // Every later flick of the toggle is silent.
        const scene = form && this.claimMegaScene(member, form.key) ? form : null;

        this.emitState();
        await this.saveGameState();
        return { ok: true, form, scene };
    }

    /** Grants a stone to one member. Idempotent — owning it twice is owning it once. */
    async grantMegaStone(instanceId, formKey) {
        const member = this.gameState.party.find(p => p.instanceId === instanceId);
        if (!member) return { ok: false, reason: 'unknown' };
        if (this.ownedStoneKeys(member).has(formKey)) return { ok: false, reason: 'owned' };

        member.megaStones = [...new Set([...(member.megaStones || []), formKey])].sort();
        this.emitState();
        await this.saveGameState({ immediate: true });
        return { ok: true };
    }

    /** Damage multiplier for one member: 1.30 while megaed, 1 otherwise. */
    megaMultiplierFor(member) {
        return this.activeMegaForm(member) ? this.config.MEGA_DAMAGE_MULTIPLIER : 1;
    }

    /**
     * The multiplier applied to wild-battle damage.
     *
     * Keys off the ACTIVE PARTNER only — that is the Pokémon actually fighting.
     * Team members share EXP, not the battle.
     */
    activeMegaMultiplier() {
        return this.megaMultiplierFor(this.getActivePokemon());
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
     * Claims the right to play one Pokemon's transformation scene, once.
     *
     * The scene is an 8.5-second takeover. It earns that length by being the
     * moment a Pokemon becomes something else -- which happens once per form,
     * not once per time the toggle is flicked. Every path that could play it
     * asks here first, and the answer is persisted on the member and synced, so
     * a scene watched on one device does not replay on another.
     *
     * Keyed by form, not by member: Mega Charizard Y is a creature the player
     * has genuinely never seen, even on a Charizard that has been wearing X for
     * a week.
     */
    claimMegaScene(member, formKey) {
        if (!member || typeof formKey !== 'string') return false;
        const seen = member.megaSeen || [];
        if (seen.includes(formKey)) return false;
        member.megaSeen = [...new Set([...seen, formKey])].sort();
        return true;
    }

    /**
     * Writes one stone onto one party member and reports whether it is dormant.
     *
     * The PVP draw and the admin tool both come through here, so "held stones
     * stay sorted and unique" and "switch it on the moment it can be used" are
     * decided once. Sorted matters beyond tidiness: mergeCloudState decides
     * whether anything changed by comparing serialised state, and an unstable
     * order would force a Firestore write on every merge.
     *
     * Switching on immediately is deliberate — winning the stone is what plays
     * the transformation scene, and a scene showing a change that had not
     * happened yet would be a lie. It stays a toggle: the party page turns the
     * ordinary form back on.
     */
    applyMegaStone(member, form) {
        member.megaStones = [...new Set([...(member.megaStones || []), form.key])].sort();
        const usable = this.config.megaFormsFor(member.speciesId).some(f => f.key === form.key);
        let scene = null;
        if (usable && !member.megaActive) {
            member.megaActive = form.key;
            member.megaActiveAt = Date.now();
            if (this.claimMegaScene(member, form.key)) scene = form;
        }
        return { dormant: !usable, scene };
    }

    /**
     * Admin: hands the active partner the next Mega Stone in its line.
     *
     * This replaced a summon-a-mega checkbox, which only ever produced a wild
     * opponent wearing the form — something to look at, not something to test.
     * A stone is the part worth having on a test account: it persists, it
     * toggles, it travels in a trade, and it is granted through the same
     * applyMegaStone the 10% PVP draw uses, so the tool exercises the real path.
     *
     * Repeated use walks the forms: an X first, then the Y, then nothing left.
     * A partner that is not yet fully evolved still receives the stone its line
     * ends in, which is exactly how a dormant stone is meant to be reproduced.
     */
    async adminGrantMegaStone() {
        const member = this.getActivePokemon();
        if (!member) return { ok: false, reason: 'nobody' };

        const source = this.config.megaSourceFor(member.speciesId);
        if (source === null) return { ok: false, reason: 'no-mega' };

        const held = this.ownedStoneKeys(member);
        const form = this.config.megaFormsFor(source).find(f => !held.has(f.key));
        if (!form) return { ok: false, reason: 'maxed' };

        const { dormant, scene } = this.applyMegaStone(member, form);
        this.emitState();
        await this.saveGameState({ immediate: true });

        const species = this.config.getSpeciesById(member.speciesId);
        return { ok: true, form, dormant, scene: scene !== null,
                 holder: species ? species.name : '' };
    }

    /**
     * Switches on a stone that has just become usable, and reports it.
     *
     * Called after an evolution: a Charmander that has been carrying
     * Charizardite X since before it could use it should transform on arrival,
     * not sit there needing to be told. Returns the form so the caller can play
     * the scene, or null when there was nothing waiting.
     */
    wakeDormantMega(member) {
        if (!member || member.megaActive) return null;
        const owned = this.ownedStoneKeys(member);
        const form = this.config.megaFormsFor(member.speciesId).find(f => owned.has(f.key));
        if (!form) return null;
        member.megaActive = form.key;
        member.megaActiveAt = Date.now();
        return form;
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
     * Grants a win reward: a mega stone 10% of the time, otherwise one of the
     * three boosts.
     *
     * A boost refuses while one is already running, and that refusal is the
     * feature: it caps what battling can be worth per hour, so the way to
     * benefit from a reward is to spend the hour watching lectures rather than
     * queueing for another match. A stone is a permanent item rather than a
     * timer, so it is drawn before that gate and ignores it.
     */
    async grantPvpReward(durationMs = this.config.REWARD_DURATION_MS) {
        // The lockout is checked FIRST, ahead of the running-boost check it used
        // to follow. A defeat has to block everything including stones, and the
        // stone branch below runs before the boost branch. The visible effect is
        // that someone both locked out and mid-boost is now told 'locked' rather
        // than 'active'; both are refusals, only the wording changes.
        const lockMsLeft = this.getRewardLock();
        if (lockMsLeft > 0) return { granted: false, reason: 'locked', msLeft: lockMsLeft };

        // ── Stones, 10% ──
        //
        // Deliberately ahead of the no-stacking gate. A boost is a timer and
        // only one may run; a stone is a permanent item and stacks with
        // everything. Were this below the gate, every win during an active boost
        // would silently forfeit its stone chance too.
        if (this.config.rollMegaStone()) {
            const pick = this.chooseStoneRecipient();
            if (pick) {
                const member = this.gameState.party.find(p => p.instanceId === pick.instanceId);
                const species = this.config.getSpeciesById(member.speciesId);
                const { dormant, scene } = this.applyMegaStone(member, pick.form);
                this.emitState();
                await this.saveGameState({ immediate: true });
                return {
                    granted: true, kind: 'stone',
                    stone: pick.form,
                    instanceId: pick.instanceId,
                    holder: species ? species.name : '',
                    // Dormant means the stone is owned but the holder has not
                    // evolved far enough to use it yet.
                    dormant,
                    // Whether this win earned the transformation scene. Not the
                    // same as !dormant: a Charizard already wearing X wins Y
                    // without transforming into it.
                    scene: scene !== null,
                };
            }
            // Nobody could take one — fall through to an even 1-of-3 boost.
        }

        const running = this.getActiveReward();
        if (running) return { granted: false, reason: 'active', reward: running };

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
        return { granted: true, kind: 'boost', reward: this.getActiveReward() };
    }

    /**
     * Which Pokémon on the PVP line-up should receive a stone, or null.
     *
     * The pool is the whole saved line-up rather than only the members a given
     * format actually fielded, so a 1v1 is no worse a way to collect stones
     * than a 6v6 — which already pays four times the boost.
     *
     * Two tiers. A member whose CURRENT species has the mega can use the stone
     * the moment it lands, and those are preferred. A member whose stone belongs
     * to a form further down its line still qualifies, but only when nobody in
     * the first tier does — that is the "give it anyway, dormant until it
     * evolves" rule.
     *
     * Candidacy reads megaStones and never megaActive. Reading the toggle would
     * make "switch mega off, win, win the same stone again" an endless loop that
     * also starves every other member of the line-up.
     */
    chooseStoneRecipient() {
        const preferred = [];
        const fallback = [];

        for (const instanceId of this.getPvpTeam()) {
            const member = this.gameState.party.find(p => p.instanceId === instanceId);
            if (!member) continue;

            const source = this.config.megaSourceFor(member.speciesId);
            if (source === null) continue;                    // no mega anywhere in this line

            const owned = this.ownedStoneKeys(member);
            const missing = this.config.megaFormsFor(source).filter(f => !owned.has(f.key));
            if (missing.length === 0) continue;               // already owns every form

            // Taking the first missing form is what satisfies the second-stone
            // rule for free: a Charizard already holding X has only Y left.
            const entry = { instanceId, form: missing[0] };
            (source === member.speciesId ? preferred : fallback).push(entry);
        }

        const tier = preferred.length ? preferred : fallback;
        if (tier.length === 0) return null;                   // caller re-rolls into a boost
        return tier[Math.floor(Math.random() * tier.length)];
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

    // ─────────────────────── Shop: the wallet ───────────────────────

    /**
     * This device's counters, created on first use.
     *
     * Bucketed by the SAME device id study time is, and deliberately so: the
     * reason is identical, which is that two devices earning in one evening
     * have to add up rather than compete. See shopWallet in createEmptyState.
     */
    walletBucket() {
        if (!this.gameState.shopWallet) this.gameState.shopWallet = {};
        const key = this.studySource();
        if (!this.gameState.shopWallet[key]) {
            this.gameState.shopWallet[key] = { earned: 0, spent: 0 };
        }
        return this.gameState.shopWallet[key];
    }

    /** Lifetime earned minus lifetime spent, across every device. */
    getMoney() {
        let earned = 0;
        let spent = 0;
        for (const b of Object.values(this.gameState.shopWallet || {})) {
            earned += Number(b && b.earned) || 0;
            spent += Number(b && b.spent) || 0;
        }
        // Clamped because two devices offline at once can each spend the same
        // balance. Rare, self-correcting, and a negative number on the widget
        // would be a worse answer than zero.
        return Math.max(0, earned - spent);
    }

    /**
     * Credits money for an encounter.
     *
     * Note what is NOT here: no reward multiplier, no shop multiplier, no
     * scaling by level. Money measures time, not power — see the Shop section
     * of flickemon-config.js for why that is load-bearing rather than lazy.
     */
    addMoney(amount) {
        const n = Math.max(0, Math.floor(Number(amount) || 0));
        if (!n) return 0;
        this.walletBucket().earned += n;
        return n;
    }

    /** Deducts a price, or refuses. The single gate every purchase goes through. */
    spendMoney(amount) {
        const n = Math.max(0, Math.floor(Number(amount) || 0));
        if (this.getMoney() < n) return false;
        this.walletBucket().spent += n;
        return true;
    }

    // ─────────────────── Shop: permanent boosts ───────────────────

    shopBoostTier(kind) {
        return Math.min(this.config.SHOP_MAX_BOOST_TIER,
                        Math.max(0, Math.floor(Number((this.gameState.shopBoosts || {})[kind]) || 0)));
    }

    /**
     * The permanent multipliers.
     *
     * Kept separate from the reward ones above rather than folded into them,
     * because the two are multiplied together at the point of use and a single
     * combined function would hide which half a number came from.
     */
    shopExpMultiplier() {
        return this.config.shopBoostMultiplier(this.config.REWARDS.EXP,
                                               this.shopBoostTier(this.config.REWARDS.EXP));
    }

    shopShinyMultiplier() {
        return this.config.shopBoostMultiplier(this.config.REWARDS.SHINY,
                                               this.shopBoostTier(this.config.REWARDS.SHINY));
    }

    shopLegendaryMultiplier() {
        return this.config.shopBoostMultiplier(this.config.REWARDS.LEGENDARY,
                                               this.shopBoostTier(this.config.REWARDS.LEGENDARY));
    }

    /** Buys the next tier of a permanent boost. */
    async buyBoost(kind) {
        if (!Object.values(this.config.REWARDS).includes(kind)) {
            return { ok: false, reason: 'unknown' };
        }
        const current = this.shopBoostTier(kind);
        const next = this.config.nextBoostTier(current);
        if (!next) return { ok: false, reason: 'maxed' };
        if (!this.spendMoney(next.price)) return { ok: false, reason: 'poor', price: next.price };

        if (!this.gameState.shopBoosts) this.gameState.shopBoosts = {};
        this.gameState.shopBoosts[kind] = next.tier;
        this.emitState();
        // Deliberately NOT an immediate cloud push. The local write happens
        // straight away and pagehide flushes on the way out, so nothing is at
        // risk — but somebody buying four eggs in a row should cost one
        // Firestore write, not four. See the budget at the top of this file.
        await this.saveGameState();
        return { ok: true, tier: next.tier, spent: next.price };
    }

    // ─────────────────── Shop: mega stones ───────────────────

    /**
     * Every stone key this member can draw on: its own, plus the account's.
     *
     * A stone won in PVP lands on one individual; a stone bought in the mart
     * belongs to the species, so a Charizard caught tomorrow can use one bought
     * today. Account stones are filtered to this member's OWN line first, or
     * every Pokémon in the party would report 96 dormant stones it can never use.
     */
    ownedStoneKeys(member) {
        const owned = new Set((member && member.megaStones) || []);
        if (!member) return owned;
        const source = this.config.megaSourceFor(member.speciesId);
        if (source === null) return owned;
        const lineKeys = new Set(this.config.megaFormsFor(source).map(f => f.key));
        for (const key of this.gameState.megaSpecies || []) {
            if (lineKeys.has(key)) owned.add(key);
        }
        return owned;
    }

    /** Buys a stone for a species. Every Pokémon of that line gains the form. */
    async buyMegaStone(formKey) {
        const form = this.config.allMegaForms().find(f => f.key === formKey);
        if (!form) return { ok: false, reason: 'unknown' };
        if ((this.gameState.megaSpecies || []).includes(formKey)) {
            return { ok: false, reason: 'owned' };
        }
        const item = this.config.shopItemById('mega-stone');
        if (!this.spendMoney(item.price)) return { ok: false, reason: 'poor', price: item.price };

        this.gameState.megaSpecies = [...new Set([
            ...(this.gameState.megaSpecies || []), formKey])].sort();

        // Anything in the party that can already use it transforms on the spot,
        // the same way a stone won in PVP does.
        for (const member of this.gameState.party) {
            if (this.config.megaFormsFor(member.speciesId).some(f => f.key === formKey)) {
                this.wakeDormantMega(member);
            }
        }

        this.emitState();
        await this.saveGameState();
        return { ok: true, form, spent: item.price };
    }

    // ─────────────────── Shop: eggs ───────────────────

    getEggs() {
        return (this.gameState.eggs || []).filter(e => !e.hatched);
    }

    getIncubatingEgg() {
        return this.getEggs().find(e => e.eggId === this.gameState.incubatingId) || null;
    }

    /**
     * Buys an egg, rolling its contents NOW.
     *
     * Deciding at purchase rather than at hatch is what makes the egg safe to
     * sync: two devices that both reach zero on the same egg produce the same
     * species, and because the hatched Pokémon takes a deterministic instanceId
     * derived from the eggId, the ordinary party merge collapses the two into
     * one instead of handing the student a free duplicate.
     */
    async buyEgg(itemId) {
        const item = this.config.shopItemById(itemId);
        if (!item || item.kind !== this.config.SHOP_ITEM_KINDS.EGG) {
            return { ok: false, reason: 'unknown' };
        }
        const contents = this.config.rollEggContents(itemId);
        if (!contents) return { ok: false, reason: 'unknown' };
        if (!this.spendMoney(item.price)) return { ok: false, reason: 'poor', price: item.price };

        const egg = {
            eggId: this.generateId(),
            itemId,
            speciesId: contents.speciesId,
            shiny: contents.shiny,
            encountersLeft: item.hatchEncounters,
            hatched: false,
        };
        this.gameState.eggs.push(egg);
        // Straight into the incubator when it is free, so the common case is
        // one press rather than two.
        if (!this.getIncubatingEgg()) this.gameState.incubatingId = egg.eggId;

        this.emitState();
        await this.saveGameState();
        return { ok: true, egg, spent: item.price };
    }

    /** Swaps which egg is being carried. */
    async setIncubating(eggId) {
        const egg = this.getEggs().find(e => e.eggId === eggId);
        if (!egg) return { ok: false, reason: 'unknown' };
        this.gameState.incubatingId = eggId;
        this.emitState();
        await this.saveGameState();
        return { ok: true };
    }

    /**
     * One encounter's worth of incubation, hatching if that was the last one.
     *
     * Called once per RESOLVED encounter — a win or an escape, never per tick —
     * so an egg's cost is quoted in the same unit the shop prices are.
     * Returns what hatched, for the caller to play a scene for.
     */
    hatchTick() {
        const egg = this.getIncubatingEgg();
        if (!egg) return null;
        egg.encountersLeft = Math.max(0, egg.encountersLeft - 1);
        if (egg.encountersLeft > 0) return null;
        return this.hatchEgg(egg);
    }

    hatchEgg(egg) {
        if (!egg || egg.hatched) return null;
        egg.hatched = true;
        if (this.gameState.incubatingId === egg.eggId) this.gameState.incubatingId = null;

        const species = this.config.getSpeciesById(egg.speciesId);
        if (!species) return null;

        // Derived from the eggId, NOT generateId(): a second device hatching the
        // same egg must land on the same instanceId so the party merge sees one
        // Pokémon rather than two.
        const instanceId = 'egg_' + egg.eggId;
        if (!this.gameState.party.some(p => p.instanceId === instanceId)) {
            this.gameState.party.push({
                instanceId,
                speciesId: egg.speciesId,
                // Hatches at 5 like a starter does. An egg is a Pokémon you are
                // given, not one you have trained.
                level: 5,
                totalExp: this.config.expForLevel(5),
                shiny: egg.shiny === true,
                megaStones: [],
                megaSeen: [],
                megaActive: null,
                megaActiveAt: 0,
            });
        }
        this.updatePokedex(egg.speciesId, true, egg.shiny === true);

        // Pick up the next egg automatically, so a bag of eggs keeps working
        // without the student having to reopen the mart between each one.
        const next = this.getEggs()[0];
        if (next) this.gameState.incubatingId = next.eggId;

        return { egg, species, shiny: egg.shiny === true, instanceId };
    }

    // ─────────────────────────── Trading ───────────────────────────

    /**
     * The stones an incoming traded Pokémon is allowed to keep.
     *
     * Only forms that genuinely belong to the species being received, and only
     * as many as that species has. The sender writes this payload, so it is
     * treated as a claim rather than a fact.
     */
    sanitizeTradedStones(received) {
        if (!received || !Array.isArray(received.megaStones)) return [];
        const source = this.config.megaSourceFor(Number(received.speciesId));
        if (source === null) return [];
        const legal = new Set(this.config.megaFormsFor(source).map(f => f.key));
        return [...new Set(received.megaStones.filter(k => typeof k === 'string' && legal.has(k)))].sort();
    }

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
            // Stones travel with the Pokémon: destroying them would make trading
            // a mega a silent downgrade that neither side can see in the
            // preview, and the receiver should get exactly what was shown.
            //
            // Sanitised on arrival, unlike a local load — this payload is
            // written by the other trainer, so an unfiltered copy makes "give
            // myself every stone" a one-line forgery. Same reasoning as the
            // durationMs clamp in grantPvpReward.
            megaStones: this.sanitizeTradedStones(received),
            // Neither the toggle nor the seen-scene list travels. The receiver
            // opts in, so no inconsistent active/unowned pair can arrive -- and
            // they have never watched this Pokemon transform, so the first time
            // they switch it on is a first time.
            megaSeen: [],
            megaActive: null,
            megaActiveAt: 0,
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
            // A guaranteed catch does not flee. Without this the guarantee is
            // a lie in exactly the case it matters most: rollWildLevel can put
            // a wild up to ~14 levels above the player, so a shiny or a
            // legendary could clear the +4 threshold and walk away at 90
            // seconds no matter what the capture rules said.
            const levelDiff = this.wildOpponent.wildLevel - active.level;
            if (levelDiff >= 4 && this.wildOpponent.fightDurationSeconds >= 90
                && !this.isGuaranteedCatch(this.wildOpponent)) {
                this.wildOpponent.status = 'escaped';
                const partialExp = Math.round(
                    this.wildOpponent.wildLevel * this.config.ESCAPE_EXP_MULTIPLIER
                );
                this.wildOpponent.expGained = partialExp;
                this.addExpToActive(partialExp);
                // An abandoned fight still pays, and still counts as an
                // encounter for whatever is in the incubator.
                const escapeMoney = this.addMoney(this.config.ESCAPE_MONEY);
                this.wildOpponent.moneyGained = escapeMoney;
                const escapeHatch = this.hatchTick();

                this.encounterListeners.forEach(cb => cb({
                    wildSpecies: this.wildOpponent.wildSpecies,
                    wildLevel: this.wildOpponent.wildLevel,
                    won: false,
                    captured: false,
                    expGained: partialExp,
                    moneyGained: escapeMoney,
                    evolved: false,
                }));
                if (escapeHatch) this.emitHatch(escapeHatch);

                if (this.respawnTimer) clearTimeout(this.respawnTimer);
                this.respawnTimer = setTimeout(() => this.spawnWildOpponent(), 3000);
                this.emitWild();
                // Encounter resolved with EXP gained — worth persisting now.
                await this.saveGameState({ immediate: true });
                return;
            }

            // Damage calculation (~150 seconds / 2.5 mins to defeat)
            const TARGET_BATTLE_SECONDS = 150;
            const damagePerSec = (this.wildOpponent.maxHp / TARGET_BATTLE_SECONDS)
                           * this.adminDamageMultiplier
                           * this.activeMegaMultiplier();
            this.wildHpAcc -= secondsWatched * damagePerSec;
            this.wildOpponent.currentHp = Math.max(0, Math.ceil(this.wildHpAcc));

            if (this.wildOpponent.currentHp === 0) {
                // Battle won. Worth pushing to the cloud right away.
                capturedThisTick = true;

                // Winning in capture mode is no longer the same thing as
                // catching. The roll happens once, here, at the moment the
                // battle ends -- not per tick, and not at spawn, so a student
                // cannot learn the outcome early and walk away from a loss.
                const inCaptureMode = this.isCaptureMode();
                // Rolled unconditionally, then overridden, so that a guaranteed
                // catch does not quietly draw a different number of values from
                // Math.random than an ordinary one does.
                const wonRoll = Math.random() < this.config.CAPTURE_CHANCE;
                // Shinies and legendaries ignore both the roll AND the mode.
                // This is the one place EXP mode captures anything, and it is
                // deliberate: the point of EXP mode is giving up the ordinary
                // catches, not the once-a-month ones.
                const guaranteed = this.isGuaranteedCatch(this.wildOpponent);
                const captured = guaranteed || (inCaptureMode && wonRoll);

                this.wildOpponent.status = captured ? 'captured' : 'defeated';
                // Beaten in capture mode but not caught. The status is a defeat
                // either way -- it lost the fight -- but the widget has to say
                // which of the two happened or a 60% miss reads as a bug.
                this.wildOpponent.brokeFree = inCaptureMode && !captured;
                // Worth telling apart from an ordinary catch on the results
                // line, especially in EXP mode where a capture is otherwise
                // impossible and would read as a bug.
                this.wildOpponent.guaranteed = captured && guaranteed;

                const winExp = this.consumeWinExp(this.wildOpponent.wildLevel);
                this.wildOpponent.expGained = winExp;

                // Money is flat and unboosted — see addMoney. A catch pays a
                // little extra, which is what stops capture mode being strictly
                // the poorer choice for giving up half the EXP.
                const winMoney = this.addMoney(this.config.BATTLE_WIN_MONEY
                    + (captured && inCaptureMode ? this.config.CAPTURE_MONEY_BONUS : 0));
                this.wildOpponent.moneyGained = winMoney;

                let joined = false;
                if (captured) {
                    joined = this.addWildToParty(this.wildOpponent);
                    this.updatePokedex(this.wildOpponent.wildSpecies.id, true,
                                       this.wildOpponent.shiny === true);
                    this.creditDailyProgress({ caught: 1 });
                } else {
                    // EXP mode, or a capture that failed its roll: the encounter
                    // still counts as SEEN — the student did meet it — but it is
                    // not added to the party or marked caught.
                    this.updatePokedex(this.wildOpponent.wildSpecies.id, false);
                }

                const evoResult = this.addExpToActive(winExp);
                const hatched = this.hatchTick();

                this.encounterListeners.forEach(cb => cb({
                    wildSpecies: this.wildOpponent.wildSpecies,
                    wildLevel: this.wildOpponent.wildLevel,
                    won: true,
                    captured,
                    // Whether it actually reached the party. instantCapture has
                    // always reported this; the ordinary capture discarded it,
                    // so a capture at the backstop announced itself and then
                    // quietly did not happen.
                    joined,
                    guaranteed: this.wildOpponent.guaranteed === true,
                    brokeFree: this.wildOpponent.brokeFree === true,
                    expGained: winExp,
                    moneyGained: winMoney,
                    expDebtLeft: this.getExpDebt(),
                    evolved: !!evoResult,
                    evolvedInto: evoResult || undefined,
                }));
                if (hatched) this.emitHatch(hatched);

                if (this.respawnTimer) clearTimeout(this.respawnTimer);
                this.respawnTimer = setTimeout(() => this.spawnWildOpponent(), 3000);
            }

            this.emitWild();
        }

        this.gameState.wildOpponent = this.wildOpponent;
        this.creditStudyMinutes(this.studySource(), secondsWatched / 60);
        await this.saveGameState({ immediate: capturedThisTick });
    }

    /**
     * Puts a beaten wild Pokemon into the party.
     *
     * Shared by the ordinary 40% capture and by the instant-capture button, so
     * the party-capacity rule cannot come to mean two different things
     * depending on how the Pokemon was caught.
     *
     * Catching a species you already own gives you a second, separate Pokemon
     * with its own level — both show in the party and either can go on a PVP
     * team. At the capacity backstop a species you have never owned still gets
     * in: losing a Pokedex entry matters, losing a duplicate does not.
     *
     * A shiny or a legendary is the exception to that last clause, and gets in
     * regardless. "Duplicate" is a judgement about the SPECIES, and it is the
     * wrong test for these two: a shiny Pikachu alongside an ordinary one is
     * not a duplicate in any sense the student cares about. Without this the
     * guarantee in isGuaranteedCatch would hold everywhere except the one place
     * it is silent -- the game would say "caught!", mark the Pokedex, and hand
     * back nothing. The backstop sits at 3000, so this is a corner rather than
     * a common case, but a guarantee with a corner in it is not a guarantee.
     */
    addWildToParty(wild) {
        const atCapacity = this.gameState.party.length >= this.config.MAX_PARTY_SIZE;
        const isNewSpecies = !this.gameState.party
            .some(p => p.speciesId === wild.wildSpecies.id);
        if (atCapacity && !isNewSpecies && !this.isGuaranteedCatch(wild)) return false;

        this.gameState.party.push({
            instanceId: this.generateId(),
            speciesId: wild.wildSpecies.id,
            level: wild.wildLevel,
            totalExp: this.config.expForLevel(wild.wildLevel),
            shiny: wild.shiny === true,
            // An admin-summoned mega arrives holding its stone, already
            // transformed. Anything else would make the tool produce a mega you
            // cannot keep.
            megaStones: wild.megaForm ? [wild.megaForm] : [],
            megaSeen: [],
            megaActive: wild.megaForm || null,
            megaActiveAt: wild.megaForm ? Date.now() : 0,
        });
        return true;
    }

    /**
     * Whether meeting this Pokemon means keeping it, whatever the mode.
     *
     * A legendary is a 1% draw gated behind Lv.40; a shiny is 1 in 512.
     * Both are the moment a student looks up from their notes
     * and tells someone, and neither should then be taken away by a 40% roll --
     * or by EXP mode, where the trade is meant to be "no ordinary captures for
     * double EXP", not "your one shiny this month is a statistic".
     */
    isGuaranteedCatch(wild) {
        if (!wild || !wild.wildSpecies) return false;
        return wild.wildSpecies.isLegendary === true || wild.shiny === true;
    }

    /** Wins still owed to an instant capture, or 0. */
    getExpDebt() {
        const n = this.gameState.expDebt;
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }

    /**
     * The EXP for one win, and the bookkeeping that goes with it.
     *
     * A win under an instant-capture debt is worth nothing and pays off one of
     * the ten. The debt is spent by WINNING, not by capturing: a Pokemon that
     * broke free was still beaten, so it counts. Escapes do not — nothing was
     * defeated — which also stops "let the high-level ones flee" being a way to
     * wait out the debt for free.
     */
    consumeWinExp(wildLevel) {
        const debt = this.getExpDebt();
        if (debt > 0) {
            this.gameState.expDebt = debt - 1;
            return 0;
        }
        return Math.round(wildLevel * this.getWinExpBonus());
    }

    /**
     * Catches the wild Pokemon on the spot, and books the cost.
     *
     * The button exists because a 40% roll on a shiny or a legendary that took
     * two and a half minutes to beat is a genuinely bad moment. This turns that
     * into a decision the student makes deliberately and pays for, rather than
     * one the dice make for them.
     *
     * No EXP for the capture itself — nothing was defeated — and the next
     * INSTANT_CAPTURE_EXP_DEBT wins award none either. Capturing still works
     * normally throughout: the debt costs levels, never Pokemon.
     */
    async instantCapture() {
        const wild = this.wildOpponent;
        if (!wild || wild.status !== 'fighting') return { ok: false, reason: 'no-battle' };
        if (!this.isCaptureMode()) return { ok: false, reason: 'mode' };

        wild.status = 'captured';
        wild.brokeFree = false;
        wild.instant = true;
        wild.currentHp = 0;
        wild.expGained = 0;
        this.wildHpAcc = 0;

        const joined = this.addWildToParty(wild);
        this.updatePokedex(wild.wildSpecies.id, true, wild.shiny === true);
        this.gameState.expDebt = this.getExpDebt() + this.config.INSTANT_CAPTURE_EXP_DEBT;

        this.encounterListeners.forEach(cb => cb({
            wildSpecies: wild.wildSpecies,
            wildLevel: wild.wildLevel,
            won: true,
            captured: true,
            instant: true,
            joined,
            expGained: 0,
            expDebtLeft: this.getExpDebt(),
            evolved: false,
        }));

        if (this.respawnTimer) clearTimeout(this.respawnTimer);
        this.respawnTimer = setTimeout(() => this.spawnWildOpponent(), 3000);

        this.gameState.wildOpponent = wild;
        this.emitWild();
        this.emitState();
        await this.saveGameState({ immediate: true });
        return { ok: true, joined, debt: this.getExpDebt() };
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
            // Clamped, or x10 from PVP times x5 from the mart would turn 1/512
            // into roughly 1/10 and a shiny would stop being an event.
            shiny: Math.random() < Math.min(
                this.config.MAX_SHINY_CHANCE,
                this.config.SHINY_CHANCE * this.rewardShinyMultiplier() * this.shopShinyMultiplier()
            ),
        };

        this.gameState.wildOpponent = this.wildOpponent;
        this.updatePokedex(wildSpecies.id, false);
        this.emitWild();
        this.saveGameState();
    }

    rollWildPokemon() {
        const active = this.getActivePokemon();
        const activeLevel = active ? active.level : 5;

        // Legendary check (Lv40+, 1% base, multiplied by the radar and by any
        // permanent boost). The 0.5 ceiling is what keeps x50 from turning the
        // wild into nothing but legendaries.
        const legendaryChance = Math.min(0.5,
            0.01 * this.rewardLegendaryMultiplier() * this.shopLegendaryMultiplier());
        if (activeLevel >= 40 && Math.random() <= legendaryChance) {
            const legendaries = this.config.POKEMON_REGISTRY.filter(s => s.isLegendary);
            if (legendaries.length > 0) {
                return legendaries[Math.floor(Math.random() * legendaries.length)];
            }
        }

        // Custom Pokemon that asked to be met. Checked before the stage table
        // rather than folded into it, so the 50/40/10 split stays exactly what
        // it says it is -- and so a roster with nothing marked `wild: true`
        // leaves the encounter code behaving identically to before.
        const wildCustoms = this.config.customRoster().filter(s => s.wild);
        if (wildCustoms.length > 0 && Math.random() < this.config.CUSTOM_ENCOUNTER_CHANCE) {
            return wildCustoms[Math.floor(Math.random() * wildCustoms.length)];
        }

        const nonLegendaries = this.config.POKEMON_REGISTRY.filter(s => !s.isLegendary);

        // The table comes from how far the PARTNER has come. A first-form
        // partner meets first forms only; a fully evolved one draws the whole
        // ladder. See ENCOUNTER_STAGE_WEIGHTS.
        const weights = this.config.encounterWeightsFor(active ? active.speciesId : 1);
        const roll = Math.random();
        let cumulative = 0;
        let selectedStage = weights[0].stage;

        for (const entry of weights) {
            cumulative += entry.weight;
            if (roll <= cumulative) {
                selectedStage = entry.stage;
                break;
            }
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
        // consolation, and by extension the team's share — so both boosts are
        // applied once, at the source.
        //
        // The two MULTIPLY rather than one overriding the other: a maxed
        // permanent boost during a PVP Double EXP is x4. That is deliberate and
        // is the reason to keep battling after buying one.
        const exp = Math.round(rawExp * this.rewardExpMultiplier() * this.shopExpMultiplier());

        active.totalExp += exp;
        const newLevel = Math.min(this.config.MAX_LEVEL, this.config.levelFromExp(active.totalExp));
        // Credited here rather than at either call site, because this method's
        // own comment is right: every EXP gain in the game funnels through it.
        // One hook, and nothing new to remember when a future source is added.
        this.creditDailyProgress({ exp, levels: Math.max(0, newLevel - active.level) });
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
                // A stone carried since before this form could use it wakes up
                // here. It rides the same listener, so the queue plays the mega
                // scene directly after the evolution scene rather than at once.
                const woke = this.wakeDormantMega(active);
                if (woke && this.claimMegaScene(active, woke.key)) {
                    this.evolutionListeners.forEach(cb => cb({
                        kind: 'mega', form: woke, species: toSpecies,
                        shiny: active.shiny === true,
                    }));
                }
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
            const before = member.level;
            member.level = Math.min(
                this.config.MAX_LEVEL,
                this.config.levelFromExp(member.totalExp)
            );
            // Levels only. The EXP was already credited whole in addExpToActive
            // before it was shared out, and counting the share again would
            // inflate the day by the size of the team.
            if (member.level > before) {
                this.creditDailyProgress({ levels: member.level - before });
            }

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
                    // A dormant stone on the bench wakes here too. This used to
                    // be the partner's privilege only, which meant a Charmander
                    // that evolved while training on the team reached Charizard
                    // still switched off, and its one transformation scene was
                    // never played at all.
                    const woke = this.wakeDormantMega(member);
                    if (woke && this.claimMegaScene(member, woke.key)) {
                        this.evolutionListeners.forEach(cb => cb({
                            kind: 'mega', form: woke, species: to,
                            shiny: member.shiny === true, benched: true,
                        }));
                    }
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

        // "Studying now" for the friends screen. Deliberately in memory only
        // and never saved: it says what is happening on THIS device at this
        // moment, and a figure restored from a save would claim a student was
        // studying because they once were.
        this.lastStudyTickAt = Date.now();
    }

    updatePokedex(speciesId, caught, shiny = false) {
        // The Pokedex is the 1,025 real ones and stays that way. A custom
        // Pokemon is caught, kept, levelled and battled like any other, but it
        // is not a dex entry: the grid iterates POKEMON_REGISTRY so it would
        // never render, and getCaughtCount would quietly inflate "N / 1,025"
        // with something no other trainer could ever match. One guard here
        // keeps every downstream count honest.
        if (this.config.isCustomSpeciesId(speciesId)) return;

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
