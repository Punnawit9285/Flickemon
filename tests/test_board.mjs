/**
 * The global board without its index.
 * ───────────────────────────────────
 * The board's query orders by today's EXP, which needs the composite index in
 * firestore.indexes.json. Firestore answers an un-indexed ordered query with an
 * error, not an empty list -- so until somebody deployed the index, the board
 * was simply broken. It now falls back to today's rows unordered and ranks them
 * itself, and remembers for an hour that the index is missing.
 */
const ROOT = new URL('..', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const store = {}, session = {};
const area = (o) => ({
    async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in o) out[k] = o[k]; return out; },
    async set(v) { Object.assign(o, v); },
    async remove(keys) { for (const k of [].concat(keys)) delete o[k]; },
});
globalThis.chrome = { storage: { local: area(store), session: area(session) }, runtime: { id: 't' },
                      identity: { getRedirectURL: () => 'x' } };
store.flickemon_auth_v1 = { uid: 'me', email: 'me@docchula.com', idToken: 't', refreshToken: 'r',
                            expiresAt: Date.now() + 3600e3 };

const row = (uid, exp) => ({ document: {
    name: `projects/p/databases/(default)/documents/leaderboard/${uid}`,
    fields: { uid: { stringValue: uid }, label: { stringValue: uid }, dayKey: { stringValue: 'd' },
              todayExp: { integerValue: String(exp) }, levels: { integerValue: '0' }, streak: { integerValue: '0' } } } });

let queries = [];
let indexed = false;
globalThis.fetch = async (url, init) => {
    const q = JSON.parse(init.body).structuredQuery;
    queries.push(q);
    if (q.orderBy && !indexed) {
        return { ok: false, status: 400,
                 text: async () => '[{"error":{"code":400,"message":"The query requires an index. You can create it here: https://console.firebase.google.com/...","status":"FAILED_PRECONDITION"}}]' };
    }
    const rows = Array.from({ length: 40 }, (_, i) => row('u' + i, (i * 37) % 101));
    return { ok: true, status: 200, json: async () => rows };
};

const F = await import(ROOT + 'background/friends.js');

console.log('\n=== no index deployed ===');
{
    const res = await F.readLeaderboard('d');
    check('the board still loads', res.ok === true && Array.isArray(res.board), JSON.stringify(res).slice(0, 120));
    check('ranked by today\'s EXP', res.board.every((r, i) => i === 0 || res.board[i - 1].todayExp >= r.todayExp));
    check('top 25 only', res.board.length === F.LEADERBOARD_LIMIT, String(res.board.length));
    check('the fallback asks only for today, which needs no composite index',
        !queries[1].orderBy && queries[1].where.fieldFilter.field.fieldPath === 'dayKey', JSON.stringify(queries[1]));

    queries = [];
    for (const k of Object.keys(session)) if (k.startsWith('cache:board:board:')) delete session[k];
    await F.readLeaderboard('d');
    check('the refused query is not paid for again', queries.length === 1 && !queries[0].orderBy,
        JSON.stringify(queries.map(q => Boolean(q.orderBy))));
}

console.log('\n=== index deployed ===');
{
    for (const k of Object.keys(session)) delete session[k];
    indexed = true; queries = [];
    const res = await F.readLeaderboard('d2');
    check('the ordered query is used', queries.length === 1 && Boolean(queries[0].orderBy));
    check('and its answer is taken as it comes', res.ok === true && !res.unindexed);
}

console.log('\n=== any other failure is still a failure ===');
{
    for (const k of Object.keys(session)) delete session[k];
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'PERMISSION_DENIED' });
    let threw = '';
    try { await F.readLeaderboard('d3'); } catch (e) { threw = e.message; }
    check('a refusal is reported, not papered over', /403/.test(threw), threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
