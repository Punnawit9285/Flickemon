/**
 * Local caches
 * ────────────
 * Anything the extension would otherwise fetch twice.
 *
 * MV3 evicts this worker after ~30s idle, which takes every in-memory cache
 * with it. That is a feature rather than a problem: these caches exist to
 * collapse bursts — the read a poll just did and the read the resulting user
 * action would repeat — not to hold state across sessions. Anything that must
 * survive eviction belongs in chrome.storage.local instead.
 *
 * What is deliberately NOT cached:
 *   - the poll loop's own reads, which exist precisely to see changes;
 *   - a negative admin check, because that is the case where the student is
 *     waiting for access to be granted and a cached "no" would strand them.
 */

/** In-memory value cache with a per-entry TTL. */
export function createMemoCache(defaultTtlMs) {
    const entries = new Map();

    return {
        get(key) {
            const hit = entries.get(key);
            if (!hit) return undefined;
            if (hit.expiresAt <= Date.now()) {
                entries.delete(key);
                return undefined;
            }
            return hit.value;
        },
        set(key, value, ttlMs = defaultTtlMs) {
            entries.set(key, { value, expiresAt: Date.now() + ttlMs });
            return value;
        },
        delete(key) { entries.delete(key); },
        clear() { entries.clear(); },
        /** Resolves through the cache, running `produce` only on a miss. */
        async through(key, produce, ttlMs = defaultTtlMs) {
            const hit = this.get(key);
            if (hit !== undefined) return hit;
            const value = await produce();
            if (value !== undefined) this.set(key, value, ttlMs);
            return value;
        },
    };
}

/**
 * A cache that survives the worker being evicted.
 *
 * MV3 tears the service worker down after ~30s idle, which throws away every
 * createMemoCache above. For a burst that is fine and is the stated design. It
 * is NOT fine for anything read on a cadence SLOWER than 30s — a friend's feed
 * polled every 90s, or a leaderboard someone flips back to — because the
 * in-memory copy is always gone by the time it would have been used, and the
 * cache silently never hits.
 *
 * chrome.storage.session is the right home for those: memory-backed, never
 * written to disk, cleared when the browser closes, and shared across worker
 * lifetimes. Reads are the metered resource here, so a cache that actually
 * survives to be hit is worth the async.
 */
export function createSessionCache(namespace, defaultTtlMs) {
    const memory = new Map();          // fallback when storage.session is absent
    const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session)
        ? chrome.storage.session : null;
    const keyOf = (key) => `cache:${namespace}:${key}`;

    return {
        async get(key) {
            const k = keyOf(key);
            let hit;
            if (store) {
                const data = await store.get([k]);
                hit = data && data[k];
            } else {
                hit = memory.get(k);
            }
            if (!hit) return undefined;
            if (hit.expiresAt <= Date.now()) {
                await this.delete(key);
                return undefined;
            }
            return hit.value;
        },
        async set(key, value, ttlMs = defaultTtlMs) {
            const entry = { value, expiresAt: Date.now() + ttlMs };
            if (store) await store.set({ [keyOf(key)]: entry });
            else memory.set(keyOf(key), entry);
            return value;
        },
        async delete(key) {
            if (store) await store.remove([keyOf(key)]);
            else memory.delete(keyOf(key));
        },
        /** Resolves through the cache, running `produce` only on a miss. */
        async through(key, produce, { fresh = false, ttlMs = defaultTtlMs } = {}) {
            if (fresh) await this.delete(key);
            else {
                const hit = await this.get(key);
                if (hit !== undefined) return hit;
            }
            const value = await produce();
            if (value !== undefined) await this.set(key, value, ttlMs);
            return value;
        },
    };
}

// ─────────────────────── Shared Firestore documents ───────────────────────
//
// battles/{code} and trades/{code} are read by a poll every couple of seconds
// and then read AGAIN by whatever the student does next, because every write
// is a read-modify-write on state the other player also edits. That second read
// is pure waste against a metered quota.
//
// Serving it from a cache is only safe because every write now carries the
// document version it was based on. A write built on a stale copy is rejected
// by the server rather than quietly overwriting the other player's move — so
// the cache can be wrong without anything being lost, which is the property
// that makes caching shared mutable state defensible at all.

const DOC_CACHE_TTL_MS = 2500;   // just over one poll interval
const docCache = createMemoCache(DOC_CACHE_TTL_MS);

export function invalidateDoc(url) {
    docCache.delete(url);
}

/**
 * Reads a Firestore document, optionally from cache.
 * Returns { doc, updateTime } or null when the document does not exist.
 */
export async function readDoc(url, idToken, { fresh = false } = {}) {
    if (fresh) docCache.delete(url);

    return await docCache.through(url, async () => {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
        if (res.status === 404) return null;
        if (!res.ok) {
            // The status rides along, so a caller can tell "the rules refused"
            // from "the network failed" without parsing the message.
            const err = new Error(`Could not read (${res.status})`);
            err.status = res.status;
            throw err;
        }
        const doc = await res.json();
        return { doc, updateTime: doc.updateTime || null };
    });
}

/**
 * Where a document URL is committed to, and the name a commit addresses it by.
 * `.../v1/projects/P/databases/(default)/documents/col/id` becomes the commit
 * endpoint and `projects/P/databases/(default)/documents/col/id`.
 */
function commitTarget(url) {
    const at = url.indexOf('/documents/');
    const root = url.slice(0, at);
    const path = url.slice(at + '/documents/'.length).split('?')[0]
        .split('/').map(decodeURIComponent).join('/');
    const project = root.slice(root.indexOf('/v1/') + 4);
    return { commitUrl: `${root}/documents:commit`, name: `${project}/documents/${path}` };
}

/** Did the server refuse a write because the document moved under it? */
async function isConflict(res) {
    if (res.status === 409 || res.status === 412) return true;
    if (res.status !== 400) return false;
    const body = await res.json().catch(() => null);
    const status = body && (Array.isArray(body) ? body[0] : body).error;
    return Boolean(status && status.status === 'FAILED_PRECONDITION');
}

/**
 * Read-modify-write against a shared document.
 *
 * `transform(current)` returns the fields to write, or null to abort. The write
 * is conditional on the version that was read; if the other player changed the
 * document in between, the server rejects it and this retries once against a
 * guaranteed-fresh copy. One retry is enough — two clients cannot livelock when
 * each only writes on its own turn.
 *
 * Sent as a commit with a precondition -- the document's update time, or "does
 * not exist yet" -- rather than a PATCH carrying `currentDocument.updateTime`.
 * The PATCH form was answered by the Firestore emulator as a CREATE, so the
 * rules judged an edit to somebody else's document by the create rule and
 * refused it: accepting a friend request failed every time. The commit form is
 * judged as the update it is, and is what the save path already uses.
 */
export async function mutateDoc(url, idToken, transform) {
    const { commitUrl, name } = commitTarget(url);
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await readDoc(url, idToken, { fresh: attempt > 0 });
        const fields = await transform(current);
        if (!fields) return { ok: false, aborted: true };

        const res = await fetch(commitUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ writes: [{
                update: { name, fields },
                currentDocument: current && current.updateTime
                    ? { updateTime: current.updateTime }
                    : { exists: false },
            }] }),
        });

        if (res.ok) {
            const out = await res.json().catch(() => null);
            const updateTime = (out && out.writeResults && out.writeResults[0]
                                && out.writeResults[0].updateTime) || (out && out.commitTime) || null;
            const doc = { name, fields, updateTime };
            docCache.set(url, { doc, updateTime });
            return { ok: true, doc };
        }

        // Someone else wrote first. Drop the stale copy and rebuild.
        if (await isConflict(res)) {
            docCache.delete(url);
            continue;
        }
        const err = new Error(`Could not write (${res.status})`);
        err.status = res.status;
        throw err;
    }

    return { ok: false, conflict: true };
}
