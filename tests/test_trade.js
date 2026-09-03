const ROOT = require('path').join(__dirname, '..') + '/';
// Trading: the wiring that made it fail outright, and the scene that plays when
// it works. The transport itself is covered by test_sandbox.js, which holds the
// sandbox shim to background/trade.js route for route.
const fs = require('fs');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const raw = (rel) => fs.readFileSync(ROOT + rel, 'utf8');
// Comments stripped: assertions about what the code does must not be satisfied
// by prose explaining it. Several checks in this repo have been fooled that way.
const code = (rel) => raw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const trade = code('content/flickemon-trade.js');
const css = raw('content/styles.css');
const worker = code('background/service-worker.js');
const engine = code('content/flickemon-engine.js');
const shim = code('tests/pvp-sandbox/sandbox.js');

console.log('\n=== every trade route is answered end to end ===');
{
    // This is the bug that made trading impossible: the sandbox had all seven
    // PVP routes and none of the seven trade routes, and an unhandled type
    // returns undefined -- exactly what Chrome returns when nothing is
    // listening -- so the UI reported "Could not open a trade".
    const routes = [...worker.matchAll(/async (TRADE_[A-Z_]+)\(/g)].map(m => m[1]);
    check('the worker routes all seven', routes.length === 7, routes.join(','));

    for (const r of routes) {
        check(`${r}: the engine bridges it`, engine.includes(`'${r}'`), 'no sendToWorker call');
        check(`${r}: the sandbox mirrors it`, new RegExp(`async ${r}\\(`).test(shim),
            'the shim would answer undefined, which reads as a broken feature');
    }

    // Battles and trades derive the SAME 6-digit code, so one must not evict
    // the other out of the shared store.
    check('the shim namespaces trades away from battles', /tradeKey/.test(shim));
}

console.log('\n=== the scene plays after the swap, never before ===');
{
    // Sliced from the method definition to the NEXT one. onPartnerLeft is
    // called in tick() further up, so searching for it from zero finds the call
    // site and hands back an empty range that passes nothing.
    const from = trade.indexOf('async settle(');
    const settle = trade.slice(from, trade.indexOf('onPartnerLeft() {', from));
    check('the settle method was found', from > 0 && settle.length > 200, `${settle.length} chars`);

    check('the swap is applied first', settle.indexOf('applyTrade') < settle.indexOf('playTradeScene'));
    // The other trainer is polling for this. Making them wait out six seconds
    // of our scenery would be rude, and a tab closed mid-scene must not cost
    // anyone a Pokémon.
    check('and acknowledged before the scene, not after',
        settle.indexOf('tradeAck') < settle.indexOf('playTradeScene'),
        'the partner polls for this');
    check('a failed trade skips the scene entirely',
        /result && result\.ok/.test(settle) && /else \{[\s\S]{0,120}renderResult/.test(settle));
}

console.log('\n=== the scene itself ===');
{
    check('it exists', /playTradeScene\(/.test(trade));
    check('both Pokémon are drawn', /trade-traveller going/.test(trade)
        && /trade-traveller coming/.test(trade));
    check('each rides a ball', (trade.match(/ballSvg\(\)/g) || []).length >= 2);
    check('the ball is drawn, not an image file', /<svg class="trade-ball"/.test(trade));

    check('it can be skipped', /trade-skip/.test(trade) && /addEventListener\('click', finish\)/.test(trade));
    check('skipping twice does not run the result twice', /if \(finished\) return/.test(trade));
    check('and the timer is cleared when it does', /clearTimeout\(this\.sceneTimer\)/.test(trade));

    // Reduced motion, and a species the roster cannot resolve: both go straight
    // to the outcome rather than showing an empty frame.
    check('reduced motion goes straight to the result',
        /prefers-reduced-motion[\s\S]{0,200}?return done\(\)/.test(trade));
    check('so does an unresolvable species', /!sentSp \|\| !gotSp/.test(trade));

    // Species names come from flickemon-custom.js, which students edit by hand.
    check('names are escaped', /tradeEsc\(sentSp\.name\)/.test(trade));
    check('with its own helper, not pvp.js\'s bare global',
        /function tradeEsc/.test(trade) && !/\besc\(/.test(trade.replace(/tradeEsc\(/g, '')));
}

console.log('\n=== the scene fits in the time the JS gives it ===');
{
    // The stylesheet holds the timings and the JS holds the cutoff. Nothing
    // links them but this check, and the cost of drift is an animation that is
    // silently truncated -- which is exactly what happened first time.
    const block = css.slice(css.indexOf('The trade scene'), css.indexOf('.trade-slots {'));
    check('the scene block exists in the stylesheet', block.length > 500);

    const sec = v => (v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v));
    let worst = 0, who = '';
    for (const m of block.matchAll(/animation:\s*([a-z-]+)\s+([\d.]+m?s)([^;]*)/g)) {
        const [, name, dur, rest] = m;
        // An infinite animation has no end to fit; it is simply cut when the
        // scene closes, which is the intent.
        if (/\binfinite\b/.test(rest)) continue;
        const delay = (rest.match(/([\d.]+m?s)/) || [])[1];
        const end = sec(dur) + (delay ? sec(delay) : 0);
        if (end > worst) { worst = end; who = name; }
    }
    const budget = Number(trade.match(/TRADE_SCENE_MS = (\d+)/)[1]) / 1000;
    check('nothing is cut off', worst <= budget, `${who} ends at ${worst}s, budget ${budget}s`);
    // Not so slack that the scene ends in a dead pause either.
    check('and it does not end in dead air', budget - worst <= 1.0,
        `${(budget - worst).toFixed(2)}s of nothing after the last animation`);
    console.log(`      last to finish: ${who} at ${worst}s, budget ${budget}s`);
}

console.log('\n=== it looks like the rest of the game ===');
{
    const block = css.slice(css.indexOf('The trade scene'), css.indexOf('.trade-slots {'));

    // Every colour in this stylesheet resolves through a token, so a future
    // site theme carries the widget with it. A literal here would not follow.
    const literals = (block.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
        .concat(block.match(/\brgba?\([\d\s.,]+\)/g) || []);
    check('no hardcoded colours', literals.length === 0, literals.join(' '));

    // A duplicate @keyframes name silently overrides the earlier one
    // everywhere it is used. That had already happened once.
    const all = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const names = [...all.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map(m => m[1]);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    check('no keyframe name is defined twice', dupes.length === 0, dupes.join(', '));

    check('reduced motion is honoured', /prefers-reduced-motion/.test(css));
    check('it works on a narrow screen', /max-width: 460px[\s\S]{0,200}?trade-scene/.test(block));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
