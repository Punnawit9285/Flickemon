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
  activeMegaForm:()=>engine._mega,
  spriteIdFor:(pk)=>engine._mega?engine._mega.spriteId:pk.speciesId,
  _mega:null,
  getExpProgress:()=>({current:100,needed:331,percent:30}),
  isCaptureMode:()=>engine._capture,
  getExpDebt:()=>engine._debt,
  _capture:true,
  _debt:0,
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

console.log('\n=== a Mega toggle rebuilds ===');
// getSpeciesForPokemon returns the BASE species by design, so nothing else in
// the signature moves when a partner Mega Evolves. Before this was in the
// signature the widget took the patch path, and patchWidgetView never touches
// the partner sprite -- the HUD kept the ordinary sprite on screen.
{
  const b=card._writes;
  engine._mega={key:'charizard-mega-x',spriteId:10034,name:'Mega Charizard X'};
  ui.updateWidgetView(card,state,wild(50));
  check('switching a Mega on rebuilds', card._writes===b+1, `writes ${card._writes-b}`);
  check('and the new sprite is on screen', card.innerHTML.includes('10034'));

  const b2=card._writes;
  for (let hp=49; hp>40; hp--) ui.updateWidgetView(card,state,wild(hp));
  check('but playback still does not', card._writes===b2, `${card._writes-b2} extra`);

  const b3=card._writes;
  engine._mega=null;
  ui.updateWidgetView(card,state,wild(40));
  check('switching it off rebuilds too', card._writes===b3+1);
  check('back to the ordinary sprite', !card.innerHTML.includes('10034'));
}

console.log('\n=== the instant-capture button ===');
{
  engine._debt=0; engine._capture=true;
  ui.updateWidgetView(card,state,wild(60));
  check('offered during a capture-mode fight', card.innerHTML.includes('catch-now-btn'));
  check('and no debt line yet', !card.innerHTML.includes('exp-debt-flag'));

  ui.updateWidgetView(card,state,{...wild(0),status:'captured',expGained:0,instant:true});
  check('not offered once the battle is over', !card.innerHTML.includes('catch-now-btn'));
  check('an instant catch does not claim EXP it did not give',
        card.innerHTML.includes('Caught!') && !card.innerHTML.includes('+0 EXP'));

  const b=card._writes;
  engine._debt=10;
  ui.updateWidgetView(card,state,wild(59));
  check('taking on a debt rebuilds', card._writes===b+1, `writes ${card._writes-b}`);
  check('and the cost is on screen',
        card.innerHTML.includes('exp-debt-flag') && card.innerHTML.includes('10 more wins'));

  const b2=card._writes;
  for (let hp=58; hp>50; hp--) ui.updateWidgetView(card,state,wild(hp));
  check('but playback still does not rebuild', card._writes===b2, `${card._writes-b2} extra`);

  engine._debt=1;
  ui.updateWidgetView(card,state,wild(50));
  check('the last win reads in the singular',
        card.innerHTML.includes('1 more win') && !card.innerHTML.includes('1 more wins'));

  engine._debt=0; engine._capture=false;
  ui.updateWidgetView(card,state,wild(49));
  check('never offered in EXP mode', !card.innerHTML.includes('catch-now-btn'));

  // A legendary is a guaranteed catch, so selling an instant one would be a trap.
  engine._capture=true; engine._debt=0;
  const legend=(hp)=>({wildSpecies:{id:150,name:'Mewtwo',isLegendary:true},
                       wildLevel:45,maxHp:100,currentHp:hp,status:'fighting'});
  ui.updateWidgetView(card,state,legend(70));
  check('no catch button on a legendary', !card.innerHTML.includes('catch-now-btn'));
  check('it says why instead', card.innerHTML.includes('Guaranteed catch'));

  ui.updateWidgetView(card,state,{...wild(70)});
  check('the button comes back for an ordinary one',
        card.innerHTML.includes('catch-now-btn') && !card.innerHTML.includes('Guaranteed catch'));

  // A shiny is guaranteed too, and says so in BOTH modes -- EXP mode is where
  // an unexplained capture would read as a bug.
  ui.updateWidgetView(card,state,{...wild(70),shiny:true});
  check('no catch button on a shiny', !card.innerHTML.includes('catch-now-btn'));
  check('and it says why', card.innerHTML.includes('Guaranteed catch'));

  engine._capture=false;
  ui.updateWidgetView(card,state,{...wild(70),shiny:true});
  check('still says so in EXP mode', card.innerHTML.includes('Guaranteed catch'));
  ui.updateWidgetView(card,state,{...wild(70)});
  check('but nothing for an ordinary one there',
        !card.innerHTML.includes('Guaranteed catch') && !card.innerHTML.includes('catch-now-btn'));
  engine._capture=true;

  ui.updateWidgetView(card,state,{...wild(0),status:'captured',expGained:60,guaranteed:true});
  check('a guaranteed catch is named as one',
        card.innerHTML.includes('too rare to lose'));

  ui.updateWidgetView(card,state,{...wild(0),status:'defeated',expGained:60,brokeFree:true});
  check('a missed roll says so', card.innerHTML.includes('broke free'));
  check('and still shows the EXP', card.innerHTML.includes('+60 EXP'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
