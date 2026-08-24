const ROOT = require('path').join(__dirname, '..') + '/';
// Team, favourites and EXP share — all keyed by instanceId since duplicates
// became separate Pokémon.
global.window={};
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
global.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},onChanged:{addListener:()=>{}}},runtime:{sendMessage:async()=>null}};
global.document={visibilityState:'visible',addEventListener:()=>{}};
global.window.addEventListener=()=>{};
global.setTimeout=f=>{f();return 0;};global.clearTimeout=()=>{};global.setInterval=()=>0;
require(ROOT + 'content/flickemon-engine.js');
const e=global.window.flickemonEngine, cfg=global.window.FlickemonConfig;

let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);

// Unique per call, so two of one species really are two party members.
let seq=0;
const add=(sid,lvl,shiny=false)=>{
  const inst={instanceId:'i'+(++seq),speciesId:sid,level:lvl,totalExp:cfg.expForLevel(lvl),shiny};
  e.gameState.party.push(inst);
  return inst.instanceId;
};

(async()=>{
  e.isLoaded=true;
  await e.chooseStarter(1);                    // Bulbasaur active
  const ids={};
  [4,7,25,133,52,95,129].forEach(id=>{ ids[id]=add(id,10); });
  const activeId=()=>e.getActivePokemon().instanceId;

  console.log('\n=== active partner is always on the team ===');
  check('team contains active', e.isOnTeam(activeId()));
  check('team starts at 1', e.getTeam().length===1, JSON.stringify(e.getTeam()));
  check('cannot remove the active', (await e.toggleTeamMember(activeId())).reason==='active');
  check('team is instanceIds, not species', e.getTeam().every(id=>typeof id==='string'),
        JSON.stringify(e.getTeam()));

  console.log('\n=== team caps at 6 including the active ===');
  for (const id of [4,7,25,133,52]) check(`added ${id}`, (await e.toggleTeamMember(ids[id])).ok===true);
  check('team is now 6', e.getTeam().length===6, JSON.stringify(e.getTeam()));
  check('team reports full', e.isTeamFull());
  check('7th is rejected as FULL', (await e.toggleTeamMember(ids[95])).reason==='full');
  check('still 6 after rejection', e.getTeam().length===6);
  check('removing frees a slot', (await e.toggleTeamMember(ids[52])).ok===true && e.getTeam().length===5);

  console.log('\n=== favourites ===');
  await e.toggleFavourite(ids[25]);
  check('marked favourite', e.isFavourite(ids[25]));
  await e.toggleFavourite(ids[25]);
  check('unmarked', !e.isFavourite(ids[25]));
  await e.toggleFavourite(ids[133]);
  check('favourite is independent of team', e.isFavourite(ids[133]));

  console.log('\n=== two of one species are two Pokémon ===');
  {
    e.gameState.party=[]; e.gameState.teamIds=[]; e.gameState.favouriteIds=[]; seq=0;
    const a=add(25,5), b=add(25,40);                 // two Pikachu
    add(1,10); e.gameState.activeInstanceId=e.gameState.party[2].instanceId;

    check('both are in the party', e.gameState.party.filter(p=>p.speciesId===25).length===2);
    await e.toggleTeamMember(b);
    check('the Lv.40 one is on the team', e.isOnTeam(b));
    check('the Lv.5 one is not', !e.isOnTeam(a), 'starring one must not star both');
    await e.toggleFavourite(a);
    check('favouriting one does not favourite the other', e.isFavourite(a) && !e.isFavourite(b));

    // Both can fight: a PVP roster of duplicates is the point of the feature.
    await e.toggleTeamMember(a);
    const roster=e.buildPvpTeam();
    check('both Pikachu reach the PVP roster',
          roster.filter(c=>c.speciesId===25).length===2, JSON.stringify(roster.map(c=>c.name+c.level)));
    check('and they are distinct combatants',
          roster.filter(c=>c.speciesId===25).map(c=>c.level).sort((x,y)=>x-y).join()==='5,40',
          JSON.stringify(roster.filter(c=>c.speciesId===25).map(c=>c.level)));
  }

  console.log(`\n=== EXP share at ${Math.round(cfg.TEAM_EXP_SHARE*100)}% ===`);
  {
    e.gameState.party=[]; e.gameState.teamIds=[]; e.gameState.favouriteIds=[]; seq=0;
    const act=add(1,20), mate=add(4,20), off=add(7,20);
    e.gameState.activeInstanceId=act;
    await e.toggleTeamMember(mate);

    const before=new Map(e.gameState.party.map(p=>[p.instanceId,p.totalExp]));
    const GRANT=1000, SHARE=cfg.TEAM_EXP_SHARE;
    e.addExpToActive(GRANT);
    const get=id=>e.gameState.party.find(p=>p.instanceId===id);
    check('active got the full amount', get(act).totalExp-before.get(act)===GRANT,
          `${get(act).totalExp-before.get(act)}`);
    check(`team-mate got ${Math.round(SHARE*100)}%`,
          get(mate).totalExp-before.get(mate)===Math.round(GRANT*SHARE),
          `${get(mate).totalExp-before.get(mate)} vs ${Math.round(GRANT*SHARE)}`);
    check('non-team member got nothing', get(off).totalExp-before.get(off)===0);
  }

  console.log('\n=== an evolution cannot orphan a team slot ===');
  {
    e.gameState.party=[]; e.gameState.teamIds=[]; e.gameState.favouriteIds=[]; seq=0;
    const act=add(1,15), mate=add(4,15);
    e.gameState.activeInstanceId=act;
    await e.toggleTeamMember(mate); await e.toggleFavourite(mate);
    for(let i=0;i<40;i++) e.addExpToActive(2000);

    const m=e.gameState.party.find(p=>p.instanceId===mate);
    check('team-mate evolved', m.speciesId!==4, 'species='+m.speciesId);
    // The id never changed, which is exactly why nothing needs rewriting now.
    check('still on the team', e.isOnTeam(mate), JSON.stringify(e.getTeam()));
    check('still a favourite', e.isFavourite(mate));
    check('the active evolved too', e.getActivePokemon().speciesId!==1);
  }

  console.log('\n=== a schema-1 save migrates its species ids ===');
  {
    // v1 stored speciesIds. Two Pikachu in the party and one "25" on the team
    // must resolve to exactly one of them, not both and not neither.
    const n=e.normalizeState({hasStarted:true,schemaVersion:1,activeInstanceId:'a',
      party:[{instanceId:'a',speciesId:1,level:5,totalExp:125},
             {instanceId:'b',speciesId:25,level:9,totalExp:600},
             {instanceId:'c',speciesId:25,level:30,totalExp:9000}],
      favouriteIds:[25,999,null,25], teamIds:[1,25,999]});
    check('schema bumped to 2', n.schemaVersion===2, String(n.schemaVersion));
    check('team ids became instanceIds', n.teamIds.every(id=>typeof id==='string'),
          JSON.stringify(n.teamIds));
    check('the "1" resolved to the Bulbasaur', n.teamIds.includes('a'), JSON.stringify(n.teamIds));
    check('the "25" resolved to exactly one Pikachu',
          n.teamIds.filter(id=>id==='b'||id==='c').length===1, JSON.stringify(n.teamIds));
    check('unowned species dropped', n.teamIds.length===2, JSON.stringify(n.teamIds));
    check('a repeated species id is not double-counted',
          n.favouriteIds.length===1, JSON.stringify(n.favouriteIds));
  }

  console.log('\n=== normalisation drops ids for Pokémon you do not own ===');
  {
    const n=e.normalizeState({hasStarted:true,schemaVersion:2,activeInstanceId:'i1',
      party:[{instanceId:'i1',speciesId:1,level:5,totalExp:125}],
      favouriteIds:['i1','nope',null,'i1'], teamIds:['i1','x','y','z','p','q','r','s']});
    check('unowned favourites removed', n.favouriteIds.every(id=>id==='i1'), JSON.stringify(n.favouriteIds));
    check('duplicates removed', n.favouriteIds.length===1);
    check('team capped at 6', n.teamIds.length<=6, JSON.stringify(n.teamIds));
    check('unowned team ids removed', n.teamIds.every(id=>id==='i1'));
    // Two entries claiming one instanceId is corruption, not a duplicate catch.
    const d=e.normalizeState({hasStarted:true,activeInstanceId:'i1',
      party:[{instanceId:'i1',speciesId:1,level:5,totalExp:125},
             {instanceId:'i1',speciesId:1,level:9,totalExp:600}]});
    check('duplicate instanceIds collapsed', d.party.length===1, String(d.party.length));
  }

  console.log('\n=== both lists sync ===');
  {
    e.gameState.favouriteIds=['i4']; e.gameState.teamIds=['i4'];
    const p=e.buildCloudPayload();
    check('favourites in payload', JSON.stringify(p.favouriteIds)==='["i4"]');
    check('team in payload', JSON.stringify(p.teamIds)==='["i4"]');
    check('schema travels with it', p.schemaVersion===2, String(p.schemaVersion));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
