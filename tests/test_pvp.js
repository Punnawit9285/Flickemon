const ROOT = require('path').join(__dirname, '..') + '/';
// Code derivation + the wiring between UI, engine, worker and transport.
const fs=require('fs');
let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);
const R=f=>fs.readFileSync(ROOT + ''+f,'utf8');

(async()=>{
  const pvp=await import(ROOT + 'background/pvp.js');

  console.log('\n=== 6-digit code ===');
  const c1=pvp.codeForUid('abc123'), c2=pvp.codeForUid('abc123');
  check('always 6 digits', /^\d{6}$/.test(c1), c1);
  check('stable for the same uid', c1===c2);
  check('differs for another uid', pvp.codeForUid('xyz789')!==c1);
  const codes=new Set();
  for(let i=0;i<5000;i++) codes.add(pvp.codeForUid('uid-firebase-'+i));
  check('well spread (<1% collisions over 5000 uids)', codes.size>4950, `${codes.size}/5000 unique`);
  check('all six digits kept, zero-padded', [...codes].every(c=>c.length===6));

  console.log('\n=== transport surface ===');
  for (const fn of ['openLobby','readBattle','joinBattle','submitAction','commitTurn','closeLobby'])
    check(`exports ${fn}`, typeof pvp[fn]==='function');

  console.log('\n=== wiring ===');
  const sw=R('background/service-worker.js'), eng=R('content/flickemon-engine.js'), ui=R('content/flickemon-ui.js');
  for (const t of ['PVP_MY_CODE','PVP_OPEN','PVP_READ','PVP_JOIN','PVP_ACTION','PVP_COMMIT','PVP_CLOSE'])
    check(`worker routes ${t}`, sw.includes(`async ${t}(`));
  check('engine bridges every route', ['pvpMyCode','pvpOpen','pvpRead','pvpJoin','pvpAction','pvpCommit','pvpClose']
        .every(m=>eng.includes(m+'(')));
  check('engine builds a battle team', /buildPvpTeam\s*\(/.test(eng));
  check('and the roster is sized by the format', /buildPvpTeam\s*\(size/.test(eng));

  console.log('\n=== header button ===');
  const hdr=ui.slice(ui.indexOf('<div class="header-actions">'), ui.indexOf('<!-- Options Popover Menu -->'));
  check('PVP button present', hdr.includes('pvp-header-btn'));
  check('sits beside the mode switch', hdr.indexOf('mode-switch')<hdr.indexOf('pvp-header-btn'));
  check('before the ⋮ menu', hdr.indexOf('pvp-header-btn')<hdr.indexOf('menu-trigger-btn'));
  check('uses an inline SVG, not emoji', hdr.includes('${swordsSvg}'));
  check('opens the PVP modal', ui.includes('this.openPvp()'));

  console.log('\n=== no external pages ===');
  const p=R('content/flickemon-pvp.js');
  check('no window.open', !p.includes('window.open'));
  check('no target=_blank', !p.includes('_blank'));
  check('renders into the extension modal', p.includes('createModalOverlay'));

  console.log('\n=== Mega Evolve, on the battle screen ===');
  {
    // Source assertions, not behaviour: the mechanic itself is proved in
    // test_pvp_match.js. What matters here is that the button exists, is
    // reachable, and cannot be pressed in the states where it must not be.
    // Comments are stripped first -- prose about a rule has satisfied one of
    // these checks before now.
    const p = R('content/flickemon-pvp.js')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    check('the button exists', /pvp-mega-btn/.test(p));
    check('it is drawn only when it can be used', /canMegaNow\(\)\s*\?/.test(p));
    check('arming does not send anything', /this\.megaArmed = !this\.megaArmed/.test(p));
    check('the move carries it', /action\.mega = true/.test(p));

    // Four conditions, and every one of them matters:
    const gate = p.slice(p.indexOf('canMegaNow()'), p.indexOf('canMegaNow()') + 400);
    check('needs a stone', /me\.megaKey/.test(gate));
    check('not already transformed', /megaOn !== true/.test(gate));
    check('not fainted', /me\.hp > 0/.test(gate));
    check('and not already spent this battle', /megaUsedBy/.test(gate));

    // Spent-ness is read off the team rather than stored, so it cannot drift
    // out of step with what is actually on the field.
    check('spent is derived from the team, not a flag',
        /megaUsedBy\(team\)\s*\{[\s\S]{0,200}?megaOn === true/.test(p));
    check('no separate used-flag on the document',
        !/hostMegaUsed|guestMegaUsed/.test(p));

    // A poll between drawing the button and pressing a move can change the
    // answer, so the render is not trusted at send time.
    check('availability is re-checked when the move is sent',
        /this\.megaArmed && this\.canMegaNow\(\)/.test(p));

    // Armed state is per-turn. Left set, it would spend the battle's one Mega
    // Evolution on a turn its owner never armed. Sliced by method rather than
    // matched with a window, which quietly depended on how long the comments
    // in between happened to be.
    const method = (name, end) => {
      const at = p.indexOf(name);
      return at < 0 ? '' : p.slice(at, end ? p.indexOf(end, at) : at + 1200);
    };
    check('a new battle starts unarmed',
        /megaArmed = false/.test(method('async open()', 'renderLobby();')));
    check('and so does every turn after the first',
        /megaArmed = false/.test(method('commitLocal(battle, next)', 'renderBattle();')));
    check('including one resolved by the opponent',
        /megaArmed = false/.test(method('lastTurnRendered = st.turn', 'renderBattle();')));

    check('and the flash plays once per Pokémon, not per render',
        /megaFlashed/.test(p) && /just-megaed/.test(p));

    const css = R('content/styles.css');
    check('the button is styled', /\.pvp-mega-btn\b/.test(css));
    check('the armed state is visible', /\.pvp-mega-btn\.armed/.test(css));
    check('the transformation flashes', /\.pvp-sprite\.just-megaed/.test(css));
    // The block that mentions it, whichever one that is -- not a fixed window
    // whose reach depends on the length of the comments inside it.
    const rm = css.split('@media (prefers-reduced-motion').find(b => /just-megaed/.test(b));
    check('reduced motion turns the flash off', Boolean(rm));
    check('and the armed pulse too', Boolean(rm) && /pvp-mega-btn\.armed/.test(rm));
  }

  console.log('\n=== shinies are marked everywhere a Pokémon is drawn ===');
  {
    const p = R('content/flickemon-pvp.js')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Each of these draws a Pokémon at small size, where the sprite alone does
    // not say "shiny" -- a shiny Gyarados is just a red Gyarados at 48px.
    const drawn = ['pvp-team-chip', 'pvp-bench-mon', 'pvp-roster-sprite'];
    for (const cls of drawn) {
      const at = p.indexOf(cls);
      check(`${cls} marks shiny`, at > 0 && /is-shiny/.test(p.slice(at - 60, at + 260)),
          'the sprite is right but nothing says it is shiny');
    }
    check('the battle sprites do too', /my-sprite\$\{me\.shiny/.test(p.replace(/\s+/g, ''))
        || /me\.shiny \? ' is-shiny'/.test(p));
    check('and the nameplates carry the ✦', /pvp-rarity shiny/.test(p));

    const css = R('content/styles.css');
    check('chips and bench have a shiny treatment',
        /\.pvp-team-chip\.is-shiny/.test(css) && /\.pvp-bench-mon\.is-shiny/.test(css));

    // The rule that was overturned when team sizes were made exact. The copy
    // saying otherwise was unreachable, but a future reader would believe it.
    check('nothing still offers a short team',
        !/you are a Pokémon down/.test(p));
  }

  console.log('\n=== security rules cover battles ===');
  const rules=R('firestore.rules');
  check('battles matched', rules.includes('match /battles/{code}'));
  check('writes limited to participants', rules.includes("resource.data.guest == request.auth.uid"));
  check('only the host may delete', /allow delete: if signedInStudent\(\)\s*&& resource\.data\.host == request\.auth\.uid/.test(rules));
  check('still default-deny at the end', rules.includes('match /{document=**}'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
