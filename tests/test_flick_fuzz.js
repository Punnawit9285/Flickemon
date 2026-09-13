const ROOT = require('path').join(__dirname, '..') + '/';
/**
 * Adversarial checks on the Flick credit path.
 * ────────────────────────────────────────────
 * The other suite asserts that the feature does what it should on inputs
 * written to look like Flick. This one attacks it: degenerate markup, hostile
 * numbers, clocks that run backwards, and a state round-tripped through the
 * sync the way a second device would see it.
 *
 * Deterministic on purpose. A fuzz suite that fails one run in twenty teaches
 * nobody anything and gets deleted, so the generator is seeded and every run
 * covers exactly the same ground.
 */
const { parseHTML } = require('linkedom');

global.window = { addEventListener() {} };
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
global.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
               onChanged: { addListener: () => {} } },
    runtime: { sendMessage: async () => null },
};
global.document = { visibilityState: 'visible', addEventListener: () => {} };
global.setTimeout = f => { f(); return 0; }; global.clearTimeout = () => {}; global.setInterval = () => 0;
require(ROOT + 'content/flickemon-flick-progress.js');
require(ROOT + 'content/flickemon-engine.js');

const e = global.window.flickemonEngine;
const cfg = global.window.FlickemonConfig;
const FP = global.window.FlickProgress;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

/** Mulberry32 — same sequence every run, so a failure is always reproducible. */
function rng(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

(async () => {

console.log('\n=== the parser cannot be made to throw ===');
{
    // Every shape the page could be in that is not the shape it should be in.
    const hostile = [
        '', '<div>', '<ion-list></ion-list>',
        '<ion-list><ion-item></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label></ion-label></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label>T<small><span class="time-info"></span></small></ion-label></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label>T<small><span class="time-info">- NaN min</span></small></ion-label></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label>T<small><span class="time-info">- -5 min</span></small></ion-label></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label>T<small><span class="time-info">- 999999999 min</span></small></ion-label></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label>T<small><span class="time-info">- 60 min</span></small>'
            + '<ion-progress-bar value="Infinity"></ion-progress-bar></ion-label></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label>T<small><span class="time-info">- 60 min</span></small>'
            + '<ion-progress-bar value="-3"></ion-progress-bar></ion-label></ion-item></ion-list>',
        '<ion-list><ion-item><ion-label>T<small><span class="time-info">- 60 min</span></small>'
            + '<ion-progress-bar value="banana"></ion-progress-bar></ion-label></ion-item></ion-list>',
        '<ion-title><small>NaN hours left (NaN%)</small></ion-title><ion-list>'
            + '<ion-item><ion-label>T<small><span class="time-info">- 1 min</span></small></ion-label></ion-item></ion-list>',
        '<ion-title><small>-4 hours left (140%)</small></ion-title><ion-list>'
            + '<ion-item><ion-label>T<small><span class="time-info">- 1 min</span></small></ion-label></ion-item></ion-list>',
        // Nested lists, the shape a sidebar or a menu would take.
        '<ion-list><ion-list><ion-item><ion-label>Menu</ion-label></ion-item></ion-list></ion-list>',
    ];

    let threw = null, bad = null;
    for (const html of hostile) {
        try {
            const r = FP.readCourse(parseHTML(html).document);
            if (r) {
                for (const l of r.lectures) {
                    const okPlayed = Number.isFinite(l.playedSec) && l.playedSec >= 0;
                    const okDur = l.durationSec === null
                        || (Number.isFinite(l.durationSec) && l.durationSec >= 0);
                    // A lecture can never be more watched than it is long.
                    const okOrder = l.durationSec === null || l.playedSec <= l.durationSec;
                    if (!okPlayed || !okDur || !okOrder) bad = JSON.stringify(l) + ' from ' + html.slice(0, 60);
                }
                FP.agreesWithHeader(r);
            }
        } catch (err) { threw = html.slice(0, 60) + ' -> ' + err.message; break; }
    }
    check('no hostile page throws', threw === null, threw || '');
    check('and every figure it returns is sane', bad === null, bad || '');
}

console.log('\n=== a lecture is never more watched than it is long ===');
{
    const r = rng(12345);
    let worst = null;
    for (let i = 0; i < 400; i++) {
        const dur = Math.floor(r() * 300);
        const left = Math.floor(r() * 400) - 50;          // deliberately out of range
        const bar = (r() * 3 - 1).toFixed(4);             // -1 .. 2
        const html = `<ion-list><ion-item><ion-label>L${i}<small>
            <span class="time-info">- ${dur} min </span>
            <span class="time-info"><span>- ${left} min left</span></span></small>
            <ion-progress-bar value="${bar}"></ion-progress-bar></ion-label></ion-item></ion-list>`;
        const out = FP.readCourse(parseHTML(html).document);
        if (!out) continue;
        const l = out.lectures[0];
        if (!Number.isFinite(l.playedSec) || l.playedSec < 0
            || (l.durationSec !== null && l.playedSec > l.durationSec)) {
            worst = JSON.stringify({ dur, left, bar, l }); break;
        }
    }
    check('400 malformed rows all clamp inside their own duration', worst === null, worst || '');
}

// ── The credit path ──
e.isLoaded = true;
await e.chooseStarter(1);
e.gameState.battleMode = 'capture';
e.deviceId = 'dev_fuzz';

const doc = (min, dur, header) => parseHTML(
    `<ion-title>C${header === undefined ? '' : `<small>${header}</small>`}</ion-title>
     <ion-list><ion-item><ion-label>L<small>
        <span class="time-info">- ${dur} min </span>
        <span class="time-info"><span>- ${dur - min} min left</span></span>
     </small></ion-label></ion-item></ion-list>`).document;
// readCourse is what creditFlickProgress consumes. Handing it the document
// instead made every call return null at the guard, and a whole fuzz loop
// passed while exercising nothing at all.
const page = (min, dur, header) => FP.readCourse(doc(min, dur, header));

console.log('\n=== no sequence of readings can break the bounds ===');
{
    const r = rng(987654);
    const CAP = cfg.FLICK_DAILY_CAP_MINUTES;
    let violation = null, threw = null, totalCredited = 0;
    // Counters, because a fuzz loop that exercises nothing passes beautifully.
    // This suite already shipped one: it handed the credit path a DOM document
    // where a parsed reading belongs, so all 500 iterations bailed at the guard
    // and every assertion below was vacuously true.
    const seen = {};
    let clock = Date.UTC(2026, 8, 4, 6, 0, 0);

    e.gameState.flickSeen = {}; e.gameState.flickCheckedAt = 0;
    e.gameState.flickLocalMinutes = 0; e.gameState.dailyProgress = {};
    e.gameState.studyMinutes = {};

    let watched = 0;
    for (let i = 0; i < 500 && !violation && !threw; i++) {
        // Jump the clock forwards, and sometimes backwards — a student changing
        // their system time is not a hypothetical.
        clock += Math.floor((r() - 0.15) * 40 * 60000);
        // Drag the seekbar by an arbitrary amount, including backwards.
        watched = Math.max(0, Math.min(600, watched + Math.floor((r() - 0.3) * 200)));
        if (r() < 0.2) e.creditStudyMinutes(e.studySource(), r() * 30);

        const before = { ...e.gameState.flickSeen };
        let out;
        try { out = await e.creditFlickProgress(page(watched, 600, ''), clock); }
        catch (err) { threw = err.message + ' at i=' + i; break; }
        if (!out) { seen.null = (seen.null || 0) + 1; continue; }
        seen[out.reason || '?'] = (seen[out.reason || '?'] || 0) + 1;

        const c = out.credited || 0;
        if (!Number.isFinite(c) || c < 0) { violation = 'credited=' + c; break; }
        if (c > CAP * cfg.FLICK_CREDIT_RATE + 1) { violation = 'over cap in one go: ' + c; break; }
        if (out.exp !== undefined && (!Number.isFinite(out.exp) || out.exp < 0)) {
            violation = 'exp=' + out.exp; break;
        }
        for (const [k, v] of Object.entries(before)) {
            if ((e.gameState.flickSeen[k] || 0) < v) { violation = 'a mark went backwards: ' + k; break; }
        }
        totalCredited += c;
    }

    check('the loop actually reached the credit path',
        !seen.null && (seen.credited || 0) > 0, JSON.stringify(seen));
    check('and exercised the refusals too, not just the happy path',
        (seen['below-threshold'] || 0) + (seen['daily-cap'] || 0) > 0, JSON.stringify(seen));
    check('500 hostile readings never throw', threw === null, threw || '');
    check('and never break an invariant', violation === null, violation || '');
    check('marks only ever rise', violation === null || !/backwards/.test(violation));
    check('the day total never exceeds the cap',
        e.flickMinutesToday() <= CAP + 1, String(e.flickMinutesToday()));
    check('and neither does everything credited across the day',
        totalCredited <= CAP * cfg.FLICK_CREDIT_RATE + 1, String(totalCredited));
}

console.log('\n=== a clock that runs backwards earns nothing ===');
{
    e.gameState.flickSeen = {}; e.gameState.flickCheckedAt = 0;
    e.gameState.flickLocalMinutes = 0; e.gameState.dailyProgress = {};
    const T = Date.UTC(2026, 8, 4, 12, 0, 0);
    await e.creditFlickProgress(page(0, 600, ''), T);
    const back = await e.creditFlickProgress(page(300, 600, ''), T - 5 * 3600000);
    check('a reading from before the last one pays nothing',
        (back.credited || 0) === 0, String(back.credited));
    check('and the marks are not advanced by it',
        Object.values(e.gameState.flickSeen)[0] === 0,
        JSON.stringify(e.gameState.flickSeen));
}

console.log('\n=== everything new survives a sync, field by field ===');
{
    // Three separate places rebuild ledger rows field by field and drop what
    // they do not name; one of them already shipped that bug. This walks the
    // whole round trip a second device sees: save -> normalise -> cloud payload
    // -> merge, and checks each field is still there on the other side.
    e.gameState.flickSeen = { abc123abc123: 1234 };
    e.gameState.flickCheckedAt = Date.UTC(2026, 8, 4, 9, 0, 0);
    e.gameState.flickLocalMinutes = 17;
    e.gameState.flickPlayedHere = { abcabcabcabc: { from: 60, to: 90, at: Date.UTC(2026, 8, 4, 9, 0, 0) } };
    e.gameState.leaderboardLabel = 'pun…';
    e.gameState.dailyProgress = {
        '2026-09-04': { devA: { exp: 400, levels: 2, caught: 1, flickMin: 88 } },
    };

    const payload = JSON.parse(JSON.stringify(e.buildCloudPayload()));
    check('the marks reach the cloud payload', payload.flickSeen.abc123abc123 === 1234);
    check('so does the reading clock', payload.flickCheckedAt > 0);
    check('so does the board label', payload.leaderboardLabel === 'pun…');
    check('and the day ledger keeps its off-extension minutes',
        payload.dailyProgress['2026-09-04'].devA.flickMin === 88);

    // The local-only counter must NOT travel: it is this device's accounting
    // against its own clock.
    check('the local tally stays behind', payload.flickLocalMinutes === undefined);
    check('and so does where this device has played', payload.flickPlayedHere === undefined);

    // Now the receiving side.
    const fresh = e.normalizeState(JSON.parse(JSON.stringify(e.gameState)));
    check('a normalised save keeps the marks', fresh.flickSeen.abc123abc123 === 1234);
    check('and its off-extension minutes', fresh.dailyProgress['2026-09-04'].devA.flickMin === 88);
    check('and the local tally, which is stored but not sent', fresh.flickLocalMinutes === 17);
    check('as is the stretch played here', fresh.flickPlayedHere.abcabcabcabc.to === 90);

    e.gameState.flickSeen = {}; e.gameState.dailyProgress = {};
    e.gameState.flickCheckedAt = 0; e.gameState.leaderboardLabel = '';
    e.mergeCloudState(payload);
    check('a second device receives the marks', e.gameState.flickSeen.abc123abc123 === 1234);
    check('and the spent allowance', e.flickMinutesToday
        ? e.dailyTotals()['2026-09-04'].flickMin === 88 : false);
    check('and the reading clock', e.gameState.flickCheckedAt > 0);
}

console.log('\n=== the sanitiser repairs anything the parser could not ===');
{
    const nasty = e.normalizeState({
        flickSeen: { ok: 10, neg: -1, str: 'x', inf: Infinity, nan: NaN },
        flickCheckedAt: Number.MAX_SAFE_INTEGER,
        flickLocalMinutes: Infinity,
        flickPlayedHere: { inf: { from: 0, to: Infinity, at: 1 }, nan: { from: NaN, to: 5, at: 1 },
                           neg: { from: -5, to: 5, at: 1 }, ok: { from: 5, to: 9, at: NaN } },
        leaderboardLabel: 'someone@docchula.com',
        dailyProgress: { '2026-09-04': { d: { exp: -5, levels: NaN, caught: 3, flickMin: -9 } } },
    });
    check('infinite marks are dropped', nasty.flickSeen.inf === undefined);
    check('NaN marks are dropped', nasty.flickSeen.nan === undefined);
    check('sound marks survive', nasty.flickSeen.ok === 10);
    check('a clock from the year 275760 is reset', nasty.flickCheckedAt === 0);
    check('an infinite local tally is reset', nasty.flickLocalMinutes === 0);
    check('a stretch with no end is dropped', nasty.flickPlayedHere.inf === undefined);
    check('so is one starting nowhere, or before the start',
        nasty.flickPlayedHere.nan === undefined && nasty.flickPlayedHere.neg === undefined);
    check('a sound stretch with a broken clock is kept, and its clock repaired',
        nasty.flickPlayedHere.ok && Number.isFinite(nasty.flickPlayedHere.ok.at));
    check('a label carrying an address is discarded entirely',
        nasty.leaderboardLabel === '', nasty.leaderboardLabel);
    check('negative ledger figures become zero',
        nasty.dailyProgress['2026-09-04'].d.flickMin === 0
        && nasty.dailyProgress['2026-09-04'].d.exp === 0);
}

console.log('\n=== a model of FlickPlayer: studying only here is never paid as elsewhere ===');
{
    // Built from FlickPlayer's course.page.ts rather than imagined. The player
    // posts currentTime every 20 seconds while it moves and when it pauses;
    // Flick keeps the LAST position posted, not the furthest; a lecture opened
    // again resumes there unless it was 99.5% done; the list renders that record
    // with lengths rounded to a minute and a checkmark past 95%. On top of that
    // this device plays at random speeds, pauses, seeks both ways, moves between
    // lectures and closes the tab mid-play, while the harvest reads once a minute
    // whenever the tab is open -- and a phone, when there is one, plays too.
    const LEC = [50, 45, 61, 90, 30, 75].map((m, i) => ({ title: 'Lecture ' + i, dur: m * 60 - 13 * i }));
    const render = (rec, open) => {
        let total = 0, viewed = 0;
        const rows = LEC.map((l, i) => {
            const end = rec[i] || 0, ratio = end / l.dur, part = end > 3 && ratio < 0.95;
            total += l.dur; viewed += end;
            return `<ion-item button${open === i ? ' color="secondary" class="ion-color ion-color-secondary"' : ''}>
                <ion-label>${l.title}<small>Dr. X <span class="time-info">- ${Math.round(l.dur / 60)} min </span>
                ${part ? `<span class="time-info"><span>- ${Math.round((l.dur - end) / 60)} min left</span></span>` : ''}
                </small>${part ? `<ion-progress-bar value="${ratio}"></ion-progress-bar>` : ''}</ion-label>
                ${end > 3 && ratio >= 0.95 ? '<ion-icon class="check-icon"></ion-icon>' : ''}</ion-item>`;
        }).join('');
        return parseHTML(`<ion-title>Anatomy<small>${((total - viewed) / 3600).toFixed(1)} hours left
            (${((viewed / total) * 100).toFixed(1)}%)</small></ion-title><ion-list>${rows}</ion-list>`).document;
    };

    const run = async (seed, { report = true, withPhone = false } = {}) => {
        const r = rng(seed);
        Object.assign(e.gameState, { flickSeen: {}, flickCheckedAt: 0, flickLocalMinutes: 0,
            flickPlayedHere: {}, dailyProgress: {}, studyMinutes: {} });
        const rec = {};
        const resume = i => ((rec[i] || 0) / LEC[i].dur < 0.995 ? (rec[i] || 0) : 0);
        const tally = { paid: 0, phoneMin: 0, reads: 0, playedMin: 0, closes: 0, seeks: 0 };
        let t = Date.UTC(2026, 8, 1, 0, 0, 0), open = true, lastRead = -Infinity;
        let here = null, phone = null;

        for (let step = 0; step < 6 * 720; step++) {           // six hours in five-second steps
            t += 5000;

            if (withPhone) {
                if (!phone && r() < 0.001) {
                    const i = Math.floor(r() * LEC.length);
                    if (!here || here.i !== i) phone = { i, pos: resume(i), lastPost: t };
                }
                if (phone && (r() < 0.004 || (here && here.i === phone.i))) {
                    rec[phone.i] = phone.pos; phone = null;
                } else if (phone) {
                    const next = Math.min(LEC[phone.i].dur, phone.pos + 5);
                    tally.phoneMin += (next - phone.pos) / 60; phone.pos = next;
                    if (t - phone.lastPost >= 20000) { rec[phone.i] = phone.pos; phone.lastPost = t; }
                }
            }

            if (!open) { if (r() < 0.005) open = true; continue; }

            if (!here && r() < 0.03) {
                const i = Math.floor(r() * LEC.length);
                const d = render(rec, i), pos = resume(i);
                here = { i, pos, from: pos, to: pos, lastPost: t, playing: true,
                         speed: [1, 1.25, 1.5, 2, 3][Math.floor(r() * 5)],
                         name: { course: FP.parseCourseName(d), lecture: FP.activeLecture(d) } };
            }
            if (here) {
                const roll = r();
                if (roll < 0.01) {                                  // pause, or play on
                    here.playing = !here.playing;
                    if (!here.playing) rec[here.i] = here.pos;
                } else if (roll < 0.014) {                          // seek either way
                    here.pos = Math.max(0, Math.min(LEC[here.i].dur, here.pos + (r() - 0.4) * 1200));
                    if (!here.playing) rec[here.i] = here.pos;
                    tally.seeks++;
                } else if (roll < 0.016) {                          // on to another lecture
                    rec[here.i] = here.pos; here = null;
                } else if (roll < 0.0175) {                         // tab closed mid-play: nothing posts
                    here = null; open = false; tally.closes++;
                    continue;
                }
            }
            if (here && here.playing) {
                const dur = LEC[here.i].dur;
                here.pos = Math.min(dur, here.pos + 5 * here.speed);
                e.creditStudyMinutes(e.studySource(), 5 / 60);
                tally.playedMin += 5 / 60;
                if (t - here.lastPost >= 20000) { rec[here.i] = here.pos; here.lastPost = t; }
                if (here.pos >= dur) { rec[here.i] = dur; here.playing = false; }
            }
            if (here && report) {
                here.to = Math.max(here.to, here.pos);
                await e.recordPlayedHere({ ...here.name, from: here.from, to: here.to }, t);
            }
            if (t - lastRead >= 60000) {
                const out = await e.creditFlickProgress(FP.readCourse(render(rec, here ? here.i : null)), t);
                lastRead = t; tally.reads++;
                if (out && out.credited > 0) tally.paid += out.rawMinutes;
            }
        }
        return tally;
    };

    const local = [];
    for (const seed of [11, 22, 33]) local.push(await run(seed));
    const reached = local.reduce((a, x) => ({ reads: a.reads + x.reads, played: a.played + x.playedMin,
        closes: a.closes + x.closes, seeks: a.seeks + x.seeks }), { reads: 0, played: 0, closes: 0, seeks: 0 });
    // A model that never studied, never closed the tab or never sought would
    // pass the next check for free.
    check('the model really studied, read the page, sought and closed the tab',
        reached.reads > 500 && reached.played > 120 && reached.closes > 0 && reached.seeks > 20,
        JSON.stringify(reached));
    check('three simulated days of studying only here pay nothing as elsewhere',
        local.every(x => x.paid === 0), JSON.stringify(local.map(x => +x.paid.toFixed(2))));

    const unreported = await run(11, { report: false });
    check('the same day without the player reporting IS paid -- the model reaches the bug',
        unreported.paid > 1, String(unreported.paid));

    for (const seed of [44, 55]) {
        const x = await run(seed, { withPhone: true });
        // Past what the phone played only by rounding and a checkmark's tail.
        check(`a phone alongside (seed ${seed}) is still paid, and never beyond what it played`,
            x.paid > 5 && x.paid <= x.phoneMin + 6,
            `paid ${x.paid.toFixed(1)} for ${x.phoneMin.toFixed(1)} phone minutes`);
    }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
})();
