/**
 * "Studied on another device", end to end.
 * ────────────────────────────────────────
 * Runs the real engine and content script against a model of FlickPlayer and
 * Flick's backend (see flick-sim.js), on a simulated clock, and asks the one
 * question that matters: is anything studied on THIS computer ever paid back
 * as studying done somewhere else -- and is a phone session paid exactly once?
 *
 * Each block below is a way that went wrong in a real browser:
 *
 *   - A second Flick tab on the same course read the first tab's progress on
 *     its own page, with no record of the first tab's playback, and paid it.
 *     A skip ahead made it worse: one jump was worth the whole allowance.
 *   - Every Flick tab open paid the same phone session again.
 *   - A skip made while a lecture was still loading was taken for where Flick
 *     had left off, so everything skipped was paid.
 */
const { World } = require('./flick-sim.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

/** Mulberry32, so a fuzz failure is the same failure every run. */
function rng(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/** A laptop with the extension, a game started, and Flick's clock running. */
async function start({ tabs = 1, phone = false } = {}) {
    const w = new World();
    const laptop = w.device('laptop');
    const first = await laptop.openTab();
    await first.engine.chooseStarter(1);
    await w.advance(2000);
    for (let i = 1; i < tabs; i++) await laptop.openTab();
    // The first reading only starts the clock.
    await w.minutes(2);
    const handset = phone ? await w.device('phone', { extension: false }).openTab() : null;
    return { w, laptop, tabs: laptop.tabs.slice(), phone: handset };
}

const paid = laptop => Number(laptop.totalPaid().toFixed(2));
const errors = w => w.clock.errors.concat(w.errors).map(String);

(async () => {

console.log('\n=== studying here, skips and all, is never paid as another device ===');
{
    const { w, laptop, tabs: [tab] } = await start();
    tab.open(101); await w.advance(1000); tab.play();
    await w.minutes(5);
    for (let i = 0; i < 6; i++) { tab.skip(10); await w.advance(1500); }   // arrow keys
    await w.minutes(2);
    tab.drag(1500); await w.minutes(3);                                     // the scrubber
    tab.rate(2); await w.minutes(4);
    tab.pause(); await w.minutes(10);                                       // a break
    tab.play(); await w.minutes(2);
    tab.drag(2950); await w.minutes(3);                                     // to the end
    await w.minutes(30);
    check('one tab: play, skip, drag, 2x, a break, drag to the end -- nothing paid',
        paid(laptop) === 0, String(paid(laptop)));
    check('and Flick really did record the lecture as finished',
        w.server.records[101] && w.server.records[101].end_time >= 3000,
        JSON.stringify(w.server.records[101]));
    check('without a single error', errors(w).length === 0, errors(w).join(' | '));
}
{
    // video.js answers the bar once the metadata is in, which can be seconds
    // before canplay on a slow connection.
    const { w, laptop, tabs: [tab] } = await start();
    tab.open(101); await w.advance(200);
    tab.drag(1500); await w.advance(500);
    tab.play(); await w.minutes(3); tab.pause();
    await w.minutes(40);
    check('a skip ahead made while the lecture is still loading is not paid',
        paid(laptop) === 0, String(paid(laptop)));
}
{
    const { w, laptop, tabs: [tab] } = await start();
    tab.open(102); await w.advance(1000); tab.play(); await w.minutes(5); tab.pause();
    await w.minutes(2);
    tab.open(101); await w.advance(1000);
    tab.open(102); await w.advance(200);                                    // resumes at 5:00
    for (let i = 0; i < 30; i++) tab.skip(10);                              // held arrow key
    await w.advance(500); tab.play(); await w.minutes(3); tab.pause();
    await w.minutes(40);
    check('nor arrow keys held down while a resumed lecture loads',
        paid(laptop) === 0, String(paid(laptop)));
}

console.log('\n=== a second Flick tab does not pay this one\'s studying ===');
{
    const { w, laptop, tabs: [a] } = await start({ tabs: 2 });
    a.open(101); await w.advance(1000); a.play(); await w.minutes(20); a.pause();
    await w.minutes(30);
    check('twenty minutes here, with the course open in another tab: nothing paid',
        paid(laptop) === 0, JSON.stringify(laptop.paid));
}
{
    const { w, laptop, tabs: [a] } = await start();
    a.open(101); await w.advance(1000); a.play(); await w.minutes(10);
    await laptop.openTab(); await w.minutes(10); a.pause();
    await w.minutes(30);
    check('nor when the second tab is opened mid-lecture', paid(laptop) === 0, String(paid(laptop)));
}
{
    // What a skip turned into: one jump, worth the whole allowance, every time.
    const { w, laptop, tabs: [a] } = await start({ tabs: 2 });
    a.open(102); await w.advance(1000); a.play(); await w.minutes(3);
    a.drag(1800); await w.minutes(3);
    a.skip(60); await w.minutes(1); a.pause();
    await w.minutes(30);
    check('nor a skip ahead with the course open in another tab', paid(laptop) === 0, String(paid(laptop)));
}
{
    const { w, laptop, tabs: [a, b] } = await start({ tabs: 2 });
    a.open(101); await w.advance(1000); a.play(); await w.minutes(10); a.pause();
    await w.minutes(2);
    b.open(101); await w.advance(1000); b.play(); await w.minutes(10); b.pause();
    await w.minutes(30);
    check('nor picking the lecture up again in the other tab', paid(laptop) === 0, String(paid(laptop)));
}
{
    const { w, laptop, tabs: [a] } = await start({ tabs: 3 });
    a.open(101); await w.advance(1000); a.play(); await w.minutes(10);
    a.close();
    const b = await laptop.openTab(); await w.minutes(1);
    b.open(101); await w.advance(1000); b.play(); await w.minutes(10); b.pause();
    await w.minutes(30);
    check('nor closing a tab mid-lecture and carrying on in a new one',
        paid(laptop) === 0, String(paid(laptop)));
}

console.log('\n=== a phone session is paid once, however many tabs are open ===');
{
    const totals = [];
    for (const tabs of [1, 2, 3]) {
        const { w, laptop, phone } = await start({ tabs, phone: true });
        phone.open(103); await w.advance(1000); phone.play(); await w.minutes(20); phone.pause();
        await w.minutes(30);
        totals.push(paid(laptop));
    }
    check('twenty minutes on a phone is paid', totals[0] >= 18 && totals[0] <= 20, JSON.stringify(totals));
    check('and paid the same with two or three Flick tabs open, not two or three times',
        totals[1] === totals[0] && totals[2] === totals[0], JSON.stringify(totals));
}
{
    // The phone moves on in a lecture this laptop has also played. Only the
    // part past where the laptop stopped is the phone's.
    const { w, laptop, tabs: [a], phone } = await start({ tabs: 2, phone: true });
    a.open(101); await w.advance(1000); a.play(); await w.minutes(10); a.pause();
    await w.minutes(3);
    phone.open(101); await w.advance(1000); phone.play(); await w.minutes(15); phone.pause();
    await w.minutes(40);
    const got = paid(laptop);
    check('carrying a lecture on from here on a phone pays the phone\'s part, once',
        got >= 13 && got <= 15.1, String(got));
}

console.log('\n=== seeded fuzz: random studying across tabs pays nothing ===');
{
    // Opening, playing, pausing, skipping and dragging -- some of it while a
    // lecture is still loading -- speed changes, and tabs opened, closed and
    // reloaded, in every order. None of it is another device.
    let worst = null;
    for (const seed of [1056, 1084, 5009, 5114]) {
        const r = rng(seed);
        const pick = list => list[Math.floor(r() * list.length)];
        const { w, laptop } = await start();
        for (let i = 0; i < 70; i++) {
            const tabs = laptop.tabs;
            let tab = pick(tabs);
            const lecture = pick(w.course.lectures).id;
            const roll = r();
            if (roll < 0.06 && tabs.length < 3) tab = await laptop.openTab({ renderFirst: r() < 0.5 });
            else if (roll < 0.09 && tabs.length > 1) tab.close();
            else if (roll < 0.11) { tab.close(); await laptop.openTab({ renderFirst: r() < 0.5 }); }
            else if (roll < 0.21) { tab.open(lecture); await w.advance(400); tab.play(); }
            else if (roll < 0.25) {
                tab.open(lecture); await w.advance(200);
                if (r() < 0.5) tab.drag(r() * 2000); else for (let j = 0; j < 12; j++) tab.skip(10);
                await w.advance(400); tab.play();
            }
            else if (roll < 0.40) tab.play();
            else if (roll < 0.48) tab.pause();
            else if (roll < 0.58) tab.skip(pick([10, 10, 30, -10, 120, 600]));
            else if (roll < 0.66) tab.drag(r() * (tab.video.duration || 1000));
            else if (roll < 0.72) tab.rate(pick([1, 1.5, 2, 3]));
            await w.advance(Math.floor(r() * 90000) + 1000);
        }
        await w.minutes(20);
        if (paid(laptop) !== 0 || errors(w).length) {
            worst = { seed, paid: paid(laptop), errors: errors(w).slice(0, 2) };
            break;
        }
    }
    check('four seeded runs of seventy actions each pay nothing', worst === null, JSON.stringify(worst));
}

console.log('\n=== seeded fuzz: never more than the phone actually did ===');
{
    let worst = null;
    for (const seed of [300, 322, 377]) {
        const r = rng(seed);
        const pick = list => list[Math.floor(r() * list.length)];
        const { w, laptop, phone } = await start({ phone: true });
        for (let i = 0; i < 60; i++) {
            const tabs = laptop.tabs;
            let tab = pick(tabs);
            const lecture = pick(w.course.lectures).id;
            const roll = r();
            if (roll < 0.05 && tabs.length < 3) tab = await laptop.openTab();
            else if (roll < 0.07 && tabs.length > 1) tab.close();
            else if (roll < 0.16) { tab.open(lecture); await w.advance(600); tab.play(); }
            else if (roll < 0.26) tab.play();
            else if (roll < 0.32) tab.pause();
            else if (roll < 0.40) tab.skip(pick([10, 30, 120, 600, -30]));
            else if (roll < 0.45) tab.drag(r() * (tab.video.duration || 1000));
            else if (roll < 0.58) { phone.open(lecture); await w.advance(500); phone.play(); }
            else if (roll < 0.66) phone.play();
            else if (roll < 0.72) phone.pause();
            else if (roll < 0.76) phone.skip(pick([10, 60, 600]));
            await w.advance(Math.floor(r() * 90000) + 1000);
        }
        phone.pause();
        for (const t of laptop.tabs) t.pause();
        await w.minutes(60);
        // What the phone did to Flick's record: each of its posts, above the
        // highest position Flick had held for that lecture before it.
        const highest = {};
        let phoneMin = 0;
        for (const p of w.server.posts) {
            const h = highest[p.lectureId] || 0;
            if (p.from === phone.id && p.position > h) phoneMin += (p.position - h) / 60;
            highest[p.lectureId] = Math.max(h, p.position);
        }
        if (paid(laptop) > phoneMin + 1 || errors(w).length) {
            worst = { seed, paid: paid(laptop), phone: phoneMin, errors: errors(w).slice(0, 2) };
            break;
        }
    }
    check('three seeded runs with a phone pay no more than the phone moved Flick',
        worst === null, JSON.stringify(worst));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch(err => { console.error(err); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
