/**
 * Friends, over Firestore REST
 * ────────────────────────────
 * Six collections, because Firestore security rules gate whole DOCUMENTS and
 * cannot filter fields. That single fact decides the entire shape of this file:
 *
 *     Publish what you chose to share. Never publish and hide.
 *
 * A privacy toggle here does not tell anyone's client to look away — it changes
 * what is written. A field turned off is absent from the document; a blocked
 * friend is absent from `audience`, so the read is refused by Google's servers
 * rather than by our renderer. The extension runs on the student's own machine
 * and can be edited freely, so anything enforced in here would be enforced by
 * the attacker. Only firestore.rules is real.
 *
 *   usernames/{lowercased}   a claim on a name
 *   emailKeys/{sha256}       find someone by an address you already know
 *   profiles/{uid}           name and avatar, cohort-readable, no email
 *   friendships/{pairKey}    one document per pair, either side may act
 *   feeds/{uid}              what this student publishes, plus its audience
 *   leaderboard/{uid}        opt-in, cohort-readable, a label and a score
 *
 * ── The email is never stored ──
 *
 * Looking someone up by address uses a SHA-256 of it as a document id. You can
 * find a person whose email you already know, and reading the whole collection
 * tells you nothing but hashes — no cohort to enumerate, no addresses to leak.
 *
 * ── Quota ──
 *
 * The free tier allows 50,000 reads and 20,000 writes a day across every
 * student. Friends' feeds are read only while the panel is open, the friendship
 * list is cached for the session because it changes only when someone is added
 * or removed, and the global board is ONE ordered query returning at most 25
 * documents however large the faculty gets. Reading every student's feed
 * instead would be 100 reads per view and 100,000 a day.
 */

import {
    FIREBASE_CONFIG, USERNAMES_COLLECTION, EMAIL_KEYS_COLLECTION,
    PROFILES_COLLECTION, FRIENDSHIPS_COLLECTION, FEEDS_COLLECTION,
    LEADERBOARD_COLLECTION,
} from './firebase-config.js';
import { getIdToken } from './auth.js';
import { readDoc, mutateDoc, invalidateDoc, createMemoCache } from './cache.js';

const BASE = () => `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}`
                 + `/databases/(default)/documents`;

const docUrl = (collection, id) => `${BASE()}/${collection}/${encodeURIComponent(id)}`;

/** Rows the global board returns. A screenful; the rest is nobody's business. */
export const LEADERBOARD_LIMIT = 25;

/**
 * The board changes slowly and is read by everyone, so it is the one thing here
 * worth caching hard. Five minutes turns a student refreshing impatiently into
 * one query instead of twenty.
 */
const BOARD_CACHE_TTL_MS = 5 * 60 * 1000;
const boardCache = createMemoCache(BOARD_CACHE_TTL_MS);

async function auth() {
    const a = await getIdToken();
    if (!a) throw new Error('Sign in to use friends.');
    return a;
}

// ─────────────────────────── Firestore values ───────────────────────────

const S = (v) => ({ stringValue: String(v == null ? '' : v) });
const B = (v) => ({ booleanValue: Boolean(v) });
const I = (v) => ({ integerValue: String(Math.round(Number(v) || 0)) });
const A = (list) => ({ arrayValue: { values: (list || []).map(S) } });

const readS = (f, k) => (f && f[k] && f[k].stringValue) || '';
const readB = (f, k) => Boolean(f && f[k] && f[k].booleanValue);
const readI = (f, k) => Number((f && f[k] && f[k].integerValue) || 0);
const readA = (f, k) => ((f && f[k] && f[k].arrayValue && f[k].arrayValue.values) || [])
    .map(v => v.stringValue).filter(Boolean);

// ─────────────────────────── Identity ───────────────────────────

/**
 * The document id an email is found under.
 *
 * Hashed rather than stored so that this collection is useless to anyone who
 * reads all of it: to find a student you must already know their address.
 * Available in the worker and in a content script alike.
 */
export async function emailKey(email) {
    const norm = String(email || '').trim().toLowerCase();
    if (!norm) return '';
    const bytes = new TextEncoder().encode(norm);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One document per pair, whichever side is acting.
 *
 * Sorted, so A→B and B→A address the same document. Without that, two people
 * adding each other at the same moment would create two friendships and each
 * would see one pending request that the other had apparently never sent.
 */
export function pairKey(a, b) {
    return [String(a), String(b)].sort().join('_');
}

/**
 * Claims a username, or moves an existing claim to a new name.
 *
 * `create` is used rather than a blind write, because Firestore's create fails
 * when the document already exists — which is exactly "somebody has this name"
 * and is decided by the server rather than by a check we could lose a race to.
 */
export async function claimUsername(name) {
    const a = await auth();
    const key = String(name || '').trim().toLowerCase();
    if (!key) throw new Error('Pick a name first.');

    const url = docUrl(USERNAMES_COLLECTION, key);
    invalidateDoc(url);

    // createDocument, so an existing name is refused by the server.
    const createUrl = `${BASE()}/${USERNAMES_COLLECTION}?documentId=${encodeURIComponent(key)}`;
    const res = await fetch(createUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { uid: S(a.uid), name: S(key) } }),
    });

    if (res.status === 409) {
        // Already ours is success, not a clash — someone re-saving the same name.
        const existing = await readDoc(url, a.idToken, { fresh: true });
        if (existing && readS(existing.doc.fields, 'uid') === a.uid) {
            return { ok: true, name: key, unchanged: true };
        }
        return { ok: false, reason: 'taken' };
    }
    if (!res.ok) throw new Error(`Could not claim that name (${res.status})`);

    // The profile is what other people read, so it follows the claim. Best
    // effort: a claimed name with a stale profile is recoverable, a lost claim
    // is not, so the claim goes first and this cannot undo it.
    await writeProfile({ username: key }).catch(() => {});
    return { ok: true, name: key };
}

/** Releases a name so somebody else may take it. */
export async function releaseUsername(name) {
    const a = await auth();
    const key = String(name || '').trim().toLowerCase();
    if (!key) return { ok: true };
    const url = docUrl(USERNAMES_COLLECTION, key);
    invalidateDoc(url);
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${a.idToken}` },
    });
    return { ok: res.ok || res.status === 404 };
}

/**
 * This student's public card: what a friend, or the person receiving their
 * request, sees. Cohort-readable, so it deliberately carries no email and no
 * progress — only a name they chose and a Pokémon they picked.
 */
export async function writeProfile({ username, avatarSpeciesId, avatarShiny } = {}) {
    const a = await auth();
    const url = docUrl(PROFILES_COLLECTION, a.uid);
    invalidateDoc(url);

    const res = await mutateDoc(url, a.idToken, (current) => {
        const f = (current && current.doc.fields) || {};
        return {
            uid: S(a.uid),
            username: S(username !== undefined ? username : readS(f, 'username')),
            avatarSpeciesId: I(avatarSpeciesId !== undefined
                ? avatarSpeciesId : readI(f, 'avatarSpeciesId')),
            avatarShiny: B(avatarShiny !== undefined
                ? avatarShiny : readB(f, 'avatarShiny')),
            updatedAt: I(Date.now()),
        };
    });
    // The email key points at this uid so an address can find it later. Written
    // here rather than at sign-in because this is the first moment the student
    // has asked to be findable at all.
    await ensureEmailKey(a).catch(() => {});
    return { ok: Boolean(res && res.ok) };
}

async function ensureEmailKey(a) {
    if (!a.email) return;
    const key = await emailKey(a.email);
    if (!key) return;
    const url = docUrl(EMAIL_KEYS_COLLECTION, key);
    await mutateDoc(url, a.idToken, () => ({ uid: S(a.uid) }));
}

export async function readProfile(uid) {
    const a = await auth();
    const current = await readDoc(docUrl(PROFILES_COLLECTION, uid), a.idToken);
    if (!current) return null;
    const f = current.doc.fields || {};
    return {
        uid: readS(f, 'uid') || uid,
        username: readS(f, 'username'),
        avatarSpeciesId: readI(f, 'avatarSpeciesId'),
        avatarShiny: readB(f, 'avatarShiny'),
    };
}

/** Finds a student by the name they published, or by an address you know. */
export async function lookup({ username, email }) {
    const a = await auth();

    let uid = '';
    if (username) {
        const key = String(username).trim().toLowerCase();
        const found = await readDoc(docUrl(USERNAMES_COLLECTION, key), a.idToken);
        uid = found ? readS(found.doc.fields, 'uid') : '';
        if (!uid) return { found: false, reason: 'no-such-name' };
    } else if (email) {
        const key = await emailKey(email);
        const found = key
            ? await readDoc(docUrl(EMAIL_KEYS_COLLECTION, key), a.idToken)
            : null;
        uid = found ? readS(found.doc.fields, 'uid') : '';
        // Deliberately the same wording as a wrong name: confirming that an
        // address exists but has never opened the game is more than a stranger
        // needs to know.
        if (!uid) return { found: false, reason: 'no-such-name' };
    } else {
        return { found: false, reason: 'no-query' };
    }

    if (uid === a.uid) return { found: false, reason: 'self' };
    const profile = await readProfile(uid);
    return { found: true, uid, profile };
}

// ─────────────────────────── Friendships ───────────────────────────

function friendshipFrom(doc, key) {
    const f = doc.fields || {};
    return {
        pairKey: key,
        members: readA(f, 'members'),
        requestedBy: readS(f, 'requestedBy'),
        accepted: readB(f, 'accepted'),
        blockedBy: readA(f, 'blockedBy'),
        createdAt: readI(f, 'createdAt'),
    };
}

function friendshipFields(o) {
    return {
        members: A(o.members),
        requestedBy: S(o.requestedBy),
        accepted: B(o.accepted),
        blockedBy: A(o.blockedBy || []),
        createdAt: I(o.createdAt || Date.now()),
    };
}

/** Sends a request. Accepting one that was already sent the other way. */
export async function requestFriend(otherUid) {
    const a = await auth();
    if (!otherUid || otherUid === a.uid) return { ok: false, reason: 'self' };

    const key = pairKey(a.uid, otherUid);
    const url = docUrl(FRIENDSHIPS_COLLECTION, key);
    let outcome = 'requested';

    const res = await mutateDoc(url, a.idToken, (current) => {
        if (current) {
            const existing = friendshipFrom(current.doc, key);
            if (existing.accepted) { outcome = 'already'; return null; }
            // They asked first and we are now asking back, which is an accept
            // in every way that matters. Doing it here means two people adding
            // each other simultaneously become friends instead of deadlocking
            // on two pending requests.
            if (existing.requestedBy !== a.uid) {
                outcome = 'accepted';
                return friendshipFields({ ...existing, accepted: true });
            }
            outcome = 'pending';
            return null;
        }
        return friendshipFields({
            members: [a.uid, otherUid].sort(),
            requestedBy: a.uid,
            accepted: false,
            blockedBy: [],
            createdAt: Date.now(),
        });
    });

    if (!res.ok && !res.aborted) throw new Error('Could not send that request.');
    return { ok: true, outcome, pairKey: key };
}

/** Accepts a request somebody else sent. */
export async function acceptFriend(otherUid) {
    const a = await auth();
    const key = pairKey(a.uid, otherUid);

    let ok = false;
    await mutateDoc(docUrl(FRIENDSHIPS_COLLECTION, key), a.idToken, (current) => {
        if (!current) return null;
        const existing = friendshipFrom(current.doc, key);
        // Accepting your own request would make anyone a friend of anyone.
        if (existing.requestedBy === a.uid || existing.accepted) return null;
        ok = true;
        return friendshipFields({ ...existing, accepted: true });
    });
    return { ok };
}

/** Declines, cancels, or unfriends — all the same document, all a delete. */
export async function removeFriend(otherUid) {
    const a = await auth();
    const key = pairKey(a.uid, otherUid);
    const url = docUrl(FRIENDSHIPS_COLLECTION, key);
    invalidateDoc(url);
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${a.idToken}` },
    });
    if (!res.ok && res.status !== 404) throw new Error('Could not remove that friend.');
    return { ok: true };
}

/**
 * Every friendship this account is part of, pending ones included.
 *
 * The one query in the feature. `array-contains` on members needs only the
 * single-field index Firestore builds automatically, so this works with no
 * index deployment — unlike the leaderboard below.
 */
export async function listFriendships() {
    const a = await auth();
    const res = await fetch(`${BASE()}:runQuery`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: FRIENDSHIPS_COLLECTION }],
                where: {
                    fieldFilter: {
                        field: { fieldPath: 'members' },
                        op: 'ARRAY_CONTAINS',
                        value: { stringValue: a.uid },
                    },
                },
                limit: 200,
            },
        }),
    });
    if (!res.ok) throw new Error(`Could not load your friends (${res.status})`);

    const rows = await res.json();
    const out = [];
    for (const row of rows) {
        if (!row.document) continue;
        const key = row.document.name.split('/').pop();
        const fs = friendshipFrom(row.document, key);
        const other = fs.members.find(m => m !== a.uid);
        if (!other) continue;
        out.push({
            ...fs,
            uid: other,
            // Which side is waiting on whom, worked out here so the panel does
            // not have to know the document's shape.
            incoming: !fs.accepted && fs.requestedBy !== a.uid,
            outgoing: !fs.accepted && fs.requestedBy === a.uid,
            blockedByThem: fs.blockedBy.includes(other),
        });
    }
    return { ok: true, friendships: out, me: a.uid };
}

// ─────────────────────────── The feed ───────────────────────────

/**
 * Publishes what this student has chosen to share.
 *
 * `audience` is the list of uids allowed to read the document, and the rule is
 * `request.auth.uid in resource.data.audience` — checked against this document
 * rather than by looking up the friendship, which would cost a read on every
 * evaluation and count against the rules engine's 10-lookup limit.
 *
 * `payload` contains only enabled fields. The caller decides what goes in it;
 * nothing here re-derives anything, because a field that is never written is a
 * field that cannot leak.
 */
export async function publishFeed({ audience, payload }) {
    const a = await auth();
    const url = docUrl(FEEDS_COLLECTION, a.uid);
    invalidateDoc(url);

    const res = await mutateDoc(url, a.idToken, () => ({
        uid: S(a.uid),
        audience: A(audience || []),
        updatedAt: I(Date.now()),
        payload: S(JSON.stringify(payload || {})),
    }));
    return { ok: Boolean(res && res.ok) };
}

/**
 * Reads friends' feeds.
 *
 * One read per friend, and only while the panel is open. A 403 or a 404 is an
 * ordinary answer rather than an error: it means that person has not shared
 * with us, or has not published yet, and the panel shows them as quiet.
 */
export async function readFeeds(uids) {
    const a = await auth();
    const wanted = [...new Set((uids || []).filter(Boolean))];

    const out = {};
    await Promise.all(wanted.map(async (uid) => {
        try {
            const current = await readDoc(docUrl(FEEDS_COLLECTION, uid), a.idToken, { fresh: true });
            if (!current) { out[uid] = null; return; }
            const f = current.doc.fields || {};
            let payload = {};
            try { payload = JSON.parse(readS(f, 'payload') || '{}'); } catch { payload = {}; }
            out[uid] = { uid, updatedAt: readI(f, 'updatedAt'), payload };
        } catch {
            out[uid] = null;
        }
    }));
    return { ok: true, feeds: out };
}

// ─────────────────────────── The global board ───────────────────────────

/**
 * Publishes this student's row, or removes it.
 *
 * Opt-in: with `joined` false the document is DELETED, not flagged hidden. A
 * row that does not exist cannot be read, ranked, or restored by a future bug —
 * which is a stronger promise than any field could make.
 *
 * `label` arrives already truncated. That matters: a full address must never
 * reach a document the whole cohort can read, so the shortening happens before
 * the write rather than at display time.
 */
export async function publishLeaderboard({ joined, label, dayKey, todayExp, levels, streak }) {
    const a = await auth();
    const url = docUrl(LEADERBOARD_COLLECTION, a.uid);
    invalidateDoc(url);
    boardCache.clear();

    if (!joined) {
        const res = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${a.idToken}` },
        });
        if (!res.ok && res.status !== 404) throw new Error('Could not leave the board.');
        return { ok: true, joined: false };
    }

    // Belt and braces on the promise above: even if a caller passed a whole
    // address, it does not go up.
    const safe = String(label || '').split('@')[0].slice(0, 24);

    const res = await mutateDoc(url, a.idToken, () => ({
        uid: S(a.uid),
        label: S(safe),
        dayKey: S(dayKey),
        todayExp: I(todayExp),
        levels: I(levels),
        streak: I(streak),
        updatedAt: I(Date.now()),
    }));
    return { ok: Boolean(res && res.ok), joined: true };
}

/**
 * Today's top rows.
 *
 * ONE query returning at most LEADERBOARD_LIMIT documents, so a view costs the
 * same whether the faculty is fifty students or five thousand — which is what
 * makes a global board affordable on the free tier at all.
 *
 * ⚠️ Needs the composite index in firestore.indexes.json. Firestore answers an
 * un-indexed ordered query with an ERROR, not an empty list, so a missing index
 * looks like a broken feature rather than an empty board.
 */
export async function readLeaderboard(dayKey) {
    const a = await auth();

    return await boardCache.through(`board:${dayKey}`, async () => {
        const res = await fetch(`${BASE()}:runQuery`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                structuredQuery: {
                    from: [{ collectionId: LEADERBOARD_COLLECTION }],
                    where: {
                        fieldFilter: {
                            field: { fieldPath: 'dayKey' },
                            op: 'EQUAL',
                            value: { stringValue: dayKey },
                        },
                    },
                    orderBy: [{ field: { fieldPath: 'todayExp' }, direction: 'DESCENDING' }],
                    limit: LEADERBOARD_LIMIT,
                },
            }),
        });
        if (!res.ok) {
            const body = await res.text();
            // The one failure worth naming, because the fix is a deploy rather
            // than anything in the code.
            if (/index/i.test(body)) {
                throw new Error('The leaderboard index has not been deployed yet.');
            }
            throw new Error(`Could not load the board (${res.status})`);
        }

        const rows = await res.json();
        const board = [];
        for (const row of rows) {
            if (!row.document) continue;
            const f = row.document.fields || {};
            board.push({
                uid: readS(f, 'uid') || row.document.name.split('/').pop(),
                label: readS(f, 'label'),
                todayExp: readI(f, 'todayExp'),
                levels: readI(f, 'levels'),
                streak: readI(f, 'streak'),
            });
        }
        return { ok: true, board, me: a.uid };
    });
}
