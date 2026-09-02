/**
 * Flickémon Battle Core
 * ─────────────────────
 * Pure battle logic: type effectiveness, moves, damage, status, turn order.
 * No DOM, no network, no randomness of its own — every roll comes from a seeded
 * RNG so that two clients resolving the same turn independently reach an
 * identical result. That is what makes PVP work without a server referee.
 *
 * Deliberately excludes items, per the design.
 */

// ─────────────────────────── Type Chart ───────────────────────────
// Only non-1x matchups are listed; anything absent is 1x.
const TYPE_CHART = {
    normal:   { rock: 0.5, ghost: 0, steel: 0.5 },
    fire:     { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
    water:    { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
    electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
    grass:    { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
    ice:      { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
    fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
    poison:   { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
    ground:   { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
    flying:   { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
    psychic:  { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
    bug:      { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
    rock:     { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
    ghost:    { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
    dragon:   { dragon: 2, steel: 0.5, fairy: 0 },
    dark:     { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
    steel:    { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
    fairy:    { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

/** Combined multiplier of `atkType` against a defender's type list. */
function typeEffectiveness(atkType, defTypes) {
    // Struggle is typeless: neither resisted nor boosted by anything.
    if (atkType === 'typeless') return 1;
    const row = TYPE_CHART[atkType] || {};
    return (defTypes || []).reduce((mult, t) => mult * (row[t] === undefined ? 1 : row[t]), 1);
}

// ─────────────────────────── Moves ───────────────────────────
//
// A curated pool rather than the full national move list. Real learnsets for
// 1025 species would add megabytes to a file that ships with the extension, for
// a battle system that only needs four slots per Pokémon. Every type has a
// reliable move, a strong move, and (mostly) a status move, so matchups still
// turn on type strategy the way they should.
//
// effect: 'burn' | 'paralyze' | 'poison' | 'flinch' | null
// chance: probability the effect lands, when the move also deals damage.

const MOVES = [
    // Normal — available to everyone as filler
    { id: 'tackle',      name: 'Tackle',       type: 'normal',   power: 40,  accuracy: 100, pp: 35 },
    { id: 'body-slam',   name: 'Body Slam',    type: 'normal',   power: 85,  accuracy: 100, pp: 15, effect: 'paralyze', chance: 0.3 },
    { id: 'hyper-beam',  name: 'Hyper Beam',   type: 'normal',   power: 150, accuracy: 90,  pp: 5,  recoilUser: 0.25 },
    { id: 'quick-attack',name: 'Quick Attack', type: 'normal',   power: 40,  accuracy: 100, pp: 30, priority: 1 },

    { id: 'ember',       name: 'Ember',        type: 'fire',     power: 40,  accuracy: 100, pp: 25, effect: 'burn', chance: 0.1 },
    { id: 'flamethrower',name: 'Flamethrower', type: 'fire',     power: 90,  accuracy: 100, pp: 15, effect: 'burn', chance: 0.1 },
    { id: 'fire-blast',  name: 'Fire Blast',   type: 'fire',     power: 110, accuracy: 85,  pp: 5,  effect: 'burn', chance: 0.3 },

    { id: 'water-gun',   name: 'Water Gun',    type: 'water',    power: 40,  accuracy: 100, pp: 25 },
    { id: 'surf',        name: 'Surf',         type: 'water',    power: 90,  accuracy: 100, pp: 15 },
    { id: 'hydro-pump',  name: 'Hydro Pump',   type: 'water',    power: 110, accuracy: 80,  pp: 5 },

    { id: 'thunder-shock',name:'Thunder Shock',type: 'electric', power: 40,  accuracy: 100, pp: 30, effect: 'paralyze', chance: 0.1 },
    { id: 'thunderbolt', name: 'Thunderbolt',  type: 'electric', power: 90,  accuracy: 100, pp: 15, effect: 'paralyze', chance: 0.1 },
    { id: 'thunder-wave',name: 'Thunder Wave', type: 'electric', power: 0,   accuracy: 90,  pp: 20, effect: 'paralyze', chance: 1 },

    { id: 'vine-whip',   name: 'Vine Whip',    type: 'grass',    power: 45,  accuracy: 100, pp: 25 },
    { id: 'razor-leaf',  name: 'Razor Leaf',   type: 'grass',    power: 55,  accuracy: 95,  pp: 25, critBonus: true },
    { id: 'solar-beam',  name: 'Solar Beam',   type: 'grass',    power: 120, accuracy: 100, pp: 10 },

    { id: 'ice-shard',   name: 'Ice Shard',    type: 'ice',      power: 40,  accuracy: 100, pp: 30, priority: 1 },
    { id: 'ice-beam',    name: 'Ice Beam',     type: 'ice',      power: 90,  accuracy: 100, pp: 10 },
    { id: 'blizzard',    name: 'Blizzard',     type: 'ice',      power: 110, accuracy: 70,  pp: 5 },

    { id: 'karate-chop', name: 'Karate Chop',  type: 'fighting', power: 50,  accuracy: 100, pp: 25, critBonus: true },
    { id: 'brick-break', name: 'Brick Break',  type: 'fighting', power: 75,  accuracy: 100, pp: 15 },
    { id: 'close-combat',name: 'Close Combat', type: 'fighting', power: 120, accuracy: 100, pp: 5,  selfDefenseDrop: true },

    { id: 'poison-sting',name: 'Poison Sting', type: 'poison',   power: 15,  accuracy: 100, pp: 35, effect: 'poison', chance: 0.3 },
    { id: 'sludge-bomb', name: 'Sludge Bomb',  type: 'poison',   power: 90,  accuracy: 100, pp: 10, effect: 'poison', chance: 0.3 },
    { id: 'toxic',       name: 'Toxic',        type: 'poison',   power: 0,   accuracy: 90,  pp: 10, effect: 'poison', chance: 1 },

    { id: 'mud-slap',    name: 'Mud-Slap',     type: 'ground',   power: 20,  accuracy: 100, pp: 10 },
    { id: 'dig',         name: 'Dig',          type: 'ground',   power: 80,  accuracy: 100, pp: 10 },
    { id: 'earthquake',  name: 'Earthquake',   type: 'ground',   power: 100, accuracy: 100, pp: 10 },

    { id: 'gust',        name: 'Gust',         type: 'flying',   power: 40,  accuracy: 100, pp: 35 },
    { id: 'wing-attack', name: 'Wing Attack',  type: 'flying',   power: 60,  accuracy: 100, pp: 35 },
    { id: 'air-slash',   name: 'Air Slash',    type: 'flying',   power: 75,  accuracy: 95,  pp: 15, effect: 'flinch', chance: 0.3 },

    { id: 'confusion',   name: 'Confusion',    type: 'psychic',  power: 50,  accuracy: 100, pp: 25 },
    { id: 'psybeam',     name: 'Psybeam',      type: 'psychic',  power: 65,  accuracy: 100, pp: 20 },
    { id: 'psychic',     name: 'Psychic',      type: 'psychic',  power: 90,  accuracy: 100, pp: 10 },

    { id: 'bug-bite',    name: 'Bug Bite',     type: 'bug',      power: 60,  accuracy: 100, pp: 20 },
    { id: 'x-scissor',   name: 'X-Scissor',    type: 'bug',      power: 80,  accuracy: 100, pp: 15 },
    { id: 'megahorn',    name: 'Megahorn',     type: 'bug',      power: 120, accuracy: 85,  pp: 10 },

    { id: 'rock-throw',  name: 'Rock Throw',   type: 'rock',     power: 50,  accuracy: 90,  pp: 15 },
    { id: 'rock-slide',  name: 'Rock Slide',   type: 'rock',     power: 75,  accuracy: 90,  pp: 10, effect: 'flinch', chance: 0.3 },
    { id: 'stone-edge',  name: 'Stone Edge',   type: 'rock',     power: 100, accuracy: 80,  pp: 5,  critBonus: true },

    { id: 'lick',        name: 'Lick',         type: 'ghost',    power: 30,  accuracy: 100, pp: 30, effect: 'paralyze', chance: 0.3 },
    { id: 'shadow-ball', name: 'Shadow Ball',  type: 'ghost',    power: 80,  accuracy: 100, pp: 15 },
    { id: 'shadow-claw', name: 'Shadow Claw',  type: 'ghost',    power: 70,  accuracy: 100, pp: 15, critBonus: true },

    { id: 'dragon-breath',name:'Dragon Breath',type: 'dragon',   power: 60,  accuracy: 100, pp: 20, effect: 'paralyze', chance: 0.3 },
    { id: 'dragon-claw', name: 'Dragon Claw',  type: 'dragon',   power: 80,  accuracy: 100, pp: 15 },
    { id: 'outrage',     name: 'Outrage',      type: 'dragon',   power: 120, accuracy: 100, pp: 10 },

    { id: 'bite',        name: 'Bite',         type: 'dark',     power: 60,  accuracy: 100, pp: 25, effect: 'flinch', chance: 0.3 },
    { id: 'crunch',      name: 'Crunch',       type: 'dark',     power: 80,  accuracy: 100, pp: 15 },
    { id: 'dark-pulse',  name: 'Dark Pulse',   type: 'dark',     power: 80,  accuracy: 100, pp: 15, effect: 'flinch', chance: 0.2 },

    { id: 'metal-claw',  name: 'Metal Claw',   type: 'steel',    power: 50,  accuracy: 95,  pp: 35 },
    { id: 'iron-head',   name: 'Iron Head',    type: 'steel',    power: 80,  accuracy: 100, pp: 15, effect: 'flinch', chance: 0.3 },
    { id: 'flash-cannon',name: 'Flash Cannon', type: 'steel',    power: 80,  accuracy: 100, pp: 10 },

    { id: 'fairy-wind',  name: 'Fairy Wind',   type: 'fairy',    power: 40,  accuracy: 100, pp: 30 },
    { id: 'draining-kiss',name:'Draining Kiss',type: 'fairy',    power: 50,  accuracy: 100, pp: 10, drain: 0.5 },
    { id: 'moonblast',   name: 'Moonblast',    type: 'fairy',    power: 95,  accuracy: 100, pp: 15 },
];

// ── Tactical moves ──
//
// Everything above is "pick the biggest number". These are the turns you spend
// on something other than damage, and they are where a battle stops being an
// exchange of hit points and starts being a decision. Every type gets at least
// one, so no line is locked out of playing that way.
const TACTICAL_MOVES = [
    // Setup: trade this turn for every turn after it.
    { id: 'swords-dance', name: 'Swords Dance', type: 'normal', power: 0, accuracy: 100, pp: 20,
      stages: { attack: 2 }, stagesTarget: 'self' },
    { id: 'agility',      name: 'Agility',      type: 'psychic', power: 0, accuracy: 100, pp: 30,
      stages: { speed: 2 }, stagesTarget: 'self' },
    { id: 'iron-defense', name: 'Iron Defense', type: 'steel',   power: 0, accuracy: 100, pp: 15,
      stages: { defense: 2 }, stagesTarget: 'self' },
    { id: 'calm-mind',    name: 'Calm Mind',    type: 'psychic', power: 0, accuracy: 100, pp: 20,
      stages: { attack: 1, defense: 1 }, stagesTarget: 'self' },
    { id: 'dragon-dance', name: 'Dragon Dance', type: 'dragon',  power: 0, accuracy: 100, pp: 20,
      stages: { attack: 1, speed: 1 }, stagesTarget: 'self' },

    // Control: make the other side worse instead of yourself better.
    { id: 'growl',        name: 'Growl',        type: 'normal',  power: 0, accuracy: 100, pp: 40,
      stages: { attack: -1 } },
    { id: 'screech',      name: 'Screech',      type: 'normal',  power: 0, accuracy: 85,  pp: 40,
      stages: { defense: -2 } },
    { id: 'string-shot',  name: 'String Shot',  type: 'bug',     power: 0, accuracy: 95,  pp: 40,
      stages: { speed: -2 } },
    { id: 'sand-attack',  name: 'Sand Attack',  type: 'ground',  power: 0, accuracy: 100, pp: 15,
      stages: { attack: -1, speed: -1 } },

    // Status: whole turns taken off the opponent.
    { id: 'sleep-powder', name: 'Sleep Powder', type: 'grass',   power: 0, accuracy: 75,  pp: 15,
      effect: 'sleep', chance: 1 },
    { id: 'hypnosis',     name: 'Hypnosis',     type: 'psychic', power: 0, accuracy: 60,  pp: 20,
      effect: 'sleep', chance: 1 },
    { id: 'toxic',        name: 'Toxic',        type: 'poison',  power: 0, accuracy: 90,  pp: 10,
      effect: 'toxic', chance: 1 },
    { id: 'will-o-wisp',  name: 'Will-O-Wisp',  type: 'fire',    power: 0, accuracy: 85,  pp: 15,
      effect: 'burn', chance: 1 },
    { id: 'confuse-ray',  name: 'Confuse Ray',  type: 'ghost',   power: 0, accuracy: 100, pp: 10,
      effect: 'confuse', chance: 1 },
    { id: 'sweet-kiss',   name: 'Sweet Kiss',   type: 'fairy',   power: 0, accuracy: 75,  pp: 10,
      effect: 'confuse', chance: 1 },
    { id: 'icy-wind',     name: 'Icy Wind',     type: 'ice',     power: 55, accuracy: 95, pp: 15,
      stages: { speed: -1 } },
    { id: 'rock-tomb',    name: 'Rock Tomb',    type: 'rock',    power: 60, accuracy: 95, pp: 15,
      stages: { speed: -1 } },
    { id: 'aurora-beam',  name: 'Aurora Beam',  type: 'ice',     power: 65, accuracy: 100, pp: 20,
      stages: { attack: -1 }, stageChance: 0.3 },
    { id: 'crunch',       name: 'Crunch',       type: 'dark',    power: 80, accuracy: 100, pp: 15,
      stages: { defense: -1 }, stageChance: 0.2 },
    { id: 'low-sweep',    name: 'Low Sweep',    type: 'fighting', power: 65, accuracy: 100, pp: 20,
      stages: { speed: -1 } },
    { id: 'mud-shot',     name: 'Mud Shot',     type: 'ground',  power: 55, accuracy: 95,  pp: 15,
      stages: { speed: -1 } },
    { id: 'bubble-beam',  name: 'Bubble Beam',  type: 'water',   power: 65, accuracy: 100, pp: 20,
      stages: { speed: -1 }, stageChance: 0.3 },
    { id: 'charm',        name: 'Charm',        type: 'fairy',   power: 0,  accuracy: 100, pp: 20,
      stages: { attack: -2 } },
    { id: 'thunder-fang', name: 'Thunder Fang', type: 'electric', power: 65, accuracy: 95, pp: 15,
      effect: 'paralyze', chance: 0.1 },

    // Recovery: the reason a defensive setup can actually win.
    //
    // 5 PP, not 10 — which is both what Gen 9 uses and what keeps a match
    // finite. At 10 PP two healers could trade 50% restores for long enough to
    // push a 3v3 past 200 turns, which is nobody's idea of a lunch break.
    { id: 'recover',      name: 'Recover',      type: 'normal',  power: 0, accuracy: 100, pp: 5,
      heal: 0.5 },
    { id: 'roost',        name: 'Roost',        type: 'flying',  power: 0, accuracy: 100, pp: 5,
      heal: 0.5 },
    { id: 'synthesis',    name: 'Synthesis',    type: 'grass',   power: 0, accuracy: 100, pp: 5,
      heal: 0.5 },
];

MOVES.push(...TACTICAL_MOVES);

const MOVES_BY_ID = MOVES.reduce((m, mv) => { m[mv.id] = mv; return m; }, {});
const getMove = id => MOVES_BY_ID[id] || null;

/**
 * The four moves a species knows.
 *
 * Chosen from the species' own types (so STAB matters), strongest first, then
 * padded with Normal moves. Fully deterministic: both players must derive the
 * same moveset for the same Pokémon or the battle would desync.
 */
const TACTICAL_IDS = new Set(TACTICAL_MOVES.map(m => m.id));

/**
 * Four moves for a species at a level, chosen the same way on both clients.
 *
 * Three slots of damage and one tactical slot. Reserving that fourth slot is
 * the point: sorting purely by power would fill every set with attacks, since
 * a setup or status move has no power to sort by, and a battle of nothing but
 * attacks has no decisions in it.
 *
 * Deterministic by construction — no RNG, and ties broken by id — because both
 * clients build this independently and must agree exactly.
 */
function getMovesetFor(species, level = 50) {
    if (!species) return [];

    // Higher-powered moves unlock with level, so a level 5 Pokémon can't open
    // with Hyper Beam.
    const powerAllowed = m => (m.power || 0) <= Math.max(40, level * 2.2);

    // Sleep takes whole turns away from the other player, which is too swingy
    // for the early game where a battle is only a few turns long anyway.
    const SLEEP_LEVEL = 25;
    const tacticalAllowed = m => m.effect !== 'sleep' || level >= SLEEP_LEVEL;

    const byPowerThenId = (a, b) => (b.power - a.power) || a.id.localeCompare(b.id);
    const own = MOVES.filter(m => species.types.includes(m.type));
    const normals = MOVES.filter(m => m.type === 'normal');

    const picked = [];
    const push = (m, cap) => {
        if (m && picked.length < cap && !picked.some(p => p.id === m.id)) picked.push(m);
    };

    // Three damaging slots: own types first, then Normal as filler.
    const attacks = m => m.power > 0 && powerAllowed(m);
    own.filter(attacks).sort(byPowerThenId).forEach(m => push(m, 3));
    normals.filter(attacks).sort(byPowerThenId).forEach(m => push(m, 3));
    push(getMove('tackle'), 3);          // a usable move even at level 1

    // One tactical slot, taken from the species' OWN types before falling back
    // to Normal. Sorting the two pools together instead handed almost every
    // line Growl, because "growl" sorts ahead of "sleep-powder" — which made
    // every Pokémon play the same way regardless of type.
    const tacticalFrom = pool => pool
        .filter(m => TACTICAL_IDS.has(m.id) && tacticalAllowed(m))
        .sort((a, b) => a.id.localeCompare(b.id))[0];
    push(tacticalFrom(own) || tacticalFrom(normals), 4);
    // Nothing tactical available: fall back to a fourth attack.
    own.filter(attacks).sort(byPowerThenId).forEach(m => push(m, 4));
    normals.filter(attacks).sort(byPowerThenId).forEach(m => push(m, 4));

    return picked.slice(0, 4).map(m => ({ ...m, ppLeft: m.pp }));
}

// ─────────────────────────── Deterministic RNG ───────────────────────────
//
// Both clients replay the same turn locally; identical seeds mean identical
// accuracy, crit and effect rolls, so neither needs to trust the other's maths.

function makeRng(seedStr) {
    let h = 1779033703 ^ String(seedStr).length;
    for (let i = 0; i < String(seedStr).length; i++) {
        h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let s = h >>> 0;
    return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─────────────────────────── Combatants ───────────────────────────

/** Battle-ready copy of a party member. Never mutates the source. */
function toCombatant(pokemon, species, config) {
    const maxHp = config.calculateRealMaxHp(species.baseStats.hp, pokemon.level);

    // The mega this Pokémon could become — ARMED, not applied. A combatant
    // enters a PVP battle in its base form no matter what the party screen
    // shows, and transforms only when its trainer spends their one Mega
    // Evolution on it. See the mega step in resolveTurn.
    //
    // Which form: the one the party has toggled on, if it is owned and belongs
    // to this species — the same three conditions the engine's activeMegaForm
    // applies. Failing that, the first owned usable form, so a player who has
    // never touched the toggle still gets to Mega Evolve. The toggle only has
    // to decide anything for the nine species with more than one form, which is
    // what it is for.
    const forms = config.megaFormsFor(species.id) || [];
    const owned = Array.isArray(pokemon.megaStones) ? pokemon.megaStones : [];
    const mega = (pokemon.megaActive && owned.includes(pokemon.megaActive)
        ? forms.find(f => f.key === pokemon.megaActive) : null)
        || forms.find(f => owned.includes(f.key))
        || null;

    return {
        speciesId: species.id,
        // Cosmetic only — a shiny fights exactly like any other — but it has to
        // reach the opponent's screen or half the point of owning one is lost.
        shiny: pokemon.shiny === true,
        legendary: species.isLegendary === true,
        // Someone's own Pokémon. Travels for the same reason `legendary` does:
        // the label is half of what makes it worth showing off, and the
        // opponent has no other way to know. Render-only — nothing in the turn
        // arithmetic reads it.
        custom: species.isCustom === true,
        // The form this Pokémon is CURRENTLY in, which at build time is never a
        // mega. Everything that draws a mega — the ◆ mark, is-mega, the team
        // chips — keys off this and so needs no changes to stay correct.
        megaForm: null,

        // The armed form, carried in full rather than as a key to look up.
        // Two clients whose rosters disagree about a key would otherwise
        // transform into different Pokémon from the same document — one showing
        // Mega Charizard X and the other a plain Charizard, with no error
        // anywhere. Self-describing fields make the document the single source
        // of truth, which is what the rest of the wire format already assumes.
        //
        // What is NOT carried is any boosted number: the battle document is
        // written by the opponent too, so a stat written here is a stat someone
        // can forge. The boost lives in code and is applied on read — see
        // MEGA_BOOST below.
        megaKey: mega ? mega.key : null,
        megaName: mega ? mega.name : null,
        megaSprite: mega ? mega.spriteId : null,
        megaOn: false,

        // What to draw. Follows megaForm, so a reader that has never heard of
        // megas still renders every combatant correctly.
        spriteId: species.id,
        name: species.name,
        types: [...species.types],
        level: pokemon.level,
        maxHp,
        hp: maxHp,
        // Scaled to the level, like HP above. Using the raw base stat here meant
        // a Pokémon never got stronger or faster for levelling — only bulkier.
        attack: config.calculateRealStat(species.baseStats.attack, pokemon.level),
        defense: config.calculateRealStat(species.baseStats.defense, pokemon.level),
        speed: config.calculateRealStat(species.baseStats.speed, pokemon.level),
        status: null,          // burn | paralyze | poison | sleep | freeze | toxic
        flinched: false,
        // Stage changes live together so every stat is boostable the same way.
        stages: { attack: 0, defense: 0, speed: 0 },
        confusedTurns: 0,
        sleepTurns: 0,
        toxicTurns: 0,
        moves: getMovesetFor(species, pokemon.level),
    };
}

const STATUS_LABEL = {
    burn: 'BRN', paralyze: 'PAR', poison: 'PSN',
    sleep: 'SLP', freeze: 'FRZ', toxic: 'TOX',
};

/**
 * Struggle: what a Pokémon does with no PP left.
 *
 * Without it, a battle where every move ran dry left both players staring at
 * four disabled buttons with no legal action — a genuine soft-lock, and
 * reachable in 6v6 where matches run long. Typeless, so the type chart cannot
 * make it super effective or immune.
 */
const STRUGGLE = {
    id: 'struggle', name: 'Struggle', type: 'typeless',
    power: 50, accuracy: 100, pp: Infinity, recoilUser: 0.25,
};

/** True when nothing in the moveset can still be used. */
function isOutOfPP(c) {
    return !!c && Array.isArray(c.moves) && c.moves.every(m => (m.ppLeft || 0) <= 0);
}

/**
 * The move a chosen action resolves to.
 *
 * Struggle only stands in when EVERY move is spent. Choosing one exhausted move
 * while others remain is still a refusal, and it reports why — silently eating
 * the turn would leave a player pressing a button and seeing nothing happen.
 */
function resolveMove(c, moveId) {
    if (isOutOfPP(c)) return { move: { ...STRUGGLE }, struggled: true };
    const move = c.moves.find(m => m.id === moveId);
    if (!move) return { move: null, struggled: false, reason: 'unknown' };
    if (move.ppLeft <= 0) {
        return { move: null, struggled: false, reason: 'nopp', name: move.name };
    }
    return { move, struggled: false };
}

// ─────────────────────────── Damage ───────────────────────────

/**
 * The games' stat-stage table: +1 is 1.5x, +2 is 2x, -1 is 2/3, and so on,
 * clamped at six either way.
 *
 * Stages are what turn a battle into a decision. Without them every turn is
 * "pick the strongest move", because nothing you do this turn changes what
 * next turn is worth — a setup move that trades one turn for doubled output is
 * the oldest tactic in the series and the cheapest depth available here.
 */
const STAGE_CAP = 6;

function stageMultiplier(stage) {
    const s = Math.max(-STAGE_CAP, Math.min(STAGE_CAP, stage || 0));
    return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

/** Reads a stage off a combatant, tolerating a document written by the opponent. */
function stageOf(c, stat) {
    const raw = c && c.stages ? Number(c.stages[stat]) : 0;
    if (!Number.isFinite(raw)) return 0;
    return Math.max(-STAGE_CAP, Math.min(STAGE_CAP, Math.trunc(raw)));
}

/**
 * Applies a stage change and reports what to say about it.
 * Returns null when the stat was already pinned, so the log stays truthful.
 */
function applyStage(c, stat, delta) {
    c.stages = c.stages || {};
    const before = stageOf(c, stat);
    const after = Math.max(-STAGE_CAP, Math.min(STAGE_CAP, before + delta));
    c.stages[stat] = after;
    if (after === before) return null;

    const magnitude = Math.abs(delta) >= 2 ? ' sharply' : '';
    return `${STAT_LABEL[stat]}${magnitude} ${delta > 0 ? 'rose' : 'fell'}`;
}

const STAT_LABEL = { attack: 'Attack', defense: 'Defense', speed: 'Speed' };

function effectiveAttack(c) {
    // Burn halves physical attack, as in the games.
    const burn = c.status === 'burn' ? 0.5 : 1;
    return c.attack * stageMultiplier(stageOf(c, 'attack')) * burn * megaBoost(c, 'attack');
}

/**
 * `ignoreBoost` is passed on a critical hit: the games deliberately ignore the
 * defender's positive Defense stages on a crit, so setting up defensively is
 * strong but not an answer to everything.
 */
function effectiveDefense(c, ignoreBoost = false) {
    const stage = stageOf(c, 'defense');
    const used = ignoreBoost && stage > 0 ? 0 : stage;
    // Legacy saves carried a bare defenseStage before stages became a group.
    const legacy = Number.isFinite(c.defenseStage) ? c.defenseStage : 0;
    return c.defense * stageMultiplier(used + (stage === 0 ? legacy : 0))
         * megaBoost(c, 'defense');
}

function effectiveSpeed(c) {
    const para = c.status === 'paralyze' ? 0.5 : 1;
    return c.speed * stageMultiplier(stageOf(c, 'speed')) * para * megaBoost(c, 'speed');
}

// What Mega Evolution is worth, held as CONSTANTS rather than read from the
// document.
//
// This is the whole defence. The battle document is written by the opponent
// too, so any number in it is a number someone can forge — the version this
// replaced carried the multiplier itself and had to clamp it on every read to
// stop a "99x damage" forgery. Here the document carries only `megaOn`, a
// boolean, and the amount lives in code: the worst a forger can claim is that a
// Pokémon Mega Evolved, which is a legal move that both clients then resolve
// identically. Nothing to clamp, because nothing arrives.
//
// Held here rather than read from FlickemonConfig even though config loads
// first: every content script shares one global scope, so the name must be
// distinct from the config's, and turn resolution is deliberately free of
// outside lookups. Keep these in step with MEGA_STAT_BOOST there — a test
// asserts they match.
const MEGA_BOOST = { attack: 1.25, defense: 1.15, speed: 1.10 };

/** The factor one stat gains while megaed, or 1 the rest of the time. */
function megaBoost(c, stat) {
    return c && c.megaOn === true ? (MEGA_BOOST[stat] || 1) : 1;
}

/**
 * Damage is scaled down from the games' raw output.
 *
 * The formula below is faithful, but real Pokémon carry EV/IV investment this
 * game does not model, so their effective bulk is much higher than a bare base
 * stat implies. Unscaled, half of all level-50 matchups ended in a one-hit KO,
 * which is not a battle. This restores the pacing without distorting the
 * relative maths — type advantage, STAB and stat spreads all still matter
 * exactly as much as before.
 */
const DAMAGE_SCALE = 0.4;

/**
 * Standard damage formula, minus items/abilities/weather.
 * Returns { damage, effectiveness, crit }.
 */
function computeDamage(attacker, defender, move, rng) {
    if (!move.power) return { damage: 0, effectiveness: 1, crit: false };

    const crit = rng() < (move.critBonus ? 0.125 : 0.0625);
    const eff = typeEffectiveness(move.type, defender.types);
    const stab = attacker.types.includes(move.type) ? 1.5 : 1;
    const spread = 0.85 + rng() * 0.15;             // the games' 85–100% roll

    const base = Math.floor(
        Math.floor(
            Math.floor((2 * attacker.level) / 5 + 2) * move.power *
            (effectiveAttack(attacker) / Math.max(1, effectiveDefense(defender, crit)))
        ) / 50
    ) + 2;

    const damage = Math.max(
        eff === 0 ? 0 : 1,
        // No mega term here any more: the boost lives in effectiveAttack and
        // effectiveDefense, which the ratio above already goes through. One
        // place, so it composes with stages, burn and the crit rule for free.
        Math.floor(base * stab * eff * spread * (crit ? 1.5 : 1) * DAMAGE_SCALE)
    );
    return { damage, effectiveness: eff, crit };
}

function effectivenessText(eff) {
    if (eff === 0) return "It doesn't affect the target...";
    if (eff >= 2) return "It's super effective!";
    if (eff > 0 && eff < 1) return "It's not very effective...";
    return null;
}

// ─────────────────────────── Turn resolution ───────────────────────────

/**
 * Resolves one full turn: both sides act, then end-of-turn status ticks.
 *
 * `state` is { p1, p2 } of combatants and is mutated in place (callers pass a
 * clone). Actions are { type: 'move', moveId } or { type: 'switch', index }.
 * Returns a log of lines to display.
 */
function resolveTurn(state, actionP1, actionP2, seed) {
    const rng = makeRng(seed);
    const log = [];

    state.p1.flinched = false;
    state.p2.flinched = false;

    // Switches resolve before any attack, as in the games.
    const doSwitch = (side, action) => {
        if (!action || action.type !== 'switch') return;
        const team = state[side + 'Team'];
        const next = team && team[action.index];
        if (!next || next.hp <= 0) return;
        log.push(`${state[side].name} was withdrawn!`);
        state[side] = next;
        log.push(`Go, ${next.name}!`);
    };
    doSwitch('p1', actionP1);
    doSwitch('p2', actionP2);

    // Mega Evolution: after everyone has been switched in, before any move.
    // That is the games' own order, and doing it before decideOrder means the
    // Speed a mega gains counts for the turn it transforms on, as it has since
    // Gen 7.
    //
    // Ordered by pre-mega Speed for the log to read right, with a fixed p1-first
    // tiebreak rather than decideOrder's coin-flip: this step must not consume
    // an rng() call, or transforming would shift every roll for the rest of the
    // match on one client and not the other.
    const megaOrder = effectiveSpeed(state.p1) >= effectiveSpeed(state.p2)
        ? ['p1', 'p2'] : ['p2', 'p1'];

    for (const side of megaOrder) {
        const action = side === 'p1' ? actionP1 : actionP2;
        const c = state[side];
        // Every condition is checked on BOTH clients from the document alone,
        // so a forged request resolves to the same answer on both screens
        // rather than only on the forger's.
        if (!action || action.mega !== true) continue;
        if (!c || c.hp <= 0 || c.megaOn === true || !c.megaKey) continue;

        const was = c.name;
        c.megaOn = true;
        c.megaForm = c.megaKey;
        c.name = c.megaName || c.name;
        if (c.megaSprite) c.spriteId = c.megaSprite;
        log.push(`${was} Mega Evolved into ${c.name}!`);
    }

    const order = decideOrder(state.p1, state.p2, actionP1, actionP2, rng);

    for (const side of order) {
        const me = state[side];
        const foe = state[side === 'p1' ? 'p2' : 'p1'];
        const action = side === 'p1' ? actionP1 : actionP2;

        if (me.hp <= 0 || foe.hp <= 0) continue;
        if (!action || action.type !== 'move') continue;

        if (me.flinched) { log.push(`${me.name} flinched!`); continue; }

        // Sleep and freeze cost whole turns, which is what makes them worth a
        // move slot. Both roll to end each turn BEFORE acting, so a one-turn
        // sleep does not also cost the turn it wore off on.
        if (me.status === 'sleep') {
            me.sleepTurns = Math.max(0, (me.sleepTurns || 1) - 1);
            if (me.sleepTurns <= 0) {
                me.status = null;
                log.push(`${me.name} woke up!`);
            } else {
                log.push(`${me.name} is fast asleep.`);
                continue;
            }
        }
        if (me.status === 'freeze') {
            if (rng() < 0.20) {
                me.status = null;
                log.push(`${me.name} thawed out!`);
            } else {
                log.push(`${me.name} is frozen solid!`);
                continue;
            }
        }
        if (me.status === 'paralyze' && rng() < 0.25) {
            log.push(`${me.name} is paralysed! It can't move!`);
            continue;
        }

        // Confusion sits alongside a status rather than replacing one, and can
        // turn a setup turn into a wasted one — the reason it is feared.
        if (me.confusedTurns > 0) {
            me.confusedTurns -= 1;
            if (me.confusedTurns === 0) {
                log.push(`${me.name} snapped out of its confusion!`);
            } else if (rng() < 1 / 3) {
                const hurt = Math.max(1, Math.floor(
                    computeDamage(me, me, { power: 40, type: 'typeless' }, rng).damage));
                me.hp = Math.max(0, me.hp - hurt);
                log.push(`${me.name} is confused! It hurt itself in its confusion!`);
                if (me.hp <= 0) log.push(`${me.name} fainted!`);
                continue;
            } else {
                log.push(`${me.name} is confused...`);
            }
        }

        const { move, struggled, reason, name } = resolveMove(me, action.moveId);
        if (!move) {
            if (reason === 'nopp') log.push(`${me.name} has no PP left for ${name}!`);
            continue;
        }
        if (struggled) log.push(`${me.name} has no moves left!`);
        else move.ppLeft -= 1;

        log.push(`${me.name} used ${move.name}!`);

        if (rng() * 100 > move.accuracy) { log.push(`${me.name}'s attack missed!`); continue; }

        const { damage, effectiveness, crit } = computeDamage(me, foe, move, rng);

        if (damage > 0) {
            foe.hp = Math.max(0, foe.hp - damage);
            if (crit) log.push('A critical hit!');
            const et = effectivenessText(effectiveness);
            if (et) log.push(et);
            if (move.drain) {
                const healed = Math.max(1, Math.floor(damage * move.drain));
                me.hp = Math.min(me.maxHp, me.hp + healed);
                log.push(`${me.name} drained ${healed} HP!`);
            }
            if (move.recoilUser) {
                const recoil = Math.max(1, Math.floor(damage * move.recoilUser));
                me.hp = Math.max(0, me.hp - recoil);
                log.push(`${me.name} is hit with recoil!`);
            }
        } else if (effectiveness === 0) {
            log.push(effectivenessText(0));
            continue;
        }

        if (move.selfDefenseDrop) {
            const said = applyStage(me, 'defense', -1);
            if (said) log.push(`${me.name}'s ${said}!`);
        }

        // Stat changes. `self` moves buff the user, the rest debuff the target,
        // and a move can carry both damage and a change.
        if (move.stages && rng() < (move.stageChance ?? 1)) {
            const target = move.stagesTarget === 'self' ? me : foe;
            for (const [stat, delta] of Object.entries(move.stages)) {
                const said = applyStage(target, stat, delta);
                if (said) log.push(`${target.name}'s ${said}!`);
                else log.push(`${target.name}'s ${STAT_LABEL[stat]} won't go ${delta > 0 ? 'higher' : 'lower'}!`);
            }
        }

        if (move.heal) {
            const before = me.hp;
            me.hp = Math.min(me.maxHp, me.hp + Math.floor(me.maxHp * move.heal));
            if (me.hp > before) log.push(`${me.name} regained health!`);
            else log.push(`${me.name}'s HP is already full!`);
        }

        // Status / flinch / confusion
        if (move.effect && rng() < (move.chance ?? 1)) {
            if (move.effect === 'flinch') {
                foe.flinched = true;
            } else if (move.effect === 'confuse') {
                if (!foe.confusedTurns) {
                    foe.confusedTurns = 2 + Math.floor(rng() * 3);   // 2-4 turns
                    log.push(`${foe.name} became confused!`);
                }
            } else if (!foe.status && !isImmuneToStatus(foe, move.effect)) {
                foe.status = move.effect;
                if (move.effect === 'sleep') foe.sleepTurns = 1 + Math.floor(rng() * 3);
                if (move.effect === 'toxic') foe.toxicTurns = 0;
                log.push(`${foe.name} was ${statusVerb(move.effect)}!`);
            }
        }

        if (foe.hp <= 0) log.push(`${foe.name} fainted!`);
    }

    // End of turn: residual damage.
    for (const side of ['p1', 'p2']) {
        const c = state[side];
        if (c.hp <= 0) continue;

        if (c.status === 'burn' || c.status === 'poison') {
            const tick = Math.max(1, Math.floor(c.maxHp / 16));
            c.hp = Math.max(0, c.hp - tick);
            log.push(`${c.name} is hurt by ${c.status === 'burn' ? 'its burn' : 'poison'}!`);
        } else if (c.status === 'toxic') {
            // Escalating, as in the games: harmless at first, then a clock the
            // other player is racing. That is the whole appeal of Toxic.
            c.toxicTurns = (c.toxicTurns || 0) + 1;
            const tick = Math.max(1, Math.floor((c.maxHp / 16) * c.toxicTurns));
            c.hp = Math.max(0, c.hp - tick);
            log.push(`${c.name} is hurt by poison!`);
        }
        if (c.hp <= 0) log.push(`${c.name} fainted!`);
    }

    return log;
}

function isImmuneToStatus(c, status) {
    if (status === 'burn') return c.types.includes('fire');
    if (status === 'poison' || status === 'toxic') {
        return c.types.includes('poison') || c.types.includes('steel');
    }
    if (status === 'paralyze') return c.types.includes('electric');
    if (status === 'freeze') return c.types.includes('ice');
    return false;
}

function statusVerb(status) {
    if (status === 'sleep') return 'put to sleep';
    if (status === 'freeze') return 'frozen solid';
    if (status === 'toxic') return 'badly poisoned';
    return status === 'burn' ? 'burned' : status === 'poison' ? 'poisoned' : 'paralysed';
}

/** Priority first, then speed, with a seeded coin-flip for exact ties. */
function decideOrder(p1, p2, a1, a2, rng) {
    const pr = (c, a) => (a && a.type === 'move' ? (c.moves.find(m => m.id === a.moveId)?.priority || 0) : 6);
    const pr1 = pr(p1, a1), pr2 = pr(p2, a2);
    if (pr1 !== pr2) return pr1 > pr2 ? ['p1', 'p2'] : ['p2', 'p1'];

    const s1 = effectiveSpeed(p1), s2 = effectiveSpeed(p2);
    if (s1 !== s2) return s1 > s2 ? ['p1', 'p2'] : ['p2', 'p1'];
    return rng() < 0.5 ? ['p1', 'p2'] : ['p2', 'p1'];
}

window.FlickemonBattle = {
    TYPE_CHART, MOVES, DAMAGE_SCALE, MEGA_BOOST, megaBoost, getMove, getMovesetFor,
    typeEffectiveness, computeDamage, resolveTurn, decideOrder,
    toCombatant, makeRng, effectiveSpeed, effectiveDefense, effectiveAttack,
    STATUS_LABEL, isImmuneToStatus,
};
