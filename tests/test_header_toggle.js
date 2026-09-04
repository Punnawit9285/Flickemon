const ROOT = require('path').join(__dirname, '..') + '/';
// The header pill must render the current mode and switch it on click.
const fs=require('fs');
let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);

const ui=fs.readFileSync(ROOT + 'content/flickemon-ui.js','utf8');
const cssRaw=fs.readFileSync(ROOT + 'content/styles.css','utf8');
const css=cssRaw.replace(/[ \t]+/g,' ');

console.log('\n=== pill lives in the header, next to the menu button ===');
const hdr=ui.slice(ui.indexOf('<div class="header-actions">'), ui.indexOf('<!-- Options Popover Menu -->'));
check('switch is inside header-actions', hdr.includes('mode-switch'));
check('switch sits before the ⋮ menu button',
      hdr.indexOf('mode-switch') < hdr.indexOf('menu-trigger-btn'));
check('has BOTH options visible at once', hdr.includes('data-mode="capture"') && hdr.includes('data-mode="exp"'));
check('marks which one is on', hdr.includes('aria-pressed'));
check('uses inline SVG icons', hdr.includes('${pokeballSvg}') && hdr.includes('${boltSvg}'));
check('no emoji left in the switch', !/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(hdr), hdr.match(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu)||'');
check('icons are real svg markup', ui.includes('const pokeballSvg = `<svg') && ui.includes('const boltSvg = `<svg'));
check('each option explains itself', (hdr.match(/title="/g)||[]).length>=2);

console.log('\n=== removed from Settings (moved, not duplicated) ===');
check('no Settings mode card', !ui.includes('flickemon-list-item-title">Battle Mode'));
check('no leftover .mode-btn handlers', !ui.includes(".querySelectorAll('.mode-btn')"));
check('no dead CSS for the old Settings cards', !css.includes('.mode-btn strong'));

console.log('\n=== click behaviour ===');
const h=ui.slice(ui.indexOf(".mode-seg').forEach"), ui.indexOf('const menuBtn'));
check('stops propagation (popover would swallow it)', h.includes('stopPropagation'));
check('each segment selects its own mode directly', h.includes('seg.dataset.mode'));
check('awaits setBattleMode (persists + syncs)', h.includes('await this.engine.setBattleMode'));

console.log('\n=== styling present for both states ===');
check('active capture segment is filled', css.includes('.mode-seg[data-mode="capture"][aria-pressed="true"]'));
check('active exp segment is filled', css.includes('.mode-seg[data-mode="exp"][aria-pressed="true"]'));
check('no absolutely-positioned thumb to misalign', !css.includes('mode-switch-thumb'));
check('icons cannot be squashed', css.includes('.mode-seg svg'));
// Must be the contrast TOKEN, not a literal white: a site that themes its
// primary light would lose the label on the filled segment.
check('active segment gets contrasting text',
      (css.match(/\.mode-seg\[data-mode="(capture|exp)"\]\[aria-pressed="true"\][^}]*color: var\(--flick-on-primary\)/g)||[]).length===2);
check('and the fill itself is themed',
      /\.mode-seg\[data-mode="capture"\]\[aria-pressed="true"\][^}]*background: var\(--flick-capture\)/.test(css));
check('inactive segment is muted', css.includes('color: var(--flick-text-muted)'));
check('collapses to icons on narrow widgets', css.includes('.mode-seg-label'));
check('respects reduced motion', css.includes('prefers-reduced-motion'));

console.log('\n=== the header fits, whatever it is inside ===');
{
    // Eight controls share this row — two mode segments, PVP, Trade, Friends,
    // the mart, the menu and the collapse chevron. They used to be measured
    // against @media, which asks how wide the SCREEN is. The widget lives in a
    // column on someone else's lecture page, so a narrow column on a large
    // monitor matched no breakpoint at all and the row ran off the card. These
    // assert the fix is still in place, because the next feature to add a
    // header button will silently re-break it.
    //
    // Comments stripped: several of them describe the bug being prevented and
    // would otherwise satisfy a naive match.
    const code = css.replace(/\/\*[^]*?\*\//g, '');
    const rule = name => {
        const i = code.indexOf(name);
        return i < 0 ? '' : code.slice(i, code.indexOf('}', i) + 1);
    };

    check('the card is a query container, so the rules measure the widget',
        /container-type:\s*inline-size/.test(code) && /container-name:\s*flickemon/.test(code));
    check('and the breakpoints ask the container, not the screen',
        (code.match(/@container flickemon/g) || []).length >= 3);

    // The load-bearing one: wrapping is on at every width, so even where a
    // container query never runs the row cannot leave the card.
    check('the header wraps unconditionally, not only under a breakpoint',
        /\.flickemon-header,[^{]*\{[^}]*flex-wrap:\s*wrap/.test(code),
        rule('.flickemon-card .flickemon-header,').slice(0, 90));
    check('so does the actions row', /\.header-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(code));

    // Without these a flex item refuses to shrink past its content and pushes
    // the row wider than the card instead of wrapping.
    check('both sides of the header may shrink',
        /\.header-left\s*\{[^}]*min-width:\s*0/.test(code)
        && /\.header-actions\s*\{[^}]*min-width:\s*0/.test(code));
    check('and the title truncates rather than pushing',
        /\.header-title\s*\{[^}]*text-overflow:\s*ellipsis/.test(code));
    check('the card can never be wider than what holds it',
        /\.flickemon-card\s*\{[^}]*max-width:\s*100%/.test(code));

    // The complaint that started this: at 0.25rem the controls read as one
    // undifferentiated strip and the eye cannot find the edges.
    const gap = /\.header-actions\s*\{[^}]*gap:\s*([\d.]+)rem/.exec(code);
    check('the buttons have room to breathe at full width',
        gap && Number(gap[1]) >= 0.4, gap ? gap[1] + 'rem' : 'no gap found');

    // Every word in the row has to come off somewhere, or a narrow container
    // still overflows however much the gaps tighten.
    const ladder = code.slice(code.indexOf('@container flickemon'));
    for (const label of ['.trade-header-btn .pvp-header-label',
                         '.friends-header-btn .pvp-header-label',
                         '.pvp-header-label', '.mode-seg-label']) {
        check(`${label} is dropped as space runs out`, ladder.includes(label));
    }
    check('but no control is ever removed, only its word',
        !/\.(pvp|trade|friends|shop)-header-btn\s*\{[^}]*display:\s*none/.test(ladder));

    // Chrome has had @container since 105, but a browser without it must still
    // not overflow — which the unconditional wrap above already guarantees.
    check('there is a fallback for a browser with no container queries',
        code.includes('@supports not (container-type: inline-size)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
