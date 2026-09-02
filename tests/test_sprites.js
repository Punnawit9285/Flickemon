const ROOT = require('path').join(__dirname, '..') + '/';
// Sprite sizing + evolution-animation timing, read straight out of styles.css.
const fs = require('fs');
const css = fs.readFileSync(ROOT + 'content/styles.css', 'utf8');
const ui  = fs.readFileSync(ROOT + 'content/flickemon-ui.js', 'utf8');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

/** The declaration block for a selector, matched at the start of a line. */
function block(sel) {
    const i = css.indexOf('\n' + sel + ' {');
    if (i < 0) return null;
    return css.slice(i, css.indexOf('}', i));
}
function size(sel) {
    const b = block(sel);
    if (!b) return null;
    const w = /width:\s*(\d+)px/.exec(b), h = /height:\s*(\d+)px/.exec(b);
    return w && h ? { w: +w[1], h: +h[1] } : null;
}

console.log('\n=== every sprite got bigger, and stayed square ===');
// selector -> size before this change; sprites must now exceed it.
const previously = {
    '.partner-mini-sprite, .wild-mini-sprite': 36,
    '.starter-card-img':                       72,
    '.pokedex-sprite':                         48,
    '.pokedex-unknown':                        48,
    '.partner-big-sprite':                    128,
    '.party-row-sprite':                       44,
    '.pvp-sprite.foe-sprite':                  76,
    '.pvp-sprite.my-sprite':                   88,
    '.pvp-team-chip img':                      34,
};
for (const [sel, was] of Object.entries(previously)) {
    const s = size(sel);
    check(`${sel} sized`, !!s, 'no width/height found');
    if (!s) continue;
    check(`${sel} ${was} -> ${s.w}`, s.w > was, `still ${s.w}px`);
    check(`${sel} square`, s.w === s.h, `${s.w}x${s.h}`);
}

console.log('\n=== removed rules stayed removed ===');
{
    // These were superseded by .party-row-* and .flickemon-modal-*. Dropping
    // them is only safe while nothing renders them, so check that here rather
    // than trusting the grep that justified the deletion.
    const js = ['flickemon-ui', 'flickemon-pvp', 'content-script', 'flickemon-engine']
        .map(f => fs.readFileSync(`${ROOT}content/${f}.js`, 'utf8')).join('');
    for (const dead of ['party-sprite', 'flickemon-party-row', 'party-star',
                        'flickemon-modal-card', 'modal-close-btn']) {
        check(`.${dead} unused in markup`, !new RegExp(`["'\\s]${dead}["'\\s]`).test(js));
        check(`.${dead} has no orphan CSS`, !new RegExp(`^\\.${dead}\\s*\\{`, 'm').test(css));
    }
}

console.log('\n=== the sprite box never outgrows its container ===');
// A 6-up dex grid can't hold 64px sprites in a 500px modal, so it must reflow.
check('dex grid is not a fixed column count',
    !/\.flickemon-pokedex-grid\s*{[^}]*repeat\(\s*6\s*,/.test(css), 'still repeat(6, 1fr)');
const dexGrid = block('.flickemon-pokedex-grid');
const dexMin = /minmax\((\d+)px/.exec(dexGrid || '');
check('dex grid tracks are at least the sprite width',
    dexMin && +dexMin[1] >= size('.pokedex-sprite').w,
    `track=${dexMin && dexMin[1]} sprite=${size('.pokedex-sprite').w}`);

const starter = block('.starter-card');
const starterMin = /min-width:\s*(\d+)px/.exec(starter);
check('starter sprite fits the narrowest card',
    +starterMin[1] >= size('.starter-card-img').w,
    `card=${starterMin[1]} sprite=${size('.starter-card-img').w}`);

// The battle screen became an arena: sprites and nameplates are placed
// absolutely on a scene rather than sitting in a row, so "widths must sum to
// less than the modal" no longer describes it. What still has to hold is that
// a nameplate cannot grow across the scene and end up under its own Pokémon.
const infoWidth = /max-width:\s*(\d+)%/.exec(block('.pvp-plateinfo'));
check('a nameplate is capped to part of the arena',
    infoWidth && +infoWidth[1] <= 65, infoWidth ? infoWidth[1] + '%' : 'uncapped');

const sceneH = /height:\s*(\d+)px/.exec(block('.pvp-scene'));
check('the arena has a fixed height for the platforms to sit on',
    sceneH && +sceneH[1] >= 150, sceneH ? sceneH[1] + 'px' : 'auto');

// Each sprite has to overlap its platform, or it floats above the ground.
const foeTop = +/top:\s*(\d+)px/.exec(block('.pvp-sprite.foe-sprite'))[1];
const foeH = size('.pvp-sprite.foe-sprite').h;
const plateTop = +/top:\s*(\d+)px/.exec(block('.pvp-plate.foe-plate'))[1];
const plateH = +/height:\s*(\d+)px/.exec(block('.pvp-plate.foe-plate'))[1];
check('the foe stands on its platform rather than above it',
    foeTop + foeH > plateTop && foeTop + foeH <= plateTop + plateH,
    `sprite ends ${foeTop + foeH}, platform spans ${plateTop}-${plateTop + plateH}`);

console.log('\n=== the morph animation fits inside the overlay lifetime ===');
const lifetime = +/EVOLUTION_OVERLAY_MS\s*=\s*(\d+)/.exec(ui)[1];
function anim(sel) {
    const b = block(sel) || '';
    const m = /animation:\s*([\w-]+)\s+([\d.]+)s[^;]*?\s([\d.]+)s/.exec(b);
    return m ? { name: m[1], dur: +m[2] * 1000, delay: +m[3] * 1000 } : null;
}
const morph = anim('.evo-morph');
check('morph animation declared', !!morph, block('.evo-morph'));
check('morph ends before the overlay does',
    morph.delay + morph.dur < lifetime, `${morph.delay + morph.dur}ms vs ${lifetime}ms`);

const desc = anim('.evo-desc');
check('name text starts only after the morph resolves',
    desc.delay >= morph.delay + morph.dur, `text@${desc.delay} morph ends@${morph.delay + morph.dur}`);
check('name text is readable before dismissal',
    lifetime - (desc.delay + desc.dur) >= 1000,
    `only ${lifetime - (desc.delay + desc.dur)}ms of hold`);

console.log('\n=== the staged sequence runs in the right order ===');
// Every beat is a CSS delay, so the whole timeline can be read out of the file.
function beat(sel, delaySel) {
    const b = block(sel) || '';
    const shorthand = /animation:\s*([\w-]+)\s+([\d.]+)s([^;]*)/.exec(b);
    if (!shorthand) return null;
    const [, name, dur, rest] = shorthand;

    // A second time in the shorthand is the delay.
    const inline = /\s([\d.]+)s/.exec(rest);
    if (inline) return { name, dur: +dur * 1000, delay: +inline[1] * 1000 };

    // Otherwise it sits on animation-delay, either here or on a variant class
    // (.evo-ring holds the timing, .evo-ring-1 holds the stagger).
    const src = (delaySel ? block(delaySel) || '' : b);
    const own = /animation-delay:\s*(?:calc\()?([\d.]+)s/.exec(src);
    return own ? { name, dur: +dur * 1000, delay: +own[1] * 1000 } : null;
}
const beats = {
    lead:   beat('.evo-lead'),
    ring:   beat('.evo-ring', '.evo-ring-1'),
    rays:   beat('.evo-rays'),
    morph:  beat('.evo-morph'),
    burst:  beat('.evo-burst'),
    flash:  beat('.evo-flash'),
    spark:  beat('.evo-particles i'),
    out:    beat('.evo-outcome'),
};
for (const [k, v] of Object.entries(beats)) check(`${k} beat parsed`, !!v, JSON.stringify(v));

check('the question comes before the transformation',
    beats.lead.delay < beats.morph.delay, `lead@${beats.lead.delay} morph@${beats.morph.delay}`);
check('rings converge before the morph starts',
    beats.ring.delay < beats.morph.delay, `ring@${beats.ring.delay} morph@${beats.morph.delay}`);
check('rays are up while the morph runs',
    beats.rays.delay <= beats.morph.delay + 200 &&
    beats.rays.delay + beats.rays.dur >= beats.morph.delay + beats.morph.dur,
    `rays ${beats.rays.delay}-${beats.rays.delay + beats.rays.dur}, morph ${beats.morph.delay}-${beats.morph.delay + beats.morph.dur}`);
check('the burst lands as the morph resolves',
    Math.abs(beats.burst.delay - (beats.morph.delay + beats.morph.dur)) < 400,
    `burst@${beats.burst.delay} morph ends@${beats.morph.delay + beats.morph.dur}`);
check('the flash fires with the burst',
    Math.abs(beats.flash.delay - beats.burst.delay) < 250,
    `flash@${beats.flash.delay} burst@${beats.burst.delay}`);
check('sparks fly on the burst, not before',
    beats.spark.delay >= beats.burst.delay, `spark@${beats.spark.delay} burst@${beats.burst.delay}`);
check('the outcome is announced last',
    beats.out.delay > beats.burst.delay, `outcome@${beats.out.delay} burst@${beats.burst.delay}`);
check('the lead has faded before the outcome appears',
    beats.lead.delay + beats.lead.dur <= beats.out.delay + 100,
    `lead ends@${beats.lead.delay + beats.lead.dur} outcome@${beats.out.delay}`);

const overruns = Object.entries(beats).filter(([, b]) => b.delay + b.dur > lifetime);
check('nothing is still animating at dismissal', overruns.length === 0,
    overruns.map(([k, b]) => `${k} ends@${b.delay + b.dur}`).join(', ') + ` vs ${lifetime}ms`);

console.log('\n=== the white-out filter must not reach the burst ===');
check('glow is on .evo-morph', /\.evo-morph\s*{[^}]*animation:\s*evo-glow/.test(css));
check('glow is NOT on .evo-stage', !/\.evo-stage\s*{[^}]*animation:\s*evo-glow/.test(css),
    'a parent filter would invert the burst to black');
check('burst is a sibling, absolutely placed',
    /\.evo-burst\s*{[^}]*position:\s*absolute/.test(css));

console.log('\n=== flicker keyframes are exact complements ===');
// If they ever drift, some frame shows both sprites at once or neither.
function keyframes(name) {
    const i = css.indexOf('@keyframes ' + name);
    const body = css.slice(i, css.indexOf('\n}', i));
    const stops = [];
    for (const m of body.matchAll(/([\d.,%\s]+)\s*{\s*opacity:\s*([\d.]+);/g)) {
        const op = +m[2];
        for (const pct of m[1].split(',')) {
            const v = parseFloat(pct);
            if (!Number.isNaN(v)) stops.push([v, op]);
        }
    }
    return stops.sort((a, b) => a[0] - b[0]);
}
const out = keyframes('evo-flicker-out');
const inn = keyframes('evo-flicker-in');
check('both keyframe sets parsed', out.length > 10 && inn.length === out.length,
    `out=${out.length} in=${inn.length}`);
check('same stop percentages', out.every((s, i) => s[0] === inn[i][0]),
    JSON.stringify(out.map(s => s[0])) + ' vs ' + JSON.stringify(inn.map(s => s[0])));
check('opacities always sum to 1 (exactly one sprite visible)',
    out.every((s, i) => s[1] + inn[i][1] === 1),
    out.map((s, i) => `${s[0]}%:${s[1]}+${inn[i][1]}`).filter((_, i) => out[i][1] + inn[i][1] !== 1).join(' '));
check('starts on the old form', out[0][1] === 1 && inn[0][1] === 0);
check('ends on the new form', out.at(-1)[1] === 0 && inn.at(-1)[1] === 1);

// Swaps should get closer together, not further apart — that's what sells it.
const swaps = [];
for (let i = 1; i < out.length; i++) if (out[i][1] !== out[i - 1][1]) swaps.push(out[i][0]);
const gaps = swaps.slice(1).map((p, i) => p - swaps[i]);
check('flicker accelerates', gaps.at(-1) < gaps[0], `first gap ${gaps[0]}%, last ${gaps.at(-1)}%`);

console.log('\n=== reduced motion still shows the outcome ===');
const rm = /@media \(prefers-reduced-motion: reduce\) {([\s\S]*?)\n}/g;
const rmBlocks = [...css.matchAll(rm)].map(m => m[1]).join('\n');
check('new sprite forced visible', /\.evo-morph \.new-sprite\s*{[^}]*opacity:\s*1/.test(rmBlocks));
check('flicker disabled', /\.evo-morph \.old-sprite\s*{[^}]*display:\s*none/.test(rmBlocks));
check('name text not left invisible', /\.evo-desc\s*{[^}]*opacity:\s*1/.test(rmBlocks));
check('outcome block not left invisible', /\.evo-outcome\s*{[^}]*opacity:\s*1/.test(rmBlocks));
check('lead line not left invisible', /\.evo-lead\s*{[^}]*opacity:\s*1/.test(rmBlocks));
for (const layer of ['evo-flash', 'evo-rays', 'evo-ring', 'evo-burst', 'evo-particles']) {
    check(`${layer} suppressed`, new RegExp('\\.' + layer + '[^{]*{[^}]*display:\\s*none').test(rmBlocks)
        || new RegExp('\\.' + layer + '[,\\s]').test(rmBlocks.split('display: none')[0] || ''), 'still animating');
}
check('starter bob stopped', /\.starter-card\.selected \.starter-card-img\s*{[^}]*animation:\s*none/.test(rmBlocks));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
