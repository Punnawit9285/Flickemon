const ROOT = require('path').join(__dirname, '..') + '/';
// Duplicates, shinies, trading, PVP rewards, and wall-clock study time.
global.window={addEventListener(){}};
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
global.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},onChanged:{addListener:()=>{}}},runtime:{sendMessage:async()=>null}};
global.document={visibilityState:'visible',addEventListener:()=>{}};
global.setTimeout=f=>{f();return 0;};global.clearTimeout=()=>{};global.setInterval=()=>0;
require(ROOT + 'content/flickemon-engine.js');
const e=global.window.flickemonEngine, cfg=global.window.FlickemonConfig;

let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);
let seq=0;
const add=(sid,lvl,shiny=false)=>{const i='t'+(++seq);
  e.gameState.party.push({instanceId:i,speciesId:sid,level:lvl,totalExp:cfg.expForLevel(lvl),shiny});return i;};
const win=async(sid,lvl,shiny=false)=>{
  e.wildOpponent={wildSpecies:cfg.getSpeciesById(sid),wildLevel:lvl,maxHp:100,currentHp:1,status:'fighting',shiny};
  e.wildHpAcc=1; await e.onVideoProgress(60);
};

(async()=>{
  e.isLoaded=true;
  await e.chooseStarter(1);
  e.gameState.battleMode='capture';

  console.log('\n=== catching a duplicate gives you a second Pokémon ===');
  {
    await win(25,5);
    await win(25,40);
    const pikas=e.gameState.party.filter(p=>p.speciesId===25);
    check('two Pikachu in the party', pikas.length===2, String(pikas.length));
    check('each kept its own level',
          pikas.map(p=>p.level).sort((a,b)=>a-b).join()==='5,40',
          JSON.stringify(pikas.map(p=>p.level)));
    check('they have distinct ids', pikas[0].instanceId!==pikas[1].instanceId);
    check('the dex still counts the species once',
          e.gameState.pokedex.filter(x=>x.speciesId===25).length===1);
  }

  console.log('\n=== shinies ===');
  {
    const before=e.gameState.party.length;
    await win(133,20,true);
    const eevee=e.gameState.party.find(p=>p.speciesId===133);
    check('a shiny catch is flagged', eevee.shiny===true);
    check('and it joined the party', e.gameState.party.length===before+1);
    check('the dex records the shiny',
          e.gameState.pokedex.find(x=>x.speciesId===133).shiny===true);

    await win(129,20,false);   // ordinary Magikarp
    check('an ordinary catch is not flagged',
          e.gameState.party.find(p=>p.speciesId===129).shiny===false);

    check('shiny sprites differ from ordinary',
          cfg.getSpriteUrl(133,true)!==cfg.getSpriteUrl(133,false));
    check('back shiny sprites differ too',
          cfg.getBackSpriteUrl(133,true)!==cfg.getBackSpriteUrl(133,false));

    // Cosmetic only, as in the games.
    const B=global.window.FlickemonBattle;
    const sp=cfg.getSpeciesById(133);
    const a=B.toCombatant({level:20,shiny:true},sp,cfg), b=B.toCombatant({level:20,shiny:false},sp,cfg);
    check('a shiny carries into battle', a.shiny===true && b.shiny===false);
    check('but fights identically',
          a.maxHp===b.maxHp && a.attack===b.attack && a.speed===b.speed);

    // Shininess survives evolution — you caught it for the colour.
    e.gameState.party=[]; seq=0;
    const id=add(1,15,true); e.gameState.activeInstanceId=id;
    for(let i=0;i<40;i++) e.addExpToActive(2000);
    const grown=e.gameState.party.find(p=>p.instanceId===id);
    check('an evolved shiny is still shiny', grown.shiny===true && grown.speciesId!==1,
          `species=${grown.speciesId} shiny=${grown.shiny}`);
  }

  console.log('\n=== trading ===');
  {
    e.gameState.party=[]; e.gameState.teamIds=[]; e.gameState.favouriteIds=[];
    e.gameState.releasedIds=[]; e.gameState.appliedTrades=[]; seq=0;
    const mine=add(25,30), keep=add(1,20);
    e.gameState.activeInstanceId=keep;
    await e.toggleTeamMember(mine); await e.toggleFavourite(mine);

    const incoming={instanceId:'their_id',speciesId:6,level:44,totalExp:cfg.expForLevel(44),shiny:true};
    const r=await e.applyTrade('trade-1',mine,incoming);
    check('the trade applied', r.ok===true, JSON.stringify(r));
    check('what you gave is gone', !e.gameState.party.some(p=>p.instanceId===mine));
    check('what you got arrived', e.gameState.party.some(p=>p.speciesId===6));
    check('it kept its level and shininess',
          r.received.level===44 && r.received.shiny===true);
    check('it got a fresh id, not the sender\'s',
          r.received.instanceId!=='their_id', r.received.instanceId);
    check('the departed one is tombstoned', e.gameState.releasedIds.includes(mine));
    check('and left the team', !e.isOnTeam(mine));
    check('and the favourites', !e.isFavourite(mine));
    check('the arrival is in the dex', e.gameState.pokedex.some(x=>x.speciesId===6&&x.caught));

    // The same trade replayed must not charge twice.
    const again=await e.applyTrade('trade-1',mine,incoming);
    check('replaying the same trade is a no-op', again.alreadyApplied===true, JSON.stringify(again));
    check('party size unchanged by the replay',
          e.gameState.party.filter(p=>p.speciesId===6).length===1);

    check('your last Pokémon is never tradable',
          (()=>{ const saved=e.gameState.party; e.gameState.party=[saved[0]];
                 const t=e.tradableParty(); e.gameState.party=saved; return t.length===0; })());

    // A stale device must not hand back what was traded away.
    const revived=e.mergeCloudState({schemaVersion:2,lastSyncedAt:1,
      party:[{instanceId:mine,speciesId:25,level:30,totalExp:cfg.expForLevel(30)}],
      pokedex:[], releasedIds:[]});
    check('a stale sync cannot resurrect it',
          !e.gameState.party.some(p=>p.instanceId===mine),
          JSON.stringify(e.gameState.party.map(p=>p.instanceId)));
    check('tombstones sync outward', e.buildCloudPayload().releasedIds.includes(mine));
  }

  console.log('\n=== PVP rewards ===');
  {
    // The same win draws a Mega Stone 10% of the time, and a stone result
    // carries no `.reward`. Pinning the line-up to a Pokemon with no Mega
    // anywhere in its line makes the stone branch fall through to a boost every
    // time, so this block tests the boost path instead of failing one run in
    // ten. The stone path is covered on its own below.
    const noMega=add(19,10);              // Rattata -> Raticate, no Mega form
    e.gameState.pvpTeamIds=[noMega];

    e.gameState.activeReward=null;
    const first=await e.grantPvpReward();
    check('a mega-less line-up always draws a boost', first.kind!=='stone', first.kind);
    check('a win grants a boost', first.granted===true, JSON.stringify(first));
    check('it is one of the three',
          Object.values(cfg.REWARDS).includes(first.reward.type), first.reward.type);
    check('it lasts an hour',
          Math.abs(first.reward.msLeft-cfg.REWARD_DURATION_MS)<2000,
          String(first.reward.msLeft));

    // The no-stacking rule is the whole design.
    const second=await e.grantPvpReward();
    check('a second win grants nothing', second.granted===false, JSON.stringify(second));
    check('and says why', second.reason==='active');
    check('the running boost is unchanged',
          e.getActiveReward().type===first.reward.type);

    // Each boost affects exactly its own thing.
    e.gameState.activeReward={type:cfg.REWARDS.EXP,expiresAt:Date.now()+60000};
    check('EXP boost doubles EXP', e.rewardExpMultiplier()===cfg.REWARD_EXP_MULTIPLIER);
    check('and nothing else',
          e.rewardShinyMultiplier()===1 && e.rewardLegendaryMultiplier()===1);
    e.gameState.activeReward={type:cfg.REWARDS.SHINY,expiresAt:Date.now()+60000};
    check('shiny boost lifts shiny only',
          e.rewardShinyMultiplier()>1 && e.rewardExpMultiplier()===1);
    e.gameState.activeReward={type:cfg.REWARDS.LEGENDARY,expiresAt:Date.now()+60000};
    check('legendary boost lifts legendary only',
          e.rewardLegendaryMultiplier()>1 && e.rewardExpMultiplier()===1);

    // Expiry frees the next one.
    e.gameState.activeReward={type:cfg.REWARDS.EXP,expiresAt:Date.now()-1};
    check('an expired boost reads as none', e.getActiveReward()===null);
    check('and a win can grant again', (await e.grantPvpReward()).granted===true);

    // The doubling has to reach the actual EXP the player receives.
    e.gameState.party=[]; seq=0;
    const id=add(1,10); e.gameState.activeInstanceId=id;
    e.gameState.activeReward=null;
    const base=e.gameState.party[0].totalExp;
    e.addExpToActive(1000);
    const plain=e.gameState.party[0].totalExp-base;
    e.gameState.party[0].totalExp=base;
    e.gameState.activeReward={type:cfg.REWARDS.EXP,expiresAt:Date.now()+60000};
    e.addExpToActive(1000);
    const boosted=e.gameState.party[0].totalExp-base;
    check('a boosted grant really is doubled', boosted===plain*2, `${plain} -> ${boosted}`);

    const n=e.normalizeState({hasStarted:true,activeInstanceId:'a',
      party:[{instanceId:'a',speciesId:1,level:5,totalExp:125}],
      activeReward:{type:'exp',expiresAt:Date.now()-1}});
    check('a boost that expired while closed is dropped', n.activeReward===null);
    const n2=e.normalizeState({hasStarted:true,activeInstanceId:'a',
      party:[{instanceId:'a',speciesId:1,level:5,totalExp:125}],
      activeReward:{type:'nonsense',expiresAt:Date.now()+60000}});
    check('an unknown boost type is dropped', n2.activeReward===null);
  }

  console.log('\n=== Mega Stones ===');
  {
    // Math.random is pinned to 0 for this block, which makes rollMegaStone()
    // always fire and chooseStoneRecipient() always take the first candidate.
    // The odds themselves are not what is under test here -- the branch the
    // draw leads to is.
    const realRandom=Math.random;
    Math.random=()=>0;

    e.gameState.party=[]; seq=0;
    e.gameState.activeReward=null;
    e.gameState.rewardLockUntil=0;
    const zard=add(6,60);                 // Charizard: fully evolved, two Megas
    e.gameState.activeInstanceId=zard;
    e.gameState.pvpTeamIds=[zard];
    const holder=()=>e.gameState.party.find(p=>p.instanceId===zard);

    const one=await e.grantPvpReward();
    check('a win can grant a stone', one.kind==='stone', JSON.stringify(one));
    check('it is not dormant on a fully evolved holder', one.dormant===false);
    check('the holder now owns it', holder().megaStones.includes(one.stone.key));
    check('and it is switched on', holder().megaActive===one.stone.key);
    check('activeMegaForm resolves it',
          e.activeMegaForm(holder())?.key===one.stone.key);

    // Charizard has X and Y: a repeat win must not re-grant the one held.
    const two=await e.grantPvpReward();
    check('a second stone is the other form',
          two.kind==='stone' && two.stone.key!==one.stone.key, JSON.stringify(two));
    check('both are held now', holder().megaStones.length===2);
    check('the stone list is sorted',
          JSON.stringify(holder().megaStones)===JSON.stringify([...holder().megaStones].sort()));

    // Nothing left to win: the 10% has to pay something rather than nothing.
    e.gameState.activeReward=null;
    const maxed=await e.grantPvpReward();
    check('a maxed-out line-up re-rolls into a boost',
          maxed.granted===true && maxed.kind!=='stone', JSON.stringify(maxed));

    // A stone is an item, not a timer, so the no-stacking rule does not apply.
    e.gameState.party=[]; seq=0;
    const zard2=add(6,60);
    e.gameState.activeInstanceId=zard2; e.gameState.pvpTeamIds=[zard2];
    e.gameState.activeReward={type:cfg.REWARDS.EXP,expiresAt:Date.now()+60000};
    const during=await e.grantPvpReward();
    check('a stone lands even while a boost runs', during.kind==='stone',
          JSON.stringify(during));
    check('and the running boost is untouched',
          e.getActiveReward().type===cfg.REWARDS.EXP);

    // Dormant: owned, but the holder cannot use it yet.
    e.gameState.party=[]; seq=0;
    e.gameState.activeReward=null;
    const mander=add(4,10);               // Charmander -> Charizard has the Mega
    e.gameState.activeInstanceId=mander; e.gameState.pvpTeamIds=[mander];
    const early=await e.grantPvpReward();
    const m=()=>e.gameState.party.find(p=>p.instanceId===mander);
    check('an unevolved holder still wins the stone', early.kind==='stone',
          JSON.stringify(early));
    check('but it is dormant', early.dormant===true);
    check('and is not switched on', !m().megaActive, String(m().megaActive));
    check('activeMegaForm reports nothing', !e.activeMegaForm(m()));
    check('evolving wakes it', (()=>{
        m().speciesId=6;                  // as the evolution path leaves it
        const woke=e.wakeDormantMega(m());
        return woke && m().megaActive===woke.key;
    })());

    // The lockout outranks everything, stones included.
    e.gameState.party=[]; seq=0;
    e.gameState.activeReward=null;
    const zard3=add(6,60);
    e.gameState.activeInstanceId=zard3; e.gameState.pvpTeamIds=[zard3];
    await e.recordPvpLoss();
    const locked=await e.grantPvpReward();
    check('a loss lockout blocks stones too',
          locked.granted===false && locked.reason==='locked', JSON.stringify(locked));
    check('and nothing was handed out',
          (e.gameState.party.find(p=>p.instanceId===zard3).megaStones||[]).length===0);
    e.gameState.rewardLockUntil=0;

    Math.random=realRandom;

    // The admin tool grants through the same applyMegaStone, so it is the
    // cheapest way to reproduce every stone state on a test account.
    e.gameState.party=[]; seq=0;
    const gift=add(6,60);
    e.gameState.activeInstanceId=gift;
    const g1=await e.adminGrantMegaStone();
    check('admin can hand the partner a stone', g1.ok===true, JSON.stringify(g1));
    check('it is live on a fully evolved partner', g1.dormant===false);
    check('and switched on',
          e.gameState.party[0].megaActive===g1.form.key);
    const g2=await e.adminGrantMegaStone();
    check('a second press gives the other form',
          g2.ok===true && g2.form.key!==g1.form.key, JSON.stringify(g2));
    const g3=await e.adminGrantMegaStone();
    check('a third has nothing left to give',
          g3.ok===false && g3.reason==='maxed', JSON.stringify(g3));

    e.gameState.party=[]; seq=0;
    e.gameState.activeInstanceId=add(19,10);          // Rattata: no Mega anywhere
    const none=await e.adminGrantMegaStone();
    check('a mega-less partner is refused',
          none.ok===false && none.reason==='no-mega', JSON.stringify(none));

    e.gameState.party=[]; seq=0;
    e.gameState.activeInstanceId=add(4,10);           // Charmander
    const soon=await e.adminGrantMegaStone();
    check('an unevolved partner gets a dormant stone',
          soon.ok===true && soon.dormant===true, JSON.stringify(soon));
    check('which is not switched on', !e.gameState.party[0].megaActive);
  }

  console.log('\n=== Mega: dormant until the final form ===');
  {
    e.gameState.party=[]; seq=0;
    const id=add(4,10);                                  // Charmander
    e.gameState.activeInstanceId=id;
    const m=()=>e.gameState.party.find(p=>p.instanceId===id);

    const g=await e.adminGrantMegaStone();
    check('it holds a Charizardite', m().megaStones.length===1, JSON.stringify(m().megaStones));

    // The whole point: owning the stone changes nothing until it can be used.
    check('it cannot Mega Evolve', e.activeMegaForm(m())===null);
    check('it has no form to switch to', e.availableMegaForms(m()).length===0);
    check('and the stone reads as dormant', e.dormantMegaStones(m()).length===1);
    check('it deals ordinary damage', e.megaMultiplierFor(m())===1);
    check('it wears its ordinary sprite', e.spriteIdFor(m())===4);
    const refused=await e.toggleMega(id);
    check('the toggle refuses it', refused.ok===false && refused.reason==='dormant',
          JSON.stringify(refused));
    // Even a save that somehow carries megaActive for a form this stage cannot
    // use -- a hand-edited file, a sync from a device further along the line --
    // must not buy a damage bonus. toCombatant re-checks the species itself.
    m().megaActive=m().megaStones[0];
    const forced=window.FlickemonBattle.toCombatant(m(), cfg.getSpeciesById(m().speciesId), cfg);
    check('PVP refuses a dormant form too',
          forced.damageMult===1 && forced.megaForm===null, JSON.stringify(forced.megaForm));
    check('and so does the study multiplier', e.megaMultiplierFor(m())===1);
    m().megaActive=null;

    // Evolution is NOT blocked -- only the Mega is.
    const seen=[];
    const off=e.onEvolution(ev=>seen.push(ev.kind==='mega'?'mega:'+ev.form.key:'evo:'+ev.to.id));
    await e.adminSetPokemonLevel(16);
    check('it evolves normally to Charmeleon', m().speciesId===5, String(m().speciesId));
    check('still no Mega at the middle stage', e.activeMegaForm(m())===null);
    check('and no scene was played yet', seen.join()==='evo:5', seen.join());

    await e.adminSetPokemonLevel(36);
    check('it reaches Charizard', m().speciesId===6);
    check('the Mega scene follows the evolution scene',
          seen.join()==='evo:5,evo:6,mega:'+g.form.key, seen.join());
    check('and it is now Mega Evolved', e.activeMegaForm(m())?.key===g.form.key);
    check('dealing 1.3x', e.megaMultiplierFor(m())===cfg.MEGA_DAMAGE_MULTIPLIER);
    off();

    // Toggling is free, and silent, forever after.
    const offRes=await e.toggleMega(id);
    check('it can be switched back off', offRes.ok===true && offRes.form===null);
    check('back to the plain final form', e.spriteIdFor(m())===6);
    check('with no damage bonus', e.megaMultiplierFor(m())===1);
    const onRes=await e.toggleMega(id);
    check('and switched on again', e.activeMegaForm(m())?.key===g.form.key);
    check('but the scene does not replay', onRes.scene===null, JSON.stringify(onRes.scene));
    check('the seen list remembers it', m().megaSeen.includes(g.form.key));
  }

  console.log('\n=== Mega: the scene plays exactly once ===');
  {
    // A stone won while the holder is already wearing its other form is not a
    // transformation, and must not take the screen for 8.5 seconds.
    e.gameState.party=[]; seq=0;
    e.gameState.activeReward=null; e.gameState.rewardLockUntil=0;
    const id=add(6,60);
    e.gameState.activeInstanceId=id; e.gameState.pvpTeamIds=[id];
    const m=()=>e.gameState.party.find(p=>p.instanceId===id);

    const realRandom=Math.random; Math.random=()=>0;
    const first=await e.grantPvpReward();
    check('the first stone earns a scene', first.scene===true, JSON.stringify(first));
    e.gameState.activeReward=null;
    const second=await e.grantPvpReward();
    check('the second is a different form', second.stone.key!==first.stone.key);
    check('but earns no scene', second.scene===false, JSON.stringify(second));
    Math.random=realRandom;

    // The second form has still never been seen, so switching to it does play.
    const toY=await e.toggleMega(id, second.stone.key);
    check('switching to the unseen form plays it',
          toY.scene && toY.scene.key===second.stone.key, JSON.stringify(toY.scene));
    const again=await e.toggleMega(id, second.stone.key);   // off
    const back=await e.toggleMega(id, second.stone.key);    // on
    check('and never again', back.scene===null, JSON.stringify(back.scene));
    check('both forms are recorded as seen', m().megaSeen.length===2,
          JSON.stringify(m().megaSeen));
  }

  console.log('\n=== Mega: a bench member evolving ===');
  {
    e.gameState.party=[]; seq=0;
    const partner=add(25,50);
    const bench=add(4,15);                               // Charmander on the team
    e.gameState.activeInstanceId=partner;
    e.gameState.teamIds=[partner,bench];
    const m=()=>e.gameState.party.find(p=>p.instanceId===bench);
    m().megaStones=['charizard-mega-x']; m().megaSeen=[];

    const seen=[];
    const off=e.onEvolution(ev=>seen.push(
        (ev.kind==='mega'?'mega:'+ev.form.key:'evo:'+ev.to.id)+(ev.benched?'/bench':'')));

    // shareExpWithTeam applies at most one evolution per call, so a single
    // enormous grant would stop at Charmeleon. Nudge it over each threshold.
    const nudge=(toLevel)=>{
      m().totalExp=cfg.expForLevel(toLevel)-1;
      m().level=cfg.levelFromExp(m().totalExp);
      e.shareExpWithTeam(Math.ceil(1/cfg.TEAM_EXP_SHARE)+1, partner);
    };
    nudge(16);
    check('the bench member evolves to Charmeleon', m().speciesId===5, String(m().speciesId));
    check('its stone is still dormant there', e.activeMegaForm(m())===null);
    nudge(36);
    off();

    check('and on to Charizard', m().speciesId===6, String(m().speciesId));
    check('its dormant stone woke on the bench',
          e.activeMegaForm(m())?.key==='charizard-mega-x', JSON.stringify(seen));
    check('with a scene of its own, marked as benched',
          seen.includes('mega:charizard-mega-x/bench'), seen.join());
    check('after the evolution scene, not before',
          seen.indexOf('mega:charizard-mega-x/bench')===seen.indexOf('evo:6/bench')+1,
          seen.join());
  }

  console.log('\n=== Mega: megaSeen persistence ===');
  {
    const n=e.normalizeState({hasStarted:true,activeInstanceId:'a',party:[
      {instanceId:'a',speciesId:6,level:60,totalExp:cfg.expForLevel(60),
       megaStones:['charizard-mega-y','charizard-mega-x'],
       megaSeen:['charizard-mega-y','charizard-mega-x','charizard-mega-y'],
       megaActive:'charizard-mega-x',megaActiveAt:5}]});
    check('megaSeen survives a reload',
          JSON.stringify(n.party[0].megaSeen)==='["charizard-mega-x","charizard-mega-y"]',
          JSON.stringify(n.party[0].megaSeen));
    const n2=e.normalizeState({hasStarted:true,activeInstanceId:'a',party:[
      {instanceId:'a',speciesId:6,level:60,totalExp:cfg.expForLevel(60)}]});
    check('and defaults to empty', JSON.stringify(n2.party[0].megaSeen)==='[]');

    // A scene watched on one device must not replay on another.
    e.gameState=e.normalizeState({hasStarted:true,activeInstanceId:'a',party:[
      {instanceId:'a',speciesId:6,level:60,totalExp:cfg.expForLevel(60),
       megaStones:['charizard-mega-x'],megaSeen:[],megaActive:null,megaActiveAt:0}],
      pokedex:[],releasedIds:[],schemaVersion:2,lastSyncedAt:1});
    e.mergeCloudState({schemaVersion:2,lastSyncedAt:2,pokedex:[],releasedIds:[],party:[
      {instanceId:'a',speciesId:6,level:60,totalExp:cfg.expForLevel(60),
       megaStones:['charizard-mega-x'],megaSeen:['charizard-mega-x']}]});
    check('a seen scene unions in from the cloud',
          e.gameState.party[0].megaSeen.includes('charizard-mega-x'),
          JSON.stringify(e.gameState.party[0].megaSeen));
    const t=await e.toggleMega('a');
    check('so the other device does not replay it', t.ok===true && t.scene===null,
          JSON.stringify(t));
  }

  console.log('\n=== admin summon ===');
  {
    e.gameState.party=[]; seq=0;
    const me=add(1,30); e.gameState.activeInstanceId=me;

    const r=await e.adminSummonOpponent(150,{shiny:true,level:70});
    check('summons the named species', r.ok===true && e.wildOpponent.wildSpecies.id===150);
    check('at the level asked for', e.wildOpponent.wildLevel===70, String(e.wildOpponent.wildLevel));
    check('shiny when asked', e.wildOpponent.shiny===true);
    check('HP matches the level', e.wildOpponent.maxHp===cfg.calculateRealMaxHp(
          cfg.getSpeciesById(150).baseStats.hp,70));

    await e.adminSummonOpponent(25,{});
    check('an ordinary summon is not shiny', e.wildOpponent.shiny===false);
    check('level defaults to your partner\'s', e.wildOpponent.wildLevel===30,
          String(e.wildOpponent.wildLevel));

    check('an unknown species is refused',
          (await e.adminSummonOpponent(99999,{})).reason==='unknown-species');
    check('a refusal leaves the encounter alone', e.wildOpponent.wildSpecies.id===25);

    // Summoning must not hand out a free Pokémon — it still has to be beaten.
    check('nothing was added to the party', e.gameState.party.length===1,
          String(e.gameState.party.length));
    check('but it is marked seen in the dex',
          e.gameState.pokedex.some(x=>x.speciesId===150&&x.seen&&!x.caught));

    // Level is clamped rather than trusted.
    await e.adminSummonOpponent(25,{level:99999});
    check('an absurd level is clamped', e.wildOpponent.wildLevel===cfg.MAX_LEVEL,
          String(e.wildOpponent.wildLevel));
  }

  console.log('\n=== study time adds across devices instead of competing ===');
  {
    e.deviceId='dev_laptop';
    e.gameState.studyMinutes={legacy:100}; e.gameState.totalMinutesWatched=100;
    e.creditStudyMinutes('dev_laptop',30);
    check('this device is credited', e.gameState.studyMinutes.dev_laptop===30);
    check('the total follows', e.gameState.totalMinutesWatched===130);

    // The other device watched 40 from the same 100-minute baseline. Under the
    // old max() rule this merge credited 140 and lost 30 minutes outright.
    e.mergeCloudState({schemaVersion:2,lastSyncedAt:Date.now(),party:[],pokedex:[],
      studyMinutes:{legacy:100,dev_desktop:40}, totalMinutesWatched:140});
    check('both devices are counted', e.gameState.totalMinutesWatched===170,
          `${e.gameState.totalMinutesWatched} (want 170)`);
    check('each device kept its own bucket',
          e.gameState.studyMinutes.dev_laptop===30 && e.gameState.studyMinutes.dev_desktop===40,
          JSON.stringify(e.gameState.studyMinutes));
    check('shared history is not double counted', e.gameState.studyMinutes.legacy===100);

    // A bucket is monotonic, so a stale device cannot roll one back.
    e.mergeCloudState({schemaVersion:2,lastSyncedAt:Date.now()+1,party:[],pokedex:[],
      studyMinutes:{legacy:100,dev_laptop:5,dev_desktop:40}});
    check('a stale bucket cannot reduce the total', e.gameState.totalMinutesWatched===170,
          String(e.gameState.totalMinutesWatched));

    // Any future source writes into its own bucket and simply adds.
    e.creditStudyMinutes('ipad',25);
    check('a non-extension source adds', e.gameState.totalMinutesWatched===195,
          String(e.gameState.totalMinutesWatched));
    check('and survives a round trip through the payload',
          e.buildCloudPayload().studyMinutes.ipad===25);

    check('nonsense credits are ignored',
          (()=>{ const b=e.gameState.totalMinutesWatched;
                 e.creditStudyMinutes('x',-5); e.creditStudyMinutes('x',NaN);
                 e.creditStudyMinutes('',10); e.creditStudyMinutes(null,10);
                 return e.gameState.totalMinutesWatched===b; })());

    // A save written before the split must not lose its history.
    const n=e.normalizeState({hasStarted:true,activeInstanceId:'a',
      party:[{instanceId:'a',speciesId:1,level:5,totalExp:125}],
      totalMinutesWatched:640});
    check('an old save migrates its total into legacy',
          n.studyMinutes.legacy===640, JSON.stringify(n.studyMinutes));
    check('and reports the same total', n.totalMinutesWatched===640);

    const c=e.normalizeState({hasStarted:true,activeInstanceId:'a',
      party:[{instanceId:'a',speciesId:1,level:5,totalExp:125}],
      studyMinutes:{legacy:10,bad:-4,worse:'x'}, totalMinutesWatched:10});
    check('corrupt buckets are dropped', c.totalMinutesWatched===10,
          JSON.stringify(c.studyMinutes));
  }

  console.log('\n=== legendary labelling ===');
  {
    const B=global.window.FlickemonBattle;
    const fs=require('fs');
    const ui=fs.readFileSync(ROOT + 'content/flickemon-ui.js','utf8');
    const pvp=fs.readFileSync(ROOT + 'content/flickemon-pvp.js','utf8');
    const trade=fs.readFileSync(ROOT + 'content/flickemon-trade.js','utf8');
    const css=fs.readFileSync(ROOT + 'content/styles.css','utf8');

    check('the registry marks legendaries',
          cfg.POKEMON_REGISTRY.filter(s=>s.isLegendary).length>0);
    check('Mewtwo is one', cfg.getSpeciesById(150).isLegendary===true);
    check('Rattata is not', !cfg.getSpeciesById(19).isLegendary);

    // The flag has to travel, or PVP and trading show nothing.
    const legend=B.toCombatant({level:70,shiny:true},cfg.getSpeciesById(150),cfg);
    const plain=B.toCombatant({level:10},cfg.getSpeciesById(19),cfg);
    check('a combatant carries the flag', legend.legendary===true && plain.legendary===false);
    check('and is independent of shininess',
          legend.legendary===true && legend.shiny===true);
    check('legendary does not change the stats',
          B.toCombatant({level:70},cfg.getSpeciesById(150),cfg).maxHp===legend.maxHp);

    check('the widget flags a legendary encounter', ui.includes('legendary-flag'));
    check('party rows carry a badge', ui.includes('badge-legendary'));
    check('the Game Hub partner shows it',
          /partner-big-name[\s\S]{0,220}badge-legendary/.test(ui));
    check('the dex marks caught legendaries', /pokedex-num[^`]*isLegendary/.test(ui));
    check('PVP nameplates show it', pvp.includes('pvp-rarity') && pvp.includes('rarity(foe)'));
    check('a trade offer shows it', /trade-slot-name[^`]*isLegendary/.test(trade));

    // Two independent conditionals in the party row, not one ternary choosing
    // between them: a shiny legendary must show both.
    const rowStart = ui.indexOf('class="party-row-name"');
    const row = ui.slice(rowStart, rowStart + 600);
    check('the party row emits both labels independently',
          row.includes("sp.isLegendary ? '<span class=\"badge badge-legendary\"")
          && row.includes("pk.shiny ? '<span class=\"badge badge-shiny\""),
          row.slice(0, 200).replace(/\s+/g, ' '));

    check('the colour is a theme token, not a literal',
          /--flick-legendary:\s*var\(--ion-/.test(css));
    check('the badge is styled', css.includes('.badge-legendary'));
  }

  console.log('\n=== a team member evolving announces itself ===');
  {
    e.gameState.party=[]; e.gameState.teamIds=[]; e.gameState.favouriteIds=[]; seq=0;
    const act=add(4,20), mate=add(1,15), other=add(7,15);
    e.gameState.activeInstanceId=act;
    await e.toggleTeamMember(mate);
    await e.toggleTeamMember(other);

    const seen=[];
    const off=e.onEvolution(ev=>seen.push(ev));
    for(let i=0;i<40;i++) e.addExpToActive(2000);
    off();

    const benched=seen.filter(x=>x.benched);
    const own=seen.filter(x=>!x.benched);
    check('the bench evolution fired', benched.length>0, JSON.stringify(seen.map(x=>x.to&&x.to.name)));
    check('it is flagged as a team member, not the partner', benched[0].benched===true);
    check('the active partner still announces its own', own.length>0);
    check('the payload names both forms',
          benched[0].from && benched[0].to && benched[0].from.id!==benched[0].to.id,
          JSON.stringify([benched[0].from&&benched[0].from.name, benched[0].to&&benched[0].to.name]));

    // Both benched members crossed a threshold, so both must be announced —
    // the queue is what makes that safe now.
    check('every team member that evolved was announced',
          new Set(benched.map(x=>x.from.id)).size>=2,
          JSON.stringify(benched.map(x=>x.from.name)));

    // Shininess has to survive into the overlay or the reveal shows the wrong
    // colouring for a Pokémon caught for exactly that.
    e.gameState.party=[]; e.gameState.teamIds=[]; seq=0;
    const a2=add(4,20), shinyMate=add(1,15,true);
    e.gameState.activeInstanceId=a2;
    await e.toggleTeamMember(shinyMate);
    const seen2=[];
    const off2=e.onEvolution(ev=>seen2.push(ev));
    for(let i=0;i<40;i++) e.addExpToActive(2000);
    off2();
    const sb=seen2.find(x=>x.benched);
    check('a shiny bench evolution stays shiny', sb && sb.shiny===true, JSON.stringify(sb&&sb.shiny));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
