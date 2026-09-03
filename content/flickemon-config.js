/**
 * Flickemon Game Data Configuration (Chrome Extension)
 * ─────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for all game data.
 * Direct port of flickemon.config.ts → vanilla JS.
 */

// ─────────────────────────── Sprite Configuration ───────────────────────────

// Sprites ship inside the extension rather than being fetched per render.
// Opening the Pokédex asks for up to 1,025 images at once, and
// raw.githubusercontent.com is a source host, not a CDN — if it ever throttles
// or the student is behind a firewall that blocks it, every sprite in the game
// goes blank together. Bundled, the extension makes no third-party request at
// all, which is also one less thing for the university to have an opinion on.
//
// The remote URL stays as the fallback for the two contexts that run this file
// without an extension around it: the test harness, and the standalone review
// page.
const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

/**
 * Path to a bundled file, or null when there is no extension runtime to ask.
 *
 * getURL throws once the extension context is invalidated — which happens to
 * every open tab the moment the extension updates — so a failure here means
 * "fall back to the network", not "render a broken image".
 */
function bundledUrl(path) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
        return null;
    }
    try {
        return chrome.runtime.getURL(path);
    } catch {
        return null;
    }
}

/** Extension-relative URL for a bundled asset, or the plain path off-extension. */
function getAssetUrl(path) {
    return bundledUrl(path) || path;
}

function getSpriteUrl(pokemonId, shiny = false) {
    const custom = getCustomSpecies(pokemonId);
    if (custom) {
        // A shiny variant is optional: without one, a shiny custom just wears
        // its ordinary art rather than showing a broken image.
        const file = (shiny && custom.shinySprite) || custom.sprite;
        return bundledUrl(`sprites/custom/${file}`) || `sprites/custom/${file}`;
    }
    const rel = shiny ? `sprites/shiny/${pokemonId}.png` : `sprites/${pokemonId}.png`;
    const remote = shiny ? `${SPRITE_BASE_URL}/shiny/${pokemonId}.png`
                         : `${SPRITE_BASE_URL}/${pokemonId}.png`;
    return bundledUrl(rel) || remote;
}

function getBackSpriteUrl(pokemonId, shiny = false) {
    const custom = getCustomSpecies(pokemonId);
    if (custom) {
        // No back sprite is the normal case for hand-drawn art, so fall through
        // to the front view rather than asking the author for two pictures.
        const file = custom.backSprite || (shiny && custom.shinySprite) || custom.sprite;
        return bundledUrl(`sprites/custom/${file}`) || `sprites/custom/${file}`;
    }
    const rel = shiny ? `sprites/back/shiny/${pokemonId}.png` : `sprites/back/${pokemonId}.png`;
    const remote = shiny ? `${SPRITE_BASE_URL}/back/shiny/${pokemonId}.png`
                         : `${SPRITE_BASE_URL}/back/${pokemonId}.png`;
    return bundledUrl(rel) || remote;
}

// ─────────────────────────── Shiny encounters ───────────────────────────
//
// Purely cosmetic, as in the games: a shiny has identical stats and is worth
// no extra EXP. What it is worth is that it's rare and it's yours.
//
// The games use 1/4096 (1/8192 before Gen 6). At roughly one encounter per
// 2.5 minutes of lecture that would be one shiny per ~170 hours of watching —
// past the point where any student would ever see one, which makes the whole
// feature invisible. 1/512 puts one at around 21 hours, so it lands in the
// same range as a full three-stage evolution (~19h) and stays a genuine event.
// Change this one number for a stricter rate.
const SHINY_CHANCE = 1 / 512;

// The ceiling once every multiplier has been applied.
//
// Shiny rate is multiplied by a PVP Shiny Charm (x10) and again by a permanent
// Shiny boost from the shop (up to x5). Unclamped that is x50, which turns
// 1/512 into roughly 1/10 — at 24 encounters an hour, two or three shinies
// every hour. A shiny that common is not an event any more, and the whole
// reason SHINY_CHANCE is 1/512 rather than the games' 1/4096 was to make it a
// rare thing a student actually sees, not a common one.
//
// 1/32 is about one every 80 minutes with everything running, which stays
// remarkable while still being a visible payoff for two expensive boosts.
// The legendary roll has always had the equivalent cap, hardcoded as 0.5 in
// rollWildPokemon; this is the same idea, written down.
const MAX_SHINY_CHANCE = 1 / 32;

// ─────────────────────── PVP victory rewards ───────────────────────
//
// Winning a PVP battle grants one of three boosts, drawn at random. How long
// the boost runs is set by the battle format — see PVP_MODES below.
//
// They deliberately do NOT stack, and a second win while one is running earns
// nothing. That rule is the whole design: a student who can bank rewards by
// battling back-to-back has been handed a reason to stop watching lectures,
// which is the opposite of what this extension is for. Because the boost only
// pays out while studying, the fastest way to use a reward is to go back to
// the video — and the only way to earn the next one is to let this one run out.
//
// No-stacking is also what keeps the longer formats honest. A 6v6 pays four
// times what a 1v1 pays, but it cannot be farmed four times as fast: whichever
// format you win, the next reward is gated behind the one you are holding.
// Picking 6v6 is therefore a bet that you can win the longer match, not a way
// to earn more per hour of battling.
const REWARD_DURATION_MS = 60 * 60 * 1000;   // fallback only; modes set the real one

// Losing locks you out of rewards for half an hour.
//
// Without it the no-stacking rule has a hole: two students who both want a
// boost can take turns throwing matches, and each collects on their scheduled
// win. Rewards exist to send someone back to a lecture, so they have to cost
// something to lose. Half an hour is long enough that trading wins is slower
// than simply studying, and short enough that a genuine loss is not a
// punishment you feel for the rest of the session.
//
// This is stored on the loser's own save, like every other rule here. A student
// running the extension unpacked could clear it — the same is true of the party
// and the Pokédex, and none of it is worth a server to defend.
const PVP_LOSS_LOCKOUT_MS = 30 * 60 * 1000;

// ─────────────────────── Balance reference ───────────────────────
//
// What the tuning above actually costs a student, in hours of watching. These
// are MEASURED by simulating the real engine, not derived: a closed form gets
// it roughly 20% wrong because it cannot account for encounters that escape,
// which burn 90 seconds for half the EXP.
//
// The in-game guide quotes these, so they must not drift. tests/test_guide.js
// re-runs the simulation and fails if any figure moves more than 15%.
const BALANCE_REFERENCE = {
    // Level 36 — a three-stage line fully evolved.
    //
    // Rounded to 20 from a measured 18.6, deliberately: one block of a medical
    // subject runs to roughly 20 hours of recordings, so "one fully evolved
    // Pokémon per block" is a unit a student already thinks in. The test
    // tolerance is 15%, which this sits well inside.
    fullyEvolvedHours: { capture: 20, exp: 10 },
    // Level 100, the ceiling.
    maxLevelHours: { capture: 151, exp: 78 },
    // Time to defeat one wild Pokémon, whatever its level.
    battleMinutes: 2.5,
    // Poké Dollars earned per hour of watching, measured the same way — by
    // simulating the real engine in tests/test_guide.js, not by multiplying the
    // award constants by an assumed encounter rate. The two differ by about
    // 10%, because some encounters escape and pay ESCAPE_MONEY instead.
    //
    // Every shop price is quoted in hours and derived from SHOP_PRICE_PER_HOUR,
    // so this is the figure the whole economy hangs on. Capture mode earns a
    // little more because a successful catch pays CAPTURE_MONEY_BONUS on top of
    // the win — deliberate, since capture mode already gives up half the EXP.
    moneyPerHour: { capture: 116, exp: 101 },
    // What a block of a medical subject averages, in hours of recordings. The
    // guide uses it to express progress in something a student can picture.
    blockHours: 20,
};

const REWARDS = {
    EXP: 'exp',
    LEGENDARY: 'legendary',
    SHINY: 'shiny',
};

const REWARD_INFO = {
    [REWARDS.EXP]: {
        label: 'Double EXP',
        detail: 'Every EXP gain is doubled while it runs.',
        icon: '\u26a1',
    },
    [REWARDS.LEGENDARY]: {
        label: 'Legendary Radar',
        detail: 'Legendary encounters become 10x more likely (Lv40+).',
        icon: '\u2726',
    },
    [REWARDS.SHINY]: {
        label: 'Shiny Charm',
        detail: 'Shiny encounters become 10x more likely.',
        // U+2727, not U+2728: the sparkles glyph carries emoji presentation and
        // rendered in full colour beside two monochrome stars.
        icon: '\u2727',
    },
};

const REWARD_EXP_MULTIPLIER = 2;
// Base rates are 1% for a legendary (Lv40+) and 1/512 for a shiny. At roughly
// 24 encounters an hour these turn "probably not today" into "likely within
// the hour", which is what makes the reward worth going back to the lecture for.
const REWARD_LEGENDARY_MULTIPLIER = 10;
const REWARD_SHINY_MULTIPLIER = 10;

// ────────────────────── PVP formats ──────────────────────
//
// The host picks the format; the guest is shown it before committing and both
// teams are cut to `size`. Reward length scales with the length of the match,
// so a format is a real choice rather than a cosmetic one: 6v6 takes several
// times as long to play and pays several times as long a boost.
//
// Anything above 1v1 needs switching, which means both clients must agree on
// what a fainted Pokémon does — hence PVP_RULES_VERSION below.
// ────────────────────── Turn limit ──────────────────────
//
// Two Pokémon that both carry recovery can trade 50% restores for a very long
// time. Simulated, a 6v6 ran past 260 turns — which at a couple of seconds a
// turn, with two humans deciding, is not a lunch break any more.
//
// Competitive Pokémon has the same problem and answers it the same way: a turn
// cap with a tiebreak on what is left standing. The cap scales with the format
// so it is only ever reached by a genuine stall, never by a normal match — the
// median 6v6 finishes in 65 turns, well inside the 150 allowed.
const PVP_TURN_LIMIT = { 1: 60, 3: 120, 6: 180 };

function pvpTurnLimit(size) {
    return PVP_TURN_LIMIT[size] || 120;
}

/**
 * Who wins a battle that hit the cap.
 *
 * Most Pokémon still standing, then the healthiest team by fraction of total
 * HP. A draw stays a draw rather than being broken arbitrarily.
 */
function pvpStallWinner(hostTeam, guestTeam) {
    const alive = t => t.filter(c => c && c.hp > 0).length;
    const health = t => {
        const total = t.reduce((n, c) => n + (c.maxHp || 0), 0);
        return total ? t.reduce((n, c) => n + Math.max(0, c.hp || 0), 0) / total : 0;
    };

    const [ha, ga] = [alive(hostTeam), alive(guestTeam)];
    if (ha !== ga) return ha > ga ? 'host' : 'guest';

    const [hh, gh] = [health(hostTeam), health(guestTeam)];
    if (Math.abs(hh - gh) > 0.01) return hh > gh ? 'host' : 'guest';
    return null;
}

const PVP_MODES = [
    { id: '1v1', size: 1, label: '1 v 1', blurb: 'One Pokémon each. Quick.',        rewardMs: 30 * 60 * 1000,  rewardLabel: '30 min' },
    { id: '3v3', size: 3, label: '3 v 3', blurb: 'Three each, switching allowed.',  rewardMs: 60 * 60 * 1000,  rewardLabel: '1 hour' },
    { id: '6v6', size: 6, label: '6 v 6', blurb: 'Full teams. The long game.',      rewardMs: 120 * 60 * 1000, rewardLabel: '2 hours' },
];

const DEFAULT_PVP_MODE = '3v3';

/**
 * The battle-resolution contract two clients must share.
 *
 * Bump this whenever the LOCAL half of turn resolution changes — the type
 * chart, the damage formula, the crit or spread rolls, the order or number of
 * rng() calls, or what happens when a Pokémon faints. Stats and move data
 * travel inside the battle document and are safe to change without a bump;
 * anything each client computes for itself is not.
 *
 * Version 2 introduced multi-Pokémon formats and the forced-switch phase, which
 * a version 1 client would resolve as "first faint ends the match".
 *
 * Version 3 introduced the mega damage multiplier. The multiplier itself rides
 * in the battle document, but computeDamage had to change to read it, and a
 * version 2 client would ignore the field and diverge on the first hit.
 *
 * Version 4 made Mega Evolution the mechanic the games have: chosen during the
 * battle rather than before it, once per trainer, and paid for in stats instead
 * of a flat damage number. A version 3 client would enter already transformed,
 * ignore the activation, and compute different damage from the same document.
 */
const PVP_RULES_VERSION = 4;

/** The named format, or the default when a document predates modes. */
function getPvpMode(id) {
    return PVP_MODES.find(m => m.id === id)
        || PVP_MODES.find(m => m.id === DEFAULT_PVP_MODE);
}

/** One of the three, uniformly. */
function rollReward() {
    const types = Object.values(REWARDS);
    return types[Math.floor(Math.random() * types.length)];
}

/**
 * A remaining duration as h:mm:ss, or m:ss under an hour.
 *
 * Rounds up rather than down: a boost that still doubles EXP while its clock
 * reads 0:00 looks broken, and one that reads 0:01 for its last moment does
 * not. Both the boost timer and the loss penalty are drawn through here so the
 * two never disagree about what "a minute left" looks like.
 */
function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

function rollShiny() {
    return Math.random() < SHINY_CHANCE;
}

// ─────────────────────────── EXP & Leveling ───────────────────────────

const EXP_PER_MINUTE = 30;
// ── Battle rewards ──
//
// Two battle modes trade collection against levelling speed:
//   capture — the defeated Pokémon joins the party and the Pokédex, EXP x1
//   exp     — no capture (seen only), EXP x6
//
// Measured against the corrected escape reward below: capture x6 reaches level
// 36 in ~18.6h, EXP x12 in ~9.7h — a 1.9x gap. Deliberately not wider: the
// player gives up Pokédex progress across all 1025 species, and a 4-5x gap
// would make capture mode strictly the worse choice rather than a real decision.
//
// These are x6/x12 rather than x1/x6 because escapes no longer pay x10. When
// losing supplied 86% of all EXP, a x1 win bonus still levelled in ~19h; with
// that removed, x1 would take ~90h.
const BATTLE_WIN_EXP_BONUS = 6;
const EXP_MODE_WIN_EXP_BONUS = 12;

// Consolation EXP when a fight is abandoned, as a multiple of the wild level.
// MUST stay below the win bonuses, or losing pays better than winning. This was
// previously a hardcoded x10 in the engine: with a x1 win bonus an escape was
// worth 18x a win, and 86% of all EXP came from losing fights.
const ESCAPE_EXP_MULTIPLIER = 0.5;

// ── Capture ──
//
// Beating a wild Pokemon in capture mode used to catch it every time. At the
// battle length above that is roughly 24 guaranteed catches an hour, which
// filled the party and the Pokedex faster than anything else in the game gave
// the student a reason to want. The roll is what makes meeting a rare species
// worth doing twice.
const CAPTURE_CHANCE = 0.40;

// The instant-capture button skips both the fight and the roll, and is paid for
// in the only currency the game has: the next N wins award no EXP. Since every
// point of EXP in Flickemon comes from a win bonus, that is about N battles of
// levelling given up for one guaranteed catch.
//
// Uses STACK rather than refresh. Refreshing to N would make every press after
// the first one free, which is the same as having no cost at all.
const INSTANT_CAPTURE_EXP_DEBT = 10;

const BATTLE_MODES = { CAPTURE: 'capture', EXP: 'exp' };

// ── Team & EXP share ──
//
// Up to six Pokémon (the active partner always among them) train together.
// Non-active members earn a fraction of what the partner earns, so a team is
// a way to bring others along without out-pacing your main.
const MAX_TEAM_SIZE = 6;

// Catching a species you already own now adds a second, separate Pokémon, so
// the party has no natural ceiling. This one is a backstop, not a balance knob:
// a full save at this size is ~250KB against Firestore's 1MiB per-document
// limit, and reaching it takes well over a hundred hours of captures.
const MAX_PARTY_SIZE = 3000;
const TEAM_EXP_SHARE = 0.25;

function calculateRealMaxHp(baseHp, level) {
    return Math.floor(((2 * baseHp) * level) / 100) + level + 10;
}

/**
 * Attack, Defense and Speed at a level — the games' formula without IVs, EVs
 * or natures, which this game does not model.
 *
 * HP scaled with level and these three did not, so a Pokémon's Attack was its
 * raw base stat whether it was level 5 or level 100. Damage still grew, because
 * the damage formula has its own level term, but Speed did not — which meant a
 * level 5 Pikachu outran a level 100 Snorlax, permanently. Levelling up has to
 * make a Pokémon faster, not only tougher.
 */
function calculateRealStat(baseStat, level) {
    return Math.floor(((2 * baseStat) * level) / 100) + 5;
}

function expForLevel(level) {
    return Math.pow(level, 3);
}

function levelFromExp(totalExp) {
    return Math.max(1, Math.floor(Math.cbrt(totalExp)));
}

const MAX_LEVEL = 100;

// ─────────────────────────── Evolution ───────────────────────────

const EVOLUTION_LEVELS = {
    stage1ToStage2: 16,
    stage2ToStage3: 36,
};

// ─────────────────────────── Encounter Weights ───────────────────────────

// What the wild population looks like depends on how far the PARTNER has come,
// not on one fixed global curve. A student starting out meets nothing but
// first forms; a fully evolved partner draws a world that has grown up with it.
//
// This replaced a flat 88/11/1 plus a "stage 3 locked until Lv.30" gate. The
// gate was a blunt stand-in for the same idea and would now contradict it: a
// two-stage line is fully evolved at Lv.20, and the table below promises that
// partner its 10%.
const ENCOUNTER_TIERS = { BASIC: 'basic', MIDDLE: 'middle', FINAL: 'final' };

const ENCOUNTER_STAGE_WEIGHTS = {
    [ENCOUNTER_TIERS.BASIC]:  [{ stage: 1, weight: 1.00 }],
    [ENCOUNTER_TIERS.MIDDLE]: [{ stage: 1, weight: 0.90 }, { stage: 2, weight: 0.10 }],
    [ENCOUNTER_TIERS.FINAL]:  [{ stage: 1, weight: 0.50 }, { stage: 2, weight: 0.40 },
                               { stage: 3, weight: 0.10 }],
};

/**
 * Which table a partner draws from.
 *
 * Deliberately asymmetric, and the asymmetry is the whole point. A partner is
 * "done" by isFullyEvolved -- Raticate and Tauros never evolve again, so they
 * belong in the same tier as Charizard even though they are not stage 3.
 * The WILD side buckets by evolutionStage instead, because that is what "meet
 * a stage 2" means when you are looking at the encounter.
 */
function encounterTierFor(speciesId) {
    if (isFullyEvolved(speciesId)) return ENCOUNTER_TIERS.FINAL;
    const sp = getSpeciesById(speciesId);
    return sp && sp.evolutionStage >= 2 ? ENCOUNTER_TIERS.MIDDLE : ENCOUNTER_TIERS.BASIC;
}

function encounterWeightsFor(speciesId) {
    return ENCOUNTER_STAGE_WEIGHTS[encounterTierFor(speciesId)]
        || ENCOUNTER_STAGE_WEIGHTS[ENCOUNTER_TIERS.BASIC];
}

// ─────────────────────────── Species Registry ───────────────────────────

const POKEMON_REGISTRY = [
    // ── GEN 1: KANTO ──
    {id: 1, name: 'Bulbasaur', types: ['grass', 'poison'], baseStats: {hp: 45, attack: 49, defense: 49, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 2, name: 'Ivysaur', types: ['grass', 'poison'], baseStats: {hp: 60, attack: 62, defense: 63, speed: 60}, evolutionStage: 2, generation: 1},
    {id: 3, name: 'Venusaur', types: ['grass', 'poison'], baseStats: {hp: 80, attack: 82, defense: 83, speed: 80}, evolutionStage: 3, generation: 1},
    {id: 4, name: 'Charmander', types: ['fire'], baseStats: {hp: 39, attack: 52, defense: 43, speed: 65}, evolutionStage: 1, generation: 1},
    {id: 5, name: 'Charmeleon', types: ['fire'], baseStats: {hp: 58, attack: 64, defense: 58, speed: 80}, evolutionStage: 2, generation: 1},
    {id: 6, name: 'Charizard', types: ['fire', 'flying'], baseStats: {hp: 78, attack: 84, defense: 78, speed: 100}, evolutionStage: 3, generation: 1},
    {id: 7, name: 'Squirtle', types: ['water'], baseStats: {hp: 44, attack: 48, defense: 65, speed: 43}, evolutionStage: 1, generation: 1},
    {id: 8, name: 'Wartortle', types: ['water'], baseStats: {hp: 59, attack: 63, defense: 80, speed: 58}, evolutionStage: 2, generation: 1},
    {id: 9, name: 'Blastoise', types: ['water'], baseStats: {hp: 79, attack: 83, defense: 100, speed: 78}, evolutionStage: 3, generation: 1},
    {id: 10, name: 'Caterpie', types: ['bug'], baseStats: {hp: 45, attack: 30, defense: 35, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 11, name: 'Metapod', types: ['bug'], baseStats: {hp: 50, attack: 20, defense: 55, speed: 30}, evolutionStage: 2, generation: 1},
    {id: 12, name: 'Butterfree', types: ['bug', 'flying'], baseStats: {hp: 60, attack: 45, defense: 50, speed: 70}, evolutionStage: 3, generation: 1},
    {id: 13, name: 'Weedle', types: ['bug', 'poison'], baseStats: {hp: 40, attack: 35, defense: 30, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 14, name: 'Kakuna', types: ['bug', 'poison'], baseStats: {hp: 45, attack: 25, defense: 50, speed: 35}, evolutionStage: 2, generation: 1},
    {id: 15, name: 'Beedrill', types: ['bug', 'poison'], baseStats: {hp: 65, attack: 90, defense: 40, speed: 75}, evolutionStage: 3, generation: 1},
    {id: 16, name: 'Pidgey', types: ['normal', 'flying'], baseStats: {hp: 40, attack: 45, defense: 40, speed: 56}, evolutionStage: 1, generation: 1},
    {id: 17, name: 'Pidgeotto', types: ['normal', 'flying'], baseStats: {hp: 63, attack: 60, defense: 55, speed: 71}, evolutionStage: 2, generation: 1},
    {id: 18, name: 'Pidgeot', types: ['normal', 'flying'], baseStats: {hp: 83, attack: 80, defense: 75, speed: 101}, evolutionStage: 3, generation: 1},
    {id: 19, name: 'Rattata', types: ['normal'], baseStats: {hp: 30, attack: 56, defense: 35, speed: 72}, evolutionStage: 1, generation: 1},
    {id: 20, name: 'Raticate', types: ['normal'], baseStats: {hp: 55, attack: 81, defense: 60, speed: 97}, evolutionStage: 2, generation: 1},
    {id: 21, name: 'Spearow', types: ['normal', 'flying'], baseStats: {hp: 40, attack: 60, defense: 30, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 22, name: 'Fearow', types: ['normal', 'flying'], baseStats: {hp: 65, attack: 90, defense: 65, speed: 100}, evolutionStage: 2, generation: 1},
    {id: 23, name: 'Ekans', types: ['poison'], baseStats: {hp: 35, attack: 60, defense: 44, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 24, name: 'Arbok', types: ['poison'], baseStats: {hp: 60, attack: 95, defense: 69, speed: 80}, evolutionStage: 2, generation: 1},
    {id: 25, name: 'Pikachu', types: ['electric'], baseStats: {hp: 35, attack: 55, defense: 40, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 26, name: 'Raichu', types: ['electric'], baseStats: {hp: 60, attack: 90, defense: 55, speed: 110}, evolutionStage: 3, generation: 1},
    {id: 27, name: 'Sandshrew', types: ['ground'], baseStats: {hp: 50, attack: 75, defense: 85, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 28, name: 'Sandslash', types: ['ground'], baseStats: {hp: 75, attack: 100, defense: 110, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 29, name: 'Nidoran♀', types: ['poison'], baseStats: {hp: 55, attack: 47, defense: 52, speed: 41}, evolutionStage: 1, generation: 1},
    {id: 30, name: 'Nidorina', types: ['poison'], baseStats: {hp: 70, attack: 62, defense: 67, speed: 56}, evolutionStage: 2, generation: 1},
    {id: 31, name: 'Nidoqueen', types: ['poison', 'ground'], baseStats: {hp: 90, attack: 92, defense: 87, speed: 76}, evolutionStage: 3, generation: 1},
    {id: 32, name: 'Nidoran♂', types: ['poison'], baseStats: {hp: 46, attack: 57, defense: 40, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 33, name: 'Nidorino', types: ['poison'], baseStats: {hp: 61, attack: 72, defense: 57, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 34, name: 'Nidoking', types: ['poison', 'ground'], baseStats: {hp: 81, attack: 102, defense: 77, speed: 85}, evolutionStage: 3, generation: 1},
    {id: 35, name: 'Clefairy', types: ['fairy'], baseStats: {hp: 70, attack: 45, defense: 48, speed: 35}, evolutionStage: 2, generation: 1},
    {id: 36, name: 'Clefable', types: ['fairy'], baseStats: {hp: 95, attack: 70, defense: 73, speed: 60}, evolutionStage: 3, generation: 1},
    {id: 37, name: 'Vulpix', types: ['fire'], baseStats: {hp: 38, attack: 41, defense: 40, speed: 65}, evolutionStage: 1, generation: 1},
    {id: 38, name: 'Ninetales', types: ['fire'], baseStats: {hp: 73, attack: 76, defense: 75, speed: 100}, evolutionStage: 2, generation: 1},
    {id: 39, name: 'Jigglypuff', types: ['normal', 'fairy'], baseStats: {hp: 115, attack: 45, defense: 20, speed: 20}, evolutionStage: 2, generation: 1},
    {id: 40, name: 'Wigglytuff', types: ['normal', 'fairy'], baseStats: {hp: 140, attack: 70, defense: 45, speed: 45}, evolutionStage: 3, generation: 1},
    {id: 41, name: 'Zubat', types: ['poison', 'flying'], baseStats: {hp: 40, attack: 45, defense: 35, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 42, name: 'Golbat', types: ['poison', 'flying'], baseStats: {hp: 75, attack: 80, defense: 70, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 43, name: 'Oddish', types: ['grass', 'poison'], baseStats: {hp: 45, attack: 50, defense: 55, speed: 30}, evolutionStage: 1, generation: 1},
    {id: 44, name: 'Gloom', types: ['grass', 'poison'], baseStats: {hp: 60, attack: 65, defense: 70, speed: 40}, evolutionStage: 2, generation: 1},
    {id: 45, name: 'Vileplume', types: ['grass', 'poison'], baseStats: {hp: 75, attack: 80, defense: 85, speed: 50}, evolutionStage: 3, generation: 1},
    {id: 46, name: 'Paras', types: ['bug', 'grass'], baseStats: {hp: 35, attack: 70, defense: 55, speed: 25}, evolutionStage: 1, generation: 1},
    {id: 47, name: 'Parasect', types: ['bug', 'grass'], baseStats: {hp: 60, attack: 95, defense: 80, speed: 30}, evolutionStage: 2, generation: 1},
    {id: 48, name: 'Venonat', types: ['bug', 'poison'], baseStats: {hp: 60, attack: 55, defense: 50, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 49, name: 'Venomoth', types: ['bug', 'poison'], baseStats: {hp: 70, attack: 65, defense: 60, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 50, name: 'Diglett', types: ['ground'], baseStats: {hp: 10, attack: 55, defense: 25, speed: 95}, evolutionStage: 1, generation: 1},
    {id: 51, name: 'Dugtrio', types: ['ground'], baseStats: {hp: 35, attack: 100, defense: 50, speed: 120}, evolutionStage: 2, generation: 1},
    {id: 52, name: 'Meowth', types: ['normal'], baseStats: {hp: 40, attack: 45, defense: 35, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 53, name: 'Persian', types: ['normal'], baseStats: {hp: 65, attack: 70, defense: 60, speed: 115}, evolutionStage: 2, generation: 1},
    {id: 54, name: 'Psyduck', types: ['water'], baseStats: {hp: 50, attack: 52, defense: 48, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 55, name: 'Golduck', types: ['water'], baseStats: {hp: 80, attack: 82, defense: 78, speed: 85}, evolutionStage: 2, generation: 1},
    {id: 56, name: 'Mankey', types: ['fighting'], baseStats: {hp: 40, attack: 80, defense: 35, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 57, name: 'Primeape', types: ['fighting'], baseStats: {hp: 65, attack: 105, defense: 60, speed: 95}, evolutionStage: 2, generation: 1},
    {id: 58, name: 'Growlithe', types: ['fire'], baseStats: {hp: 55, attack: 70, defense: 45, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 59, name: 'Arcanine', types: ['fire'], baseStats: {hp: 90, attack: 110, defense: 80, speed: 95}, evolutionStage: 2, generation: 1},
    {id: 60, name: 'Poliwag', types: ['water'], baseStats: {hp: 40, attack: 50, defense: 40, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 61, name: 'Poliwhirl', types: ['water'], baseStats: {hp: 65, attack: 65, defense: 65, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 62, name: 'Poliwrath', types: ['water', 'fighting'], baseStats: {hp: 90, attack: 95, defense: 95, speed: 70}, evolutionStage: 3, generation: 1},
    {id: 63, name: 'Abra', types: ['psychic'], baseStats: {hp: 25, attack: 20, defense: 15, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 64, name: 'Kadabra', types: ['psychic'], baseStats: {hp: 40, attack: 35, defense: 30, speed: 105}, evolutionStage: 2, generation: 1},
    {id: 65, name: 'Alakazam', types: ['psychic'], baseStats: {hp: 55, attack: 50, defense: 45, speed: 120}, evolutionStage: 3, generation: 1},
    {id: 66, name: 'Machop', types: ['fighting'], baseStats: {hp: 70, attack: 80, defense: 50, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 67, name: 'Machoke', types: ['fighting'], baseStats: {hp: 80, attack: 100, defense: 70, speed: 45}, evolutionStage: 2, generation: 1},
    {id: 68, name: 'Machamp', types: ['fighting'], baseStats: {hp: 90, attack: 130, defense: 80, speed: 55}, evolutionStage: 3, generation: 1},
    {id: 69, name: 'Bellsprout', types: ['grass', 'poison'], baseStats: {hp: 50, attack: 75, defense: 35, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 70, name: 'Weepinbell', types: ['grass', 'poison'], baseStats: {hp: 65, attack: 90, defense: 50, speed: 55}, evolutionStage: 2, generation: 1},
    {id: 71, name: 'Victreebel', types: ['grass', 'poison'], baseStats: {hp: 80, attack: 105, defense: 65, speed: 70}, evolutionStage: 3, generation: 1},
    {id: 72, name: 'Tentacool', types: ['water', 'poison'], baseStats: {hp: 40, attack: 40, defense: 35, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 73, name: 'Tentacruel', types: ['water', 'poison'], baseStats: {hp: 80, attack: 70, defense: 65, speed: 100}, evolutionStage: 2, generation: 1},
    {id: 74, name: 'Geodude', types: ['rock', 'ground'], baseStats: {hp: 40, attack: 80, defense: 100, speed: 20}, evolutionStage: 1, generation: 1},
    {id: 75, name: 'Graveler', types: ['rock', 'ground'], baseStats: {hp: 55, attack: 95, defense: 115, speed: 35}, evolutionStage: 2, generation: 1},
    {id: 76, name: 'Golem', types: ['rock', 'ground'], baseStats: {hp: 80, attack: 120, defense: 130, speed: 45}, evolutionStage: 3, generation: 1},
    {id: 77, name: 'Ponyta', types: ['fire'], baseStats: {hp: 50, attack: 85, defense: 55, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 78, name: 'Rapidash', types: ['fire'], baseStats: {hp: 65, attack: 100, defense: 70, speed: 105}, evolutionStage: 2, generation: 1},
    {id: 79, name: 'Slowpoke', types: ['water', 'psychic'], baseStats: {hp: 90, attack: 65, defense: 65, speed: 15}, evolutionStage: 1, generation: 1},
    {id: 80, name: 'Slowbro', types: ['water', 'psychic'], baseStats: {hp: 95, attack: 75, defense: 110, speed: 30}, evolutionStage: 2, generation: 1},
    {id: 81, name: 'Magnemite', types: ['electric', 'steel'], baseStats: {hp: 25, attack: 35, defense: 70, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 82, name: 'Magneton', types: ['electric', 'steel'], baseStats: {hp: 50, attack: 60, defense: 95, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 83, name: 'Farfetch’d', types: ['normal', 'flying'], baseStats: {hp: 52, attack: 90, defense: 55, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 84, name: 'Doduo', types: ['normal', 'flying'], baseStats: {hp: 35, attack: 85, defense: 45, speed: 75}, evolutionStage: 1, generation: 1},
    {id: 85, name: 'Dodrio', types: ['normal', 'flying'], baseStats: {hp: 60, attack: 110, defense: 70, speed: 110}, evolutionStage: 2, generation: 1},
    {id: 86, name: 'Seel', types: ['water'], baseStats: {hp: 65, attack: 45, defense: 55, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 87, name: 'Dewgong', types: ['water', 'ice'], baseStats: {hp: 90, attack: 70, defense: 80, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 88, name: 'Grimer', types: ['poison'], baseStats: {hp: 80, attack: 80, defense: 50, speed: 25}, evolutionStage: 1, generation: 1},
    {id: 89, name: 'Muk', types: ['poison'], baseStats: {hp: 105, attack: 105, defense: 75, speed: 50}, evolutionStage: 2, generation: 1},
    {id: 90, name: 'Shellder', types: ['water'], baseStats: {hp: 30, attack: 65, defense: 100, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 91, name: 'Cloyster', types: ['water', 'ice'], baseStats: {hp: 50, attack: 95, defense: 180, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 92, name: 'Gastly', types: ['ghost', 'poison'], baseStats: {hp: 30, attack: 35, defense: 30, speed: 80}, evolutionStage: 1, generation: 1},
    {id: 93, name: 'Haunter', types: ['ghost', 'poison'], baseStats: {hp: 45, attack: 50, defense: 45, speed: 95}, evolutionStage: 2, generation: 1},
    {id: 94, name: 'Gengar', types: ['ghost', 'poison'], baseStats: {hp: 60, attack: 65, defense: 60, speed: 110}, evolutionStage: 3, generation: 1},
    {id: 95, name: 'Onix', types: ['rock', 'ground'], baseStats: {hp: 35, attack: 45, defense: 160, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 96, name: 'Drowzee', types: ['psychic'], baseStats: {hp: 60, attack: 48, defense: 45, speed: 42}, evolutionStage: 1, generation: 1},
    {id: 97, name: 'Hypno', types: ['psychic'], baseStats: {hp: 85, attack: 73, defense: 70, speed: 67}, evolutionStage: 2, generation: 1},
    {id: 98, name: 'Krabby', types: ['water'], baseStats: {hp: 30, attack: 105, defense: 90, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 99, name: 'Kingler', types: ['water'], baseStats: {hp: 55, attack: 130, defense: 115, speed: 75}, evolutionStage: 2, generation: 1},
    {id: 100, name: 'Voltorb', types: ['electric'], baseStats: {hp: 40, attack: 30, defense: 50, speed: 100}, evolutionStage: 1, generation: 1},
    {id: 101, name: 'Electrode', types: ['electric'], baseStats: {hp: 60, attack: 50, defense: 70, speed: 150}, evolutionStage: 2, generation: 1},
    {id: 102, name: 'Exeggcute', types: ['grass', 'psychic'], baseStats: {hp: 60, attack: 40, defense: 80, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 103, name: 'Exeggutor', types: ['grass', 'psychic'], baseStats: {hp: 95, attack: 95, defense: 85, speed: 55}, evolutionStage: 2, generation: 1},
    {id: 104, name: 'Cubone', types: ['ground'], baseStats: {hp: 50, attack: 50, defense: 95, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 105, name: 'Marowak', types: ['ground'], baseStats: {hp: 60, attack: 80, defense: 110, speed: 45}, evolutionStage: 2, generation: 1},
    {id: 106, name: 'Hitmonlee', types: ['fighting'], baseStats: {hp: 50, attack: 120, defense: 53, speed: 87}, evolutionStage: 2, generation: 1},
    {id: 107, name: 'Hitmonchan', types: ['fighting'], baseStats: {hp: 50, attack: 105, defense: 79, speed: 76}, evolutionStage: 2, generation: 1},
    {id: 108, name: 'Lickitung', types: ['normal'], baseStats: {hp: 90, attack: 55, defense: 75, speed: 30}, evolutionStage: 1, generation: 1},
    {id: 109, name: 'Koffing', types: ['poison'], baseStats: {hp: 40, attack: 65, defense: 95, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 110, name: 'Weezing', types: ['poison'], baseStats: {hp: 65, attack: 90, defense: 120, speed: 60}, evolutionStage: 2, generation: 1},
    {id: 111, name: 'Rhyhorn', types: ['ground', 'rock'], baseStats: {hp: 80, attack: 85, defense: 95, speed: 25}, evolutionStage: 1, generation: 1},
    {id: 112, name: 'Rhydon', types: ['ground', 'rock'], baseStats: {hp: 105, attack: 130, defense: 120, speed: 40}, evolutionStage: 2, generation: 1},
    {id: 113, name: 'Chansey', types: ['normal'], baseStats: {hp: 250, attack: 5, defense: 5, speed: 50}, evolutionStage: 2, generation: 1},
    {id: 114, name: 'Tangela', types: ['grass'], baseStats: {hp: 65, attack: 55, defense: 115, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 115, name: 'Kangaskhan', types: ['normal'], baseStats: {hp: 105, attack: 95, defense: 80, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 116, name: 'Horsea', types: ['water'], baseStats: {hp: 30, attack: 40, defense: 70, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 117, name: 'Seadra', types: ['water'], baseStats: {hp: 55, attack: 65, defense: 95, speed: 85}, evolutionStage: 2, generation: 1},
    {id: 118, name: 'Goldeen', types: ['water'], baseStats: {hp: 45, attack: 67, defense: 60, speed: 63}, evolutionStage: 1, generation: 1},
    {id: 119, name: 'Seaking', types: ['water'], baseStats: {hp: 80, attack: 92, defense: 65, speed: 68}, evolutionStage: 2, generation: 1},
    {id: 120, name: 'Staryu', types: ['water'], baseStats: {hp: 30, attack: 45, defense: 55, speed: 85}, evolutionStage: 1, generation: 1},
    {id: 121, name: 'Starmie', types: ['water', 'psychic'], baseStats: {hp: 60, attack: 75, defense: 85, speed: 115}, evolutionStage: 2, generation: 1},
    {id: 122, name: 'Mr. Mime', types: ['psychic', 'fairy'], baseStats: {hp: 40, attack: 45, defense: 65, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 123, name: 'Scyther', types: ['bug', 'flying'], baseStats: {hp: 70, attack: 110, defense: 80, speed: 105}, evolutionStage: 1, generation: 1},
    {id: 124, name: 'Jynx', types: ['ice', 'psychic'], baseStats: {hp: 65, attack: 50, defense: 35, speed: 95}, evolutionStage: 2, generation: 1},
    {id: 125, name: 'Electabuzz', types: ['electric'], baseStats: {hp: 65, attack: 83, defense: 57, speed: 105}, evolutionStage: 2, generation: 1},
    {id: 126, name: 'Magmar', types: ['fire'], baseStats: {hp: 65, attack: 95, defense: 57, speed: 93}, evolutionStage: 2, generation: 1},
    {id: 127, name: 'Pinsir', types: ['bug'], baseStats: {hp: 65, attack: 125, defense: 100, speed: 85}, evolutionStage: 1, generation: 1},
    {id: 128, name: 'Tauros', types: ['normal'], baseStats: {hp: 75, attack: 100, defense: 95, speed: 110}, evolutionStage: 1, generation: 1},
    {id: 129, name: 'Magikarp', types: ['water'], baseStats: {hp: 20, attack: 10, defense: 55, speed: 80}, evolutionStage: 1, generation: 1},
    {id: 130, name: 'Gyarados', types: ['water', 'flying'], baseStats: {hp: 95, attack: 125, defense: 79, speed: 81}, evolutionStage: 2, generation: 1},
    {id: 131, name: 'Lapras', types: ['water', 'ice'], baseStats: {hp: 130, attack: 85, defense: 80, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 132, name: 'Ditto', types: ['normal'], baseStats: {hp: 48, attack: 48, defense: 48, speed: 48}, evolutionStage: 1, generation: 1},
    {id: 133, name: 'Eevee', types: ['normal'], baseStats: {hp: 55, attack: 55, defense: 50, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 134, name: 'Vaporeon', types: ['water'], baseStats: {hp: 130, attack: 65, defense: 60, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 135, name: 'Jolteon', types: ['electric'], baseStats: {hp: 65, attack: 65, defense: 60, speed: 130}, evolutionStage: 2, generation: 1},
    {id: 136, name: 'Flareon', types: ['fire'], baseStats: {hp: 65, attack: 130, defense: 60, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 137, name: 'Porygon', types: ['normal'], baseStats: {hp: 65, attack: 60, defense: 70, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 138, name: 'Omanyte', types: ['rock', 'water'], baseStats: {hp: 35, attack: 40, defense: 100, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 139, name: 'Omastar', types: ['rock', 'water'], baseStats: {hp: 70, attack: 60, defense: 125, speed: 55}, evolutionStage: 2, generation: 1},
    {id: 140, name: 'Kabuto', types: ['rock', 'water'], baseStats: {hp: 30, attack: 80, defense: 90, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 141, name: 'Kabutops', types: ['rock', 'water'], baseStats: {hp: 60, attack: 115, defense: 105, speed: 80}, evolutionStage: 2, generation: 1},
    {id: 142, name: 'Aerodactyl', types: ['rock', 'flying'], baseStats: {hp: 80, attack: 105, defense: 65, speed: 130}, evolutionStage: 1, generation: 1},
    {id: 143, name: 'Snorlax', types: ['normal'], baseStats: {hp: 160, attack: 110, defense: 65, speed: 30}, evolutionStage: 2, generation: 1},
    {id: 144, name: 'Articuno', types: ['ice', 'flying'], baseStats: {hp: 90, attack: 85, defense: 100, speed: 85}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 145, name: 'Zapdos', types: ['electric', 'flying'], baseStats: {hp: 90, attack: 90, defense: 85, speed: 100}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 146, name: 'Moltres', types: ['fire', 'flying'], baseStats: {hp: 90, attack: 100, defense: 90, speed: 90}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 147, name: 'Dratini', types: ['dragon'], baseStats: {hp: 41, attack: 64, defense: 45, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 148, name: 'Dragonair', types: ['dragon'], baseStats: {hp: 61, attack: 84, defense: 65, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 149, name: 'Dragonite', types: ['dragon', 'flying'], baseStats: {hp: 91, attack: 134, defense: 95, speed: 80}, evolutionStage: 3, generation: 1},
    {id: 150, name: 'Mewtwo', types: ['psychic'], baseStats: {hp: 106, attack: 110, defense: 90, speed: 130}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 151, name: 'Mew', types: ['psychic'], baseStats: {hp: 100, attack: 100, defense: 100, speed: 100}, evolutionStage: 1, generation: 1, isLegendary: true},
    // ── GEN 2: JOHTO ──
    {id: 152, name: 'Chikorita', types: ['grass'], baseStats: {hp: 45, attack: 49, defense: 65, speed: 45}, evolutionStage: 1, generation: 2},
    {id: 153, name: 'Bayleef', types: ['grass'], baseStats: {hp: 60, attack: 62, defense: 80, speed: 60}, evolutionStage: 2, generation: 2},
    {id: 154, name: 'Meganium', types: ['grass'], baseStats: {hp: 80, attack: 82, defense: 100, speed: 80}, evolutionStage: 3, generation: 2},
    {id: 155, name: 'Cyndaquil', types: ['fire'], baseStats: {hp: 39, attack: 52, defense: 43, speed: 65}, evolutionStage: 1, generation: 2},
    {id: 156, name: 'Quilava', types: ['fire'], baseStats: {hp: 58, attack: 64, defense: 58, speed: 80}, evolutionStage: 2, generation: 2},
    {id: 157, name: 'Typhlosion', types: ['fire'], baseStats: {hp: 78, attack: 84, defense: 78, speed: 100}, evolutionStage: 3, generation: 2},
    {id: 158, name: 'Totodile', types: ['water'], baseStats: {hp: 50, attack: 65, defense: 64, speed: 43}, evolutionStage: 1, generation: 2},
    {id: 159, name: 'Croconaw', types: ['water'], baseStats: {hp: 65, attack: 80, defense: 80, speed: 58}, evolutionStage: 2, generation: 2},
    {id: 160, name: 'Feraligatr', types: ['water'], baseStats: {hp: 85, attack: 105, defense: 100, speed: 78}, evolutionStage: 3, generation: 2},
    {id: 161, name: 'Sentret', types: ['normal'], baseStats: {hp: 35, attack: 46, defense: 34, speed: 20}, evolutionStage: 1, generation: 2},
    {id: 162, name: 'Furret', types: ['normal'], baseStats: {hp: 85, attack: 76, defense: 64, speed: 90}, evolutionStage: 2, generation: 2},
    {id: 163, name: 'Hoothoot', types: ['normal', 'flying'], baseStats: {hp: 60, attack: 30, defense: 30, speed: 50}, evolutionStage: 1, generation: 2},
    {id: 164, name: 'Noctowl', types: ['normal', 'flying'], baseStats: {hp: 100, attack: 50, defense: 50, speed: 70}, evolutionStage: 2, generation: 2},
    {id: 165, name: 'Ledyba', types: ['bug', 'flying'], baseStats: {hp: 40, attack: 20, defense: 30, speed: 55}, evolutionStage: 1, generation: 2},
    {id: 166, name: 'Ledian', types: ['bug', 'flying'], baseStats: {hp: 55, attack: 35, defense: 50, speed: 85}, evolutionStage: 2, generation: 2},
    {id: 167, name: 'Spinarak', types: ['bug', 'poison'], baseStats: {hp: 40, attack: 60, defense: 40, speed: 30}, evolutionStage: 1, generation: 2},
    {id: 168, name: 'Ariados', types: ['bug', 'poison'], baseStats: {hp: 70, attack: 90, defense: 70, speed: 40}, evolutionStage: 2, generation: 2},
    {id: 169, name: 'Crobat', types: ['poison', 'flying'], baseStats: {hp: 85, attack: 90, defense: 80, speed: 130}, evolutionStage: 3, generation: 2},
    {id: 170, name: 'Chinchou', types: ['water', 'electric'], baseStats: {hp: 75, attack: 38, defense: 38, speed: 67}, evolutionStage: 1, generation: 2},
    {id: 171, name: 'Lanturn', types: ['water', 'electric'], baseStats: {hp: 125, attack: 58, defense: 58, speed: 67}, evolutionStage: 2, generation: 2},
    {id: 172, name: 'Pichu', types: ['electric'], baseStats: {hp: 20, attack: 40, defense: 15, speed: 60}, evolutionStage: 1, generation: 2},
    {id: 173, name: 'Cleffa', types: ['fairy'], baseStats: {hp: 50, attack: 25, defense: 28, speed: 15}, evolutionStage: 1, generation: 2},
    {id: 174, name: 'Igglybuff', types: ['normal', 'fairy'], baseStats: {hp: 90, attack: 30, defense: 15, speed: 15}, evolutionStage: 1, generation: 2},
    {id: 175, name: 'Togepi', types: ['fairy'], baseStats: {hp: 35, attack: 20, defense: 65, speed: 20}, evolutionStage: 1, generation: 2},
    {id: 176, name: 'Togetic', types: ['fairy', 'flying'], baseStats: {hp: 55, attack: 40, defense: 85, speed: 40}, evolutionStage: 2, generation: 2},
    {id: 177, name: 'Natu', types: ['psychic', 'flying'], baseStats: {hp: 40, attack: 50, defense: 45, speed: 70}, evolutionStage: 1, generation: 2},
    {id: 178, name: 'Xatu', types: ['psychic', 'flying'], baseStats: {hp: 65, attack: 75, defense: 70, speed: 95}, evolutionStage: 2, generation: 2},
    {id: 179, name: 'Mareep', types: ['electric'], baseStats: {hp: 55, attack: 40, defense: 40, speed: 35}, evolutionStage: 1, generation: 2},
    {id: 180, name: 'Flaaffy', types: ['electric'], baseStats: {hp: 70, attack: 55, defense: 55, speed: 45}, evolutionStage: 2, generation: 2},
    {id: 181, name: 'Ampharos', types: ['electric'], baseStats: {hp: 90, attack: 75, defense: 85, speed: 55}, evolutionStage: 3, generation: 2},
    {id: 182, name: 'Bellossom', types: ['grass'], baseStats: {hp: 75, attack: 80, defense: 95, speed: 50}, evolutionStage: 3, generation: 2},
    {id: 183, name: 'Marill', types: ['water', 'fairy'], baseStats: {hp: 70, attack: 20, defense: 50, speed: 40}, evolutionStage: 2, generation: 2},
    {id: 184, name: 'Azumarill', types: ['water', 'fairy'], baseStats: {hp: 100, attack: 50, defense: 80, speed: 50}, evolutionStage: 3, generation: 2},
    {id: 185, name: 'Sudowoodo', types: ['rock'], baseStats: {hp: 70, attack: 100, defense: 115, speed: 30}, evolutionStage: 2, generation: 2},
    {id: 186, name: 'Politoed', types: ['water'], baseStats: {hp: 90, attack: 75, defense: 75, speed: 70}, evolutionStage: 3, generation: 2},
    {id: 187, name: 'Hoppip', types: ['grass', 'flying'], baseStats: {hp: 35, attack: 35, defense: 40, speed: 50}, evolutionStage: 1, generation: 2},
    {id: 188, name: 'Skiploom', types: ['grass', 'flying'], baseStats: {hp: 55, attack: 45, defense: 50, speed: 80}, evolutionStage: 2, generation: 2},
    {id: 189, name: 'Jumpluff', types: ['grass', 'flying'], baseStats: {hp: 75, attack: 55, defense: 70, speed: 110}, evolutionStage: 3, generation: 2},
    {id: 190, name: 'Aipom', types: ['normal'], baseStats: {hp: 55, attack: 70, defense: 55, speed: 85}, evolutionStage: 1, generation: 2},
    {id: 191, name: 'Sunkern', types: ['grass'], baseStats: {hp: 30, attack: 30, defense: 30, speed: 30}, evolutionStage: 1, generation: 2},
    {id: 192, name: 'Sunflora', types: ['grass'], baseStats: {hp: 75, attack: 75, defense: 55, speed: 30}, evolutionStage: 2, generation: 2},
    {id: 193, name: 'Yanma', types: ['bug', 'flying'], baseStats: {hp: 65, attack: 65, defense: 45, speed: 95}, evolutionStage: 1, generation: 2},
    {id: 194, name: 'Wooper', types: ['water', 'ground'], baseStats: {hp: 55, attack: 45, defense: 45, speed: 15}, evolutionStage: 1, generation: 2},
    {id: 195, name: 'Quagsire', types: ['water', 'ground'], baseStats: {hp: 95, attack: 85, defense: 85, speed: 35}, evolutionStage: 2, generation: 2},
    {id: 196, name: 'Espeon', types: ['psychic'], baseStats: {hp: 65, attack: 65, defense: 60, speed: 110}, evolutionStage: 2, generation: 2},
    {id: 197, name: 'Umbreon', types: ['dark'], baseStats: {hp: 95, attack: 65, defense: 110, speed: 65}, evolutionStage: 2, generation: 2},
    {id: 198, name: 'Murkrow', types: ['dark', 'flying'], baseStats: {hp: 60, attack: 85, defense: 42, speed: 91}, evolutionStage: 1, generation: 2},
    {id: 199, name: 'Slowking', types: ['water', 'psychic'], baseStats: {hp: 95, attack: 75, defense: 80, speed: 30}, evolutionStage: 2, generation: 2},
    {id: 200, name: 'Misdreavus', types: ['ghost'], baseStats: {hp: 60, attack: 60, defense: 60, speed: 85}, evolutionStage: 1, generation: 2},
    {id: 201, name: 'Unown', types: ['psychic'], baseStats: {hp: 48, attack: 72, defense: 48, speed: 48}, evolutionStage: 1, generation: 2},
    {id: 202, name: 'Wobbuffet', types: ['psychic'], baseStats: {hp: 190, attack: 33, defense: 58, speed: 33}, evolutionStage: 2, generation: 2},
    {id: 203, name: 'Girafarig', types: ['normal', 'psychic'], baseStats: {hp: 70, attack: 80, defense: 65, speed: 85}, evolutionStage: 1, generation: 2},
    {id: 204, name: 'Pineco', types: ['bug'], baseStats: {hp: 50, attack: 65, defense: 90, speed: 15}, evolutionStage: 1, generation: 2},
    {id: 205, name: 'Forretress', types: ['bug', 'steel'], baseStats: {hp: 75, attack: 90, defense: 140, speed: 40}, evolutionStage: 2, generation: 2},
    {id: 206, name: 'Dunsparce', types: ['normal'], baseStats: {hp: 100, attack: 70, defense: 70, speed: 45}, evolutionStage: 1, generation: 2},
    {id: 207, name: 'Gligar', types: ['ground', 'flying'], baseStats: {hp: 65, attack: 75, defense: 105, speed: 85}, evolutionStage: 1, generation: 2},
    {id: 208, name: 'Steelix', types: ['steel', 'ground'], baseStats: {hp: 75, attack: 85, defense: 200, speed: 30}, evolutionStage: 2, generation: 2},
    {id: 209, name: 'Snubbull', types: ['fairy'], baseStats: {hp: 60, attack: 80, defense: 50, speed: 30}, evolutionStage: 1, generation: 2},
    {id: 210, name: 'Granbull', types: ['fairy'], baseStats: {hp: 90, attack: 120, defense: 75, speed: 45}, evolutionStage: 2, generation: 2},
    {id: 211, name: 'Qwilfish', types: ['water', 'poison'], baseStats: {hp: 65, attack: 95, defense: 85, speed: 85}, evolutionStage: 1, generation: 2},
    {id: 212, name: 'Scizor', types: ['bug', 'steel'], baseStats: {hp: 70, attack: 130, defense: 100, speed: 65}, evolutionStage: 2, generation: 2},
    {id: 213, name: 'Shuckle', types: ['bug', 'rock'], baseStats: {hp: 20, attack: 10, defense: 230, speed: 5}, evolutionStage: 1, generation: 2},
    {id: 214, name: 'Heracross', types: ['bug', 'fighting'], baseStats: {hp: 80, attack: 125, defense: 75, speed: 85}, evolutionStage: 1, generation: 2},
    {id: 215, name: 'Sneasel', types: ['dark', 'ice'], baseStats: {hp: 55, attack: 95, defense: 55, speed: 115}, evolutionStage: 1, generation: 2},
    {id: 216, name: 'Teddiursa', types: ['normal'], baseStats: {hp: 60, attack: 80, defense: 50, speed: 40}, evolutionStage: 1, generation: 2},
    {id: 217, name: 'Ursaring', types: ['normal'], baseStats: {hp: 90, attack: 130, defense: 75, speed: 55}, evolutionStage: 2, generation: 2},
    {id: 218, name: 'Slugma', types: ['fire'], baseStats: {hp: 40, attack: 40, defense: 40, speed: 20}, evolutionStage: 1, generation: 2},
    {id: 219, name: 'Magcargo', types: ['fire', 'rock'], baseStats: {hp: 60, attack: 50, defense: 120, speed: 30}, evolutionStage: 2, generation: 2},
    {id: 220, name: 'Swinub', types: ['ice', 'ground'], baseStats: {hp: 50, attack: 50, defense: 40, speed: 50}, evolutionStage: 1, generation: 2},
    {id: 221, name: 'Piloswine', types: ['ice', 'ground'], baseStats: {hp: 100, attack: 100, defense: 80, speed: 50}, evolutionStage: 2, generation: 2},
    {id: 222, name: 'Corsola', types: ['water', 'rock'], baseStats: {hp: 65, attack: 55, defense: 95, speed: 35}, evolutionStage: 1, generation: 2},
    {id: 223, name: 'Remoraid', types: ['water'], baseStats: {hp: 35, attack: 65, defense: 35, speed: 65}, evolutionStage: 1, generation: 2},
    {id: 224, name: 'Octillery', types: ['water'], baseStats: {hp: 75, attack: 105, defense: 75, speed: 45}, evolutionStage: 2, generation: 2},
    {id: 225, name: 'Delibird', types: ['ice', 'flying'], baseStats: {hp: 45, attack: 55, defense: 45, speed: 75}, evolutionStage: 1, generation: 2},
    {id: 226, name: 'Mantine', types: ['water', 'flying'], baseStats: {hp: 85, attack: 40, defense: 70, speed: 70}, evolutionStage: 2, generation: 2},
    {id: 227, name: 'Skarmory', types: ['steel', 'flying'], baseStats: {hp: 65, attack: 80, defense: 140, speed: 70}, evolutionStage: 1, generation: 2},
    {id: 228, name: 'Houndour', types: ['dark', 'fire'], baseStats: {hp: 45, attack: 60, defense: 30, speed: 65}, evolutionStage: 1, generation: 2},
    {id: 229, name: 'Houndoom', types: ['dark', 'fire'], baseStats: {hp: 75, attack: 90, defense: 50, speed: 95}, evolutionStage: 2, generation: 2},
    {id: 230, name: 'Kingdra', types: ['water', 'dragon'], baseStats: {hp: 75, attack: 95, defense: 95, speed: 85}, evolutionStage: 3, generation: 2},
    {id: 231, name: 'Phanpy', types: ['ground'], baseStats: {hp: 90, attack: 60, defense: 60, speed: 40}, evolutionStage: 1, generation: 2},
    {id: 232, name: 'Donphan', types: ['ground'], baseStats: {hp: 90, attack: 120, defense: 120, speed: 50}, evolutionStage: 2, generation: 2},
    {id: 233, name: 'Porygon2', types: ['normal'], baseStats: {hp: 85, attack: 80, defense: 90, speed: 60}, evolutionStage: 2, generation: 2},
    {id: 234, name: 'Stantler', types: ['normal'], baseStats: {hp: 73, attack: 95, defense: 62, speed: 85}, evolutionStage: 1, generation: 2},
    {id: 235, name: 'Smeargle', types: ['normal'], baseStats: {hp: 55, attack: 20, defense: 35, speed: 75}, evolutionStage: 1, generation: 2},
    {id: 236, name: 'Tyrogue', types: ['fighting'], baseStats: {hp: 35, attack: 35, defense: 35, speed: 35}, evolutionStage: 1, generation: 2},
    {id: 237, name: 'Hitmontop', types: ['fighting'], baseStats: {hp: 50, attack: 95, defense: 95, speed: 70}, evolutionStage: 2, generation: 2},
    {id: 238, name: 'Smoochum', types: ['ice', 'psychic'], baseStats: {hp: 45, attack: 30, defense: 15, speed: 65}, evolutionStage: 1, generation: 2},
    {id: 239, name: 'Elekid', types: ['electric'], baseStats: {hp: 45, attack: 63, defense: 37, speed: 95}, evolutionStage: 1, generation: 2},
    {id: 240, name: 'Magby', types: ['fire'], baseStats: {hp: 45, attack: 75, defense: 37, speed: 83}, evolutionStage: 1, generation: 2},
    {id: 241, name: 'Miltank', types: ['normal'], baseStats: {hp: 95, attack: 80, defense: 105, speed: 100}, evolutionStage: 1, generation: 2},
    {id: 242, name: 'Blissey', types: ['normal'], baseStats: {hp: 255, attack: 10, defense: 10, speed: 55}, evolutionStage: 3, generation: 2},
    {id: 243, name: 'Raikou', types: ['electric'], baseStats: {hp: 90, attack: 85, defense: 75, speed: 115}, evolutionStage: 1, generation: 2, isLegendary: true},
    {id: 244, name: 'Entei', types: ['fire'], baseStats: {hp: 115, attack: 115, defense: 85, speed: 100}, evolutionStage: 1, generation: 2, isLegendary: true},
    {id: 245, name: 'Suicune', types: ['water'], baseStats: {hp: 100, attack: 75, defense: 115, speed: 85}, evolutionStage: 1, generation: 2, isLegendary: true},
    {id: 246, name: 'Larvitar', types: ['rock', 'ground'], baseStats: {hp: 50, attack: 64, defense: 50, speed: 41}, evolutionStage: 1, generation: 2},
    {id: 247, name: 'Pupitar', types: ['rock', 'ground'], baseStats: {hp: 70, attack: 84, defense: 70, speed: 51}, evolutionStage: 2, generation: 2},
    {id: 248, name: 'Tyranitar', types: ['rock', 'dark'], baseStats: {hp: 100, attack: 134, defense: 110, speed: 61}, evolutionStage: 3, generation: 2},
    {id: 249, name: 'Lugia', types: ['psychic', 'flying'], baseStats: {hp: 106, attack: 90, defense: 130, speed: 110}, evolutionStage: 1, generation: 2, isLegendary: true},
    {id: 250, name: 'Ho-Oh', types: ['fire', 'flying'], baseStats: {hp: 106, attack: 130, defense: 90, speed: 90}, evolutionStage: 1, generation: 2, isLegendary: true},
    {id: 251, name: 'Celebi', types: ['psychic', 'grass'], baseStats: {hp: 100, attack: 100, defense: 100, speed: 100}, evolutionStage: 1, generation: 2, isLegendary: true},
    // ── GEN 3: HOENN ──
    {id: 252, name: 'Treecko', types: ['grass'], baseStats: {hp: 40, attack: 45, defense: 35, speed: 70}, evolutionStage: 1, generation: 3},
    {id: 253, name: 'Grovyle', types: ['grass'], baseStats: {hp: 50, attack: 65, defense: 45, speed: 95}, evolutionStage: 2, generation: 3},
    {id: 254, name: 'Sceptile', types: ['grass'], baseStats: {hp: 70, attack: 85, defense: 65, speed: 120}, evolutionStage: 3, generation: 3},
    {id: 255, name: 'Torchic', types: ['fire'], baseStats: {hp: 45, attack: 60, defense: 40, speed: 45}, evolutionStage: 1, generation: 3},
    {id: 256, name: 'Combusken', types: ['fire', 'fighting'], baseStats: {hp: 60, attack: 85, defense: 60, speed: 55}, evolutionStage: 2, generation: 3},
    {id: 257, name: 'Blaziken', types: ['fire', 'fighting'], baseStats: {hp: 80, attack: 120, defense: 70, speed: 80}, evolutionStage: 3, generation: 3},
    {id: 258, name: 'Mudkip', types: ['water'], baseStats: {hp: 50, attack: 70, defense: 50, speed: 40}, evolutionStage: 1, generation: 3},
    {id: 259, name: 'Marshtomp', types: ['water', 'ground'], baseStats: {hp: 70, attack: 85, defense: 70, speed: 50}, evolutionStage: 2, generation: 3},
    {id: 260, name: 'Swampert', types: ['water', 'ground'], baseStats: {hp: 100, attack: 110, defense: 90, speed: 60}, evolutionStage: 3, generation: 3},
    {id: 261, name: 'Poochyena', types: ['dark'], baseStats: {hp: 35, attack: 55, defense: 35, speed: 35}, evolutionStage: 1, generation: 3},
    {id: 262, name: 'Mightyena', types: ['dark'], baseStats: {hp: 70, attack: 90, defense: 70, speed: 70}, evolutionStage: 2, generation: 3},
    {id: 263, name: 'Zigzagoon', types: ['normal'], baseStats: {hp: 38, attack: 30, defense: 41, speed: 60}, evolutionStage: 1, generation: 3},
    {id: 264, name: 'Linoone', types: ['normal'], baseStats: {hp: 78, attack: 70, defense: 61, speed: 100}, evolutionStage: 2, generation: 3},
    {id: 265, name: 'Wurmple', types: ['bug'], baseStats: {hp: 45, attack: 45, defense: 35, speed: 20}, evolutionStage: 1, generation: 3},
    {id: 266, name: 'Silcoon', types: ['bug'], baseStats: {hp: 50, attack: 35, defense: 55, speed: 15}, evolutionStage: 2, generation: 3},
    {id: 267, name: 'Beautifly', types: ['bug', 'flying'], baseStats: {hp: 60, attack: 70, defense: 50, speed: 65}, evolutionStage: 3, generation: 3},
    {id: 268, name: 'Cascoon', types: ['bug'], baseStats: {hp: 50, attack: 35, defense: 55, speed: 15}, evolutionStage: 2, generation: 3},
    {id: 269, name: 'Dustox', types: ['bug', 'poison'], baseStats: {hp: 60, attack: 50, defense: 70, speed: 65}, evolutionStage: 3, generation: 3},
    {id: 270, name: 'Lotad', types: ['water', 'grass'], baseStats: {hp: 40, attack: 30, defense: 30, speed: 30}, evolutionStage: 1, generation: 3},
    {id: 271, name: 'Lombre', types: ['water', 'grass'], baseStats: {hp: 60, attack: 50, defense: 50, speed: 50}, evolutionStage: 2, generation: 3},
    {id: 272, name: 'Ludicolo', types: ['water', 'grass'], baseStats: {hp: 80, attack: 70, defense: 70, speed: 70}, evolutionStage: 3, generation: 3},
    {id: 273, name: 'Seedot', types: ['grass'], baseStats: {hp: 40, attack: 40, defense: 50, speed: 30}, evolutionStage: 1, generation: 3},
    {id: 274, name: 'Nuzleaf', types: ['grass', 'dark'], baseStats: {hp: 70, attack: 70, defense: 40, speed: 60}, evolutionStage: 2, generation: 3},
    {id: 275, name: 'Shiftry', types: ['grass', 'dark'], baseStats: {hp: 90, attack: 100, defense: 60, speed: 80}, evolutionStage: 3, generation: 3},
    {id: 276, name: 'Taillow', types: ['normal', 'flying'], baseStats: {hp: 40, attack: 55, defense: 30, speed: 85}, evolutionStage: 1, generation: 3},
    {id: 277, name: 'Swellow', types: ['normal', 'flying'], baseStats: {hp: 60, attack: 85, defense: 60, speed: 125}, evolutionStage: 2, generation: 3},
    {id: 278, name: 'Wingull', types: ['water', 'flying'], baseStats: {hp: 40, attack: 30, defense: 30, speed: 85}, evolutionStage: 1, generation: 3},
    {id: 279, name: 'Pelipper', types: ['water', 'flying'], baseStats: {hp: 60, attack: 50, defense: 100, speed: 65}, evolutionStage: 2, generation: 3},
    {id: 280, name: 'Ralts', types: ['psychic', 'fairy'], baseStats: {hp: 28, attack: 25, defense: 25, speed: 40}, evolutionStage: 1, generation: 3},
    {id: 281, name: 'Kirlia', types: ['psychic', 'fairy'], baseStats: {hp: 38, attack: 35, defense: 35, speed: 50}, evolutionStage: 2, generation: 3},
    {id: 282, name: 'Gardevoir', types: ['psychic', 'fairy'], baseStats: {hp: 68, attack: 65, defense: 65, speed: 80}, evolutionStage: 3, generation: 3},
    {id: 283, name: 'Surskit', types: ['bug', 'water'], baseStats: {hp: 40, attack: 30, defense: 32, speed: 65}, evolutionStage: 1, generation: 3},
    {id: 284, name: 'Masquerain', types: ['bug', 'flying'], baseStats: {hp: 70, attack: 60, defense: 62, speed: 80}, evolutionStage: 2, generation: 3},
    {id: 285, name: 'Shroomish', types: ['grass'], baseStats: {hp: 60, attack: 40, defense: 60, speed: 35}, evolutionStage: 1, generation: 3},
    {id: 286, name: 'Breloom', types: ['grass', 'fighting'], baseStats: {hp: 60, attack: 130, defense: 80, speed: 70}, evolutionStage: 2, generation: 3},
    {id: 287, name: 'Slakoth', types: ['normal'], baseStats: {hp: 60, attack: 60, defense: 60, speed: 30}, evolutionStage: 1, generation: 3},
    {id: 288, name: 'Vigoroth', types: ['normal'], baseStats: {hp: 80, attack: 80, defense: 80, speed: 90}, evolutionStage: 2, generation: 3},
    {id: 289, name: 'Slaking', types: ['normal'], baseStats: {hp: 150, attack: 160, defense: 100, speed: 100}, evolutionStage: 3, generation: 3},
    {id: 290, name: 'Nincada', types: ['bug', 'ground'], baseStats: {hp: 31, attack: 45, defense: 90, speed: 40}, evolutionStage: 1, generation: 3},
    {id: 291, name: 'Ninjask', types: ['bug', 'flying'], baseStats: {hp: 61, attack: 90, defense: 45, speed: 160}, evolutionStage: 2, generation: 3},
    {id: 292, name: 'Shedinja', types: ['bug', 'ghost'], baseStats: {hp: 1, attack: 90, defense: 45, speed: 40}, evolutionStage: 2, generation: 3},
    {id: 293, name: 'Whismur', types: ['normal'], baseStats: {hp: 64, attack: 51, defense: 23, speed: 28}, evolutionStage: 1, generation: 3},
    {id: 294, name: 'Loudred', types: ['normal'], baseStats: {hp: 84, attack: 71, defense: 43, speed: 48}, evolutionStage: 2, generation: 3},
    {id: 295, name: 'Exploud', types: ['normal'], baseStats: {hp: 104, attack: 91, defense: 63, speed: 68}, evolutionStage: 3, generation: 3},
    {id: 296, name: 'Makuhita', types: ['fighting'], baseStats: {hp: 72, attack: 60, defense: 30, speed: 25}, evolutionStage: 1, generation: 3},
    {id: 297, name: 'Hariyama', types: ['fighting'], baseStats: {hp: 144, attack: 120, defense: 60, speed: 50}, evolutionStage: 2, generation: 3},
    {id: 298, name: 'Azurill', types: ['normal', 'fairy'], baseStats: {hp: 50, attack: 20, defense: 40, speed: 20}, evolutionStage: 1, generation: 3},
    {id: 299, name: 'Nosepass', types: ['rock'], baseStats: {hp: 30, attack: 45, defense: 135, speed: 30}, evolutionStage: 1, generation: 3},
    {id: 300, name: 'Skitty', types: ['normal'], baseStats: {hp: 50, attack: 45, defense: 45, speed: 50}, evolutionStage: 1, generation: 3},
    {id: 301, name: 'Delcatty', types: ['normal'], baseStats: {hp: 70, attack: 65, defense: 65, speed: 90}, evolutionStage: 2, generation: 3},
    {id: 302, name: 'Sableye', types: ['dark', 'ghost'], baseStats: {hp: 50, attack: 75, defense: 75, speed: 50}, evolutionStage: 1, generation: 3},
    {id: 303, name: 'Mawile', types: ['steel', 'fairy'], baseStats: {hp: 50, attack: 85, defense: 85, speed: 50}, evolutionStage: 1, generation: 3},
    {id: 304, name: 'Aron', types: ['steel', 'rock'], baseStats: {hp: 50, attack: 70, defense: 100, speed: 30}, evolutionStage: 1, generation: 3},
    {id: 305, name: 'Lairon', types: ['steel', 'rock'], baseStats: {hp: 60, attack: 90, defense: 140, speed: 40}, evolutionStage: 2, generation: 3},
    {id: 306, name: 'Aggron', types: ['steel', 'rock'], baseStats: {hp: 70, attack: 110, defense: 180, speed: 50}, evolutionStage: 3, generation: 3},
    {id: 307, name: 'Meditite', types: ['fighting', 'psychic'], baseStats: {hp: 30, attack: 40, defense: 55, speed: 60}, evolutionStage: 1, generation: 3},
    {id: 308, name: 'Medicham', types: ['fighting', 'psychic'], baseStats: {hp: 60, attack: 60, defense: 75, speed: 80}, evolutionStage: 2, generation: 3},
    {id: 309, name: 'Electrike', types: ['electric'], baseStats: {hp: 40, attack: 45, defense: 40, speed: 65}, evolutionStage: 1, generation: 3},
    {id: 310, name: 'Manectric', types: ['electric'], baseStats: {hp: 70, attack: 75, defense: 60, speed: 105}, evolutionStage: 2, generation: 3},
    {id: 311, name: 'Plusle', types: ['electric'], baseStats: {hp: 60, attack: 50, defense: 40, speed: 95}, evolutionStage: 1, generation: 3},
    {id: 312, name: 'Minun', types: ['electric'], baseStats: {hp: 60, attack: 40, defense: 50, speed: 95}, evolutionStage: 1, generation: 3},
    {id: 313, name: 'Volbeat', types: ['bug'], baseStats: {hp: 65, attack: 73, defense: 75, speed: 85}, evolutionStage: 1, generation: 3},
    {id: 314, name: 'Illumise', types: ['bug'], baseStats: {hp: 65, attack: 47, defense: 75, speed: 85}, evolutionStage: 1, generation: 3},
    {id: 315, name: 'Roselia', types: ['grass', 'poison'], baseStats: {hp: 50, attack: 60, defense: 45, speed: 65}, evolutionStage: 2, generation: 3},
    {id: 316, name: 'Gulpin', types: ['poison'], baseStats: {hp: 70, attack: 43, defense: 53, speed: 40}, evolutionStage: 1, generation: 3},
    {id: 317, name: 'Swalot', types: ['poison'], baseStats: {hp: 100, attack: 73, defense: 83, speed: 55}, evolutionStage: 2, generation: 3},
    {id: 318, name: 'Carvanha', types: ['water', 'dark'], baseStats: {hp: 45, attack: 90, defense: 20, speed: 65}, evolutionStage: 1, generation: 3},
    {id: 319, name: 'Sharpedo', types: ['water', 'dark'], baseStats: {hp: 70, attack: 120, defense: 40, speed: 95}, evolutionStage: 2, generation: 3},
    {id: 320, name: 'Wailmer', types: ['water'], baseStats: {hp: 130, attack: 70, defense: 35, speed: 60}, evolutionStage: 1, generation: 3},
    {id: 321, name: 'Wailord', types: ['water'], baseStats: {hp: 170, attack: 90, defense: 45, speed: 60}, evolutionStage: 2, generation: 3},
    {id: 322, name: 'Numel', types: ['fire', 'ground'], baseStats: {hp: 60, attack: 60, defense: 40, speed: 35}, evolutionStage: 1, generation: 3},
    {id: 323, name: 'Camerupt', types: ['fire', 'ground'], baseStats: {hp: 70, attack: 100, defense: 70, speed: 40}, evolutionStage: 2, generation: 3},
    {id: 324, name: 'Torkoal', types: ['fire'], baseStats: {hp: 70, attack: 85, defense: 140, speed: 20}, evolutionStage: 1, generation: 3},
    {id: 325, name: 'Spoink', types: ['psychic'], baseStats: {hp: 60, attack: 25, defense: 35, speed: 60}, evolutionStage: 1, generation: 3},
    {id: 326, name: 'Grumpig', types: ['psychic'], baseStats: {hp: 80, attack: 45, defense: 65, speed: 80}, evolutionStage: 2, generation: 3},
    {id: 327, name: 'Spinda', types: ['normal'], baseStats: {hp: 60, attack: 60, defense: 60, speed: 60}, evolutionStage: 1, generation: 3},
    {id: 328, name: 'Trapinch', types: ['ground'], baseStats: {hp: 45, attack: 100, defense: 45, speed: 10}, evolutionStage: 1, generation: 3},
    {id: 329, name: 'Vibrava', types: ['ground', 'dragon'], baseStats: {hp: 50, attack: 70, defense: 50, speed: 70}, evolutionStage: 2, generation: 3},
    {id: 330, name: 'Flygon', types: ['ground', 'dragon'], baseStats: {hp: 80, attack: 100, defense: 80, speed: 100}, evolutionStage: 3, generation: 3},
    {id: 331, name: 'Cacnea', types: ['grass'], baseStats: {hp: 50, attack: 85, defense: 40, speed: 35}, evolutionStage: 1, generation: 3},
    {id: 332, name: 'Cacturne', types: ['grass', 'dark'], baseStats: {hp: 70, attack: 115, defense: 60, speed: 55}, evolutionStage: 2, generation: 3},
    {id: 333, name: 'Swablu', types: ['normal', 'flying'], baseStats: {hp: 45, attack: 40, defense: 60, speed: 50}, evolutionStage: 1, generation: 3},
    {id: 334, name: 'Altaria', types: ['dragon', 'flying'], baseStats: {hp: 75, attack: 70, defense: 90, speed: 80}, evolutionStage: 2, generation: 3},
    {id: 335, name: 'Zangoose', types: ['normal'], baseStats: {hp: 73, attack: 115, defense: 60, speed: 90}, evolutionStage: 1, generation: 3},
    {id: 336, name: 'Seviper', types: ['poison'], baseStats: {hp: 73, attack: 100, defense: 60, speed: 65}, evolutionStage: 1, generation: 3},
    {id: 337, name: 'Lunatone', types: ['rock', 'psychic'], baseStats: {hp: 90, attack: 55, defense: 65, speed: 70}, evolutionStage: 1, generation: 3},
    {id: 338, name: 'Solrock', types: ['rock', 'psychic'], baseStats: {hp: 90, attack: 95, defense: 85, speed: 70}, evolutionStage: 1, generation: 3},
    {id: 339, name: 'Barboach', types: ['water', 'ground'], baseStats: {hp: 50, attack: 48, defense: 43, speed: 60}, evolutionStage: 1, generation: 3},
    {id: 340, name: 'Whiscash', types: ['water', 'ground'], baseStats: {hp: 110, attack: 78, defense: 73, speed: 60}, evolutionStage: 2, generation: 3},
    {id: 341, name: 'Corphish', types: ['water'], baseStats: {hp: 43, attack: 80, defense: 65, speed: 35}, evolutionStage: 1, generation: 3},
    {id: 342, name: 'Crawdaunt', types: ['water', 'dark'], baseStats: {hp: 63, attack: 120, defense: 85, speed: 55}, evolutionStage: 2, generation: 3},
    {id: 343, name: 'Baltoy', types: ['ground', 'psychic'], baseStats: {hp: 40, attack: 40, defense: 55, speed: 55}, evolutionStage: 1, generation: 3},
    {id: 344, name: 'Claydol', types: ['ground', 'psychic'], baseStats: {hp: 60, attack: 70, defense: 105, speed: 75}, evolutionStage: 2, generation: 3},
    {id: 345, name: 'Lileep', types: ['rock', 'grass'], baseStats: {hp: 66, attack: 41, defense: 77, speed: 23}, evolutionStage: 1, generation: 3},
    {id: 346, name: 'Cradily', types: ['rock', 'grass'], baseStats: {hp: 86, attack: 81, defense: 97, speed: 43}, evolutionStage: 2, generation: 3},
    {id: 347, name: 'Anorith', types: ['rock', 'bug'], baseStats: {hp: 45, attack: 95, defense: 50, speed: 75}, evolutionStage: 1, generation: 3},
    {id: 348, name: 'Armaldo', types: ['rock', 'bug'], baseStats: {hp: 75, attack: 125, defense: 100, speed: 45}, evolutionStage: 2, generation: 3},
    {id: 349, name: 'Feebas', types: ['water'], baseStats: {hp: 20, attack: 15, defense: 20, speed: 80}, evolutionStage: 1, generation: 3},
    {id: 350, name: 'Milotic', types: ['water'], baseStats: {hp: 95, attack: 60, defense: 79, speed: 81}, evolutionStage: 2, generation: 3},
    {id: 351, name: 'Castform', types: ['normal'], baseStats: {hp: 70, attack: 70, defense: 70, speed: 70}, evolutionStage: 1, generation: 3},
    {id: 352, name: 'Kecleon', types: ['normal'], baseStats: {hp: 60, attack: 90, defense: 70, speed: 40}, evolutionStage: 1, generation: 3},
    {id: 353, name: 'Shuppet', types: ['ghost'], baseStats: {hp: 44, attack: 75, defense: 35, speed: 45}, evolutionStage: 1, generation: 3},
    {id: 354, name: 'Banette', types: ['ghost'], baseStats: {hp: 64, attack: 115, defense: 65, speed: 65}, evolutionStage: 2, generation: 3},
    {id: 355, name: 'Duskull', types: ['ghost'], baseStats: {hp: 20, attack: 40, defense: 90, speed: 25}, evolutionStage: 1, generation: 3},
    {id: 356, name: 'Dusclops', types: ['ghost'], baseStats: {hp: 40, attack: 70, defense: 130, speed: 25}, evolutionStage: 2, generation: 3},
    {id: 357, name: 'Tropius', types: ['grass', 'flying'], baseStats: {hp: 99, attack: 68, defense: 83, speed: 51}, evolutionStage: 1, generation: 3},
    {id: 358, name: 'Chimecho', types: ['psychic'], baseStats: {hp: 75, attack: 50, defense: 80, speed: 65}, evolutionStage: 2, generation: 3},
    {id: 359, name: 'Absol', types: ['dark'], baseStats: {hp: 65, attack: 130, defense: 60, speed: 75}, evolutionStage: 1, generation: 3},
    {id: 360, name: 'Wynaut', types: ['psychic'], baseStats: {hp: 95, attack: 23, defense: 48, speed: 23}, evolutionStage: 1, generation: 3},
    {id: 361, name: 'Snorunt', types: ['ice'], baseStats: {hp: 50, attack: 50, defense: 50, speed: 50}, evolutionStage: 1, generation: 3},
    {id: 362, name: 'Glalie', types: ['ice'], baseStats: {hp: 80, attack: 80, defense: 80, speed: 80}, evolutionStage: 2, generation: 3},
    {id: 363, name: 'Spheal', types: ['ice', 'water'], baseStats: {hp: 70, attack: 40, defense: 50, speed: 25}, evolutionStage: 1, generation: 3},
    {id: 364, name: 'Sealeo', types: ['ice', 'water'], baseStats: {hp: 90, attack: 60, defense: 70, speed: 45}, evolutionStage: 2, generation: 3},
    {id: 365, name: 'Walrein', types: ['ice', 'water'], baseStats: {hp: 110, attack: 80, defense: 90, speed: 65}, evolutionStage: 3, generation: 3},
    {id: 366, name: 'Clamperl', types: ['water'], baseStats: {hp: 35, attack: 64, defense: 85, speed: 32}, evolutionStage: 1, generation: 3},
    {id: 367, name: 'Huntail', types: ['water'], baseStats: {hp: 55, attack: 104, defense: 105, speed: 52}, evolutionStage: 2, generation: 3},
    {id: 368, name: 'Gorebyss', types: ['water'], baseStats: {hp: 55, attack: 84, defense: 105, speed: 52}, evolutionStage: 2, generation: 3},
    {id: 369, name: 'Relicanth', types: ['water', 'rock'], baseStats: {hp: 100, attack: 90, defense: 130, speed: 55}, evolutionStage: 1, generation: 3},
    {id: 370, name: 'Luvdisc', types: ['water'], baseStats: {hp: 43, attack: 30, defense: 55, speed: 97}, evolutionStage: 1, generation: 3},
    {id: 371, name: 'Bagon', types: ['dragon'], baseStats: {hp: 45, attack: 75, defense: 60, speed: 50}, evolutionStage: 1, generation: 3},
    {id: 372, name: 'Shelgon', types: ['dragon'], baseStats: {hp: 65, attack: 95, defense: 100, speed: 50}, evolutionStage: 2, generation: 3},
    {id: 373, name: 'Salamence', types: ['dragon', 'flying'], baseStats: {hp: 95, attack: 135, defense: 80, speed: 100}, evolutionStage: 3, generation: 3},
    {id: 374, name: 'Beldum', types: ['steel', 'psychic'], baseStats: {hp: 40, attack: 55, defense: 80, speed: 30}, evolutionStage: 1, generation: 3},
    {id: 375, name: 'Metang', types: ['steel', 'psychic'], baseStats: {hp: 60, attack: 75, defense: 100, speed: 50}, evolutionStage: 2, generation: 3},
    {id: 376, name: 'Metagross', types: ['steel', 'psychic'], baseStats: {hp: 80, attack: 135, defense: 130, speed: 70}, evolutionStage: 3, generation: 3},
    {id: 377, name: 'Regirock', types: ['rock'], baseStats: {hp: 80, attack: 100, defense: 200, speed: 50}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 378, name: 'Regice', types: ['ice'], baseStats: {hp: 80, attack: 50, defense: 100, speed: 50}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 379, name: 'Registeel', types: ['steel'], baseStats: {hp: 80, attack: 75, defense: 150, speed: 50}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 380, name: 'Latias', types: ['dragon', 'psychic'], baseStats: {hp: 80, attack: 80, defense: 90, speed: 110}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 381, name: 'Latios', types: ['dragon', 'psychic'], baseStats: {hp: 80, attack: 90, defense: 80, speed: 110}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 382, name: 'Kyogre', types: ['water'], baseStats: {hp: 100, attack: 100, defense: 90, speed: 90}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 383, name: 'Groudon', types: ['ground'], baseStats: {hp: 100, attack: 150, defense: 140, speed: 90}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 384, name: 'Rayquaza', types: ['dragon', 'flying'], baseStats: {hp: 105, attack: 150, defense: 90, speed: 95}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 385, name: 'Jirachi', types: ['steel', 'psychic'], baseStats: {hp: 100, attack: 100, defense: 100, speed: 100}, evolutionStage: 1, generation: 3, isLegendary: true},
    {id: 386, name: 'Deoxys', types: ['psychic'], baseStats: {hp: 50, attack: 150, defense: 50, speed: 150}, evolutionStage: 1, generation: 3, isLegendary: true},
    // ── GEN 4: SINNOH ──
    {id: 387, name: 'Turtwig', types: ['grass'], baseStats: {hp: 55, attack: 68, defense: 64, speed: 31}, evolutionStage: 1, generation: 4},
    {id: 388, name: 'Grotle', types: ['grass'], baseStats: {hp: 75, attack: 89, defense: 85, speed: 36}, evolutionStage: 2, generation: 4},
    {id: 389, name: 'Torterra', types: ['grass', 'ground'], baseStats: {hp: 95, attack: 109, defense: 105, speed: 56}, evolutionStage: 3, generation: 4},
    {id: 390, name: 'Chimchar', types: ['fire'], baseStats: {hp: 44, attack: 58, defense: 44, speed: 61}, evolutionStage: 1, generation: 4},
    {id: 391, name: 'Monferno', types: ['fire', 'fighting'], baseStats: {hp: 64, attack: 78, defense: 52, speed: 81}, evolutionStage: 2, generation: 4},
    {id: 392, name: 'Infernape', types: ['fire', 'fighting'], baseStats: {hp: 76, attack: 104, defense: 71, speed: 108}, evolutionStage: 3, generation: 4},
    {id: 393, name: 'Piplup', types: ['water'], baseStats: {hp: 53, attack: 51, defense: 53, speed: 40}, evolutionStage: 1, generation: 4},
    {id: 394, name: 'Prinplup', types: ['water'], baseStats: {hp: 64, attack: 66, defense: 68, speed: 50}, evolutionStage: 2, generation: 4},
    {id: 395, name: 'Empoleon', types: ['water', 'steel'], baseStats: {hp: 84, attack: 86, defense: 88, speed: 60}, evolutionStage: 3, generation: 4},
    {id: 396, name: 'Starly', types: ['normal', 'flying'], baseStats: {hp: 40, attack: 55, defense: 30, speed: 60}, evolutionStage: 1, generation: 4},
    {id: 397, name: 'Staravia', types: ['normal', 'flying'], baseStats: {hp: 55, attack: 75, defense: 50, speed: 80}, evolutionStage: 2, generation: 4},
    {id: 398, name: 'Staraptor', types: ['normal', 'flying'], baseStats: {hp: 85, attack: 120, defense: 70, speed: 100}, evolutionStage: 3, generation: 4},
    {id: 399, name: 'Bidoof', types: ['normal'], baseStats: {hp: 59, attack: 45, defense: 40, speed: 31}, evolutionStage: 1, generation: 4},
    {id: 400, name: 'Bibarel', types: ['normal', 'water'], baseStats: {hp: 79, attack: 85, defense: 60, speed: 71}, evolutionStage: 2, generation: 4},
    {id: 401, name: 'Kricketot', types: ['bug'], baseStats: {hp: 37, attack: 25, defense: 41, speed: 25}, evolutionStage: 1, generation: 4},
    {id: 402, name: 'Kricketune', types: ['bug'], baseStats: {hp: 77, attack: 85, defense: 51, speed: 65}, evolutionStage: 2, generation: 4},
    {id: 403, name: 'Shinx', types: ['electric'], baseStats: {hp: 45, attack: 65, defense: 34, speed: 45}, evolutionStage: 1, generation: 4},
    {id: 404, name: 'Luxio', types: ['electric'], baseStats: {hp: 60, attack: 85, defense: 49, speed: 60}, evolutionStage: 2, generation: 4},
    {id: 405, name: 'Luxray', types: ['electric'], baseStats: {hp: 80, attack: 120, defense: 79, speed: 70}, evolutionStage: 3, generation: 4},
    {id: 406, name: 'Budew', types: ['grass', 'poison'], baseStats: {hp: 40, attack: 30, defense: 35, speed: 55}, evolutionStage: 1, generation: 4},
    {id: 407, name: 'Roserade', types: ['grass', 'poison'], baseStats: {hp: 60, attack: 70, defense: 65, speed: 90}, evolutionStage: 3, generation: 4},
    {id: 408, name: 'Cranidos', types: ['rock'], baseStats: {hp: 67, attack: 125, defense: 40, speed: 58}, evolutionStage: 1, generation: 4},
    {id: 409, name: 'Rampardos', types: ['rock'], baseStats: {hp: 97, attack: 165, defense: 60, speed: 58}, evolutionStage: 2, generation: 4},
    {id: 410, name: 'Shieldon', types: ['rock', 'steel'], baseStats: {hp: 30, attack: 42, defense: 118, speed: 30}, evolutionStage: 1, generation: 4},
    {id: 411, name: 'Bastiodon', types: ['rock', 'steel'], baseStats: {hp: 60, attack: 52, defense: 168, speed: 30}, evolutionStage: 2, generation: 4},
    {id: 412, name: 'Burmy', types: ['bug'], baseStats: {hp: 40, attack: 29, defense: 45, speed: 36}, evolutionStage: 1, generation: 4},
    {id: 413, name: 'Wormadam', types: ['bug', 'grass'], baseStats: {hp: 60, attack: 59, defense: 85, speed: 36}, evolutionStage: 2, generation: 4},
    {id: 414, name: 'Mothim', types: ['bug', 'flying'], baseStats: {hp: 70, attack: 94, defense: 50, speed: 66}, evolutionStage: 2, generation: 4},
    {id: 415, name: 'Combee', types: ['bug', 'flying'], baseStats: {hp: 30, attack: 30, defense: 42, speed: 70}, evolutionStage: 1, generation: 4},
    {id: 416, name: 'Vespiquen', types: ['bug', 'flying'], baseStats: {hp: 70, attack: 80, defense: 102, speed: 40}, evolutionStage: 2, generation: 4},
    {id: 417, name: 'Pachirisu', types: ['electric'], baseStats: {hp: 60, attack: 45, defense: 70, speed: 95}, evolutionStage: 1, generation: 4},
    {id: 418, name: 'Buizel', types: ['water'], baseStats: {hp: 55, attack: 65, defense: 35, speed: 85}, evolutionStage: 1, generation: 4},
    {id: 419, name: 'Floatzel', types: ['water'], baseStats: {hp: 85, attack: 105, defense: 55, speed: 115}, evolutionStage: 2, generation: 4},
    {id: 420, name: 'Cherubi', types: ['grass'], baseStats: {hp: 45, attack: 35, defense: 45, speed: 35}, evolutionStage: 1, generation: 4},
    {id: 421, name: 'Cherrim', types: ['grass'], baseStats: {hp: 70, attack: 60, defense: 70, speed: 85}, evolutionStage: 2, generation: 4},
    {id: 422, name: 'Shellos', types: ['water'], baseStats: {hp: 76, attack: 48, defense: 48, speed: 34}, evolutionStage: 1, generation: 4},
    {id: 423, name: 'Gastrodon', types: ['water', 'ground'], baseStats: {hp: 111, attack: 83, defense: 68, speed: 39}, evolutionStage: 2, generation: 4},
    {id: 424, name: 'Ambipom', types: ['normal'], baseStats: {hp: 75, attack: 100, defense: 66, speed: 115}, evolutionStage: 2, generation: 4},
    {id: 425, name: 'Drifloon', types: ['ghost', 'flying'], baseStats: {hp: 90, attack: 50, defense: 34, speed: 70}, evolutionStage: 1, generation: 4},
    {id: 426, name: 'Drifblim', types: ['ghost', 'flying'], baseStats: {hp: 150, attack: 80, defense: 44, speed: 80}, evolutionStage: 2, generation: 4},
    {id: 427, name: 'Buneary', types: ['normal'], baseStats: {hp: 55, attack: 66, defense: 44, speed: 85}, evolutionStage: 1, generation: 4},
    {id: 428, name: 'Lopunny', types: ['normal'], baseStats: {hp: 65, attack: 76, defense: 84, speed: 105}, evolutionStage: 2, generation: 4},
    {id: 429, name: 'Mismagius', types: ['ghost'], baseStats: {hp: 60, attack: 60, defense: 60, speed: 105}, evolutionStage: 2, generation: 4},
    {id: 430, name: 'Honchkrow', types: ['dark', 'flying'], baseStats: {hp: 100, attack: 125, defense: 52, speed: 71}, evolutionStage: 2, generation: 4},
    {id: 431, name: 'Glameow', types: ['normal'], baseStats: {hp: 49, attack: 55, defense: 42, speed: 85}, evolutionStage: 1, generation: 4},
    {id: 432, name: 'Purugly', types: ['normal'], baseStats: {hp: 71, attack: 82, defense: 64, speed: 112}, evolutionStage: 2, generation: 4},
    {id: 433, name: 'Chingling', types: ['psychic'], baseStats: {hp: 45, attack: 30, defense: 50, speed: 45}, evolutionStage: 1, generation: 4},
    {id: 434, name: 'Stunky', types: ['poison', 'dark'], baseStats: {hp: 63, attack: 63, defense: 47, speed: 74}, evolutionStage: 1, generation: 4},
    {id: 435, name: 'Skuntank', types: ['poison', 'dark'], baseStats: {hp: 103, attack: 93, defense: 67, speed: 84}, evolutionStage: 2, generation: 4},
    {id: 436, name: 'Bronzor', types: ['steel', 'psychic'], baseStats: {hp: 57, attack: 24, defense: 86, speed: 23}, evolutionStage: 1, generation: 4},
    {id: 437, name: 'Bronzong', types: ['steel', 'psychic'], baseStats: {hp: 67, attack: 89, defense: 116, speed: 33}, evolutionStage: 2, generation: 4},
    {id: 438, name: 'Bonsly', types: ['rock'], baseStats: {hp: 50, attack: 80, defense: 95, speed: 10}, evolutionStage: 1, generation: 4},
    {id: 439, name: 'Mime Jr.', types: ['psychic', 'fairy'], baseStats: {hp: 20, attack: 25, defense: 45, speed: 60}, evolutionStage: 1, generation: 4},
    {id: 440, name: 'Happiny', types: ['normal'], baseStats: {hp: 100, attack: 5, defense: 5, speed: 30}, evolutionStage: 1, generation: 4},
    {id: 441, name: 'Chatot', types: ['normal', 'flying'], baseStats: {hp: 76, attack: 65, defense: 45, speed: 91}, evolutionStage: 1, generation: 4},
    {id: 442, name: 'Spiritomb', types: ['ghost', 'dark'], baseStats: {hp: 50, attack: 92, defense: 108, speed: 35}, evolutionStage: 1, generation: 4},
    {id: 443, name: 'Gible', types: ['dragon', 'ground'], baseStats: {hp: 58, attack: 70, defense: 45, speed: 42}, evolutionStage: 1, generation: 4},
    {id: 444, name: 'Gabite', types: ['dragon', 'ground'], baseStats: {hp: 68, attack: 90, defense: 65, speed: 82}, evolutionStage: 2, generation: 4},
    {id: 445, name: 'Garchomp', types: ['dragon', 'ground'], baseStats: {hp: 108, attack: 130, defense: 95, speed: 102}, evolutionStage: 3, generation: 4},
    {id: 446, name: 'Munchlax', types: ['normal'], baseStats: {hp: 135, attack: 85, defense: 40, speed: 5}, evolutionStage: 1, generation: 4},
    {id: 447, name: 'Riolu', types: ['fighting'], baseStats: {hp: 40, attack: 70, defense: 40, speed: 60}, evolutionStage: 1, generation: 4},
    {id: 448, name: 'Lucario', types: ['fighting', 'steel'], baseStats: {hp: 70, attack: 110, defense: 70, speed: 90}, evolutionStage: 2, generation: 4},
    {id: 449, name: 'Hippopotas', types: ['ground'], baseStats: {hp: 68, attack: 72, defense: 78, speed: 32}, evolutionStage: 1, generation: 4},
    {id: 450, name: 'Hippowdon', types: ['ground'], baseStats: {hp: 108, attack: 112, defense: 118, speed: 47}, evolutionStage: 2, generation: 4},
    {id: 451, name: 'Skorupi', types: ['poison', 'bug'], baseStats: {hp: 40, attack: 50, defense: 90, speed: 65}, evolutionStage: 1, generation: 4},
    {id: 452, name: 'Drapion', types: ['poison', 'dark'], baseStats: {hp: 70, attack: 90, defense: 110, speed: 95}, evolutionStage: 2, generation: 4},
    {id: 453, name: 'Croagunk', types: ['poison', 'fighting'], baseStats: {hp: 48, attack: 61, defense: 40, speed: 50}, evolutionStage: 1, generation: 4},
    {id: 454, name: 'Toxicroak', types: ['poison', 'fighting'], baseStats: {hp: 83, attack: 106, defense: 65, speed: 85}, evolutionStage: 2, generation: 4},
    {id: 455, name: 'Carnivine', types: ['grass'], baseStats: {hp: 74, attack: 100, defense: 72, speed: 46}, evolutionStage: 1, generation: 4},
    {id: 456, name: 'Finneon', types: ['water'], baseStats: {hp: 49, attack: 49, defense: 56, speed: 66}, evolutionStage: 1, generation: 4},
    {id: 457, name: 'Lumineon', types: ['water'], baseStats: {hp: 69, attack: 69, defense: 76, speed: 91}, evolutionStage: 2, generation: 4},
    {id: 458, name: 'Mantyke', types: ['water', 'flying'], baseStats: {hp: 45, attack: 20, defense: 50, speed: 50}, evolutionStage: 1, generation: 4},
    {id: 459, name: 'Snover', types: ['grass', 'ice'], baseStats: {hp: 60, attack: 62, defense: 50, speed: 40}, evolutionStage: 1, generation: 4},
    {id: 460, name: 'Abomasnow', types: ['grass', 'ice'], baseStats: {hp: 90, attack: 92, defense: 75, speed: 60}, evolutionStage: 2, generation: 4},
    {id: 461, name: 'Weavile', types: ['dark', 'ice'], baseStats: {hp: 70, attack: 120, defense: 65, speed: 125}, evolutionStage: 2, generation: 4},
    {id: 462, name: 'Magnezone', types: ['electric', 'steel'], baseStats: {hp: 70, attack: 70, defense: 115, speed: 60}, evolutionStage: 3, generation: 4},
    {id: 463, name: 'Lickilicky', types: ['normal'], baseStats: {hp: 110, attack: 85, defense: 95, speed: 50}, evolutionStage: 2, generation: 4},
    {id: 464, name: 'Rhyperior', types: ['ground', 'rock'], baseStats: {hp: 115, attack: 140, defense: 130, speed: 40}, evolutionStage: 3, generation: 4},
    {id: 465, name: 'Tangrowth', types: ['grass'], baseStats: {hp: 100, attack: 100, defense: 125, speed: 50}, evolutionStage: 2, generation: 4},
    {id: 466, name: 'Electivire', types: ['electric'], baseStats: {hp: 75, attack: 123, defense: 67, speed: 95}, evolutionStage: 3, generation: 4},
    {id: 467, name: 'Magmortar', types: ['fire'], baseStats: {hp: 75, attack: 95, defense: 67, speed: 83}, evolutionStage: 3, generation: 4},
    {id: 468, name: 'Togekiss', types: ['fairy', 'flying'], baseStats: {hp: 85, attack: 50, defense: 95, speed: 80}, evolutionStage: 3, generation: 4},
    {id: 469, name: 'Yanmega', types: ['bug', 'flying'], baseStats: {hp: 86, attack: 76, defense: 86, speed: 95}, evolutionStage: 2, generation: 4},
    {id: 470, name: 'Leafeon', types: ['grass'], baseStats: {hp: 65, attack: 110, defense: 130, speed: 95}, evolutionStage: 2, generation: 4},
    {id: 471, name: 'Glaceon', types: ['ice'], baseStats: {hp: 65, attack: 60, defense: 110, speed: 65}, evolutionStage: 2, generation: 4},
    {id: 472, name: 'Gliscor', types: ['ground', 'flying'], baseStats: {hp: 75, attack: 95, defense: 125, speed: 95}, evolutionStage: 2, generation: 4},
    {id: 473, name: 'Mamoswine', types: ['ice', 'ground'], baseStats: {hp: 110, attack: 130, defense: 80, speed: 80}, evolutionStage: 3, generation: 4},
    {id: 474, name: 'Porygon-Z', types: ['normal'], baseStats: {hp: 85, attack: 80, defense: 70, speed: 90}, evolutionStage: 3, generation: 4},
    {id: 475, name: 'Gallade', types: ['psychic', 'fighting'], baseStats: {hp: 68, attack: 125, defense: 65, speed: 80}, evolutionStage: 3, generation: 4},
    {id: 476, name: 'Probopass', types: ['rock', 'steel'], baseStats: {hp: 60, attack: 55, defense: 145, speed: 40}, evolutionStage: 2, generation: 4},
    {id: 477, name: 'Dusknoir', types: ['ghost'], baseStats: {hp: 45, attack: 100, defense: 135, speed: 45}, evolutionStage: 3, generation: 4},
    {id: 478, name: 'Froslass', types: ['ice', 'ghost'], baseStats: {hp: 70, attack: 80, defense: 70, speed: 110}, evolutionStage: 2, generation: 4},
    {id: 479, name: 'Rotom', types: ['electric', 'ghost'], baseStats: {hp: 50, attack: 50, defense: 77, speed: 91}, evolutionStage: 1, generation: 4},
    {id: 480, name: 'Uxie', types: ['psychic'], baseStats: {hp: 75, attack: 75, defense: 130, speed: 95}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 481, name: 'Mesprit', types: ['psychic'], baseStats: {hp: 80, attack: 105, defense: 105, speed: 80}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 482, name: 'Azelf', types: ['psychic'], baseStats: {hp: 75, attack: 125, defense: 70, speed: 115}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 483, name: 'Dialga', types: ['steel', 'dragon'], baseStats: {hp: 100, attack: 120, defense: 120, speed: 90}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 484, name: 'Palkia', types: ['water', 'dragon'], baseStats: {hp: 90, attack: 120, defense: 100, speed: 100}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 485, name: 'Heatran', types: ['fire', 'steel'], baseStats: {hp: 91, attack: 90, defense: 106, speed: 77}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 486, name: 'Regigigas', types: ['normal'], baseStats: {hp: 110, attack: 160, defense: 110, speed: 100}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 487, name: 'Giratina', types: ['ghost', 'dragon'], baseStats: {hp: 150, attack: 100, defense: 120, speed: 90}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 488, name: 'Cresselia', types: ['psychic'], baseStats: {hp: 120, attack: 70, defense: 110, speed: 85}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 489, name: 'Phione', types: ['water'], baseStats: {hp: 80, attack: 80, defense: 80, speed: 80}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 490, name: 'Manaphy', types: ['water'], baseStats: {hp: 100, attack: 100, defense: 100, speed: 100}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 491, name: 'Darkrai', types: ['dark'], baseStats: {hp: 70, attack: 90, defense: 90, speed: 125}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 492, name: 'Shaymin', types: ['grass'], baseStats: {hp: 100, attack: 100, defense: 100, speed: 100}, evolutionStage: 1, generation: 4, isLegendary: true},
    {id: 493, name: 'Arceus', types: ['normal'], baseStats: {hp: 120, attack: 120, defense: 120, speed: 120}, evolutionStage: 1, generation: 4, isLegendary: true},
    // ── GEN 5: UNOVA ──
    {id: 494, name: 'Victini', types: ['psychic', 'fire'], baseStats: {hp: 100, attack: 100, defense: 100, speed: 100}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 495, name: 'Snivy', types: ['grass'], baseStats: {hp: 45, attack: 45, defense: 55, speed: 63}, evolutionStage: 1, generation: 5},
    {id: 496, name: 'Servine', types: ['grass'], baseStats: {hp: 60, attack: 60, defense: 75, speed: 83}, evolutionStage: 2, generation: 5},
    {id: 497, name: 'Serperior', types: ['grass'], baseStats: {hp: 75, attack: 75, defense: 95, speed: 113}, evolutionStage: 3, generation: 5},
    {id: 498, name: 'Tepig', types: ['fire'], baseStats: {hp: 65, attack: 63, defense: 45, speed: 45}, evolutionStage: 1, generation: 5},
    {id: 499, name: 'Pignite', types: ['fire', 'fighting'], baseStats: {hp: 90, attack: 93, defense: 55, speed: 55}, evolutionStage: 2, generation: 5},
    {id: 500, name: 'Emboar', types: ['fire', 'fighting'], baseStats: {hp: 110, attack: 123, defense: 65, speed: 65}, evolutionStage: 3, generation: 5},
    {id: 501, name: 'Oshawott', types: ['water'], baseStats: {hp: 55, attack: 55, defense: 45, speed: 45}, evolutionStage: 1, generation: 5},
    {id: 502, name: 'Dewott', types: ['water'], baseStats: {hp: 75, attack: 75, defense: 60, speed: 60}, evolutionStage: 2, generation: 5},
    {id: 503, name: 'Samurott', types: ['water'], baseStats: {hp: 95, attack: 100, defense: 85, speed: 70}, evolutionStage: 3, generation: 5},
    {id: 504, name: 'Patrat', types: ['normal'], baseStats: {hp: 45, attack: 55, defense: 39, speed: 42}, evolutionStage: 1, generation: 5},
    {id: 505, name: 'Watchog', types: ['normal'], baseStats: {hp: 60, attack: 85, defense: 69, speed: 77}, evolutionStage: 2, generation: 5},
    {id: 506, name: 'Lillipup', types: ['normal'], baseStats: {hp: 45, attack: 60, defense: 45, speed: 55}, evolutionStage: 1, generation: 5},
    {id: 507, name: 'Herdier', types: ['normal'], baseStats: {hp: 65, attack: 80, defense: 65, speed: 60}, evolutionStage: 2, generation: 5},
    {id: 508, name: 'Stoutland', types: ['normal'], baseStats: {hp: 85, attack: 110, defense: 90, speed: 80}, evolutionStage: 3, generation: 5},
    {id: 509, name: 'Purrloin', types: ['dark'], baseStats: {hp: 41, attack: 50, defense: 37, speed: 66}, evolutionStage: 1, generation: 5},
    {id: 510, name: 'Liepard', types: ['dark'], baseStats: {hp: 64, attack: 88, defense: 50, speed: 106}, evolutionStage: 2, generation: 5},
    {id: 511, name: 'Pansage', types: ['grass'], baseStats: {hp: 50, attack: 53, defense: 48, speed: 64}, evolutionStage: 1, generation: 5},
    {id: 512, name: 'Simisage', types: ['grass'], baseStats: {hp: 75, attack: 98, defense: 63, speed: 101}, evolutionStage: 2, generation: 5},
    {id: 513, name: 'Pansear', types: ['fire'], baseStats: {hp: 50, attack: 53, defense: 48, speed: 64}, evolutionStage: 1, generation: 5},
    {id: 514, name: 'Simisear', types: ['fire'], baseStats: {hp: 75, attack: 98, defense: 63, speed: 101}, evolutionStage: 2, generation: 5},
    {id: 515, name: 'Panpour', types: ['water'], baseStats: {hp: 50, attack: 53, defense: 48, speed: 64}, evolutionStage: 1, generation: 5},
    {id: 516, name: 'Simipour', types: ['water'], baseStats: {hp: 75, attack: 98, defense: 63, speed: 101}, evolutionStage: 2, generation: 5},
    {id: 517, name: 'Munna', types: ['psychic'], baseStats: {hp: 76, attack: 25, defense: 45, speed: 24}, evolutionStage: 1, generation: 5},
    {id: 518, name: 'Musharna', types: ['psychic'], baseStats: {hp: 116, attack: 55, defense: 85, speed: 29}, evolutionStage: 2, generation: 5},
    {id: 519, name: 'Pidove', types: ['normal', 'flying'], baseStats: {hp: 50, attack: 55, defense: 50, speed: 43}, evolutionStage: 1, generation: 5},
    {id: 520, name: 'Tranquill', types: ['normal', 'flying'], baseStats: {hp: 62, attack: 77, defense: 62, speed: 65}, evolutionStage: 2, generation: 5},
    {id: 521, name: 'Unfezant', types: ['normal', 'flying'], baseStats: {hp: 80, attack: 115, defense: 80, speed: 93}, evolutionStage: 3, generation: 5},
    {id: 522, name: 'Blitzle', types: ['electric'], baseStats: {hp: 45, attack: 60, defense: 32, speed: 76}, evolutionStage: 1, generation: 5},
    {id: 523, name: 'Zebstrika', types: ['electric'], baseStats: {hp: 75, attack: 100, defense: 63, speed: 116}, evolutionStage: 2, generation: 5},
    {id: 524, name: 'Roggenrola', types: ['rock'], baseStats: {hp: 55, attack: 75, defense: 85, speed: 15}, evolutionStage: 1, generation: 5},
    {id: 525, name: 'Boldore', types: ['rock'], baseStats: {hp: 70, attack: 105, defense: 105, speed: 20}, evolutionStage: 2, generation: 5},
    {id: 526, name: 'Gigalith', types: ['rock'], baseStats: {hp: 85, attack: 135, defense: 130, speed: 25}, evolutionStage: 3, generation: 5},
    {id: 527, name: 'Woobat', types: ['psychic', 'flying'], baseStats: {hp: 65, attack: 45, defense: 43, speed: 72}, evolutionStage: 1, generation: 5},
    {id: 528, name: 'Swoobat', types: ['psychic', 'flying'], baseStats: {hp: 67, attack: 57, defense: 55, speed: 114}, evolutionStage: 2, generation: 5},
    {id: 529, name: 'Drilbur', types: ['ground'], baseStats: {hp: 60, attack: 85, defense: 40, speed: 68}, evolutionStage: 1, generation: 5},
    {id: 530, name: 'Excadrill', types: ['ground', 'steel'], baseStats: {hp: 110, attack: 135, defense: 60, speed: 88}, evolutionStage: 2, generation: 5},
    {id: 531, name: 'Audino', types: ['normal'], baseStats: {hp: 103, attack: 60, defense: 86, speed: 50}, evolutionStage: 1, generation: 5},
    {id: 532, name: 'Timburr', types: ['fighting'], baseStats: {hp: 75, attack: 80, defense: 55, speed: 35}, evolutionStage: 1, generation: 5},
    {id: 533, name: 'Gurdurr', types: ['fighting'], baseStats: {hp: 85, attack: 105, defense: 85, speed: 40}, evolutionStage: 2, generation: 5},
    {id: 534, name: 'Conkeldurr', types: ['fighting'], baseStats: {hp: 105, attack: 140, defense: 95, speed: 45}, evolutionStage: 3, generation: 5},
    {id: 535, name: 'Tympole', types: ['water'], baseStats: {hp: 50, attack: 50, defense: 40, speed: 64}, evolutionStage: 1, generation: 5},
    {id: 536, name: 'Palpitoad', types: ['water', 'ground'], baseStats: {hp: 75, attack: 65, defense: 55, speed: 69}, evolutionStage: 2, generation: 5},
    {id: 537, name: 'Seismitoad', types: ['water', 'ground'], baseStats: {hp: 105, attack: 95, defense: 75, speed: 74}, evolutionStage: 3, generation: 5},
    {id: 538, name: 'Throh', types: ['fighting'], baseStats: {hp: 120, attack: 100, defense: 85, speed: 45}, evolutionStage: 1, generation: 5},
    {id: 539, name: 'Sawk', types: ['fighting'], baseStats: {hp: 75, attack: 125, defense: 75, speed: 85}, evolutionStage: 1, generation: 5},
    {id: 540, name: 'Sewaddle', types: ['bug', 'grass'], baseStats: {hp: 45, attack: 53, defense: 70, speed: 42}, evolutionStage: 1, generation: 5},
    {id: 541, name: 'Swadloon', types: ['bug', 'grass'], baseStats: {hp: 55, attack: 63, defense: 90, speed: 42}, evolutionStage: 2, generation: 5},
    {id: 542, name: 'Leavanny', types: ['bug', 'grass'], baseStats: {hp: 75, attack: 103, defense: 80, speed: 92}, evolutionStage: 3, generation: 5},
    {id: 543, name: 'Venipede', types: ['bug', 'poison'], baseStats: {hp: 30, attack: 45, defense: 59, speed: 57}, evolutionStage: 1, generation: 5},
    {id: 544, name: 'Whirlipede', types: ['bug', 'poison'], baseStats: {hp: 40, attack: 55, defense: 99, speed: 47}, evolutionStage: 2, generation: 5},
    {id: 545, name: 'Scolipede', types: ['bug', 'poison'], baseStats: {hp: 60, attack: 100, defense: 89, speed: 112}, evolutionStage: 3, generation: 5},
    {id: 546, name: 'Cottonee', types: ['grass', 'fairy'], baseStats: {hp: 40, attack: 27, defense: 60, speed: 66}, evolutionStage: 1, generation: 5},
    {id: 547, name: 'Whimsicott', types: ['grass', 'fairy'], baseStats: {hp: 60, attack: 67, defense: 85, speed: 116}, evolutionStage: 2, generation: 5},
    {id: 548, name: 'Petilil', types: ['grass'], baseStats: {hp: 45, attack: 35, defense: 50, speed: 30}, evolutionStage: 1, generation: 5},
    {id: 549, name: 'Lilligant', types: ['grass'], baseStats: {hp: 70, attack: 60, defense: 75, speed: 90}, evolutionStage: 2, generation: 5},
    {id: 550, name: 'Basculin', types: ['water'], baseStats: {hp: 70, attack: 92, defense: 65, speed: 98}, evolutionStage: 1, generation: 5},
    {id: 551, name: 'Sandile', types: ['ground', 'dark'], baseStats: {hp: 50, attack: 72, defense: 35, speed: 65}, evolutionStage: 1, generation: 5},
    {id: 552, name: 'Krokorok', types: ['ground', 'dark'], baseStats: {hp: 60, attack: 82, defense: 45, speed: 74}, evolutionStage: 2, generation: 5},
    {id: 553, name: 'Krookodile', types: ['ground', 'dark'], baseStats: {hp: 95, attack: 117, defense: 80, speed: 92}, evolutionStage: 3, generation: 5},
    {id: 554, name: 'Darumaka', types: ['fire'], baseStats: {hp: 70, attack: 90, defense: 45, speed: 50}, evolutionStage: 1, generation: 5},
    {id: 555, name: 'Darmanitan', types: ['fire'], baseStats: {hp: 105, attack: 140, defense: 55, speed: 95}, evolutionStage: 2, generation: 5},
    {id: 556, name: 'Maractus', types: ['grass'], baseStats: {hp: 75, attack: 86, defense: 67, speed: 60}, evolutionStage: 1, generation: 5},
    {id: 557, name: 'Dwebble', types: ['bug', 'rock'], baseStats: {hp: 50, attack: 65, defense: 85, speed: 55}, evolutionStage: 1, generation: 5},
    {id: 558, name: 'Crustle', types: ['bug', 'rock'], baseStats: {hp: 70, attack: 105, defense: 125, speed: 45}, evolutionStage: 2, generation: 5},
    {id: 559, name: 'Scraggy', types: ['dark', 'fighting'], baseStats: {hp: 50, attack: 75, defense: 70, speed: 48}, evolutionStage: 1, generation: 5},
    {id: 560, name: 'Scrafty', types: ['dark', 'fighting'], baseStats: {hp: 65, attack: 90, defense: 115, speed: 58}, evolutionStage: 2, generation: 5},
    {id: 561, name: 'Sigilyph', types: ['psychic', 'flying'], baseStats: {hp: 72, attack: 58, defense: 80, speed: 97}, evolutionStage: 1, generation: 5},
    {id: 562, name: 'Yamask', types: ['ghost'], baseStats: {hp: 38, attack: 30, defense: 85, speed: 30}, evolutionStage: 1, generation: 5},
    {id: 563, name: 'Cofagrigus', types: ['ghost'], baseStats: {hp: 58, attack: 50, defense: 145, speed: 30}, evolutionStage: 2, generation: 5},
    {id: 564, name: 'Tirtouga', types: ['water', 'rock'], baseStats: {hp: 54, attack: 78, defense: 103, speed: 22}, evolutionStage: 1, generation: 5},
    {id: 565, name: 'Carracosta', types: ['water', 'rock'], baseStats: {hp: 74, attack: 108, defense: 133, speed: 32}, evolutionStage: 2, generation: 5},
    {id: 566, name: 'Archen', types: ['rock', 'flying'], baseStats: {hp: 55, attack: 112, defense: 45, speed: 70}, evolutionStage: 1, generation: 5},
    {id: 567, name: 'Archeops', types: ['rock', 'flying'], baseStats: {hp: 75, attack: 140, defense: 65, speed: 110}, evolutionStage: 2, generation: 5},
    {id: 568, name: 'Trubbish', types: ['poison'], baseStats: {hp: 50, attack: 50, defense: 62, speed: 65}, evolutionStage: 1, generation: 5},
    {id: 569, name: 'Garbodor', types: ['poison'], baseStats: {hp: 80, attack: 95, defense: 82, speed: 75}, evolutionStage: 2, generation: 5},
    {id: 570, name: 'Zorua', types: ['dark'], baseStats: {hp: 40, attack: 65, defense: 40, speed: 65}, evolutionStage: 1, generation: 5},
    {id: 571, name: 'Zoroark', types: ['dark'], baseStats: {hp: 60, attack: 105, defense: 60, speed: 105}, evolutionStage: 2, generation: 5},
    {id: 572, name: 'Minccino', types: ['normal'], baseStats: {hp: 55, attack: 50, defense: 40, speed: 75}, evolutionStage: 1, generation: 5},
    {id: 573, name: 'Cinccino', types: ['normal'], baseStats: {hp: 75, attack: 95, defense: 60, speed: 115}, evolutionStage: 2, generation: 5},
    {id: 574, name: 'Gothita', types: ['psychic'], baseStats: {hp: 45, attack: 30, defense: 50, speed: 45}, evolutionStage: 1, generation: 5},
    {id: 575, name: 'Gothorita', types: ['psychic'], baseStats: {hp: 60, attack: 45, defense: 70, speed: 55}, evolutionStage: 2, generation: 5},
    {id: 576, name: 'Gothitelle', types: ['psychic'], baseStats: {hp: 70, attack: 55, defense: 95, speed: 65}, evolutionStage: 3, generation: 5},
    {id: 577, name: 'Solosis', types: ['psychic'], baseStats: {hp: 45, attack: 30, defense: 40, speed: 20}, evolutionStage: 1, generation: 5},
    {id: 578, name: 'Duosion', types: ['psychic'], baseStats: {hp: 65, attack: 40, defense: 50, speed: 30}, evolutionStage: 2, generation: 5},
    {id: 579, name: 'Reuniclus', types: ['psychic'], baseStats: {hp: 110, attack: 65, defense: 75, speed: 30}, evolutionStage: 3, generation: 5},
    {id: 580, name: 'Ducklett', types: ['water', 'flying'], baseStats: {hp: 62, attack: 44, defense: 50, speed: 55}, evolutionStage: 1, generation: 5},
    {id: 581, name: 'Swanna', types: ['water', 'flying'], baseStats: {hp: 75, attack: 87, defense: 63, speed: 98}, evolutionStage: 2, generation: 5},
    {id: 582, name: 'Vanillite', types: ['ice'], baseStats: {hp: 36, attack: 50, defense: 50, speed: 44}, evolutionStage: 1, generation: 5},
    {id: 583, name: 'Vanillish', types: ['ice'], baseStats: {hp: 51, attack: 65, defense: 65, speed: 59}, evolutionStage: 2, generation: 5},
    {id: 584, name: 'Vanilluxe', types: ['ice'], baseStats: {hp: 71, attack: 95, defense: 85, speed: 79}, evolutionStage: 3, generation: 5},
    {id: 585, name: 'Deerling', types: ['normal', 'grass'], baseStats: {hp: 60, attack: 60, defense: 50, speed: 75}, evolutionStage: 1, generation: 5},
    {id: 586, name: 'Sawsbuck', types: ['normal', 'grass'], baseStats: {hp: 80, attack: 100, defense: 70, speed: 95}, evolutionStage: 2, generation: 5},
    {id: 587, name: 'Emolga', types: ['electric', 'flying'], baseStats: {hp: 55, attack: 75, defense: 60, speed: 103}, evolutionStage: 1, generation: 5},
    {id: 588, name: 'Karrablast', types: ['bug'], baseStats: {hp: 50, attack: 75, defense: 45, speed: 60}, evolutionStage: 1, generation: 5},
    {id: 589, name: 'Escavalier', types: ['bug', 'steel'], baseStats: {hp: 70, attack: 135, defense: 105, speed: 20}, evolutionStage: 2, generation: 5},
    {id: 590, name: 'Foongus', types: ['grass', 'poison'], baseStats: {hp: 69, attack: 55, defense: 45, speed: 15}, evolutionStage: 1, generation: 5},
    {id: 591, name: 'Amoonguss', types: ['grass', 'poison'], baseStats: {hp: 114, attack: 85, defense: 70, speed: 30}, evolutionStage: 2, generation: 5},
    {id: 592, name: 'Frillish', types: ['water', 'ghost'], baseStats: {hp: 55, attack: 40, defense: 50, speed: 40}, evolutionStage: 1, generation: 5},
    {id: 593, name: 'Jellicent', types: ['water', 'ghost'], baseStats: {hp: 100, attack: 60, defense: 70, speed: 60}, evolutionStage: 2, generation: 5},
    {id: 594, name: 'Alomomola', types: ['water'], baseStats: {hp: 165, attack: 75, defense: 80, speed: 65}, evolutionStage: 1, generation: 5},
    {id: 595, name: 'Joltik', types: ['bug', 'electric'], baseStats: {hp: 50, attack: 47, defense: 50, speed: 65}, evolutionStage: 1, generation: 5},
    {id: 596, name: 'Galvantula', types: ['bug', 'electric'], baseStats: {hp: 70, attack: 77, defense: 60, speed: 108}, evolutionStage: 2, generation: 5},
    {id: 597, name: 'Ferroseed', types: ['grass', 'steel'], baseStats: {hp: 44, attack: 50, defense: 91, speed: 10}, evolutionStage: 1, generation: 5},
    {id: 598, name: 'Ferrothorn', types: ['grass', 'steel'], baseStats: {hp: 74, attack: 94, defense: 131, speed: 20}, evolutionStage: 2, generation: 5},
    {id: 599, name: 'Klink', types: ['steel'], baseStats: {hp: 40, attack: 55, defense: 70, speed: 30}, evolutionStage: 1, generation: 5},
    {id: 600, name: 'Klang', types: ['steel'], baseStats: {hp: 60, attack: 80, defense: 95, speed: 50}, evolutionStage: 2, generation: 5},
    {id: 601, name: 'Klinklang', types: ['steel'], baseStats: {hp: 60, attack: 100, defense: 115, speed: 90}, evolutionStage: 3, generation: 5},
    {id: 602, name: 'Tynamo', types: ['electric'], baseStats: {hp: 35, attack: 55, defense: 40, speed: 60}, evolutionStage: 1, generation: 5},
    {id: 603, name: 'Eelektrik', types: ['electric'], baseStats: {hp: 65, attack: 85, defense: 70, speed: 40}, evolutionStage: 2, generation: 5},
    {id: 604, name: 'Eelektross', types: ['electric'], baseStats: {hp: 85, attack: 115, defense: 80, speed: 50}, evolutionStage: 3, generation: 5},
    {id: 605, name: 'Elgyem', types: ['psychic'], baseStats: {hp: 55, attack: 55, defense: 55, speed: 30}, evolutionStage: 1, generation: 5},
    {id: 606, name: 'Beheeyem', types: ['psychic'], baseStats: {hp: 75, attack: 75, defense: 75, speed: 40}, evolutionStage: 2, generation: 5},
    {id: 607, name: 'Litwick', types: ['ghost', 'fire'], baseStats: {hp: 50, attack: 30, defense: 55, speed: 20}, evolutionStage: 1, generation: 5},
    {id: 608, name: 'Lampent', types: ['ghost', 'fire'], baseStats: {hp: 60, attack: 40, defense: 60, speed: 55}, evolutionStage: 2, generation: 5},
    {id: 609, name: 'Chandelure', types: ['ghost', 'fire'], baseStats: {hp: 60, attack: 55, defense: 90, speed: 80}, evolutionStage: 3, generation: 5},
    {id: 610, name: 'Axew', types: ['dragon'], baseStats: {hp: 46, attack: 87, defense: 60, speed: 57}, evolutionStage: 1, generation: 5},
    {id: 611, name: 'Fraxure', types: ['dragon'], baseStats: {hp: 66, attack: 117, defense: 70, speed: 67}, evolutionStage: 2, generation: 5},
    {id: 612, name: 'Haxorus', types: ['dragon'], baseStats: {hp: 76, attack: 147, defense: 90, speed: 97}, evolutionStage: 3, generation: 5},
    {id: 613, name: 'Cubchoo', types: ['ice'], baseStats: {hp: 55, attack: 70, defense: 40, speed: 40}, evolutionStage: 1, generation: 5},
    {id: 614, name: 'Beartic', types: ['ice'], baseStats: {hp: 95, attack: 130, defense: 80, speed: 50}, evolutionStage: 2, generation: 5},
    {id: 615, name: 'Cryogonal', types: ['ice'], baseStats: {hp: 80, attack: 50, defense: 50, speed: 105}, evolutionStage: 1, generation: 5},
    {id: 616, name: 'Shelmet', types: ['bug'], baseStats: {hp: 50, attack: 40, defense: 85, speed: 25}, evolutionStage: 1, generation: 5},
    {id: 617, name: 'Accelgor', types: ['bug'], baseStats: {hp: 80, attack: 70, defense: 40, speed: 145}, evolutionStage: 2, generation: 5},
    {id: 618, name: 'Stunfisk', types: ['ground', 'electric'], baseStats: {hp: 109, attack: 66, defense: 84, speed: 32}, evolutionStage: 1, generation: 5},
    {id: 619, name: 'Mienfoo', types: ['fighting'], baseStats: {hp: 45, attack: 85, defense: 50, speed: 65}, evolutionStage: 1, generation: 5},
    {id: 620, name: 'Mienshao', types: ['fighting'], baseStats: {hp: 65, attack: 125, defense: 60, speed: 105}, evolutionStage: 2, generation: 5},
    {id: 621, name: 'Druddigon', types: ['dragon'], baseStats: {hp: 77, attack: 120, defense: 90, speed: 48}, evolutionStage: 1, generation: 5},
    {id: 622, name: 'Golett', types: ['ground', 'ghost'], baseStats: {hp: 59, attack: 74, defense: 50, speed: 35}, evolutionStage: 1, generation: 5},
    {id: 623, name: 'Golurk', types: ['ground', 'ghost'], baseStats: {hp: 89, attack: 124, defense: 80, speed: 55}, evolutionStage: 2, generation: 5},
    {id: 624, name: 'Pawniard', types: ['dark', 'steel'], baseStats: {hp: 45, attack: 85, defense: 70, speed: 60}, evolutionStage: 1, generation: 5},
    {id: 625, name: 'Bisharp', types: ['dark', 'steel'], baseStats: {hp: 65, attack: 125, defense: 100, speed: 70}, evolutionStage: 2, generation: 5},
    {id: 626, name: 'Bouffalant', types: ['normal'], baseStats: {hp: 95, attack: 110, defense: 95, speed: 55}, evolutionStage: 1, generation: 5},
    {id: 627, name: 'Rufflet', types: ['normal', 'flying'], baseStats: {hp: 70, attack: 83, defense: 50, speed: 60}, evolutionStage: 1, generation: 5},
    {id: 628, name: 'Braviary', types: ['normal', 'flying'], baseStats: {hp: 100, attack: 123, defense: 75, speed: 80}, evolutionStage: 2, generation: 5},
    {id: 629, name: 'Vullaby', types: ['dark', 'flying'], baseStats: {hp: 70, attack: 55, defense: 75, speed: 60}, evolutionStage: 1, generation: 5},
    {id: 630, name: 'Mandibuzz', types: ['dark', 'flying'], baseStats: {hp: 110, attack: 65, defense: 105, speed: 80}, evolutionStage: 2, generation: 5},
    {id: 631, name: 'Heatmor', types: ['fire'], baseStats: {hp: 85, attack: 97, defense: 66, speed: 65}, evolutionStage: 1, generation: 5},
    {id: 632, name: 'Durant', types: ['bug', 'steel'], baseStats: {hp: 58, attack: 109, defense: 112, speed: 109}, evolutionStage: 1, generation: 5},
    {id: 633, name: 'Deino', types: ['dark', 'dragon'], baseStats: {hp: 52, attack: 65, defense: 50, speed: 38}, evolutionStage: 1, generation: 5},
    {id: 634, name: 'Zweilous', types: ['dark', 'dragon'], baseStats: {hp: 72, attack: 85, defense: 70, speed: 58}, evolutionStage: 2, generation: 5},
    {id: 635, name: 'Hydreigon', types: ['dark', 'dragon'], baseStats: {hp: 92, attack: 105, defense: 90, speed: 98}, evolutionStage: 3, generation: 5},
    {id: 636, name: 'Larvesta', types: ['bug', 'fire'], baseStats: {hp: 55, attack: 85, defense: 55, speed: 60}, evolutionStage: 1, generation: 5},
    {id: 637, name: 'Volcarona', types: ['bug', 'fire'], baseStats: {hp: 85, attack: 60, defense: 65, speed: 100}, evolutionStage: 2, generation: 5},
    {id: 638, name: 'Cobalion', types: ['steel', 'fighting'], baseStats: {hp: 91, attack: 90, defense: 129, speed: 108}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 639, name: 'Terrakion', types: ['rock', 'fighting'], baseStats: {hp: 91, attack: 129, defense: 90, speed: 108}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 640, name: 'Virizion', types: ['grass', 'fighting'], baseStats: {hp: 91, attack: 90, defense: 72, speed: 108}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 641, name: 'Tornadus', types: ['flying'], baseStats: {hp: 79, attack: 115, defense: 70, speed: 111}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 642, name: 'Thundurus', types: ['electric', 'flying'], baseStats: {hp: 79, attack: 115, defense: 70, speed: 111}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 643, name: 'Reshiram', types: ['dragon', 'fire'], baseStats: {hp: 100, attack: 120, defense: 100, speed: 90}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 644, name: 'Zekrom', types: ['dragon', 'electric'], baseStats: {hp: 100, attack: 150, defense: 120, speed: 90}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 645, name: 'Landorus', types: ['ground', 'flying'], baseStats: {hp: 89, attack: 125, defense: 90, speed: 101}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 646, name: 'Kyurem', types: ['dragon', 'ice'], baseStats: {hp: 125, attack: 130, defense: 90, speed: 95}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 647, name: 'Keldeo', types: ['water', 'fighting'], baseStats: {hp: 91, attack: 72, defense: 90, speed: 108}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 648, name: 'Meloetta', types: ['normal', 'psychic'], baseStats: {hp: 100, attack: 77, defense: 77, speed: 90}, evolutionStage: 1, generation: 5, isLegendary: true},
    {id: 649, name: 'Genesect', types: ['bug', 'steel'], baseStats: {hp: 71, attack: 120, defense: 95, speed: 99}, evolutionStage: 1, generation: 5, isLegendary: true},
    // ── GEN 6: KALOS ──
    {id: 650, name: 'Chespin', types: ['grass'], baseStats: {hp: 56, attack: 61, defense: 65, speed: 38}, evolutionStage: 1, generation: 6},
    {id: 651, name: 'Quilladin', types: ['grass'], baseStats: {hp: 61, attack: 78, defense: 95, speed: 57}, evolutionStage: 2, generation: 6},
    {id: 652, name: 'Chesnaught', types: ['grass', 'fighting'], baseStats: {hp: 88, attack: 107, defense: 122, speed: 64}, evolutionStage: 3, generation: 6},
    {id: 653, name: 'Fennekin', types: ['fire'], baseStats: {hp: 40, attack: 45, defense: 40, speed: 60}, evolutionStage: 1, generation: 6},
    {id: 654, name: 'Braixen', types: ['fire'], baseStats: {hp: 59, attack: 59, defense: 58, speed: 73}, evolutionStage: 2, generation: 6},
    {id: 655, name: 'Delphox', types: ['fire', 'psychic'], baseStats: {hp: 75, attack: 69, defense: 72, speed: 104}, evolutionStage: 3, generation: 6},
    {id: 656, name: 'Froakie', types: ['water'], baseStats: {hp: 41, attack: 56, defense: 40, speed: 71}, evolutionStage: 1, generation: 6},
    {id: 657, name: 'Frogadier', types: ['water'], baseStats: {hp: 54, attack: 63, defense: 52, speed: 97}, evolutionStage: 2, generation: 6},
    {id: 658, name: 'Greninja', types: ['water', 'dark'], baseStats: {hp: 72, attack: 95, defense: 67, speed: 122}, evolutionStage: 3, generation: 6},
    {id: 659, name: 'Bunnelby', types: ['normal'], baseStats: {hp: 38, attack: 36, defense: 38, speed: 57}, evolutionStage: 1, generation: 6},
    {id: 660, name: 'Diggersby', types: ['normal', 'ground'], baseStats: {hp: 85, attack: 56, defense: 77, speed: 78}, evolutionStage: 2, generation: 6},
    {id: 661, name: 'Fletchling', types: ['normal', 'flying'], baseStats: {hp: 45, attack: 50, defense: 43, speed: 62}, evolutionStage: 1, generation: 6},
    {id: 662, name: 'Fletchinder', types: ['fire', 'flying'], baseStats: {hp: 62, attack: 73, defense: 55, speed: 84}, evolutionStage: 2, generation: 6},
    {id: 663, name: 'Talonflame', types: ['fire', 'flying'], baseStats: {hp: 78, attack: 81, defense: 71, speed: 126}, evolutionStage: 3, generation: 6},
    {id: 664, name: 'Scatterbug', types: ['bug'], baseStats: {hp: 38, attack: 35, defense: 40, speed: 35}, evolutionStage: 1, generation: 6},
    {id: 665, name: 'Spewpa', types: ['bug'], baseStats: {hp: 45, attack: 22, defense: 60, speed: 29}, evolutionStage: 2, generation: 6},
    {id: 666, name: 'Vivillon', types: ['bug', 'flying'], baseStats: {hp: 80, attack: 52, defense: 50, speed: 89}, evolutionStage: 3, generation: 6},
    {id: 667, name: 'Litleo', types: ['fire', 'normal'], baseStats: {hp: 62, attack: 50, defense: 58, speed: 72}, evolutionStage: 1, generation: 6},
    {id: 668, name: 'Pyroar', types: ['fire', 'normal'], baseStats: {hp: 86, attack: 68, defense: 72, speed: 106}, evolutionStage: 2, generation: 6},
    {id: 669, name: 'Flabébé', types: ['fairy'], baseStats: {hp: 44, attack: 38, defense: 39, speed: 42}, evolutionStage: 1, generation: 6},
    {id: 670, name: 'Floette', types: ['fairy'], baseStats: {hp: 54, attack: 45, defense: 47, speed: 52}, evolutionStage: 2, generation: 6},
    {id: 671, name: 'Florges', types: ['fairy'], baseStats: {hp: 78, attack: 65, defense: 68, speed: 75}, evolutionStage: 3, generation: 6},
    {id: 672, name: 'Skiddo', types: ['grass'], baseStats: {hp: 66, attack: 65, defense: 48, speed: 52}, evolutionStage: 1, generation: 6},
    {id: 673, name: 'Gogoat', types: ['grass'], baseStats: {hp: 123, attack: 100, defense: 62, speed: 68}, evolutionStage: 2, generation: 6},
    {id: 674, name: 'Pancham', types: ['fighting'], baseStats: {hp: 67, attack: 82, defense: 62, speed: 43}, evolutionStage: 1, generation: 6},
    {id: 675, name: 'Pangoro', types: ['fighting', 'dark'], baseStats: {hp: 95, attack: 124, defense: 78, speed: 58}, evolutionStage: 2, generation: 6},
    {id: 676, name: 'Furfrou', types: ['normal'], baseStats: {hp: 75, attack: 80, defense: 60, speed: 102}, evolutionStage: 1, generation: 6},
    {id: 677, name: 'Espurr', types: ['psychic'], baseStats: {hp: 62, attack: 48, defense: 54, speed: 68}, evolutionStage: 1, generation: 6},
    {id: 678, name: 'Meowstic', types: ['psychic'], baseStats: {hp: 74, attack: 48, defense: 76, speed: 104}, evolutionStage: 2, generation: 6},
    {id: 679, name: 'Honedge', types: ['steel', 'ghost'], baseStats: {hp: 45, attack: 80, defense: 100, speed: 28}, evolutionStage: 1, generation: 6},
    {id: 680, name: 'Doublade', types: ['steel', 'ghost'], baseStats: {hp: 59, attack: 110, defense: 150, speed: 35}, evolutionStage: 2, generation: 6},
    {id: 681, name: 'Aegislash', types: ['steel', 'ghost'], baseStats: {hp: 60, attack: 50, defense: 140, speed: 60}, evolutionStage: 3, generation: 6},
    {id: 682, name: 'Spritzee', types: ['fairy'], baseStats: {hp: 78, attack: 52, defense: 60, speed: 23}, evolutionStage: 1, generation: 6},
    {id: 683, name: 'Aromatisse', types: ['fairy'], baseStats: {hp: 101, attack: 72, defense: 72, speed: 29}, evolutionStage: 2, generation: 6},
    {id: 684, name: 'Swirlix', types: ['fairy'], baseStats: {hp: 62, attack: 48, defense: 66, speed: 49}, evolutionStage: 1, generation: 6},
    {id: 685, name: 'Slurpuff', types: ['fairy'], baseStats: {hp: 82, attack: 80, defense: 86, speed: 72}, evolutionStage: 2, generation: 6},
    {id: 686, name: 'Inkay', types: ['dark', 'psychic'], baseStats: {hp: 53, attack: 54, defense: 53, speed: 45}, evolutionStage: 1, generation: 6},
    {id: 687, name: 'Malamar', types: ['dark', 'psychic'], baseStats: {hp: 86, attack: 92, defense: 88, speed: 73}, evolutionStage: 2, generation: 6},
    {id: 688, name: 'Binacle', types: ['rock', 'water'], baseStats: {hp: 42, attack: 52, defense: 67, speed: 50}, evolutionStage: 1, generation: 6},
    {id: 689, name: 'Barbaracle', types: ['rock', 'water'], baseStats: {hp: 72, attack: 105, defense: 115, speed: 68}, evolutionStage: 2, generation: 6},
    {id: 690, name: 'Skrelp', types: ['poison', 'water'], baseStats: {hp: 50, attack: 60, defense: 60, speed: 30}, evolutionStage: 1, generation: 6},
    {id: 691, name: 'Dragalge', types: ['poison', 'dragon'], baseStats: {hp: 65, attack: 75, defense: 90, speed: 44}, evolutionStage: 2, generation: 6},
    {id: 692, name: 'Clauncher', types: ['water'], baseStats: {hp: 50, attack: 53, defense: 62, speed: 44}, evolutionStage: 1, generation: 6},
    {id: 693, name: 'Clawitzer', types: ['water'], baseStats: {hp: 71, attack: 73, defense: 88, speed: 59}, evolutionStage: 2, generation: 6},
    {id: 694, name: 'Helioptile', types: ['electric', 'normal'], baseStats: {hp: 44, attack: 38, defense: 33, speed: 70}, evolutionStage: 1, generation: 6},
    {id: 695, name: 'Heliolisk', types: ['electric', 'normal'], baseStats: {hp: 62, attack: 55, defense: 52, speed: 109}, evolutionStage: 2, generation: 6},
    {id: 696, name: 'Tyrunt', types: ['rock', 'dragon'], baseStats: {hp: 58, attack: 89, defense: 77, speed: 48}, evolutionStage: 1, generation: 6},
    {id: 697, name: 'Tyrantrum', types: ['rock', 'dragon'], baseStats: {hp: 82, attack: 121, defense: 119, speed: 71}, evolutionStage: 2, generation: 6},
    {id: 698, name: 'Amaura', types: ['rock', 'ice'], baseStats: {hp: 77, attack: 59, defense: 50, speed: 46}, evolutionStage: 1, generation: 6},
    {id: 699, name: 'Aurorus', types: ['rock', 'ice'], baseStats: {hp: 123, attack: 77, defense: 72, speed: 58}, evolutionStage: 2, generation: 6},
    {id: 700, name: 'Sylveon', types: ['fairy'], baseStats: {hp: 95, attack: 65, defense: 65, speed: 60}, evolutionStage: 2, generation: 6},
    {id: 701, name: 'Hawlucha', types: ['fighting', 'flying'], baseStats: {hp: 78, attack: 92, defense: 75, speed: 118}, evolutionStage: 1, generation: 6},
    {id: 702, name: 'Dedenne', types: ['electric', 'fairy'], baseStats: {hp: 67, attack: 58, defense: 57, speed: 101}, evolutionStage: 1, generation: 6},
    {id: 703, name: 'Carbink', types: ['rock', 'fairy'], baseStats: {hp: 50, attack: 50, defense: 150, speed: 50}, evolutionStage: 1, generation: 6},
    {id: 704, name: 'Goomy', types: ['dragon'], baseStats: {hp: 45, attack: 50, defense: 35, speed: 40}, evolutionStage: 1, generation: 6},
    {id: 705, name: 'Sliggoo', types: ['dragon'], baseStats: {hp: 68, attack: 75, defense: 53, speed: 60}, evolutionStage: 2, generation: 6},
    {id: 706, name: 'Goodra', types: ['dragon'], baseStats: {hp: 90, attack: 100, defense: 70, speed: 80}, evolutionStage: 3, generation: 6},
    {id: 707, name: 'Klefki', types: ['steel', 'fairy'], baseStats: {hp: 57, attack: 80, defense: 91, speed: 75}, evolutionStage: 1, generation: 6},
    {id: 708, name: 'Phantump', types: ['ghost', 'grass'], baseStats: {hp: 43, attack: 70, defense: 48, speed: 38}, evolutionStage: 1, generation: 6},
    {id: 709, name: 'Trevenant', types: ['ghost', 'grass'], baseStats: {hp: 85, attack: 110, defense: 76, speed: 56}, evolutionStage: 2, generation: 6},
    {id: 710, name: 'Pumpkaboo', types: ['ghost', 'grass'], baseStats: {hp: 49, attack: 66, defense: 70, speed: 51}, evolutionStage: 1, generation: 6},
    {id: 711, name: 'Gourgeist', types: ['ghost', 'grass'], baseStats: {hp: 65, attack: 90, defense: 122, speed: 84}, evolutionStage: 2, generation: 6},
    {id: 712, name: 'Bergmite', types: ['ice'], baseStats: {hp: 55, attack: 69, defense: 85, speed: 28}, evolutionStage: 1, generation: 6},
    {id: 713, name: 'Avalugg', types: ['ice'], baseStats: {hp: 95, attack: 117, defense: 184, speed: 28}, evolutionStage: 2, generation: 6},
    {id: 714, name: 'Noibat', types: ['flying', 'dragon'], baseStats: {hp: 40, attack: 30, defense: 35, speed: 55}, evolutionStage: 1, generation: 6},
    {id: 715, name: 'Noivern', types: ['flying', 'dragon'], baseStats: {hp: 85, attack: 70, defense: 80, speed: 123}, evolutionStage: 2, generation: 6},
    {id: 716, name: 'Xerneas', types: ['fairy'], baseStats: {hp: 126, attack: 131, defense: 95, speed: 99}, evolutionStage: 1, generation: 6, isLegendary: true},
    {id: 717, name: 'Yveltal', types: ['dark', 'flying'], baseStats: {hp: 126, attack: 131, defense: 95, speed: 99}, evolutionStage: 1, generation: 6, isLegendary: true},
    {id: 718, name: 'Zygarde', types: ['dragon', 'ground'], baseStats: {hp: 108, attack: 100, defense: 121, speed: 95}, evolutionStage: 1, generation: 6, isLegendary: true},
    {id: 719, name: 'Diancie', types: ['rock', 'fairy'], baseStats: {hp: 50, attack: 100, defense: 150, speed: 50}, evolutionStage: 1, generation: 6, isLegendary: true},
    {id: 720, name: 'Hoopa', types: ['psychic', 'ghost'], baseStats: {hp: 80, attack: 110, defense: 60, speed: 70}, evolutionStage: 1, generation: 6, isLegendary: true},
    {id: 721, name: 'Volcanion', types: ['fire', 'water'], baseStats: {hp: 80, attack: 110, defense: 120, speed: 70}, evolutionStage: 1, generation: 6, isLegendary: true},
    // ── GEN 7: ALOLA ──
    {id: 722, name: 'Rowlet', types: ['grass', 'flying'], baseStats: {hp: 68, attack: 55, defense: 55, speed: 42}, evolutionStage: 1, generation: 7},
    {id: 723, name: 'Dartrix', types: ['grass', 'flying'], baseStats: {hp: 78, attack: 75, defense: 75, speed: 52}, evolutionStage: 2, generation: 7},
    {id: 724, name: 'Decidueye', types: ['grass', 'ghost'], baseStats: {hp: 78, attack: 107, defense: 75, speed: 70}, evolutionStage: 3, generation: 7},
    {id: 725, name: 'Litten', types: ['fire'], baseStats: {hp: 45, attack: 65, defense: 40, speed: 70}, evolutionStage: 1, generation: 7},
    {id: 726, name: 'Torracat', types: ['fire'], baseStats: {hp: 65, attack: 85, defense: 50, speed: 90}, evolutionStage: 2, generation: 7},
    {id: 727, name: 'Incineroar', types: ['fire', 'dark'], baseStats: {hp: 95, attack: 115, defense: 90, speed: 60}, evolutionStage: 3, generation: 7},
    {id: 728, name: 'Popplio', types: ['water'], baseStats: {hp: 50, attack: 54, defense: 54, speed: 40}, evolutionStage: 1, generation: 7},
    {id: 729, name: 'Brionne', types: ['water'], baseStats: {hp: 60, attack: 69, defense: 69, speed: 50}, evolutionStage: 2, generation: 7},
    {id: 730, name: 'Primarina', types: ['water', 'fairy'], baseStats: {hp: 80, attack: 74, defense: 74, speed: 60}, evolutionStage: 3, generation: 7},
    {id: 731, name: 'Pikipek', types: ['normal', 'flying'], baseStats: {hp: 35, attack: 75, defense: 30, speed: 65}, evolutionStage: 1, generation: 7},
    {id: 732, name: 'Trumbeak', types: ['normal', 'flying'], baseStats: {hp: 55, attack: 85, defense: 50, speed: 75}, evolutionStage: 2, generation: 7},
    {id: 733, name: 'Toucannon', types: ['normal', 'flying'], baseStats: {hp: 80, attack: 120, defense: 75, speed: 60}, evolutionStage: 3, generation: 7},
    {id: 734, name: 'Yungoos', types: ['normal'], baseStats: {hp: 48, attack: 70, defense: 30, speed: 45}, evolutionStage: 1, generation: 7},
    {id: 735, name: 'Gumshoos', types: ['normal'], baseStats: {hp: 88, attack: 110, defense: 60, speed: 45}, evolutionStage: 2, generation: 7},
    {id: 736, name: 'Grubbin', types: ['bug'], baseStats: {hp: 47, attack: 62, defense: 45, speed: 46}, evolutionStage: 1, generation: 7},
    {id: 737, name: 'Charjabug', types: ['bug', 'electric'], baseStats: {hp: 57, attack: 82, defense: 95, speed: 36}, evolutionStage: 2, generation: 7},
    {id: 738, name: 'Vikavolt', types: ['bug', 'electric'], baseStats: {hp: 77, attack: 70, defense: 90, speed: 43}, evolutionStage: 3, generation: 7},
    {id: 739, name: 'Crabrawler', types: ['fighting'], baseStats: {hp: 47, attack: 82, defense: 57, speed: 63}, evolutionStage: 1, generation: 7},
    {id: 740, name: 'Crabominable', types: ['fighting', 'ice'], baseStats: {hp: 97, attack: 132, defense: 77, speed: 43}, evolutionStage: 2, generation: 7},
    {id: 741, name: 'Oricorio', types: ['fire', 'flying'], baseStats: {hp: 75, attack: 70, defense: 70, speed: 93}, evolutionStage: 1, generation: 7},
    {id: 742, name: 'Cutiefly', types: ['bug', 'fairy'], baseStats: {hp: 40, attack: 45, defense: 40, speed: 84}, evolutionStage: 1, generation: 7},
    {id: 743, name: 'Ribombee', types: ['bug', 'fairy'], baseStats: {hp: 60, attack: 55, defense: 60, speed: 124}, evolutionStage: 2, generation: 7},
    {id: 744, name: 'Rockruff', types: ['rock'], baseStats: {hp: 45, attack: 65, defense: 40, speed: 60}, evolutionStage: 1, generation: 7},
    {id: 745, name: 'Lycanroc', types: ['rock'], baseStats: {hp: 75, attack: 115, defense: 65, speed: 112}, evolutionStage: 2, generation: 7},
    {id: 746, name: 'Wishiwashi', types: ['water'], baseStats: {hp: 45, attack: 20, defense: 20, speed: 40}, evolutionStage: 1, generation: 7},
    {id: 747, name: 'Mareanie', types: ['poison', 'water'], baseStats: {hp: 50, attack: 53, defense: 62, speed: 45}, evolutionStage: 1, generation: 7},
    {id: 748, name: 'Toxapex', types: ['poison', 'water'], baseStats: {hp: 50, attack: 63, defense: 152, speed: 35}, evolutionStage: 2, generation: 7},
    {id: 749, name: 'Mudbray', types: ['ground'], baseStats: {hp: 70, attack: 100, defense: 70, speed: 45}, evolutionStage: 1, generation: 7},
    {id: 750, name: 'Mudsdale', types: ['ground'], baseStats: {hp: 100, attack: 125, defense: 100, speed: 35}, evolutionStage: 2, generation: 7},
    {id: 751, name: 'Dewpider', types: ['water', 'bug'], baseStats: {hp: 38, attack: 40, defense: 52, speed: 27}, evolutionStage: 1, generation: 7},
    {id: 752, name: 'Araquanid', types: ['water', 'bug'], baseStats: {hp: 68, attack: 70, defense: 92, speed: 42}, evolutionStage: 2, generation: 7},
    {id: 753, name: 'Fomantis', types: ['grass'], baseStats: {hp: 40, attack: 55, defense: 35, speed: 35}, evolutionStage: 1, generation: 7},
    {id: 754, name: 'Lurantis', types: ['grass'], baseStats: {hp: 70, attack: 105, defense: 90, speed: 45}, evolutionStage: 2, generation: 7},
    {id: 755, name: 'Morelull', types: ['grass', 'fairy'], baseStats: {hp: 40, attack: 35, defense: 55, speed: 15}, evolutionStage: 1, generation: 7},
    {id: 756, name: 'Shiinotic', types: ['grass', 'fairy'], baseStats: {hp: 60, attack: 45, defense: 80, speed: 30}, evolutionStage: 2, generation: 7},
    {id: 757, name: 'Salandit', types: ['poison', 'fire'], baseStats: {hp: 48, attack: 44, defense: 40, speed: 77}, evolutionStage: 1, generation: 7},
    {id: 758, name: 'Salazzle', types: ['poison', 'fire'], baseStats: {hp: 68, attack: 64, defense: 60, speed: 117}, evolutionStage: 2, generation: 7},
    {id: 759, name: 'Stufful', types: ['normal', 'fighting'], baseStats: {hp: 70, attack: 75, defense: 50, speed: 50}, evolutionStage: 1, generation: 7},
    {id: 760, name: 'Bewear', types: ['normal', 'fighting'], baseStats: {hp: 120, attack: 125, defense: 80, speed: 60}, evolutionStage: 2, generation: 7},
    {id: 761, name: 'Bounsweet', types: ['grass'], baseStats: {hp: 42, attack: 30, defense: 38, speed: 32}, evolutionStage: 1, generation: 7},
    {id: 762, name: 'Steenee', types: ['grass'], baseStats: {hp: 52, attack: 40, defense: 48, speed: 62}, evolutionStage: 2, generation: 7},
    {id: 763, name: 'Tsareena', types: ['grass'], baseStats: {hp: 72, attack: 120, defense: 98, speed: 72}, evolutionStage: 3, generation: 7},
    {id: 764, name: 'Comfey', types: ['fairy'], baseStats: {hp: 51, attack: 52, defense: 90, speed: 100}, evolutionStage: 1, generation: 7},
    {id: 765, name: 'Oranguru', types: ['normal', 'psychic'], baseStats: {hp: 90, attack: 60, defense: 80, speed: 60}, evolutionStage: 1, generation: 7},
    {id: 766, name: 'Passimian', types: ['fighting'], baseStats: {hp: 100, attack: 120, defense: 90, speed: 80}, evolutionStage: 1, generation: 7},
    {id: 767, name: 'Wimpod', types: ['bug', 'water'], baseStats: {hp: 25, attack: 35, defense: 40, speed: 80}, evolutionStage: 1, generation: 7},
    {id: 768, name: 'Golisopod', types: ['bug', 'water'], baseStats: {hp: 75, attack: 125, defense: 140, speed: 40}, evolutionStage: 2, generation: 7},
    {id: 769, name: 'Sandygast', types: ['ghost', 'ground'], baseStats: {hp: 55, attack: 55, defense: 80, speed: 15}, evolutionStage: 1, generation: 7},
    {id: 770, name: 'Palossand', types: ['ghost', 'ground'], baseStats: {hp: 85, attack: 75, defense: 110, speed: 35}, evolutionStage: 2, generation: 7},
    {id: 771, name: 'Pyukumuku', types: ['water'], baseStats: {hp: 55, attack: 60, defense: 130, speed: 5}, evolutionStage: 1, generation: 7},
    {id: 772, name: 'Type: Null', types: ['normal'], baseStats: {hp: 95, attack: 95, defense: 95, speed: 59}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 773, name: 'Silvally', types: ['normal'], baseStats: {hp: 95, attack: 95, defense: 95, speed: 95}, evolutionStage: 2, generation: 7, isLegendary: true},
    {id: 774, name: 'Minior', types: ['rock', 'flying'], baseStats: {hp: 60, attack: 60, defense: 100, speed: 60}, evolutionStage: 1, generation: 7},
    {id: 775, name: 'Komala', types: ['normal'], baseStats: {hp: 65, attack: 115, defense: 65, speed: 65}, evolutionStage: 1, generation: 7},
    {id: 776, name: 'Turtonator', types: ['fire', 'dragon'], baseStats: {hp: 60, attack: 78, defense: 135, speed: 36}, evolutionStage: 1, generation: 7},
    {id: 777, name: 'Togedemaru', types: ['electric', 'steel'], baseStats: {hp: 65, attack: 98, defense: 63, speed: 96}, evolutionStage: 1, generation: 7},
    {id: 778, name: 'Mimikyu', types: ['ghost', 'fairy'], baseStats: {hp: 55, attack: 90, defense: 80, speed: 96}, evolutionStage: 1, generation: 7},
    {id: 779, name: 'Bruxish', types: ['water', 'psychic'], baseStats: {hp: 68, attack: 105, defense: 70, speed: 92}, evolutionStage: 1, generation: 7},
    {id: 780, name: 'Drampa', types: ['normal', 'dragon'], baseStats: {hp: 78, attack: 60, defense: 85, speed: 36}, evolutionStage: 1, generation: 7},
    {id: 781, name: 'Dhelmise', types: ['ghost', 'grass'], baseStats: {hp: 70, attack: 131, defense: 100, speed: 40}, evolutionStage: 1, generation: 7},
    {id: 782, name: 'Jangmo-o', types: ['dragon'], baseStats: {hp: 45, attack: 55, defense: 65, speed: 45}, evolutionStage: 1, generation: 7},
    {id: 783, name: 'Hakamo-o', types: ['dragon', 'fighting'], baseStats: {hp: 55, attack: 75, defense: 90, speed: 65}, evolutionStage: 2, generation: 7},
    {id: 784, name: 'Kommo-o', types: ['dragon', 'fighting'], baseStats: {hp: 75, attack: 110, defense: 125, speed: 85}, evolutionStage: 3, generation: 7},
    {id: 785, name: 'Tapu Koko', types: ['electric', 'fairy'], baseStats: {hp: 70, attack: 115, defense: 85, speed: 130}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 786, name: 'Tapu Lele', types: ['psychic', 'fairy'], baseStats: {hp: 70, attack: 85, defense: 75, speed: 95}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 787, name: 'Tapu Bulu', types: ['grass', 'fairy'], baseStats: {hp: 70, attack: 130, defense: 115, speed: 75}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 788, name: 'Tapu Fini', types: ['water', 'fairy'], baseStats: {hp: 70, attack: 75, defense: 115, speed: 85}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 789, name: 'Cosmog', types: ['psychic'], baseStats: {hp: 43, attack: 29, defense: 31, speed: 37}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 790, name: 'Cosmoem', types: ['psychic'], baseStats: {hp: 43, attack: 29, defense: 131, speed: 37}, evolutionStage: 2, generation: 7, isLegendary: true},
    {id: 791, name: 'Solgaleo', types: ['psychic', 'steel'], baseStats: {hp: 137, attack: 137, defense: 107, speed: 97}, evolutionStage: 3, generation: 7, isLegendary: true},
    {id: 792, name: 'Lunala', types: ['psychic', 'ghost'], baseStats: {hp: 137, attack: 113, defense: 89, speed: 97}, evolutionStage: 3, generation: 7, isLegendary: true},
    // ── Ultra Beasts (UB-01 to UB-05 and the Ultra Sun/Moon additions).
    //    Flagged legendary: they are one-per-game encounters with legendary
    //    stat totals, so treating them as ordinary spawns would have put the
    //    game's rarest creatures in the common pool. ──
    {id: 793, name: 'Nihilego', types: ['rock', 'poison'], baseStats: {hp: 109, attack: 53, defense: 47, speed: 103}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 794, name: 'Buzzwole', types: ['bug', 'fighting'], baseStats: {hp: 107, attack: 139, defense: 139, speed: 79}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 795, name: 'Pheromosa', types: ['bug', 'fighting'], baseStats: {hp: 71, attack: 137, defense: 37, speed: 151}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 796, name: 'Xurkitree', types: ['electric'], baseStats: {hp: 83, attack: 89, defense: 71, speed: 83}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 797, name: 'Celesteela', types: ['steel', 'flying'], baseStats: {hp: 97, attack: 101, defense: 103, speed: 61}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 798, name: 'Kartana', types: ['grass', 'steel'], baseStats: {hp: 59, attack: 181, defense: 131, speed: 109}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 799, name: 'Guzzlord', types: ['dark', 'dragon'], baseStats: {hp: 223, attack: 101, defense: 53, speed: 43}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 800, name: 'Necrozma', types: ['psychic'], baseStats: {hp: 97, attack: 107, defense: 101, speed: 79}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 801, name: 'Magearna', types: ['steel', 'fairy'], baseStats: {hp: 80, attack: 95, defense: 115, speed: 65}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 802, name: 'Marshadow', types: ['fighting', 'ghost'], baseStats: {hp: 90, attack: 125, defense: 80, speed: 125}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 803, name: 'Poipole', types: ['poison'], baseStats: {hp: 67, attack: 73, defense: 67, speed: 73}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 804, name: 'Naganadel', types: ['poison', 'dragon'], baseStats: {hp: 73, attack: 73, defense: 73, speed: 121}, evolutionStage: 2, generation: 7, isLegendary: true},
    {id: 805, name: 'Stakataka', types: ['rock', 'steel'], baseStats: {hp: 61, attack: 131, defense: 211, speed: 13}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 806, name: 'Blacephalon', types: ['fire', 'ghost'], baseStats: {hp: 53, attack: 127, defense: 53, speed: 107}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 807, name: 'Zeraora', types: ['electric'], baseStats: {hp: 88, attack: 112, defense: 75, speed: 143}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 808, name: 'Meltan', types: ['steel'], baseStats: {hp: 46, attack: 65, defense: 65, speed: 34}, evolutionStage: 1, generation: 7, isLegendary: true},
    {id: 809, name: 'Melmetal', types: ['steel'], baseStats: {hp: 135, attack: 143, defense: 143, speed: 34}, evolutionStage: 2, generation: 7, isLegendary: true},
    // ── GEN 8: GALAR/HISUI ──
    {id: 810, name: 'Grookey', types: ['grass'], baseStats: {hp: 50, attack: 65, defense: 50, speed: 65}, evolutionStage: 1, generation: 8},
    {id: 811, name: 'Thwackey', types: ['grass'], baseStats: {hp: 70, attack: 85, defense: 70, speed: 80}, evolutionStage: 2, generation: 8},
    {id: 812, name: 'Rillaboom', types: ['grass'], baseStats: {hp: 100, attack: 125, defense: 90, speed: 85}, evolutionStage: 3, generation: 8},
    {id: 813, name: 'Scorbunny', types: ['fire'], baseStats: {hp: 50, attack: 71, defense: 40, speed: 69}, evolutionStage: 1, generation: 8},
    {id: 814, name: 'Raboot', types: ['fire'], baseStats: {hp: 65, attack: 86, defense: 60, speed: 94}, evolutionStage: 2, generation: 8},
    {id: 815, name: 'Cinderace', types: ['fire'], baseStats: {hp: 80, attack: 116, defense: 75, speed: 119}, evolutionStage: 3, generation: 8},
    {id: 816, name: 'Sobble', types: ['water'], baseStats: {hp: 50, attack: 40, defense: 40, speed: 70}, evolutionStage: 1, generation: 8},
    {id: 817, name: 'Drizzile', types: ['water'], baseStats: {hp: 65, attack: 60, defense: 55, speed: 90}, evolutionStage: 2, generation: 8},
    {id: 818, name: 'Inteleon', types: ['water'], baseStats: {hp: 70, attack: 85, defense: 65, speed: 120}, evolutionStage: 3, generation: 8},
    {id: 819, name: 'Skwovet', types: ['normal'], baseStats: {hp: 70, attack: 55, defense: 55, speed: 25}, evolutionStage: 1, generation: 8},
    {id: 820, name: 'Greedent', types: ['normal'], baseStats: {hp: 120, attack: 95, defense: 95, speed: 20}, evolutionStage: 2, generation: 8},
    {id: 821, name: 'Rookidee', types: ['flying'], baseStats: {hp: 38, attack: 47, defense: 35, speed: 57}, evolutionStage: 1, generation: 8},
    {id: 822, name: 'Corvisquire', types: ['flying'], baseStats: {hp: 68, attack: 67, defense: 55, speed: 77}, evolutionStage: 2, generation: 8},
    {id: 823, name: 'Corviknight', types: ['flying', 'steel'], baseStats: {hp: 98, attack: 87, defense: 105, speed: 67}, evolutionStage: 3, generation: 8},
    {id: 824, name: 'Blipbug', types: ['bug'], baseStats: {hp: 25, attack: 20, defense: 20, speed: 45}, evolutionStage: 1, generation: 8},
    {id: 825, name: 'Dottler', types: ['bug', 'psychic'], baseStats: {hp: 50, attack: 35, defense: 80, speed: 30}, evolutionStage: 2, generation: 8},
    {id: 826, name: 'Orbeetle', types: ['bug', 'psychic'], baseStats: {hp: 60, attack: 45, defense: 110, speed: 90}, evolutionStage: 3, generation: 8},
    {id: 827, name: 'Nickit', types: ['dark'], baseStats: {hp: 40, attack: 28, defense: 28, speed: 50}, evolutionStage: 1, generation: 8},
    {id: 828, name: 'Thievul', types: ['dark'], baseStats: {hp: 70, attack: 58, defense: 58, speed: 90}, evolutionStage: 2, generation: 8},
    {id: 829, name: 'Gossifleur', types: ['grass'], baseStats: {hp: 40, attack: 40, defense: 60, speed: 10}, evolutionStage: 1, generation: 8},
    {id: 830, name: 'Eldegoss', types: ['grass'], baseStats: {hp: 60, attack: 50, defense: 90, speed: 60}, evolutionStage: 2, generation: 8},
    {id: 831, name: 'Wooloo', types: ['normal'], baseStats: {hp: 42, attack: 40, defense: 55, speed: 48}, evolutionStage: 1, generation: 8},
    {id: 832, name: 'Dubwool', types: ['normal'], baseStats: {hp: 72, attack: 80, defense: 100, speed: 88}, evolutionStage: 2, generation: 8},
    {id: 833, name: 'Chewtle', types: ['water'], baseStats: {hp: 50, attack: 64, defense: 50, speed: 44}, evolutionStage: 1, generation: 8},
    {id: 834, name: 'Drednaw', types: ['water', 'rock'], baseStats: {hp: 90, attack: 115, defense: 90, speed: 74}, evolutionStage: 2, generation: 8},
    {id: 835, name: 'Yamper', types: ['electric'], baseStats: {hp: 59, attack: 45, defense: 50, speed: 26}, evolutionStage: 1, generation: 8},
    {id: 836, name: 'Boltund', types: ['electric'], baseStats: {hp: 69, attack: 90, defense: 60, speed: 121}, evolutionStage: 2, generation: 8},
    {id: 837, name: 'Rolycoly', types: ['rock'], baseStats: {hp: 30, attack: 40, defense: 50, speed: 30}, evolutionStage: 1, generation: 8},
    {id: 838, name: 'Carkol', types: ['rock', 'fire'], baseStats: {hp: 80, attack: 60, defense: 90, speed: 50}, evolutionStage: 2, generation: 8},
    {id: 839, name: 'Coalossal', types: ['rock', 'fire'], baseStats: {hp: 110, attack: 80, defense: 120, speed: 30}, evolutionStage: 3, generation: 8},
    {id: 840, name: 'Applin', types: ['grass', 'dragon'], baseStats: {hp: 40, attack: 40, defense: 80, speed: 20}, evolutionStage: 1, generation: 8},
    {id: 841, name: 'Flapple', types: ['grass', 'dragon'], baseStats: {hp: 70, attack: 110, defense: 80, speed: 70}, evolutionStage: 2, generation: 8},
    {id: 842, name: 'Appletun', types: ['grass', 'dragon'], baseStats: {hp: 110, attack: 85, defense: 80, speed: 30}, evolutionStage: 2, generation: 8},
    {id: 843, name: 'Silicobra', types: ['ground'], baseStats: {hp: 52, attack: 57, defense: 75, speed: 46}, evolutionStage: 1, generation: 8},
    {id: 844, name: 'Sandaconda', types: ['ground'], baseStats: {hp: 72, attack: 107, defense: 125, speed: 71}, evolutionStage: 2, generation: 8},
    {id: 845, name: 'Cramorant', types: ['flying', 'water'], baseStats: {hp: 70, attack: 85, defense: 55, speed: 85}, evolutionStage: 1, generation: 8},
    {id: 846, name: 'Arrokuda', types: ['water'], baseStats: {hp: 41, attack: 63, defense: 40, speed: 66}, evolutionStage: 1, generation: 8},
    {id: 847, name: 'Barraskewda', types: ['water'], baseStats: {hp: 61, attack: 123, defense: 60, speed: 136}, evolutionStage: 2, generation: 8},
    {id: 848, name: 'Toxel', types: ['electric', 'poison'], baseStats: {hp: 40, attack: 38, defense: 35, speed: 40}, evolutionStage: 1, generation: 8},
    {id: 849, name: 'Toxtricity', types: ['electric', 'poison'], baseStats: {hp: 75, attack: 98, defense: 70, speed: 75}, evolutionStage: 2, generation: 8},
    {id: 850, name: 'Sizzlipede', types: ['fire', 'bug'], baseStats: {hp: 50, attack: 65, defense: 45, speed: 45}, evolutionStage: 1, generation: 8},
    {id: 851, name: 'Centiskorch', types: ['fire', 'bug'], baseStats: {hp: 100, attack: 115, defense: 65, speed: 65}, evolutionStage: 2, generation: 8},
    {id: 852, name: 'Clobbopus', types: ['fighting'], baseStats: {hp: 50, attack: 68, defense: 60, speed: 32}, evolutionStage: 1, generation: 8},
    {id: 853, name: 'Grapploct', types: ['fighting'], baseStats: {hp: 80, attack: 118, defense: 90, speed: 42}, evolutionStage: 2, generation: 8},
    {id: 854, name: 'Sinistea', types: ['ghost'], baseStats: {hp: 40, attack: 45, defense: 45, speed: 50}, evolutionStage: 1, generation: 8},
    {id: 855, name: 'Polteageist', types: ['ghost'], baseStats: {hp: 60, attack: 65, defense: 65, speed: 70}, evolutionStage: 2, generation: 8},
    {id: 856, name: 'Hatenna', types: ['psychic'], baseStats: {hp: 42, attack: 30, defense: 45, speed: 39}, evolutionStage: 1, generation: 8},
    {id: 857, name: 'Hattrem', types: ['psychic'], baseStats: {hp: 57, attack: 40, defense: 65, speed: 49}, evolutionStage: 2, generation: 8},
    {id: 858, name: 'Hatterene', types: ['psychic', 'fairy'], baseStats: {hp: 57, attack: 90, defense: 95, speed: 29}, evolutionStage: 3, generation: 8},
    {id: 859, name: 'Impidimp', types: ['dark', 'fairy'], baseStats: {hp: 45, attack: 45, defense: 30, speed: 50}, evolutionStage: 1, generation: 8},
    {id: 860, name: 'Morgrem', types: ['dark', 'fairy'], baseStats: {hp: 65, attack: 60, defense: 45, speed: 70}, evolutionStage: 2, generation: 8},
    {id: 861, name: 'Grimmsnarl', types: ['dark', 'fairy'], baseStats: {hp: 95, attack: 120, defense: 65, speed: 60}, evolutionStage: 3, generation: 8},
    {id: 862, name: 'Obstagoon', types: ['dark', 'normal'], baseStats: {hp: 93, attack: 90, defense: 101, speed: 95}, evolutionStage: 3, generation: 8},
    {id: 863, name: 'Perrserker', types: ['steel'], baseStats: {hp: 70, attack: 110, defense: 100, speed: 50}, evolutionStage: 2, generation: 8},
    {id: 864, name: 'Cursola', types: ['ghost'], baseStats: {hp: 60, attack: 95, defense: 50, speed: 30}, evolutionStage: 2, generation: 8},
    {id: 865, name: 'Sirfetch’d', types: ['fighting'], baseStats: {hp: 62, attack: 135, defense: 95, speed: 65}, evolutionStage: 2, generation: 8},
    {id: 866, name: 'Mr. Rime', types: ['ice', 'psychic'], baseStats: {hp: 80, attack: 85, defense: 75, speed: 70}, evolutionStage: 3, generation: 8},
    {id: 867, name: 'Runerigus', types: ['ground', 'ghost'], baseStats: {hp: 58, attack: 95, defense: 145, speed: 30}, evolutionStage: 2, generation: 8},
    {id: 868, name: 'Milcery', types: ['fairy'], baseStats: {hp: 45, attack: 40, defense: 40, speed: 34}, evolutionStage: 1, generation: 8},
    {id: 869, name: 'Alcremie', types: ['fairy'], baseStats: {hp: 65, attack: 60, defense: 75, speed: 64}, evolutionStage: 2, generation: 8},
    {id: 870, name: 'Falinks', types: ['fighting'], baseStats: {hp: 65, attack: 100, defense: 100, speed: 75}, evolutionStage: 1, generation: 8},
    {id: 871, name: 'Pincurchin', types: ['electric'], baseStats: {hp: 48, attack: 101, defense: 95, speed: 15}, evolutionStage: 1, generation: 8},
    {id: 872, name: 'Snom', types: ['ice', 'bug'], baseStats: {hp: 30, attack: 25, defense: 35, speed: 20}, evolutionStage: 1, generation: 8},
    {id: 873, name: 'Frosmoth', types: ['ice', 'bug'], baseStats: {hp: 70, attack: 65, defense: 60, speed: 65}, evolutionStage: 2, generation: 8},
    {id: 874, name: 'Stonjourner', types: ['rock'], baseStats: {hp: 100, attack: 125, defense: 135, speed: 70}, evolutionStage: 1, generation: 8},
    {id: 875, name: 'Eiscue', types: ['ice'], baseStats: {hp: 75, attack: 80, defense: 110, speed: 50}, evolutionStage: 1, generation: 8},
    {id: 876, name: 'Indeedee', types: ['psychic', 'normal'], baseStats: {hp: 60, attack: 65, defense: 55, speed: 95}, evolutionStage: 1, generation: 8},
    {id: 877, name: 'Morpeko', types: ['electric', 'dark'], baseStats: {hp: 58, attack: 95, defense: 58, speed: 97}, evolutionStage: 1, generation: 8},
    {id: 878, name: 'Cufant', types: ['steel'], baseStats: {hp: 72, attack: 80, defense: 49, speed: 40}, evolutionStage: 1, generation: 8},
    {id: 879, name: 'Copperajah', types: ['steel'], baseStats: {hp: 122, attack: 130, defense: 69, speed: 30}, evolutionStage: 2, generation: 8},
    {id: 880, name: 'Dracozolt', types: ['electric', 'dragon'], baseStats: {hp: 90, attack: 100, defense: 90, speed: 75}, evolutionStage: 1, generation: 8},
    {id: 881, name: 'Arctozolt', types: ['electric', 'ice'], baseStats: {hp: 90, attack: 100, defense: 90, speed: 55}, evolutionStage: 1, generation: 8},
    {id: 882, name: 'Dracovish', types: ['water', 'dragon'], baseStats: {hp: 90, attack: 90, defense: 100, speed: 75}, evolutionStage: 1, generation: 8},
    {id: 883, name: 'Arctovish', types: ['water', 'ice'], baseStats: {hp: 90, attack: 90, defense: 100, speed: 55}, evolutionStage: 1, generation: 8},
    {id: 884, name: 'Duraludon', types: ['steel', 'dragon'], baseStats: {hp: 70, attack: 95, defense: 115, speed: 85}, evolutionStage: 1, generation: 8},
    {id: 885, name: 'Dreepy', types: ['dragon', 'ghost'], baseStats: {hp: 28, attack: 60, defense: 30, speed: 82}, evolutionStage: 1, generation: 8},
    {id: 886, name: 'Drakloak', types: ['dragon', 'ghost'], baseStats: {hp: 68, attack: 80, defense: 50, speed: 102}, evolutionStage: 2, generation: 8},
    {id: 887, name: 'Dragapult', types: ['dragon', 'ghost'], baseStats: {hp: 88, attack: 120, defense: 75, speed: 142}, evolutionStage: 3, generation: 8},
    {id: 888, name: 'Zacian', types: ['fairy'], baseStats: {hp: 92, attack: 120, defense: 115, speed: 138}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 889, name: 'Zamazenta', types: ['fighting'], baseStats: {hp: 92, attack: 120, defense: 115, speed: 138}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 890, name: 'Eternatus', types: ['poison', 'dragon'], baseStats: {hp: 140, attack: 85, defense: 95, speed: 130}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 891, name: 'Kubfu', types: ['fighting'], baseStats: {hp: 60, attack: 90, defense: 60, speed: 72}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 892, name: 'Urshifu', types: ['fighting', 'dark'], baseStats: {hp: 100, attack: 130, defense: 100, speed: 97}, evolutionStage: 2, generation: 8, isLegendary: true},
    {id: 893, name: 'Zarude', types: ['dark', 'grass'], baseStats: {hp: 105, attack: 120, defense: 105, speed: 105}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 894, name: 'Regieleki', types: ['electric'], baseStats: {hp: 80, attack: 100, defense: 50, speed: 200}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 895, name: 'Regidrago', types: ['dragon'], baseStats: {hp: 200, attack: 100, defense: 50, speed: 80}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 896, name: 'Glastrier', types: ['ice'], baseStats: {hp: 100, attack: 145, defense: 130, speed: 30}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 897, name: 'Spectrier', types: ['ghost'], baseStats: {hp: 100, attack: 65, defense: 60, speed: 130}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 898, name: 'Calyrex', types: ['psychic', 'grass'], baseStats: {hp: 100, attack: 80, defense: 80, speed: 80}, evolutionStage: 1, generation: 8, isLegendary: true},
    {id: 899, name: 'Wyrdeer', types: ['normal', 'psychic'], baseStats: {hp: 103, attack: 105, defense: 72, speed: 65}, evolutionStage: 2, generation: 8},
    {id: 900, name: 'Kleavor', types: ['bug', 'rock'], baseStats: {hp: 70, attack: 135, defense: 95, speed: 85}, evolutionStage: 2, generation: 8},
    {id: 901, name: 'Ursaluna', types: ['ground', 'normal'], baseStats: {hp: 130, attack: 140, defense: 105, speed: 50}, evolutionStage: 3, generation: 8},
    {id: 902, name: 'Basculegion', types: ['water', 'ghost'], baseStats: {hp: 120, attack: 112, defense: 65, speed: 78}, evolutionStage: 2, generation: 8},
    {id: 903, name: 'Sneasler', types: ['fighting', 'poison'], baseStats: {hp: 80, attack: 130, defense: 60, speed: 120}, evolutionStage: 2, generation: 8},
    {id: 904, name: 'Overqwil', types: ['dark', 'poison'], baseStats: {hp: 85, attack: 115, defense: 95, speed: 85}, evolutionStage: 2, generation: 8},
    {id: 905, name: 'Enamorus', types: ['fairy', 'flying'], baseStats: {hp: 74, attack: 115, defense: 70, speed: 106}, evolutionStage: 1, generation: 8, isLegendary: true},
    // ── GEN 9: PALDEA ──
    {id: 906, name: 'Sprigatito', types: ['grass'], baseStats: {hp: 40, attack: 61, defense: 54, speed: 65}, evolutionStage: 1, generation: 9},
    {id: 907, name: 'Floragato', types: ['grass'], baseStats: {hp: 61, attack: 80, defense: 63, speed: 83}, evolutionStage: 2, generation: 9},
    {id: 908, name: 'Meowscarada', types: ['grass', 'dark'], baseStats: {hp: 76, attack: 110, defense: 70, speed: 123}, evolutionStage: 3, generation: 9},
    {id: 909, name: 'Fuecoco', types: ['fire'], baseStats: {hp: 67, attack: 45, defense: 59, speed: 36}, evolutionStage: 1, generation: 9},
    {id: 910, name: 'Crocalor', types: ['fire'], baseStats: {hp: 81, attack: 55, defense: 78, speed: 49}, evolutionStage: 2, generation: 9},
    {id: 911, name: 'Skeledirge', types: ['fire', 'ghost'], baseStats: {hp: 104, attack: 75, defense: 100, speed: 66}, evolutionStage: 3, generation: 9},
    {id: 912, name: 'Quaxly', types: ['water'], baseStats: {hp: 55, attack: 65, defense: 45, speed: 50}, evolutionStage: 1, generation: 9},
    {id: 913, name: 'Quaxwell', types: ['water'], baseStats: {hp: 70, attack: 85, defense: 65, speed: 65}, evolutionStage: 2, generation: 9},
    {id: 914, name: 'Quaquaval', types: ['water', 'fighting'], baseStats: {hp: 85, attack: 120, defense: 80, speed: 85}, evolutionStage: 3, generation: 9},
    {id: 915, name: 'Lechonk', types: ['normal'], baseStats: {hp: 54, attack: 45, defense: 40, speed: 35}, evolutionStage: 1, generation: 9},
    {id: 916, name: 'Oinkologne', types: ['normal'], baseStats: {hp: 110, attack: 100, defense: 75, speed: 65}, evolutionStage: 2, generation: 9},
    {id: 917, name: 'Tarountula', types: ['bug'], baseStats: {hp: 35, attack: 41, defense: 45, speed: 20}, evolutionStage: 1, generation: 9},
    {id: 918, name: 'Spidops', types: ['bug'], baseStats: {hp: 60, attack: 79, defense: 92, speed: 35}, evolutionStage: 2, generation: 9},
    {id: 919, name: 'Nymble', types: ['bug'], baseStats: {hp: 33, attack: 46, defense: 40, speed: 45}, evolutionStage: 1, generation: 9},
    {id: 920, name: 'Lokix', types: ['bug', 'dark'], baseStats: {hp: 71, attack: 102, defense: 78, speed: 92}, evolutionStage: 2, generation: 9},
    {id: 921, name: 'Pawmi', types: ['electric'], baseStats: {hp: 45, attack: 50, defense: 20, speed: 60}, evolutionStage: 1, generation: 9},
    {id: 922, name: 'Pawmo', types: ['electric', 'fighting'], baseStats: {hp: 60, attack: 75, defense: 40, speed: 85}, evolutionStage: 2, generation: 9},
    {id: 923, name: 'Pawmot', types: ['electric', 'fighting'], baseStats: {hp: 70, attack: 115, defense: 70, speed: 105}, evolutionStage: 3, generation: 9},
    {id: 924, name: 'Tandemaus', types: ['normal'], baseStats: {hp: 50, attack: 50, defense: 45, speed: 75}, evolutionStage: 1, generation: 9},
    {id: 925, name: 'Maushold', types: ['normal'], baseStats: {hp: 74, attack: 75, defense: 70, speed: 111}, evolutionStage: 2, generation: 9},
    {id: 926, name: 'Fidough', types: ['fairy'], baseStats: {hp: 37, attack: 55, defense: 70, speed: 65}, evolutionStage: 1, generation: 9},
    {id: 927, name: 'Dachsbun', types: ['fairy'], baseStats: {hp: 57, attack: 80, defense: 115, speed: 95}, evolutionStage: 2, generation: 9},
    {id: 928, name: 'Smoliv', types: ['grass', 'normal'], baseStats: {hp: 41, attack: 35, defense: 45, speed: 30}, evolutionStage: 1, generation: 9},
    {id: 929, name: 'Dolliv', types: ['grass', 'normal'], baseStats: {hp: 52, attack: 53, defense: 60, speed: 33}, evolutionStage: 2, generation: 9},
    {id: 930, name: 'Arboliva', types: ['grass', 'normal'], baseStats: {hp: 78, attack: 69, defense: 90, speed: 39}, evolutionStage: 3, generation: 9},
    {id: 931, name: 'Squawkabilly', types: ['normal', 'flying'], baseStats: {hp: 82, attack: 96, defense: 51, speed: 92}, evolutionStage: 1, generation: 9},
    {id: 932, name: 'Nacli', types: ['rock'], baseStats: {hp: 55, attack: 55, defense: 75, speed: 25}, evolutionStage: 1, generation: 9},
    {id: 933, name: 'Naclstack', types: ['rock'], baseStats: {hp: 60, attack: 60, defense: 100, speed: 35}, evolutionStage: 2, generation: 9},
    {id: 934, name: 'Garganacl', types: ['rock'], baseStats: {hp: 100, attack: 100, defense: 130, speed: 35}, evolutionStage: 3, generation: 9},
    {id: 935, name: 'Charcadet', types: ['fire'], baseStats: {hp: 40, attack: 50, defense: 40, speed: 35}, evolutionStage: 1, generation: 9},
    {id: 936, name: 'Armarouge', types: ['fire', 'psychic'], baseStats: {hp: 85, attack: 60, defense: 100, speed: 75}, evolutionStage: 2, generation: 9},
    {id: 937, name: 'Ceruledge', types: ['fire', 'ghost'], baseStats: {hp: 75, attack: 125, defense: 80, speed: 85}, evolutionStage: 2, generation: 9},
    {id: 938, name: 'Tadbulb', types: ['electric'], baseStats: {hp: 61, attack: 31, defense: 41, speed: 45}, evolutionStage: 1, generation: 9},
    {id: 939, name: 'Bellibolt', types: ['electric'], baseStats: {hp: 109, attack: 64, defense: 91, speed: 45}, evolutionStage: 2, generation: 9},
    {id: 940, name: 'Wattrel', types: ['electric', 'flying'], baseStats: {hp: 40, attack: 40, defense: 35, speed: 70}, evolutionStage: 1, generation: 9},
    {id: 941, name: 'Kilowattrel', types: ['electric', 'flying'], baseStats: {hp: 70, attack: 70, defense: 60, speed: 125}, evolutionStage: 2, generation: 9},
    {id: 942, name: 'Maschiff', types: ['dark'], baseStats: {hp: 60, attack: 78, defense: 60, speed: 51}, evolutionStage: 1, generation: 9},
    {id: 943, name: 'Mabosstiff', types: ['dark'], baseStats: {hp: 80, attack: 120, defense: 90, speed: 85}, evolutionStage: 2, generation: 9},
    {id: 944, name: 'Shroodle', types: ['poison', 'normal'], baseStats: {hp: 40, attack: 65, defense: 35, speed: 75}, evolutionStage: 1, generation: 9},
    {id: 945, name: 'Grafaiai', types: ['poison', 'normal'], baseStats: {hp: 63, attack: 95, defense: 65, speed: 110}, evolutionStage: 2, generation: 9},
    {id: 946, name: 'Bramblin', types: ['grass', 'ghost'], baseStats: {hp: 40, attack: 65, defense: 30, speed: 60}, evolutionStage: 1, generation: 9},
    {id: 947, name: 'Brambleghast', types: ['grass', 'ghost'], baseStats: {hp: 55, attack: 115, defense: 70, speed: 90}, evolutionStage: 2, generation: 9},
    {id: 948, name: 'Toedscool', types: ['ground', 'grass'], baseStats: {hp: 40, attack: 40, defense: 35, speed: 70}, evolutionStage: 1, generation: 9},
    {id: 949, name: 'Toedscruel', types: ['ground', 'grass'], baseStats: {hp: 80, attack: 70, defense: 65, speed: 100}, evolutionStage: 2, generation: 9},
    {id: 950, name: 'Klawf', types: ['rock'], baseStats: {hp: 70, attack: 100, defense: 115, speed: 75}, evolutionStage: 1, generation: 9},
    {id: 951, name: 'Capsakid', types: ['grass'], baseStats: {hp: 50, attack: 62, defense: 40, speed: 50}, evolutionStage: 1, generation: 9},
    {id: 952, name: 'Scovillain', types: ['grass', 'fire'], baseStats: {hp: 65, attack: 108, defense: 65, speed: 75}, evolutionStage: 2, generation: 9},
    {id: 953, name: 'Rellor', types: ['bug'], baseStats: {hp: 41, attack: 50, defense: 60, speed: 30}, evolutionStage: 1, generation: 9},
    {id: 954, name: 'Rabsca', types: ['bug', 'psychic'], baseStats: {hp: 75, attack: 50, defense: 85, speed: 45}, evolutionStage: 2, generation: 9},
    {id: 955, name: 'Flittle', types: ['psychic'], baseStats: {hp: 30, attack: 35, defense: 30, speed: 75}, evolutionStage: 1, generation: 9},
    {id: 956, name: 'Espathra', types: ['psychic'], baseStats: {hp: 95, attack: 60, defense: 60, speed: 105}, evolutionStage: 2, generation: 9},
    {id: 957, name: 'Tinkatink', types: ['fairy', 'steel'], baseStats: {hp: 50, attack: 45, defense: 45, speed: 58}, evolutionStage: 1, generation: 9},
    {id: 958, name: 'Tinkatuff', types: ['fairy', 'steel'], baseStats: {hp: 65, attack: 55, defense: 55, speed: 78}, evolutionStage: 2, generation: 9},
    {id: 959, name: 'Tinkaton', types: ['fairy', 'steel'], baseStats: {hp: 85, attack: 75, defense: 77, speed: 94}, evolutionStage: 3, generation: 9},
    {id: 960, name: 'Wiglett', types: ['water'], baseStats: {hp: 10, attack: 55, defense: 25, speed: 95}, evolutionStage: 1, generation: 9},
    {id: 961, name: 'Wugtrio', types: ['water'], baseStats: {hp: 35, attack: 100, defense: 50, speed: 120}, evolutionStage: 2, generation: 9},
    {id: 962, name: 'Bombirdier', types: ['flying', 'dark'], baseStats: {hp: 70, attack: 103, defense: 85, speed: 82}, evolutionStage: 1, generation: 9},
    {id: 963, name: 'Finizen', types: ['water'], baseStats: {hp: 70, attack: 45, defense: 40, speed: 75}, evolutionStage: 1, generation: 9},
    {id: 964, name: 'Palafin', types: ['water'], baseStats: {hp: 100, attack: 70, defense: 72, speed: 100}, evolutionStage: 2, generation: 9},
    {id: 965, name: 'Varoom', types: ['steel', 'poison'], baseStats: {hp: 45, attack: 70, defense: 63, speed: 47}, evolutionStage: 1, generation: 9},
    {id: 966, name: 'Revavroom', types: ['steel', 'poison'], baseStats: {hp: 80, attack: 119, defense: 90, speed: 90}, evolutionStage: 2, generation: 9},
    {id: 967, name: 'Cyclizar', types: ['dragon', 'normal'], baseStats: {hp: 70, attack: 95, defense: 65, speed: 121}, evolutionStage: 1, generation: 9},
    {id: 968, name: 'Orthworm', types: ['steel'], baseStats: {hp: 70, attack: 85, defense: 145, speed: 65}, evolutionStage: 1, generation: 9},
    {id: 969, name: 'Glimmet', types: ['rock', 'poison'], baseStats: {hp: 48, attack: 35, defense: 42, speed: 60}, evolutionStage: 1, generation: 9},
    {id: 970, name: 'Glimmora', types: ['rock', 'poison'], baseStats: {hp: 83, attack: 55, defense: 90, speed: 86}, evolutionStage: 2, generation: 9},
    {id: 971, name: 'Greavard', types: ['ghost'], baseStats: {hp: 50, attack: 61, defense: 60, speed: 34}, evolutionStage: 1, generation: 9},
    {id: 972, name: 'Houndstone', types: ['ghost'], baseStats: {hp: 72, attack: 101, defense: 100, speed: 68}, evolutionStage: 2, generation: 9},
    {id: 973, name: 'Flamigo', types: ['flying', 'fighting'], baseStats: {hp: 82, attack: 115, defense: 74, speed: 90}, evolutionStage: 1, generation: 9},
    {id: 974, name: 'Cetoddle', types: ['ice'], baseStats: {hp: 108, attack: 68, defense: 45, speed: 43}, evolutionStage: 1, generation: 9},
    {id: 975, name: 'Cetitan', types: ['ice'], baseStats: {hp: 170, attack: 113, defense: 65, speed: 73}, evolutionStage: 2, generation: 9},
    {id: 976, name: 'Veluza', types: ['water', 'psychic'], baseStats: {hp: 90, attack: 102, defense: 73, speed: 70}, evolutionStage: 1, generation: 9},
    {id: 977, name: 'Dondozo', types: ['water'], baseStats: {hp: 150, attack: 100, defense: 115, speed: 35}, evolutionStage: 1, generation: 9},
    {id: 978, name: 'Tatsugiri', types: ['dragon', 'water'], baseStats: {hp: 68, attack: 50, defense: 60, speed: 82}, evolutionStage: 1, generation: 9},
    {id: 979, name: 'Annihilape', types: ['fighting', 'ghost'], baseStats: {hp: 110, attack: 115, defense: 80, speed: 90}, evolutionStage: 3, generation: 9},
    {id: 980, name: 'Clodsire', types: ['poison', 'ground'], baseStats: {hp: 130, attack: 75, defense: 60, speed: 20}, evolutionStage: 2, generation: 9},
    {id: 981, name: 'Farigiraf', types: ['normal', 'psychic'], baseStats: {hp: 120, attack: 90, defense: 70, speed: 60}, evolutionStage: 2, generation: 9},
    {id: 982, name: 'Dudunsparce', types: ['normal'], baseStats: {hp: 125, attack: 100, defense: 80, speed: 55}, evolutionStage: 2, generation: 9},
    {id: 983, name: 'Kingambit', types: ['dark', 'steel'], baseStats: {hp: 100, attack: 135, defense: 120, speed: 50}, evolutionStage: 3, generation: 9},
    {id: 984, name: 'Great Tusk', types: ['ground', 'fighting'], baseStats: {hp: 115, attack: 131, defense: 131, speed: 87}, evolutionStage: 1, generation: 9},
    {id: 985, name: 'Scream Tail', types: ['fairy', 'psychic'], baseStats: {hp: 115, attack: 65, defense: 99, speed: 111}, evolutionStage: 1, generation: 9},
    {id: 986, name: 'Brute Bonnet', types: ['grass', 'dark'], baseStats: {hp: 111, attack: 127, defense: 99, speed: 55}, evolutionStage: 1, generation: 9},
    {id: 987, name: 'Flutter Mane', types: ['ghost', 'fairy'], baseStats: {hp: 55, attack: 55, defense: 55, speed: 135}, evolutionStage: 1, generation: 9},
    {id: 988, name: 'Slither Wing', types: ['bug', 'fighting'], baseStats: {hp: 85, attack: 135, defense: 79, speed: 81}, evolutionStage: 1, generation: 9},
    {id: 989, name: 'Sandy Shocks', types: ['electric', 'ground'], baseStats: {hp: 85, attack: 81, defense: 97, speed: 101}, evolutionStage: 1, generation: 9},
    {id: 990, name: 'Iron Treads', types: ['ground', 'steel'], baseStats: {hp: 90, attack: 112, defense: 120, speed: 106}, evolutionStage: 1, generation: 9},
    {id: 991, name: 'Iron Bundle', types: ['ice', 'water'], baseStats: {hp: 56, attack: 80, defense: 114, speed: 136}, evolutionStage: 1, generation: 9},
    {id: 992, name: 'Iron Hands', types: ['fighting', 'electric'], baseStats: {hp: 154, attack: 140, defense: 108, speed: 50}, evolutionStage: 1, generation: 9},
    {id: 993, name: 'Iron Jugulis', types: ['dark', 'flying'], baseStats: {hp: 94, attack: 80, defense: 86, speed: 108}, evolutionStage: 1, generation: 9},
    {id: 994, name: 'Iron Moth', types: ['fire', 'poison'], baseStats: {hp: 80, attack: 70, defense: 60, speed: 110}, evolutionStage: 1, generation: 9},
    {id: 995, name: 'Iron Thorns', types: ['rock', 'electric'], baseStats: {hp: 100, attack: 134, defense: 110, speed: 72}, evolutionStage: 1, generation: 9},
    {id: 996, name: 'Frigibax', types: ['dragon', 'ice'], baseStats: {hp: 65, attack: 75, defense: 45, speed: 55}, evolutionStage: 1, generation: 9},
    {id: 997, name: 'Arctibax', types: ['dragon', 'ice'], baseStats: {hp: 90, attack: 95, defense: 66, speed: 62}, evolutionStage: 2, generation: 9},
    {id: 998, name: 'Baxcalibur', types: ['dragon', 'ice'], baseStats: {hp: 115, attack: 145, defense: 92, speed: 87}, evolutionStage: 3, generation: 9},
    {id: 999, name: 'Gimmighoul', types: ['ghost'], baseStats: {hp: 45, attack: 30, defense: 70, speed: 10}, evolutionStage: 1, generation: 9},
    {id: 1000, name: 'Gholdengo', types: ['steel', 'ghost'], baseStats: {hp: 87, attack: 60, defense: 95, speed: 84}, evolutionStage: 2, generation: 9},
    {id: 1001, name: 'Wo-Chien', types: ['dark', 'grass'], baseStats: {hp: 85, attack: 85, defense: 100, speed: 70}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1002, name: 'Chien-Pao', types: ['dark', 'ice'], baseStats: {hp: 80, attack: 120, defense: 80, speed: 135}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1003, name: 'Ting-Lu', types: ['dark', 'ground'], baseStats: {hp: 155, attack: 110, defense: 125, speed: 45}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1004, name: 'Chi-Yu', types: ['dark', 'fire'], baseStats: {hp: 55, attack: 80, defense: 80, speed: 100}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1005, name: 'Roaring Moon', types: ['dragon', 'dark'], baseStats: {hp: 105, attack: 139, defense: 71, speed: 119}, evolutionStage: 1, generation: 9},
    {id: 1006, name: 'Iron Valiant', types: ['fairy', 'fighting'], baseStats: {hp: 74, attack: 130, defense: 90, speed: 116}, evolutionStage: 1, generation: 9},
    {id: 1007, name: 'Koraidon', types: ['fighting', 'dragon'], baseStats: {hp: 100, attack: 135, defense: 115, speed: 135}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1008, name: 'Miraidon', types: ['electric', 'dragon'], baseStats: {hp: 100, attack: 85, defense: 100, speed: 135}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1009, name: 'Walking Wake', types: ['water', 'dragon'], baseStats: {hp: 99, attack: 83, defense: 91, speed: 109}, evolutionStage: 1, generation: 9},
    {id: 1010, name: 'Iron Leaves', types: ['grass', 'psychic'], baseStats: {hp: 90, attack: 130, defense: 88, speed: 104}, evolutionStage: 1, generation: 9},
    {id: 1011, name: 'Dipplin', types: ['grass', 'dragon'], baseStats: {hp: 80, attack: 80, defense: 110, speed: 40}, evolutionStage: 2, generation: 9},
    {id: 1012, name: 'Poltchageist', types: ['grass', 'ghost'], baseStats: {hp: 40, attack: 45, defense: 45, speed: 50}, evolutionStage: 1, generation: 9},
    {id: 1013, name: 'Sinistcha', types: ['grass', 'ghost'], baseStats: {hp: 71, attack: 60, defense: 106, speed: 70}, evolutionStage: 2, generation: 9},
    {id: 1014, name: 'Okidogi', types: ['poison', 'fighting'], baseStats: {hp: 88, attack: 128, defense: 115, speed: 80}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1015, name: 'Munkidori', types: ['poison', 'psychic'], baseStats: {hp: 88, attack: 75, defense: 66, speed: 106}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1016, name: 'Fezandipiti', types: ['poison', 'fairy'], baseStats: {hp: 88, attack: 91, defense: 82, speed: 99}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1017, name: 'Ogerpon', types: ['grass'], baseStats: {hp: 80, attack: 120, defense: 84, speed: 110}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1018, name: 'Archaludon', types: ['steel', 'dragon'], baseStats: {hp: 90, attack: 105, defense: 130, speed: 85}, evolutionStage: 2, generation: 9},
    {id: 1019, name: 'Hydrapple', types: ['grass', 'dragon'], baseStats: {hp: 106, attack: 80, defense: 110, speed: 44}, evolutionStage: 3, generation: 9},
    {id: 1020, name: 'Gouging Fire', types: ['fire', 'dragon'], baseStats: {hp: 105, attack: 115, defense: 121, speed: 91}, evolutionStage: 1, generation: 9},
    {id: 1021, name: 'Raging Bolt', types: ['electric', 'dragon'], baseStats: {hp: 125, attack: 73, defense: 91, speed: 75}, evolutionStage: 1, generation: 9},
    {id: 1022, name: 'Iron Boulder', types: ['rock', 'psychic'], baseStats: {hp: 90, attack: 120, defense: 80, speed: 124}, evolutionStage: 1, generation: 9},
    {id: 1023, name: 'Iron Crown', types: ['steel', 'psychic'], baseStats: {hp: 90, attack: 72, defense: 100, speed: 98}, evolutionStage: 1, generation: 9},
    {id: 1024, name: 'Terapagos', types: ['normal'], baseStats: {hp: 90, attack: 65, defense: 85, speed: 60}, evolutionStage: 1, generation: 9, isLegendary: true},
    {id: 1025, name: 'Pecharunt', types: ['poison', 'ghost'], baseStats: {hp: 88, attack: 88, defense: 160, speed: 88}, evolutionStage: 1, generation: 9, isLegendary: true},
];

// ─────────────────────────── Evolution Chains ───────────────────────────

const EVOLUTION_CHAINS = [
    // ── GEN 1 ──
    {fromId: 1, toId: 2, level: 16},
    {fromId: 2, toId: 3, level: 32},
    {fromId: 4, toId: 5, level: 16},
    {fromId: 5, toId: 6, level: 36},
    {fromId: 7, toId: 8, level: 16},
    {fromId: 8, toId: 9, level: 36},
    {fromId: 10, toId: 11, level: 7},
    {fromId: 11, toId: 12, level: 10},
    {fromId: 13, toId: 14, level: 7},
    {fromId: 14, toId: 15, level: 10},
    {fromId: 16, toId: 17, level: 18},
    {fromId: 17, toId: 18, level: 36},
    {fromId: 19, toId: 20, level: 20},
    {fromId: 21, toId: 22, level: 20},
    {fromId: 23, toId: 24, level: 22},
    {fromId: 25, toId: 26, level: 36},
    {fromId: 27, toId: 28, level: 22},
    {fromId: 29, toId: 30, level: 16},
    {fromId: 30, toId: 31, level: 36},
    {fromId: 32, toId: 33, level: 16},
    {fromId: 33, toId: 34, level: 36},
    {fromId: 35, toId: 36, level: 36},
    {fromId: 37, toId: 38, level: 16},
    {fromId: 39, toId: 40, level: 36},
    {fromId: 41, toId: 42, level: 22},
    {fromId: 42, toId: 169, level: 36},
    {fromId: 43, toId: 44, level: 21},
    {fromId: 44, toId: 45, level: 36},
    {fromId: 44, toId: 182, level: 36},
    {fromId: 46, toId: 47, level: 24},
    {fromId: 48, toId: 49, level: 31},
    {fromId: 50, toId: 51, level: 26},
    {fromId: 52, toId: 53, level: 28},
    {fromId: 52, toId: 863, level: 28},
    {fromId: 54, toId: 55, level: 33},
    {fromId: 56, toId: 57, level: 28},
    {fromId: 57, toId: 979, level: 36},
    {fromId: 58, toId: 59, level: 16},
    {fromId: 60, toId: 61, level: 25},
    {fromId: 61, toId: 62, level: 36},
    {fromId: 61, toId: 186, level: 36},
    {fromId: 63, toId: 64, level: 16},
    {fromId: 64, toId: 65, level: 36},
    {fromId: 66, toId: 67, level: 28},
    {fromId: 67, toId: 68, level: 36},
    {fromId: 69, toId: 70, level: 21},
    {fromId: 70, toId: 71, level: 36},
    {fromId: 72, toId: 73, level: 30},
    {fromId: 74, toId: 75, level: 25},
    {fromId: 75, toId: 76, level: 36},
    {fromId: 77, toId: 78, level: 40},
    {fromId: 79, toId: 80, level: 37},
    {fromId: 79, toId: 199, level: 16},
    {fromId: 81, toId: 82, level: 30},
    {fromId: 82, toId: 462, level: 36},
    {fromId: 83, toId: 865, level: 16},
    {fromId: 84, toId: 85, level: 31},
    {fromId: 86, toId: 87, level: 34},
    {fromId: 88, toId: 89, level: 38},
    {fromId: 90, toId: 91, level: 16},
    {fromId: 92, toId: 93, level: 25},
    {fromId: 93, toId: 94, level: 36},
    {fromId: 95, toId: 208, level: 16},
    {fromId: 96, toId: 97, level: 26},
    {fromId: 98, toId: 99, level: 28},
    {fromId: 100, toId: 101, level: 30},
    {fromId: 102, toId: 103, level: 16},
    {fromId: 104, toId: 105, level: 28},
    {fromId: 108, toId: 463, level: 16},
    {fromId: 109, toId: 110, level: 35},
    {fromId: 111, toId: 112, level: 42},
    {fromId: 112, toId: 464, level: 36},
    {fromId: 113, toId: 242, level: 36},
    {fromId: 114, toId: 465, level: 16},
    {fromId: 116, toId: 117, level: 32},
    {fromId: 117, toId: 230, level: 36},
    {fromId: 118, toId: 119, level: 33},
    {fromId: 120, toId: 121, level: 16},
    {fromId: 122, toId: 866, level: 42},
    {fromId: 123, toId: 212, level: 16},
    {fromId: 123, toId: 900, level: 16},
    {fromId: 125, toId: 466, level: 36},
    {fromId: 126, toId: 467, level: 36},
    {fromId: 129, toId: 130, level: 20},
    {fromId: 133, toId: 134, level: 16},
    {fromId: 133, toId: 135, level: 16},
    {fromId: 133, toId: 136, level: 16},
    {fromId: 133, toId: 196, level: 16},
    {fromId: 133, toId: 197, level: 16},
    {fromId: 133, toId: 470, level: 16},
    {fromId: 133, toId: 471, level: 16},
    {fromId: 133, toId: 700, level: 16},
    {fromId: 137, toId: 233, level: 16},
    {fromId: 138, toId: 139, level: 40},
    {fromId: 140, toId: 141, level: 40},
    {fromId: 147, toId: 148, level: 30},
    {fromId: 148, toId: 149, level: 55},
    // ── GEN 2 ──
    {fromId: 152, toId: 153, level: 16},
    {fromId: 153, toId: 154, level: 32},
    {fromId: 155, toId: 156, level: 14},
    {fromId: 156, toId: 157, level: 36},
    {fromId: 158, toId: 159, level: 18},
    {fromId: 159, toId: 160, level: 30},
    {fromId: 161, toId: 162, level: 15},
    {fromId: 163, toId: 164, level: 20},
    {fromId: 165, toId: 166, level: 18},
    {fromId: 167, toId: 168, level: 22},
    {fromId: 170, toId: 171, level: 27},
    {fromId: 172, toId: 25, level: 16},
    {fromId: 173, toId: 35, level: 16},
    {fromId: 174, toId: 39, level: 16},
    {fromId: 175, toId: 176, level: 16},
    {fromId: 176, toId: 468, level: 36},
    {fromId: 177, toId: 178, level: 25},
    {fromId: 179, toId: 180, level: 15},
    {fromId: 180, toId: 181, level: 30},
    {fromId: 183, toId: 184, level: 18},
    {fromId: 187, toId: 188, level: 18},
    {fromId: 188, toId: 189, level: 27},
    {fromId: 190, toId: 424, level: 16},
    {fromId: 191, toId: 192, level: 16},
    {fromId: 193, toId: 469, level: 16},
    {fromId: 194, toId: 195, level: 20},
    {fromId: 194, toId: 980, level: 20},
    {fromId: 198, toId: 430, level: 16},
    {fromId: 200, toId: 429, level: 16},
    {fromId: 203, toId: 981, level: 16},
    {fromId: 204, toId: 205, level: 31},
    {fromId: 206, toId: 982, level: 16},
    {fromId: 207, toId: 472, level: 16},
    {fromId: 209, toId: 210, level: 23},
    {fromId: 211, toId: 904, level: 16},
    {fromId: 215, toId: 461, level: 16},
    {fromId: 215, toId: 903, level: 16},
    {fromId: 216, toId: 217, level: 30},
    {fromId: 217, toId: 901, level: 36},
    {fromId: 218, toId: 219, level: 38},
    {fromId: 220, toId: 221, level: 33},
    {fromId: 221, toId: 473, level: 36},
    {fromId: 222, toId: 864, level: 38},
    {fromId: 223, toId: 224, level: 25},
    {fromId: 228, toId: 229, level: 24},
    {fromId: 231, toId: 232, level: 25},
    {fromId: 233, toId: 474, level: 36},
    {fromId: 234, toId: 899, level: 16},
    {fromId: 236, toId: 106, level: 20},
    {fromId: 236, toId: 107, level: 20},
    {fromId: 236, toId: 237, level: 20},
    {fromId: 238, toId: 124, level: 30},
    {fromId: 239, toId: 125, level: 30},
    {fromId: 240, toId: 126, level: 30},
    {fromId: 246, toId: 247, level: 30},
    {fromId: 247, toId: 248, level: 55},
    // ── GEN 3 ──
    {fromId: 252, toId: 253, level: 16},
    {fromId: 253, toId: 254, level: 36},
    {fromId: 255, toId: 256, level: 16},
    {fromId: 256, toId: 257, level: 36},
    {fromId: 258, toId: 259, level: 16},
    {fromId: 259, toId: 260, level: 36},
    {fromId: 261, toId: 262, level: 18},
    {fromId: 263, toId: 264, level: 20},
    {fromId: 264, toId: 862, level: 35},
    {fromId: 265, toId: 266, level: 7},
    {fromId: 265, toId: 268, level: 7},
    {fromId: 266, toId: 267, level: 10},
    {fromId: 268, toId: 269, level: 10},
    {fromId: 270, toId: 271, level: 14},
    {fromId: 271, toId: 272, level: 36},
    {fromId: 273, toId: 274, level: 14},
    {fromId: 274, toId: 275, level: 36},
    {fromId: 276, toId: 277, level: 22},
    {fromId: 278, toId: 279, level: 25},
    {fromId: 280, toId: 281, level: 20},
    {fromId: 281, toId: 282, level: 30},
    {fromId: 281, toId: 475, level: 36},
    {fromId: 283, toId: 284, level: 22},
    {fromId: 285, toId: 286, level: 23},
    {fromId: 287, toId: 288, level: 18},
    {fromId: 288, toId: 289, level: 36},
    {fromId: 290, toId: 291, level: 20},
    {fromId: 290, toId: 292, level: 16},
    {fromId: 293, toId: 294, level: 20},
    {fromId: 294, toId: 295, level: 40},
    {fromId: 296, toId: 297, level: 24},
    {fromId: 298, toId: 183, level: 16},
    {fromId: 299, toId: 476, level: 16},
    {fromId: 300, toId: 301, level: 16},
    {fromId: 304, toId: 305, level: 32},
    {fromId: 305, toId: 306, level: 42},
    {fromId: 307, toId: 308, level: 37},
    {fromId: 309, toId: 310, level: 26},
    {fromId: 315, toId: 407, level: 36},
    {fromId: 316, toId: 317, level: 26},
    {fromId: 318, toId: 319, level: 30},
    {fromId: 320, toId: 321, level: 40},
    {fromId: 322, toId: 323, level: 33},
    {fromId: 325, toId: 326, level: 32},
    {fromId: 328, toId: 329, level: 35},
    {fromId: 329, toId: 330, level: 45},
    {fromId: 331, toId: 332, level: 32},
    {fromId: 333, toId: 334, level: 35},
    {fromId: 339, toId: 340, level: 30},
    {fromId: 341, toId: 342, level: 30},
    {fromId: 343, toId: 344, level: 36},
    {fromId: 345, toId: 346, level: 40},
    {fromId: 347, toId: 348, level: 40},
    {fromId: 349, toId: 350, level: 16},
    {fromId: 353, toId: 354, level: 37},
    {fromId: 355, toId: 356, level: 37},
    {fromId: 356, toId: 477, level: 36},
    {fromId: 360, toId: 202, level: 15},
    {fromId: 361, toId: 362, level: 42},
    {fromId: 361, toId: 478, level: 16},
    {fromId: 363, toId: 364, level: 32},
    {fromId: 364, toId: 365, level: 44},
    {fromId: 366, toId: 367, level: 16},
    {fromId: 366, toId: 368, level: 16},
    {fromId: 371, toId: 372, level: 30},
    {fromId: 372, toId: 373, level: 50},
    {fromId: 374, toId: 375, level: 20},
    {fromId: 375, toId: 376, level: 45},
    // ── GEN 4 ──
    {fromId: 387, toId: 388, level: 18},
    {fromId: 388, toId: 389, level: 32},
    {fromId: 390, toId: 391, level: 14},
    {fromId: 391, toId: 392, level: 36},
    {fromId: 393, toId: 394, level: 16},
    {fromId: 394, toId: 395, level: 36},
    {fromId: 396, toId: 397, level: 14},
    {fromId: 397, toId: 398, level: 34},
    {fromId: 399, toId: 400, level: 15},
    {fromId: 401, toId: 402, level: 10},
    {fromId: 403, toId: 404, level: 15},
    {fromId: 404, toId: 405, level: 30},
    {fromId: 406, toId: 315, level: 16},
    {fromId: 408, toId: 409, level: 30},
    {fromId: 410, toId: 411, level: 30},
    {fromId: 412, toId: 413, level: 20},
    {fromId: 412, toId: 414, level: 20},
    {fromId: 415, toId: 416, level: 21},
    {fromId: 418, toId: 419, level: 26},
    {fromId: 420, toId: 421, level: 25},
    {fromId: 422, toId: 423, level: 30},
    {fromId: 425, toId: 426, level: 28},
    {fromId: 427, toId: 428, level: 16},
    {fromId: 431, toId: 432, level: 38},
    {fromId: 433, toId: 358, level: 16},
    {fromId: 434, toId: 435, level: 34},
    {fromId: 436, toId: 437, level: 33},
    {fromId: 438, toId: 185, level: 16},
    {fromId: 439, toId: 122, level: 16},
    {fromId: 440, toId: 113, level: 16},
    {fromId: 443, toId: 444, level: 24},
    {fromId: 444, toId: 445, level: 48},
    {fromId: 446, toId: 143, level: 16},
    {fromId: 447, toId: 448, level: 16},
    {fromId: 449, toId: 450, level: 34},
    {fromId: 451, toId: 452, level: 40},
    {fromId: 453, toId: 454, level: 37},
    {fromId: 456, toId: 457, level: 31},
    {fromId: 458, toId: 226, level: 16},
    {fromId: 459, toId: 460, level: 40},
    // ── GEN 5 ──
    {fromId: 495, toId: 496, level: 17},
    {fromId: 496, toId: 497, level: 36},
    {fromId: 498, toId: 499, level: 17},
    {fromId: 499, toId: 500, level: 36},
    {fromId: 501, toId: 502, level: 17},
    {fromId: 502, toId: 503, level: 36},
    {fromId: 504, toId: 505, level: 20},
    {fromId: 506, toId: 507, level: 16},
    {fromId: 507, toId: 508, level: 32},
    {fromId: 509, toId: 510, level: 20},
    {fromId: 511, toId: 512, level: 16},
    {fromId: 513, toId: 514, level: 16},
    {fromId: 515, toId: 516, level: 16},
    {fromId: 517, toId: 518, level: 16},
    {fromId: 519, toId: 520, level: 21},
    {fromId: 520, toId: 521, level: 32},
    {fromId: 522, toId: 523, level: 27},
    {fromId: 524, toId: 525, level: 25},
    {fromId: 525, toId: 526, level: 36},
    {fromId: 527, toId: 528, level: 16},
    {fromId: 529, toId: 530, level: 31},
    {fromId: 532, toId: 533, level: 25},
    {fromId: 533, toId: 534, level: 36},
    {fromId: 535, toId: 536, level: 25},
    {fromId: 536, toId: 537, level: 36},
    {fromId: 540, toId: 541, level: 20},
    {fromId: 541, toId: 542, level: 36},
    {fromId: 543, toId: 544, level: 22},
    {fromId: 544, toId: 545, level: 30},
    {fromId: 546, toId: 547, level: 16},
    {fromId: 548, toId: 549, level: 16},
    {fromId: 550, toId: 902, level: 16},
    {fromId: 551, toId: 552, level: 29},
    {fromId: 552, toId: 553, level: 40},
    {fromId: 554, toId: 555, level: 35},
    {fromId: 557, toId: 558, level: 34},
    {fromId: 559, toId: 560, level: 39},
    {fromId: 562, toId: 563, level: 34},
    {fromId: 562, toId: 867, level: 16},
    {fromId: 564, toId: 565, level: 37},
    {fromId: 566, toId: 567, level: 37},
    {fromId: 568, toId: 569, level: 36},
    {fromId: 570, toId: 571, level: 30},
    {fromId: 572, toId: 573, level: 16},
    {fromId: 574, toId: 575, level: 32},
    {fromId: 575, toId: 576, level: 41},
    {fromId: 577, toId: 578, level: 32},
    {fromId: 578, toId: 579, level: 41},
    {fromId: 580, toId: 581, level: 35},
    {fromId: 582, toId: 583, level: 35},
    {fromId: 583, toId: 584, level: 47},
    {fromId: 585, toId: 586, level: 34},
    {fromId: 588, toId: 589, level: 16},
    {fromId: 590, toId: 591, level: 39},
    {fromId: 592, toId: 593, level: 40},
    {fromId: 595, toId: 596, level: 36},
    {fromId: 597, toId: 598, level: 40},
    {fromId: 599, toId: 600, level: 38},
    {fromId: 600, toId: 601, level: 49},
    {fromId: 602, toId: 603, level: 39},
    {fromId: 603, toId: 604, level: 36},
    {fromId: 605, toId: 606, level: 42},
    {fromId: 607, toId: 608, level: 41},
    {fromId: 608, toId: 609, level: 36},
    {fromId: 610, toId: 611, level: 38},
    {fromId: 611, toId: 612, level: 48},
    {fromId: 613, toId: 614, level: 37},
    {fromId: 616, toId: 617, level: 16},
    {fromId: 619, toId: 620, level: 50},
    {fromId: 622, toId: 623, level: 43},
    {fromId: 624, toId: 625, level: 52},
    {fromId: 625, toId: 983, level: 36},
    {fromId: 627, toId: 628, level: 54},
    {fromId: 629, toId: 630, level: 54},
    {fromId: 633, toId: 634, level: 50},
    {fromId: 634, toId: 635, level: 64},
    {fromId: 636, toId: 637, level: 59},
    // ── GEN 6 ──
    {fromId: 650, toId: 651, level: 16},
    {fromId: 651, toId: 652, level: 36},
    {fromId: 653, toId: 654, level: 16},
    {fromId: 654, toId: 655, level: 36},
    {fromId: 656, toId: 657, level: 16},
    {fromId: 657, toId: 658, level: 36},
    {fromId: 659, toId: 660, level: 20},
    {fromId: 661, toId: 662, level: 17},
    {fromId: 662, toId: 663, level: 35},
    {fromId: 664, toId: 665, level: 9},
    {fromId: 665, toId: 666, level: 12},
    {fromId: 667, toId: 668, level: 35},
    {fromId: 669, toId: 670, level: 19},
    {fromId: 670, toId: 671, level: 36},
    {fromId: 672, toId: 673, level: 32},
    {fromId: 674, toId: 675, level: 32},
    {fromId: 677, toId: 678, level: 25},
    {fromId: 679, toId: 680, level: 35},
    {fromId: 680, toId: 681, level: 36},
    {fromId: 682, toId: 683, level: 16},
    {fromId: 684, toId: 685, level: 16},
    {fromId: 686, toId: 687, level: 30},
    {fromId: 688, toId: 689, level: 39},
    {fromId: 690, toId: 691, level: 48},
    {fromId: 692, toId: 693, level: 37},
    {fromId: 694, toId: 695, level: 16},
    {fromId: 696, toId: 697, level: 39},
    {fromId: 698, toId: 699, level: 39},
    {fromId: 704, toId: 705, level: 40},
    {fromId: 705, toId: 706, level: 50},
    {fromId: 708, toId: 709, level: 16},
    {fromId: 710, toId: 711, level: 16},
    {fromId: 712, toId: 713, level: 37},
    {fromId: 714, toId: 715, level: 48},
    // ── GEN 7 ──
    {fromId: 722, toId: 723, level: 17},
    {fromId: 723, toId: 724, level: 34},
    {fromId: 725, toId: 726, level: 17},
    {fromId: 726, toId: 727, level: 34},
    {fromId: 728, toId: 729, level: 17},
    {fromId: 729, toId: 730, level: 34},
    {fromId: 731, toId: 732, level: 14},
    {fromId: 732, toId: 733, level: 28},
    {fromId: 734, toId: 735, level: 20},
    {fromId: 736, toId: 737, level: 20},
    {fromId: 737, toId: 738, level: 36},
    {fromId: 739, toId: 740, level: 16},
    {fromId: 742, toId: 743, level: 25},
    {fromId: 744, toId: 745, level: 25},
    {fromId: 747, toId: 748, level: 38},
    {fromId: 749, toId: 750, level: 30},
    {fromId: 751, toId: 752, level: 22},
    {fromId: 753, toId: 754, level: 34},
    {fromId: 755, toId: 756, level: 24},
    {fromId: 757, toId: 758, level: 33},
    {fromId: 759, toId: 760, level: 27},
    {fromId: 761, toId: 762, level: 18},
    {fromId: 762, toId: 763, level: 36},
    {fromId: 767, toId: 768, level: 30},
    {fromId: 769, toId: 770, level: 42},
    {fromId: 772, toId: 773, level: 16},
    {fromId: 782, toId: 783, level: 35},
    {fromId: 783, toId: 784, level: 45},
    {fromId: 789, toId: 790, level: 43},
    {fromId: 790, toId: 791, level: 53},
    {fromId: 790, toId: 792, level: 53},
    {fromId: 803, toId: 804, level: 16},
    {fromId: 808, toId: 809, level: 16},
    // ── GEN 8 ──
    {fromId: 810, toId: 811, level: 16},
    {fromId: 811, toId: 812, level: 35},
    {fromId: 813, toId: 814, level: 16},
    {fromId: 814, toId: 815, level: 35},
    {fromId: 816, toId: 817, level: 16},
    {fromId: 817, toId: 818, level: 35},
    {fromId: 819, toId: 820, level: 24},
    {fromId: 821, toId: 822, level: 18},
    {fromId: 822, toId: 823, level: 38},
    {fromId: 824, toId: 825, level: 10},
    {fromId: 825, toId: 826, level: 30},
    {fromId: 827, toId: 828, level: 18},
    {fromId: 829, toId: 830, level: 20},
    {fromId: 831, toId: 832, level: 24},
    {fromId: 833, toId: 834, level: 22},
    {fromId: 835, toId: 836, level: 25},
    {fromId: 837, toId: 838, level: 18},
    {fromId: 838, toId: 839, level: 34},
    {fromId: 840, toId: 841, level: 16},
    {fromId: 840, toId: 842, level: 16},
    {fromId: 840, toId: 1011, level: 16},
    {fromId: 843, toId: 844, level: 36},
    {fromId: 846, toId: 847, level: 26},
    {fromId: 848, toId: 849, level: 30},
    {fromId: 850, toId: 851, level: 28},
    {fromId: 852, toId: 853, level: 16},
    {fromId: 854, toId: 855, level: 16},
    {fromId: 856, toId: 857, level: 32},
    {fromId: 857, toId: 858, level: 42},
    {fromId: 859, toId: 860, level: 32},
    {fromId: 860, toId: 861, level: 42},
    {fromId: 868, toId: 869, level: 16},
    {fromId: 872, toId: 873, level: 16},
    {fromId: 878, toId: 879, level: 34},
    {fromId: 884, toId: 1018, level: 16},
    {fromId: 885, toId: 886, level: 50},
    {fromId: 886, toId: 887, level: 60},
    {fromId: 891, toId: 892, level: 16},
    // ── GEN 9 ──
    {fromId: 906, toId: 907, level: 16},
    {fromId: 907, toId: 908, level: 36},
    {fromId: 909, toId: 910, level: 16},
    {fromId: 910, toId: 911, level: 36},
    {fromId: 912, toId: 913, level: 16},
    {fromId: 913, toId: 914, level: 36},
    {fromId: 915, toId: 916, level: 18},
    {fromId: 917, toId: 918, level: 15},
    {fromId: 919, toId: 920, level: 24},
    {fromId: 921, toId: 922, level: 18},
    {fromId: 922, toId: 923, level: 36},
    {fromId: 924, toId: 925, level: 25},
    {fromId: 926, toId: 927, level: 26},
    {fromId: 928, toId: 929, level: 25},
    {fromId: 929, toId: 930, level: 35},
    {fromId: 932, toId: 933, level: 24},
    {fromId: 933, toId: 934, level: 38},
    {fromId: 935, toId: 936, level: 16},
    {fromId: 935, toId: 937, level: 16},
    {fromId: 938, toId: 939, level: 16},
    {fromId: 940, toId: 941, level: 25},
    {fromId: 942, toId: 943, level: 30},
    {fromId: 944, toId: 945, level: 28},
    {fromId: 946, toId: 947, level: 16},
    {fromId: 948, toId: 949, level: 30},
    {fromId: 951, toId: 952, level: 16},
    {fromId: 953, toId: 954, level: 16},
    {fromId: 955, toId: 956, level: 35},
    {fromId: 957, toId: 958, level: 24},
    {fromId: 958, toId: 959, level: 38},
    {fromId: 960, toId: 961, level: 26},
    {fromId: 963, toId: 964, level: 38},
    {fromId: 965, toId: 966, level: 40},
    {fromId: 969, toId: 970, level: 35},
    {fromId: 971, toId: 972, level: 30},
    {fromId: 974, toId: 975, level: 16},
    {fromId: 996, toId: 997, level: 35},
    {fromId: 997, toId: 998, level: 54},
    {fromId: 999, toId: 1000, level: 16},
    {fromId: 1011, toId: 1019, level: 36},
    {fromId: 1012, toId: 1013, level: 16},
];

// ─────────────────────────── Starter Options ───────────────────────────

const STARTER_OPTIONS = [
    // Gen 1
    1, 4, 7, 25, 133,
    // Gen 2
    152, 155, 158,
    // Gen 3
    252, 255, 258,
    // Gen 4
    387, 390, 393,
    // Gen 5
    495, 498, 501,
    // Gen 6
    650, 653, 656,
    // Gen 7
    722, 725, 728,
    // Gen 8
    810, 813, 816,
    // Gen 9
    906, 909, 912,
];

// ─────────────────────────── Mega Evolution ───────────────────────────
//
// A mega is a sprite change plus a power increase. What that increase IS
// depends on where the Pokémon is fighting, and the two are deliberately
// different:
//
//   Studying (wild captures)   MEGA_DAMAGE_MULTIPLIER, applied for as long as
//                              the toggle is on. Permanent, because that is
//                              what a reward for studying should feel like.
//
//   PVP                        MEGA_STAT_BOOST, applied only after the trainer
//                              spends their one Mega Evolution in that battle.
//                              Temporary, chosen, and paid for in stats — the
//                              mechanic the games actually have.
//
// Types are untouched in both: they feed the type chart and the EXP curve, the
// two systems it would be most expensive to destabilise.
//
// Keyed by BASE species id, because every read is "given a speciesId, what
// megas?" — O(1) here, a full-array scan per party row otherwise.
//
//   key      the PokeAPI form slug. Unique, legible in a save file, and
//            verifiable against PokeAPI's own data — which is what makes a
//            stone unambiguous between Charizard X and Y.
//   spriteId the PokeAPI form id. Sprite filenames are bare integers, so these
//            live in the SAME four directories as every other sprite and need
//            no manifest or build.sh change. See sprites/PROVENANCE.md.
//   stone    what the player is told they won.
//   name     display name, used on nameplates and in battle logs.
//
// 96 forms across 86 species: the Gen 6 (X/Y + ORAS) wave plus the Legends Z-A
// wave. Nine species have more than one form and Tatsugiri has three, so
// nothing here may assume a form array of length 1 or 2.
//
// Stone names for the Gen 6 wave are canonical. The Z-A wave has no established
// stone names, so those are derived from the species name and are ours, not
// Nintendo's.
const MEGA_FORMS = {
       3: [{ key:'venusaur-mega', spriteId:10033, stone:'Venusaurite', name:'Mega Venusaur' }],
       6: [
        { key:'charizard-mega-x', spriteId:10034, stone:'Charizardite X', name:'Mega Charizard X' },
        { key:'charizard-mega-y', spriteId:10035, stone:'Charizardite Y', name:'Mega Charizard Y' }
    ],
       9: [{ key:'blastoise-mega', spriteId:10036, stone:'Blastoisinite', name:'Mega Blastoise' }],
      15: [{ key:'beedrill-mega', spriteId:10090, stone:'Beedrillite', name:'Mega Beedrill' }],
      18: [{ key:'pidgeot-mega', spriteId:10073, stone:'Pidgeotite', name:'Mega Pidgeot' }],
      26: [
        { key:'raichu-mega-x', spriteId:10304, stone:'Raichuite X', name:'Mega Raichu X' },
        { key:'raichu-mega-y', spriteId:10305, stone:'Raichuite Y', name:'Mega Raichu Y' }
    ],
      36: [{ key:'clefable-mega', spriteId:10278, stone:'Clefablite', name:'Mega Clefable' }],
      65: [{ key:'alakazam-mega', spriteId:10037, stone:'Alakazite', name:'Mega Alakazam' }],
      71: [{ key:'victreebel-mega', spriteId:10279, stone:'Victreebelite', name:'Mega Victreebel' }],
      80: [{ key:'slowbro-mega', spriteId:10071, stone:'Slowbronite', name:'Mega Slowbro' }],
      94: [{ key:'gengar-mega', spriteId:10038, stone:'Gengarite', name:'Mega Gengar' }],
     115: [{ key:'kangaskhan-mega', spriteId:10039, stone:'Kangaskhanite', name:'Mega Kangaskhan' }],
     121: [{ key:'starmie-mega', spriteId:10280, stone:'Starmite', name:'Mega Starmie' }],
     127: [{ key:'pinsir-mega', spriteId:10040, stone:'Pinsirite', name:'Mega Pinsir' }],
     130: [{ key:'gyarados-mega', spriteId:10041, stone:'Gyaradosite', name:'Mega Gyarados' }],
     142: [{ key:'aerodactyl-mega', spriteId:10042, stone:'Aerodactylite', name:'Mega Aerodactyl' }],
     149: [{ key:'dragonite-mega', spriteId:10281, stone:'Dragonitite', name:'Mega Dragonite' }],
     150: [
        { key:'mewtwo-mega-x', spriteId:10043, stone:'Mewtwonite X', name:'Mega Mewtwo X' },
        { key:'mewtwo-mega-y', spriteId:10044, stone:'Mewtwonite Y', name:'Mega Mewtwo Y' }
    ],
     154: [{ key:'meganium-mega', spriteId:10282, stone:'Meganite', name:'Mega Meganium' }],
     160: [{ key:'feraligatr-mega', spriteId:10283, stone:'Feraligite', name:'Mega Feraligatr' }],
     181: [{ key:'ampharos-mega', spriteId:10045, stone:'Ampharosite', name:'Mega Ampharos' }],
     208: [{ key:'steelix-mega', spriteId:10072, stone:'Steelixite', name:'Mega Steelix' }],
     212: [{ key:'scizor-mega', spriteId:10046, stone:'Scizorite', name:'Mega Scizor' }],
     214: [{ key:'heracross-mega', spriteId:10047, stone:'Heracronite', name:'Mega Heracross' }],
     227: [{ key:'skarmory-mega', spriteId:10284, stone:'Skarmoryite', name:'Mega Skarmory' }],
     229: [{ key:'houndoom-mega', spriteId:10048, stone:'Houndoominite', name:'Mega Houndoom' }],
     248: [{ key:'tyranitar-mega', spriteId:10049, stone:'Tyranitarite', name:'Mega Tyranitar' }],
     254: [{ key:'sceptile-mega', spriteId:10065, stone:'Sceptilite', name:'Mega Sceptile' }],
     257: [{ key:'blaziken-mega', spriteId:10050, stone:'Blazikenite', name:'Mega Blaziken' }],
     260: [{ key:'swampert-mega', spriteId:10064, stone:'Swampertite', name:'Mega Swampert' }],
     282: [{ key:'gardevoir-mega', spriteId:10051, stone:'Gardevoirite', name:'Mega Gardevoir' }],
     302: [{ key:'sableye-mega', spriteId:10066, stone:'Sablenite', name:'Mega Sableye' }],
     303: [{ key:'mawile-mega', spriteId:10052, stone:'Mawilite', name:'Mega Mawile' }],
     306: [{ key:'aggron-mega', spriteId:10053, stone:'Aggronite', name:'Mega Aggron' }],
     308: [{ key:'medicham-mega', spriteId:10054, stone:'Medichamite', name:'Mega Medicham' }],
     310: [{ key:'manectric-mega', spriteId:10055, stone:'Manectite', name:'Mega Manectric' }],
     319: [{ key:'sharpedo-mega', spriteId:10070, stone:'Sharpedonite', name:'Mega Sharpedo' }],
     323: [{ key:'camerupt-mega', spriteId:10087, stone:'Cameruptite', name:'Mega Camerupt' }],
     334: [{ key:'altaria-mega', spriteId:10067, stone:'Altarianite', name:'Mega Altaria' }],
     354: [{ key:'banette-mega', spriteId:10056, stone:'Banettite', name:'Mega Banette' }],
     358: [{ key:'chimecho-mega', spriteId:10306, stone:'Chimechoite', name:'Mega Chimecho' }],
     359: [
        { key:'absol-mega', spriteId:10057, stone:'Absolite', name:'Mega Absol' },
        { key:'absol-mega-z', spriteId:10307, stone:'Absolite Z', name:'Mega Absol Z' }
    ],
     362: [{ key:'glalie-mega', spriteId:10074, stone:'Glalitite', name:'Mega Glalie' }],
     373: [{ key:'salamence-mega', spriteId:10089, stone:'Salamencite', name:'Mega Salamence' }],
     376: [{ key:'metagross-mega', spriteId:10076, stone:'Metagrossite', name:'Mega Metagross' }],
     380: [{ key:'latias-mega', spriteId:10062, stone:'Latiasite', name:'Mega Latias' }],
     381: [{ key:'latios-mega', spriteId:10063, stone:'Latiosite', name:'Mega Latios' }],
     384: [{ key:'rayquaza-mega', spriteId:10079, stone:'Dragon Ascent', name:'Mega Rayquaza' }],
     398: [{ key:'staraptor-mega', spriteId:10308, stone:'Staraptorite', name:'Mega Staraptor' }],
     428: [{ key:'lopunny-mega', spriteId:10088, stone:'Lopunnite', name:'Mega Lopunny' }],
     445: [
        { key:'garchomp-mega', spriteId:10058, stone:'Garchompite', name:'Mega Garchomp' },
        { key:'garchomp-mega-z', spriteId:10309, stone:'Garchompite Z', name:'Mega Garchomp Z' }
    ],
     448: [
        { key:'lucario-mega', spriteId:10059, stone:'Lucarionite', name:'Mega Lucario' },
        { key:'lucario-mega-z', spriteId:10310, stone:'Lucarionite Z', name:'Mega Lucario Z' }
    ],
     460: [{ key:'abomasnow-mega', spriteId:10060, stone:'Abomasite', name:'Mega Abomasnow' }],
     475: [{ key:'gallade-mega', spriteId:10068, stone:'Galladite', name:'Mega Gallade' }],
     478: [{ key:'froslass-mega', spriteId:10285, stone:'Froslassite', name:'Mega Froslass' }],
     485: [{ key:'heatran-mega', spriteId:10311, stone:'Heatranite', name:'Mega Heatran' }],
     491: [{ key:'darkrai-mega', spriteId:10312, stone:'Darkraiite', name:'Mega Darkrai' }],
     500: [{ key:'emboar-mega', spriteId:10286, stone:'Emborite', name:'Mega Emboar' }],
     530: [{ key:'excadrill-mega', spriteId:10287, stone:'Excadrillite', name:'Mega Excadrill' }],
     531: [{ key:'audino-mega', spriteId:10069, stone:'Audinite', name:'Mega Audino' }],
     545: [{ key:'scolipede-mega', spriteId:10288, stone:'Scolipedite', name:'Mega Scolipede' }],
     560: [{ key:'scrafty-mega', spriteId:10289, stone:'Scraftyite', name:'Mega Scrafty' }],
     604: [{ key:'eelektross-mega', spriteId:10290, stone:'Eelektrite', name:'Mega Eelektross' }],
     609: [{ key:'chandelure-mega', spriteId:10291, stone:'Chandelurite', name:'Mega Chandelure' }],
     623: [{ key:'golurk-mega', spriteId:10313, stone:'Golurkite', name:'Mega Golurk' }],
     652: [{ key:'chesnaught-mega', spriteId:10292, stone:'Chesnaughtite', name:'Mega Chesnaught' }],
     655: [{ key:'delphox-mega', spriteId:10293, stone:'Delphoxite', name:'Mega Delphox' }],
     658: [{ key:'greninja-mega', spriteId:10294, stone:'Greninjaite', name:'Mega Greninja' }],
     668: [{ key:'pyroar-mega', spriteId:10295, stone:'Pyroarite', name:'Mega Pyroar' }],
     670: [{ key:'floette-mega', spriteId:10296, stone:'Floettite', name:'Mega Floette' }],
     678: [
        { key:'meowstic-male-mega', spriteId:10314, stone:'Meowsticite ♂', name:'Mega Meowstic ♂' },
        { key:'meowstic-female-mega', spriteId:10326, stone:'Meowsticite ♀', name:'Mega Meowstic ♀' }
    ],
     687: [{ key:'malamar-mega', spriteId:10297, stone:'Malamarite', name:'Mega Malamar' }],
     689: [{ key:'barbaracle-mega', spriteId:10298, stone:'Barbaraclite', name:'Mega Barbaracle' }],
     691: [{ key:'dragalge-mega', spriteId:10299, stone:'Dragalgite', name:'Mega Dragalge' }],
     701: [{ key:'hawlucha-mega', spriteId:10300, stone:'Hawluchaite', name:'Mega Hawlucha' }],
     719: [{ key:'diancie-mega', spriteId:10075, stone:'Diancite', name:'Mega Diancie' }],
     740: [{ key:'crabominable-mega', spriteId:10315, stone:'Crabominablite', name:'Mega Crabominable' }],
     768: [{ key:'golisopod-mega', spriteId:10316, stone:'Golisopodite', name:'Mega Golisopod' }],
     780: [{ key:'drampa-mega', spriteId:10302, stone:'Drampaite', name:'Mega Drampa' }],
     801: [
        { key:'magearna-mega', spriteId:10317, stone:'Magearnaite', name:'Mega Magearna' },
        { key:'magearna-original-mega', spriteId:10318, stone:'Magearnaite Original', name:'Mega Magearna (Original)' }
    ],
     807: [{ key:'zeraora-mega', spriteId:10319, stone:'Zeraoraite', name:'Mega Zeraora' }],
     870: [{ key:'falinks-mega', spriteId:10303, stone:'Falinksite', name:'Mega Falinks' }],
     952: [{ key:'scovillain-mega', spriteId:10320, stone:'Scovillainite', name:'Mega Scovillain' }],
     970: [{ key:'glimmora-mega', spriteId:10321, stone:'Glimmoraite', name:'Mega Glimmora' }],
     978: [
        { key:'tatsugiri-curly-mega', spriteId:10322, stone:'Tatsugirite Curly', name:'Mega Tatsugiri (Curly)' },
        { key:'tatsugiri-droopy-mega', spriteId:10323, stone:'Tatsugirite Droopy', name:'Mega Tatsugiri (Droopy)' },
        { key:'tatsugiri-stretchy-mega', spriteId:10324, stone:'Tatsugirite Stretchy', name:'Mega Tatsugiri (Stretchy)' }
    ],
     998: [{ key:'baxcalibur-mega', spriteId:10325, stone:'Baxcaliburite', name:'Mega Baxcalibur' }],
};

// Mega damage. Applied to the wild-battle damage rate while a mega is the
// active partner, and inside computeDamage in PVP. Deliberately one number in
// one place, so the two paths cannot drift apart.
const MEGA_DAMAGE_MULTIPLIER = 1.30;

/**
 * What Mega Evolution is worth in a PVP battle.
 *
 * Stats rather than a damage number, because that is where a real mega's power
 * comes from: roughly +100 BST over the base form, concentrated in whatever
 * that Pokémon is for. Mega Gyarados gains attack x1.24 and defense x1.38;
 * Mega Alakazam gains defense x1.44 and speed x1.25. These three factors are
 * the shape of that, averaged, rather than 96 hand-entered stat lines with
 * nothing in the repo to check them against.
 *
 * HP IS ABSENT ON PURPOSE. No mega in any game changes its HP, and a mega that
 * healed on transforming would also be a mega worth saving until you are nearly
 * dead — the wrong incentive entirely.
 *
 * Attack x1.25 also lands damage within a few percent of the flat 1.30x this
 * replaced, so the 8-15 turn pacing that was tuned around it survives. Unlike
 * that multiplier, this also makes the mega bulkier and faster, which is what
 * makes one feel like a mega rather than a stronger hit.
 */
const MEGA_STAT_BOOST = { attack: 1.25, defense: 1.15, speed: 1.10 };

// A PVP win draws a mega stone this often. The remaining 90% is split evenly
// between the three boosts, so the full table is 30/30/30/10.
const MEGA_STONE_CHANCE = 0.10;

// The stone itself, drawn rather than borrowed from a font. `\u25c6` is a
// generic diamond that reads as "some sparkly thing", and the emoji gems all
// render in a different visual language from the rest of the 8-bit UI. This is
// the canonical Mega Stone: a sphere split by a swirl, with the two lobes in
// the two mega colours. No `id` anywhere in it, because the same markup is
// stamped into the page more than once and duplicate ids would collide.
const MEGA_STONE_SVG = `<svg class="mega-stone-svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle class="ms-orb" cx="16" cy="16" r="14"/>
    <path class="ms-swirl" d="M16,2 a14,14 0 0,1 0,28 a7,7 0 0,1 0,-14 a7,7 0 0,0 0,-14 z"/>
    <circle class="ms-dot-a" cx="16" cy="9" r="2.3"/>
    <circle class="ms-dot-b" cx="16" cy="23" r="2.3"/>
    <path class="ms-shine" d="M7.4,12.2 a9.5,9.5 0 0,1 4.8,-4.8"/>
</svg>`;

/** The mega forms a species can take, or an empty array. */
function megaFormsFor(speciesId) {
    return MEGA_FORMS[speciesId] || [];
}

/**
 * Whether a species is the end of its line.
 *
 * NOT the same predicate as evolutionStage === 3, which is a hand-authored
 * field used only for encounter weighting: Raticate is stage 2 and has no
 * outgoing edge, so it is fully evolved while reporting stage 2. The edge list
 * is the truth.
 */
function isFullyEvolved(speciesId) {
    return !getEvolution(speciesId);
}

/** The form this species will actually reach, following the branch the game plays. */
function finalFormOf(speciesId) {
    const line = getEvolutionLine(speciesId);
    const last = line[line.length - 1];
    return last ? last.species.id : speciesId;
}

/**
 * Which species' mega stone this Pokémon is in line for, or null.
 *
 * Its own species wins over its final form, and that ordering is the whole
 * point: Floette has a mega but is NOT fully evolved, and its final form
 * (Florges) has none. Keying purely off finalFormOf would make a Floette
 * ineligible for the mega it can actually use. Returning the species that owns
 * the forms also gives the caller its answer for free — a stone is usable now
 * exactly when the source is the Pokémon's current species, and dormant when it
 * is something further down the line.
 */
function megaSourceFor(speciesId) {
    if (megaFormsFor(speciesId).length > 0) return speciesId;
    const final = finalFormOf(speciesId);
    if (final !== speciesId && megaFormsFor(final).length > 0) return final;
    return null;
}

/** Does this PVP win pay a stone rather than a boost? */
function rollMegaStone() {
    return Math.random() < MEGA_STONE_CHANCE;
}

// ─────────────────────────── Custom species ───────────────────────────
//
// Player-authored Pokemon from content/flickemon-custom.js. Deliberately NOT
// in POKEMON_REGISTRY: the Pokedex grid, the caught count and the encounter
// stage buckets all iterate that array, and a homemade Pokemon has no business
// in any of them. Everything else -- party, battles, PVP, trade -- resolves
// species through getSpeciesById, so joining there is all it takes to be a
// first-class Pokemon everywhere it matters.

// What a custom Pokemon is called on screen: a third rarity tag beside
// Legendary and Shiny, worn by every custom Pokemon automatically rather than
// opted into. Kept here rather than written into each render site, so renaming
// it is one edit.
const CUSTOM_LABEL = 'ตัวซีเคร็ท';
// The compact form, for nameplates and trade slots with no room for a word.
// Text presentation, like the ★ and ✦ it sits beside -- not an emoji.
const CUSTOM_MARK = '\u2756';

// How often a wild encounter is drawn from the custom roster instead of the
// real one. Applies ONLY to entries marked `wild: true`; with none marked, the
// branch never fires and the encounter table is exactly what it was.
//
// One in ten thousand, which at roughly 24 encounters an hour is one sighting
// per ~420 hours of lectures. That is deliberately a rumour rather than a drop
// rate: custom Pokemon are meant to be handed out by an admin over a trade, and
// this exists so that "could it just turn up?" has an answer other than no.
const CUSTOM_ENCOUNTER_CHANCE = 1 / 10000;

// Far above the mega forms (10033-10326) with room to spare, so nothing here
// can ever collide with a real dex number or a form id.
const CUSTOM_ID_BASE = 900000;
const CUSTOM_ID_RANGE = 100000;

/**
 * A stable id for a custom Pokemon, derived from its key.
 *
 * Derived rather than assigned by position, because position is exactly what
 * an author changes: inserting an entry at the top of the file would otherwise
 * renumber every Pokemon below it and silently turn every saved one into
 * something else. FNV-1a over the key -- the same trick the PVP codes use --
 * means the id depends on nothing but the name the author chose.
 */
function customIdFor(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return CUSTOM_ID_BASE + ((h >>> 0) % CUSTOM_ID_RANGE);
}

/**
 * Reads flickemon-custom.js into real species objects.
 *
 * One bad entry is skipped and named in the console rather than taken down the
 * whole roster with it -- the file is meant to be edited by hand, and a typo in
 * entry 4 must not cost you entries 1 to 3. Memoised because every party row
 * render asks for it.
 */
let customCache = null;
const customProblems = [];

function normalizeCustomRoster() {
    if (customCache) return customCache;

    const raw = (typeof window !== 'undefined' && Array.isArray(window.FlickemonCustom))
        ? window.FlickemonCustom : [];
    const chart = (typeof window !== 'undefined' && window.FlickemonBattle
                   && window.FlickemonBattle.TYPE_CHART) || null;

    const out = [];
    const seenKeys = new Set();
    const seenIds = new Map();
    customProblems.length = 0;
    const reject = (i, why) => customProblems.push(`entry ${i + 1}: ${why}`);

    raw.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') return reject(i, 'is not an entry');

        const key = typeof entry.key === 'string' ? entry.key.trim() : '';
        if (!key) return reject(i, 'needs a key');
        if (seenKeys.has(key)) return reject(i, `key "${key}" is already used above`);

        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) return reject(i, `"${key}" needs a name`);

        const types = Array.isArray(entry.types)
            ? entry.types.filter(t => typeof t === 'string').map(t => t.toLowerCase())
            : [];
        if (types.length < 1 || types.length > 2) {
            return reject(i, `"${key}" needs one or two types`);
        }
        // Only checked when the type chart is loaded; a config-only context
        // (the tests, the guide) must not fail for want of the battle module.
        if (chart) {
            const bad = types.find(t => !(t in chart));
            if (bad) return reject(i, `"${key}" has an unknown type "${bad}"`);
        }

        const st = entry.stats || {};
        const stat = (v) => Number.isFinite(v) && v >= 1 && v <= 255 ? Math.round(v) : null;
        const baseStats = {
            hp: stat(st.hp), attack: stat(st.attack),
            defense: stat(st.defense), speed: stat(st.speed),
        };
        if (Object.values(baseStats).some(v => v === null)) {
            return reject(i, `"${key}" needs hp, attack, defense and speed, each 1-255`);
        }

        if (typeof entry.sprite !== 'string' || !entry.sprite.trim()) {
            return reject(i, `"${key}" needs a sprite filename`);
        }

        const id = Number.isFinite(entry.id) ? entry.id : customIdFor(key);
        if (id < CUSTOM_ID_BASE || id >= CUSTOM_ID_BASE + CUSTOM_ID_RANGE) {
            return reject(i, `"${key}" has an id outside the custom range`);
        }
        if (seenIds.has(id)) {
            // Astronomically unlikely, but silence here would mean one Pokemon
            // quietly becoming another in an existing save.
            return reject(i, `"${key}" collides with "${seenIds.get(id)}" — rename one key`);
        }

        seenKeys.add(key);
        seenIds.set(id, key);
        out.push({
            id, key, name, types, baseStats,
            // Both spellings, because `isLegendary` is what the field is called
            // everywhere else in the codebase and `legendary` is what anyone
            // writing this file by hand types first.
            isLegendary: entry.isLegendary === true || entry.legendary === true,
            isCustom: true,
            // Only ones that ask for it are ever drawn in the wild, so a roster
            // that does not opt in changes nothing about the game.
            wild: entry.wild === true,
            sprite: entry.sprite.trim(),
            shinySprite: typeof entry.shinySprite === 'string' ? entry.shinySprite.trim() : null,
            backSprite: typeof entry.backSprite === 'string' ? entry.backSprite.trim() : null,
            evolvesTo: entry.evolvesTo != null ? entry.evolvesTo : null,
            evolvesAt: Number.isFinite(entry.evolvesAt) ? entry.evolvesAt : null,
            // Used only for the encounter stage buckets, which customs sit
            // outside of. Present so nothing downstream reads undefined.
            evolutionStage: entry.evolvesTo != null ? 1 : 3,
        });
    });

    if (customProblems.length && typeof console !== 'undefined') {
        console.warn('[Flickémon custom] skipped:\n  ' + customProblems.join('\n  '));
    }
    customCache = out;
    return customCache;
}

function customRoster() { return normalizeCustomRoster(); }
function customRosterProblems() { normalizeCustomRoster(); return [...customProblems]; }
function isCustomSpeciesId(id) {
    return Number.isFinite(id) && id >= CUSTOM_ID_BASE && id < CUSTOM_ID_BASE + CUSTOM_ID_RANGE;
}
function getCustomSpecies(id) {
    if (!isCustomSpeciesId(id)) return undefined;
    return normalizeCustomRoster().find(s => s.id === id);
}
function getCustomByKey(key) {
    return normalizeCustomRoster().find(s => s.key === key);
}

// ─────────────────────────── Helper Utilities ───────────────────────────

// 1,025 entries, and getSpeciesById is on the path of every party row, every
// battle tick and every Pokedex cell. Built once, on first use, because the
// registry is a const that is never mutated.
let registryById = null;

function getSpeciesById(id) {
    if (!registryById) {
        registryById = new Map(POKEMON_REGISTRY.map(p => [p.id, p]));
    }
    return registryById.get(id) || getCustomSpecies(id);
}

/** Species by name, across the real roster and the custom one. Case-insensitive. */
function getSpeciesByName(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return undefined;
    return POKEMON_REGISTRY.find(p => p.name.toLowerCase() === want)
        || normalizeCustomRoster().find(p => p.name.toLowerCase() === want);
}

function getSpeciesByStage(stage) {
    return POKEMON_REGISTRY.filter(p => p.evolutionStage === stage);
}

function getEvolution(fromId) {
    // A custom Pokemon carries its own evolution rather than living in
    // EVOLUTION_CHAINS, so that editing flickemon-custom.js never means
    // editing this file too. `evolvesTo` accepts another custom key or a plain
    // Pokedex number, which is what makes "my creature evolves into Dragonite"
    // one line instead of a schema.
    if (isCustomSpeciesId(fromId)) {
        const me = getCustomSpecies(fromId);
        if (!me || me.evolvesTo == null) return undefined;
        const toId = typeof me.evolvesTo === 'string'
            ? (getCustomByKey(me.evolvesTo) || {}).id
            : me.evolvesTo;
        if (!Number.isFinite(toId) || !getSpeciesById(toId)) return undefined;
        return { fromId, toId, level: me.evolvesAt || EVOLUTION_LEVELS.stage1ToStage2 };
    }
    return EVOLUTION_CHAINS.find(e => e.fromId === fromId);
}

function getAllEvolutions(fromId) {
    if (isCustomSpeciesId(fromId)) {
        const one = getEvolution(fromId);
        return one ? [one] : [];
    }
    return EVOLUTION_CHAINS.filter(e => e.fromId === fromId);
}

function canEvolveAt(fromId, level) {
    const evolution = getEvolution(fromId);
    if (evolution && level >= evolution.level) {
        return evolution;
    }
    return null;
}

/**
 * The chain a species will actually walk, in order, starting from `startId`.
 * Follows getEvolution (the same `find` the game uses), so a branching line
 * like Eevee's reports the single path the player will really get, with
 * `branches` recording how many alternatives exist at that step.
 *
 * Returns [{ species, evolvesAt, branches }]; `evolvesAt` is null on the final
 * form. The visited set guards against a malformed chain looping forever.
 */
function getEvolutionLine(startId) {
    const line = [];
    const visited = new Set();
    let currentId = startId;

    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const species = getSpeciesById(currentId);
        if (!species) break;

        const next = getEvolution(currentId);
        line.push({
            species,
            evolvesAt: next ? next.level : null,
            branches: getAllEvolutions(currentId).length,
        });
        currentId = next ? next.toId : null;
    }

    return line;
}

/** Sum of a species' base stats — a single number for comparing starters. */
function totalBaseStats(species) {
    const s = species && species.baseStats;
    return s ? s.hp + s.attack + s.defense + s.speed : 0;
}

// Expose globally for other extension scripts
// ─────────────────────────── Friends ───────────────────────────
//
// Pure helpers only. Everything here is a function of its arguments, which is
// what lets the rules for a username, a day boundary and a published label be
// tested without a browser, an account, or Firestore.

/**
 * How many friends one account may hold.
 *
 * A budget, not a social judgement. Reading friends' feeds costs one Firestore
 * read each, against a free tier of 50,000 a day shared by every student in the
 * faculty — so one person with 200 friends would spend a visible fraction of
 * everyone else's allowance. Thirty is more than anyone studies with.
 */
const FRIEND_MAX = 30;

/** Requests you may have outstanding. Stops the add screen being a spam tool. */
const FRIEND_REQUEST_MAX = 20;

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;

// Names that would let someone impersonate the game or a member of staff.
const RESERVED_USERNAMES = [
    'admin', 'administrator', 'flickemon', 'flick', 'docchula', 'staff',
    'moderator', 'mod', 'official', 'support', 'system', 'root', 'null',
    'undefined', 'me', 'you',
];

/**
 * The three things a student can choose to share, and what each one means in
 * plain words. The panel builds its own controls from this list, so adding a
 * fourth kind of sharing is one entry rather than a hunt through the UI.
 *
 * `key` is also the payload field name: what is published IS what is listed
 * here, which keeps the promise and the implementation the same object.
 */
const FRIEND_FIELDS = [
    { key: 'active', label: 'Online status',
      detail: 'Whether you are watching a lecture right now.' },
    { key: 'mon', label: 'Current Pokémon',
      detail: 'Which Pokémon you have out, its level and its stats.' },
    { key: 'today', label: "Today's progress",
      detail: 'EXP earned and levels gained today. Never how long you studied.' },
];

/** Sharing everything, which is what a new account starts with. */
function defaultFriendPrivacy() {
    const out = {};
    for (const f of FRIEND_FIELDS) out[f.key] = true;
    return out;
}

/**
 * Minutes a student counts as "studying now" after their last lecture tick.
 *
 * Generous on purpose: a pause to write a note, or a tab switch to look
 * something up, is still studying, and a status that flickers off every time
 * someone thinks is worse than no status at all.
 */
const FRIEND_ACTIVE_WINDOW_MS = 6 * 60 * 1000;

// ─────────────────────────── The day ───────────────────────────
//
// Every student's day rolls over together, on Bangkok time, regardless of what
// their device thinks the time is.
//
// Not device-local, for two reasons. A streak computed from local time can be
// farmed by moving the clock; and a shared leaderboard where one student's
// "today" started six hours before another's is not a comparison at all.
const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The YYYY-MM-DD a timestamp falls in, Bangkok time. */
function dayKeyFor(ts = Date.now()) {
    return new Date(ts + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

/** The day key `n` days before the one given. Used to walk a streak backwards. */
function dayKeyBefore(key, n = 1) {
    // The key is already a calendar date, so this is plain date arithmetic --
    // the ICT offset was applied when the key was made and must not be applied
    // twice. Going back through UTC midnight also steps over daylight saving,
    // which Bangkok does not observe but a device's local timezone might.
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) - (n * 86400000)).toISOString().slice(0, 10);
}

// How many days of progress a save keeps. Enough to show a streak worth having,
// short enough that the ledger never becomes the largest thing in the save.
const DAILY_HISTORY_DAYS = 14;

// ─────────────────────────── Usernames ───────────────────────────

/** The form a name is stored and compared in. Case and spacing never matter. */
function normaliseUsername(raw) {
    return String(raw == null ? '' : raw).trim().toLowerCase();
}

/**
 * Whether a name may be claimed, and why not when it may not.
 *
 * Returns a reason rather than a boolean because every rejection here is shown
 * to a student who is trying to do something reasonable, and "invalid" is not
 * an explanation.
 */
function validateUsername(raw) {
    const name = normaliseUsername(raw);
    if (!name) return { ok: false, reason: 'Pick a name first.' };
    if (name.length < USERNAME_MIN) {
        return { ok: false, reason: `At least ${USERNAME_MIN} characters.` };
    }
    if (name.length > USERNAME_MAX) {
        return { ok: false, reason: `At most ${USERNAME_MAX} characters.` };
    }
    if (!/^[a-z0-9._]+$/.test(name)) {
        return { ok: false, reason: 'Letters, numbers, dots and underscores only.' };
    }
    if (!/^[a-z0-9]/.test(name)) {
        return { ok: false, reason: 'Start with a letter or a number.' };
    }
    if (RESERVED_USERNAMES.includes(name)) {
        return { ok: false, reason: 'That name is reserved.' };
    }
    return { ok: true, name };
}

/**
 * The name published on the global board.
 *
 * A student who set a username gets it. One who did not gets the first three
 * characters of their address and nothing more — enough to recognise yourself
 * in a list, not enough for anyone else to identify you.
 *
 * The truncation happens HERE, before the write, and never at display time.
 * That is the whole point: a full address is never put into a document the
 * cohort can read, so there is nothing to leak even if a rule were wrong later.
 */
function leaderboardLabel(username, email) {
    const name = normaliseUsername(username);
    if (name) return name;
    const local = String(email || '').split('@')[0];
    if (!local) return 'anon';
    return local.slice(0, 3) + '…';
}

// ─────────────────────────── Streaks ───────────────────────────

/**
 * Consecutive days ending today on which any progress was made.
 *
 * Today not counting yet is deliberate: a streak that breaks at midnight before
 * anyone has had a chance to study would punish sleeping. So the walk starts at
 * today when today has progress, and at yesterday when it does not — which
 * means a streak survives until the day it is actually missed.
 */
function streakFrom(totalsByDay, todayKey = dayKeyFor()) {
    const has = (k) => (totalsByDay && totalsByDay[k] && totalsByDay[k].exp > 0);
    let cursor = has(todayKey) ? todayKey : dayKeyBefore(todayKey, 1);
    let streak = 0;
    while (has(cursor) && streak <= DAILY_HISTORY_DAYS) {
        streak++;
        cursor = dayKeyBefore(cursor, 1);
    }
    return streak;
}

// ─────────────────────────── Shop ───────────────────────────
//
// The late game had nothing to spend itself on. A student with a level 100
// partner and a wide Pokédex has met everything the encounter table can offer,
// and EXP — until now the only currency the game had — buys nothing once the
// ceiling is reached.
//
// So a defeated or captured Pokémon now also pays Poké Dollars, and the Poké
// Mart turns them into the things grinding cannot produce: an egg of a chosen
// evolution stage, a Mega Stone for a species of your choosing, and three
// permanent boosts that stack on top of the temporary ones PVP hands out.
//
// ── Why money is a TIME currency and not a POWER one ──
//
// Every award below is flat. Not scaled by wild level, not scaled by your
// level, and — this is the important one — never multiplied by any boost, PVP
// or shop. Two consequences follow, and both are the point:
//
//   1. Every price can be quoted honestly in hours of lectures, for every
//      student, at every level. "100 hours" means 100 hours whoever reads it.
//   2. The Legendary and Shiny boosts sold here raise how often rare things
//      appear. If rarity paid a bonus, those boosts would multiply the income
//      that buys them, and a maxed Legendary booster would earn several times
//      the honest rate. A flat award closes that loop completely.
//
// Anyone tempted to pay a shiny a bonus should read that twice first.

const BATTLE_WIN_MONEY = 5;

// Paid on top of the win, capture mode only, and only when the catch roll
// actually lands. Capture mode gives up half the EXP of exp mode; paying it a
// little more money keeps the choice between the two a real one rather than a
// tax on wanting a Pokédex.
const CAPTURE_MONEY_BONUS = 2;

// An abandoned fight still pays, for the same reason ESCAPE_EXP_MULTIPLIER
// exists — and stays far below a win, for the same reason too.
const ESCAPE_MONEY = 1;

// What an hour of lectures is worth, for pricing.
//
// Deliberately BETWEEN the two measured rates in BALANCE_REFERENCE rather than
// equal to either. Capture mode earns 116/h and exp mode 101/h, and a single
// price list has to be honest to both: at 110 a capture-mode student earns
// slightly faster than the label promises and an exp-mode one slightly slower,
// which is the right way round — exp mode already bought its advantage in
// levelling speed.
//
// tests/test_guide.js re-measures both rates against the real engine and fails
// if either drifts more than 15%, so the hours on the price tags cannot quietly
// stop being true.
const SHOP_PRICE_PER_HOUR = 110;

/** Hours of lectures, as a price. */
function priceForHours(hours) {
    return Math.round(hours * SHOP_PRICE_PER_HOUR);
}

const SHOP_ITEM_KINDS = { EGG: 'egg', STONE: 'stone', BOOST: 'boost' };

/**
 * Everything the mart sells, in the order it is shown.
 *
 * The panel builds itself from this list — prices, blurbs, tabs and all — so
 * adding an item is one entry here rather than a hunt through the UI. Same
 * property FRIEND_FIELDS has, and for the same reason.
 *
 * `hours` is the authored number and `price` is derived from it, never the
 * other way round: the balance conversation is always about hours.
 */
const SHOP_ITEMS = [
    {
        id: 'egg-stage1', kind: SHOP_ITEM_KINDS.EGG, stage: 1,
        label: 'Stage 1 Egg', icon: '○',
        detail: 'Hatches into a random unevolved Pokémon.',
        hours: 10, price: priceForHours(10), hatchEncounters: 20,
    },
    {
        id: 'egg-stage2', kind: SHOP_ITEM_KINDS.EGG, stage: 2,
        label: 'Stage 2 Egg', icon: '◐',
        detail: 'Hatches into a random once-evolved Pokémon.',
        hours: 30, price: priceForHours(30), hatchEncounters: 40,
    },
    {
        id: 'egg-stage3', kind: SHOP_ITEM_KINDS.EGG, stage: 3,
        label: 'Stage 3 Egg', icon: '●',
        detail: 'Hatches into a random fully evolved Pokémon.',
        hours: 50, price: priceForHours(50), hatchEncounters: 60,
    },
    {
        id: 'egg-rare', kind: SHOP_ITEM_KINDS.EGG, stage: 'rare',
        label: 'Rare Egg', icon: '✦',
        detail: 'Hatches into a legendary, or a shiny. Yours for good either way.',
        hours: 100, price: priceForHours(100), hatchEncounters: 100,
    },
    {
        id: 'mega-stone', kind: SHOP_ITEM_KINDS.STONE,
        label: 'Mega Stone', icon: '◈',
        detail: 'Choose the stone. Every Pokémon of that species can Mega Evolve.',
        hours: 100, price: priceForHours(100),
    },
];

/**
 * What a boost costs at each tier, and what it is worth.
 *
 * Three tiers, and the cost doubles each time: reaching the top of one boost is
 * 1,400 hours, and all three is 4,200 — a target measured in years of a degree
 * rather than a weekend, which is the only honest shape for a permanent effect.
 * The first tier is deliberately reachable at 200 hours so the ladder starts
 * somewhere a student can actually see from where they stand.
 *
 * Indexed by tier, so [0] is "not owned yet" and reads as x1 / no price.
 */
const SHOP_BOOST_TIERS = [
    { tier: 0, hours: 0,   price: 0 },
    { tier: 1, hours: 200, price: priceForHours(200) },
    { tier: 2, hours: 400, price: priceForHours(400) },
    { tier: 3, hours: 800, price: priceForHours(800) },
];

const SHOP_MAX_BOOST_TIER = 3;

/**
 * The permanent multipliers, indexed by tier.
 *
 * These MULTIPLY the temporary PVP reward rather than replacing it — a maxed
 * EXP boost during a PVP Double EXP is x4 — which is the whole reason to keep
 * winning battles after buying one.
 *
 * EXP tops out at x2 because that is already what Double EXP is worth, and a
 * permanent version of the game's biggest reward is enough. Shiny and Legendary
 * top out at x5 because both are clamped downstream anyway (MAX_SHINY_CHANCE
 * and the 0.5 ceiling in rollWildPokemon), so a larger number here would only
 * be a number.
 */
const SHOP_BOOST_MULTIPLIERS = {
    [REWARDS.EXP]:       [1, 1.25, 1.5, 2],
    [REWARDS.SHINY]:     [1, 2, 3, 5],
    [REWARDS.LEGENDARY]: [1, 2, 3, 5],
};

/**
 * The three boosts as the shop shows them.
 *
 * Keyed by the SAME ids PVP uses, so the two systems share one vocabulary and
 * the panel can reuse REWARD_INFO's labels and icons instead of inventing a
 * second set that would drift.
 */
const SHOP_BOOSTS = [
    { id: REWARDS.EXP,       reward: REWARDS.EXP,
      detail: 'Every EXP gain is multiplied, for good.' },
    { id: REWARDS.SHINY,     reward: REWARDS.SHINY,
      detail: 'Shiny encounters stay more likely, for good.' },
    { id: REWARDS.LEGENDARY, reward: REWARDS.LEGENDARY,
      detail: 'Legendary encounters stay more likely, for good (Lv40+).' },
];

function shopItemById(id) {
    return SHOP_ITEMS.find(i => i.id === id) || null;
}

/** What the NEXT tier of a boost costs, or null when it is already maxed. */
function nextBoostTier(currentTier) {
    const next = (Number(currentTier) || 0) + 1;
    return next <= SHOP_MAX_BOOST_TIER ? SHOP_BOOST_TIERS[next] : null;
}

/** A permanent boost's multiplier at a tier. Unknown kinds are simply x1. */
function shopBoostMultiplier(kind, tier) {
    const ladder = SHOP_BOOST_MULTIPLIERS[kind];
    if (!ladder) return 1;
    const t = Math.max(0, Math.min(SHOP_MAX_BOOST_TIER, Math.floor(Number(tier) || 0)));
    return ladder[t] || 1;
}

/**
 * A price or a balance, ready to render.
 *
 * Formatted here rather than in the panel for the reason PVP_MODES carries
 * rewardLabel: the UI should never be the place a number gets its units, or
 * two screens will eventually disagree about what one is.
 */
function formatMoney(amount) {
    const n = Math.max(0, Math.floor(Number(amount) || 0));
    return '₽' + n.toLocaleString('en-US');
}

/** The same figure said in the units the prices were authored in. */
function hoursForPrice(amount) {
    return (Number(amount) || 0) / SHOP_PRICE_PER_HOUR;
}

/**
 * What is inside an egg, decided when it is BOUGHT rather than when it hatches.
 *
 * That is not flavour, it is the merge rule. An egg bought on a laptop and
 * hatched on a phone has to produce the same Pokémon on both, or syncing hands
 * the student two of them — so the roll has to happen once, at a point both
 * devices agree on, and travel in the save. Purchase is that point.
 *
 * Legendaries are excluded from the stage eggs on purpose: they are what the
 * Rare Egg is for, and letting a 10-hour egg produce one would make the
 * 100-hour one pointless.
 */
function rollEggContents(itemId) {
    const item = shopItemById(itemId);
    if (!item || item.kind !== SHOP_ITEM_KINDS.EGG) return null;

    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    if (item.stage === 'rare') {
        // Half a legendary, half a shiny. Drawn from the same legendary pool
        // rollWildPokemon uses, so the two can never disagree about what counts.
        const legendaries = POKEMON_REGISTRY.filter(s => s.isLegendary);
        if (Math.random() < 0.5 && legendaries.length) {
            return { speciesId: pick(legendaries).id, shiny: false };
        }
        const ordinary = POKEMON_REGISTRY.filter(s => !s.isLegendary);
        return { speciesId: pick(ordinary).id, shiny: true };
    }

    const pool = getSpeciesByStage(item.stage).filter(s => !s.isLegendary);
    if (!pool.length) return null;
    // A shop egg rolls its own shiny chance, unmodified by any boost — the
    // boosts are about what you MEET in the wild, and an egg is not an encounter.
    return { speciesId: pick(pool).id, shiny: Math.random() < SHINY_CHANCE };
}

/** Every mega form that exists, flattened, for the stone picker. */
function allMegaForms() {
    const out = [];
    for (const [speciesId, forms] of Object.entries(MEGA_FORMS)) {
        for (const form of forms) out.push({ ...form, speciesId: Number(speciesId) });
    }
    return out;
}

window.FlickemonConfig = {
    SPRITE_BASE_URL,
    getSpriteUrl,
    getBackSpriteUrl,
    getAssetUrl,
    SHINY_CHANCE,
    rollShiny,
    BALANCE_REFERENCE,
    REWARD_DURATION_MS,
    PVP_LOSS_LOCKOUT_MS,
    MEGA_FORMS,
    MEGA_DAMAGE_MULTIPLIER,
    MEGA_STAT_BOOST,
    MEGA_STONE_CHANCE,
    MEGA_STONE_SVG,
    megaFormsFor,
    FRIEND_MAX,
    FRIEND_REQUEST_MAX,
    FRIEND_FIELDS,
    FRIEND_ACTIVE_WINDOW_MS,
    defaultFriendPrivacy,
    USERNAME_MIN,
    USERNAME_MAX,
    RESERVED_USERNAMES,
    normaliseUsername,
    validateUsername,
    leaderboardLabel,
    ICT_OFFSET_MS,
    DAILY_HISTORY_DAYS,
    dayKeyFor,
    dayKeyBefore,
    streakFrom,
    MAX_SHINY_CHANCE,
    BATTLE_WIN_MONEY,
    CAPTURE_MONEY_BONUS,
    ESCAPE_MONEY,
    SHOP_PRICE_PER_HOUR,
    SHOP_ITEM_KINDS,
    SHOP_ITEMS,
    SHOP_BOOSTS,
    SHOP_BOOST_TIERS,
    SHOP_BOOST_MULTIPLIERS,
    SHOP_MAX_BOOST_TIER,
    priceForHours,
    shopItemById,
    nextBoostTier,
    shopBoostMultiplier,
    formatMoney,
    hoursForPrice,
    rollEggContents,
    allMegaForms,
    isFullyEvolved,
    finalFormOf,
    megaSourceFor,
    rollMegaStone,
    REWARDS,
    REWARD_INFO,
    REWARD_EXP_MULTIPLIER,
    REWARD_LEGENDARY_MULTIPLIER,
    REWARD_SHINY_MULTIPLIER,
    PVP_MODES,
    PVP_TURN_LIMIT,
    pvpTurnLimit,
    pvpStallWinner,
    DEFAULT_PVP_MODE,
    PVP_RULES_VERSION,
    getPvpMode,
    rollReward,
    formatCountdown,
    EXP_PER_MINUTE,
    BATTLE_WIN_EXP_BONUS,
    EXP_MODE_WIN_EXP_BONUS,
    ESCAPE_EXP_MULTIPLIER,
    CAPTURE_CHANCE,
    INSTANT_CAPTURE_EXP_DEBT,
    BATTLE_MODES,
    MAX_TEAM_SIZE,
    MAX_PARTY_SIZE,
    TEAM_EXP_SHARE,
    calculateRealMaxHp,
    calculateRealStat,
    expForLevel,
    levelFromExp,
    MAX_LEVEL,
    EVOLUTION_LEVELS,
    ENCOUNTER_STAGE_WEIGHTS,
    ENCOUNTER_TIERS,
    CUSTOM_LABEL,
    CUSTOM_MARK,
    CUSTOM_ID_BASE,
    CUSTOM_ID_RANGE,
    CUSTOM_ENCOUNTER_CHANCE,
    customIdFor,
    customRoster,
    customRosterProblems,
    isCustomSpeciesId,
    getCustomSpecies,
    getCustomByKey,
    getSpeciesByName,
    encounterTierFor,
    encounterWeightsFor,
    POKEMON_REGISTRY,
    EVOLUTION_CHAINS,
    STARTER_OPTIONS,
    getSpeciesById,
    getSpeciesByStage,
    getEvolution,
    getAllEvolutions,
    canEvolveAt,
    getEvolutionLine,
    totalBaseStats,
};
