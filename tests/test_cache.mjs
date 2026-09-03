const ROOT = new URL('..', import.meta.url).pathname;
// Local caching, and the write shape it made verifiable.
import fs from 'node:fs';
const R = ROOT;
const { createMemoCache, createSessionCache, readDoc, mutateDoc, invalidateDoc } = await import(R + 'background/cache.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

console.log('\n=== memo cache ===');
{
    const c = createMemoCache(50);
    let produced = 0;
    const make = async () => { produced++; return 'v' + produced; };

    check('first call produces', await c.through('k', make) === 'v1');
    check('second call is served from cache', await c.through('k', make) === 'v1');
    check('the producer ran once', produced === 1, String(produced));

    c.delete('k');
    check('delete forces a rebuild', await c.through('k', make) === 'v2');

    await new Promise(r => setTimeout(r, 70));
    check('an expired entry is a miss', c.get('k') === undefined);

    c.set('a', 1); c.set('b', 2); c.clear();
    check('clear empties it', c.get('a') === undefined && c.get('b') === undefined);
    check('null is cacheable (absence is a real answer)',
        await c.through('n', async () => null) === null && c.get('n') === null);
}

console.log('\n=== session cache (survives the worker being evicted) ===');
{
    // No chrome.storage.session here, so this exercises the in-memory fallback.
    // What matters either way is the contract the friends code relies on.
    const c = createSessionCache('t', 50);
    let produced = 0;
    const make = async () => { produced++; return 'v' + produced; };

    check('first call produces', await c.through('k', make) === 'v1');
    check('second call is served from cache', await c.through('k', make) === 'v1');
    check('the producer ran once', produced === 1, String(produced));

    check('fresh bypasses the cache', await c.through('k', make, { fresh: true }) === 'v2');

    await new Promise(r => setTimeout(r, 70));
    check('an expired entry is a miss', await c.get('k') === undefined);

    // A friend who has published nothing reads as null, and caching that is the
    // whole point: a quiet friend must not cost a read on every sweep.
    check('null is cacheable, because absence is a real answer',
        await c.through('n', async () => null) === null && await c.get('n') === null);

    await c.set('d', 1);
    await c.delete('d');
    check('delete removes it', await c.get('d') === undefined);

    // Two namespaces must not collide — feeds and friendships share the store.
    const a = createSessionCache('a', 1000), b = createSessionCache('b', 1000);
    await a.set('same', 'from-a');
    await b.set('same', 'from-b');
    check('namespaces are isolated',
        await a.get('same') === 'from-a' && await b.get('same') === 'from-b');
}

console.log('\n=== the expensive reads are the ones that are cached ===');
{
    const src = fs.readFileSync(R + 'background/friends.js', 'utf8');
    check('feeds go through the session cache', /feedCache\.through/.test(src));
    check('a feed sweep can still be forced fresh', /readFeeds\(uids, \{ fresh/.test(src));
    check('the friendship list is cached too', /friendshipsCache\.through/.test(src));
    check('and invalidated whenever it is changed',
        (src.match(/friendshipsCache\.delete/g) || []).length >= 3);
    check('the board is cached in session storage, not memory',
        /boardCache = createSessionCache/.test(src));
}

console.log('\n=== readDoc ===');
{
    let calls = 0;
    const url = 'https://example.test/doc/1';
    global.fetch = async () => { calls++; return {
        ok: true, status: 200,
        json: async () => ({ fields: { a: { stringValue: 'x' } }, updateTime: '2026-01-01T00:00:00Z' }),
    }; };

    invalidateDoc(url);
    const first = await readDoc(url, 'tok');
    check('reads the document', first.doc.fields.a.stringValue === 'x');
    check('keeps the version for later conditional writes',
        first.updateTime === '2026-01-01T00:00:00Z');

    await readDoc(url, 'tok');
    check('a second read is served from cache', calls === 1, `${calls} network calls`);

    await readDoc(url, 'tok', { fresh: true });
    check('fresh bypasses the cache', calls === 2, `${calls} network calls`);

    // The poll loop must never be served a stale document.
    global.fetch = async () => ({ ok: false, status: 404 });
    invalidateDoc(url);
    check('a missing document reads as null', await readDoc(url, 'tok') === null);
}

console.log('\n=== mutateDoc: shape, version and conflict ===');
{
    const url = 'https://example.test/doc/2';
    let sent = [];
    invalidateDoc(url);

    global.fetch = async (u, init) => {
        if (!init || init.method !== 'PATCH') {
            return { ok: true, status: 200,
                     json: async () => ({ fields: {}, updateTime: 'V1' }) };
        }
        sent.push({ url: u, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ fields: {}, updateTime: 'V2' }) };
    };

    const res = await mutateDoc(url, 'tok', () => ({ host: { stringValue: 'me' } }));
    check('the write succeeds', res.ok === true);
    check('the body is wrapped in `fields`',
        Object.keys(sent[0].body).join() === 'fields', JSON.stringify(sent[0].body).slice(0, 60));
    check('the write is conditional on the version read',
        sent[0].url.includes('currentDocument.updateTime=V1'), sent[0].url);

    // A conflicting write must not overwrite; it rebuilds and retries once.
    sent = []; invalidateDoc(url);
    let patches = 0, seenVersions = [];
    global.fetch = async (u, init) => {
        if (!init || init.method !== 'PATCH') {
            return { ok: true, status: 200,
                     json: async () => ({ fields: {}, updateTime: patches ? 'V9' : 'V1' }) };
        }
        patches++;
        seenVersions.push(decodeURIComponent(u.split('updateTime=')[1] || ''));
        return patches === 1
            ? { ok: false, status: 409 }
            : { ok: true, status: 200, json: async () => ({ fields: {}, updateTime: 'V10' }) };
    };
    const retried = await mutateDoc(url, 'tok', () => ({ x: { stringValue: '1' } }));
    check('a rejected write is retried', retried.ok === true, JSON.stringify(retried));
    check('the retry uses the newer version',
        seenVersions[0] === 'V1' && seenVersions[1] === 'V9', JSON.stringify(seenVersions));

    // Two conflicts in a row give up rather than looping.
    invalidateDoc(url);
    global.fetch = async (u, init) => (!init || init.method !== 'PATCH')
        ? { ok: true, status: 200, json: async () => ({ fields: {}, updateTime: 'V1' }) }
        : { ok: false, status: 409 };
    const gave = await mutateDoc(url, 'tok', () => ({ x: { stringValue: '1' } }));
    check('it gives up rather than looping', gave.ok === false && gave.conflict === true,
        JSON.stringify(gave));

    // A real server error must surface, not be mistaken for a conflict.
    invalidateDoc(url);
    global.fetch = async (u, init) => (!init || init.method !== 'PATCH')
        ? { ok: true, status: 200, json: async () => ({ fields: {}, updateTime: 'V1' }) }
        : { ok: false, status: 500 };
    let threw = false;
    try { await mutateDoc(url, 'tok', () => ({ x: { stringValue: '1' } })); } catch { threw = true; }
    check('a 500 throws rather than retrying forever', threw);

    // Aborting the transform must not write at all.
    invalidateDoc(url);
    let wrote = false;
    global.fetch = async (u, init) => {
        if (init && init.method === 'PATCH') { wrote = true; }
        return { ok: true, status: 200, json: async () => ({ fields: {}, updateTime: 'V1' }) };
    };
    const aborted = await mutateDoc(url, 'tok', () => null);
    check('returning null aborts without writing', aborted.aborted === true && !wrote);
}

console.log('\n=== every Firestore write sends a Document, not bare fields ===');
{
    // pushState (the save path in production use) has always wrapped its body
    // in `fields`. PVP and trade did not, which Firestore rejects — and neither
    // had ever been run in a browser, so nothing caught it.
    const offenders = [];
    for (const f of ['cache.js', 'pvp.js', 'trade.js', 'firestore.js']) {
        const src = fs.readFileSync(R + 'background/' + f, 'utf8');
        for (const m of src.matchAll(/method:\s*'PATCH'[\s\S]{0,260}?body:\s*JSON\.stringify\(([^)]*)\)/g)) {
            const arg = m[1].trim();
            const wrapped = arg.startsWith('{ fields') || arg.startsWith('{fields') || arg === 'body';
            if (!wrapped) offenders.push(`${f}: ${arg.slice(0, 50)}`);
        }
    }
    check('no PATCH sends bare fields', offenders.length === 0, offenders.join(' | '));

    // The save path moved from PATCH to :commit so it could carry an
    // updateTransform for the server timestamp the wallet rule depends on. The
    // Document still has to be wrapped — one level deeper now, inside the write.
    const fs2 = fs.readFileSync(R + 'background/firestore.js', 'utf8');
    check('the save path still wraps its fields in a Document',
        /writes:\s*\[\{\s*\n\s*update:\s*\{[\s\S]{0,120}?fields:\s*\{/.test(fs2));
    check('and still asks the server to stamp the time the rule trusts',
        /updateTransforms:\s*\[[\s\S]{0,160}?setToServerValue:\s*'REQUEST_TIME'/.test(fs2));
}

console.log('\n=== auth reads are memoised, and invalidated on change ===');
{
    const src = fs.readFileSync(R + 'background/auth.js', 'utf8');
    check('readAuth goes through a cache', /authMemo\.through/.test(src));
    check('writeAuth invalidates it', /writeAuth[\s\S]{0,160}authMemo\.delete/.test(src));
    check('clearAuth invalidates it', /clearAuth[\s\S]{0,120}authMemo\.delete/.test(src));
    check('the memo cannot outlive a token',
        /createMemoCache\((\d+)\)/.test(src) && Number(/createMemoCache\((\d+)\)/.exec(src)[1]) <= 60000,
        'a long TTL could serve a token past its refresh');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
