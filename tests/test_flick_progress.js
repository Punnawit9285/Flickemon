const ROOT = require('path').join(__dirname, '..') + '/';
// Credit for studying done where this extension was not running.
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
require(ROOT + 'content/flickemon-ui.js');

const e = global.window.flickemonEngine;
const cfg = global.window.FlickemonConfig;
const FP = global.window.FlickProgress;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ── Fixtures, written to mirror FlickPlayer's own course.page.html ──
// The row renders the time REMAINING, not the time watched, and only while a
// lecture is under 95%. Past that it loses the text and the bar and gains a
// checkmark, so "no numbers" means finished in one case and untouched in the
// other.
const row = ({ title, lecturer = 'Dr. Somchai', durationMin, leftMin, barValue,
               playedMin, check: done, date = '01 Sep 2026' }) => `
    <ion-item button>
        <ion-label class="ion-text-wrap">
            <span class="date">${date}</span>
            <span class="date-divider"> | </span>
            ${title}
            <small>
                ${lecturer}
                ${durationMin ? `<span class="time-info">- ${durationMin} min </span>` : ''}
                ${leftMin !== undefined ? `<span class="time-info"><span>
                    - ${leftMin} min left</span></span>` : ''}
                ${playedMin !== undefined ? `<span class="time-info"><span>
                    - ${playedMin} min played</span></span>` : ''}
            </small>
            ${barValue !== undefined ? `<ion-progress-bar value="${barValue}"></ion-progress-bar>` : ''}
        </ion-label>
        ${done ? '<ion-icon class="check-icon" name="checkmark-outline"></ion-icon>' : ''}
    </ion-item>`;

const page = (rows, header = '2.4 hours left (68.1%)', course = 'Cardiology') => parseHTML(`
    <ion-header><ion-toolbar><ion-title>${course}
        ${header ? `<small>${header}</small>` : ''}
    </ion-title></ion-toolbar></ion-header>
    <ion-list>${rows.join('')}</ion-list>`).document;

(async () => {

console.log('\n=== reading the page Flick already rendered ===');
{
    const doc = page([
        row({ title: 'Cardiovascular Physiology I', durationMin: 45, leftMin: 34, barValue: 0.2444 }),
        row({ title: 'Renal Physiology', durationMin: 60, check: true }),
        row({ title: 'Intro to Anatomy', durationMin: 30 }),
        row({ title: 'Unknown Length Lecture', playedMin: 12 }),
    ]);
    const reading = FP.readCourse(doc);

    check('four rows are read', reading && reading.lectures.length === 4,
        reading && String(reading.lectures.length));

    const [cardio, renal, intro, unknown] = reading.lectures;

    // The bar carries the raw ratio; the text is rounded to whole minutes.
    check('a part-watched lecture reads its position from the bar',
        near(cardio.playedSec, 0.2444 * 45 * 60, 1), String(cardio.playedSec));
    check('a checkmark counts as complete', renal.playedSec === 60 * 60, String(renal.playedSec));
    check('an untouched lecture is zero, not unknown', intro.playedSec === 0, String(intro.playedSec));
    check('minutes PLAYED is used where Flick has no duration',
        unknown.playedSec === 12 * 60 && unknown.durationSec === null, JSON.stringify(unknown));

    check('the title drops the date, the lecturer and the bar',
        cardio.title === 'Cardiovascular Physiology I', cardio.title);
    check('the course name drops the progress header',
        reading.course === 'Cardiology', reading.course);
    check('the header yields both figures',
        reading.header && near(reading.header.hoursLeft, 2.4) && near(reading.header.percent, 68.1),
        JSON.stringify(reading.header));
}

console.log('\n=== without a bar, the remaining time is the signal ===');
{
    const doc = page([row({ title: 'A', durationMin: 45, leftMin: 34 })]);
    const [a] = FP.readCourse(doc).lectures;
    check('played is duration minus what is left', a.playedSec === (45 - 34) * 60, String(a.playedSec));
}

console.log('\n=== an unchanged page must difference to exactly zero ===');
{
    // The whole design rests on this: rounding to whole minutes is harmless
    // only because an untouched lecture yields the SAME number every time.
    const rows = [row({ title: 'A', durationMin: 45, leftMin: 34 }),
                  row({ title: 'B', durationMin: 60, check: true })];
    const first = FP.readCourse(page(rows));
    const second = FP.readCourse(page(rows));
    check('two reads of one page agree exactly',
        JSON.stringify(first.lectures) === JSON.stringify(second.lectures));
}

console.log('\n=== a page that is not a course reads as nothing, not as empty ===');
{
    // "No lectures here" and "a course where nothing was watched" must not look
    // alike, or navigating away would read as progress being lost.
    check('no lecture list is null', FP.readCourse(parseHTML('<div>hello</div>').document) === null);
    check('an empty list is null too', FP.readCourse(page([])) === null);
}

console.log('\n=== the rows and the header have to agree ===');
{
    const consistent = FP.readCourse(page(
        [row({ title: 'A', durationMin: 60, leftMin: 30 })], '0.5 hours left (50%)'));
    check('a consistent page is trusted', FP.agreesWithHeader(consistent) === true);

    const skewed = FP.readCourse(page(
        [row({ title: 'A', durationMin: 60, leftMin: 30 })], '9 hours left (2%)'));
    check('a header that disagrees badly is rejected', FP.agreesWithHeader(skewed) === false);

    const noHeader = FP.readCourse(page([row({ title: 'A', durationMin: 60, leftMin: 30 })], ''));
    check('no header at all is not a disagreement', FP.agreesWithHeader(noHeader) === true);
}

// ── The engine ──
e.isLoaded = true;
await e.chooseStarter(1);
e.gameState.battleMode = 'capture';
e.deviceId = 'dev_test';

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const MIN = 60000;
const reset = () => {
    e.gameState.flickSeen = {};
    e.gameState.flickCheckedAt = 0;
    e.gameState.studyMinutes = {};
    e.gameState.flickLocalMinutes = 0;
    // The daily allowance is cumulative across a day, and every block here
    // shares one simulated day — without this each block inherits whatever the
    // last one spent.
    e.gameState.dailyProgress = {};
};
// One lecture, watched `min` minutes of a 120-minute recording.
const watched = min => FP.readCourse(page(
    [row({ title: 'Cardiovascular Physiology I', durationMin: 120, leftMin: 120 - min })],
    `${((120 - min) / 60).toFixed(1)} hours left (${((min / 120) * 100).toFixed(1)}%)`));

console.log('\n=== the first look starts the clock, it does not pay out ===');
{
    reset();
    const r = await e.creditFlickProgress(watched(90), NOW);
    check('nothing is credited on a first reading', r.credited === 0 && r.reason === 'first-reading');
    check('but the clock is now running', e.gameState.flickCheckedAt === NOW);
    check('and the position is recorded', Object.keys(e.gameState.flickSeen).length === 1);

    // Otherwise opening a course for the first time would bank a whole
    // semester of watching that happened before any of this existed.
    check('90 minutes of pre-existing history bought nothing',
        !e.gameState.studyMinutes[e.flickBucket()]);
}

console.log('\n=== a genuine rise is credited, at the advertised rate ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    const before = e.getActivePokemon().totalExp;
    const wallet = JSON.stringify(e.gameState.shopWallet);

    const r = await e.creditFlickProgress(watched(60), NOW);
    check('an hour elsewhere is worth 18 minutes here',
        near(r.credited, 60 * cfg.FLICK_CREDIT_RATE, 0.05), String(r.credited));
    check('it lands in this device\'s own Flick bucket',
        near(e.gameState.studyMinutes['flick:dev_test'], 18, 0.05),
        JSON.stringify(e.gameState.studyMinutes));
    check('EXP moved', e.getActivePokemon().totalExp > before);
    check('money did NOT — the wallet rule would reject the save',
        JSON.stringify(e.gameState.shopWallet) === wallet);
    check('and nothing was caught', r.evolved === null || r.evolved === undefined || !r.caught);
}

console.log('\n=== rewatching earns nothing ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    await e.creditFlickProgress(watched(60), NOW);
    const after = e.gameState.studyMinutes['flick:dev_test'];

    // Flick's end_time is a resume position, so restarting a lecture drops it.
    const r = await e.creditFlickProgress(watched(10), NOW + 10 * MIN);
    check('a position that went backwards credits nothing', r.credited === 0, String(r.credited));
    check('and the mark holds at the high-water point',
        e.gameState.studyMinutes['flick:dev_test'] === after);

    const again = await e.creditFlickProgress(watched(55), NOW + 20 * MIN);
    check('re-covering old ground still credits nothing', again.credited === 0, String(again.credited));
}

console.log('\n=== the ceiling: never more than time has actually passed ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    // Forge three hours of progress one minute after the last reading.
    const r = await e.creditFlickProgress(watched(180), NOW - 59 * MIN);
    check('a three-hour jump one minute later pays about one minute',
        near(r.rawMinutes, 1 * cfg.FLICK_MAX_RATE, 0.02), String(r.rawMinutes));
    check('so the credit is a third of a minute, not fifty-four',
        near(r.credited, 1 * cfg.FLICK_MAX_RATE * cfg.FLICK_CREDIT_RATE, 0.02), String(r.credited));

    // And the excess is forfeit rather than banked: the mark advanced to the
    // forged position, so there is nothing left to claim later.
    const later = await e.creditFlickProgress(watched(180), NOW + 120 * MIN);
    check('the forged remainder cannot be claimed later', later.credited === 0, String(later.credited));
}

console.log('\n=== watching here is not paid for twice ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    // An hour watched WITH the extension open: counted locally, and Flick's own
    // record advances by the same hour.
    e.creditStudyMinutes(e.studySource(), 60);

    const r = await e.creditFlickProgress(watched(60), NOW);
    check('the hour already counted locally is subtracted',
        r.credited === 0 || r.credited < 1, String(r.credited));
    check('local minutes are tracked separately from Flick\'s',
        e.gameState.studyMinutes['dev_test'] === 60,
        JSON.stringify(e.gameState.studyMinutes));
}

console.log('\n=== a rise too small to be signal waits rather than vanishing ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    const tiny = await e.creditFlickProgress(watched(0.2), NOW - 59 * MIN);
    check('12 seconds is below the threshold', tiny.credited === 0 && tiny.reason === 'below-threshold');
    check('and the mark is deliberately NOT advanced',
        Object.values(e.gameState.flickSeen)[0] === 0,
        JSON.stringify(e.gameState.flickSeen));

    // Which is the point: it accumulates instead of rounding to nothing forever.
    const later = await e.creditFlickProgress(watched(30), NOW);
    check('the remainder is still there to be claimed', later.credited > 0, String(later.credited));
}

console.log('\n=== a misparse credits nothing ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    const skewed = FP.readCourse(page(
        [row({ title: 'Cardiovascular Physiology I', durationMin: 120, leftMin: 60 })],
        '40 hours left (1%)'));
    const r = await e.creditFlickProgress(skewed, NOW);
    check('rows that disagree with the header pay nothing', r.credited === 0 && r.reason === 'disagree');
}

console.log('\n=== nothing legible about what is being studied leaves the device ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    await e.creditFlickProgress(watched(60), NOW);

    const flat = JSON.stringify(e.buildCloudPayload());
    check('the payload carries the marks', flat.includes('flickSeen'));
    check('but no lecture title', !flat.includes('Cardiovascular'));
    check('and no course name', !flat.includes('Cardiology'));
    check('the keys are hex digests', Object.keys(e.gameState.flickSeen)
        .every(k => /^[0-9a-f]{12}$/.test(k)), JSON.stringify(Object.keys(e.gameState.flickSeen)));
}

console.log('\n=== two devices do not pay for the same hour twice ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    await e.creditFlickProgress(watched(60), NOW);
    const claimed = { ...e.gameState.flickSeen };
    const paid = e.gameState.studyMinutes['flick:dev_test'];

    // The second device syncs, receives the first's marks, then reads the same
    // page. The rise has already been claimed, so it sees nothing.
    reset();
    e.gameState.flickCheckedAt = NOW - 30 * MIN;
    e.mergeCloudState({ flickSeen: claimed, flickCheckedAt: NOW });
    const second = await e.creditFlickProgress(watched(60), NOW + 30 * MIN);
    check('the second device sees no rise to credit', second.credited === 0, String(second.credited));
    check('the first device\'s credit stands', paid > 0);

    check('marks merge upward only',
        e.mergeCloudState({ flickSeen: { [Object.keys(claimed)[0]]: 1 } }) !== undefined
        && e.gameState.flickSeen[Object.keys(claimed)[0]] === claimed[Object.keys(claimed)[0]]);
}

console.log('\n=== a poisoned save is repaired, not trusted ===');
{
    // Too high silently stops crediting a real lecture forever; too low pays
    // for it twice; a mark from the future suppresses everything until the
    // clock catches up.
    const s = e.normalizeState({ flickSeen: { good: 100, bad: -5, worse: 'lots' },
                                 flickCheckedAt: Date.now() + 9e9 });
    check('negative marks are dropped', !('bad' in s.flickSeen));
    check('non-numeric marks are dropped', !('worse' in s.flickSeen));
    check('sound marks survive', s.flickSeen.good === 100);
    check('a mark from the future is reset', s.flickCheckedAt === 0);

    const s2 = e.normalizeState({ flickSeen: 'nope' });
    check('a corrupt container becomes an empty one', JSON.stringify(s2.flickSeen) === '{}');
}

console.log('\n=== a real course, where most lectures are already finished ===');
{
    // Past 95% Flick prints a checkmark instead of a number, so a finished
    // lecture can only be read as "all of it" while the header still counts the
    // true position. A flat tolerance rejected that -- which meant rejecting
    // almost every real course, and the feature would have looked perfectly
    // healthy while silently never crediting anything.
    const done = n => Array.from({ length: n }, (_, i) =>
        row({ title: 'Lecture ' + i, durationMin: 60, check: true }));
    const doc = page([...done(20),
        row({ title: 'Current', durationMin: 60, leftMin: 30, barValue: 0.5 })],
        '1.1 hours left (94.8%)');
    const reading = FP.readCourse(doc);
    check('twenty finished lectures still agree with the header',
        FP.agreesWithHeader(reading) === true);

    // But the check must still catch a parse that has actually gone wrong.
    const broken = FP.readCourse(page([...done(20),
        row({ title: 'Current', durationMin: 60, leftMin: 30 })], '18 hours left (11%)'));
    check('a header that genuinely disagrees is still rejected',
        FP.agreesWithHeader(broken) === false);

    check('a row records how it was read', reading.lectures[0].from === 'complete'
        && reading.lectures[20].from === 'bar',
        reading.lectures[0].from + '/' + reading.lectures[20].from);
}

console.log('\n=== closing the browser must not re-pay for the same hour ===');
{
    // flickCheckedAt survives a restart, so the local subtraction has to as
    // well. Held in memory it reset to zero while the clock it is subtracted
    // from kept running, and the next reading paid a second time for an hour
    // that had already been counted.
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    e.creditStudyMinutes(e.studySource(), 60);      // an hour watched HERE
    check('the local tally is on the save, not in memory',
        e.gameState.flickLocalMinutes === 60, String(e.gameState.flickLocalMinutes));

    // Reload: gameState comes back from storage, instance fields do not.
    const persisted = e.normalizeState(JSON.parse(JSON.stringify(e.gameState)));
    check('and it survives normalizeState', persisted.flickLocalMinutes === 60);

    e.gameState = persisted;
    const r = await e.creditFlickProgress(watched(60), NOW);
    check('so the hour is not paid for a second time after a restart',
        r.credited === 0, String(r.credited));
}

console.log('\n=== local watching is subtracted before the skew margin ===');
{
    // Applied to the whole window instead, the 5% clock-skew margin handed back
    // 5% of every locally-watched hour as unearned offline credit.
    reset();
    await e.creditFlickProgress(watched(0), NOW - 60 * MIN);
    e.creditStudyMinutes(e.studySource(), 60);
    const r = await e.creditFlickProgress(watched(60), NOW);
    check('an hour watched here yields exactly nothing extra',
        r.credited === 0, String(r.credited));
}

console.log('\n=== two lectures that hash alike cannot invent a rise ===');
{
    reset();
    // Same title, same length, twice in one course.
    const twice = (aLeft, bLeft) => FP.readCourse(page([
        row({ title: 'Practical Session', durationMin: 60, leftMin: aLeft }),
        row({ title: 'Practical Session', durationMin: 60, leftMin: bLeft }),
    ], `${((aLeft + bLeft) / 60).toFixed(1)} hours left (${(((120 - aLeft - bLeft) / 120) * 100).toFixed(1)}%)`));

    await e.creditFlickProgress(twice(60, 30), NOW - 60 * MIN);
    check('one mark is kept for the pair', Object.keys(e.gameState.flickSeen).length === 1);
    const r = await e.creditFlickProgress(twice(60, 30), NOW);
    check('re-reading the same page invents nothing', r.credited === 0, String(r.credited));
}

console.log('\n=== the marks cannot grow without limit ===');
{
    reset();
    const marks = {};
    for (let i = 0; i < cfg.FLICK_MAX_MARKS + 50; i++) marks['k' + i] = i;
    e.gameState.flickSeen = marks;
    e.pruneFlickSeen();
    const kept = Object.keys(e.gameState.flickSeen);
    check('pruned to the cap', kept.length === cfg.FLICK_MAX_MARKS, String(kept.length));
    check('the marks with the most progress behind them are the ones kept',
        e.gameState.flickSeen['k' + (cfg.FLICK_MAX_MARKS + 49)] !== undefined
        && e.gameState.flickSeen.k0 === undefined);
    check('under the cap it does nothing', (() => {
        e.gameState.flickSeen = { a: 1, b: 2 };
        e.pruneFlickSeen();
        return Object.keys(e.gameState.flickSeen).length === 2;
    })());
}

console.log('\n=== the local tally never leaves the device ===');
{
    reset();
    e.creditStudyMinutes(e.studySource(), 42);
    const flat = JSON.stringify(e.buildCloudPayload());
    check('flickLocalMinutes is not synced', !flat.includes('flickLocalMinutes'));
    check('a negative tally is repaired',
        e.normalizeState({ flickLocalMinutes: -5 }).flickLocalMinutes === 0);
}

console.log('\n=== coming back is told as a summary, not a receipt ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 120 * MIN);
    const before = e.getActivePokemon().level;
    const r = await e.creditFlickProgress(watched(115), NOW);

    check('it reports how long the device was away',
        near(r.awayMinutes, 120, 1), String(r.awayMinutes));
    check('it names the partner that gained the EXP',
        r.partner && typeof r.partner.name === 'string' && r.partner.name.length > 0,
        JSON.stringify(r.partner));
    check('and reports the levels it actually gained',
        r.partner.levelsGained === e.getActivePokemon().level - before,
        r.partner.levelsGained + ' vs ' + (e.getActivePokemon().level - before));
    check('the level reported is the level after the award',
        r.partner.level === e.getActivePokemon().level);
    check('every figure comes from memory — no extra document is written',
        r.reason === 'credited');

    // A phone playing in the next room is not a return, and must not be
    // announced as one.
    const trickle = await e.creditFlickProgress(watched(118), NOW + 3 * MIN);
    check('a three-minute gap is not a homecoming',
        trickle.credited > 0 && trickle.awayMinutes < 20, String(trickle.awayMinutes));
}

console.log('\n=== the notice itself ===');
{
    const { parseHTML } = require('linkedom');
    const dom = parseHTML('<div class="flickemon-widgets-wrapper"></div>');
    const prevDoc = global.document;
    global.document = dom.document;
    // The UI module needs a document at load time.
    const ui = Object.create(global.window.FlickemonUI
        ? global.window.FlickemonUI.prototype : {});
    ui.config = cfg;

    // This suite runs setTimeout callbacks synchronously, which would fire the
    // notice's own dismissal the instant it is added. Hold them.
    const render = res => {
        dom.document.querySelector('.flickemon-widgets-wrapper').innerHTML = '';
        const realTimeout = global.setTimeout;
        global.setTimeout = () => 0;
        try { global.window.FlickemonUI.prototype.showFlickCredit.call(ui, res); }
        finally { global.setTimeout = realTimeout; }
        return dom.document.querySelector('.flick-credit');
    };

    const back = render({ credited: 36, rawMinutes: 120, exp: 900, awayMinutes: 130,
        partner: { name: 'Ivysaur', level: 21, levelsGained: 3, evolvedInto: null } });
    check('a return says how long was studied, in hours',
        back && /2h 0m studied on Flick/.test(back.innerHTML), back && back.textContent.trim());
    check('and names the partner and its new level',
        /Ivysaur/.test(back.innerHTML) && /Lv\.21/.test(back.innerHTML));
    check('and still states the rate, as a footnote rather than the headline',
        /30%/.test(back.innerHTML));
    check('it is marked as a return', back.className.includes('is-return'));

    const drip = render({ credited: 1, rawMinutes: 3, exp: 20, awayMinutes: 3, partner: null });
    check('a trickle stays a one-liner', !drip.className.includes('is-return')
        && /counted from Flick/.test(drip.innerHTML));

    const evo = render({ credited: 36, rawMinutes: 120, exp: 900, awayMinutes: 130,
        partner: { name: 'Venusaur', level: 33, levelsGained: 2, evolvedInto: 'Venusaur' } });
    check('an evolution leads the summary', /Venusaur<\/b> evolved/.test(evo.innerHTML));

    // A player-drawn Pokemon's name is whatever its author typed.
    const nasty = render({ credited: 36, rawMinutes: 120, exp: 900, awayMinutes: 130,
        partner: { name: '<img src=x onerror=alert(1)>', level: 9, levelsGained: 1,
                   evolvedInto: null } });
    check('a custom name cannot inject markup',
        !/<img/.test(nasty.innerHTML) && /&lt;img/.test(nasty.innerHTML));

    check('nothing is drawn for a zero credit',
        render({ credited: 0, rawMinutes: 0, exp: 0 }) === null);
    global.document = prevDoc;
}

console.log('\n=== the day has a ceiling, so patience is not a strategy ===');
{
    // The wall-clock bound already makes one drag of the seekbar nearly
    // worthless. It does nothing against someone dragging every few minutes all
    // day, which is what this stops.
    reset();
    const CAP = cfg.FLICK_DAILY_CAP_MINUTES;
    check('four hours is the advertised ceiling', CAP === 240, String(CAP));

    // Cheating must be strictly worse than studying: the very best a full day
    // of dragging can yield has to sit below an honest session.
    check('a maxed-out day of dragging is worth less than five hours of studying',
        CAP * cfg.FLICK_CREDIT_RATE < 5 * 60,
        `${CAP * cfg.FLICK_CREDIT_RATE} min vs 300 min`);

    await e.creditFlickProgress(watched(0), NOW - 600 * MIN);
    check('nothing spent yet today', e.flickMinutesToday() === 0);

    // Ten hours of "progress" with ten hours of clock behind it, so only the
    // daily cap can stop it.
    const long = min => FP.readCourse(page(
        [row({ title: 'Marathon', durationMin: 600, leftMin: 600 - min })],
        `${((600 - min) / 60).toFixed(1)} hours left (${((min / 600) * 100).toFixed(1)}%)`));
    await e.creditFlickProgress(long(0), NOW - 600 * MIN);
    const r = await e.creditFlickProgress(long(600), NOW);

    check('the day pays out at most the cap', near(r.rawMinutes, CAP, 1), String(r.rawMinutes));
    check('which is the cap times the rate', near(r.credited, CAP * cfg.FLICK_CREDIT_RATE, 1),
        String(r.credited));
    check('and the allowance is now spent', e.flickMinutesLeftToday() === 0,
        String(e.flickMinutesLeftToday()));

    const after = await e.creditFlickProgress(long(600), NOW + 60 * MIN);
    check('further watching the same day earns nothing',
        after.credited === 0 && after.reason === 'daily-cap', after.reason);
    check('and the notice can say what the limit was', after.capMinutes === CAP);

    // A cap that banks its excess for tomorrow is not a cap.
    check('minutes past the ceiling are gone, not carried',
        e.flickMinutesToday() >= CAP, String(e.flickMinutesToday()));
}

console.log('\n=== the allowance is shared across devices ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 300 * MIN);
    await e.creditFlickProgress(watched(120), NOW);
    const spent = e.flickMinutesToday();
    check('the first device spent part of the allowance', spent >= 119, String(spent));

    // Without this the cap would be per device rather than per student, and two
    // laptops would hand out two allowances.
    const cloud = JSON.parse(JSON.stringify(e.gameState.dailyProgress));
    e.gameState.dailyProgress = {};
    e.deviceId = 'dev_other';
    e.mergeCloudState({ dailyProgress: cloud });
    check('a second device sees the minutes already spent',
        e.flickMinutesToday() >= 119, String(e.flickMinutesToday()));
    e.deviceId = 'dev_test';

    // Three separate places rebuild a ledger row field by field — the merge,
    // the totals and the prune — and each drops anything it does not name. The
    // prune was the one that got missed, and the symptom was silent: every sync
    // reset the day's allowance, so the cap could be cleared on demand.
    const row = { '2026-09-04': { dev: { exp: 5, levels: 1, caught: 2, flickMin: 90 } } };
    check('the prune keeps the minutes it does not understand',
        e.pruneDailyProgress(row)['2026-09-04'].dev.flickMin === 90);
    check('the merge keeps them too',
        e.mergeDailyProgress({}, row)['2026-09-04'].dev.flickMin === 90);
    check('and the totals sum them',
        e.dailyTotals(row)['2026-09-04'].flickMin === 90);
}

console.log('\n=== the allowance is nobody else\'s business ===');
{
    reset();
    await e.creditFlickProgress(watched(0), NOW - 300 * MIN);
    await e.creditFlickProgress(watched(120), NOW);
    e.friendCache = [{ uid: 'friend1', accepted: true, blockedByThem: false }];
    const payload = JSON.stringify(e.buildFriendPayload());
    check('the friend feed carries no off-extension minutes',
        !payload.includes('flickMin'), payload.slice(0, 160));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
})();
