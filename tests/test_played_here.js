const ROOT = require('path').join(__dirname, '..') + '/';
/**
 * The player's half of "studied here".
 * ────────────────────────────────────
 * content-script.js watches its own <video> and reports the stretch of the
 * lecture it covered, so the Flick harvest never pays that progress back as
 * "studied on another device". The engine's half is in test_flick_progress.js.
 *
 * This boots the REAL content script against a fake player that fires events in
 * the order a browser and video.js do, because the whole risk here is order:
 * reading the position before FlickPlayer's resume seek lands would hand a phone
 * session to this device, and reading it after a new source loads would hand the
 * old lecture's stretch to the new one.
 */
const fs = require('fs');
const vm = require('vm');
const { parseHTML } = require('linkedom');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

// The course page as FlickPlayer renders it. Ionic puts the open row's colour on
// the element twice, as an attribute and as classes.
const { document: page } = parseHTML(`<html><body>
    <ion-header><ion-toolbar><ion-title>Anatomy <small>1.2 hours left (40.0%)</small></ion-title></ion-toolbar></ion-header>
    <ion-list>
        <ion-item button id="axilla"><ion-label>Axilla<small>Dr. A
            <span class="time-info">- 45 min </span></small></ion-label></ion-item>
        <ion-item button id="plexus"><ion-label>Brachial Plexus<small>Dr. A
            <span class="time-info">- 50 min </span></small></ion-label></ion-item>
    </ion-list></body></html>`);
const highlight = id => {
    for (const item of page.querySelectorAll('ion-item')) {
        item.removeAttribute('color');
        item.setAttribute('class', '');
    }
    if (!id) return;
    const item = page.getElementById(id);
    item.setAttribute('color', 'secondary');
    item.setAttribute('class', 'ion-color ion-color-secondary');
};

class FakeVideo {
    constructor({ currentTime = 0, readyState = 0, played = [] } = {}) {
        this.listeners = {};
        this.dataset = {};
        this.currentTime = currentTime;
        this.readyState = readyState;
        this.paused = true; this.seeking = false; this.ended = false;
        this.played = { length: played.length, start: i => played[i][0], end: i => played[i][1] };
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
}

let video = new FakeVideo();
const reports = [];
const polls = [];
const document = {
    readyState: 'complete', body: page.body, documentElement: page.documentElement,
    querySelector: sel => (sel === 'video' ? video : page.querySelector(sel)),
    querySelectorAll: sel => page.querySelectorAll(sel),
    createElement: tag => page.createElement(tag),
    addEventListener() {},
};
const window = {
    flickemonEngine: {
        init: async () => {}, getPokemonTheme: async () => false, config: {},
        creditFlickProgress: async () => null, onVideoProgress() {},
        recordPlayedHere: async report => { reports.push(JSON.parse(JSON.stringify(report))); },
    },
    FlickemonUI: class {
        constructor() { this.music = null; }
        renderWidget() { return page.createElement('div'); }
    },
};
const context = vm.createContext({
    window, document, Date, JSON, Math, Number,
    console: { log() {}, warn: console.warn },
    setInterval: fn => polls.push(fn),
    requestAnimationFrame: fn => fn(),
    MutationObserver: class { observe() {} },
});
vm.runInContext(fs.readFileSync(ROOT + 'content/flickemon-flick-progress.js', 'utf8'), context);
vm.runInContext(fs.readFileSync(ROOT + 'content/content-script.js', 'utf8'), context);
const last = () => reports[reports.length - 1];

(async () => {
    await new Promise(r => setImmediate(r));     // initExtension awaits the engine first
    check('the content script booted and is polling for a player', polls.length === 1, String(polls.length));
    const hook = () => polls[0]();

    console.log('\n=== a lecture opened here reports from where it resumed ===');
    {
        highlight('plexus');
        hook();
        check('nothing is reported before a source loads', reports.length === 0);
        video.fire('loadstart');
        video.currentTime = 0;
        video.fire('timeupdate');
        check('nor while it is loading, before the resume seek has landed',
            reports.length === 0, JSON.stringify(reports));

        // video.js holds FlickPlayer's seek to the saved position until canplay.
        video.currentTime = 1200;
        video.readyState = 3;
        video.fire('canplay');
        check('canplay reports the resume point as where the stretch starts',
            reports.length === 1 && last().from === 1200 && last().to === 1200, JSON.stringify(last()));
        check('named by the row Flick highlights, as the harvest would read it',
            last().lecture && last().lecture.title === 'Brachial Plexus'
            && last().lecture.durationSec === 3000 && last().course === 'Anatomy', JSON.stringify(last()));
    }

    console.log('\n=== the stretch follows the player, and is never behind what Flick records ===');
    {
        video.paused = false;
        video.currentTime = 1260;
        video.fire('timeupdate');
        check('playing on extends it', last().from === 1200 && last().to === 1260, JSON.stringify(last()));

        const n = reports.length;
        video.currentTime = 1260.4;
        video.fire('timeupdate');
        check('a sub-second tick is not worth a report', reports.length === n);
        video.fire('pause');
        check('but a pause always is -- FlickPlayer posts then',
            reports.length === n + 1 && last().to === 1260.4, JSON.stringify(last()));

        video.currentTime = 1900;
        video.fire('seeked');
        check('a seek forward is covered, since Flick records it', last().to === 1900);
        video.currentTime = 300;
        video.fire('seeked');
        check('a seek back leaves both ends where they were',
            last().from === 1200 && last().to === 1900, JSON.stringify(last()));
    }

    console.log('\n=== another lecture starts a stretch of its own ===');
    {
        highlight('axilla');
        video.fire('loadstart');
        const n = reports.length;
        video.currentTime = 1900;
        video.fire('timeupdate');
        check('the old stretch does not carry into the new source', reports.length === n);

        video.currentTime = 0;                        // nothing saved, so no resume
        video.fire('canplay');
        check('it starts where the new lecture did, under the new name',
            reports.length === n + 1 && last().from === 0 && last().to === 0
            && last().lecture.title === 'Axilla', JSON.stringify(last()));
        video.fire('canplay');
        check('a later canplay, after buffering, does not restart it', reports.length === n + 1);
    }

    console.log('\n=== a lecture the page cannot name is still reported, for its course ===');
    {
        highlight(null);
        video.fire('emptied');
        video.currentTime = 90;
        video.fire('canplay');
        check('reported without a lecture, so the engine holds the whole course',
            last().lecture === null && last().course === 'Anatomy' && last().from === 90,
            JSON.stringify(last()));
    }

    console.log('\n=== a player hooked after it had already played ===');
    {
        highlight('plexus');
        // The site's router can put a fresh <video> in place of the old one.
        video = new FakeVideo({ currentTime: 700, readyState: 4, played: [[500, 640], [660, 700]] });
        hook();
        check('reports at once, from the first moment it played to the furthest',
            last().from === 500 && last().to === 700 && last().lecture.title === 'Brachial Plexus',
            JSON.stringify(last()));
        const n = reports.length;
        hook();
        check('hooking the same element again adds nothing', reports.length === n);
    }

    console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})();
