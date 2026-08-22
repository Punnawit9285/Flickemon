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

const MOVES_BY_ID = MOVES.reduce((m, mv) => { m[mv.id] = mv; return m; }, {});
const getMove = id => MOVES_BY_ID[id] || null;

/**
 * The four moves a species knows.
 *
 * Chosen from the species' own types (so STAB matters), strongest first, then
 * padded with Normal moves. Fully deterministic: both players must derive the
 * same moveset for the same Pokémon or the battle would desync.
 */
function getMovesetFor(species, level = 50) {
    if (!species) return [];
    const own = MOVES.filter(m => species.types.includes(m.type));
    const normals = MOVES.filter(m => m.type === 'normal');

    // Higher-powered moves unlock with level, so a level 5 Pokémon can't open
    // with Hyper Beam.
    const allowed = m => m.power <= Math.max(40, level * 2.2);

    const picked = [];
    const push = m => { if (m && picked.length < 4 && !picked.some(p => p.id === m.id)) picked.push(m); };

    own.filter(allowed).sort((a, b) => b.power - a.power).forEach(push);
    normals.filter(allowed).sort((a, b) => b.power - a.power).forEach(push);
    // Guarantee a usable move even at level 1.
    push(getMove('tackle'));

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
    return {
        speciesId: species.id,
        // Cosmetic only — a shiny fights exactly like any other — but it has to
        // reach the opponent's screen or half the point of owning one is lost.
        shiny: pokemon.shiny === true,
        legendary: species.isLegendary === true,
        name: species.name,
        types: [...species.types],
        level: pokemon.level,
        maxHp,
        hp: maxHp,
        attack: species.baseStats.attack,
        defense: species.baseStats.defense,
        speed: species.baseStats.speed,
        status: null,          // 'burn' | 'paralyze' | 'poison'
        flinched: false,
        defenseStage: 0,
        moves: getMovesetFor(species, pokemon.level),
    };
}

const STATUS_LABEL = { burn: 'BRN', paralyze: 'PAR', poison: 'PSN' };

// ─────────────────────────── Damage ───────────────────────────

function effectiveAttack(c) {
    // Burn halves physical attack, as in the games.
    return c.status === 'burn' ? c.attack * 0.5 : c.attack;
}

function effectiveDefense(c) {
    const stage = Math.max(-6, Math.min(6, c.defenseStage || 0));
    const mult = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
    return c.defense * mult;
}

function effectiveSpeed(c) {
    return c.status === 'paralyze' ? c.speed * 0.5 : c.speed;
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
            (effectiveAttack(attacker) / Math.max(1, effectiveDefense(defender)))
        ) / 50
    ) + 2;

    const damage = Math.max(
        eff === 0 ? 0 : 1,
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

    const order = decideOrder(state.p1, state.p2, actionP1, actionP2, rng);

    for (const side of order) {
        const me = state[side];
        const foe = state[side === 'p1' ? 'p2' : 'p1'];
        const action = side === 'p1' ? actionP1 : actionP2;

        if (me.hp <= 0 || foe.hp <= 0) continue;
        if (!action || action.type !== 'move') continue;

        if (me.flinched) { log.push(`${me.name} flinched!`); continue; }
        if (me.status === 'paralyze' && rng() < 0.25) {
            log.push(`${me.name} is paralysed! It can't move!`);
            continue;
        }

        const move = me.moves.find(m => m.id === action.moveId);
        if (!move) continue;
        if (move.ppLeft <= 0) { log.push(`${me.name} has no PP left for ${move.name}!`); continue; }
        move.ppLeft -= 1;

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
            me.defenseStage = Math.max(-6, (me.defenseStage || 0) - 1);
            log.push(`${me.name}'s Defense fell!`);
        }

        // Status / flinch
        if (move.effect && rng() < (move.chance ?? 1)) {
            if (move.effect === 'flinch') {
                foe.flinched = true;
            } else if (!foe.status && !isImmuneToStatus(foe, move.effect)) {
                foe.status = move.effect;
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
            if (c.hp <= 0) log.push(`${c.name} fainted!`);
        }
    }

    return log;
}

function isImmuneToStatus(c, status) {
    if (status === 'burn') return c.types.includes('fire');
    if (status === 'poison') return c.types.includes('poison') || c.types.includes('steel');
    if (status === 'paralyze') return c.types.includes('electric');
    return false;
}

function statusVerb(status) {
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
    TYPE_CHART, MOVES, DAMAGE_SCALE, getMove, getMovesetFor,
    typeEffectiveness, computeDamage, resolveTurn, decideOrder,
    toCombatant, makeRng, effectiveSpeed, effectiveDefense, effectiveAttack,
    STATUS_LABEL, isImmuneToStatus,
};
