const ROOT = require('path').join(__dirname, '..') + '/';
// Theme-proofing: no rule may hardcode a colour, so a new theme on the main
// site carries the widget with it. Also budgets the Firestore free tier.
const fs = require('fs');
const R = ROOT;
const css = fs.readFileSync(R + 'content/styles.css', 'utf8');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

// Everything after the token block is component CSS and must be literal-free.
const tokenBlockEnd = css.indexOf('\n', css.indexOf('    --type-fighting'));
const tokens = css.slice(0, tokenBlockEnd);
const rules = css.slice(tokenBlockEnd);

console.log('\n=== no component rule hardcodes a colour ===');
{
    // Two constructs are exempt, each for a stated reason:
    //   - the evo-glow keyframes, whose white must match invert(1)'s silhouette
    //   - mask-image, where a colour is an alpha stencil, not paint
    const glowStart = rules.indexOf('@keyframes evo-glow');
    const glowEnd = rules.indexOf('}', rules.indexOf('100%', glowStart));
    const exempt = (i) => (i > glowStart && i < glowEnd && glowStart !== -1);

    // Blank out comment bodies rather than skipping comment *lines*: the prose
    // wraps, and a continuation line looks like a declaration.
    const code = rules.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

    const offenders = [];
    const re = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g;
    let m;
    while ((m = re.exec(code))) {
        const lineStart = code.lastIndexOf('\n', m.index) + 1;
        const line = code.slice(lineStart, code.indexOf('\n', m.index));
        if (line.includes('mask-image')) continue;               // alpha stencil, not paint
        if (exempt(m.index)) continue;                           // white-out glow
        offenders.push(line.trim().slice(0, 90));
    }
    check('every colour resolves through a token', offenders.length === 0,
        '\n      ' + offenders.slice(0, 8).join('\n      '));
}

console.log('\n=== tokens read the host site before falling back ===');
{
    const surface = ['--flick-bg', '--flick-card-bg', '--flick-text',
                     '--flick-text-muted', '--flick-border', '--flick-primary'];
    for (const t of surface) {
        const m = new RegExp(t + ':\\s*var\\(--ion-').test(tokens);
        check(`${t} derives from an Ionic variable`, m);
    }
    // Semantic colours must move with the site's palette too.
    for (const t of ['--flick-danger', '--flick-success', '--flick-warning',
                     '--flick-hp-ok', '--flick-hp-warn', '--flick-hp-low', '--flick-gold']) {
        check(`${t} derives from an Ionic variable`,
            new RegExp(t + ':\\s*var\\(--ion-').test(tokens));
    }
}

console.log('\n=== nothing readable is pinned to a colour that can move ===');
{
    // Text on --flick-primary must come from the contrast token: a site that
    // themes primary dark would otherwise lose every button label at once.
    const onPrimary = /--flick-on-primary:\s*var\(--ion-color-primary-contrast/.test(tokens);
    check('--flick-on-primary tracks the primary contrast colour', onPrimary);

    const bad = [];
    for (const m of rules.matchAll(/\{[^}]*background:\s*var\(--flick-primary\)[^}]*\}/g)) {
        if (/(?:^|[\s;{])color:(?!\s*var\(--flick-on-primary)/.test(m[0])) bad.push(m[0].replace(/\s+/g, ' ').slice(0, 90));
    }
    check('every primary-backed rule uses --flick-on-primary', bad.length === 0, bad.join(' | '));
}

console.log('\n=== neutral fills survive a dark theme ===');
{
    // A fixed rgba(0,0,0,0.05) fill is invisible on a dark surface. Ionic's
    // step scale is derived between background and text, so it flips with it.
    // The arena paints its own world, like the evolution scene: a lecture
    // site's palette has no business repainting the ground a Pokémon stands on.
    check('the arena palette is fixed on purpose',
        /--flick-arena-sky-top:\s*#/.test(tokens) && /--flick-arena-ink:\s*#/.test(tokens));

    check('the QR colours are fixed on purpose, and only those',
        /--flick-qr-ground:\s*#ffffff/.test(tokens) && /--flick-qr-ink:\s*#/.test(tokens),
        'a QR must stay dark-on-white or it stops scanning');

    for (const t of ['--flick-fill-subtle', '--flick-fill', '--flick-fill-strong', '--flick-track']) {
        check(`${t} uses the Ionic step scale`,
            new RegExp(t + ':\\s*var\\(--ion-color-step-').test(tokens));
    }
    check('no fill is a fixed black wash',
        !/background:\s*rgba\(0,\s*0,\s*0,/.test(rules));
    // Fallbacks are grey rather than black so they show on either ground.
    check('step fallbacks are neutral grey, not black',
        !/--flick-fill[a-z-]*:\s*var\([^,]+,\s*rgba\(0,/.test(tokens));
}

console.log('\n=== one source of truth for type colours ===');
{
    const TYPES = ['normal','fire','water','grass','electric','poison','flying','bug','ground',
                   'psychic','rock','ghost','dragon','dark','steel','fairy','ice','fighting'];
    for (const t of TYPES) {
        check(`--type-${t} defined once`,
            (tokens.match(new RegExp('--type-' + t + ':', 'g')) || []).length === 1);
    }
    // .type-pill and .type-badge used to carry two different palettes, so the
    // same Fire type rendered in two oranges depending on the panel.
    const pillsOk = TYPES.every(t => rules.includes(`.type-pill.${t} { background: var(--type-${t});`));
    const badgesOk = TYPES.every(t => rules.includes(`.type-badge[data-type="${t}"] { background: var(--type-${t});`));
    check('type pills use the tokens', pillsOk);
    check('type badges use the same tokens', badgesOk);
    check('no second type palette survives',
        !/\.type-badge\[data-type="fire"\]\s*\{\s*background:\s*#/.test(rules));
}

console.log('\n=== a re-themed host actually moves every colour ===');
{
    // Resolve the token graph against a hypothetical dark theme and confirm
    // nothing stays stuck on a light-theme value.
    const host = {
        '--ion-background-color': '#101014',
        '--ion-text-color': '#e8e9f0',
        '--ion-card-background': '#1b1d26',
        '--ion-color-medium': '#9195a8',
        '--ion-border-color': '#31354',
        '--ion-color-primary': '#8ab4f8',
        '--ion-color-primary-contrast': '#06121f',
        '--ion-color-step-100': '#22242e',
    };
    const defs = [...tokens.matchAll(/(--flick-[\w-]+):\s*([^;]+);/g)];
    check('token block parsed', defs.length > 25, String(defs.length));

    let stuck = [];
    for (const [, name, value] of defs) {
        // Scene tokens paint the extension's own full-screen grounds and are
        // meant to be independent of the host surface.
        // This list is the register of scenes that lay down their own world:
        // a battle arena, a trade tunnel, the ball travelling through it. A
        // lecture site's palette has no business repainting the ground a
        // Pokemon is standing on, or handing a dark theme a black ball on a
        // black sky. `mask-` is not a colour at all -- a mask reads alpha and
        // ignores hue.
        const SCENE = ['scrim', 'shadow', 'spark', 'ray', 'burst', 'damage',
                       'on-type', 'field', 'tint-neutral', 'highlight', 'sheen', 'qr-',
                       'video-ground', 'arena-', 'tunnel-', 'ball-', 'mask-'];
        if (SCENE.some(k => name.includes(k))) continue;
        // A token pointing at another token inherits whatever that one does.
        if (/var\(--(?:type|flick)-[\w-]+/.test(value)) continue;
        if (!/var\(--ion-[\w-]+/.test(value)) stuck.push(`${name}: ${value.trim().slice(0, 40)}`);
    }
    check('every surface/semantic token follows the host', stuck.length === 0,
        '\n      ' + stuck.join('\n      '));

    const resolvable = defs.filter(([, , v]) => /var\(--ion-([\w-]+)/.test(v))
        .filter(([, , v]) => host[/var\((--ion-[\w-]+)/.exec(v)[1]] !== undefined);
    check('the sampled dark palette reaches the widget', resolvable.length >= 6,
        `${resolvable.length} tokens resolved against the sample`);
}

console.log('\n=== Firestore free-tier budget ===');
{
    const engine = fs.readFileSync(R + 'content/flickemon-engine.js', 'utf8');
    const pvp = fs.readFileSync(R + 'content/flickemon-pvp.js', 'utf8');
    const num = (src, name) => Number(new RegExp(name + '\\s*=\\s*(\\d+)').exec(src)[1]);

    const push = num(engine, 'CLOUD_PUSH_DEBOUNCE_MS');
    const poll = num(engine, 'CLOUD_POLL_INTERVAL_MS');

    // Spark plan: 50,000 reads and 20,000 writes per day, across all users.
    const USERS = 100, TAB_HOURS = 8, WATCH_HOURS = 5;
    const reads = USERS * TAB_HOURS * (3600000 / poll);
    const writes = USERS * WATCH_HOURS * (3600000 / push);
    console.log(`      saves: ${reads.toLocaleString()} reads/day, ${writes.toLocaleString()} writes/day @ ${USERS} users`);

    check('save reads leave 2x headroom', reads <= 25000, `${reads}/50000`);
    check('save writes leave 2x headroom', writes <= 10000, `${writes}/20000`);

    const awaiting = num(pvp, 'POLL_AWAITING_MS');
    const myTurn = num(pvp, 'POLL_MY_TURN_MS');
    const lobbyMax = num(pvp, 'POLL_LOBBY_MAX_MS');

    check('the fast cadence is reserved for waiting on the opponent',
        awaiting <= 2000, `${awaiting}ms`);
    check('my own turn polls far more slowly', myTurn >= 6 * awaiting,
        `${myTurn}ms vs ${awaiting}ms`);
    check('an idle lobby backs off', lobbyMax >= 10000, `${lobbyMax}ms`);
    check('the loop stops when the battle is over',
        /phase === 'over'\) return null/.test(pvp));
    check('an unanswered lobby closes itself', /LOBBY_GIVE_UP_MS/.test(pvp));
    check('a hidden tab stops reading',
        /visibilityState === 'hidden'/.test(pvp) && /stopPolling\(\)/.test(pvp));
    check('save polling also skips a hidden tab',
        /visibilityState === 'visible'/.test(engine));

    // A six-turn battle: 8s deciding, 5s waiting on the opponent, per turn.
    // The read on submitting falls inside the waiting window, so it is already
    // counted by ceil(WAIT / awaiting) rather than added on top.
    const TURNS = 6, DECIDE = 8000, WAIT = 5000, LOBBY = 30000;
    const lobbyReads = 5;                     // 2.5s backing off to 15s over ~30s
    const perBattle = lobbyReads + TURNS * (Math.ceil(DECIDE / myTurn) + Math.ceil(WAIT / awaiting));
    const oldPerBattle = (LOBBY + TURNS * (DECIDE + WAIT)) / 1500;

    // What actually matters is the combined daily total, not the ratio: saves
    // and PVP draw on the same 50,000 reads.
    const BATTLERS = 20, BATTLES_EACH = 3;
    const pvpReads = BATTLERS * BATTLES_EACH * perBattle;
    const total = reads + pvpReads;
    console.log(`      pvp:   ${perBattle} reads/player/battle (was ${Math.round(oldPerBattle)}), `
              + `${pvpReads.toLocaleString()}/day @ ${BATTLERS} battlers`);

    check('PVP is materially cheaper than a flat 1.5s loop',
        perBattle < oldPerBattle * 0.6, `${perBattle} vs ${Math.round(oldPerBattle)}`);

    // ── Friends ──
    //
    // The most expensive thing in the extension, and the only one that scales
    // with somebody else's choices: a feed sweep is ONE READ PER FRIEND, and
    // FRIEND_MAX is 30. Budgeted at the worst case the code can actually reach,
    // not at typical use, because the whole point of the sweep budget is that
    // the worst case is bounded at all.
    const friends = fs.readFileSync(R + 'content/flickemon-friends.js', 'utf8');
    const cfgSrc = fs.readFileSync(R + 'content/flickemon-config.js', 'utf8');

    const sweepBudget = num(friends, 'FRIENDS_SWEEP_BUDGET');
    const friendPoll = num(friends, 'FRIENDS_POLL_MS');
    const friendPollMax = num(friends, 'FRIENDS_POLL_MAX_MS');
    const friendMax = num(cfgSrc, 'FRIEND_MAX');
    const boardLimit = num(fs.readFileSync(R + 'background/friends.js', 'utf8'), 'LEADERBOARD_LIMIT');

    check('a feed sweep is bounded per panel session', sweepBudget <= 8, String(sweepBudget));
    check('the poll floor is slower than the save cadence that feeds it',
        friendPoll >= push / 2, `${friendPoll}ms vs push ${push}ms`);
    check('an abandoned panel backs off to minutes', friendPollMax >= 300000,
        `${friendPollMax}ms`);
    check('the budget applies to manual refreshes too, not just the timer',
        /canSweep\(/.test(friends) && /FRIENDS_MANUAL_MIN_MS/.test(friends));
    check('feeds are cached somewhere that survives worker eviction',
        /createSessionCache/.test(fs.readFileSync(R + 'background/friends.js', 'utf8')));
    check('a friends panel stops reading when the tab is hidden',
        /visibilityState === 'hidden'/.test(friends) && /stopPolling\(\)/.test(friends));

    // Worst case one student can reach: every sweep spent, a full friend list,
    // the friendship query, and a board view.
    const FRIEND_USERS = 40, OPENS_EACH = 2;
    const perOpen = sweepBudget * friendMax + friendMax + boardLimit;
    const friendReads = FRIEND_USERS * OPENS_EACH * perOpen;
    console.log(`      friends: ${perOpen} reads/open worst case, `
              + `${friendReads.toLocaleString()}/day @ ${FRIEND_USERS} users x${OPENS_EACH}`);

    // ── Shop ──
    //
    // Zero reads and zero extra writes by construction: the wallet, the eggs
    // and the boosts all ride the save blob that was already being written, and
    // a purchase takes the ordinary debounce rather than an immediate push.
    const shop = fs.readFileSync(R + 'content/flickemon-shop.js', 'utf8');
    check('the shop opens no connections of its own',
        !/fetch\(|sendMessage/.test(shop));
    check('a shopping spree coalesces into one write',
        !/saveGameState\(\{ immediate: true \}\)/.test(
            engine.slice(engine.indexOf('async buyBoost'), engine.indexOf('hatchTick()'))));

    const grand = total + friendReads;
    console.log(`      TOTAL: ${grand.toLocaleString()} reads/day = `
              + `${Math.round(grand / 500)}% of the free tier`);

    check('saves, PVP and friends together stay under 60% of the read tier',
        grand <= 30000, `${grand}/50000`);

    check('an unchanged save is not written at all',
        /lastPushedFingerprint/.test(engine) && /cloudFingerprint/.test(engine));
    check('the fingerprint ignores the timestamp that always moves',
        /const \{ lastSyncedAt, \.\.\.content \} = payload/.test(engine));
}

console.log('\n=== the page is not asked to do needless work ===');
{
    const ui = fs.readFileSync(R + 'content/flickemon-ui.js', 'utf8');
    const cs = fs.readFileSync(R + 'content/content-script.js', 'utf8');

    // 1,025 dex rows: one request per visible sprite, not per species.
    check('dex sprites load lazily', /class="pokedex-sprite[^"]*"[\s\S]{0,120}loading="lazy"/.test(ui));
    check('dex sprites are sized so lazy loading does not reflow',
        /width="64" height="64"/.test(ui));
    check('dex lookup is a Map, not a scan per row',
        /new Map\(pokedex\.map/.test(ui) && !/pokedex\.find\(p => p\.speciesId === sp\.id\)/.test(ui));

    check('mutation bursts coalesce into one check',
        /injectQueued/.test(cs) && /requestAnimationFrame/.test(cs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
