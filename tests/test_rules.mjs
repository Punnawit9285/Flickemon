/**
 * The security rules, executed rather than read.
 * ──────────────────────────────────────────────
 * Every other suite in this repo asserts what firestore.rules SAYS. This one
 * runs it: the real file, loaded into the Firestore emulator, answering real
 * requests from fake students.
 *
 * That distinction is the whole point. `firestore.rules` is the only privacy
 * boundary this project has — every client-side check can be edited out by
 * anyone running the extension unpacked — so a rule nobody has executed is a
 * promise nobody has kept.
 *
 * Needs the emulator, which needs Java:
 *
 *     ./tests/rules.sh
 *
 * Without it this file skips rather than fails, so `./tests/run.sh` still works
 * on a machine with no JVM. A skip is printed loudly; silence would be worse
 * than a failure, because it looks like success.
 */
import fs from 'node:fs';
import net from 'node:net';

const ROOT = new URL('..', import.meta.url).pathname;
const HOST = '127.0.0.1';
const PORT = Number((process.env.FIRESTORE_EMULATOR_HOST || '').split(':')[1] || 8080);

/** Is anything listening? Cheaper and clearer than catching an SDK timeout. */
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
    console.log('        These are the only tests that execute firestore.rules rather');
    console.log('        than reading it. Run them with:  ./tests/rules.sh');
    console.log('SKIPPED');
    process.exit(0);
}

const { initializeTestEnvironment, assertFails, assertSucceeds } =
    await import('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } =
    await import('firebase/firestore');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

/** Ran without throwing => the rules allowed it. */
const allowed = async p => { try { await assertSucceeds(p); return true; } catch { return false; } };
const denied  = async p => { try { await assertFails(p);    return true; } catch { return false; } };

const env = await initializeTestEnvironment({
    projectId: 'flickemon-rules-test',
    firestore: { rules: fs.readFileSync(ROOT + 'firestore.rules', 'utf8'), host: HOST, port: PORT },
});
await env.clearFirestore();

// Two students, one outsider, and the shapes the extension really writes.
const A = 'uid_alice', B = 'uid_bob', C = 'uid_carol';
const student = (uid, email) =>
    env.authenticatedContext(uid, { email, email_verified: true }).firestore();
const alice = student(A, 'alice@docchula.com');
const bob   = student(B, 'bob@docchula.com');
const carol = student(C, 'carol@docchula.com');
const anon  = env.unauthenticatedContext().firestore();

/** Seed documents the rules would not let a client create. */
const seed = fn => env.withSecurityRulesDisabled(ctx => fn(ctx.firestore()));

const pairKey = (x, y) => [x, y].sort().join('_');

console.log('\n=== who counts as a student ===');
{
    await seed(db => setDoc(doc(db, 'profiles', A), { username: 'alice' }));

    check('a signed-in student may read a profile', await allowed(getDoc(doc(alice, 'profiles', A))));
    check('an unauthenticated reader may not', await denied(getDoc(doc(anon, 'profiles', A))));

    const outsider = env.authenticatedContext('uid_x',
        { email: 'someone@gmail.com', email_verified: true }).firestore();
    check('a non-docchula address may not — the domain check is server-side',
        await denied(getDoc(doc(outsider, 'profiles', A))));

    const unverified = env.authenticatedContext('uid_y',
        { email: 'y@docchula.com', email_verified: false }).firestore();
    check('an unverified address may not',
        await denied(getDoc(doc(unverified, 'profiles', A))));
}

console.log('\n=== saves stay private ===');
{
    await seed(db => setDoc(doc(db, 'saves', A), { party: [], moneyEarned: 0, moneySpent: 0 }));
    check('a student reads their own save', await allowed(getDoc(doc(alice, 'saves', A))));
    check('nobody reads another student\'s save', await denied(getDoc(doc(bob, 'saves', A))));
    check('nobody writes another student\'s save',
        await denied(setDoc(doc(bob, 'saves', A), { party: ['stolen'] })));
}

console.log('\n=== the wallet ceiling, enforced on the server ===');
{
    // These rules are what stop forged money being PERSISTED. They are also the
    // easiest rules in the file to get wrong in a way that locks every student
    // out of syncing, which is why they are worth executing rather than
    // reasoning about.
    const HOUR = 3600000;
    const save = (extra = {}) => ({ email: 'alice@docchula.com', state: '{}', ...extra });

    // A first save has no history to be measured against.
    await seed(db => deleteDoc(doc(db, 'saves', A)));
    check('a first save is allowed whatever it claims',
        await allowed(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 500, moneySpent: 0, serverAt: serverTimestamp() }))));

    // serverAt must BE the commit time. A client that could back-date it would
    // hand itself an arbitrarily large allowance on the following write.
    check('serverAt cannot be back-dated',
        await denied(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 500, moneySpent: 0,
                   serverAt: Timestamp.fromMillis(Date.now() - 30 * 24 * HOUR) }))));
    check('nor set to any client-chosen value',
        await denied(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 500, moneySpent: 0, serverAt: Timestamp.fromMillis(Date.now()) }))));

    // One hour of history => 240/hour plus the rounding allowance.
    const withHistory = (earned, spent = 0) => seed(db => setDoc(doc(db, 'saves', A),
        save({ moneyEarned: earned, moneySpent: spent,
               serverAt: Timestamp.fromMillis(Date.now() - HOUR) })));

    await withHistory(1000);
    check('an hour of play may earn within the ceiling',
        await allowed(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 1200, moneySpent: 0, serverAt: serverTimestamp() }))));

    await withHistory(1000);
    check('but not beyond it — forged money never persists',
        await denied(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 9999, moneySpent: 0, serverAt: serverTimestamp() }))));

    await withHistory(1000, 400);
    check('earnings cannot be walked backwards',
        await denied(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 200, moneySpent: 400, serverAt: serverTimestamp() }))));
    check('and neither can spending — un-spending is minting',
        await denied(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 1000, moneySpent: 0, serverAt: serverTimestamp() }))));

    check('the counters cannot be dropped to escape the ceiling',
        await denied(setDoc(doc(alice, 'saves', A), save({ serverAt: serverTimestamp() }))));

    // A save written before serverAt existed has no trustworthy clock, so it
    // falls back to a coarse per-write ceiling rather than locking that student
    // out of syncing entirely.
    await seed(db => setDoc(doc(db, 'saves', A), save({ moneyEarned: 1000, moneySpent: 0 })));
    check('a legacy save with no serverAt still syncs',
        await allowed(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 1500, moneySpent: 0, serverAt: serverTimestamp() }))));

    await seed(db => setDoc(doc(db, 'saves', A), save({ moneyEarned: 1000, moneySpent: 0 })));
    check('but the fallback is still a ceiling',
        await denied(setDoc(doc(alice, 'saves', A),
            save({ moneyEarned: 99999, moneySpent: 0, serverAt: serverTimestamp() }))));

    // A save that carries no wallet at all is untouched by any of this.
    await seed(db => deleteDoc(doc(db, 'saves', A)));
    check('a save with no wallet fields is unaffected',
        await allowed(setDoc(doc(alice, 'saves', A), save({ serverAt: serverTimestamp() }))));
}

console.log('\n=== a username cannot be taken from its holder ===');
{
    check('claiming a free name with your own uid',
        await allowed(setDoc(doc(alice, 'usernames', 'alice'), { uid: A })));
    check('claiming one in someone else\'s name is refused',
        await denied(setDoc(doc(bob, 'usernames', 'bobby'), { uid: A })));
    check('a held name cannot be repointed by anyone else',
        await denied(setDoc(doc(bob, 'usernames', 'alice'), { uid: B })));
    check('the holder may release their own',
        await allowed(deleteDoc(doc(alice, 'usernames', 'alice'))));
}

console.log('\n=== email lookup reveals only hashes ===');
{
    const hash = 'a'.repeat(64);
    check('a student registers their own hash',
        await allowed(setDoc(doc(alice, 'emailKeys', hash), { uid: A })));
    check('nobody can point someone else\'s hash at themselves',
        await denied(setDoc(doc(bob, 'emailKeys', hash), { uid: B })));
}

console.log('\n=== profiles are cohort-readable but owner-written ===');
{
    check('a student writes their own profile',
        await allowed(setDoc(doc(alice, 'profiles', A), { username: 'alice' })));
    check('and cannot write anyone else\'s',
        await denied(setDoc(doc(bob, 'profiles', A), { username: 'not-alice' })));
    check('but may read it', await allowed(getDoc(doc(bob, 'profiles', A))));
}

console.log('\n=== friendship: request and accept, with members pinned ===');
{
    const key = pairKey(A, B);
    check('a request names you as the asker and is not pre-accepted',
        await allowed(setDoc(doc(alice, 'friendships', key),
            { members: [A, B].sort(), requestedBy: A, accepted: false, blockedBy: [] })));

    check('you cannot accept your own request at creation time',
        await denied(setDoc(doc(alice, 'friendships', pairKey(A, C)),
            { members: [A, C].sort(), requestedBy: A, accepted: true, blockedBy: [] })));

    check('you cannot forge a request from someone else',
        await denied(setDoc(doc(bob, 'friendships', pairKey(B, C)),
            { members: [B, C].sort(), requestedBy: C, accepted: false, blockedBy: [] })));

    check('a stranger cannot read the friendship',
        await denied(getDoc(doc(carol, 'friendships', key))));
    check('a member can', await allowed(getDoc(doc(bob, 'friendships', key))));

    check('the other side accepts',
        await allowed(updateDoc(doc(bob, 'friendships', key), { accepted: true })));

    // The rule that stops a friendship being rewritten into someone else's.
    check('members cannot be rewritten — the door to a stranger\'s feed',
        await denied(updateDoc(doc(bob, 'friendships', key), { members: [B, C].sort() })));
    check('requestedBy cannot be rewritten',
        await denied(updateDoc(doc(bob, 'friendships', key), { requestedBy: B })));

    check('either side may walk away',
        await allowed(deleteDoc(doc(bob, 'friendships', key))));
}

console.log('\n=== the feed audience gate — the headline privacy claim ===');
{
    // Alice publishes, having approved Bob and not Carol.
    await seed(db => setDoc(doc(db, 'feeds', A), {
        audience: [B],
        payload: JSON.stringify({ todayExp: 400, mon: { name: 'Pikachu' } }),
    }));

    check('the owner reads their own feed', await allowed(getDoc(doc(alice, 'feeds', A))));
    check('an approved friend reads it', await allowed(getDoc(doc(bob, 'feeds', A))));
    check('a student NOT in the audience is refused by the server',
        await denied(getDoc(doc(carol, 'feeds', A))));

    check('nobody can write into another student\'s feed',
        await denied(setDoc(doc(bob, 'feeds', A), { audience: [B], payload: '{}' })));
    check('and so cannot add themselves to its audience',
        await denied(updateDoc(doc(carol, 'feeds', A), { audience: [B, C] })));

    // Blocking is removal from the audience, so it must actually take effect.
    await seed(db => setDoc(doc(db, 'feeds', A), { audience: [], payload: '{}' }));
    check('once removed from the audience, a former friend loses the read',
        await denied(getDoc(doc(bob, 'feeds', A))));
}

console.log('\n=== the leaderboard is opt-in and owner-only ===');
{
    const row = { label: 'alice', dayKey: '2026-09-03', todayExp: 900, levels: 2, streak: 4 };

    check('a student publishes their own row', await allowed(setDoc(doc(alice, 'leaderboard', A), row)));
    check('the cohort may read it', await allowed(getDoc(doc(carol, 'leaderboard', A))));
    check('nobody can post a row for someone else',
        await denied(setDoc(doc(bob, 'leaderboard', C), { ...row, label: 'carol' })));
    check('nobody can inflate a rival\'s score',
        await denied(updateDoc(doc(bob, 'leaderboard', A), { todayExp: 999999 })));
    check('nobody can delete a rival off the board',
        await denied(deleteDoc(doc(bob, 'leaderboard', A))));
    check('leaving is the owner deleting their own row',
        await allowed(deleteDoc(doc(alice, 'leaderboard', A))));
    // Opt-in means absence, not a zeroed row: a student who never joined is
    // one the board cannot rank even though anyone may look.
    check('a student who never joined has no row at all',
        (await getDoc(doc(carol, 'leaderboard', C))).exists() === false);
}

console.log('\n=== anything not matched above is unreachable ===');
{
    check('an unknown collection is denied',
        await denied(getDoc(doc(alice, 'somethingElse', 'x'))));
    check('and cannot be written',
        await denied(setDoc(doc(alice, 'somethingElse', 'x'), { a: 1 })));
}

await env.cleanup();
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
