const ROOT = require('path').join(__dirname, '..') + '/';
/**
 * Six save slots, and who may delete one.
 * ───────────────────────────────────────
 * The engine's half: where each slot lives on the device, what moves when the
 * student switches, and how a delete made on one device reaches the others
 * instead of being merged straight back. The rules' half -- that only an
 * administrator may delete at all -- is executed in test_rules.mjs.
 */

// An in-memory chrome.storage, because the whole point is which KEY each slot
// is written under.
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
global.setTimeout = f => { f(); return 0; }; global.clearTimeout = () => {}; global.setInterval = () => 0;
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
require(ROOT + 'content/flickemon-flick-progress.js');
require(ROOT + 'content/flickemon-engine.js');

const e = global.window.flickemonEngine;
let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const ME = 'uid_me';
// The worker, answering as the cloud would. `cloud` is keyed by slot.
let cloud = {};
let sent = [];
let wipeAnswer = null;
e.sendToWorker = async msg => {
    sent.push(msg);
    switch (msg.type) {
        case 'AUTH_STATUS': return { configured: true, signedIn: true, uid: ME, email: 'me@docchula.com' };
        case 'CLOUD_PULL': {
            const doc = cloud[msg.slot || 1];
            if (!doc) return { signedIn: true, state: null };
            return { signedIn: true, state: doc.state || null, generation: doc.generation || null,
                     wiped: doc.wiped === true, serverAt: null };
        }
        case 'CLOUD_PUSH': return { ok: true, serverAt: null };
        case 'CLOUD_SLOTS': return { signedIn: true, slots: Object.entries(cloud).map(([n, d]) => ({
            slot: Number(n), hasStarted: Boolean(d.state && d.state.hasStarted),
            partnerSpecies: 25, partnerLevel: 30, caughtCount: 9, totalMinutesWatched: 600 })) };
        case 'CLOUD_WIPE_SLOT': return wipeAnswer
            || { signedIn: true, ok: true, slot: msg.slot, generation: 'gen-wiped', serverAt: null };
        default: return { ok: true };
    }
};

/** A started game, as the engine would hold it. */
const game = (speciesId, level, extra = {}) => e.normalizeState({
    ...e.createEmptyState(), hasStarted: true, ownerUid: ME,
    party: [{ instanceId: 'p' + speciesId, speciesId, level, totalExp: 1000, shiny: false,
              megaStones: [], megaSeen: [], megaActive: null, megaActiveAt: 0 }],
    activeInstanceId: 'p' + speciesId,
    pokedex: [{ id: speciesId, seen: true, caught: true }],
    ...extra,
});

const reset = async () => {
    // Writes queue on the save lock, so one from the block before can still be
    // waiting. It lands first, then the store is cleared.
    await e.withSaveLock(() => {});
    for (const k of Object.keys(store)) delete store[k];
    cloud = {}; sent = []; wipeAnswer = null;
    e.activeSlot = 1;
    e.gameState = e.createEmptyState();
    e.lastSeenServerAt = null; e.lastPushedFingerprint = null;
    e.cloudDirty = false; e.cloudInFlight = false;
};

(async () => {
    e.isLoaded = true;

    console.log('\n=== a save from before slots is slot 1, where it always was ===');
    {
        await reset();
        store[e.STORAGE_KEY] = game(4, 12);
        await e.init();
        check('it loads without being moved',
            e.activeSlot === 1 && e.gameState.hasStarted && e.gameState.party[0].speciesId === 4,
            JSON.stringify({ slot: e.activeSlot, started: e.gameState.hasStarted }));
        check('slot 2 has its own key', e.slotStorageKey(2) !== e.STORAGE_KEY
            && e.slotStorageKey(1) === e.STORAGE_KEY);
    }

    console.log('\n=== switching slots keeps the games apart ===');
    {
        await reset();
        e.gameState = game(4, 12, { flickSeen: { lecA: 600, lecB: 100 }, flickLocalMinutes: 7 });
        e.writeLocal();
        store[e.slotStorageKey(3)] = game(7, 20, { flickSeen: { lecB: 900 } });

        await e.switchSlot(2);
        check('an empty slot starts a new game', e.activeSlot === 2 && !e.gameState.hasStarted);
        check('the pointer is remembered on this device', store[e.SLOT_KEY] === 2, String(store[e.SLOT_KEY]));
        check('the slot left behind is intact on disk',
            store[e.STORAGE_KEY] && store[e.STORAGE_KEY].party[0].speciesId === 4);
        check('it belongs to the same student', e.gameState.ownerUid === ME);
        check('what Flick has seen comes along -- nothing is paid twice',
            e.gameState.flickSeen.lecA === 600 && e.gameState.flickLocalMinutes === 7,
            JSON.stringify(e.gameState.flickSeen));

        await e.switchSlot(3);
        check('a slot with a game loads it', e.gameState.party[0].speciesId === 7);
        check('the furthest mark of the two is kept',
            e.gameState.flickSeen.lecB === 900 && e.gameState.flickSeen.lecA === 600,
            JSON.stringify(e.gameState.flickSeen));

        await e.switchSlot(1);
        check('and switching back finds the first game where it was',
            e.gameState.party[0].speciesId === 4 && e.activeSlot === 1);
        check('but with the marks it now has to honour',
            e.gameState.flickSeen.lecB === 900, JSON.stringify(e.gameState.flickSeen));

        sent = [];
        await e.switchSlot(5);
        check('the cloud is asked about the slot arriving, not the one left',
            sent.some(m => m.type === 'CLOUD_PULL' && m.slot === 5), JSON.stringify(sent.map(m => [m.type, m.slot])));
        check('a slot out of range is refused',
            await e.switchSlot(7).then(() => false, () => true));
    }

    console.log('\n=== the slot being left is pushed to its own document ===');
    {
        await reset();
        e.gameState = game(4, 12, { saveGeneration: 'g1' });
        e.cloudDirty = true;
        sent = [];
        await e.switchSlot(2);
        const push = sent.find(m => m.type === 'CLOUD_PUSH');
        check('flushed before leaving, addressed to slot 1 with its run',
            push && push.slot === 1 && push.generation === 'g1' && push.state.party[0].speciesId === 4,
            JSON.stringify(push && { slot: push.slot, gen: push.generation }));
    }

    console.log('\n=== a generation is only minted where the cloud has none ===');
    {
        await reset();
        e.gameState = game(4, 12);                    // a save from before slots
        cloud[1] = { state: { ...game(4, 12), totalMinutesWatched: 50 }, generation: 'cloud-gen' };
        await e.pullFromCloud();
        check('a save from before slots joins the run the cloud has, and merges',
            e.gameState.saveGeneration === 'cloud-gen' && e.gameState.hasStarted
            && e.gameState.party.length === 1, JSON.stringify(e.gameState.saveGeneration));

        await reset();
        e.gameState = game(4, 12);
        cloud[1] = { state: game(4, 12) };            // the cloud's save predates slots too
        await e.pullFromCloud();
        check('where neither has one, the device names the run',
            typeof e.gameState.saveGeneration === 'string' && e.gameState.saveGeneration.length > 8);
    }

    console.log('\n=== a delete made on another device is not merged back ===');
    {
        // The admin reset that undid itself: the merge only ever adds, so the
        // next pull put every Pokémon back.
        await reset();
        e.gameState = game(4, 12, { saveGeneration: 'old-run', flickSeen: { lecA: 300 } });
        e.writeLocal();
        cloud[1] = { generation: 'new-run', wiped: true };
        await e.pullFromCloud();
        check('the deleted run is let go', !e.gameState.hasStarted && e.gameState.party.length === 0,
            JSON.stringify(e.gameState.party));
        check('and this device joins the new one', e.gameState.saveGeneration === 'new-run');
        check('the owner and what Flick has seen stay',
            e.gameState.ownerUid === ME && e.gameState.flickSeen.lecA === 300);
        check('the emptied slot is what is on disk', store[e.STORAGE_KEY] && !store[e.STORAGE_KEY].hasStarted);
        const backup = await e.peekBackup();
        check('a snapshot of the deleted run is kept', backup && backup.state.party[0].speciesId === 4);

        await reset();
        e.gameState = game(4, 12);                    // pre-slot copy of a save since deleted
        cloud[1] = { generation: 'new-run', wiped: true };
        await e.pullFromCloud();
        check('an owned save from before slots is the deleted copy too', !e.gameState.hasStarted);

        await reset();
        e.gameState = game(4, 12, { ownerUid: null }); // played before ever signing in
        cloud[1] = { generation: 'new-run', wiped: true };
        await e.pullFromCloud();
        check('but a game nobody owned yet is adopted into the empty slot',
            e.gameState.hasStarted && e.gameState.saveGeneration === 'new-run');
    }

    console.log('\n=== only an administrator deletes, and the server decides ===');
    {
        await reset();
        e.gameState = game(4, 12, { saveGeneration: 'g1' });
        wipeAnswer = { signedIn: true, ok: false, reason: 'forbidden' };
        const refused = await e.adminDeleteSlot(1).then(() => null, err => err.message);
        check('a refusal says so', refused && /not an administrator/.test(refused), String(refused));
        check('and nothing local is touched', e.gameState.hasStarted && e.gameState.party.length === 1);

        wipeAnswer = null;
        await e.adminDeleteSlot(1);
        check('an admin deletes the slot being played', !e.gameState.hasStarted);
        check('under the generation the server wrote', e.gameState.saveGeneration === 'gen-wiped');
        check('the request named the slot',
            sent.some(m => m.type === 'CLOUD_WIPE_SLOT' && m.slot === 1));

        await reset();
        e.gameState = game(4, 12);
        store[e.slotStorageKey(4)] = game(150, 70);
        await e.adminDeleteSlot(4);
        check('or another slot, whose copy leaves this device',
            !(e.slotStorageKey(4) in store) && e.gameState.hasStarted);
        const backup = await e.peekBackup();
        check('kept as the snapshot', backup && backup.state.party[0].speciesId === 150);

        cloud[4] = { generation: 'gen-wiped', wiped: true };
        const restored = await e.restoreBackup();
        check('a restore goes back to the slot it came from, not over the game on screen',
            restored && e.activeSlot === 4 && e.gameState.party[0].speciesId === 150
            && store[e.STORAGE_KEY].party[0].speciesId === 4, String(e.activeSlot));
        check('into the run that is current there, not the retired one',
            e.gameState.saveGeneration === 'gen-wiped', String(e.gameState.saveGeneration));
    }

    console.log('\n=== the save screen ===');
    {
        await reset();
        e.gameState = game(4, 12);
        store[e.slotStorageKey(2)] = game(7, 20);
        store[e.slotStorageKey(3)] = game(1, 5, { ownerUid: 'uid_someone_else' });
        cloud[4] = { state: game(25, 30) };
        const { slots } = await e.listSaveSlots();
        check('six slots', slots.length === 6, String(slots.length));
        check('the one on screen is marked and read from memory',
            slots[0].active && slots[0].partnerSpecies === 4);
        check('a game only this device has is shown', slots[1].hasStarted && slots[1].partnerSpecies === 7);
        check('another account\'s save on a shared machine is not', !slots[2].hasStarted);
        check('the cloud fills in the rest', slots[3].hasStarted && slots[3].partnerSpecies === 25);
        check('and an unused slot is empty', !slots[5].hasStarted);
    }

    console.log('\n=== naming a Pokémon ===');
    {
        await reset();
        e.gameState = game(25, 10);
        await e.renamePokemon('p25', '  Sparky ⚡  ', 1000);
        check('a nickname is kept, trimmed', e.gameState.party[0].nickname === 'Sparky ⚡',
            JSON.stringify(e.gameState.party[0].nickname));
        await e.renamePokemon('p25', 'Zap‮yrakps​\n', 1001);
        check('invisible and direction-flipping characters are dropped',
            e.gameState.party[0].nickname === 'Zap yrakps', JSON.stringify(e.gameState.party[0].nickname));
        await e.renamePokemon('p25', '😀'.repeat(30), 1002);
        check('capped at 20 characters, an emoji counting as one',
            Array.from(e.gameState.party[0].nickname).length === 20);
        await e.renamePokemon('p25', '<img src=x onerror=alert(1)>', 1003);
        check('anything typed is kept as text -- the UI escapes it',
            e.gameState.party[0].nickname === '<img src=x onerror=alert(1)>'.slice(0, 20));
        await e.renamePokemon('p25', '   ', 1004);
        check('an empty name goes back to the species', !('nickname' in e.gameState.party[0]));
        check('someone else\'s Pokémon cannot be named',
            await e.renamePokemon('nope', 'x').then(() => false, () => true));

        // Two devices: the later rename wins, whichever syncs last.
        await reset();
        e.gameState = game(25, 10);
        e.gameState.party[0].nickname = 'Old'; e.gameState.party[0].nicknameAt = 500;
        const remote = game(25, 10);
        remote.party[0].nickname = 'New'; remote.party[0].nicknameAt = 900;
        e.mergeCloudState({ ...remote, schemaVersion: 2 });
        check('a newer nickname from another device is taken', e.gameState.party[0].nickname === 'New');
        remote.party[0].nickname = 'Stale'; remote.party[0].nicknameAt = 100;
        e.mergeCloudState({ ...remote, schemaVersion: 2 });
        check('an older one is not', e.gameState.party[0].nickname === 'New');
        remote.party[0].nicknameAt = 1000; delete remote.party[0].nickname;
        e.mergeCloudState({ ...remote, schemaVersion: 2 });
        check('and clearing it on another device clears it here', !e.gameState.party[0].nickname);
        check('a junk nickname in a save is dropped on load',
            !('nickname' in e.normalizeState({ ...game(1, 5), party: [{ ...game(1, 5).party[0], nickname: 42 }] }).party[0]));
    }

    console.log('\n=== naming a save slot ===');
    {
        await reset();
        e.gameState = game(4, 12);
        sent = [];
        await e.renameSaveSlot(1, 'Main run', 2000);
        check('the slot being played is named in its own save',
            e.gameState.saveName === 'Main run' && e.gameState.saveNameAt === 2000);
        check('and rides its push, not a separate write', !sent.some(m => m.type === 'CLOUD_RENAME_SLOT'));
        check('the name travels in the save', e.buildCloudPayload().saveName === 'Main run');

        store[e.slotStorageKey(3)] = game(7, 20);
        sent = [];
        await e.renameSaveSlot(3, 'Shiny hunt', 2100);
        check('another slot is renamed on this device', store[e.slotStorageKey(3)].saveName === 'Shiny hunt');
        const msg = sent.find(m => m.type === 'CLOUD_RENAME_SLOT');
        check('and in the cloud, by name only', msg && msg.slot === 3 && msg.name === 'Shiny hunt' && !msg.state,
            JSON.stringify(msg));

        const { slots } = await e.listSaveSlots();
        check('the save screen shows both names',
            slots[0].saveName === 'Main run' && slots[2].saveName === 'Shiny hunt',
            JSON.stringify(slots.map(x => x.saveName)));

        await e.renameSaveSlot(1, '', 2200);
        check('an empty name goes back to "Slot n"', e.gameState.saveName === '');

        // A rename made from another slot arrives as the document's own fields.
        await reset();
        e.gameState = game(4, 12, { saveGeneration: 'g', saveName: 'Mine', saveNameAt: 10 });
        cloud[1] = { state: game(4, 12), generation: 'g' };
        const realSend = e.sendToWorker;
        e.sendToWorker = async m => m.type === 'CLOUD_PULL'
            ? { signedIn: true, state: game(4, 12), generation: 'g', saveName: 'From phone', saveNameAt: 50 }
            : realSend(m);
        await e.pullFromCloud();
        check('a newer name from another device is taken', e.gameState.saveName === 'From phone');
        e.sendToWorker = async m => m.type === 'CLOUD_PULL'
            ? { signedIn: true, state: game(4, 12), generation: 'g', saveName: 'Old', saveNameAt: 5 }
            : realSend(m);
        await e.pullFromCloud();
        check('an older one is not', e.gameState.saveName === 'From phone');
        e.sendToWorker = realSend;

        // Signed out, a slot with no save here has nowhere to keep a name.
        await reset();
        e.gameState = game(4, 12);
        e.sendToWorker = async m => m.type === 'AUTH_STATUS' ? { configured: true, signedIn: false } : realSend(m);
        check('signed out, an empty slot cannot be named',
            await e.renameSaveSlot(5, 'x').then(() => false, () => true));
        e.sendToWorker = realSend;
    }

    console.log('\n=== a reply for a slot already left is ignored ===');
    {
        await reset();
        e.gameState = game(4, 12, { saveGeneration: 'g1' });
        const realSend = e.sendToWorker;
        e.sendToWorker = async msg => {
            if (msg.type === 'CLOUD_PULL') {
                e.activeSlot = 2;                     // the student switched meanwhile
                return { signedIn: true, state: game(150, 90), generation: 'other', serverAt: 'x' };
            }
            return realSend(msg);
        };
        await e.pullFromCloud();
        check('it is not merged into the slot on screen',
            e.gameState.party[0].speciesId === 4 && e.gameState.saveGeneration === 'g1'
            && e.lastSeenServerAt === null);
        e.sendToWorker = realSend;
    }

    console.log('\n=== the account\'s friend settings follow it across slots ===');
    {
        await reset();
        // Slot 1: on the board, a name, sharing trimmed. Slot 2's own cloud copy
        // still says what it said the last time it was played.
        e.gameState = game(4, 12, { username: 'nan', usernameAt: 500, onLeaderboard: true,
            onLeaderboardAt: 500, leaderboardLabel: 'nan',
            friendPrivacy: { ...e.config.defaultFriendPrivacy(), today: false }, friendPrivacyAt: 500,
            blockedUids: ['pest'] });
        e.writeLocal();
        cloud[2] = { state: { ...game(7, 20), username: 'old', usernameAt: 0, onLeaderboard: false,
                              onLeaderboardAt: 0, lastSyncedAt: Date.now() + 9e6 }, generation: 'g2' };

        await e.switchSlot(2);
        check('still on the board', e.isOnLeaderboard() === true);
        check('still the same name', e.getUsername() === 'nan', e.getUsername());
        check('still not sharing what was hidden', e.getFriendPrivacy().today === false);
        check('still blocking who was blocked', e.isBlocked('pest'));

        // Leaving the board here holds when going back to slot 1.
        e.sendToWorker = async msg => (msg.type === 'FRIEND_BOARD_PUBLISH' ? { ok: true } : (await (async () => {
            switch (msg.type) {
                case 'AUTH_STATUS': return { configured: true, signedIn: true, uid: ME, email: 'me@docchula.com' };
                case 'CLOUD_PULL': return { signedIn: true, state: null };
                default: return { ok: true };
            }
        })()));
        await e.setOnLeaderboard(false, 'me@docchula.com');
        await e.switchSlot(1);
        check('leaving the board in one slot holds in the other', e.isOnLeaderboard() === false);
    }

    console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
})();
