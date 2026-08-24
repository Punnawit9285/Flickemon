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
    e.gameState.activeReward=null;
    const first=await e.grantPvpReward();
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
