const ROOT = require('path').join(__dirname, '..') + '/';
// The mechanics that make a battle a decision rather than an exchange.
global.window = {};
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
const cfg = global.window.FlickemonConfig;
const B = global.window.FlickemonBattle;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const mon = (id, lv = 50) => B.toCombatant({ level: lv }, cfg.getSpeciesById(id), cfg);

/**
 * Puts a move in slot 0.
 *
 * resolveTurn only honours moves the Pokémon actually knows — as the real UI
 * guarantees, since it renders buttons from me.moves — so a test that names a
 * move the species never learned is silently ignored, not executed.
 */
const teach = (c, id) => {
    const m = B.getMove(id);
    c.moves[0] = { ...m, ppLeft: m.pp };
    return c;
};
const field = (a, b) => ({ p1: a, p2: b, p1Team: [], p2Team: [] });
const move = (id) => ({ type: 'move', moveId: id });
const idle = { type: 'wait' };

console.log('\n=== stat stages ===');
{
    const c = mon(1);
    check('a fresh combatant starts neutral',
        c.stages && c.stages.attack === 0 && c.stages.defense === 0 && c.stages.speed === 0,
        JSON.stringify(c.stages));

    const base = B.effectiveAttack(c);
    c.stages.attack = 1;
    check('+1 attack is 1.5x', Math.abs(B.effectiveAttack(c) / base - 1.5) < 1e-9);
    c.stages.attack = 2;
    check('+2 attack is 2x', Math.abs(B.effectiveAttack(c) / base - 2) < 1e-9);
    c.stages.attack = -1;
    check('-1 attack is 2/3', Math.abs(B.effectiveAttack(c) / base - 2 / 3) < 1e-9);
    c.stages.attack = 99;
    check('stages clamp at +6', Math.abs(B.effectiveAttack(c) / base - 4) < 1e-9,
        'a forged document must not multiply damage without limit');
    c.stages.attack = -99;
    check('and at -6', Math.abs(B.effectiveAttack(c) / base - 0.25) < 1e-9);
    c.stages.attack = 'nonsense';
    check('a non-numeric stage reads as neutral', B.effectiveAttack(c) === base);

    const sp = mon(1);
    const baseSpeed = B.effectiveSpeed(sp);
    sp.stages.speed = 2;
    check('speed stages apply', B.effectiveSpeed(sp) === baseSpeed * 2);
    sp.status = 'paralyze';
    check('paralysis still halves on top', B.effectiveSpeed(sp) === baseSpeed * 2 * 0.5);
}

console.log('\n=== setup moves actually change the battle ===');
{
    const s = field(teach(mon(1), 'swords-dance'), mon(113));
    const log = B.resolveTurn(s, move('swords-dance'), idle, 'sd:1');
    check('Swords Dance raises Attack twice', s.p1.stages.attack === 2, JSON.stringify(s.p1.stages));
    check('and says so', log.some(l => /Attack sharply rose/.test(l)), JSON.stringify(log));

    // The point of setup: the next hit must actually be bigger.
    const avgDamage = (stage) => {
        const at = mon(1); at.stages.attack = stage;
        const mv = at.moves.find(m => m.power > 0);
        let total = 0;
        for (let i = 0; i < 200; i++) {
            total += B.computeDamage(at, mon(113), mv, B.makeRng('d' + i)).damage;
        }
        return total / 200;
    };
    const plainDmg = avgDamage(0), boostDmg = avgDamage(2);
    check('a +2 Attack hits about twice as hard',
        boostDmg > plainDmg * 1.8 && boostDmg < plainDmg * 2.2,
        `${plainDmg.toFixed(0)} -> ${boostDmg.toFixed(0)}`);

    // Debuffs land on the opponent, not the user.
    const d = field(teach(mon(1), 'growl'), mon(113));
    B.resolveTurn(d, move('growl'), idle, 'g:1');
    check('Growl lowers the FOE\'s attack', d.p2.stages.attack === -1 && d.p1.stages.attack === 0,
        `me=${d.p1.stages.attack} foe=${d.p2.stages.attack}`);

    const pinned = field(teach(mon(1), 'growl'), mon(113));
    pinned.p2.stages.attack = -6;
    const plog = B.resolveTurn(pinned, move('growl'), idle, 'g:2');
    check('a pinned stat says so rather than pretending',
        plog.some(l => /won't go lower/.test(l)), JSON.stringify(plog));
}

console.log('\n=== a critical hit ignores defensive setup ===');
{
    // The games do this so setting up defensively is strong, not an answer to
    // everything.
    const c = mon(113);
    const flat = B.effectiveDefense(c, false);
    c.stages.defense = 4;
    check('boosted defence counts normally', B.effectiveDefense(c, false) > flat);
    check('but is ignored on a crit', B.effectiveDefense(c, true) === flat);
    c.stages.defense = -4;
    check('a defence DROP still counts on a crit',
        B.effectiveDefense(c, true) < flat, 'only positive stages are ignored');
}

console.log('\n=== status that costs whole turns ===');
{
    const s = field(mon(1), mon(113));
    s.p2.status = 'sleep';
    s.p2.sleepTurns = 2;
    const log = B.resolveTurn(s, idle, move(s.p2.moves[0].id), 'slp:1');
    check('a sleeping Pokémon cannot act', log.some(l => /fast asleep/.test(l)), JSON.stringify(log));
    check('and burns a turn of it', s.p2.sleepTurns === 1);

    const wake = field(mon(1), mon(113));
    wake.p2.status = 'sleep';
    wake.p2.sleepTurns = 1;
    const wlog = B.resolveTurn(wake, idle, move(wake.p2.moves[0].id), 'slp:2');
    check('it wakes when the counter runs out', wake.p2.status === null);
    check('and acts on the turn it wakes',
        wlog.some(l => /used/.test(l)), 'losing the wake-up turn as well would be a double penalty');

    // Confusion sits alongside a status rather than replacing it.
    const c = field(teach(mon(1), 'confuse-ray'), mon(113));
    c.p2.status = 'burn';
    B.resolveTurn(c, move('confuse-ray'), idle, 'cf:1');
    check('confusion stacks with a status',
        c.p2.confusedTurns > 0 && c.p2.status === 'burn',
        `conf=${c.p2.confusedTurns} status=${c.p2.status}`);
}

console.log('\n=== toxic escalates, ordinary poison does not ===');
{
    const tox = field(mon(1), mon(113));
    tox.p2.status = 'toxic';
    const ticks = [];
    for (let t = 1; t <= 4; t++) {
        const before = tox.p2.hp;
        B.resolveTurn(tox, idle, idle, 'tx:' + t);
        ticks.push(before - tox.p2.hp);
    }
    check('each turn hurts more than the last',
        ticks.every((v, i) => i === 0 || v > ticks[i - 1]), JSON.stringify(ticks));

    const psn = field(mon(1), mon(113));
    psn.p2.status = 'poison';
    const flat = [];
    for (let t = 1; t <= 3; t++) {
        const before = psn.p2.hp;
        B.resolveTurn(psn, idle, idle, 'ps:' + t);
        flat.push(before - psn.p2.hp);
    }
    check('ordinary poison stays flat', new Set(flat).size === 1, JSON.stringify(flat));
}

console.log('\n=== status immunities ===');
{
    for (const [id, status, why] of [
        [4, 'burn', 'a Fire type cannot be burned'],
        [1, 'poison', 'a Poison type cannot be poisoned'],
        [1, 'toxic', 'nor badly poisoned'],
        [25, 'paralyze', 'an Electric type cannot be paralysed'],
        [144, 'freeze', 'an Ice type cannot be frozen'],
    ]) {
        check(why, B.isImmuneToStatus(mon(id), status));
    }
    check('but a Fire type can still be paralysed', !B.isImmuneToStatus(mon(4), 'paralyze'));
}

console.log('\n=== Struggle: no legal move is still a legal turn ===');
{
    const s = field(mon(1), mon(113));
    s.p1.moves.forEach(m => { m.ppLeft = 0; });
    const before = s.p2.hp, myHp = s.p1.hp;
    const log = B.resolveTurn(s, move(s.p1.moves[0].id), idle, 'st:1');

    check('Struggle is used', log.some(l => /used Struggle/.test(l)), JSON.stringify(log));
    check('it damages the foe', s.p2.hp < before);
    check('and recoils on the user', s.p1.hp < myHp);
    check('it is typeless, so nothing resists it',
        B.typeEffectiveness('typeless', ['rock', 'steel']) === 1);
    check('and nothing is immune', B.typeEffectiveness('typeless', ['ghost']) === 1);

    // One spent move among several is a refusal, not Struggle — and it says so.
    const partial = field(mon(1), mon(113));
    partial.p1.moves[0].ppLeft = 0;
    const plog = B.resolveTurn(partial, move(partial.p1.moves[0].id), idle, 'st:2');
    check('a single exhausted move refuses out loud',
        plog.some(l => /no PP left/.test(l)), JSON.stringify(plog));
    check('and does not become Struggle', !plog.some(l => /Struggle/.test(l)));
}

console.log('\n=== healing ===');
{
    const s = field(teach(mon(113), 'recover'), mon(1));
    s.p1.hp = Math.floor(s.p1.maxHp * 0.3);
    const before = s.p1.hp;
    B.resolveTurn(s, move('recover'), idle, 'h:1');
    check('Recover restores about half', s.p1.hp > before, `${before} -> ${s.p1.hp}`);
    check('but never past full', s.p1.hp <= s.p1.maxHp);

    const full = field(teach(mon(113), 'recover'), mon(1));
    const flog = B.resolveTurn(full, move('recover'), idle, 'h:2');
    check('healing at full HP says so rather than silently wasting the turn',
        flog.some(l => /already full/.test(l)), JSON.stringify(flog));
}

console.log('\n=== movesets stay decision-shaped ===');
{
    let noTactical = 0, empty = 0;
    const tacticalNames = new Set();
    for (const sp of cfg.POKEMON_REGISTRY) {
        const set = B.getMovesetFor(sp, 50);
        if (set.length === 0) empty++;
        if (set.length !== 4) noTactical++;
        const t = set.find(m => m.stages || m.heal || (m.effect && m.power === 0));
        if (t) tacticalNames.add(t.name);
    }
    check('no species is left with nothing to do', empty === 0);
    check('every species gets four moves at Lv50', noTactical === 0, `${noTactical} short`);
    check('tactical moves are spread across types, not one default',
        tacticalNames.size >= 10, `${tacticalNames.size} distinct`);

    // Own-type first: sorting the pools together handed nearly everyone Growl.
    const bulba = B.getMovesetFor(cfg.getSpeciesById(1), 50).map(m => m.id);
    check('a Grass line gets a Grass tactical move, not Growl',
        bulba.includes('sleep-powder'), JSON.stringify(bulba));

    check('sleep is gated out of the early game',
        !B.getMovesetFor(cfg.getSpeciesById(1), 10).some(m => m.effect === 'sleep'),
        'whole-turn denial is too swingy in a short battle');
}

console.log('\n=== still deterministic ===');
{
    // Every new mechanic rolls through the seeded RNG, or the two clients
    // would drift apart the first time anyone fell asleep.
    const run = () => {
        const s = field(mon(6, 50), mon(9, 50));
        const out = [];
        for (let t = 1; t <= 15 && s.p1.hp > 0 && s.p2.hp > 0; t++) {
            out.push(...B.resolveTurn(s,
                move(s.p1.moves[t % s.p1.moves.length].id),
                move(s.p2.moves[t % s.p2.moves.length].id), 'det:' + t));
        }
        return JSON.stringify({ out, a: s.p1.hp, b: s.p2.hp, sa: s.p1.stages, sb: s.p2.stages });
    };
    check('two replays of the same battle are identical', run() === run());

    const sets = () => JSON.stringify(B.getMovesetFor(cfg.getSpeciesById(94), 50).map(m => m.id));
    check('moveset generation is deterministic too', sets() === sets());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
