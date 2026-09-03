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
    e.localMinutesSinceHarvest = 0;
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

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
})();
