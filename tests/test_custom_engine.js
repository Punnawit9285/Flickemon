const ROOT = require('path').join(__dirname, '..') + '/';
// A custom Pokemon driven through the real engine: caught, kept, levelled,
// saved and synced -- while never touching the 1,025-entry Pokedex.
global.window={addEventListener(){}};
global.window.FlickemonCustom=[
  {key:'mosscat',name:'Mosscat',types:['grass'],stats:{hp:60,attack:55,defense:50,speed:70},sprite:'m.png',wild:true},
  // Spelled the way the rest of the codebase spells it. `legendary: true` is
  // accepted too; both are tested in test_custom.js.
  {key:'relic',name:'Relic',types:['psychic','steel'],stats:{hp:100,attack:110,defense:95,speed:88},
   sprite:'relic.png',isLegendary:true},
];
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
global.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},onChanged:{addListener:()=>{}}},runtime:{sendMessage:async()=>null}};
global.document={visibilityState:'visible',addEventListener:()=>{}};
global.setTimeout=f=>{f();return 0;};global.clearTimeout=()=>{};global.setInterval=()=>0;
require(ROOT + 'content/flickemon-engine.js');
const e=window.flickemonEngine, cfg=window.FlickemonConfig;
let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);

(async()=>{
  e.isLoaded=true;
  await e.chooseStarter(1);
  e.gameState.battleMode='capture';
  const moss=cfg.getCustomByKey('mosscat');

  const dexBefore=e.gameState.pokedex.length;
  const caughtBefore=e.getCaughtCount();

  // Beat one, forcing the capture roll to succeed.
  const r=Math.random; Math.random=()=>0.2;
  e.wildOpponent={wildSpecies:moss,wildLevel:12,maxHp:100,currentHp:1,status:'fighting',shiny:false};
  e.wildHpAcc=1; await e.onVideoProgress(60);
  Math.random=r;

  const mine=e.gameState.party.find(p=>p.speciesId===moss.id);
  check('a custom can be caught', !!mine, JSON.stringify(e.gameState.party.map(p=>p.speciesId)));
  check('it lands in the party at its level', mine.level===12);
  // The respawn fires synchronously in this harness and marks the NEXT
  // (ordinary) opponent as seen, so the dex does grow -- just never by a custom.
  check('no custom ever enters the Pokedex',
        !e.gameState.pokedex.some(x=>cfg.isCustomSpeciesId(x.speciesId)),
        JSON.stringify(e.gameState.pokedex.map(x=>x.speciesId)));
  check('the caught count is untouched', e.getCaughtCount()===caughtBefore);
  check('and no dex entry names it', !e.gameState.pokedex.some(x=>x.speciesId===moss.id));

  // It behaves as a party member.
  check('the engine resolves its species', e.getSpeciesForPokemon(mine).name==='Mosscat');
  check('and a sprite id', e.spriteIdFor(mine)===moss.id);
  check('no mega for it', e.activeMegaForm(mine)===null && e.availableMegaForms(mine).length===0);
  e.gameState.activeInstanceId=mine.instanceId;
  check('it can be the active partner', e.getActivePokemon().speciesId===moss.id);
  const before=mine.totalExp;
  e.addExpToActive(5000);
  check('it gains EXP', mine.totalExp>before);

  // It survives a save round trip.
  const norm=e.normalizeState(JSON.parse(JSON.stringify(e.gameState)));
  check('it survives normalizeState', norm.party.some(p=>p.speciesId===moss.id));
  check('and the cloud payload carries it',
        e.buildCloudPayload().party.some(p=>p.speciesId===moss.id));

  // The wild lottery. At 1 in 10,000 a sampled rate would need tens of
  // millions of draws to mean anything, so pin the roll and test the branch
  // instead -- and guard the constant itself, since the whole point is that it
  // stays close to zero.
  e.gameState.activeInstanceId=e.gameState.party[0].instanceId;
  check('the chance is a rumour, not a drop rate',
        cfg.CUSTOM_ENCOUNTER_CHANCE > 0 && cfg.CUSTOM_ENCOUNTER_CHANCE <= 0.001,
        String(cfg.CUSTOM_ENCOUNTER_CHANCE));

  const pin=(v,fn)=>{const r=Math.random;let n=0;Math.random=()=>n++===0?v:r();
                     try{return fn();}finally{Math.random=r;}};
  check('a winning roll draws an opted-in custom',
        pin(cfg.CUSTOM_ENCOUNTER_CHANCE/2, ()=>e.rollWildPokemon().id)===moss.id);
  check('a losing roll never does',
        !cfg.isCustomSpeciesId(pin(cfg.CUSTOM_ENCOUNTER_CHANCE*2, ()=>e.rollWildPokemon().id)));

  // Over an ordinary session nobody should ever see one.
  let seen=0;
  for (let i=0;i<20000;i++) if (cfg.isCustomSpeciesId(e.rollWildPokemon().id)) seen++;
  check('and 20,000 encounters turn up almost none', seen<=8,
        `${seen} in 20,000 — expected about ${(20000*cfg.CUSTOM_ENCOUNTER_CHANCE).toFixed(1)}`);

  // With none opted in the encounter table is exactly what it was before.
  const all=cfg.customRoster(); const wasWild=all[0].wild; all[0].wild=false;
  let any=0;
  for (let i=0;i<3000;i++) if (cfg.isCustomSpeciesId(e.rollWildPokemon().id)) any++;
  check('with none opted in, none ever appear', any===0, String(any));
  check('not even on a winning roll',
        !cfg.isCustomSpeciesId(pin(0, ()=>e.rollWildPokemon().id)));
  all[0].wild=wasWild;

  // ── a legendary custom ──
  const legend=cfg.getCustomByKey('relic');
  check('isLegendary is carried through', legend.isLegendary===true);
  check('the engine treats it as a guaranteed catch',
        e.isGuaranteedCatch({wildSpecies:legend, shiny:false})===true);

  // Beaten in EXP mode with the capture roll deliberately lost: a legendary is
  // kept anyway, custom or not.
  e.gameState.battleMode='exp';
  const n0=e.gameState.party.length;
  const r2=Math.random; Math.random=()=>0.95;
  e.wildOpponent={wildSpecies:legend,wildLevel:30,maxHp:100,currentHp:1,status:'fighting',shiny:false};
  e.wildHpAcc=1; await e.onVideoProgress(60);
  Math.random=r2;
  check('a legendary custom is caught even in EXP mode',
        e.gameState.party.length===n0+1, `${n0} -> ${e.gameState.party.length}`);
  check('and still never enters the Pokedex',
        !e.gameState.pokedex.some(x=>cfg.isCustomSpeciesId(x.speciesId)));
  e.gameState.battleMode='capture';

  // It does not gatecrash the real legendary draw.
  check('it is not in the Lv.40 legendary pool',
        !cfg.POKEMON_REGISTRY.some(sp=>sp.id===legend.id));

  // ── the intended route: an admin trade ──
  const mineNow=e.gameState.party.find(p=>p.speciesId===moss.id);
  const before2=e.gameState.party.length;
  const res=await e.applyTrade('t-custom-1', mineNow.instanceId, {
      speciesId: legend.id, level: 44, shiny: true, megaStones: [],
  });
  check('a custom crosses a trade', res.ok===true, JSON.stringify(res));
  check('arriving at the level it was sent at', res.received.level===44);
  check('keeping its shininess', res.received.shiny===true);
  check('the party size is unchanged by a swap', e.gameState.party.length===before2);
  check('the traded-away one is gone',
        !e.gameState.party.some(p=>p.instanceId===mineNow.instanceId));
  check('and the trade did not touch the Pokedex either',
        !e.gameState.pokedex.some(x=>cfg.isCustomSpeciesId(x.speciesId)));
  check('the arrival resolves to a real species',
        e.getSpeciesForPokemon(res.received).name==='Relic');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
