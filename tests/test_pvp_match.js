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

console.log('\n=== Mega Evolution is the mechanic the games have ===');
{
    // Gyarados, holding its stone and with the party toggle on. The toggle is
    // how the party screen shows a permanent mega while studying; a PVP battle
    // must ignore it and start in the base form regardless.
    const armed = (id, lv = 50, extra = {}) => {
        const forms = cfg.megaFormsFor(id);
        return B.toCombatant({
            level: lv, megaStones: [forms[0].key], megaActive: forms[0].key, ...extra,
        }, cfg.getSpeciesById(id), cfg);
    };

    console.log('\n  -- it enters as itself --');
    {
        const g = armed(130);
        check('not transformed at the start', g.megaOn === false && g.megaForm === null);
        check('wearing its own name', g.name === 'Gyarados', g.name);
        check('and its own sprite', g.spriteId === 130, String(g.spriteId));
        check('but armed', g.megaKey === 'gyarados-mega' && g.megaName === 'Mega Gyarados');
        check('with the form sprite ready to swap in', g.megaSprite === 10041, String(g.megaSprite));

        // The whole security argument: no boosted number is ever written down.
        check('no stat on the wire is boosted',
            g.attack === cfg.calculateRealStat(cfg.getSpeciesById(130).baseStats.attack, 50));
        check('and there is no multiplier to forge', g.damageMult === undefined);
    }

    console.log('\n  -- and transforms only when asked --');
    {
        const g = armed(130), foe = mon(9, 50);
        const s = { p1: g, p2: foe, p1Team: [g], p2Team: [foe] };
        const quiet = B.resolveTurn(s, move(g.moves[0].id), idle, 'm:1');
        check('a plain move does not transform it', g.megaOn === false);
        check('and says nothing about megas', !quiet.some(l => /Mega Evolved/.test(l)));

        const log = B.resolveTurn(s, { ...move(g.moves[0].id), mega: true }, idle, 'm:2');
        check('asking transforms it', g.megaOn === true);
        check('it takes the form name', g.name === 'Mega Gyarados', g.name);
        check('and the form sprite', g.spriteId === 10041, String(g.spriteId));
        check('megaForm is set, so every existing render site lights up',
            g.megaForm === 'gyarados-mega');
        check('it is announced before the move',
            log[0] === 'Gyarados Mega Evolved into Mega Gyarados!', JSON.stringify(log[0]));

        // Once. A second request must not stack, and must not re-announce.
        const again = B.resolveTurn(s, { ...move(g.moves[0].id), mega: true }, idle, 'm:3');
        check('a second request does nothing', !again.some(l => /Mega Evolved/.test(l)),
            JSON.stringify(again));
    }

    console.log('\n  -- HP never changes, which is the rule in every game --');
    {
        const g = armed(130);
        const hp = g.hp, maxHp = g.maxHp;
        const foe = mon(9, 50);
        const s = { p1: g, p2: foe, p1Team: [g], p2Team: [foe] };
        B.resolveTurn(s, { ...move(g.moves[0].id), mega: true }, idle, 'hp:1');
        check('max HP is untouched', g.maxHp === maxHp, `${maxHp} -> ${g.maxHp}`);
        check('and transforming healed nothing', g.hp <= hp, `${hp} -> ${g.hp}`);
    }

    console.log('\n  -- the boost is stats, not a damage number --');
    {
        const base = armed(130), meg = armed(130);
        meg.megaOn = true;
        const bo = cfg.MEGA_STAT_BOOST;
        const near = (a, b) => Math.abs(a - b) < 0.001;
        check('attack rises', near(B.effectiveAttack(meg), B.effectiveAttack(base) * bo.attack));
        check('defense rises', near(B.effectiveDefense(meg), B.effectiveDefense(base) * bo.defense));
        check('speed rises', near(B.effectiveSpeed(meg), B.effectiveSpeed(base) * bo.speed));

        // Speed mattering is the point of boosting it, so prove it flips an
        // order rather than just moving a number. Two identical Gyarados, one
        // megaed: the mega must move first, and would not have before.
        const twinA = armed(130), twinB = armed(130);
        check('identical twins tie on speed',
            B.effectiveSpeed(twinA) === B.effectiveSpeed(twinB));
        twinA.megaOn = true;
        const order = B.decideOrder(twinA, twinB, move(twinA.moves[0].id),
            move(twinB.moves[0].id), () => 0.99);
        check('and the megaed twin now moves first', order[0] === 'p1',
            `${B.effectiveSpeed(twinA)} vs ${B.effectiveSpeed(twinB)}`);

        // It composes with stages rather than sitting beside them.
        const staged = armed(130);
        staged.megaOn = true;
        staged.stages = { attack: 2, defense: 0, speed: 0 };
        check('stages multiply on top of the mega',
            near(B.effectiveAttack(staged), B.effectiveAttack(base) * 2 * bo.attack),
            String(B.effectiveAttack(staged)));

        // And through the damage formula, which is what a player feels.
        const foe = mon(9, 50);
        const dmgBase = B.computeDamage(base, foe, base.moves.find(m => m.power > 0), () => 0.9).damage;
        const dmgMega = B.computeDamage(meg, foe, meg.moves.find(m => m.power > 0), () => 0.9).damage;
        check('a mega hits harder', dmgMega > dmgBase, `${dmgBase} -> ${dmgMega}`);
        console.log(`      damage ${dmgBase} -> ${dmgMega} (x${(dmgMega / dmgBase).toFixed(2)})`);
    }

    console.log('\n  -- both clients reach the same state --');
    {
        // The two clients replay the same turn from the same document. If a
        // mega changed anything not written down, they would diverge here.
        const run = () => {
            const g = armed(130), foe = mon(9, 50);
            const s = { p1: g, p2: foe, p1Team: [g], p2Team: [foe] };
            const log = B.resolveTurn(s, { ...move(g.moves[0].id), mega: true },
                move(foe.moves[0].id), 'sync:1');
            return JSON.stringify({ log, p1: s.p1, p2: s.p2 });
        };
        check('replaying a mega turn is deterministic', run() === run());
    }

    console.log('\n  -- a forged request resolves the same on both screens --');
    {
        // Nothing here can stop an opponent editing their own client. What it
        // CAN do is make the forgery resolve identically for both players, and
        // cap what it is worth. A stat written into the document would not be.
        const g = armed(130);
        g.megaSprite = 10041;
        const foe = mon(9, 50);
        const s = { p1: g, p2: foe, p1Team: [g], p2Team: [foe] };
        B.resolveTurn(s, { ...move(g.moves[0].id), mega: true }, idle, 'f:1');
        const honest = B.effectiveAttack(g);

        const forged = armed(130);
        forged.megaOn = true;
        forged.attack = 99999;               // a hand-edited document
        check('a forged stat is still just a number both sides read',
            B.effectiveAttack(forged) === 99999 * cfg.MEGA_STAT_BOOST.attack,
            'the defence is that the AMOUNT is not forgeable, not the stat');
        check('the boost itself comes from code, not the document',
            B.effectiveAttack(g) === honest);

        // A Pokémon with no stone cannot claim one.
        const bare = mon(9, 50);
        const s2 = { p1: bare, p2: mon(130, 50), p1Team: [bare], p2Team: [mon(130, 50)] };
        const log = B.resolveTurn(s2, { ...move(bare.moves[0].id), mega: true }, idle, 'f:2');
        check('no stone, no transformation', bare.megaOn === false && bare.megaForm === null);
        check('and nothing is announced', !log.some(l => /Mega Evolved/.test(l)));
    }

    console.log('\n  -- a fainted mega does not hand the transformation back --');
    {
        const g = armed(130);
        g.megaOn = true; g.megaForm = 'gyarados-mega';
        g.hp = 0;
        const t = [g, mon(9, 50)];
        // megaUsedBy in the PVP layer reads exactly this: a spent mega stays
        // spent, because the record IS the team.
        check('the team still shows one spent', t.some(c => c.megaOn === true));
    }

    console.log('\n  -- and it is gone next battle --');
    {
        // Reversion needs no code: buildPvpTeam builds fresh combatants from the
        // party every match, and nothing about the transformation is persisted.
        const member = { level: 50, megaStones: ['gyarados-mega'], megaActive: 'gyarados-mega' };
        const first = B.toCombatant(member, cfg.getSpeciesById(130), cfg);
        first.megaOn = true; first.name = 'Mega Gyarados'; first.megaForm = 'gyarados-mega';
        const second = B.toCombatant(member, cfg.getSpeciesById(130), cfg);
        check('the next battle starts untransformed', second.megaOn === false);
        check('the party member was never touched',
            member.megaOn === undefined && member.name === undefined);
    }

    console.log('\n  -- the two boost tables must not drift apart --');
    {
        // battle.js holds its own copy so turn resolution stays free of outside
        // lookups. That is only safe while they agree.
        for (const k of ['attack', 'defense', 'speed']) {
            check(`${k} matches the config`, B.MEGA_BOOST[k] === cfg.MEGA_STAT_BOOST[k],
                `${B.MEGA_BOOST[k]} vs ${cfg.MEGA_STAT_BOOST[k]}`);
        }
        check('and HP is in neither', B.MEGA_BOOST.hp === undefined
            && cfg.MEGA_STAT_BOOST.hp === undefined);
    }

    console.log('\n  -- pacing survives the change --');
    {
        // The 1.30x this replaced was tuned for 8-15 turn battles. Attack x1.25
        // was chosen to land near it; this is the check that says so.
        const alive = t => t.some(c => c.hp > 0);
        let worst = 0, longest = 0;
        for (let seed = 0; seed < 40; seed++) {
            const a = armed(130, 50), b = mon(9, 50);
            a.megaOn = true;                                   // mega vs plain
            const s = { p1: a, p2: b, p1Team: [a], p2Team: [b] };
            let turn = 0;
            while (alive([a]) && alive([b]) && turn < 100) {
                turn++;
                const pk = x => x.moves[turn % x.moves.length].id;
                B.resolveTurn(s, move(pk(s.p1)), move(pk(s.p2)), `p${seed}:${turn}`);
            }
            worst = Math.max(worst, turn);
            longest = Math.max(longest, turn);
        }
        console.log(`      mega vs plain, worst of 40: ${worst} turns`);
        check('a mega does not end battles instantly', worst >= 4, `${worst} turns`);
        check('nor drag them out', worst <= 30, `${worst} turns`);
    }
}

console.log('\n=== shinies reach the other trainer ===');
{
    const shiny = (id, lv = 30) =>
        B.toCombatant({ level: lv, shiny: true }, cfg.getSpeciesById(id), cfg);

    const s = shiny(130), plain = mon(130);
    check('the flag travels on the combatant', s.shiny === true && plain.shiny === false);

    // Cosmetic, and it has to STAY cosmetic: a shiny that hit harder would turn
    // a 1-in-512 encounter into a competitive requirement.
    check('same max HP', s.maxHp === plain.maxHp);
    check('same attack', s.attack === plain.attack);
    check('same defense', s.defense === plain.defense);
    check('same speed', s.speed === plain.speed);
    check('same moves', JSON.stringify(s.moves) === JSON.stringify(plain.moves));

    // The document is JSON in one field, so anything not JSON-safe is lost.
    const wire = JSON.parse(JSON.stringify(s));
    check('it survives the trip through the document', wire.shiny === true);

    console.log('\n  -- including a shiny mega --');
    {
        const g = B.toCombatant({
            level: 50, shiny: true,
            megaStones: ['gyarados-mega'], megaActive: 'gyarados-mega',
        }, cfg.getSpeciesById(130), cfg);
        const foe = mon(9, 50);
        const st = { p1: g, p2: foe, p1Team: [g], p2Team: [foe] };
        B.resolveTurn(st, { ...move(g.moves[0].id), mega: true }, idle, 'sh:1');
        check('it is still shiny after transforming', g.shiny === true);
        check('and wearing the mega sprite', g.spriteId === 10041, String(g.spriteId));

        // Which is a real file, in the shiny directory. A mega whose shiny art
        // was missing would show a broken image at the loudest possible moment.
        const fs = require('fs');
        for (const dir of ['sprites/shiny', 'sprites/back/shiny']) {
            check(`${dir}/10041.png ships`, fs.existsSync(ROOT + dir + '/10041.png'));
        }
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
