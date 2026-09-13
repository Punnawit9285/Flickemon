/**
 * The shared-computer guard.
 *
 * A faculty library PC runs one Chrome profile signed in to a dozen Google
 * accounts, every one of them @docchula.com. The domain check passes all of
 * them and firestore.rules cannot see a Flick session at all, so the only thing
 * that ties a Flickémon sign-in to the right person is: it must match the
 * account Flick itself is already signed in as.
 *
 * Two halves are tested here — reading that account off the page, and refusing
 * to proceed when it does not match.
 */
const ROOT = require('path').join(__dirname, '..') + '/';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const identity = require(ROOT + 'content/flickemon-flick-identity.js');
const { readFlickIdentity, sameAccount } = identity;

/** A storage double: plain object in, getItem out. */
const store = (obj) => ({
    ...obj,
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null; },
});

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const jwt = (claims) => `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(claims))}.sig`
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

(async () => {

console.log('=== reading the Flick account off the page ===');
{
    check('a user object in localStorage is found',
        readFlickIdentity({ localStorage: store({ user: '{"email":"a@docchula.com"}' }) })
            ?.email === 'a@docchula.com');

    check('a nested session wrapper is descended into',
        readFlickIdentity({
            localStorage: store({ session: '{"data":{"profile":{"email":"B@Docchula.com"}}}' }),
        })?.email === 'b@docchula.com');

    check('and the address is lowercased, so case cannot split one account in two',
        sameAccount('B@Docchula.com', 'b@docchula.com'));

    check('a JWT payload is decoded for its claims',
        readFlickIdentity({
            localStorage: store({ access_token: jwt({ email: 'c@docchula.com', sub: '1' }) }),
            atob: (s) => Buffer.from(s, 'base64').toString('utf8'),
        })?.email === 'c@docchula.com');

    check('a JWT carried inside a JSON blob is still found',
        readFlickIdentity({
            localStorage: store({ auth: JSON.stringify({ token: jwt({ upn: 'd@docchula.com' }) }) }),
            atob: (s) => Buffer.from(s, 'base64').toString('utf8'),
        })?.email === 'd@docchula.com');

    check('sessionStorage is read as well as localStorage',
        readFlickIdentity({ sessionStorage: store({ me: '{"userEmail":"e@docchula.com"}' }) })
            ?.email === 'e@docchula.com');

    check('the account menu in the DOM is a fallback when storage says nothing',
        readFlickIdentity({
            localStorage: store({ theme: 'dark' }),
            document: { querySelector: () => ({ getAttribute: () => 'mailto:f@docchula.com' }) },
        })?.email === 'f@docchula.com');

    // The extension's own writes must never answer this question: reading our
    // own record of who signed in, to decide who may sign in, proves nothing.
    check('this extension\'s own storage keys are ignored',
        readFlickIdentity({ localStorage: store({ flickemon_ext_save_v2: '{"email":"g@docchula.com"}' }) })
            === null);

    check('nothing readable returns null, not a guess',
        readFlickIdentity({ localStorage: store({ theme: 'dark', lang: 'th' }) }) === null);

    check('null is distinguishable from an answer, so callers can fail closed',
        readFlickIdentity({}) === null && readFlickIdentity(null) === null);

    // A parser that throws on a hostile page would take the game down with it.
    check('a storage that throws is treated as absent, not as a crash', (() => {
        const hostile = { getItem() { throw new Error('blocked'); } };
        Object.defineProperty(hostile, 'k', { enumerable: true, get() { throw new Error('nope'); } });
        try { return readFlickIdentity({ localStorage: hostile }) === null; }
        catch { return false; }
    })());

    check('a malformed address is rejected rather than half-accepted',
        readFlickIdentity({ localStorage: store({ user: '{"email":"not-an-address"}' }) }) === null);

    check('the source that answered is reported, so a break is diagnosable',
        readFlickIdentity({ localStorage: store({ user: '{"email":"h@docchula.com"}' }) })
            ?.source === 'localStorage:user');
}

console.log('\n=== two different @docchula.com accounts are still two accounts ===');
{
    // The whole reason the domain check is not enough.
    check('same domain, different people, does not match',
        !sameAccount('alice@docchula.com', 'bob@docchula.com'));
    check('surrounding whitespace does not make two accounts',
        sameAccount(' a@docchula.com ', 'a@docchula.com'));
    // Gmail dot-aliasing is deliberately not applied: Workspace domains do not
    // honour it, so folding them together would merge two real students.
    check('dot aliasing is NOT folded away',
        !sameAccount('a.b@docchula.com', 'ab@docchula.com'));
    check('a missing side never matches',
        !sameAccount(null, 'a@docchula.com') && !sameAccount('a@docchula.com', undefined));
}

console.log('\n=== signing in is refused unless it matches Flick ===');
{
    global.window = { addEventListener() {} };
    global.chrome = {
        storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
                   onChanged: { addListener: () => {} } },
        runtime: { sendMessage: async () => null },
    };
    global.document = { visibilityState: 'visible', addEventListener: () => {} };
    const realSetTimeout = global.setTimeout;
    global.setTimeout = f => { f(); return 0; };
    global.clearTimeout = () => {};
    global.setInterval = () => 0;

    require(ROOT + 'content/flickemon-config.js');
    require(ROOT + 'content/flickemon-battle.js');
    require(ROOT + 'content/flickemon-engine.js');
    const e = global.window.flickemonEngine;
    global.window.FlickemonFlickIdentity = identity;

    const asFlick = (email) => {
        global.window.FlickemonFlickIdentity = {
            ...identity,
            currentFlickIdentity: () => (email ? { email, source: 'test' } : null),
        };
    };

    // 1. The account Flick is signed in as is what gets sent to the worker.
    asFlick('alice@docchula.com');
    let sent = null;
    e.sendToWorker = async (msg) => {
        if (msg.type === 'AUTH_SIGN_IN') { sent = msg; return { ok: true, uid: 'u-alice', email: 'alice@docchula.com' }; }
        if (msg.type === 'CLOUD_PULL') return { signedIn: true, state: null };
        return { ok: true };
    };
    e.gameState = e.createEmptyState();
    e.isLoaded = true;
    await e.signIn();
    check('sign-in sends Flick\'s account as the one that must be used',
        sent && sent.requireEmail === 'alice@docchula.com', JSON.stringify(sent));

    // 2. Flick unreadable -> refuse. This is the fail-closed choice: a guard
    //    that waves everyone through the moment it breaks is not a guard.
    asFlick(null);
    let threw = false, message = '';
    try { await e.signIn(); } catch (err) { threw = true; message = err.message; }
    check('an unreadable Flick session blocks sign-in entirely', threw);
    check('and says why, naming the shared-computer reason',
        /shared computer|logged in to Flick/i.test(message), message);

    // 3. The reader missing altogether (script failed to load) fails the same way.
    global.window.FlickemonFlickIdentity = null;
    threw = false;
    try { await e.signIn(); } catch { threw = true; }
    check('a missing identity reader also blocks, rather than defaulting to open', threw);

    global.setTimeout = realSetTimeout;
}

console.log('\n=== the library walk-away: Flick changes hands mid-session ===');
{
    const e = global.window.flickemonEngine;
    const seed = () => {
        e.gameState = e.createEmptyState();
        e.gameState.hasStarted = true;
        e.gameState.ownerUid = 'u-alice';
        e.gameState.party = [{ instanceId: 'alice-pikachu', speciesId: 25, level: 30,
                               totalExp: 0, shiny: false, megaStones: [], megaSeen: [],
                               megaActive: null, megaActiveAt: 0 }];
        e.isLoaded = true;
        // flushCloud() is a no-op unless something is actually pending, so
        // without this the ordering check below would pass by never running.
        e.cloudDirty = true;
        e.cloudInFlight = false;
        e.lastPushedFingerprint = null;
    };
    const withFlick = (email) => {
        global.window.FlickemonFlickIdentity = {
            ...identity,
            currentFlickIdentity: () => (email ? { email, source: 'test' } : null),
        };
    };
    const wired = (signedInAs) => {
        const calls = [];
        e.sendToWorker = async (msg) => {
            calls.push(msg.type);
            if (msg.type === 'AUTH_STATUS') {
                return { configured: true, signedIn: Boolean(signedInAs), email: signedInAs, uid: 'u-alice' };
            }
            return { ok: true };
        };
        return calls;
    };

    // Alice is signed in to both. Nothing to do.
    seed(); withFlick('alice@docchula.com');
    let calls = wired('alice@docchula.com');
    check('a matching account is left alone', (await e.enforceFlickAccount()) === false);
    check('and nothing is signed out', !calls.includes('AUTH_SIGN_OUT'));
    check('and Alice keeps her party', e.gameState.party.length === 1);

    // Bob logs in to Flick on the same machine while Alice is still signed in.
    seed(); withFlick('bob@docchula.com');
    calls = wired('alice@docchula.com');
    check('a handover is detected', (await e.enforceFlickAccount()) === true);
    check('Alice is signed out', calls.includes('AUTH_SIGN_OUT'));
    check('her progress is actually pushed, not silently dropped',
        calls.includes('CLOUD_PUSH'), calls.join(','));
    check('and it goes out BEFORE the sign-out, so it lands in HER account',
        calls.indexOf('CLOUD_PUSH') < calls.indexOf('AUTH_SIGN_OUT'), calls.join(','));
    check('and her party is off the screen, so Bob cannot see it',
        e.gameState.party.length === 0);
    check('but a snapshot survives, so it is recoverable', !!e.peekBackup());

    // Flick briefly unreadable during a route change. Acting here would wipe a
    // save belonging to someone who did nothing wrong.
    seed(); withFlick(null);
    calls = wired('alice@docchula.com');
    check('an unreadable Flick session does NOT trigger a handover',
        (await e.enforceFlickAccount()) === false);
    check('and leaves the party intact', e.gameState.party.length === 1);
    check('and does not sign anyone out', !calls.includes('AUTH_SIGN_OUT'));

    // Nobody signed in to Flickémon: nothing to protect.
    seed(); withFlick('bob@docchula.com');
    calls = wired(null);
    check('a signed-out session is a no-op', (await e.enforceFlickAccount()) === false);
    check('and keeps local-only progress, which belongs to whoever is sitting there',
        e.gameState.party.length === 1);

    // The guard must not stack timers across re-inits.
    e.flickGuardTimer = null;
    let timers = 0;
    const realInterval = global.setInterval;
    global.setInterval = () => { timers++; return 99; };
    e.sendToWorker = async () => ({ configured: true, signedIn: false });
    e.startFlickAccountGuard();
    e.startFlickAccountGuard();
    check('starting the guard twice creates one timer, not two', timers === 1, String(timers));
    global.setInterval = realInterval;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
