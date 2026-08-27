const ROOT = require('path').join(__dirname, '..') + '/';
// The widget must stop rebuilding its DOM on every video tick.
global.window={FlickemonConfig:require('fs')&&null};
global.window={};
require(ROOT + 'content/flickemon-config.js');
global.document={addEventListener:()=>{}};
require(ROOT + 'content/flickemon-ui.js');
const FlickemonUI=global.window.FlickemonUI;

let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);

// Minimal element stub: enough for updateWidgetView / patchWidgetView.
function el(){ return {
  style:{}, dataset:{}, textContent:'', innerHTML:'',
  classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
              toggle(c,on){on?this._s.add(c):this._s.delete(c);}, contains(c){return this._s.has(c);} },
  addEventListener(){}, querySelector(){return el();}, querySelectorAll(){return [];},
  getAttribute(){return null;}, setAttribute(){}, remove(){},
}; }

function makeCard(){
  const c=el(); c._writes=0;
  let html='';
  Object.defineProperty(c,'innerHTML',{get:()=>html,set(v){html=v;c._writes++;}});
  return c;
}

const species={id:1,name:'Bulbasaur',types:['grass'],baseStats:{hp:45,attack:49,defense:49,speed:45}};
const engine={
  getActivePokemon:()=>({instanceId:'a1',speciesId:1,level:10,totalExp:1000}),
  getSpeciesForPokemon:()=>species,
  activeMegaForm:()=>null,
  spriteIdFor:(pk)=>pk.speciesId,
  getExpProgress:()=>({current:100,needed:331,percent:30}),
  isCaptureMode:()=>true,
  getGameState:()=>({hasStarted:true}),
  onStateChange(){}, onWildChange(){}, onEvolution(){},
  wildOpponent:null,
};

const ui=new FlickemonUI(engine);
const state={hasStarted:true};
const wild=(hp)=>({wildSpecies:{id:6,name:'Charizard'},wildLevel:12,maxHp:100,currentHp:hp,status:'fighting'});

const card=makeCard();

console.log('\n=== first render builds the DOM ===');
ui.updateWidgetView(card,state,wild(100));
check('innerHTML written once', card._writes===1, 'writes='+card._writes);
check('signature recorded', !!card.dataset.sig, JSON.stringify(card.dataset.sig));

console.log('\n=== a video tick (HP only) must NOT rebuild ===');
const before=card._writes;
for (let hp=99; hp>90; hp--) ui.updateWidgetView(card,state,wild(hp));
check('no further innerHTML writes', card._writes===before, `${card._writes-before} extra rebuilds`);

console.log('\n=== 4Hz playback for 30s ===');
const b2=card._writes;
for (let i=0;i<120;i++) ui.updateWidgetView(card,state,wild(90-(i%50)));
check('still zero rebuilds', card._writes===b2, `${card._writes-b2} rebuilds in 120 ticks`);

console.log('\n=== structural change DOES rebuild ===');
const b3=card._writes;
ui.updateWidgetView(card,state,{...wild(0),status:'captured'});
check('status change rebuilds', card._writes===b3+1, `writes ${card._writes-b3}`);
const b4=card._writes;
ui.updateWidgetView(card,state,{wildSpecies:{id:25,name:'Pikachu'},wildLevel:9,maxHp:80,currentHp:80,status:'fighting'});
check('new opponent rebuilds', card._writes===b4+1);

console.log('\n=== open menu survives playback ===');
ui.popoverOpen=true;
const pika=(hp)=>({wildSpecies:{id:25,name:'Pikachu'},wildLevel:9,maxHp:80,currentHp:hp,status:'fighting'});
const b5=card._writes;
for (let i=0;i<40;i++) ui.updateWidgetView(card,state,pika(80-i%30));
check('menu stayed open', ui.popoverOpen===true);
check('no rebuild wiped it', card._writes===b5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
