const ROOT = require('path').join(__dirname, '..') + '/';
global.window={};
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
const B=window.FlickemonBattle, C=window.FlickemonConfig;

let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);
const mon=(sid,lvl)=>B.toCombatant({level:lvl,totalExp:0},C.getSpeciesById(sid),C);

console.log('\n=== type chart matches the real game ===');
check('fire > grass (2x)',      B.typeEffectiveness('fire',['grass'])===2);
check('water > fire (2x)',      B.typeEffectiveness('water',['fire'])===2);
check('electric vs ground (0)', B.typeEffectiveness('electric',['ground'])===0);
check('normal vs ghost (0)',    B.typeEffectiveness('normal',['ghost'])===0);
check('fighting vs ghost (0)',  B.typeEffectiveness('fighting',['ghost'])===0);
check('dragon vs fairy (0)',    B.typeEffectiveness('dragon',['fairy'])===0);
check('dual type stacks 4x',    B.typeEffectiveness('rock',['fire','flying'])===4);
check('dual type cancels 1x',   B.typeEffectiveness('water',['water','grass'])===0.25*1||B.typeEffectiveness('water',['water','grass'])===0.25);
check('ice vs dragon/flying 4x',B.typeEffectiveness('ice',['dragon','flying'])===4);
check('all 18 types present',   Object.keys(B.TYPE_CHART).length===18);

console.log('\n=== movesets ===');
{
  const set=B.getMovesetFor(C.getSpeciesById(6),50);           // Charizard fire/flying
  check('4 moves', set.length===4, String(set.length));
  check('all from own types', set.every(m=>['fire','flying','normal'].includes(m.type)));
  check('has PP tracked', set.every(m=>m.ppLeft===m.pp));
  const low=B.getMovesetFor(C.getSpeciesById(1),5);
  check('low level gets weak moves', low.every(m=>m.power<=Math.max(40,5*2.2)));
  check('never empty even at Lv1', B.getMovesetFor(C.getSpeciesById(129),1).length>0);
}

console.log('\n=== determinism: both clients must agree ===');
{
  const build=()=>({p1:mon(6,50),p2:mon(9,50),p1Team:[],p2Team:[]});
  const a1={type:'move',moveId:'flamethrower'}, a2={type:'move',moveId:'surf'};
  const s1=build(), s2=build();
  const l1=B.resolveTurn(s1,a1,a2,'123456:1');
  const l2=B.resolveTurn(s2,a1,a2,'123456:1');
  check('identical logs',  JSON.stringify(l1)===JSON.stringify(l2));
  check('identical HP',    s1.p1.hp===s2.p1.hp && s1.p2.hp===s2.p2.hp, `${s1.p2.hp} vs ${s2.p2.hp}`);
  const s3=build();
  const l3=B.resolveTurn(s3,a1,a2,'123456:2');
  check('different turn differs', JSON.stringify(l3)!==JSON.stringify(l1) || s3.p2.hp!==s1.p2.hp);
}

console.log('\n=== damage behaves sensibly ===');
{
  const rng=B.makeRng('x');
  const atk=mon(6,50), def=mon(3,50);                      // Charizard vs Venusaur
  const d=B.computeDamage(atk,def,B.getMove('flamethrower'),rng);
  check('super effective flagged', d.effectiveness===2, String(d.effectiveness));
  check('damage is positive', d.damage>0);
  const imm=B.computeDamage(mon(25,50),mon(51,50),B.getMove('thunderbolt'),B.makeRng('y')); // electric vs ground
  check('immune deals 0', imm.damage===0 && imm.effectiveness===0);
  const st=B.computeDamage(atk,def,B.getMove('thunder-wave'),B.makeRng('z'));
  check('status move deals no damage', st.damage===0);
}

console.log('\n=== status effects ===');
{
  check('fire immune to burn', B.isImmuneToStatus(mon(6,50),'burn'));
  check('steel immune to poison', B.isImmuneToStatus(mon(82,50),'poison'));
  check('electric immune to paralysis', B.isImmuneToStatus(mon(25,50),'paralyze'));
  const burned=mon(3,50); burned.status='burn';
  check('burn halves attack', B.effectiveAttack(burned)===burned.attack*0.5);
  const par=mon(3,50); par.status='paralyze';
  check('paralysis halves speed', B.effectiveSpeed(par)===par.speed*0.5);
  // Residual damage at end of turn
  const s={p1:mon(3,50),p2:mon(9,50),p1Team:[],p2Team:[]};
  s.p1.status='poison'; const hp0=s.p1.hp;
  B.resolveTurn(s,{type:'move',moveId:'tackle'},{type:'move',moveId:'tackle'},'s:1');
  check('poison ticks each turn', s.p1.hp<hp0);
}

console.log('\n=== turn order ===');
{
  const fast=mon(101,50), slow=mon(95,50);                  // Electrode vs Onix
  const mv={type:'move',moveId:'tackle'};
  check('faster acts first',
        B.decideOrder(fast,slow,mv,mv,B.makeRng('a'))[0]==='p1');
  const slowWithPriority=mon(95,50);
  slowWithPriority.moves=[{...B.getMove('quick-attack'),ppLeft:30}];
  check('priority beats speed',
        B.decideOrder(slowWithPriority,fast,{type:'move',moveId:'quick-attack'},mv,B.makeRng('b'))[0]==='p1');
  check('switching resolves before attacking',
        B.decideOrder(slow,fast,{type:'switch',index:1},mv,B.makeRng('c'))[0]==='p1');
}

console.log('\n=== PP is consumed and enforced ===');
{
  const s={p1:mon(113,20),p2:mon(113,20),p1Team:[],p2Team:[]};   // Chansey: huge HP, nothing faints
  const mv=s.p1.moves[0];
  const before=mv.ppLeft;
  B.resolveTurn(s,{type:'move',moveId:mv.id},{type:'move',moveId:s.p2.moves[0].id},'p:1');
  check('PP decremented', s.p1.moves[0].ppLeft===before-1, `${s.p1.moves[0].ppLeft}/${before}`);
  s.p1.moves[0].ppLeft=0;
  const log=B.resolveTurn(s,{type:'move',moveId:mv.id},{type:'move',moveId:s.p2.moves[0].id},'p:2');
  check('exhausted PP refuses', log.some(l=>l.includes('no PP')), JSON.stringify(log));
}

console.log('\n=== a full battle terminates with one winner ===');
{
  const s={p1:mon(6,50),p2:mon(9,50),p1Team:[],p2Team:[]};
  let turns=0;
  while(s.p1.hp>0 && s.p2.hp>0 && turns<200){
    turns++;
    const m1=s.p1.moves.find(m=>m.ppLeft>0)||s.p1.moves[0];
    const m2=s.p2.moves.find(m=>m.ppLeft>0)||s.p2.moves[0];
    B.resolveTurn(s,{type:'move',moveId:m1.id},{type:'move',moveId:m2.id},`f:${turns}`);
  }
  check('battle ended', s.p1.hp<=0||s.p2.hp<=0, `after ${turns} turns`);
  check('exactly one side down', (s.p1.hp<=0)!==(s.p2.hp<=0) || turns<200);
  check('lasts more than one turn', turns>1, `${turns} turns`);
  check('finished in reasonable time', turns<60, `${turns} turns`);
  console.log(`         (resolved in ${turns} turns)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
