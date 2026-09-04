const ROOT = new URL('..', import.meta.url).pathname;
/**
 * The masked freshness check on the save poll.
 * ───────────────────────────────────────────
 * The poll used to fetch the whole ~39 KiB save every five minutes to find out,
 * almost every time, that nothing had changed. It now asks for the write time
 * alone and only fetches the body when it has moved on.
 *
 * The danger in that is not cost, it is silence: a check that wrongly says
 * "unchanged" leaves a device blind to the other one's progress and reports
 * nothing wrong. So most of what is asserted here is that every uncertain
 * answer falls back to the full read.
 */
const R = ROOT;

// getIdToken() reads this before anything else happens.
const auth = { idToken: 'tok', uid: 'u1', email: 'a@docchula.com',
               expiresAt: Date.now() + 3600000, refreshToken: 'r' };
global.chrome = {
    storage: { local: {
        get: async () => ({ flickemon_auth_v1: auth }),
        set: async () => {}, remove: async () => {},
    }, session: undefined },
};

const { pullState, isNewer } = await import(R + 'background/firestore.js');
// auth.js memoises the token for thirty seconds, and caches its ABSENCE too, so
// a suite that flips auth state has to clear it between blocks. signOut() does
// exactly that and nothing else.
const { signOut } = await import(R + 'background/auth.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const T1 = '2026-09-04T10:00:00.000000Z';
const T2 = '2026-09-04T10:05:00.000000Z';

console.log('\n=== comparing two write times ===');
{
    check('later is newer', isNewer(T2, T1) === true);
    check('earlier is not', isNewer(T1, T2) === false);
    check('the same string is not', isNewer(T1, T1) === false);

    // Everything below is a case the comparison cannot settle, and each one
    // resolves to "assume it changed" — one wasted fetch, never a missed update.
    check('a missing stamp counts as changed', isNewer(null, T1) === true);
    check('a missing baseline counts as changed', isNewer(T1, null) === true);
    check('an unparseable stamp counts as changed', isNewer('yesterday', T1) === true);
    // Firestore's fractional precision is not fixed, and Date.parse throws away
    // anything below a millisecond, so two different strings that land on the
    // same millisecond must not be read as "no change".
    check('same millisecond, different strings, counts as changed',
        isNewer('2026-09-04T10:00:00.000001Z', '2026-09-04T10:00:00.000002Z') === true);
}

/** Records every URL fetched, and answers from a script. */
function stubFetch(script) {
    const urls = [];
    global.fetch = async (url) => {
        urls.push(String(url));
        const step = script(String(url));
        return {
            ok: step.status === undefined || step.status === 200,
            status: step.status || 200,
            json: async () => step.body,
        };
    };
    return urls;
}
const masked = u => u.includes('mask.fieldPaths=serverAt');
const save = (state, serverAt) => ({
    fields: { state: { stringValue: JSON.stringify(state) },
              serverAt: { timestampValue: serverAt } },
});

console.log('\n=== signed out ===');
{
    // FIRST, deliberately: auth.js memoises the token for thirty seconds, so
    // once any call above has read one, no stub can take it away again.
    const saved = global.chrome.storage.local.get;
    global.chrome.storage.local.get = async () => ({});
    global.fetch = async () => { throw new Error('should not reach the network'); };
    await signOut();
    const res = await pullState({ since: T1 });
    check('no token means no request and no claim about freshness',
        res.signedIn === false && res.unchanged !== true, JSON.stringify(res));
    // Put the token back, and drop the memoised absence with it.
    global.chrome.storage.local.get = saved;
    await signOut();
}

console.log('\n=== an unchanged save is not downloaded ===');
{
    const urls = stubFetch(u => masked(u)
        ? { body: { fields: { serverAt: { timestampValue: T1 } } } }
        : { body: save({ party: [] }, T1) });

    const res = await pullState({ since: T1 });
    check('it reports no change', res.unchanged === true, JSON.stringify(res));
    check('and never asks for the body', urls.length === 1 && masked(urls[0]),
        JSON.stringify(urls));
    check('it hands back the stamp it saw', res.serverAt === T1);
}

console.log('\n=== a changed save is fetched in full ===');
{
    const urls = stubFetch(u => masked(u)
        ? { body: { fields: { serverAt: { timestampValue: T2 } } } }
        : { body: save({ party: ['x'] }, T2) });

    const res = await pullState({ since: T1 });
    check('the body comes back', res.state && res.state.party[0] === 'x');
    check('after exactly one masked check', urls.length === 2
        && masked(urls[0]) && !masked(urls[1]), JSON.stringify(urls.map(masked)));
    check('and the new stamp travels with it', res.serverAt === T2);
}

console.log('\n=== with no baseline, nothing is skipped ===');
{
    const urls = stubFetch(() => ({ body: save({ party: [] }, T1) }));
    const res = await pullState();
    check('a first poll reads the document itself', res.state !== null);
    check('with no masked request at all', urls.length === 1 && !masked(urls[0]));
}

console.log('\n=== every uncertain answer falls back to the full read ===');
{
    // A save written before serverAt existed has nothing to compare against.
    let urls = stubFetch(u => masked(u)
        ? { body: { fields: {} } }
        : { body: save({ party: ['legacy'] }, undefined) });
    let res = await pullState({ since: T1 });
    check('a save with no write time is read in full',
        res.state && res.state.party[0] === 'legacy', JSON.stringify(res));
    check('and is never reported as unchanged', res.unchanged !== true);

    // A failed freshness request must not be read as "nothing changed".
    urls = stubFetch(u => masked(u)
        ? { status: 500, body: null }
        : { body: save({ party: ['recovered'] }, T2) });
    res = await pullState({ since: T1 });
    check('a failed check falls through to the document',
        res.state && res.state.party[0] === 'recovered');
    check('rather than claiming no change', res.unchanged !== true);

    // Unparseable JSON on the masked hop.
    urls = stubFetch(u => masked(u)
        ? { body: null }
        : { body: save({ party: ['ok'] }, T2) });
    res = await pullState({ since: T1 });
    check('an empty freshness body also falls through',
        res.state && res.state.party[0] === 'ok');
}

console.log('\n=== a student with no save yet ===');
{
    const urls = stubFetch(() => ({ status: 404, body: null }));
    const res = await pullState({ since: T1 });
    check('404 on the check means no save, not no change',
        res.signedIn === true && res.state === null && res.unchanged !== true,
        JSON.stringify(res));
    check('and it does not go on to ask for a body that is not there',
        urls.length === 1, JSON.stringify(urls));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
