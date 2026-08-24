const ROOT = require('path').join(__dirname, '..') + '/';
// Evolution overlay: fullscreen deferral, sequential replay, and skip.
global.window = {};
require(ROOT + 'content/flickemon-config.js');

// ── Fake timers: real setTimeout would make ordering assertions timing-dependent.
const timers = new Map();
let nextId = 1;
global.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
function fireTimers() {                       // fire everything currently pending
    const due = [...timers.entries()];
    for (const [id, t] of due) { if (timers.delete(id)) t.fn(); }
}

// ── DOM stub.
const listeners = {};
const body = { children: [] };
function makeEl() {
    const e = {
        className: '', innerHTML: '', _handlers: {}, parentNode: null,
        addEventListener(type, fn) { (this._handlers[type] ||= []).push(fn); },
        click() { (this._handlers.click || []).forEach(fn => fn()); },
        remove() {
            const i = body.children.indexOf(this);
            if (i >= 0) body.children.splice(i, 1);
            this.parentNode = null;
        },
        querySelector() { return makeEl(); }, querySelectorAll() { return []; },
        getAttribute() { return null; }, setAttribute() {}, removeAttribute() {},
        style: {}, dataset: {},
        classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
        textContent: '',
    };
    return e;
}
global.document = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    createElement: () => makeEl(),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    body: { appendChild(el) { el.parentNode = body; body.children.push(el); } },
};
function dispatch(type) { (listeners[type] || []).forEach(fn => fn()); }
function enterFullscreen() { document.fullscreenElement = { tag: 'video' }; dispatch('fullscreenchange'); }
function exitFullscreen()  { document.fullscreenElement = null;              dispatch('fullscreenchange'); }

require(ROOT + 'content/flickemon-ui.js');
const FlickemonUI = global.window.FlickemonUI;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const engine = { onStateChange(){}, onWildChange(){}, onEvolution(){}, wildOpponent: null };
const evo = (from, to) => ({ from: { id: from, name: 'From' + from }, to: { id: to, name: 'To' + to } });
const cfg = global.window.FlickemonConfig;
const realEvo = (from, to) => ({ from: cfg.getSpeciesById(from), to: cfg.getSpeciesById(to) });
const overlays = () => body.children.filter(c => c.className === 'evolution-overlay-screen');

function fresh() {
    body.children.length = 0;
    timers.clear();
    document.fullscreenElement = null;
    document.webkitFullscreenElement = null;
    // Each UI registers document listeners in its constructor. Production makes
    // exactly one instance per page load, so drop the previous block's before
    // building the next — otherwise stale instances also react to dispatch().
    for (const k of Object.keys(listeners)) delete listeners[k];
    return new FlickemonUI(engine);
}

console.log('\n=== windowed: the overlay shows immediately ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay(evo(1, 2));
    check('overlay in the DOM', overlays().length === 1, 'n=' + overlays().length);
    check('queue drained', ui.pendingEvolutions.length === 0);
    check('not flagged deferred', !overlays()[0].innerHTML.includes('evo-deferred'));
}

console.log('\n=== fullscreen: nothing is drawn, the evolution is banked ===');
{
    const ui = fresh();
    enterFullscreen();
    ui.showEvolutionOverlay(evo(1, 2));
    check('no overlay while fullscreen', overlays().length === 0, 'n=' + overlays().length);
    check('queued instead', ui.pendingEvolutions.length === 1);
    check('no timer armed', timers.size === 0, 'timers=' + timers.size);

    exitFullscreen();
    check('replays on exit', overlays().length === 1, 'n=' + overlays().length);
    check('flagged as deferred', overlays()[0].innerHTML.includes('evo-deferred'));
    check('names both forms',
        overlays()[0].innerHTML.includes('From1 evolved into <b>To2</b>!'),
        overlays()[0].innerHTML.slice(0, 120));
}

console.log('\n=== several during one fullscreen session play in order ===');
{
    const ui = fresh();
    enterFullscreen();
    ui.showEvolutionOverlay(evo(1, 2));
    ui.showEvolutionOverlay(evo(4, 5));
    ui.showEvolutionOverlay(evo(7, 8));
    check('all three banked', ui.pendingEvolutions.length === 3);

    exitFullscreen();
    check('only one on screen', overlays().length === 1, 'n=' + overlays().length);
    check('first one first', overlays()[0].innerHTML.includes('From1 evolved into <b>To2</b>!'));
    check('shows the backlog count', overlays()[0].innerHTML.includes('+2 more'));

    fireTimers();
    check('second follows', overlays().length === 1 && overlays()[0].innerHTML.includes('From4 evolved into <b>To5</b>!'),
        overlays().length + ' on screen');
    check('backlog count decremented', overlays()[0].innerHTML.includes('+1 more'));

    fireTimers();
    check('third follows', overlays()[0].innerHTML.includes('From7 evolved into <b>To8</b>!'));
    check('the backlog line is hidden, not absent',
        /class="evo-queue" hidden/.test(overlays()[0].innerHTML),
        overlays()[0].innerHTML.slice(overlays()[0].innerHTML.indexOf('evo-queue') - 10, 200));

    fireTimers();
    check('queue empties', overlays().length === 0 && ui.pendingEvolutions.length === 0);
    check('not stuck playing', ui.evolutionPlaying === false);
}

console.log('\n=== click skips to the next ===');
{
    const ui = fresh();
    enterFullscreen();
    ui.showEvolutionOverlay(evo(1, 2));
    ui.showEvolutionOverlay(evo(4, 5));
    exitFullscreen();

    overlays()[0].click();
    check('advanced to the second', overlays().length === 1 && overlays()[0].innerHTML.includes('From4'),
        overlays().length + ' on screen');
    check('skipped timer cancelled', timers.size === 1, 'timers=' + timers.size);

    overlays()[0].click();
    check('last click clears the screen', overlays().length === 0);
    check('no orphaned timers', timers.size === 0, 'timers=' + timers.size);
}

console.log('\n=== a click racing its own timeout only fires once ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay(evo(1, 2));
    ui.showEvolutionOverlay(evo(4, 5));       // second stays queued behind the first
    const first = overlays()[0];
    first.click();                             // dismisses -> second starts
    const second = overlays()[0];
    first.click();                             // stale handler must be inert
    fireTimers();
    check('stale click did not skip ahead', overlays().length === 0 && ui.pendingEvolutions.length === 0,
        'on screen=' + overlays().length + ' queued=' + ui.pendingEvolutions.length);
    check('second really was a new overlay', second !== first);
}

console.log('\n=== evolving mid-playback, then leaving fullscreen later ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay(evo(1, 2));        // windowed: plays now
    fireTimers();
    enterFullscreen();
    ui.showEvolutionOverlay(evo(4, 5));        // fullscreen: banked
    check('banked while fullscreen', overlays().length === 0);
    exitFullscreen();
    check('shown on exit', overlays().length === 1 && overlays()[0].innerHTML.includes('From4'));
}

console.log('\n=== a stray fullscreenchange with an empty queue is harmless ===');
{
    const ui = fresh();
    exitFullscreen();
    exitFullscreen();
    check('nothing drawn', overlays().length === 0);
    check('not left playing', ui.evolutionPlaying === false);
}

console.log('\n=== webkit-prefixed fullscreen is honoured too ===');
{
    const ui = fresh();
    document.webkitFullscreenElement = { tag: 'video' };
    ui.showEvolutionOverlay(evo(1, 2));
    check('deferred under the prefixed API', overlays().length === 0 && ui.pendingEvolutions.length === 1);
    document.webkitFullscreenElement = null;
    dispatch('webkitfullscreenchange');
    check('prefixed exit event replays it', overlays().length === 1);
}

console.log('\n=== markup: burst must sit outside the filtered wrapper ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay(evo(1, 2));
    const html = overlays()[0].innerHTML;
    check('has a morph wrapper', html.includes('class="evo-morph"'));
    check('burst precedes the wrapper', html.indexOf('evo-burst') < html.indexOf('evo-morph'),
        'burst@' + html.indexOf('evo-burst') + ' morph@' + html.indexOf('evo-morph'));
    check('both sprites present', html.includes('old-sprite') && html.includes('new-sprite'));
    const cfg = global.window.FlickemonConfig;
    check('old sprite src is the from-species', html.includes(cfg.getSpriteUrl(1)));
    check('new sprite src is the to-species', html.includes(cfg.getSpriteUrl(2)));
}

console.log('\n=== re-entering fullscreen mid-animation replays it in full ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay(evo(1, 2));
    ui.showEvolutionOverlay(evo(4, 5));
    check('first is on screen', overlays()[0].innerHTML.includes('From1'));

    enterFullscreen();                         // user goes back into the video
    check('overlay torn down', overlays().length === 0, 'n=' + overlays().length);
    check('put back at the front of the queue',
        ui.pendingEvolutions.length === 2 && ui.pendingEvolutions[0].from.id === 1,
        JSON.stringify(ui.pendingEvolutions.map(e => e.from.id)));
    check('not left marked as playing', ui.evolutionPlaying === false);
    check('its timer was cancelled', timers.size === 0, 'timers=' + timers.size);

    exitFullscreen();
    check('same evolution replays from the start', overlays()[0].innerHTML.includes('From1'));
    check('now marked deferred', overlays()[0].innerHTML.includes('evo-deferred'));
    fireTimers();
    check('the second still follows', overlays()[0].innerHTML.includes('From4'));
}

console.log('\n=== toggling fullscreen repeatedly cannot loop or duplicate ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay(evo(1, 2));
    for (let i = 0; i < 25; i++) { enterFullscreen(); exitFullscreen(); }
    check('exactly one overlay on screen', overlays().length === 1, 'n=' + overlays().length);
    check('queue holds nothing extra', ui.pendingEvolutions.length === 0,
        'queued=' + ui.pendingEvolutions.length);
    check('one live timer', timers.size === 1, 'timers=' + timers.size);
    fireTimers();
    check('finishes cleanly', overlays().length === 0 && ui.evolutionPlaying === false);
    check('no dangling reference', ui.currentEvolution === null);
}

console.log('\n=== re-injecting the widget must not duplicate the overlay ===');
{
    // Faithful to the engine's contract: registering invokes the callback once
    // (state/wild only) and hands back an unsubscribe.
    function stubEngine() {
        const chans = { state: [], wild: [], evo: [] };
        const species = { id: 1, name: 'Bulbasaur', types: ['grass'],
                          baseStats: { hp: 45, attack: 49, defense: 49, speed: 45 } };
        return {
            _chans: chans,
            wildOpponent: null,
            getGameState: () => ({ hasStarted: true }),
            getActivePokemon: () => ({ instanceId: 'a1', speciesId: 1, level: 10, totalExp: 1000 }),
            getSpeciesForPokemon: () => species,
            getExpProgress: () => ({ current: 100, needed: 331, percent: 30 }),
            isCaptureMode: () => true,
            onStateChange(cb) { chans.state.push(cb); cb({ hasStarted: true });
                                return () => chans.state.splice(chans.state.indexOf(cb), 1); },
            onWildChange(cb)  { chans.wild.push(cb); cb(null);
                                return () => chans.wild.splice(chans.wild.indexOf(cb), 1); },
            onEvolution(cb)   { chans.evo.push(cb);
                                return () => chans.evo.splice(chans.evo.indexOf(cb), 1); },
            fireEvolution(e)  { chans.evo.forEach(cb => cb(e)); },
        };
    }

    body.children.length = 0;
    timers.clear();
    document.fullscreenElement = null;
    for (const k of Object.keys(listeners)) delete listeners[k];

    const eng = stubEngine();
    const ui = new FlickemonUI(eng);

    ui.renderWidget();
    check('one subscription per channel after the first inject',
        eng._chans.evo.length === 1 && eng._chans.state.length === 1 && eng._chans.wild.length === 1,
        `evo=${eng._chans.evo.length} state=${eng._chans.state.length} wild=${eng._chans.wild.length}`);

    ui.renderWidget();                          // course -> list -> course
    ui.renderWidget();
    check('re-injecting does not stack subscriptions',
        eng._chans.evo.length === 1 && eng._chans.state.length === 1 && eng._chans.wild.length === 1,
        `evo=${eng._chans.evo.length} state=${eng._chans.state.length} wild=${eng._chans.wild.length}`);

    eng.fireEvolution(evo(1, 2));
    check('one evolution shows exactly one overlay', overlays().length === 1, 'n=' + overlays().length);
    check('nothing left queued', ui.pendingEvolutions.length === 0,
        'queued=' + ui.pendingEvolutions.length);
}

console.log('\n=== the staged scene renders all of its layers ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay(realEvo(1, 2));       // Bulbasaur -> Ivysaur
    const html = overlays()[0].innerHTML;

    check('asks the question first', html.includes('What? <b>Bulbasaur</b> is evolving!'), html.slice(0, 200));
    check('screen flash present', html.includes('evo-flash'));
    check('light rays present', html.includes('evo-rays'));
    check('three converging rings',
        ['evo-ring-1', 'evo-ring-2', 'evo-ring-3'].every(c => html.includes(c)));
    check('burst present', html.includes('evo-burst'));
    check('a full ring of sparks', (html.match(/--angle:/g) || []).length === 12,
        String((html.match(/--angle:/g) || []).length));
    check('announces the outcome', html.includes('Bulbasaur evolved into <b>Ivysaur</b>!'));
    check("shows the new form's types",
        html.includes('type-pill grass') && html.includes('type-pill poison'));
    check('shows the stat gains', html.includes('HP <b>+15</b>'), 'no gains row');

    // Order matters in the DOM as well as on the timeline: the rays have to
    // paint behind the sprites, and the reveal after the stage.
    check('outcome sits after the stage',
        html.indexOf('evo-outcome') > html.indexOf('evo-stage'));
    check('rays sit behind the sprites',
        html.indexOf('evo-rays') < html.indexOf('evo-morph'));
}

console.log('\n=== overlay markup and stylesheet stay in step ===');
{
    // A class in the HTML with no rule behind it is the usual way these two
    // files drift apart after a rename. Cover the conditional branches too.
    const css = require('fs').readFileSync(ROOT + 'content/styles.css', 'utf8');

    // `deferred` is derived from fullscreen state, not accepted from the caller,
    // so the banner has to be earned the real way.
    const ui = fresh();
    enterFullscreen();
    ui.showEvolutionOverlay(realEvo(1, 2));
    ui.showEvolutionOverlay(realEvo(4, 5));                 // second one forces "+N more"
    exitFullscreen();
    const withExtras = overlays()[0].innerHTML;

    const ui2 = fresh();
    ui2.showEvolutionOverlay(realEvo(133, 134));             // plain, single-type
    const plain = overlays()[0].innerHTML;

    const used = new Set();
    for (const m of (withExtras + plain).matchAll(/class="([^"]+)"/g)) {
        m[1].split(/\s+/).forEach(c => c && used.add(c));
    }
    const unstyled = [...used].filter(c =>
        !new RegExp('\\.' + c.replace(/-/g, '\\-') + '(?![\\w-])').test(css));
    check('every class in the overlay has a rule', unstyled.length === 0, unstyled.join(', '));
    check('the deferred banner was covered', used.has('evo-deferred'));
    check('the backlog line was covered', used.has('evo-queue'));
}

console.log('\n=== a bare {id, name} listener payload still renders fully ===');
{
    // The engine passes registry objects today, but the listener contract only
    // promises id and name; the overlay looks the rest up itself.
    const ui = fresh();
    ui.showEvolutionOverlay(evo(1, 2));
    const html = overlays()[0].innerHTML;
    check('types recovered from the registry', html.includes('type-pill grass'), 'no type pills');
    check('gains recovered from the registry', html.includes('HP <b>+15</b>'), 'no gains');
    check('names still come from the payload', html.includes('From1 evolved into <b>To2</b>!'));
}

console.log('\n=== a team member\'s evolution is labelled as theirs ===');
{
    const ui = fresh();
    ui.showEvolutionOverlay({ ...realEvo(1, 2), benched: true });
    const html = overlays()[0].innerHTML;
    check('labelled as a team member', html.includes('evo-benched'), html.slice(0, 160));
    check('and still names the Pokémon', html.includes('What? <b>Bulbasaur</b> is evolving!'));

    const ui2 = fresh();
    ui2.showEvolutionOverlay(realEvo(4, 5));
    check('the partner\'s own evolution is not labelled',
        !overlays()[0].innerHTML.includes('evo-benched'));
}

console.log('\n=== several team members evolving on one battle queue up ===');
{
    // This is why they used to be silent: three at once would have stacked
    // five-second takeovers on top of each other.
    const ui = fresh();
    ui.showEvolutionOverlay({ ...realEvo(1, 2), benched: true });
    ui.showEvolutionOverlay({ ...realEvo(4, 5), benched: true });
    ui.showEvolutionOverlay({ ...realEvo(7, 8), benched: true });

    check('only one is on screen', overlays().length === 1, 'n=' + overlays().length);
    check('the other two are queued', ui.pendingEvolutions.length === 2);

    // All three fire in the same tick, so the first overlay rendered its count
    // before the other two were queued. It has to be corrected afterwards or
    // the backlog is under-reported exactly when it matters most.
    const badge = { textContent: '', attrs: { hidden: '' },
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; } };
    ui.currentOverlayEl = { querySelector: (sel) => sel === '.evo-queue' ? badge : null };
    ui.refreshQueueBadge();
    check('the live count matches the queue', badge.textContent === '+2 more', badge.textContent);
    check('and the line is revealed', !('hidden' in badge.attrs), JSON.stringify(badge.attrs));

    ui.pendingEvolutions = [];
    ui.refreshQueueBadge();
    check('an emptied queue hides it again', 'hidden' in badge.attrs && badge.textContent === '+0 more',
        badge.textContent + ' ' + JSON.stringify(badge.attrs));
    ui.pendingEvolutions = [realEvo(4, 5), realEvo(7, 8)];

    fireTimers();
    check('the second follows', overlays()[0].innerHTML.includes('From4') ||
        overlays()[0].innerHTML.includes('Charmander'), overlays()[0].innerHTML.slice(0, 80));
    fireTimers(); fireTimers();
    check('all three played, none dropped', overlays().length === 0 && ui.pendingEvolutions.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
