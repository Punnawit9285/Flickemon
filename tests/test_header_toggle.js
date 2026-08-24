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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
