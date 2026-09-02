const ROOT = require('path').join(__dirname, '..') + '/';
// The local PVP sandbox (tests/pvp-sandbox/) fakes the service worker so the
// real PVP client can be clicked through in a browser without accounts or
// Firestore. A dev tool that has quietly stopped matching the transport it
// stands in for is worse than no dev tool, so its shim is held to the same
// contract as background/pvp.js.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(ROOT + 'tests/pvp-sandbox/sandbox.js', 'utf8');

// One shared localStorage: the two tabs are two contexts over one browser store.
const backing=new Map();
const localStorage={ getItem:k=>backing.has(k)?backing.get(k):null,
                     setItem:(k,v)=>backing.set(k,String(v)),
                     removeItem:k=>backing.delete(k) };

function tab(p){
  const win={};
  const ctx={ window:win, localStorage,
              location:{ search:`?p=${p}` },
              URLSearchParams };
  ctx.globalThis=ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return win;
}
const A=tab('a'), B=tab('b');
let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);

(async()=>{
  const send=(w,m)=>w.chrome.runtime.sendMessage(m);

  const codeA=(await send(A,{type:'PVP_MY_CODE'})).code;
  const codeB=(await send(B,{type:'PVP_MY_CODE'})).code;
  check('each player gets a 6-digit code', /^\d{6}$/.test(codeA)&&/^\d{6}$/.test(codeB), `${codeA} ${codeB}`);
  check('and they differ', codeA!==codeB);
  check('codes are stable across calls', (await send(A,{type:'PVP_MY_CODE'})).code===codeA);

  const open=await send(A,{type:'PVP_OPEN',payload:{displayName:'A',team:[{instanceId:'x'}],mode:'3v3',rulesVersion:3}});
  check('host opens a lobby at its own code', open.code===codeA, JSON.stringify(open));

  const seen=await send(B,{type:'PVP_READ',code:codeA});
  check('the other tab can read it', !!seen.battle, JSON.stringify(seen));
  check('it is waiting', seen.battle.state.phase==='waiting');
  check('and carries the host mode + rules version',
        seen.battle.state.mode==='3v3'&&seen.battle.state.rulesVersion===3);
  check('the reader is told who they are', seen.battle.me==='sandbox-uid-b');

  const own=await send(A,{type:'PVP_JOIN',code:codeA,payload:{displayName:'A',team:[],rulesVersion:3}});
  check('you cannot join your own code', own.ok===false && /your own code/.test(own.error), JSON.stringify(own));

  const stale=await send(B,{type:'PVP_JOIN',code:codeA,payload:{displayName:'B',team:[],rulesVersion:2}});
  check('a version mismatch is refused', stale.ok===false && /older|newer/.test(stale.error), JSON.stringify(stale));

  const join=await send(B,{type:'PVP_JOIN',code:codeA,payload:{displayName:'B',team:[{instanceId:'y'}],rulesVersion:3}});
  check('a matching guest joins', join.role==='guest', JSON.stringify(join));

  const now=(await send(A,{type:'PVP_READ',code:codeA})).battle;
  check('the host sees the battle start', now.state.phase==='battling' && now.state.turn===1);
  check('both teams are on the document', !!now.state.hostTeam && !!now.state.guestTeam);
  check('and the log opened', now.state.log.length===1, JSON.stringify(now.state.log));

  await send(A,{type:'PVP_ACTION',code:codeA,action:{kind:'move',index:0}});
  await send(B,{type:'PVP_ACTION',code:codeA,action:{kind:'move',index:1}});
  const acted=(await send(A,{type:'PVP_READ',code:codeA})).battle;
  check('each side writes its own action slot',
        acted.state.hostAction.index===0 && acted.state.guestAction.index===1,
        JSON.stringify([acted.state.hostAction,acted.state.guestAction]));
  check('actions are stamped with the turn', acted.state.hostAction.turn===1);

  await send(A,{type:'PVP_COMMIT',code:codeA,state:{...acted.state,turn:2,hostAction:null,guestAction:null}});
  const after=(await send(B,{type:'PVP_READ',code:codeA})).battle;
  check('a commit is visible to the other tab', after.state.turn===2);
  check('and clears the actions', after.state.hostAction===null);

  const third=await send(B,{type:'PVP_READ',code:'000000'});
  check('an unknown code reads as no battle', third.battle===null);
  const badJoin=await send(B,{type:'PVP_JOIN',code:'000000',payload:{displayName:'B',team:[],rulesVersion:3}});
  check('and joining one fails cleanly', badJoin.ok===false && /No battle/.test(badJoin.error), JSON.stringify(badJoin));

  await send(A,{type:'PVP_CLOSE',code:codeA});
  check('the host can tear it down', (await send(B,{type:'PVP_READ',code:codeA})).battle===null);

  const st=await send(A,{type:'AUTH_STATUS'});
  check('auth reports signed in and configured', st.signedIn===true&&st.configured===true);
  check('admin tools are on', (await send(A,{type:'AUTH_IS_ADMIN'})).isAdmin===true);

  await A.chrome.storage.local.set({k:1});
  check('saves are per player',
        (await A.chrome.storage.local.get('k')).k===1
        && (await B.chrome.storage.local.get('k')).k===undefined);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
