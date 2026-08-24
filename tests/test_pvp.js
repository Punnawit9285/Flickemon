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

  console.log('\n=== security rules cover battles ===');
  const rules=R('firestore.rules');
  check('battles matched', rules.includes('match /battles/{code}'));
  check('writes limited to participants', rules.includes("resource.data.guest == request.auth.uid"));
  check('only the host may delete', /allow delete: if signedInStudent\(\)\s*&& resource\.data\.host == request\.auth\.uid/.test(rules));
  check('still default-deny at the end', rules.includes('match /{document=**}'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
