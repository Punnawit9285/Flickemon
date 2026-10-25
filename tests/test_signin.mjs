/**
 * Signing in on a computer with many Google accounts.
 * ───────────────────────────────────────────────────
 * A library PC's Chrome holds a dozen @docchula.com accounts, and so does many
 * a student's own laptop. Sign-in used to open Google's chooser every time and
 * then refuse whichever account was not the one Flick is signed in as -- the
 * wrong pick was easy and the refusal came after it.
 *
 * Now the Flick account is asked for by name: first with no window at all,
 * then with Google's page pointed at that account rather than at a list. The
 * chooser is only for "Use a different Google account". These run the real
 * background/auth.js and service worker against a fake chrome.identity.
 */
import { createRequire } from 'node:module';
const ROOT = new URL('..', import.meta.url).pathname;
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

// ── The worker's world ──
const store = {}, session = {};
const area = (o) => ({
    async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in o) out[k] = o[k]; return out; },
    async set(v) { Object.assign(o, v); },
    async remove(keys) { for (const k of [].concat(keys)) delete o[k]; },
});
let listener = null;
const flows = [];            // every launchWebAuthFlow call: { interactive, params }
let google = () => ({ error: 'interaction_required' });   // decides each flow's answer
globalThis.chrome = {
    storage: { local: area(store), session: area(session) },
    runtime: { id: 'ext', lastError: null, onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { onRemoved: { addListener() {} } },
    identity: {
        getRedirectURL: () => 'https://ext.chromiumapp.org/',
        launchWebAuthFlow(details, cb) {
            const params = new URL(details.url).searchParams;
            flows.push({ interactive: details.interactive, params, details });
            const answer = google({ interactive: details.interactive, params });
            if (answer.lastError) {
                chrome.runtime.lastError = { message: answer.lastError };
                cb(undefined);
                chrome.runtime.lastError = null;
                return;
            }
            const frag = new URLSearchParams({ state: params.get('state'), ...answer });
            cb('https://ext.chromiumapp.org/#' + frag.toString());
        },
    },
};
// signInWithIdp answers with whichever account Google "chose".
let googleAccount = 'alice@docchula.com';
globalThis.fetch = async (url) => {
    if (String(url).includes('accounts:signInWithIdp')) {
        return { ok: true, json: async () => ({ localId: 'uid-' + googleAccount.split('@')[0],
            email: googleAccount, idToken: 'id', refreshToken: 'r', expiresIn: '3600' }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

const auth = await import(ROOT + 'background/auth.js');
await import(ROOT + 'background/service-worker.js');
const send = (msg) => new Promise(res => listener(msg, {}, res));
const reset = async () => { flows.length = 0; await auth.signOut(); for (const k of Object.keys(session)) delete session[k]; };

console.log('\n=== the Flick account is asked for by name ===');
{
    await reset();
    googleAccount = 'alice@docchula.com';
    google = ({ interactive, params }) => (!interactive && params.get('prompt') === 'none'
        ? { access_token: 'tok' } : { error: 'unexpected' });
    const res = await send({ type: 'AUTH_SIGN_IN', requireEmail: 'alice@docchula.com' });
    check('signed in', res.ok === true && res.email === 'alice@docchula.com', JSON.stringify(res));
    check('with no window at all', flows.length === 1 && flows[0].interactive === false,
        JSON.stringify(flows.map(f => f.interactive)));
    check('asking for exactly that account', flows[0].params.get('login_hint') === 'alice@docchula.com');
    check('silently', flows[0].params.get('prompt') === 'none');
    check('and patient with Google\'s own redirects',
        flows[0].details.abortOnLoadForNonInteractive === false && flows[0].details.timeoutMsForNonInteractive > 0);
}

console.log('\n=== when Google needs the student, it goes to that account, not a list ===');
{
    await reset();
    google = ({ interactive }) => (interactive ? { access_token: 'tok' } : { error: 'interaction_required' });
    const res = await send({ type: 'AUTH_SIGN_IN', requireEmail: 'alice@docchula.com' });
    check('signed in', res.ok === true, JSON.stringify(res));
    check('silent first, then a window', flows.length === 2 && !flows[0].interactive && flows[1].interactive);
    check('pointed at the Flick account', flows[1].params.get('login_hint') === 'alice@docchula.com');
    check('with no account chooser forced on top', !flows[1].params.has('prompt'),
        flows[1].params.get('prompt'));
}

console.log('\n=== a different account is still refused, and nothing is kept ===');
{
    await reset();
    googleAccount = 'bob@docchula.com';
    google = () => ({ access_token: 'tok' });
    const res = await send({ type: 'AUTH_SIGN_IN', requireEmail: 'alice@docchula.com' });
    check('refused', res.ok === false && /alice@docchula\.com/.test(res.error), JSON.stringify(res));
    check('and not signed in', (await send({ type: 'AUTH_STATUS' })).signedIn === false);
    googleAccount = 'alice@docchula.com';
}

console.log('\n=== "Use a different Google account" still opens the chooser ===');
{
    await reset();
    google = () => ({ access_token: 'tok' });
    await send({ type: 'AUTH_SIGN_IN', prompt: 'select_account consent', requireEmail: 'alice@docchula.com' });
    check('one window, the chooser', flows.length === 1 && flows[0].interactive
        && flows[0].params.get('prompt') === 'select_account consent');
}

console.log('\n=== signing in by itself ===');
{
    await reset();
    google = ({ interactive }) => (interactive ? { access_token: 'tok' } : { error: 'login_required' });
    const res = await send({ type: 'AUTH_SIGN_IN_SILENT', requireEmail: 'alice@docchula.com' });
    check('a silent attempt never opens a window', flows.length === 1 && flows[0].interactive === false);
    check('and reports that it needs the student', res.ok === false && res.reason === 'needs-you', JSON.stringify(res));

    flows.length = 0;
    const again = await send({ type: 'AUTH_SIGN_IN_SILENT', requireEmail: 'alice@docchula.com' });
    check('it is not asked again on every page', again.reason === 'tried' && flows.length === 0);

    google = () => ({ access_token: 'tok' });
    await send({ type: 'AUTH_SIGN_IN', requireEmail: 'alice@docchula.com' });
    await send({ type: 'AUTH_SIGN_OUT' });
    flows.length = 0;
    const later = await send({ type: 'AUTH_SIGN_IN_SILENT', requireEmail: 'alice@docchula.com' });
    check('signing in by hand clears that, so next time it is silent',
        later.ok === true && flows.length === 1 && flows[0].interactive === false, JSON.stringify(later));
    check('without an account to ask for, it does nothing',
        (await send({ type: 'AUTH_SIGN_IN_SILENT' })).reason === 'no-account');
}

// ── The engine's half ──
console.log('\n=== the engine ===');
{
    globalThis.window = { addEventListener() {} };
    globalThis.document = { visibilityState: 'visible', addEventListener() {} };
    require(ROOT + 'content/flickemon-config.js');
    require(ROOT + 'content/flickemon-battle.js');
    require(ROOT + 'content/flickemon-engine.js');
    const e = globalThis.window.flickemonEngine;
    e.isLoaded = true;

    let reads = 0;
    globalThis.window.FlickemonFlickIdentity = {
        sameAccount: (a, b) => a === b,
        // Unreadable twice, as Flick's database can be while Firebase starts.
        currentFlickIdentity: async () => (++reads < 3 ? null : { email: 'alice@docchula.com', source: 't' }),
    };
    let sent = [];
    let signedIn = false;
    e.sendToWorker = async (msg) => {
        sent.push(msg);
        if (msg.type === 'AUTH_STATUS') return { configured: true, signedIn, email: signedIn ? 'alice@docchula.com' : null };
        if (msg.type === 'AUTH_SIGN_IN_SILENT') { signedIn = true; return { ok: true, uid: 'u-alice', email: 'alice@docchula.com' }; }
        if (msg.type === 'CLOUD_PULL') return { signedIn: true, state: null };
        return { ok: true };
    };
    const ok = await e.trySilentSignIn();
    check('a brief unreadable Flick session is retried, not refused', ok === true && reads === 3, String(reads));
    check('the save now belongs to the account', e.gameState.ownerUid === 'u-alice');

    sent = [];
    check('already signed in, it does nothing', (await e.trySilentSignIn()) === false
        && !sent.some(m => m.type === 'AUTH_SIGN_IN_SILENT'));

    // Signing out by hand is respected: no silent sign-in straight back.
    globalThis.chrome = { storage: { local: area(store) } };
    reads = 10;
    e.sendToWorker = async (msg) => {
        sent.push(msg);
        if (msg.type === 'AUTH_STATUS') return { configured: true, signedIn, email: signedIn ? 'alice@docchula.com' : null };
        if (msg.type === 'AUTH_SIGN_OUT') { signedIn = false; return { ok: true }; }
        if (msg.type === 'AUTH_SIGN_IN_SILENT') { signedIn = true; return { ok: true, uid: 'u-alice', email: 'alice@docchula.com' }; }
        if (msg.type === 'AUTH_SIGN_IN') { signedIn = true; return { ok: true, uid: 'u-alice', email: 'alice@docchula.com' }; }
        if (msg.type === 'CLOUD_PULL') return { signedIn: true, state: null };
        return { ok: true };
    };
    await e.signOut({ byHand: true });
    sent = [];
    check('after signing out by hand, it does not sign straight back in',
        (await e.trySilentSignIn()) === false && !sent.some(m => m.type === 'AUTH_SIGN_IN_SILENT'));
    await e.signIn();
    await e.signOut();
    check('a sign-out it did itself (a handover) does not count', (await e.trySilentSignIn()) === true);

    signedIn = false;
    e.sendToWorker = async () => { throw new Error('worker gone'); };
    check('and it never throws', (await e.trySilentSignIn()) === false);

    const src = require('fs').readFileSync(ROOT + 'content/flickemon-engine.js', 'utf8');
    const guard = src.slice(src.indexOf('async enforceFlickAccount()'), src.indexOf('startFlickAccountGuard('));
    check('a handover signs the next student in by itself', /trySilentSignIn\(\)/.test(guard));
    const boot = require('fs').readFileSync(ROOT + 'content/content-script.js', 'utf8');
    check('and so does opening a Flick page signed out', /trySilentSignIn\(\)/.test(boot));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
