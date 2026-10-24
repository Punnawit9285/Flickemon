/**
 * Friends, the board, PVP and trading, end to end against the real rules.
 * ───────────────────────────────────────────────────────────────────────
 * test_rules.mjs executes the rules with the SDK. This executes the REST calls
 * the extension actually makes -- background/friends.js, pvp.js and trade.js,
 * unmodified -- as two or three students, against the Firestore emulator.
 *
 * It exists because every one of these was broken while every suite passed:
 * a first friend request was refused (the read before the create), nobody
 * could accept one, and no guest could join a battle or a trade (a PATCH with
 * an update-time precondition is judged by the CREATE rule). Unit tests mock
 * fetch, and a mock agrees with whatever the code expects.
 *
 *     ./tests/rules.sh       runs this alongside test_rules.mjs
 *
 * Without the emulator it skips, loudly, like test_rules.mjs.
 */
import net from 'node:net';

const ROOT = new URL('..', import.meta.url).pathname;
const HOST = '127.0.0.1';
const PORT = Number((process.env.FIRESTORE_EMULATOR_HOST || '').split(':')[1] || 8080);

const reachable = () => new Promise(res => {
    const s = net.connect({ host: HOST, port: PORT });
    const done = ok => { s.destroy(); res(ok); };
    s.setTimeout(1500);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
});

if (!await reachable()) {
    console.log('\n  SKIP  the Firestore emulator is not running on ' + HOST + ':' + PORT);
    console.log('        These run the extension\'s own Firestore calls against the rules.');
    console.log('        Run them with:  ./tests/rules.sh');
    console.log('SKIPPED');
    process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

// ── A worker's world: chrome.storage, and fetch pointed at the emulator ──
const store = {}, session = {};
const area = (o) => ({
    async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in o) out[k] = o[k]; return out; },
    async set(v) { Object.assign(o, v); },
    async remove(keys) { for (const k of [].concat(keys)) delete o[k]; },
});
globalThis.chrome = {
    storage: { local: area(store), session: area(session) },
    runtime: { id: 'test' },
    identity: { getRedirectURL: () => 'https://test.chromiumapp.org/' },
};
const { FIREBASE_CONFIG } = await import(ROOT + 'background/firebase-config.js');
const PROJECT = FIREBASE_CONFIG.projectId;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(
    String(url).replace('https://firestore.googleapis.com', `http://${HOST}:${PORT}`), opts);

// The emulator accepts unsigned tokens; these carry what the rules check.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (uid, email) => b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
    email, email_verified: true, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, auth_time: Math.floor(Date.now() / 1000),
    firebase: { sign_in_provider: 'google.com', identities: { email: [email] } },
}) + '.';

const auth = await import(ROOT + 'background/auth.js');
const F = await import(ROOT + 'background/friends.js');
const P = await import(ROOT + 'background/pvp.js');
const T = await import(ROOT + 'background/trade.js');

// Every uid is unique to this run, so a re-run against a live emulator starts clean.
const run = Date.now().toString(36);
const A = 'alice' + run, B = 'bob' + run, C = 'carol' + run;
const emails = { [A]: `alice.${run}@docchula.com`, [B]: `bob.${run}@docchula.com`, [C]: `carol.${run}@docchula.com` };

/** Signs this worker in as `uid`, dropping every cache the last one left. */
async function as(uid) {
    await auth.signOut();
    store.flickemon_auth_v1 = { uid, email: emails[uid], idToken: token(uid, emails[uid]),
                                refreshToken: 'r', expiresAt: Date.now() + 3600e3 };
    for (const k of Object.keys(session)) delete session[k];
}
const attempt = async (fn) => { try { return await fn(); } catch (e) { return { threw: e.message }; } };

console.log('\n=== finding someone ===');
{
    await as(A);
    check('alice claims a name', (await attempt(() => F.claimUsername('alice' + run))).ok === true);
    await as(C);
    const findable = await attempt(() => F.ensureFindable());
    check('carol, with no username, becomes findable by opening friends', findable.ok === true, JSON.stringify(findable));
    check('once: the second time costs nothing', (await attempt(() => F.ensureFindable())).cached === true);
    await as(B);
    const byName = await attempt(() => F.lookup({ username: 'alice' + run }));
    check('bob finds alice by name', byName.found === true && byName.uid === A, JSON.stringify(byName));
    const byMail = await attempt(() => F.lookup({ email: emails[C] }));
    check('and carol by her address, though she never chose a name',
        byMail.found === true && byMail.uid === C, JSON.stringify(byMail));
}

console.log('\n=== asking, answering, leaving ===');
{
    await as(B);
    const asked = await attempt(() => F.requestFriend(A, { name: 'bob' }));
    check('a first request is sent (it used to be refused before it was written)',
        asked.ok === true && asked.outcome === 'requested', JSON.stringify(asked));
    const again = await attempt(() => F.requestFriend(A, { name: 'bob' }));
    check('asking twice says so', again.outcome === 'pending', JSON.stringify(again));
    await attempt(() => F.requestFriend(C, { name: 'bob' }));

    await as(A);
    const list = await attempt(() => F.listFriendships({ fresh: true }));
    const incoming = (list.friendships || []).find(f => f.uid === B);
    check('alice sees it waiting for her', incoming && incoming.incoming === true, JSON.stringify(list).slice(0, 200));
    check('with the name bob asked under, not a uid', incoming && incoming.name === 'bob');
    const ok = await attempt(() => F.acceptFriend(B, { name: 'alice' }));
    check('alice can accept it (every accept used to be refused)', ok.ok === true, JSON.stringify(ok));
    const after = await F.listFriendships({ fresh: true });
    check('and they are friends', after.friendships.some(f => f.uid === B && f.accepted));

    await as(C);
    const back = await attempt(() => F.requestFriend(B, { name: 'carol' }));
    check('asking back is accepting', back.outcome === 'accepted', JSON.stringify(back));
    check('either side can leave', (await attempt(() => F.removeFriend(B))).ok === true);
    check('and leaving twice is not an error', (await attempt(() => F.removeFriend(B))).ok === true);
    const gone = await attempt(() => F.acceptFriend(B));
    check('accepting a withdrawn request says so', gone.ok === false, JSON.stringify(gone));
}

console.log('\n=== the feed and the board ===');
{
    await as(A);
    check('alice publishes her feed to bob',
        (await attempt(() => F.publishFeed({ audience: [B], payload: { username: 'alice', today: { exp: 300 } } }))).ok === true);
    check('and republishes it (an update, not a create)',
        (await attempt(() => F.publishFeed({ audience: [B], payload: { username: 'alice', today: { exp: 400 } } }))).ok === true);
    await as(B);
    const feeds = await attempt(() => F.readFeeds([A], { fresh: true }));
    check('bob reads it', feeds.feeds && feeds.feeds[A] && feeds.feeds[A].payload.today.exp === 400, JSON.stringify(feeds).slice(0, 160));
    await as(C);
    const hidden = await attempt(() => F.readFeeds([A], { fresh: true }));
    check('carol, not in the audience, gets nothing', hidden.feeds && hidden.feeds[A] === null);

    const day = '2026-10-24';
    await as(B);
    check('bob joins the board', (await attempt(() => F.publishLeaderboard({ joined: true, label: 'bob', dayKey: day, todayExp: 50, levels: 1, streak: 1 }))).ok === true);
    check('and updates his row', (await attempt(() => F.publishLeaderboard({ joined: true, label: 'bob', dayKey: day, todayExp: 90, levels: 2, streak: 1 }))).ok === true);
    await as(A);
    await attempt(() => F.publishLeaderboard({ joined: true, label: 'alice', dayKey: day, todayExp: 120, levels: 3, streak: 2 }));
    const board = await attempt(() => F.readLeaderboard(day));
    const mine = (board.board || []).filter(r => r.uid === A || r.uid === B).map(r => r.uid);
    check('the board ranks them', mine[0] === A && mine[1] === B, JSON.stringify(board).slice(0, 200));
}

console.log('\n=== PVP and trading: the guest can play ===');
{
    const team = [{ speciesId: 25, level: 10 }];
    await as(A);
    const lobby = await attempt(() => P.openLobby({ displayName: 'alice', team, mode: 'singles', rulesVersion: 1 }));
    check('alice opens a lobby', Boolean(lobby.code), JSON.stringify(lobby));
    await as(B);
    const joined = await attempt(() => P.joinBattle(lobby.code, { displayName: 'bob', team, rulesVersion: 1 }));
    check('bob joins it (a guest join used to be refused)', joined.role === 'guest', JSON.stringify(joined));
    check('bob moves', (await attempt(() => P.submitAction(lobby.code, { kind: 'move', index: 0 }))).ok === true);
    await as(A);
    check('alice moves', (await attempt(() => P.submitAction(lobby.code, { kind: 'move', index: 0 }))).ok === true);
    check('alice commits the turn', (await attempt(() => P.commitTurn(lobby.code, { turn: 1 }))).ok === true);
    await attempt(() => P.closeLobby(lobby.code));

    const table = await attempt(() => T.openTrade({ displayName: 'alice' }));
    await as(B);
    check('bob sits down at alice\'s trade', (await attempt(() => T.joinTrade(table.code, { displayName: 'bob' }))).role === 'guest');
    check('bob offers', (await attempt(() => T.offerPokemon(table.code, { instanceId: 'x', speciesId: 1, level: 5 }))).ok === true);
    await as(A);
    check('alice offers', (await attempt(() => T.offerPokemon(table.code, { instanceId: 'y', speciesId: 4, level: 5 }))).ok === true);
    await attempt(() => T.confirmTrade(table.code, true));
    await as(B);
    const sealed = await attempt(() => T.confirmTrade(table.code, true));
    check('both confirm and the trade seals', sealed.sealed === true, JSON.stringify(sealed));
    await attempt(() => T.closeTrade(table.code));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
