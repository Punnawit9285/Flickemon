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

  console.log('\n=== every worker route has a stand-in ===');
  {
    // The generalisation of the bug that broke trading: the shim had all seven
    // PVP routes and none of the seven trade routes, and an unhandled type
    // returns undefined -- the same thing Chrome returns when nothing is
    // listening. Every trade call came back empty and the feature looked
    // broken. Checking one feature's routes would not have caught the next
    // one, so this checks them ALL, by reading the worker rather than a list
    // somebody has to remember to update.
    const worker = fs.readFileSync(ROOT + 'background/service-worker.js', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const shimSrc = fs.readFileSync(ROOT + 'tests/pvp-sandbox/sandbox.js', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const routes = [...worker.matchAll(/^\s*async ([A-Z][A-Z0-9_]+)\(/gm)].map(m => m[1]);
    check('the worker exposes routes to mirror', routes.length >= 20, String(routes.length));

    // Routes that reach outside the page rather than talking to Firestore --
    // the sandbox is a web page and has no extension tab to open.
    const NOT_APPLICABLE = ['MUSIC_OPEN_TAB', 'MUSIC_LECTURE_STARTED'];

    const missing = routes.filter(r => !NOT_APPLICABLE.includes(r)
        && !shimSrc.includes(`async ${r}(`));
    check('every one of them is answered in the sandbox', missing.length === 0,
        missing.join(', ') + ' -- an unhandled type returns undefined, which reads as a broken feature');

    // And prove it at runtime, not just in the source: a handler that exists
    // but throws on an empty message is no better than a missing one.
    for (const r of routes) {
      if (NOT_APPLICABLE.includes(r)) continue;
      const answered = await send(A, { type: r, code: '000000', uid: 'nobody',
                                       payload: {}, query: {}, uids: [] });
      check(`${r} answers something`, answered !== undefined);
    }
  }

  console.log('\n=== trading, held to background/trade.js ===');
  {
    // The whole reason this section exists: the shim had every PVP route and
    // not one trade route, and an unhandled type returns undefined -- exactly
    // what Chrome returns when no listener exists. So every trade call came
    // back empty and the UI said "Could not open a trade", which reads as a
    // broken feature rather than a missing test double.
    const worker = fs.readFileSync(ROOT + 'background/service-worker.js', 'utf8');
    const routes = [...worker.matchAll(/async (TRADE_[A-Z_]+)\(/g)].map(m => m[1]);
    check('the worker has trade routes to mirror', routes.length === 7, routes.join(','));
    for (const r of routes) {
      const answered = await send(A, { type: r, code: '000000', payload: {} });
      check(`the shim answers ${r}`, answered !== undefined,
          'undefined is what Chrome returns for an unhandled type');
    }

    const t = await send(A, { type: 'TRADE_OPEN', payload: { displayName: 'A' } });
    check('a table opens at the host code', t.code === codeA, JSON.stringify(t));

    // Same code for both features, so they must not evict each other.
    await send(A, { type: 'PVP_OPEN', payload: { displayName: 'A', team: [{ instanceId: 'x' }], mode: '1v1', rulesVersion: 3 } });
    check('a battle and a trade coexist on one code',
        Boolean((await send(B, { type: 'TRADE_READ', code: codeA })).trade)
        && Boolean((await send(B, { type: 'PVP_READ', code: codeA })).battle));

    const read = await send(B, { type: 'TRADE_READ', code: codeA });
    check('the other tab sees it waiting', read.trade.state.phase === 'waiting');
    check('with nothing on the table',
        read.trade.state.hostOffer === null && read.trade.state.guestOffer === null);

    check('you cannot sit at your own table',
        (await send(A, { type: 'TRADE_JOIN', code: codeA, payload: {} })).ok === false);
    const joined = await send(B, { type: 'TRADE_JOIN', code: codeA, payload: { displayName: 'B' } });
    check('the guest sits down', joined.role === 'guest', JSON.stringify(joined));
    check('and it moves to offering',
        (await send(A, { type: 'TRADE_READ', code: codeA })).trade.state.phase === 'offering');

    const mine = { instanceId: 'a1', speciesId: 1, level: 30, shiny: false };
    const theirs = { instanceId: 'b1', speciesId: 4, level: 31, shiny: true };
    await send(A, { type: 'TRADE_OFFER', code: codeA, offer: mine });
    await send(B, { type: 'TRADE_OFFER', code: codeA, offer: theirs });
    const table = (await send(A, { type: 'TRADE_READ', code: codeA })).trade.state;
    check('both offers land on the right sides',
        table.hostOffer.instanceId === 'a1' && table.guestOffer.instanceId === 'b1');
    check('a shiny survives the table', table.guestOffer.shiny === true);

    // One confirmation is not a trade.
    const half = await send(A, { type: 'TRADE_CONFIRM', code: codeA, confirmed: true });
    check('one side confirming does not seal it', half.sealed === false);

    // Changing an offer clears BOTH confirmations, or someone could confirm,
    // wait for the other, then swap in something worthless.
    await send(B, { type: 'TRADE_OFFER', code: codeA, offer: { ...theirs, level: 5 } });
    const cleared = (await send(A, { type: 'TRADE_READ', code: codeA })).trade.state;
    check('changing an offer clears both confirmations',
        cleared.hostConfirmed === false && cleared.guestConfirmed === false);

    await send(A, { type: 'TRADE_CONFIRM', code: codeA, confirmed: true });
    const sealed = await send(B, { type: 'TRADE_CONFIRM', code: codeA, confirmed: true });
    check('both confirming seals it', sealed.sealed === true, JSON.stringify(sealed));
    const done = (await send(A, { type: 'TRADE_READ', code: codeA })).trade.state;
    check('the phase is done', done.phase === 'done');
    check('and it carries a tradeId, which is what makes applying it idempotent',
        typeof done.tradeId === 'string' && done.tradeId.length > 0, String(done.tradeId));

    // The table outlives the first acknowledgement so a tab that reloaded
    // mid-trade comes back and finishes rather than silently losing it.
    const ack1 = await send(A, { type: 'TRADE_ACK', code: codeA });
    check('one acknowledgement is not both', ack1.bothApplied === false);
    check('the table is still there', Boolean((await send(B, { type: 'TRADE_READ', code: codeA })).trade));
    const ack2 = await send(B, { type: 'TRADE_ACK', code: codeA });
    check('the second finishes it', ack2.bothApplied === true);

    check('an unknown code reads as no trade',
        (await send(B, { type: 'TRADE_READ', code: '000000' })).trade === null);
    const badJoinT = await send(B, { type: 'TRADE_JOIN', code: '000000', payload: {} });
    check('and joining one fails saying trade, not battle',
        badJoinT.ok === false && /No trade/.test(badJoinT.error), JSON.stringify(badJoinT));

    await send(A, { type: 'TRADE_CLOSE', code: codeA });
    check('the host can clear the table',
        (await send(B, { type: 'TRADE_READ', code: codeA })).trade === null);
    check('and the battle on the same code is untouched',
        Boolean((await send(B, { type: 'PVP_READ', code: codeA })).battle));
    await send(A, { type: 'PVP_CLOSE', code: codeA });
  }

  console.log('\n=== friends, end to end across two tabs ===');
  {
    const uidA = 'sandbox-uid-a', uidB = 'sandbox-uid-b';

    // ── names ──
    check('A claims a name', (await send(A, { type: 'FRIEND_CLAIM_NAME', name: 'nan' })).ok);
    const clash = await send(B, { type: 'FRIEND_CLAIM_NAME', name: 'nan' });
    check('B cannot take it', clash.ok === false && clash.reason === 'taken', JSON.stringify(clash));
    check('B claims their own', (await send(B, { type: 'FRIEND_CLAIM_NAME', name: 'beam' })).ok);
    check('re-claiming your own name is fine',
        (await send(A, { type: 'FRIEND_CLAIM_NAME', name: 'nan' })).ok);

    // ── finding each other ──
    const byName = await send(A, { type: 'FRIEND_LOOKUP', query: { username: 'beam' } });
    check('found by username', byName.found && byName.uid === uidB, JSON.stringify(byName));
    const byMail = await send(A, { type: 'FRIEND_LOOKUP',
        query: { email: 'player-b@sandbox.test' } });
    check('found by email too', byMail.found && byMail.uid === uidB);
    check('finding yourself is refused',
        (await send(A, { type: 'FRIEND_LOOKUP', query: { username: 'nan' } })).reason === 'self');
    // A wrong name and an address nobody has used must not be distinguishable.
    const ghost = await send(A, { type: 'FRIEND_LOOKUP', query: { email: 'nobody@sandbox.test' } });
    const wrong = await send(A, { type: 'FRIEND_LOOKUP', query: { username: 'nosuch' } });
    check('a missing person gives one answer, whichever way you looked',
        ghost.reason === wrong.reason, `${ghost.reason} vs ${wrong.reason}`);

    // ── requesting ──
    check('A asks B', (await send(A, { type: 'FRIEND_REQUEST', uid: uidB })).outcome === 'requested');
    check('asking twice does not resend',
        (await send(A, { type: 'FRIEND_REQUEST', uid: uidB })).outcome === 'pending');

    const bList = await send(B, { type: 'FRIEND_LIST' });
    const fromA = bList.friendships.find(f => f.uid === uidA);
    check('B sees it as incoming', fromA && fromA.incoming === true && fromA.outgoing === false);
    const aList = await send(A, { type: 'FRIEND_LIST' });
    check('A sees the same one as outgoing',
        aList.friendships.find(f => f.uid === uidB).outgoing === true);
    check('and it is ONE document, not two',
        aList.friendships.length === 1 && bList.friendships.length === 1);

    // You cannot accept your own request, or anyone could befriend anyone.
    check('A cannot accept their own request',
        (await send(A, { type: 'FRIEND_ACCEPT', uid: uidB })).ok === false);
    check('B accepts', (await send(B, { type: 'FRIEND_ACCEPT', uid: uidA })).ok);
    check('now both sides say accepted',
        (await send(A, { type: 'FRIEND_LIST' })).friendships[0].accepted === true
        && (await send(B, { type: 'FRIEND_LIST' })).friendships[0].accepted === true);

    // ── the audience gate, which in production is a security rule ──
    await send(A, { type: 'FRIEND_PUBLISH', payload: {
        audience: [uidB], payload: { username: 'nan', today: { exp: 1200 } } } });
    const seen = await send(B, { type: 'FRIEND_FEEDS', uids: [uidA] });
    check('B can read a feed that names them', seen.feeds[uidA]
        && seen.feeds[uidA].payload.today.exp === 1200, JSON.stringify(seen.feeds[uidA]));

    // The block. Not "we stop drawing it" -- the audience no longer names them.
    await send(A, { type: 'FRIEND_PUBLISH', payload: {
        audience: [], payload: { username: 'nan', today: { exp: 1200 } } } });
    const blocked = await send(B, { type: 'FRIEND_FEEDS', uids: [uidA] });
    check('dropping them from the audience makes the feed unreadable',
        blocked.feeds[uidA] === null,
        'this is a security rule in production, not a rendering decision');

    // ── the board ──
    const day = '2026-09-03';
    check('nothing is on the board to begin with',
        (await send(A, { type: 'FRIEND_BOARD_READ', dayKey: day })).board.length === 0);

    await send(A, { type: 'FRIEND_BOARD_PUBLISH', payload: {
        joined: true, label: 'nan', dayKey: day, todayExp: 8100, levels: 2, streak: 6 } });
    await send(B, { type: 'FRIEND_BOARD_PUBLISH', payload: {
        joined: true, label: 'pla@docchula.com', dayKey: day, todayExp: 12400, levels: 3, streak: 12 } });

    const board = (await send(A, { type: 'FRIEND_BOARD_READ', dayKey: day })).board;
    check('both rows appear', board.length === 2, JSON.stringify(board));
    check('ranked by EXP', board[0].todayExp === 12400 && board[1].todayExp === 8100);
    check('an address passed by mistake is still cut down',
        !board.some(r => r.label.includes('@')), JSON.stringify(board.map(r => r.label)));

    check("yesterday's rows are not today's board",
        (await send(A, { type: 'FRIEND_BOARD_READ', dayKey: '2026-09-02' })).board.length === 0,
        'the day is part of the query, so a stale row cannot hold a place');

    // Leaving removes the row rather than hiding it.
    await send(A, { type: 'FRIEND_BOARD_PUBLISH', payload: { joined: false } });
    const after = (await send(B, { type: 'FRIEND_BOARD_READ', dayKey: day })).board;
    check('leaving takes the row away', after.length === 1 && after[0].uid === uidB,
        JSON.stringify(after));

    // ── unfriending ──
    await send(B, { type: 'FRIEND_REMOVE', uid: uidA });
    check('removal is symmetric — one document, one delete',
        (await send(A, { type: 'FRIEND_LIST' })).friendships.length === 0
        && (await send(B, { type: 'FRIEND_LIST' })).friendships.length === 0);

    // ── the simultaneous-add race ──
    // Both ask at the same moment. One document, so the second ask is an accept
    // rather than a second pending request neither side can resolve.
    await send(A, { type: 'FRIEND_REQUEST', uid: uidB });
    const race = await send(B, { type: 'FRIEND_REQUEST', uid: uidA });
    check('adding each other at once becomes a friendship', race.outcome === 'accepted',
        JSON.stringify(race));
    check('and not two half-requests',
        (await send(A, { type: 'FRIEND_LIST' })).friendships.length === 1);
    await send(A, { type: 'FRIEND_REMOVE', uid: uidB });
  }

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
