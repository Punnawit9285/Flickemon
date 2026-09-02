const ROOT = require('path').join(__dirname, '..') + '/';
// Bundled sprites: complete coverage, correct URL resolution, and a fallback
// for every context that has no extension runtime.
const fs = require('fs');
const path = require('path');
const R = ROOT;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

function loadConfig(chromeStub) {
    for (const k of Object.keys(require.cache)) delete require.cache[k];
    global.window = {};
    if (chromeStub === undefined) delete global.chrome;
    else global.chrome = chromeStub;
    require(R + 'content/flickemon-config.js');
    return global.window.FlickemonConfig;
}

console.log('\n=== every sprite the game can reference is on disk ===');
{
    const cfg = loadConfig(undefined);
    const missingFront = [], missingBack = [], empty = [];
    for (const sp of cfg.POKEMON_REGISTRY) {
        for (const [dir, miss] of [['sprites', missingFront], ['sprites/back', missingBack],
                                  ['sprites/shiny', missingFront], ['sprites/back/shiny', missingBack]]) {
            const f = path.join(R, dir, `${sp.id}.png`);
            if (!fs.existsSync(f)) miss.push(sp.id);
            else if (fs.statSync(f).size === 0) empty.push(`${dir}/${sp.id}`);
        }
    }
    check(`all ${cfg.POKEMON_REGISTRY.length} front sprites bundled`, missingFront.length === 0,
        missingFront.slice(0, 10).join(', '));
    check('all back sprites bundled (PVP draws your own from behind)',
        missingBack.length === 0, missingBack.slice(0, 10).join(', '));
    check('none are zero-byte', empty.length === 0, empty.slice(0, 5).join(', '));

    // Starters and evolution targets are reachable from the registry, but check
    // the chains explicitly — an evolution to an unbundled id is a blank sprite
    // at the most visible moment in the game.
    const ids = new Set(cfg.POKEMON_REGISTRY.map(s => s.id));
    const orphanEvo = cfg.EVOLUTION_CHAINS.filter(c => !ids.has(c.toId) || !ids.has(c.fromId));
    check(`all ${cfg.EVOLUTION_CHAINS.length} evolution targets are bundled species`,
        orphanEvo.length === 0, orphanEvo.slice(0, 5).map(c => `${c.fromId}->${c.toId}`).join(', '));
    check('all starters bundled', cfg.STARTER_OPTIONS.every(id => ids.has(id)));
}

console.log('\n=== they are real PNGs, not stubs or HTML error pages ===');
{
    const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bad = [];
    let total = 0;
    for (const dir of ['sprites', 'sprites/back', 'sprites/shiny', 'sprites/back/shiny']) {
        for (const f of fs.readdirSync(path.join(R, dir))) {
            if (!f.endsWith('.png')) continue;
            const p = path.join(R, dir, f);
            total += fs.statSync(p).size;
            const fd = fs.openSync(p, 'r');
            const head = Buffer.alloc(8);
            fs.readSync(fd, head, 0, 8, 0);
            fs.closeSync(fd);
            if (!head.equals(MAGIC)) bad.push(`${dir}/${f}`);
        }
    }
    check('every file carries the PNG signature', bad.length === 0, bad.slice(0, 5).join(', '));
    console.log(`      ${(total / 1048576).toFixed(2)} MB across 4,100 files`);
    check('the bundle stays under 6 MB', total < 6 * 1024 * 1024,
        `${(total / 1048576).toFixed(2)} MB`);
}

console.log('\n=== URLs resolve to the bundle inside the extension ===');
{
    const calls = [];
    const cfg = loadConfig({
        runtime: {
            getURL: (p) => { calls.push(p); return 'chrome-extension://abc/' + p; },
        },
    });
    check('front sprite comes from the bundle',
        cfg.getSpriteUrl(25) === 'chrome-extension://abc/sprites/25.png', cfg.getSpriteUrl(25));
    check('back sprite comes from the bundle',
        cfg.getBackSpriteUrl(25) === 'chrome-extension://abc/sprites/back/25.png', cfg.getBackSpriteUrl(25));
    check('nothing reaches for GitHub', !cfg.getSpriteUrl(25).includes('githubusercontent'));
    const asked = [...new Set(calls)].sort();
    check('the runtime was asked for exactly these two paths',
        JSON.stringify(asked) === JSON.stringify(['sprites/25.png', 'sprites/back/25.png']),
        JSON.stringify(asked));
    check('paths are relative to the extension root, not absolute',
        asked.every(p => !p.startsWith('/')), JSON.stringify(asked));
}

console.log('\n=== and fall back wherever there is no extension ===');
{
    // The test harness and the standalone review page both load this file bare.
    const cfg = loadConfig(undefined);
    check('falls back to the remote host',
        cfg.getSpriteUrl(25) === cfg.SPRITE_BASE_URL + '/25.png', cfg.getSpriteUrl(25));
    check('back sprite falls back too',
        cfg.getBackSpriteUrl(25) === cfg.SPRITE_BASE_URL + '/back/25.png');

    // Every open tab keeps running its old content script after an extension
    // update, and getURL throws from then on. A broken image is a worse answer
    // than a slow one.
    const cfg2 = loadConfig({
        runtime: {
            getURL: () => { throw new Error('Extension context invalidated.'); },
        },
    });
    let threw = false;
    let url;
    try { url = cfg2.getSpriteUrl(25); } catch { threw = true; }
    check('an invalidated context does not throw', !threw);
    check('and falls back to the network', url === cfg2.SPRITE_BASE_URL + '/25.png', url);

    // A runtime with no getURL at all (some injected contexts) must not crash.
    const cfg3 = loadConfig({ runtime: {} });
    check('a runtime without getURL falls back', cfg3.getSpriteUrl(1).includes('githubusercontent'));
    const cfg4 = loadConfig({});
    check('a chrome object without runtime falls back', cfg4.getSpriteUrl(1).includes('githubusercontent'));
}

console.log('\n=== the manifest actually exposes them ===');
{
    const m = JSON.parse(fs.readFileSync(R + 'manifest.json', 'utf8'));
    const war = m.web_accessible_resources;
    check('web_accessible_resources declared', Array.isArray(war) && war.length === 1);

    const res = war[0].resources;
    // An <img> in the page's DOM is a page-context request, so the file has to
    // be web-accessible or Chrome blocks it however the URL was built.
    check('front sprites are exposed', res.includes('sprites/*.png'), JSON.stringify(res));
    check('back sprites are exposed explicitly', res.includes('sprites/back/*.png'),
        'relying on * crossing a / would be a guess');
    check('shiny sprites are exposed', res.includes('sprites/shiny/*.png'), JSON.stringify(res));
    check('shiny back sprites are exposed', res.includes('sprites/back/shiny/*.png'), JSON.stringify(res));
    check('custom sprites are exposed', res.includes('sprites/custom/*.png'), JSON.stringify(res));

    check('exposure is limited to the lecture site',
        JSON.stringify(war[0].matches) === JSON.stringify(['https://flick.docchula.com/*']),
        JSON.stringify(war[0].matches));
    check('the content script host list still matches',
        JSON.stringify(m.content_scripts[0].matches) === JSON.stringify(war[0].matches));
}

console.log('\n=== the art in flickemon-custom.js is actually there ===');
{
    // A typo in a `sprite:` filename is the likeliest mistake an author makes,
    // and its only symptom in the game is a broken image. Read the real file --
    // not a fixture -- so this fails here instead of on someone's screen.
    for (const k of Object.keys(require.cache)) delete require.cache[k];
    global.window = {};
    delete global.chrome;
    require(R + 'content/flickemon-custom.js');
    require(R + 'content/flickemon-config.js');
    const cfg = global.window.FlickemonConfig;

    check('the shipped roster has no rejected entries',
        cfg.customRosterProblems().length === 0,
        cfg.customRosterProblems().join('; '));

    const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const missing = [], notPng = [];
    for (const sp of cfg.customRoster()) {
        for (const file of [sp.sprite, sp.shinySprite, sp.backSprite].filter(Boolean)) {
            const f = path.join(R, 'sprites/custom', file);
            if (!fs.existsSync(f)) { missing.push(`${sp.key}: ${file}`); continue; }
            const fd = fs.openSync(f, 'r');
            const head = Buffer.alloc(8);
            fs.readSync(fd, head, 0, 8, 0);
            fs.closeSync(fd);
            if (!head.equals(MAGIC)) notPng.push(`${sp.key}: ${file}`);
        }
    }
    check('every declared sprite is on disk', missing.length === 0, missing.join(', '));
    check('and every one is a real PNG', notPng.length === 0, notPng.join(', '));
    check('none of them leaked into the Pokédex',
        !cfg.POKEMON_REGISTRY.some(sp => sp.isCustom));
}

console.log('\n=== the build ships them ===');
(() => {
    const cfg = loadConfig(undefined);
    const build = fs.readFileSync(R + 'build.sh', 'utf8');
    check('build.sh copies every sprite variant',
        ['cp sprites/*.png', 'cp sprites/back/*.png',
         'cp sprites/shiny/*.png', 'cp sprites/back/shiny/*.png'].every(g => build.includes(g)));
    // Player-drawn art. An empty folder is the normal case, so the copy must
    // not be able to fail the build when nothing matches.
    check('build.sh copies custom sprites, tolerating none',
        build.includes('cp sprites/custom/*.png') && build.includes('|| true'));

    // The script exists to ship only what the manifest references; a recursive
    // copy would sweep in PROVENANCE.md alongside the images.
    const DIRS = ['dist/sprites', 'dist/sprites/back', 'dist/sprites/shiny',
                  'dist/sprites/back/shiny', 'dist/sprites/custom'];
    const SUBDIRS = new Set(['back', 'shiny', 'custom']);
    const stray = DIRS.flatMap(d => fs.existsSync(R + d)
        ? fs.readdirSync(R + d).filter(f => !f.endsWith('.png') && !SUBDIRS.has(f))
        : [d + ' missing']);
    check('nothing but PNGs ships in the sprite folder', stray.length === 0, stray.join(', '));
    // sprites/custom/ carries a README for whoever is drawing the art. It is
    // documentation for the repo, not an asset for the package.
    check('the custom sprite README stays out of the build',
        !fs.existsSync(R + 'dist/sprites/custom/README.md'));

    // dist/ is gitignored, so a fresh clone has nothing to inspect until
    // ./build.sh has run. Skipping is honest; failing would just be noise.
    if (!fs.existsSync(R + 'dist')) {
        console.log('  SKIP  dist/ checks — run ./build.sh first');
        return;
    }

    const distFront = R + 'dist/sprites/1.png';
    const distBack = R + 'dist/sprites/back/1.png';
    check('dist carries front sprites', fs.existsSync(distFront));
    check('dist carries back sprites', fs.existsSync(distBack));
    if (fs.existsSync(R + 'dist/sprites')) {
        const n = fs.readdirSync(R + 'dist/sprites').filter(f => f.endsWith('.png')).length;
        // Derived, not hardcoded: the bundle is one file per species plus one
        // per Mega form, and a literal here would have to be edited by hand
        // every time either set grows.
        const expected = cfg.POKEMON_REGISTRY.length
            + Object.values(cfg.MEGA_FORMS).reduce((t, forms) => t + forms.length, 0);
        check('dist has the full front set', n === expected, `${n}, expected ${expected}`);
    }

    // Packaging strips the dev key for the Web Store, but dist/ must stay
    // loadable unpacked afterwards — without the key the extension ID changes
    // and the OAuth redirect stops matching.
    const dm = JSON.parse(fs.readFileSync(R + 'dist/manifest.json', 'utf8'));
    check('dist/ keeps the dev key after packaging', typeof dm.key === 'string');
    check('no packaging scratch files left behind',
        !fs.existsSync(R + 'dist/manifest.store.json') && !fs.existsSync(R + 'dist/manifest.dev.json'));
})();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
