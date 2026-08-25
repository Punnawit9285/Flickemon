const ROOT = require('path').join(__dirname, '..') + '/';
// The guide quotes real numbers, so it must not drift from the config or from
// what the engine actually does.
global.window = { addEventListener() {} };
require(ROOT + 'content/flickemon-config.js');
global.document = { addEventListener() {} };
require(ROOT + 'content/flickemon-ui.js');
const cfg = global.window.FlickemonConfig;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const el = () => ({
    className: '', innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [],
    setAttribute() {}, removeAttribute() {}, remove() {},
});
global.document.createElement = el;
global.document.body = { appendChild() {} };

function render(method) {
    const ui = new global.window.FlickemonUI({ onStateChange(){}, onWildChange(){}, onEvolution(){} });
    let html = '';
    ui.createModalOverlay = () => {
        const body = el();
        Object.defineProperty(body, 'innerHTML', { get: () => html, set: v => { html = v; } });
        return { overlay: el(), body };
    };
    ui[method]();
    return html;
}
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('\n=== the guide states the real tuning ===');
{
    const t = text(render('openGuideModal'));

    check('capture bonus matches config', t.includes(`${cfg.BATTLE_WIN_EXP_BONUS}x EXP per win`),
        `config says ${cfg.BATTLE_WIN_EXP_BONUS}`);
    check('exp bonus matches config', t.includes(`${cfg.EXP_MODE_WIN_EXP_BONUS}x EXP`));
    check('team share matches config',
        t.includes(`${Math.round(cfg.TEAM_EXP_SHARE * 100)}%`), String(cfg.TEAM_EXP_SHARE));
    check('team size matches config', t.includes(`Up to ${cfg.MAX_TEAM_SIZE} Pokémon`));
    check('evolution levels match config',
        t.includes(`Lv.${cfg.EVOLUTION_LEVELS.stage1ToStage2}`)
        && t.includes(`Lv.${cfg.EVOLUTION_LEVELS.stage2ToStage3}`));
    check('level ceiling matches config', t.includes(`Lv.${cfg.MAX_LEVEL}`));
    check('shiny rate matches config',
        t.includes(`1 in ${Math.round(1 / cfg.SHINY_CHANCE)}`), oneInText());
    check('escape rate matches config',
        t.includes(`${Math.round(cfg.ESCAPE_EXP_MULTIPLIER * 100)}% EXP`));
    check('every PVP format is listed',
        (cfg.PVP_MODES || []).every(m => t.includes(m.label)),
        JSON.stringify((cfg.PVP_MODES || []).map(m => m.label)));
    check('every reward is named',
        Object.values(cfg.REWARDS).every(k => t.includes(cfg.REWARD_INFO[k].label)));
    check('the loss lockout is stated',
        !cfg.PVP_LOSS_LOCKOUT_MS || t.includes(`${Math.round(cfg.PVP_LOSS_LOCKOUT_MS / 60000)} minutes`));

    function oneInText() { return `config: 1 in ${Math.round(1 / cfg.SHINY_CHANCE)}`; }

    // The behaviour the guide promises about study time.
    check('says speed does not matter', /2x or 10x earns exactly the same/.test(t));
    check('says seeking earns nothing', /skipping ahead earns nothing/.test(t));
    check('says devices add up', /added together/.test(t));
    check('says duplicates are separate', /second, separate/.test(t));
    check('says boosts do not stack', /Only one boost runs at a time/.test(t));

    check('block length matches config',
        t.includes(`around ${cfg.BALANCE_REFERENCE.blockHours} hours of recordings`),
        `config says ${cfg.BALANCE_REFERENCE.blockHours}`);
    check('the block framing is stated',
        /One block, one fully evolved Pok/.test(t));
    // The comparison only holds while a block and a full evolution cost the same.
    check('one block really does equal one full evolution',
        cfg.BALANCE_REFERENCE.blockHours === cfg.BALANCE_REFERENCE.fullyEvolvedHours.capture,
        `block ${cfg.BALANCE_REFERENCE.blockHours}h vs evolution ${cfg.BALANCE_REFERENCE.fullyEvolvedHours.capture}h`);
    check('and two of them in EXP mode',
        cfg.BALANCE_REFERENCE.fullyEvolvedHours.exp * 2 === cfg.BALANCE_REFERENCE.blockHours,
        `${cfg.BALANCE_REFERENCE.fullyEvolvedHours.exp}h x2 vs ${cfg.BALANCE_REFERENCE.blockHours}h`);

    check('no unresolved template holes', !t.includes('undefined') && !t.includes('NaN'), t.slice(0, 200));
}

console.log('\n=== the hour figures still match the engine ===');
{
    // BALANCE_REFERENCE is measured, not derived. Re-measure and fail on drift,
    // so tuning the EXP economy cannot leave the guide quoting stale hours.
    global.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } },
                      runtime: { sendMessage: async () => null } };
    global.document.visibilityState = 'visible';
    const realTimeout = global.setTimeout;
    global.setTimeout = f => { f(); return 0; };
    global.clearTimeout = () => {};
    global.setInterval = () => 0;
    delete require.cache[require.resolve(ROOT + 'content/flickemon-engine.js')];
    require(ROOT + 'content/flickemon-engine.js');
    const e = global.window.flickemonEngine;

    async function hoursTo(level, mode) {
        e.gameState = e.createEmptyState();
        e.isLoaded = true; e.deviceId = 'sim';
        await e.chooseStarter(1);
        e.gameState.battleMode = mode;
        let seconds = 0;
        const CAP = 3600 * 400;
        while (seconds < CAP && e.getActivePokemon().level < level) {
            await e.onVideoProgress(10);
            seconds += 10;
        }
        return seconds / 3600;
    }

    const bal = cfg.BALANCE_REFERENCE;
    const within = (actual, claimed, tol = 0.15) =>
        Math.abs(actual - claimed) / claimed <= tol;

    (async () => {
        for (const [label, level, key] of [
            ['fully evolved', cfg.EVOLUTION_LEVELS.stage2ToStage3, 'fullyEvolvedHours'],
        ]) {
            for (const mode of ['capture', 'exp']) {
                const actual = await hoursTo(level, mode);
                const claimed = bal[key][mode];
                console.log(`      ${label} (${mode}): guide says ${claimed}h, engine gives ${actual.toFixed(1)}h`);
                check(`${label} in ${mode} mode is accurate`, within(actual, claimed),
                    `${actual.toFixed(1)}h vs claimed ${claimed}h`);
            }
        }
        global.setTimeout = realTimeout;

        console.log('\n=== support page ===');
        {
            const html = render('openSupportModal');
            const t = text(html);
            check('names the two costs', /Running costs/.test(t) && /Building the next one/.test(t));
            check('mentions the database going past free', /stops being free/.test(t));
            check('says nothing is paywalled', /every feature is already yours/i.test(t));
            check('shows a QR slot', html.includes('support-qr'));
            check('has a fallback when the image is missing',
                html.includes('support-qr-missing') && html.includes('promptpay-qr.png'));
            check('the QR path resolves through the extension',
                html.includes('icons/promptpay-qr.png'));
            check('no unresolved template holes', !t.includes('undefined'), t.slice(0, 120));
        }

        console.log('\n=== both entries reachable from the menu ===');
        {
            const uiSrc = require('fs').readFileSync(ROOT + 'content/flickemon-ui.js', 'utf8');
            check('How to Play is in the menu', uiSrc.includes('guide-item') && uiSrc.includes('How to Play'));
            check('Support is in the menu', uiSrc.includes('support-item') && uiSrc.includes('Support the Creator'));
            check('both are wired up',
                /guide-item'\)\.addEventListener/.test(uiSrc) && /support-item'\)\.addEventListener/.test(uiSrc));

            const mf = require('fs').readFileSync(ROOT + 'manifest.json', 'utf8');
            check('the QR is web-accessible', mf.includes('icons/*.png'));

            // The order was chosen deliberately: play, learn, listen, adjust,
            // and only then the ask.
            const menuStart = uiSrc.indexOf('options-popover-menu');
            const menu = uiSrc.slice(menuStart, uiSrc.indexOf('</div>\n                </div>', menuStart));
            const labels = [...menu.matchAll(/<\/span>\s*([A-Za-z ]+?)<\/div>/g)]
                .map(m => m[1].trim()).filter(Boolean);
            check('menu order is Game Hub, How to Play, Music, Settings, Support',
                labels.join(' | ') === 'Game Hub | How to Play | Music | Settings | Support the Creator',
                labels.join(' | '));

            // One outlined glyph among filled ones reads as a weight mismatch
            // rather than a different icon.
            const icons = ['menuGameControllerSvg', 'bookSvg', 'noteSvg', 'gearSvg', 'heartSvg'];
            const fills = icons.map(n => {
                const m = new RegExp(n + " = `<svg[^>]*fill=\"([^\"]+)\"").exec(uiSrc);
                return m ? m[1] : 'missing';
            });
            check('every menu icon is filled the same way',
                fills.every(f => f === 'currentColor'),
                icons.map((n, i) => `${n}=${fills[i]}`).join(' '));
            check('none of them is stroke-only',
                !icons.some(n => new RegExp(n + " = `<svg[^>]*stroke=").test(uiSrc)));
        }

        console.log('\n=== mega is described only where it exists ===');
        {
            // Mega lives on its own branch. The guide must not describe a feature
            // the running build does not have — nor omit it once it lands.
            const before = text(render('openGuideModal'));
            check('absent when the config has no mega data',
                !cfg.MEGA_FORMS ? !before.includes('Mega Evolution') : before.includes('Mega Evolution'),
                cfg.MEGA_FORMS ? 'config HAS mega' : 'config has no mega');

            const saved = cfg.MEGA_FORMS;
            cfg.MEGA_FORMS = { 3: [{ key: 'a' }], 6: [{ key: 'b' }, { key: 'c' }] };
            cfg.MEGA_DAMAGE_MULTIPLIER = 1.30;
            cfg.MEGA_STONE_CHANCE = 0.10;
            const after = text(render('openGuideModal'));
            check('appears once the data is there', after.includes('Mega Evolution'));
            check('quotes the damage multiplier', after.includes('1.3x damage'));
            check('quotes the drop chance', after.includes('10% chance'));
            check('counts forms and species', after.includes('3 across 2 species'));
            check('says stats are unchanged', /base stats are untouched/.test(after));
            if (saved === undefined) delete cfg.MEGA_FORMS; else cfg.MEGA_FORMS = saved;
        }

        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail ? 1 : 0);
    })();
}
