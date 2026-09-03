const ROOT = require('path').join(__dirname, '..') + '/';
// Friends, the daily ledger, and the global board.
//
// A disproportionate number of these are PRIVACY assertions rather than feature
// ones. That is deliberate: a promise that a field is not shared is only worth
// what a test says it is worth, and "we don't render it" is not the promise —
// the promise is that it never leaves the device.
const fs = require('fs');

global.window = { addEventListener() {} };
global.document = { addEventListener() {}, visibilityState: 'visible' };
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-custom.js');
require(ROOT + 'content/flickemon-battle.js');
require(ROOT + 'content/flickemon-engine.js');

const cfg = global.window.FlickemonConfig;
const e = global.window.flickemonEngine;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const raw = (rel) => fs.readFileSync(ROOT + rel, 'utf8');
// Comments stripped, or a rule explained in prose satisfies the check that it
// exists. This repo has been caught by that four times.
const code = (rel) => raw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** A fresh engine with a known device, one Pokémon out, and no history. */
function reset() {
    e.gameState = e.createEmptyState();
    e.deviceId = 'laptop';
    // A partner, because half the payload is about which Pokémon is out and an
    // engine with an empty party would make those assertions vacuously pass.
    e.gameState.party = [{
        instanceId: 'p1', speciesId: 25, level: 30,
        totalExp: cfg.expForLevel(30), shiny: false,
        megaStones: [], megaSeen: [], megaActive: null, megaActiveAt: 0,
    }];
    e.gameState.activeInstanceId = 'p1';
    e.friendCache = [];
    e.lastFeedFingerprint = null;
    e.lastFeedPublishAt = 0;
    e.lastStudyTickAt = 0;
    // Nothing in these tests should reach the network.
    e.sendToWorker = async (msg) => { e.sent = (e.sent || []).concat([msg]); return { ok: true }; };
    e.saveGameState = async () => {};
    e.emitState = () => {};
    e.sent = [];
}

console.log('\n=== usernames ===');
{
    const good = ['nan', 'nan_studies', 'beam.k', 'a1b2c3'];
    for (const n of good) check(`"${n}" is allowed`, cfg.validateUsername(n).ok, JSON.stringify(cfg.validateUsername(n)));

    const bad = [
        ['', 'empty'], ['ab', 'too short'], ['x'.repeat(25), 'too long'],
        ['nan studies', 'a space'], ['Nan!', 'punctuation'],
        ['_nan', 'leading underscore'], ['admin', 'reserved'], ['flickemon', 'reserved'],
    ];
    for (const [n, why] of bad) {
        const r = cfg.validateUsername(n);
        check(`${why} is refused`, r.ok === false, JSON.stringify(r));
        check(`  ...and says why`, typeof r.reason === 'string' && r.reason.length > 5, r.reason);
    }

    // Case and spacing must never be what makes two names different, or "Nan"
    // and "nan" become two people.
    check('case is not identity', cfg.normaliseUsername('  NaN_Studies ') === 'nan_studies');
    check('and validation normalises too', cfg.validateUsername(' NAN ').name === 'nan');
}

console.log('\n=== the day, on Bangkok time ===');
{
    const at = (iso) => cfg.dayKeyFor(Date.parse(iso));
    check('23:59 ICT is still today', at('2026-09-03T16:59:00Z') === '2026-09-03');
    check('00:00 ICT is tomorrow', at('2026-09-03T17:00:00Z') === '2026-09-04');

    // The reason it is fixed rather than device-local: two students in
    // different timezones must be compared over the same day, and a clock a
    // student controls must not be able to mint streak days.
    const before = at('2026-09-03T16:00:00Z'), after = at('2026-09-03T18:00:00Z');
    check('a day boundary exists at all', before !== after);
    check('it does not read the device timezone',
        !/getTimezoneOffset|toLocaleDateString/.test(code('content/flickemon-config.js')
            .slice(code('content/flickemon-config.js').indexOf('function dayKeyFor'),
                   code('content/flickemon-config.js').indexOf('function dayKeyFor') + 400)));

    check('back one day', cfg.dayKeyBefore('2026-09-04') === '2026-09-03');
    check('across a month', cfg.dayKeyBefore('2026-03-01') === '2026-02-28');
    check('across a year', cfg.dayKeyBefore('2026-01-01') === '2025-12-31');
    check('several at once', cfg.dayKeyBefore('2026-09-04', 4) === '2026-08-31');
}

console.log('\n=== the daily ledger ===');
{
    reset();
    e.creditDailyProgress({ exp: 500, levels: 1 });
    e.creditDailyProgress({ exp: 300 });
    e.creditDailyProgress({ caught: 2 });
    const t = e.todayProgress();
    check('credits accumulate', t.exp === 800 && t.levels === 1 && t.caught === 2, JSON.stringify(t));

    // THE trap this whole shape exists to avoid. studyMinutes carries a comment
    // about losing 30 minutes across two devices to a Math.max on the totals;
    // this is the same mistake, one field over.
    const phone = { [e.today()]: { phone: { exp: 900, levels: 2, caught: 1 } } };
    e.gameState.dailyProgress = e.mergeDailyProgress(e.gameState.dailyProgress, phone);
    const merged = e.todayProgress();
    check('two devices ADD UP rather than competing',
        merged.exp === 1700 && merged.levels === 3 && merged.caught === 3, JSON.stringify(merged));

    // A merge is not an event; it can happen on every sync.
    e.gameState.dailyProgress = e.mergeDailyProgress(e.gameState.dailyProgress, phone);
    check('replaying a merge changes nothing',
        JSON.stringify(e.todayProgress()) === JSON.stringify(merged));

    // A source only ever counts up, so an older copy of it must not win.
    const stale = { [e.today()]: { phone: { exp: 10, levels: 0, caught: 0 } } };
    e.gameState.dailyProgress = e.mergeDailyProgress(e.gameState.dailyProgress, stale);
    check('a stale copy of a source cannot subtract', e.todayProgress().exp === 1700);

    // Junk from a hand-edited save must not become negative progress.
    const junk = { 'not-a-day': { x: { exp: 5 } },
                   [e.today()]: { y: { exp: -50, levels: 'x', caught: null } } };
    const clean = e.pruneDailyProgress(junk);
    check('a bad day key is dropped', !('not-a-day' in clean));
    check('negatives and non-numbers become zero',
        clean[e.today()].y.exp === 0 && clean[e.today()].y.levels === 0, JSON.stringify(clean));

    const many = {};
    for (let i = 0; i < 40; i++) many[cfg.dayKeyBefore(e.today(), i)] = { d: { exp: 1 } };
    const pruned = e.pruneDailyProgress(many);
    check('history is bounded', Object.keys(pruned).length === cfg.DAILY_HISTORY_DAYS,
        String(Object.keys(pruned).length));
    check('and it keeps the RECENT days', pruned[e.today()] !== undefined);
}

console.log('\n=== streaks ===');
{
    const day = (n) => cfg.dayKeyBefore(cfg.dayKeyFor(), n);
    const totals = (...offsets) => {
        const o = {};
        for (const n of offsets) o[day(n)] = { exp: 100 };
        return o;
    };
    check('three in a row', cfg.streakFrom(totals(0, 1, 2)) === 3);
    check('a gap ends it', cfg.streakFrom(totals(0, 1, 3)) === 2);
    check('no progress at all is zero', cfg.streakFrom({}) === 0);

    // The kind one: a streak must survive the morning before you have studied,
    // or it would break at midnight every single night.
    check('yesterday alone still counts today', cfg.streakFrom(totals(1, 2)) === 2);
    check('but two days off is over', cfg.streakFrom(totals(2, 3)) === 0);
}

console.log('\n=== what actually gets published ===');
{
    reset();
    e.gameState.username = 'nan';
    e.creditDailyProgress({ exp: 1234, levels: 2 });
    e.lastStudyTickAt = Date.now();

    const all = e.buildFriendPayload();
    check('everything is shared by default',
        all.activeAt !== undefined && all.mon !== undefined && all.today !== undefined,
        JSON.stringify(Object.keys(all)));

    // WHEN rather than whether, so a feed nobody has republished ages into
    // "idle" by itself. Publishing a boolean would need a write to say "I
    // stopped" -- the one transition nobody is around to trigger.
    check('activity is a timestamp, not a boolean', typeof all.activeAt === 'number');
    check('and it is bucketed, so time passing alone is not a change',
        all.activeAt % 300000 === 0, String(all.activeAt));
    check('no boolean is published alongside it', all.active === undefined);

    // THE privacy claim. Not "we hide it" -- it is not in the object at all,
    // so there is nothing for a modified client to reveal and nothing for a
    // wrong security rule to expose.
    for (const field of cfg.FRIEND_FIELDS) {
        reset();
        e.gameState.username = 'nan';
        e.creditDailyProgress({ exp: 1234 });
        e.lastStudyTickAt = Date.now();
        e.gameState.friendPrivacy = { ...cfg.defaultFriendPrivacy(), [field.key]: false };

        const payload = e.buildFriendPayload();
        check(`"${field.label}" off means ABSENT, not blank`,
            payload[field.key] === undefined, JSON.stringify(payload[field.key]));
        // And nothing else quietly carries it either.
        if (field.key === 'today') {
            // Field by field, not a substring sweep of the JSON: an `activeAt`
            // timestamp happens to contain the digits "1200", which made the
            // first version of this pass and fail for the wrong reasons.
            check('  ...and nothing else carries the figure either',
                payload.today === undefined && payload.streak === undefined
                && payload.dayKey === undefined
                && !Object.values(payload).some(v => v === 1234 || v === 1200),
                JSON.stringify(payload));
        }
    }

    // Time is never published, in any form. The whole point of measuring
    // progress instead of hours.
    reset();
    e.creditStudyMinutes('laptop', 87);
    e.creditDailyProgress({ exp: 500 });
    const p = e.buildFriendPayload();
    const keys = JSON.stringify(Object.keys(p)) + JSON.stringify(Object.keys(p.today || {}));
    check('no field in the payload is a duration',
        !/minute|hour|second|watched|time/i.test(keys), keys);
    check('and the figure itself is nowhere in it',
        !Object.values(p).some(v => v === 87)
        && !Object.values(p.today || {}).some(v => v === 87),
        JSON.stringify(p));

    // Quantised, or the figure changes on every video tick and every tick
    // becomes a Firestore write.
    reset();
    e.creditDailyProgress({ exp: 1249 });
    check("today's EXP is rounded down to a step",
        e.buildFriendPayload().today.exp === 1200, String(e.buildFriendPayload().today.exp));
}

console.log('\n=== the audience is the enforcement ===');
{
    reset();
    e.friendCache = [
        { uid: 'a', accepted: true }, { uid: 'b', accepted: true },
        { uid: 'c', accepted: false },
    ];
    check('accepted friends are in it', e.friendAudience().sort().join() === 'a,b');
    check('a pending request is NOT', !e.friendAudience().includes('c'));

    e.gameState.blockedUids = ['b'];
    check('a blocked friend is removed from it', e.friendAudience().join() === 'a',
        'absence from the audience IS the block -- the server refuses them');

    // The cap is a quota control, so it has to hold even if the list is longer.
    e.gameState.blockedUids = [];
    e.friendCache = Array.from({ length: 60 }, (_, i) => ({ uid: 'u' + i, accepted: true }));
    check('the audience is capped', e.friendAudience().length === cfg.FRIEND_MAX,
        String(e.friendAudience().length));
}

console.log('\n=== publishing is rate-limited, because writes are metered ===');
{
    reset();
    e.friendCache = [{ uid: 'a', accepted: true }];
    e.creditDailyProgress({ exp: 500 });

    const first = e.publishFriendFeed();
    return Promise.resolve(first).then(async (r1) => {
        check('the first publish goes out', r1.ok && !r1.skipped, JSON.stringify(r1));

        const r2 = await e.publishFriendFeed();
        check('an unchanged payload writes nothing', r2.skipped === 'unchanged', JSON.stringify(r2));

        // Changed, but too soon: EXP creeping up must not buy a write a second.
        e.creditDailyProgress({ exp: 5000 });
        const r3 = await e.publishFriendFeed();
        check('a changed payload still waits its turn', r3.skipped === 'too-soon', JSON.stringify(r3));

        // Except when privacy changed, which must take effect NOW.
        const r4 = await e.publishFriendFeed({ force: true });
        check('turning sharing off is never delayed', r4.ok && !r4.skipped, JSON.stringify(r4));

        // Nobody to read it is a write worth not making.
        reset();
        e.friendCache = [];
        const r5 = await e.publishFriendFeed();
        check('no audience and no board means no write', r5.skipped === 'no-audience', JSON.stringify(r5));

        await board();
    });
}

async function board() {
    console.log('\n=== the global board ===');
    {
        reset();
        check('nobody is on it to begin with', e.isOnLeaderboard() === false);

        // The label is the promise: a full address must never reach a document
        // the whole cohort can read.
        const label = cfg.leaderboardLabel('', 'punnawit.wsr@docchula.com');
        check('no username publishes three letters', label === 'pun…', label);
        check('and never the address', !label.includes('@') && !label.includes('docchula'));
        check('a username is published as itself',
            cfg.leaderboardLabel('nan_studies', 'punnawit.wsr@docchula.com') === 'nan_studies');

        // Truncation happens before the write, not at display -- so the doc
        // itself is clean even if a renderer were wrong later.
        const t = code('background/friends.js');
        check('the transport truncates again on the way out',
            /split\('@'\)\[0\]/.test(t), 'belt and braces on the one field that matters');

        await e.setOnLeaderboard(true, 'punnawit.wsr@docchula.com');
        const join = e.sent.find(m => m.type === 'FRIEND_BOARD_PUBLISH');
        check('joining publishes a row', join && join.payload.joined === true);
        check('the row carries no email', !JSON.stringify(join.payload).includes('@'),
            JSON.stringify(join.payload));
        check('and none of the friend-gated detail',
            join.payload.mon === undefined && join.payload.active === undefined,
            'the board is a score, not a feed');

        e.sent = [];
        await e.setOnLeaderboard(false, 'punnawit.wsr@docchula.com');
        const leave = e.sent.find(m => m.type === 'FRIEND_BOARD_PUBLISH');
        check('leaving publishes joined:false', leave && leave.payload.joined === false);
        check('and the transport DELETES rather than hides',
            /if \(!joined\)[\s\S]{0,200}?method: 'DELETE'/.test(t),
            'a row that does not exist cannot be ranked or restored');
    }

    console.log('\n=== merging never widens what is shared ===');
    {
        // Two devices disagreeing about a privacy setting must resolve to the
        // MORE private answer, or turning sharing off on a phone would be
        // undone by a laptop that had not synced.
        reset();
        e.gameState.friendPrivacy = { active: false, mon: true, today: true };
        e.mergeCloudState({ friendPrivacy: { active: true, mon: true, today: false } });
        const p = e.getFriendPrivacy();
        check('off on either side stays off', p.active === false && p.today === false,
            JSON.stringify(p));
        check('on on both sides stays on', p.mon === true);

        reset();
        e.gameState.blockedUids = ['a'];
        e.mergeCloudState({ blockedUids: ['b'] });
        check('blocks union', e.gameState.blockedUids.sort().join() === 'a,b');

        reset();
        e.gameState.onLeaderboard = true;
        e.mergeCloudState({ onLeaderboard: false });
        check('leaving the board on one device leaves it everywhere',
            e.isOnLeaderboard() === false);

        reset();
        e.gameState.username = 'nan';
        e.mergeCloudState({ username: '' });
        check('a device that has not seen the name does not erase it',
            e.getUsername() === 'nan');
    }

    console.log('\n=== the panel renders what it is given, and nothing more ===');
    {
        const panel = code('content/flickemon-friends.js');
        check('it exists', fs.existsSync(ROOT + 'content/flickemon-friends.js'));
        check('it ships', JSON.parse(raw('manifest.json')).content_scripts[0].js
            .includes('content/flickemon-friends.js'));

        // The renderer must not be where privacy happens. If it ever reads the
        // privacy settings to decide what to DRAW, the promise has moved from
        // the server back into code an attacker controls.
        check('the panel never filters by privacy itself',
            !/getFriendPrivacy\(\)[\s\S]{0,200}?feeds/.test(panel),
            'what a friend can see is decided by what is published, not by this file');

        check('names from other accounts are escaped', /function fesc/.test(panel)
            && /fesc\(r\.label\)/.test(panel));

        // Reads are metered, so the panel must not poll when nobody is looking.
        check('polling stops when the tab is hidden',
            /visibilitychange[\s\S]{0,200}?stopPolling/.test(panel));
        check('and when the modal closes', /leave\(\)[\s\S]{0,120}?stopPolling/.test(panel));
        check('it backs off the longer it sits open', /FRIENDS_BACKOFF/.test(panel));
        check('the board is only read on its own tab',
            /tab === 'global'[\s\S]{0,200}?friendBoardRead/.test(panel));

        // A private friend is a choice, not a zero.
        check('someone sharing nothing is not ranked last',
            /unranked/.test(panel) && /NOT SHARING PROGRESS/.test(panel));
    }

    console.log('\n=== rules and index cover the new collections ===');
    {
        const rules = raw('firestore.rules');
        for (const c of ['usernames', 'emailKeys', 'profiles', 'friendships',
                         'feeds', 'leaderboard']) {
            check(`${c} is matched`, rules.includes(`match /${c}/`));
        }
        check('a feed is gated on its own audience list',
            /match \/feeds\/\{uid\}[\s\S]{0,400}?in resource\.data\.audience/.test(rules));
        check('only the owner writes their feed',
            /match \/feeds\/\{uid\}[\s\S]{0,500}?allow write: if isMine\(uid\)/.test(rules));
        check('only the owner writes their board row',
            /match \/leaderboard\/\{uid\}[\s\S]{0,300}?allow write: if isMine\(uid\)/.test(rules));
        check('a friendship cannot have its members rewritten',
            /request\.resource\.data\.members == resource\.data\.members/.test(rules));
        check('default deny is still last',
            rules.lastIndexOf('match /{document=**}') > rules.lastIndexOf('match /leaderboard/'));

        const idx = JSON.parse(raw('firestore.indexes.json'));
        const board = idx.indexes.find(i => i.collectionGroup === 'leaderboard');
        check('the board index is defined', Boolean(board));
        check('on the two fields the query uses',
            board.fields.map(f => f.fieldPath).join() === 'dayKey,todayExp',
            JSON.stringify(board.fields));
        check('scored descending', board.fields[1].order === 'DESCENDING');
    }

    console.log('\n=== the email is never stored ===');
    {
        const t = code('background/friends.js');
        check('lookup is by hash', /crypto\.subtle\.digest\('SHA-256'/.test(t));
        check('the hash is what becomes the document id',
            /emailKey\(email\)[\s\S]{0,200}?EMAIL_KEYS_COLLECTION/.test(t));
        check('a missing address and a wrong name give the SAME answer',
            (t.match(/no-such-name/g) || []).length >= 2,
            'confirming an address exists is more than a stranger needs to know');
        check('the profile carries no email field',
            !/writeProfile[\s\S]{0,700}?email: S\(/.test(t));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}
