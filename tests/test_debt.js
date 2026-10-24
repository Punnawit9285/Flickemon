const ROOT = require('path').join(__dirname, '..') + '/';
/**
 * Instant-capture debt: what it costs, where it stops, and that it stays paid.
 * ───────────────────────────────────────────────────────────────────────────
 * The debt used to be one number merged newest-write-wins. Two Flick tabs on
 * one computer each held the save, and the one opened before a catch-now wrote
 * its copy back over the debt; a slot switch then read that copy and the debt
 * was gone. It is a ledger now -- owed and paid per device, both only ever
 * counting up -- and these run two engines against one disk and one cloud to
 * show that no copy, however stale, can make it smaller.
 *
 * Also the ceiling: catch now cannot take the debt past EXP_DEBT_MAX, and a
 * save already over it catches nothing and earns no EXP until it is paid down.
 */
const store = {};
global.window = { addEventListener() {} };
global.chrome = {
    storage: {
        local: {
            get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
                .filter(k => k in store).map(k => [k, JSON.parse(JSON.stringify(store[k]))])),
            set: async obj => { for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v)); },
            remove: async keys => { for (const k of [].concat(keys)) delete store[k]; },
        },
        onChanged: { addListener: () => {} },
    },
    runtime: { sendMessage: async () => null },
};
global.document = { visibilityState: 'visible', addEventListener: () => {} };
// Web Locks, as every Chrome tab on one profile shares them: one queue per name.
const lockQueues = {};
Object.defineProperty(global, 'navigator', { configurable: true, value: { locks: {
    request(name, fn) {
        const run = (lockQueues[name] || Promise.resolve()).then(() => fn());
        lockQueues[name] = run.catch(() => {});
        return run;
    },
} } });
global.setTimeout = f => { f(); return 0; }; global.clearTimeout = () => {}; global.setInterval = () => 0;
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
require(ROOT + 'content/flickemon-flick-progress.js');
require(ROOT + 'content/flickemon-engine.js');

const cfg = global.window.FlickemonConfig;
const Engine = global.window.flickemonEngine.constructor;
const COST = cfg.INSTANT_CAPTURE_EXP_DEBT;
const MAX = cfg.EXP_DEBT_MAX;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

// One cloud, answering as background/firestore.js does: a document per slot,
// stamped with a write time, and "unchanged" when asked with that time.
const ME = 'uid_me';
let cloud = {};
let serial = 0;
const worker = async msg => {
    switch (msg.type) {
        case 'AUTH_STATUS': return { configured: true, signedIn: true, uid: ME, email: 'me@docchula.com' };
        case 'CLOUD_PULL': {
            const doc = cloud[msg.slot || 1];
            if (!doc) return { signedIn: true, state: null };
            if (msg.since && msg.since === doc.serverAt) return { signedIn: true, unchanged: true, serverAt: doc.serverAt };
            return { signedIn: true, state: JSON.parse(JSON.stringify(doc.state)),
                     generation: doc.generation, serverAt: doc.serverAt };
        }
        case 'CLOUD_PUSH': {
            const at = 'T' + (++serial);
            cloud[msg.slot || 1] = { state: JSON.parse(JSON.stringify(msg.state)),
                                     generation: msg.generation || null, serverAt: at };
            return { ok: true, serverAt: at };
        }
        default: return { ok: true };
    }
};

/** A Flick tab: its own engine, the shared disk and cloud. */
async function openTab() {
    const e = new Engine();
    e.sendToWorker = worker;
    await e.init();
    return e;
}

function startGame(e) {
    e.gameState = e.normalizeState({
        ...e.createEmptyState(), hasStarted: true, ownerUid: ME, battleMode: 'capture',
        party: [{ instanceId: 'p1', speciesId: 25, level: 30, totalExp: cfg.expForLevel(30) }],
        activeInstanceId: 'p1',
    });
}

/** An ordinary wild Pokémon mid-fight, never shiny or legendary. */
function meet(e, speciesId = 19, { shiny = false } = {}) {
    e.wildOpponent = { wildSpecies: cfg.getSpeciesById(speciesId), wildLevel: 20, maxHp: 100,
                       currentHp: 100, status: 'fighting', fightDurationSeconds: 0, shiny };
    e.wildHpAcc = 100;
}

/** Wins the fight in progress with the capture roll pinned. */
async function win(e, { roll = 0.2, speciesId = 19, shiny = false } = {}) {
    meet(e, speciesId, { shiny });
    const fight = e.wildOpponent;   // the respawn replaces e.wildOpponent at once
    e.wildHpAcc = 1; fight.currentHp = 1;
    const r = Math.random;
    let step = 0;
    Math.random = () => roll + (step++ % 50) * 1e-4;
    try { await e.onVideoProgress(60); } finally { Math.random = r; }
    return fight;
}

async function catchNow(e) { meet(e, 129); return e.instantCapture(); }

const settle = () => new Promise(r => setImmediate(r));
const reset = async () => {
    // A write from the block before can still be in flight; let it land first.
    for (let i = 0; i < 5; i++) await settle();
    for (const k of Object.keys(store)) delete store[k];
    cloud = {}; serial = 0;
};

(async () => {
    console.log('\n=== the ceiling ===');
    {
        await reset();
        const e = await openTab();
        startGame(e);
        check('the ceiling is 30', MAX === 30, String(MAX));
        for (let i = 1; i * COST <= MAX; i++) {
            const res = await catchNow(e);
            check(`catch now #${i} is allowed (${i * COST}/${MAX})`, res.ok === true, JSON.stringify(res));
        }
        const refused = await catchNow(e);
        check('one more would pass the ceiling, so it is refused',
            refused.ok === false && refused.reason === 'debt-limit', JSON.stringify(refused));
        check('and the refusal says where the debt stands', refused.debt === MAX && refused.max === MAX);
        check('nothing was caught by the refusal', e.wildOpponent.status === 'fighting');
        check('the debt never went past the ceiling', e.getExpDebt() === MAX, String(e.getExpDebt()));

        // At exactly the ceiling: not over it, so catching works as normal.
        const w = await win(e);
        check('at the ceiling ordinary catching still works', w.status === 'captured', w.status);
        check('and that win paid one off', e.getExpDebt() === MAX - 1);
        check('one under the ceiling is still not enough room for another',
            (await catchNow(e)).reason === 'debt-limit');
        for (let i = 0; i < COST - 1; i++) await win(e, { roll: 0.95 });
        check(`paid down to ${MAX - COST}, catch now opens again`,
            (await catchNow(e)).ok === true, String(e.getExpDebt()));
    }

    console.log('\n=== over the ceiling: no catching and no EXP ===');
    {
        await reset();
        const e = await openTab();
        startGame(e);
        // A save that stacked debt before there was a ceiling.
        e.gameState = e.normalizeState({ ...e.gameState, expDebtLedger: undefined, expDebt: 45 });
        check('a legacy debt over the ceiling is kept, not trimmed', e.getExpDebt() === 45, String(e.getExpDebt()));
        check('it reads as over the limit', e.isOverDebtLimit() === true);
        check('catch now is refused', (await catchNow(e)).reason === 'debt-limit');

        const before = e.getActivePokemon().totalExp;
        const partyBefore = e.gameState.party.length;
        const w = await win(e, { roll: 0.2 });
        check('a won fight is not caught', w.status === 'defeated' && w.debtLocked === true, w.status);
        check('and is not called a miss', w.brokeFree === false);
        const shiny = await win(e, { roll: 0.2, shiny: true });
        check('not even a guaranteed shiny', shiny.status === 'defeated', shiny.status);
        check('nothing joined the party', e.gameState.party.length === partyBefore);
        check('wins still pay the debt down', e.getExpDebt() === 43, String(e.getExpDebt()));

        check('no EXP lands from anywhere', e.addExpToActive(500) === null
            && e.getActivePokemon().totalExp === before, String(e.getActivePokemon().totalExp - before));

        // An escape normally leaves consolation EXP.
        meet(e, 19);
        e.wildOpponent.wildLevel = e.getActivePokemon().level + 10;
        e.wildOpponent.fightDurationSeconds = 120;
        await e.onVideoProgress(1);
        check('an escape pays no EXP either', e.getActivePokemon().totalExp === before);

        while (e.getExpDebt() > MAX) await win(e, { roll: 0.95 });
        const back = await win(e, { roll: 0.2 });
        check('back at the ceiling, catching works again', back.status === 'captured', back.status);
        check('and EXP lands again', e.addExpToActive(10) !== undefined
            && e.getActivePokemon().totalExp > before);
    }

    console.log('\n=== the exploit: a second tab, then a slot switch ===');
    {
        await reset();
        const a = await openTab();
        startGame(a);
        await a.saveGameState({ immediate: true });
        const b = await openTab();               // another Flick tab, same save
        check('both tabs share the device bucket', a.studySource() === b.studySource());

        await catchNow(a); await catchNow(a);
        check('tab A owes 20', a.getExpDebt() === 20);
        check('tab B still holds the save from before', b.getExpDebt() === 0);

        await a.switchSlot(2);
        // Tab B keeps studying, writing its copy of slot 1 to disk.
        await b.onVideoProgress(1);
        await b.writeLocal();
        check('tab B\'s write took tab A\'s debt in rather than wiping it',
            b.getExpDebt() === 20, String(b.getExpDebt()));
        check('so the slot on disk still owes it',
            new Engine().normalizeState(store[a.slotStorageKey(1)]).expDebt === 20);

        await a.switchSlot(1);
        check('switching back finds the debt where it was', a.getExpDebt() === 20, String(a.getExpDebt()));

        // Tab B pushes its copy with a newer timestamp; tab A pulls it.
        b.cloudDirty = true; b.lastPushedFingerprint = null;
        await b.flushCloud();
        a.lastSeenServerAt = null;
        await a.pullFromCloud();
        check('a newer copy from elsewhere cannot lower it either', a.getExpDebt() === 20, String(a.getExpDebt()));

        await a.switchSlot(3); await a.switchSlot(1); await a.switchSlot(2); await a.switchSlot(1);
        check('nor can switching back and forth', a.getExpDebt() === 20, String(a.getExpDebt()));
    }

    console.log('\n=== two tabs pressing catch now at once both pay ===');
    {
        await reset();
        const a = await openTab();
        startGame(a);
        await a.saveGameState({ immediate: true });
        await a.writeLocal();
        const b = await openTab();
        check('both tabs start from no debt', a.getExpDebt() === 0 && b.getExpDebt() === 0);
        meet(a, 129); meet(b, 129);
        // Neither has seen the other's press when it makes its own.
        const [ra, rb] = await Promise.all([a.instantCapture(), b.instantCapture()]);
        check('both catches happened', ra.ok === true && rb.ok === true, JSON.stringify([ra, rb]));
        const onDisk = new Engine().normalizeState(store[a.slotStorageKey(1)]).expDebt;
        check('and both were charged', onDisk === 2 * COST && Math.max(a.getExpDebt(), b.getExpDebt()) === 2 * COST,
            `${onDisk} ${a.getExpDebt()} ${b.getExpDebt()}`);
        await a.instantCapture().catch(() => {});
        meet(a, 129); await a.instantCapture();
        meet(b, 129);
        const third = await b.instantCapture();
        check('and the ceiling holds across tabs', b.getExpDebt() <= MAX && (third.ok === false || b.getExpDebt() === MAX),
            `${b.getExpDebt()} ${JSON.stringify(third)}`);
        meet(a, 129);
        const over = await a.instantCapture();
        check('a fourth press in either tab is refused', over.ok === false && over.reason === 'debt-limit', JSON.stringify(over));
    }

    console.log('\n=== a stale copy cannot lower it, a paid one stays paid ===');
    {
        await reset();
        const e = await openTab();
        startGame(e);
        const stale = JSON.parse(JSON.stringify(e.buildCloudPayload()));   // owes nothing
        await catchNow(e);
        stale.lastSyncedAt = Date.now() + 60000;                           // and is "newer"
        e.mergeCloudState(stale);
        check('a stale, newer copy owing nothing leaves the debt', e.getExpDebt() === COST, String(e.getExpDebt()));

        const owing = JSON.parse(JSON.stringify(e.buildCloudPayload()));
        await e.adminClearExpDebt();
        check('cleared', e.getExpDebt() === 0);
        e.mergeCloudState(owing);
        check('a copy from before the clear does not bring it back', e.getExpDebt() === 0, String(e.getExpDebt()));

        // Two devices paying the same debt down add up rather than compete.
        await catchNow(e);
        const other = JSON.parse(JSON.stringify(e.buildCloudPayload()));
        other.expDebtLedger.dev_other = { owed: 0, paid: 3 };
        await win(e, { roll: 0.95 }); await win(e, { roll: 0.95 });
        e.mergeCloudState(other);
        check('wins on two devices both count', e.getExpDebt() === COST - 5, String(e.getExpDebt()));
    }

    console.log('\n=== saves from before the ledger ===');
    {
        await reset();
        const e = await openTab();
        startGame(e);
        const old = { ...e.buildCloudPayload(), lastSyncedAt: Date.now() + 60000, expDebt: 12 };
        delete old.expDebtLedger;
        e.mergeCloudState(old);
        check('an older client\'s debt is taken up', e.getExpDebt() === 12, String(e.getExpDebt()));
        const lower = { ...old, expDebt: 4, lastSyncedAt: Date.now() + 120000 };
        e.mergeCloudState(lower);
        check('but its lower number never lowers ours', e.getExpDebt() === 12, String(e.getExpDebt()));
        const again = { ...old, expDebt: 12, lastSyncedAt: Date.now() + 180000 };
        e.mergeCloudState(again);
        check('and the same number is not counted twice', e.getExpDebt() === 12, String(e.getExpDebt()));

        const norm = e.normalizeState({ ...e.createEmptyState(), hasStarted: true,
            party: [{ instanceId: 'a', speciesId: 1, level: 5, totalExp: 125 }], activeInstanceId: 'a', expDebt: 7 });
        check('a local save from before the ledger keeps its debt', norm.expDebt === 7
            && norm.expDebtLedger.legacy && norm.expDebtLedger.legacy.owed === 7);
        check('older clients still get the plain number', e.buildCloudPayload().expDebt === e.getExpDebt());
        const p1 = JSON.stringify(e.buildCloudPayload().expDebtLedger);
        e.gameState.expDebtLedger = Object.fromEntries(Object.entries(e.gameState.expDebtLedger).reverse());
        check('the ledger serialises the same in any order (no wasted writes)',
            JSON.stringify(e.buildCloudPayload().expDebtLedger) === p1);
    }

    console.log('\n=== another student\'s save, or a deleted run, owes nothing here ===');
    {
        const e = new Engine();
        const mine = { ownerUid: ME, saveGeneration: 'g1', expDebtLedger: {} };
        e.mergeStoredDebt({ ownerUid: 'someone_else', saveGeneration: 'g1',
                            expDebtLedger: { d: { owed: 30, paid: 0 } } }, mine);
        check('not another account\'s', debt(mine) === 0);
        e.mergeStoredDebt({ ownerUid: ME, saveGeneration: 'g0',
                            expDebtLedger: { d: { owed: 30, paid: 0 } } }, mine);
        check('not a run an administrator deleted', debt(mine) === 0);
        e.mergeStoredDebt({ ownerUid: ME, saveGeneration: 'g1',
                            expDebtLedger: { d: { owed: 30, paid: 0 } } }, mine);
        check('the same run\'s is taken in', debt(mine) === 30);
    }

    console.log('\n=== every press warns ===');
    {
        const ui = require('fs').readFileSync(ROOT + 'content/flickemon-ui.js', 'utf8');
        const handler = ui.slice(ui.indexOf("querySelector('.catch-now-btn')"), ui.indexOf("querySelectorAll('.mode-seg')"));
        check('the button opens the warning', handler.includes('openCatchNowWarning'));
        check('and no native confirm(), which a page can mute for good', !/confirm\(/.test(handler));
        const warn = ui.slice(ui.indexOf('openCatchNowWarning() {'), ui.indexOf('Sign-In Gate'));
        check('the warning names the cost and the ceiling',
            warn.includes('INSTANT_CAPTURE_EXP_DEBT') && warn.includes('EXP_DEBT_MAX'));
        check('it says switching slots does not clear it', /Switching save slots/.test(warn));
        check('at the ceiling it still opens, and says why not', warn.includes("can't use Catch Now"));
    }

    function debt(state) {
        let o = 0, p = 0;
        for (const b of Object.values(state.expDebtLedger || {})) { o += b.owed || 0; p += b.paid || 0; }
        return Math.max(0, o - p);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
