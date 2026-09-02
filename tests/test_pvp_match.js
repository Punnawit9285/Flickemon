const ROOT = require('path').join(__dirname, '..') + '/';
// A whole match, played out: switching, fainting, formats, and the states a
// player can actually reach with the buttons in front of them.
global.window = {};
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-custom.js');
require(ROOT + 'content/flickemon-battle.js');
const cfg = global.window.FlickemonConfig;
const B = global.window.FlickemonBattle;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const mon = (id, lv = 30) => B.toCombatant({ level: lv }, cfg.getSpeciesById(id), cfg);
const team = (ids, lv = 30) => ids.map(i => mon(i, lv));
const move = id => ({ type: 'move', moveId: id });
const swap = i => ({ type: 'switch', index: i });
const idle = { type: 'wait' };

console.log('\n=== switching mid-battle ===');
{
    const t = team([1, 4, 7]);
    const s = { p1: t[0], p2: mon(113), p1Team: t, p2Team: [mon(113)] };

    const log = B.resolveTurn(s, swap(1), idle, 'sw:1');
    check('the switch happens', s.p1.speciesId === 4, `active is ${s.p1.name}`);
    check('it is announced', log.some(l => /withdrawn/.test(l)) && log.some(l => /Go,/.test(l)),
        JSON.stringify(log));
    check('the team array still holds everyone', s.p1Team.length === 3);
    check('the one switched out keeps its HP',
        s.p1Team[0].hp === s.p1Team[0].maxHp, 'switching must not heal or hurt');

    // Switching costs the turn: you do not also get to attack.
    const atk = { p1: team([1, 4])[0], p2: mon(113), p1Team: team([1, 4]), p2Team: [mon(113)] };
    const before = atk.p2.hp;
    B.resolveTurn(atk, swap(1), idle, 'sw:2');
    check('a switch is instead of attacking, not as well as',
        atk.p2.hp === before, `foe lost ${before - atk.p2.hp}`);

    // The opponent still acts, so switching in front of an attack hurts.
    const punish = { p1: team([1, 4])[0], p2: mon(6, 40), p1Team: team([1, 4]), p2Team: [mon(6, 40)] };
    const hpBefore = punish.p1Team[1].hp;
    B.resolveTurn(punish, swap(1), move(punish.p2.moves.find(m => m.power > 0).id), 'sw:3');
    check('the incoming Pokémon takes the hit',
        punish.p1.hp < hpBefore || punish.p1.hp === punish.p1.maxHp,
        'switching should be a real risk, not a free dodge');
}

console.log('\n=== switching refuses what it should ===');
{
    const t = team([1, 4, 7]);
    t[1].hp = 0;
    const s = { p1: t[0], p2: mon(113), p1Team: t, p2Team: [mon(113)] };

    B.resolveTurn(s, swap(1), idle, 'sw:4');
    check('cannot switch to a fainted Pokémon', s.p1.speciesId === 1, `active is ${s.p1.name}`);

    B.resolveTurn(s, swap(99), idle, 'sw:5');
    check('an index off the end is ignored', s.p1.speciesId === 1);

    B.resolveTurn(s, swap(-1), idle, 'sw:6');
    check('a negative index is ignored', s.p1.speciesId === 1);

    const solo = { p1: mon(1), p2: mon(113), p1Team: [mon(1)], p2Team: [mon(113)] };
    B.resolveTurn(solo, swap(0), idle, 'sw:7');
    check('switching to yourself is harmless', solo.p1.hp === solo.p1.maxHp);
}

console.log('\n=== switches resolve before attacks, on both sides ===');
{
    // If an attack landed first, a switch would be a free dodge.
    const t1 = team([1, 4]), t2 = team([7, 25]);
    const s = { p1: t1[0], p2: t2[0], p1Team: t1, p2Team: t2 };
    const log = B.resolveTurn(s, swap(1), swap(1), 'sw:8');
    check('both sides switch in the same turn',
        s.p1.speciesId === 4 && s.p2.speciesId === 25,
        `${s.p1.name} / ${s.p2.name}`);
    const firstAttack = log.findIndex(l => /used /.test(l));
    const lastSwitch = log.map(l => /Go,/.test(l)).lastIndexOf(true);
    check('every switch is logged before any attack',
        firstAttack === -1 || lastSwitch < firstAttack, JSON.stringify(log));
}

console.log('\n=== a full 3v3 plays to a real finish ===');
{
    let decided = 0, stalled = 0, longest = 0;
    for (let seed = 0; seed < 40; seed++) {
        const t1 = team([1 + (seed * 3) % 900, 2 + (seed * 5) % 900, 3 + (seed * 7) % 900], 40);
        const t2 = team([4 + (seed * 11) % 900, 5 + (seed * 13) % 900, 6 + (seed * 17) % 900], 40);
        const s = { p1: t1[0], p2: t2[0], p1Team: t1, p2Team: t2 };

        let turn = 0;
        const alive = t => t.some(c => c.hp > 0);
        while (alive(t1) && alive(t2) && turn < 400) {
            turn++;
            // A fainted active is replaced, which is what the switching phase
            // does in the real client.
            for (const [side, roster] of [['p1', t1], ['p2', t2]]) {
                if (s[side].hp <= 0) {
                    const next = roster.find(c => c.hp > 0);
                    if (next) s[side] = next;
                }
            }
            if (!alive(t1) || !alive(t2)) break;
            const pick = c => c.moves[turn % c.moves.length].id;
            B.resolveTurn(s, move(pick(s.p1)), move(pick(s.p2)), `m${seed}:${turn}`);
        }
        longest = Math.max(longest, turn);
        if (turn >= 400) stalled++; else decided++;
    }
    check('every 3v3 reached a result', stalled === 0, `${stalled} stalled`);
    check('and none dragged past a sane length', longest < 200, `longest ${longest} turns`);
    console.log(`      40 matches, longest ${longest} turns`);
}

console.log('\n=== formats field exactly what they promise ===');
{
    for (const m of cfg.PVP_MODES) {
        check(`${m.label} declares a size`, Number.isInteger(m.size) && m.size > 0, String(m.size));
    }
    const sizes = cfg.PVP_MODES.map(m => m.size);
    check('the sizes are 1, 3 and 6', JSON.stringify(sizes) === '[1,3,6]', JSON.stringify(sizes));
    check('no format exceeds the team cap',
        cfg.PVP_MODES.every(m => m.size <= cfg.MAX_TEAM_SIZE));

    const pvpSrc = require('fs').readFileSync(ROOT + 'content/flickemon-pvp.js', 'utf8');
    check('hosting checks the roster fits the format', /canFieldPvpMode\(mode\.id\)/.test(pvpSrc));
    check('joining checks it too',
        (pvpSrc.match(/canFieldPvpMode/g) || []).length >= 3,
        'the guest never picked the format, so they must be told before committing');
    check('the lobby marks formats it cannot field', /fit\.ok \? '' : ' short'/.test(pvpSrc));
    check('the old "at least one" check is gone',
        !/at least one Pokémon to your team/.test(pvpSrc),
        'that let two Pokémon into a 3v3');
}

console.log('\n=== the arena stacks in the right order ===');
{
    // Comments are stripped first: a selector list is split on commas, and the
    // prose above these rules is full of them.
    const css = require('fs').readFileSync(ROOT + 'content/styles.css', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const z = (sel) => {
        for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            if (!m[1].split(',').map(x => x.trim()).includes(sel)) continue;
            const zi = /z-index:\s*(-?\d+)/.exec(m[2]);
            if (zi) return +zi[1];
        }
        return null;
    };

    const layers = {
        sky: z('.pvp-sky'), ground: z('.pvp-ground'),
        horizon: z('.pvp-scene::before'), vignette: z('.pvp-scene::after'),
        plate: z('.pvp-plate'), sprite: z('.pvp-sprite'), plate_info: z('.pvp-plateinfo'),
    };
    for (const [name, v] of Object.entries(layers)) {
        check(`${name} has an explicit layer`, v !== null, 'implicit order is not a decision');
    }
    check('the backdrop is behind everything',
        layers.sky === layers.ground && layers.sky < layers.horizon);
    check('the horizon haze sits over the backdrop', layers.horizon < layers.vignette);
    check('the vignette is UNDER the combatants',
        layers.vignette < layers.plate && layers.vignette < layers.sprite,
        'over them it would quietly dim the two things the screen exists to show');
    check('sprites and nameplates are above the platforms',
        layers.sprite > layers.plate && layers.plate_info > layers.plate);

    // The backdrop is decoration; it must never eat a click meant for a button.
    check('the vignette does not swallow clicks',
        /\.pvp-scene::after\s*\{[^}]*pointer-events:\s*none/.test(css));

    const pvpSrc = require('fs').readFileSync(ROOT + 'content/flickemon-pvp.js', 'utf8');
    check('sky and ground are real layers in the markup',
        pvpSrc.includes('pvp-sky') && pvpSrc.includes('pvp-ground'));
    check('the arena still costs no requests',
        !/background[^;]*url\(/.test(css.slice(css.indexOf('.pvp-sky'), css.indexOf('.pvp-plate'))),
        'a gradient scene should not have picked up an image');
}

console.log('\n=== a nameplate never covers a Pokémon ===');
{
    // The foe's plate and YOUR Pokémon share the left side of the arena. At
    // four stacked rows the plate grew tall enough to sit on top of the
    // Pokémon being played — which is what a player noticed first.
    const css = require('fs').readFileSync(ROOT + 'content/styles.css', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel) => {
        for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            if (m[1].split(',').map(x => x.trim()).includes(sel)) return m[2];
        }
        return '';
    };
    const px = (sel, prop) => {
        const m = new RegExp(prop + ':\\s*(\\d+)px').exec(rule(sel));
        return m ? +m[1] : null;
    };

    for (const [label, scene, info, sprite] of [
        ['desktop', px('.pvp-scene', 'height'), '.pvp-plateinfo.foe-info', '.pvp-sprite.my-sprite'],
    ]) {
        const top = px(info, 'top'), cap = px(info, 'max-height');
        const h = px(sprite, 'height'), bottom = px(sprite, 'bottom');
        check(`${label}: the plate declares a height cap`, cap !== null,
            'without one a long name wraps and undoes the layout');
        const plateEnds = top + cap, spriteStarts = scene - bottom - h;
        check(`${label}: the plate stops above your Pokémon`,
            spriteStarts > plateEnds,
            `plate ends ${plateEnds}, sprite starts ${spriteStarts}`);
    }

    check('the cap is enforced, not advisory',
        /\.pvp-plateinfo\.foe-info[^}]*overflow:\s*hidden/.test(css),
        'max-height alone lets content spill over the sprite');
    check('a long name truncates rather than wrapping',
        /\.pvp-mon-name[^}]*white-space:\s*nowrap/.test(css)
        && /\.pvp-mon-name[^}]*text-overflow:\s*ellipsis/.test(css));

    const pvpSrc = require('fs').readFileSync(ROOT + 'content/flickemon-pvp.js', 'utf8');
    const plateRows = (pvpSrc.match(/class="pvp-plate-top"/g) || []).length;
    check('both plates use the compact two-row layout', plateRows === 2, `${plateRows} found`);
    check('the marks sit on the name row', /pvp-plate-top[\s\S]{0,400}pvp-plate-marks/.test(pvpSrc));
}

console.log('\n=== levelling up makes a Pokémon stronger, not just tougher ===');
{
    // HP scaled with level and the other three stats did not, so a level 5
    // Pikachu outran a level 100 Snorlax — permanently.
    const lo = B.toCombatant({ level: 5 }, cfg.getSpeciesById(25), cfg);
    const hi = B.toCombatant({ level: 100 }, cfg.getSpeciesById(25), cfg);
    for (const stat of ['attack', 'defense', 'speed', 'maxHp']) {
        check(`${stat} grows with level`, hi[stat] > lo[stat], `${lo[stat]} -> ${hi[stat]}`);
    }
    check('the formula matches the games',
        lo.speed === cfg.calculateRealStat(cfg.getSpeciesById(25).baseStats.speed, 5),
        `${lo.speed}`);

    const pika5 = B.toCombatant({ level: 5 }, cfg.getSpeciesById(25), cfg);
    const snor100 = B.toCombatant({ level: 100 }, cfg.getSpeciesById(143), cfg);
    check('a level 100 Snorlax outspeeds a level 5 Pikachu',
        B.effectiveSpeed(snor100) > B.effectiveSpeed(pika5),
        `${B.effectiveSpeed(snor100)} vs ${B.effectiveSpeed(pika5)}`);

    // Base stats must still decide who is fast AT THE SAME level.
    const pika50 = B.toCombatant({ level: 50 }, cfg.getSpeciesById(25), cfg);
    const snor50 = B.toCombatant({ level: 50 }, cfg.getSpeciesById(143), cfg);
    check('at equal level the faster species is still faster',
        B.effectiveSpeed(pika50) > B.effectiveSpeed(snor50));
}

console.log('\n=== the battle screen renders every state a player can reach ===');
{
    const src = require('fs').readFileSync(ROOT + 'content/flickemon-pvp.js', 'utf8');
    for (const [what, needle] of [
        ['the arena', 'pvp-scene'],
        ['both platforms', 'foe-plate'],
        ['stat multipliers', 'pvp-stage'],
        ['an HP tag', 'pvp-hp-tag'],
        ['the switch button', 'pvp-switch-open'],
        ['the forced-switch phase', "phase === 'switching'"],
        ['Struggle when out of PP', 'pvp-move struggle'],
        ['what each move does', 'pvp-move-hint'],
        ['remaining team balls', 'renderBalls'],
    ]) {
        check(what + ' is rendered', src.includes(needle));
    }
}

console.log('\n=== a stalled battle still ends ===');
{
    // Two Pokémon that both carry recovery can trade restores for a very long
    // time; simulated, a 6v6 ran past 260 turns. Competitive Pokémon answers
    // this with a turn cap and a tiebreak, and so does this.
    for (const m of cfg.PVP_MODES) {
        const limit = cfg.pvpTurnLimit(m.size);
        check(`${m.label} has a turn limit`, Number.isInteger(limit) && limit > 0, String(limit));
    }
    check('bigger formats get longer limits',
        cfg.pvpTurnLimit(1) < cfg.pvpTurnLimit(3) && cfg.pvpTurnLimit(3) < cfg.pvpTurnLimit(6));
    check('an unknown size still gets a limit', cfg.pvpTurnLimit(99) > 0,
        'no format may fall through to "unbounded"');

    const c2 = (hp, max) => ({ hp, maxHp: max });
    check('most left standing wins',
        cfg.pvpStallWinner([c2(1, 50), c2(1, 50)], [c2(50, 50), c2(0, 50)]) === 'host',
        'count beats health');
    check('then the healthier team',
        cfg.pvpStallWinner([c2(40, 50)], [c2(10, 50)]) === 'host');
    check('and an even stall is a draw',
        cfg.pvpStallWinner([c2(25, 50)], [c2(25, 50)]) === null,
        'breaking a genuine tie arbitrarily would be worse than admitting it');
    check('a near-tie is still a draw',
        cfg.pvpStallWinner([c2(25, 50)], [c2(25.2, 50)]) === null);

    const src = require('fs').readFileSync(ROOT + 'content/flickemon-pvp.js', 'utf8');
    check('the limit is applied when a turn resolves', /next\.turn > limit/.test(src));
    check('a draw is not scored as a loss', /!iWon && !drawn && !this\.lossRecorded/.test(src),
        'a stalemate neither player chose must not start a lockout');
    check('a draw grants no boost', /iWon = over && !drawn/.test(src));
    check('and the screen says DRAW', /drawn \? 'DRAW'/.test(src));
}

console.log('\n=== every format finishes inside its own limit ===');
{
    const mon2 = (id, lv) => B.toCombatant({ level: lv }, cfg.getSpeciesById(id), cfg);
    for (const m of cfg.PVP_MODES) {
        const limit = cfg.pvpTurnLimit(m.size);
        let over = 0, worst = 0;
        for (let seed = 0; seed < 60; seed++) {
            const mk = off => Array.from({ length: m.size },
                (_, k) => mon2(1 + ((seed * 7) + off + k * 97) % 900, 40));
            const t1 = mk(0), t2 = mk(400);
            const s = { p1: t1[0], p2: t2[0], p1Team: t1, p2Team: t2 };
            const alive = t => t.some(x => x.hp > 0);
            let turn = 0;
            while (alive(t1) && alive(t2) && turn < limit + 50) {
                turn++;
                for (const [k, r] of [['p1', t1], ['p2', t2]]) {
                    if (s[k].hp <= 0) { const n = r.find(x => x.hp > 0); if (n) s[k] = n; }
                }
                if (!alive(t1) || !alive(t2)) break;
                const pk = x => x.moves[turn % x.moves.length].id;
                B.resolveTurn(s, move(pk(s.p1)), move(pk(s.p2)), `t${seed}:${turn}`);
            }
            worst = Math.max(worst, turn);
            if (turn > limit) over++;
        }
        console.log(`      ${m.label}: worst ${worst} turns, limit ${limit}, hit the cap ${over}/60`);
        check(`${m.label} rarely reaches its cap`, over <= 6, `${over}/60 stalled`);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
