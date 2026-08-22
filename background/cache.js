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
        if (!res.ok) throw new Error(`Could not read (${res.status})`);
        const doc = await res.json();
        return { doc, updateTime: doc.updateTime || null };
    });
}

/**
 * Read-modify-write against a shared document.
 *
 * `transform(current)` returns the fields to write, or null to abort. The write
 * is conditional on the version that was read; if the other player changed the
 * document in between, the server rejects it and this retries once against a
 * guaranteed-fresh copy. One retry is enough — two clients cannot livelock when
 * each only writes on its own turn.
 */
export async function mutateDoc(url, idToken, transform) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = await readDoc(url, idToken, { fresh: attempt > 0 });
        const fields = await transform(current);
        if (!fields) return { ok: false, aborted: true };

        const target = current && current.updateTime
            ? `${url}?currentDocument.updateTime=${encodeURIComponent(current.updateTime)}`
            : url;

        const res = await fetch(target, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields }),
        });

        if (res.ok) {
            const doc = await res.json();
            docCache.set(url, { doc, updateTime: doc.updateTime || null });
            return { ok: true, doc };
        }

        // 409/412: someone else wrote first. Drop the stale copy and rebuild.
        if (res.status === 409 || res.status === 412) {
            docCache.delete(url);
            continue;
        }
        throw new Error(`Could not write (${res.status})`);
    }

    return { ok: false, conflict: true };
}
