/**
 * Flick, a student's devices, and their tabs, on one simulated clock.
 * ───────────────────────────────────────────────────────────────────
 * test_flick_progress.js drives the engine with readings written by hand, and
 * test_played_here.js drives the content script with events written by hand.
 * Neither can show what happens when the two meet FlickPlayer: a resume seek
 * landing around canplay, a post every 20 seconds and on pause, a list that
 * only catches up on a 60-second poll or a websocket push, a second tab with
 * its own idea of where every lecture is. That meeting is where "studied on
 * another device" has kept coming from, so this puts all of it in one room.
 *
 * Each tab with the extension runs the REAL config, battle, progress, engine
 * and content scripts in a VM context of its own, as Chrome runs one content
 * script world per tab. Tabs on one device share one chrome.storage.local and
 * one device ID; nothing else. Flick itself is modelled from FlickPlayer's
 * source (src/app/home/course/course.page.{ts,html}, man.service.ts):
 *
 *   - viewVideo() calls src() and then assigns currentVideo, so the list's
 *     highlight moves on the next change-detection pass;
 *   - loadedmetadata seeks to the saved end_time, unless it is 99.5% done,
 *     using the copy of the record this tab last rendered;
 *   - timeupdate (throttled to one per 2s) and pause feed a pairwise stream
 *     that posts the position every 20s while playing and on a pause that is
 *     not a seek; `ended` posts too;
 *   - the server keeps the LAST position posted, not the furthest;
 *   - each tab re-polls every 60s and takes websocket pushes in between;
 *   - a lecture with an evaluation and no record is shown as watched.
 *
 * Not a test file itself (no test_ prefix): test_flick_sim.js uses it.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..') + '/';
const SCRIPTS = [
    'content/flickemon-config.js',
    'content/flickemon-battle.js',
    'content/flickemon-flick-progress.js',
    'content/flickemon-engine.js',
    'content/content-script.js',
].map(file => new vm.Script(fs.readFileSync(ROOT + file, 'utf8'), { filename: file }));

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Lets every promise the last timer started run to completion. */
async function settle() {
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
}

class Clock {
    constructor(start) {
        this.now = start;
        this.timers = [];
        this.seq = 0;
        this.errors = [];
    }

    add(fn, ms, every, owner) {
        const id = ++this.seq;
        const wait = Math.max(0, Number(ms) || 0);
        this.timers.push({ id, at: this.now + wait, fn, every: every ? Math.max(1, wait) : 0, owner });
        return id;
    }
    setTimeout(fn, ms, owner) { return this.add(fn, ms, false, owner); }
    setInterval(fn, ms, owner) { return this.add(fn, ms, true, owner); }
    clear(id) { this.timers = this.timers.filter(t => t.id !== id); }
    clearOwner(owner) { this.timers = this.timers.filter(t => t.owner !== owner); }

    /** Runs every timer due in the next `ms`, in order, settling after each. */
    async advance(ms) {
        const end = this.now + ms;
        for (;;) {
            let next = null;
            for (const t of this.timers) {
                if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
            }
            if (!next) break;
            this.now = next.at;
            if (next.every) next.at += next.every;
            else this.timers = this.timers.filter(t => t !== next);
            try {
                const out = next.fn();
                if (out && typeof out.catch === 'function') out.catch(err => this.errors.push(err));
            } catch (err) {
                this.errors.push(err);
            }
            await settle();
        }
        this.now = end;
        await settle();
    }
}

/** One device's chrome.storage.local, shared by every tab on it. */
class DeviceStorage {
    constructor(clock) {
        this.clock = clock;
        this.data = {};
        this.listeners = [];
    }

    api(owner) {
        const pick = keys => {
            if (keys === null || keys === undefined) return clone(this.data);
            const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
            const out = {};
            for (const k of list) if (Object.prototype.hasOwnProperty.call(this.data, k)) out[k] = clone(this.data[k]);
            return out;
        };
        const changed = changes => {
            // Chrome tells every context, the writer included, a moment later.
            for (const { fn } of this.listeners.slice()) {
                this.clock.setTimeout(() => fn(clone(changes), 'local'), 0, owner);
            }
        };
        return {
            local: {
                get: async keys => pick(keys),
                set: async items => {
                    const changes = {};
                    for (const [k, v] of Object.entries(items)) {
                        changes[k] = { oldValue: clone(this.data[k]), newValue: clone(v) };
                        this.data[k] = clone(v);
                    }
                    changed(changes);
                },
                remove: async keys => {
                    const changes = {};
                    for (const k of [].concat(keys)) {
                        if (!(k in this.data)) continue;
                        changes[k] = { oldValue: clone(this.data[k]) };
                        delete this.data[k];
                    }
                    changed(changes);
                },
            },
            onChanged: {
                addListener: fn => this.listeners.push({ fn, owner }),
                removeListener: fn => { this.listeners = this.listeners.filter(l => l.fn !== fn); },
            },
        };
    }

    forget(owner) { this.listeners = this.listeners.filter(l => l.owner !== owner); }
}

/**
 * navigator.locks for one device. Web Locks are per origin, so every Flick tab
 * in a browser shares one set; requests are granted in the order they arrive.
 */
class DeviceLocks {
    constructor() { this.queues = new Map(); }

    request(name, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const prev = this.queues.get(name) || Promise.resolve();
        const run = prev.then(() => cb({ name, mode: 'exclusive' }));
        this.queues.set(name, run.catch(() => {}));
        return run;
    }
}

/** Flick's backend: play records, evaluations, and the push to every client. */
class FlickServer {
    constructor(clock, course) {
        this.clock = clock;
        this.course = course;
        this.records = {};
        this.evaluations = {};
        this.clients = new Set();
        this.posts = [];
    }

    post(lectureId, position, from) {
        const record = {
            video_id: lectureId,
            end_time: position,
            played_at: new Date(this.clock.now).toISOString(),
        };
        this.records[lectureId] = record;
        this.posts.push({ at: this.clock.now, lectureId, position, from });
        // A dropped websocket: pages only learn of it at their next poll.
        if (this.pushesDown) return;
        // PlayRecordUpdated, to every open Flick page the student has.
        for (const client of this.clients) {
            this.clock.setTimeout(() => client.pushed(clone(record)), 300, client);
        }
    }
}

/** <video>, with video.js and FlickPlayer's own listeners already on it. */
class SimVideo {
    constructor() {
        this.listeners = {};
        this.dataset = {};
        this.currentTime = 0;
        this.duration = NaN;
        this.paused = true;
        this.seeking = false;
        this.ended = false;
        this.readyState = 0;
        this.playbackRate = 1;
        this.ranges = [];
        const self = this;
        this.played = {
            get length() { return self.ranges.length; },
            start: i => self.ranges[i][0],
            end: i => self.ranges[i][1],
        };
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);
    }
    fire(type) {
        for (const fn of (this.listeners[type] || []).slice()) fn({ type, target: this });
    }
    markPlayed(from, to) {
        if (!(to > from)) return;
        const r = this.ranges.find(([a, b]) => from <= b + 0.01 && to >= a - 0.01);
        if (r) { r[0] = Math.min(r[0], from); r[1] = Math.max(r[1], to); }
        else this.ranges.push([from, to]);
        this.ranges.sort((a, b) => a[0] - b[0]);
    }
}

let tabSeq = 0;

/**
 * One Flick course page in one browser tab: FlickPlayer, and the extension if
 * the device has it.
 */
class FlickTab {
    constructor(device, { extension = device.extension, renderFirst = true, deferSeek = false } = {}) {
        this.id = 'tab' + (++tabSeq);
        this.device = device;
        this.world = device.world;
        this.clock = this.world.clock;
        this.server = this.world.server;
        this.course = this.world.course;
        this.extension = extension;
        // In a browser, Angular's change detection after the click usually
        // beats the media element's queued loadstart; either order is legal.
        this.renderFirst = renderFirst;
        // Whether video.js applies the resume seek at loadedmetadata or holds
        // it until canplay.
        this.deferSeek = deferSeek;
        this.closed = false;

        this.document = parseHTML('<!doctype html><html><head></head><body></body></html>').document;
        this.video = new SimVideo();
        this.observers = [];
        this.notices = [];

        // FlickPlayer's state.
        this.currentVideo = null;
        this.expectJump = false;
        this.pendingSeek = null;
        this.lastUpdated = 0;          // closure in course.page.ts: survives lecture changes
        this.previous = null;          // pairwise()
        this.throttledUntil = -Infinity;
        this.lectures = this.course.lectures.map(l => ({ ...l, history: { end_time: null, played_at: null } }));
        this.polled = clone(this.server.records);
        this.update = null;
        this.mergeVideoInfo();

        this.wirePlayer();
        this.server.clients.add(this);
        this.clock.setInterval(() => this.poll(), 60000, this);
        this.tickId = null;
    }

    // ── FlickPlayer ────────────────────────────────────────────────────────

    records() {
        const records = clone(this.polled) || {};
        const u = this.update;
        if (u && (!records[u.video_id] || records[u.video_id].played_at < u.played_at)) records[u.video_id] = u;
        return records;
    }

    mergeVideoInfo() {
        const history = this.records();
        const keys = Object.values(history).map(h => h.video_id)
            .sort((a, b) => ('' + history[b].played_at).localeCompare(history[a].played_at));
        this.lastPlayedVideoKey = keys.length ? keys[0] : null;
        for (const lecture of this.lectures) {
            lecture.history = history[lecture.id]
                ?? ((lecture.id in this.server.evaluations && lecture.duration)
                    ? { end_time: lecture.duration, played_at: null }
                    : { end_time: null, played_at: null });
        }
    }

    poll() {
        if (this.closed) return;
        this.polled = clone(this.server.records);
        this.mergeVideoInfo();
        this.render();
    }

    pushed(record) {
        if (this.closed) return;
        this.update = record;
        this.mergeVideoInfo();
        this.render();
    }

    render() {
        if (this.closed) return;
        let viewed = 0, duration = 0;
        for (const l of this.lectures) {
            if (!l.duration) continue;
            duration += l.duration;
            if (l.history.end_time) viewed += l.history.end_time;
        }
        const one = x => Number(x.toFixed(1)).toLocaleString('en-US', { maximumFractionDigits: 1 });
        const header = duration > 0
            ? `<small>${one((duration - viewed) / 3600)} hours left (${one((viewed / duration) * 100)}%)</small>` : '';

        const rows = this.lectures.map(l => {
            const open = this.currentVideo && this.currentVideo.id === l.id;
            const color = open ? 'secondary' : (this.lastPlayedVideoKey === l.id && !this.currentVideo ? 'tertiary' : '');
            const colorAttrs = color ? ` color="${color}" class="ion-color ion-color-${color}"` : '';
            const end = l.history.end_time;
            const inMin = l.duration ? Math.round(l.duration / 60) : 0;
            let info = '';
            if (inMin) info += `<span class="time-info">- ${inMin} min </span>`;
            if (end && end > 3) {
                info += '<span class="time-info">';
                if (!l.duration) info += `<span> - ${Math.round(end / 60)} min played </span>`;
                if (l.duration && end / l.duration < 0.95) {
                    info += `<span> - ${Math.round((l.duration - end) / 60)} min left </span>`;
                }
                info += '</span>';
            }
            const bar = end && l.duration && end > 3 && end / l.duration < 0.95
                ? `<ion-progress-bar value="${end / l.duration}"></ion-progress-bar>` : '';
            const check = end && l.duration && end / l.duration >= 0.95
                ? '<ion-icon class="check-icon" name="checkmark-outline" slot="end"></ion-icon>' : '';
            const resume = this.lastPlayedVideoKey === l.id
                ? '<ion-icon name="pause-circle-outline" slot="end"></ion-icon>' : '';
            return `<ion-item button${colorAttrs}><ion-label class="ion-text-wrap">`
                + `<span class="date">01 Oct 2026</span><span class="date-divider"> | </span>`
                + `${l.title}<small>${l.lecturer}${info}</small>${bar}</ion-label>${check}${resume}</ion-item>`;
        }).join('');

        this.document.body.innerHTML = `<ion-header><ion-toolbar><ion-title>${this.course.name}${header}</ion-title>`
            + `</ion-toolbar></ion-header><ion-content><ion-grid><ion-row>`
            + `<ion-col size="12" size-lg></ion-col>`
            + `<ion-col size="12" size-lg><ion-searchbar></ion-searchbar><ion-list>${rows}</ion-list></ion-col>`
            + `</ion-row></ion-grid></ion-content>`;
        for (const cb of this.observers) cb([]);
    }

    /** The listeners FlickPlayer puts on the player when the page is built. */
    wirePlayer() {
        const v = this.video;
        v.addEventListener('loadedmetadata', () => {
            const cv = this.currentVideo;
            if (!cv) return;
            if (!cv.duration) cv.duration = v.duration;
            if (cv.history.end_time && this.expectJump
                && (!cv.duration || (cv.history.end_time / cv.duration) < 0.995)) {
                if (this.deferSeek) this.pendingSeek = cv.history.end_time;
                else this.nativeSeek(cv.history.end_time);
            }
            this.expectJump = false;
        });
        v.addEventListener('canplay', () => {
            // video.js applying a seek it was holding: its own listener, so it
            // runs before anything added to the element later.
            if (this.pendingSeek !== null) {
                const at = this.pendingSeek;
                this.pendingSeek = null;
                this.nativeSeek(at);
            }
        });
        v.addEventListener('ended', () => this.updatePlayRecord());
        v.addEventListener('timeupdate', () => {
            if (this.clock.now < this.throttledUntil) return;
            this.throttledUntil = this.clock.now + 2000;
            this.emit();
        });
        v.addEventListener('pause', () => this.emit());
    }

    emit() {
        const v = this.video;
        const current = { currentTime: v.currentTime, isPaused: v.paused, isSeeking: v.seeking };
        const previous = this.previous;
        this.previous = current;
        if (!previous || !this.currentVideo) return;
        if (current.currentTime !== previous.currentTime) {
            if (this.clock.now - this.lastUpdated > 20000) {
                this.lastUpdated = this.clock.now;
                this.updatePlayRecord();
            } else if (current.isPaused && !current.isSeeking) {
                this.updatePlayRecord();
            }
        }
    }

    updatePlayRecord() {
        if (!this.currentVideo) return;
        const id = this.currentVideo.id;
        const at = this.video.currentTime;
        // The request takes a moment to land.
        this.clock.setTimeout(() => this.server.post(id, at, this.id), 120, this);
    }

    /** The element's own seek: seeking, then timeupdate and seeked. */
    nativeSeek(to) {
        const v = this.video;
        const target = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration : to, to));
        v.seeking = true;
        v.ended = false;
        v.currentTime = target;
        v.fire('seeking');
        v.fire('timeupdate');
        this.clock.setTimeout(() => {
            if (this.closed) return;
            v.seeking = false;
            v.fire('timeupdate');
            v.fire('seeked');
        }, 60, this);
    }

    // ── What the student does ──────────────────────────────────────────────

    /** Clicks a lecture in the list (viewVideo). */
    open(lectureId) {
        const lecture = this.lectures.find(l => l.id === lectureId);
        const v = this.video;
        const hadSource = v.readyState > 0 || Number.isFinite(v.duration);
        this.stopTicking();
        const sourceChange = () => {
            if (hadSource) {
                v.readyState = 0; v.duration = NaN; v.currentTime = 0;
                v.paused = true; v.ended = false; v.seeking = false; v.ranges = [];
                v.fire('emptied');
            }
            v.fire('loadstart');
        };
        // src() first, then currentVideo, then change detection.
        if (this.renderFirst) {
            this.currentVideo = lecture;
            this.expectJump = true;
            this.render();
            sourceChange();
        } else {
            sourceChange();
            this.currentVideo = lecture;
            this.expectJump = true;
            this.clock.setTimeout(() => this.render(), 30, this);
        }
        this.clock.setTimeout(() => {
            if (this.closed || this.currentVideo !== lecture) return;
            v.duration = lecture.realDuration;
            v.readyState = 1;
            v.fire('loadedmetadata');
        }, 150, this);
        this.clock.setTimeout(() => {
            if (this.closed || this.currentVideo !== lecture) return;
            v.readyState = 4;
            v.fire('loadeddata');
            v.fire('canplay');
            v.fire('canplaythrough');
        }, 260, this);
    }

    play() {
        const v = this.video;
        if (!this.currentVideo || !v.paused) return;
        v.paused = false;
        v.ended = false;
        v.fire('play');
        v.fire('playing');
        this.startTicking();
    }

    pause() {
        const v = this.video;
        if (v.paused) return;
        v.paused = true;
        this.stopTicking();
        v.fire('pause');
    }

    /** Arrow keys, or a click on the bar: the element seeks, play carries on. */
    seek(to) { if (this.currentVideo) this.nativeSeek(to); }
    skip(by) { this.seek(this.video.currentTime + by); }

    /** Dragging the scrubber: video.js pauses for the drag, then resumes. */
    drag(to) {
        const v = this.video;
        // The bar is only there once something is loaded.
        if (!this.currentVideo || v.readyState < 1) return;
        const wasPlaying = !v.paused;
        if (wasPlaying) { v.paused = true; this.stopTicking(); v.fire('pause'); }
        this.nativeSeek(to);
        if (wasPlaying) this.clock.setTimeout(() => { if (!this.closed) this.play(); }, 200, this);
    }

    rate(r) {
        this.video.playbackRate = r;
        this.video.fire('ratechange');
    }

    startTicking() {
        if (this.tickId) return;
        this.tickId = this.clock.setInterval(() => {
            const v = this.video;
            if (this.closed || v.paused || v.seeking || v.readyState < 3) return;
            const from = v.currentTime;
            const to = Math.min(v.duration, from + 0.25 * v.playbackRate);
            v.currentTime = to;
            v.markPlayed(from, to);
            v.fire('timeupdate');
            if (to >= v.duration) {
                v.paused = true;
                this.stopTicking();
                v.fire('pause');
                v.ended = true;
                v.fire('ended');
            }
        }, 250, this);
    }

    stopTicking() {
        if (this.tickId) this.clock.clear(this.tickId);
        this.tickId = null;
    }

    close() {
        this.closed = true;
        this.stopTicking();
        this.clock.clearOwner(this);
        this.server.clients.delete(this);
        this.device.storage.forget(this);
        this.device.tabs = this.device.tabs.filter(t => t !== this);
    }

    // ── The extension ──────────────────────────────────────────────────────

    async boot() {
        const tab = this;
        const clock = this.clock;
        const doc = this.document;
        const video = this.video;

        class SimDate extends Date {
            constructor(...a) { if (a.length) super(...a); else super(clock.now); }
            static now() { return clock.now; }
        }

        const document = {
            readyState: 'complete',
            visibilityState: 'visible',
            get body() { return doc.body; },
            get documentElement() { return doc.documentElement; },
            querySelector: sel => (sel === 'video' ? video : doc.querySelector(sel)),
            querySelectorAll: sel => doc.querySelectorAll(sel),
            getElementById: id => doc.getElementById(id),
            createElement: tag => doc.createElement(tag),
            addEventListener() {},
            removeEventListener() {},
        };

        const quiet = { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => tab.world.errors.push(a.join(' ')) };
        const sandbox = {
            console: quiet,
            Date: SimDate,
            document,
            chrome: { storage: this.device.storage.api(this), runtime: {} },
            setTimeout: (fn, ms) => clock.setTimeout(fn, ms, tab),
            clearTimeout: id => clock.clear(id),
            setInterval: (fn, ms) => clock.setInterval(fn, ms, tab),
            clearInterval: id => clock.clear(id),
            requestAnimationFrame: fn => clock.setTimeout(fn, 16, tab),
            MutationObserver: class { constructor(cb) { tab.observers.push(cb); } observe() {} disconnect() {} },
            TextEncoder,
            structuredClone,
            FlickemonUI: class {
                constructor() { this.music = null; }
                renderWidget() { return doc.createElement('div'); }
                syncToolbarLogo() {}
                showFlickCredit(result) { tab.notices.push(result); }
            },
            navigator: { userAgent: 'sim', locks: this.device.locks },
            location: { href: 'https://flick.docchula.com/course/sim', hostname: 'flick.docchula.com' },
        };
        sandbox.window = sandbox;
        sandbox.self = sandbox;
        sandbox.addEventListener = () => {};
        sandbox.removeEventListener = () => {};
        this.context = vm.createContext(sandbox);
        for (const script of SCRIPTS) script.runInContext(this.context);

        const engine = sandbox.flickemonEngine;
        this.engine = engine;
        const credit = engine.creditFlickProgress.bind(engine);
        engine.creditFlickProgress = async (reading, ...rest) => {
            const before = tab.world.trace ? clone({
                seen: engine.gameState.flickSeen, here: engine.gameState.flickPlayedHere,
                checkedAt: engine.gameState.flickCheckedAt, local: engine.gameState.flickLocalMinutes,
            }) : null;
            const r = await credit(reading, ...rest);
            if (r && r.rawMinutes > 0) {
                tab.device.paid.push({
                    tab: tab.id, at: clock.now, raw: r.rawMinutes,
                    ...(before ? { reading: reading.lectures.map(l => [l.title, l.playedSec, l.from]), before,
                                   records: clone(tab.world.server.records),
                                   video: { at: video.currentTime, lecture: tab.currentVideo && tab.currentVideo.title } } : {}),
                });
            }
            if (tab.world.trace && r) tab.world.trace.push([clock.now, tab.id, r.reason, r.rawMinutes || 0]);
            return r;
        };
        if (tab.world.trace) {
            // What the reading actually works from: after the other tabs'
            // accounting has been folded in.
            const settleReading = engine.settleFlickReading.bind(engine);
            engine.settleFlickReading = async (reading, now) => {
                tab.world.trace.push({ at: clock.now, tab: tab.id, merged: clone({
                    seen: engine.gameState.flickSeen, here: engine.gameState.flickPlayedHere }),
                    stored: clone(Object.values(tab.device.storage.data).find(v => v && v.flickSeen)) &&
                        clone(Object.fromEntries(Object.entries(tab.device.storage.data)
                            .filter(([, v]) => v && v.flickSeen).map(([k, v]) => [k, { seen: v.flickSeen, here: v.flickPlayedHere }]))) });
                return settleReading(reading, now);
            };
            const record = engine.recordPlayedHere.bind(engine);
            engine.recordPlayedHere = async (report, ...rest) => {
                tab.world.trace.push({ at: clock.now, tab: tab.id, report: clone(report) });
                return record(report, ...rest);
            };
        }
        // initExtension awaits the engine's init.
        await settle();
        await clock.advance(0);
    }
}

class Device {
    constructor(world, name, { extension = true } = {}) {
        this.world = world;
        this.name = name;
        this.extension = extension;
        this.storage = new DeviceStorage(world.clock);
        this.locks = new DeviceLocks();
        this.tabs = [];
        this.paid = [];
    }

    async openTab(opts = {}) {
        const tab = new FlickTab(this, opts);
        this.tabs.push(tab);
        tab.render();
        if (tab.extension) await tab.boot();
        return tab;
    }

    /** Total "studied on another device", in raw minutes, across every tab. */
    totalPaid() { return this.paid.reduce((a, p) => a + p.raw, 0); }
}

class World {
    constructor({ start = Date.UTC(2026, 9, 5, 1, 0, 0), course } = {}) {
        this.clock = new Clock(start);
        this.errors = [];
        this.course = course || World.defaultCourse();
        this.server = new FlickServer(this.clock, this.course);
        this.devices = [];
    }

    static defaultCourse() {
        return {
            name: 'Cardiovascular System',
            lectures: [
                // `duration` is what Flick stores; `realDuration` is the media's.
                { id: 101, title: 'Cardiac Cycle', lecturer: 'Dr. A', duration: 3020, realDuration: 3020.4 },
                { id: 102, title: 'Heart Sounds', lecturer: 'Dr. B', duration: 2700, realDuration: 2699.8 },
                { id: 103, title: 'ECG Basics', lecturer: 'Dr. C', duration: 5410, realDuration: 5410.2 },
                { id: 104, title: 'Valves', lecturer: 'Dr. D', duration: 751, realDuration: 751.3 },
            ],
        };
    }

    device(name, opts) {
        const d = new Device(this, name, opts);
        this.devices.push(d);
        return d;
    }

    advance(ms) { return this.clock.advance(ms); }
    minutes(n) { return this.clock.advance(n * 60000); }
}

module.exports = { World, Device, FlickTab, Clock, settle };
