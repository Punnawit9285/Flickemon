const ROOT = require('path').join(__dirname, '..') + '/';
// The Poké Mart: earning, spending, the cross-device wallet, eggs and the
// permanent boosts that stack on top of the PVP ones.
global.window={addEventListener(){}};
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-custom.js');
require(ROOT + 'content/flickemon-battle.js');
global.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},onChanged:{addListener:()=>{}}},runtime:{sendMessage:async()=>null}};
global.document={visibilityState:'visible',addEventListener:()=>{}};
global.setTimeout=f=>{f();return 0;};global.clearTimeout=()=>{};global.setInterval=()=>0;
require(ROOT + 'content/flickemon-engine.js');
const cfg = global.window.FlickemonConfig;
const Engine = global.window.flickemonEngine.constructor;

let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);

/** A fresh, loaded engine on a named device. */
function mk(device='dev_a') {
    const e = new Engine();
    e.gameState = e.createEmptyState();
    e.deviceId = device;
    e.isLoaded = true;
    return e;
}
const fund = (e, n) => { e.gameState.shopWallet[e.studySource()] = { earned: n, spent: 0 }; };

console.log('\n=== prices are quoted in hours, and the hours are the authored number ===');
{
    for (const item of cfg.SHOP_ITEMS) {
        check(`${item.id} costs ${item.hours}h`,
            item.price === item.hours * cfg.SHOP_PRICE_PER_HOUR,
            `${item.price} != ${item.hours * cfg.SHOP_PRICE_PER_HOUR}`);
    }
    const tiers = cfg.SHOP_BOOST_TIERS.slice(1);
    check('boost tiers are 200h / 400h / 800h',
        tiers.map(t => t.hours).join(',') === '200,400,800');
    check('maxing one boost is 1,400 hours',
        tiers.reduce((n, t) => n + t.hours, 0) === 1400);
    check('a maxed boost costs 1,400 hours worth',
        tiers.reduce((n, t) => n + t.price, 0) === 1400 * cfg.SHOP_PRICE_PER_HOUR);
}

console.log('\n=== the price rate is honest about both battle modes ===');
{
    // The rates themselves are MEASURED against the real engine in
    // tests/test_guide.js, which is where a drift in the EXP economy would show
    // up. What matters here is only that pricing sits inside what the engine
    // actually pays, in both modes.
    const bal = cfg.BALANCE_REFERENCE;
    check('an hour costs no more than capture mode earns',
        cfg.SHOP_PRICE_PER_HOUR <= bal.moneyPerHour.capture,
        `${cfg.SHOP_PRICE_PER_HOUR} > ${bal.moneyPerHour.capture}`);
    check('an hour costs no less than exp mode earns',
        cfg.SHOP_PRICE_PER_HOUR >= bal.moneyPerHour.exp,
        `${cfg.SHOP_PRICE_PER_HOUR} < ${bal.moneyPerHour.exp}`);
    check('capture mode earns more than exp mode',
        bal.moneyPerHour.capture > bal.moneyPerHour.exp);
}

console.log('\n=== earning and spending ===');
{
    const e = mk();
    check('a new save has nothing', e.getMoney() === 0);
    e.addMoney(cfg.BATTLE_WIN_MONEY);
    e.addMoney(cfg.ESCAPE_MONEY);
    check('a win and an escape add up', e.getMoney() === 6, String(e.getMoney()));
    check('spending more than you have is refused', e.spendMoney(100) === false);
    check('the refusal costs nothing', e.getMoney() === 6);
    check('an affordable price is taken', e.spendMoney(4) === true && e.getMoney() === 2);
    e.addMoney(-500);
    check('a negative award is ignored', e.getMoney() === 2);
}

console.log('\n=== money is a TIME currency: no boost may touch it ===');
{
    const e = mk();
    e.gameState.shopBoosts = { exp: 3, shiny: 3, legendary: 3 };
    e.gameState.activeReward = { type: cfg.REWARDS.EXP, expiresAt: Date.now() + 9e5, durationMs: 9e5 };
    e.addMoney(cfg.BATTLE_WIN_MONEY);
    check('a maxed EXP boost does not multiply money', e.getMoney() === cfg.BATTLE_WIN_MONEY,
        String(e.getMoney()));

    // The load-bearing one: the Legendary boost raises how often rare things
    // appear, so if rarity paid a bonus it would multiply its own income.
    const src = require('fs').readFileSync(ROOT + 'content/flickemon-engine.js', 'utf8');
    const body = src.slice(src.indexOf('addMoney(amount)'), src.indexOf('spendMoney(amount)'));
    check('addMoney applies no multiplier at all',
        !/Multiplier\(\)/.test(body) && !/rewardExp|shopExp/.test(body));
}

console.log('\n=== permanent boosts stack with the PVP ones ===');
{
    const e = mk();
    check('nothing owned is x1', e.shopExpMultiplier() === 1 && e.shopShinyMultiplier() === 1);
    e.gameState.shopBoosts = { exp: 3, shiny: 3, legendary: 3 };
    check('a maxed EXP boost is x2', e.shopExpMultiplier() === 2);
    e.gameState.activeReward = { type: cfg.REWARDS.EXP, expiresAt: Date.now() + 9e5, durationMs: 9e5 };
    check('maxed EXP during a PVP Double EXP is x4',
        e.rewardExpMultiplier() * e.shopExpMultiplier() === 4);

    check('shiny is clamped so a shiny stays an event',
        Math.min(cfg.MAX_SHINY_CHANCE,
                 cfg.SHINY_CHANCE * cfg.REWARD_SHINY_MULTIPLIER * e.shopShinyMultiplier())
        === cfg.MAX_SHINY_CHANCE);
    check('legendary is clamped at 0.5',
        Math.min(0.5, 0.01 * cfg.REWARD_LEGENDARY_MULTIPLIER * e.shopLegendaryMultiplier()) === 0.5);
    check('a tier beyond the last is refused', cfg.nextBoostTier(cfg.SHOP_MAX_BOOST_TIER) === null);
}

console.log('\n=== buying a boost ===');
(async () => {
    {
        const e = mk();
        fund(e, cfg.SHOP_BOOST_TIERS[1].price);
        const r1 = await e.buyBoost(cfg.REWARDS.EXP);
        check('tier 1 is bought', r1.ok && r1.tier === 1);
        check('the price came out of the wallet', e.getMoney() === 0);
        const r2 = await e.buyBoost(cfg.REWARDS.EXP);
        check('a second tier is refused when broke', !r2.ok && r2.reason === 'poor');
        check('the refusal changed nothing', e.shopBoostTier(cfg.REWARDS.EXP) === 1);

        fund(e, cfg.SHOP_BOOST_TIERS[2].price + cfg.SHOP_BOOST_TIERS[3].price);
        await e.buyBoost(cfg.REWARDS.EXP);
        await e.buyBoost(cfg.REWARDS.EXP);
        check('the ladder tops out at tier 3', e.shopBoostTier(cfg.REWARDS.EXP) === 3);
        const r4 = await e.buyBoost(cfg.REWARDS.EXP);
        check('a fourth tier is refused', !r4.ok && r4.reason === 'maxed');
    }

    console.log('\n=== a mega stone belongs to the species ===');
    {
        const e = mk();
        const item = cfg.shopItemById('mega-stone');
        fund(e, item.price);
        // Charizardite X. Charizard is 6, Charmander is 4 and shares the line.
        const r = await e.buyMegaStone('charizard-mega-x');
        check('the stone is bought', r.ok, r.reason);
        const charizard = { instanceId: 'c1', speciesId: 6, level: 40, totalExp: 1,
                            megaStones: [], megaSeen: [], megaActive: null, megaActiveAt: 0 };
        const charmander = { instanceId: 'c2', speciesId: 4, level: 5, totalExp: 1,
                             megaStones: [], megaSeen: [], megaActive: null, megaActiveAt: 0 };
        const pikachu = { instanceId: 'p1', speciesId: 25, level: 40, totalExp: 1,
                          megaStones: [], megaSeen: [], megaActive: null, megaActiveAt: 0 };
        e.gameState.party.push(charizard, charmander, pikachu);
        check('a Charizard caught later can use it',
            e.availableMegaForms(charizard).some(f => f.key === 'charizard-mega-x'));
        check('a Charmander holds it dormant',
            e.dormantMegaStones(charmander).some(f => f.key === 'charizard-mega-x'));
        check('an unrelated Pokémon is not given 96 dormant stones',
            e.dormantMegaStones(pikachu).length === 0);
        check('buying the same stone twice is refused',
            (await e.buyMegaStone('charizard-mega-x')).reason === 'owned');
        check('Charizardite Y is still for sale',
            !e.availableMegaForms(charizard).some(f => f.key === 'charizard-mega-y'));
    }

    console.log('\n=== eggs ===');
    {
        const e = mk();
        const item = cfg.shopItemById('egg-stage3');
        fund(e, item.price);
        const r = await e.buyEgg('egg-stage3');
        check('the egg is bought', r.ok, r.reason);
        check('its contents were decided at purchase', Number.isFinite(r.egg.speciesId));
        const sp = cfg.getSpeciesById(r.egg.speciesId);
        check('a stage 3 egg holds a stage 3 Pokémon', sp.evolutionStage === 3, sp && sp.name);
        check('and never a legendary', !sp.isLegendary);
        check('it goes straight into the incubator', e.getIncubatingEgg().eggId === r.egg.eggId);

        let early = false;
        for (let i = 0; i < item.hatchEncounters - 1; i++) {
            if (e.hatchTick()) { early = true; break; }
        }
        check('it does not hatch early', !early);
        check('it survives one encounter short of the count', e.getEggs().length === 1);
        const hatched = e.hatchTick();
        check('the last encounter hatches it', !!hatched);
        check('the Pokémon joined the party', e.gameState.party.length === 1);
        check('it hatched as the species the egg held',
            e.gameState.party[0].speciesId === r.egg.speciesId);
        check('it hatches at level 5', e.gameState.party[0].level === 5);
        check('the Pokédex records it', e.getPokedex().some(x => x.speciesId === r.egg.speciesId && x.caught));
        check('the incubator is empty again', e.getIncubatingEgg() === null);
        check('ticking an empty incubator is harmless', e.hatchTick() === null);
    }

    console.log('\n=== a rare egg is a legendary or a shiny ===');
    {
        let legend = 0, shiny = 0;
        for (let i = 0; i < 300; i++) {
            const c = cfg.rollEggContents('egg-rare');
            if (cfg.getSpeciesById(c.speciesId).isLegendary) legend++;
            else if (c.shiny) shiny++;
        }
        check('every rare egg is one or the other', legend + shiny === 300, `${legend}+${shiny}`);
        check('both outcomes actually occur', legend > 50 && shiny > 50, `${legend}/${shiny}`);
    }

    console.log('\n=== the wallet survives two devices ===');
    {
        const A = mk('dev_a');
        A.gameState.shopWallet = { dev_a: { earned: 1000, spent: 600 } };
        A.mergeCloudState({ schemaVersion: 2, lastSyncedAt: 1, party: [], pokedex: [],
            shopWallet: { dev_a: { earned: 1000, spent: 600 }, dev_b: { earned: 500, spent: 0 } } });
        check('two devices earning ADD UP rather than compete', A.getMoney() === 900, String(A.getMoney()));

        // The rule the whole two-counter design exists for.
        A.mergeCloudState({ schemaVersion: 2, lastSyncedAt: 0, party: [], pokedex: [],
            shopWallet: { dev_a: { earned: 1000, spent: 0 } } });
        check('a stale save cannot refund a purchase', A.getMoney() === 900, String(A.getMoney()));

        A.gameState.shopWallet = { dev_a: { earned: 10, spent: 900 } };
        check('an overspend clamps at zero rather than going negative', A.getMoney() === 0);
    }

    console.log('\n=== one egg cannot become two Pokémon ===');
    {
        const A = mk('dev_a');
        fund(A, 99999);
        const bought = await A.buyEgg('egg-stage1');
        A.gameState.eggs[0].encountersLeft = 1;
        const hA = A.hatchTick();

        const B = mk('dev_b');
        B.mergeCloudState({ schemaVersion: 2, lastSyncedAt: 1, party: [], pokedex: [],
            eggs: [{ ...bought.egg, hatched: false, encountersLeft: 1 }] });
        B.gameState.incubatingId = bought.egg.eggId;
        const hB = B.hatchTick();

        check('both devices hatch the same species', hA.species.name === hB.species.name);
        A.mergeCloudState({ schemaVersion: 2, lastSyncedAt: 2, pokedex: [],
            party: B.gameState.party, eggs: B.gameState.eggs, shopWallet: B.gameState.shopWallet });
        check('after syncing there is exactly one of it', A.gameState.party.length === 1,
            String(A.gameState.party.length));
        check('the egg stays hatched on both', A.getEggs().length === 0);
    }

    console.log('\n=== boosts and stones merge monotonically ===');
    {
        const A = mk('dev_a');
        A.gameState.shopBoosts = { exp: 2 };
        A.gameState.megaSpecies = ['venusaur-mega'];
        A.mergeCloudState({ schemaVersion: 2, lastSyncedAt: 1, party: [], pokedex: [],
            shopBoosts: { exp: 1, shiny: 3 }, megaSpecies: ['blastoise-mega'] });
        check('the higher tier wins', A.shopBoostTier('exp') === 2);
        check('a boost only the cloud knows about arrives', A.shopBoostTier('shiny') === 3);
        check('stones union', A.gameState.megaSpecies.length === 2);
    }

    console.log('\n=== the save round-trips ===');
    {
        const e = mk();
        fund(e, 5000);
        await e.buyEgg('egg-stage1');
        await e.buyBoost(cfg.REWARDS.SHINY).catch(() => {});
        const payload = e.buildCloudPayload();
        for (const f of ['shopWallet', 'eggs', 'incubatingId', 'megaSpecies', 'shopBoosts']) {
            check(`${f} is in the cloud payload`, f in payload);
        }
        const restored = mk();
        restored.gameState = restored.normalizeState(JSON.parse(JSON.stringify(e.gameState)));
        check('the balance survives a save/load', restored.getMoney() === e.getMoney(),
            `${restored.getMoney()} vs ${e.getMoney()}`);
        check('the egg survives a save/load', restored.getEggs().length === e.getEggs().length);

        // normalizeState is the repair chokepoint; junk must not reach the game.
        const junk = restored.normalizeState({
            shopWallet: { d: { earned: -5, spent: 'x' } },
            shopBoosts: { exp: 99, nonsense: 2 },
            eggs: [{ eggId: 'x' }, { eggId: 'ok', speciesId: 25, encountersLeft: -3 }],
            megaSpecies: ['a', 'a', 7],
        });
        check('a negative balance is repaired to zero',
            junk.shopWallet.d.earned === 0 && junk.shopWallet.d.spent === 0);
        check('a tier past the ceiling is clamped', junk.shopBoosts.exp === cfg.SHOP_MAX_BOOST_TIER);
        check('an unknown boost kind is dropped', !('nonsense' in junk.shopBoosts));
        check('a malformed egg is dropped', junk.eggs.length === 1);
        check('a negative countdown is repaired', junk.eggs[0].encountersLeft === 0);
        check('stone keys are deduped and typed', junk.megaSpecies.length === 1);
    }

    console.log('\n=== the panel renders every tab ===');
    {
        // The panel is plain string-building over the engine, so a stub body is
        // enough to prove every tab draws and that the copy tracks the wallet.
        // Nothing here touches the network or the DOM beyond innerHTML.
        require(ROOT + 'content/flickemon-shop.js');
        const Shop = global.window.FlickemonShop;

        const e = mk();
        fund(e, 3000);
        const stub = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
        const shop = new Shop(e, { createModalOverlay: () => ({ overlay: null, body: stub }) });
        shop.modal = { body: stub };

        for (const tab of ['eggs', 'stones', 'boosts']) {
            shop.tab = tab;
            let html = '';
            try { html = shop.renderTab(); } catch (err) { html = 'THREW: ' + err.message; }
            check(`the ${tab} tab renders`, html.length > 50 && !html.startsWith('THREW'), html.slice(0, 90));
        }

        shop.tab = 'eggs';
        const eggs = shop.renderTab();
        check('an affordable egg has a live BUY', /data-buy-egg="egg-stage1"[^>]*>BUY/.test(eggs.replace(/\s+/g, ' ')));
        check('an unaffordable egg is disabled, not hidden',
            /data-buy-egg="egg-rare"[\s\S]*?disabled/.test(eggs));
        check('the shortfall is spelled out', eggs.includes('to go'));
        check('prices are shown in hours too', eggs.includes('h of lectures'));

        check('the mart has exactly three pages', (() => {
            shop.render();
            // data-tab, not the class: the container is `shop-tabs`, which any
            // prefix match on `shop-tab` also counts.
            return (stub.innerHTML.match(/data-tab="/g) || []).length === 3;
        })());
        check('the pages are named for what they sell',
            /SPAWN EGG/.test(stub.innerHTML) && /MEGA STONE/.test(stub.innerHTML)
            && /BOOSTER/.test(stub.innerHTML));
        check('an unknown page falls back to the first one',
            (() => { shop.tab = 'nonsense'; return shop.renderTab() === shop.renderEggs(); })());

        shop.tab = 'eggs';
        check('with no eggs the page is a shelf, not an empty container',
            !shop.renderTab().includes('YOUR EGGS'));

        await (async () => {
            await e.buyEgg('egg-stage1');
            shop.tab = 'eggs';
            const page = shop.renderTab();
            // The whole reason the bag is not its own page: buying and seeing
            // what you bought happen in one place.
            check('a bought egg appears on the same page it was bought',
                page.includes('YOUR EGGS') && page.includes('CARRYING'));
            check('it shows how far along it is', page.includes('encounters to go'));
            check('the shelf is still there below it',
                page.includes('data-buy-egg="egg-stage2"'));

            shop.tab = 'stones';
            shop.stoneQuery = 'charizard';
            const stones = shop.renderStoneList();
            check('the stone search filters to both Charizard forms',
                (stones.match(/data-buy-stone=/g) || []).length === 2,
                String((stones.match(/data-buy-stone=/g) || []).length));
            shop.stoneQuery = 'zzzz';
            check('a search with no matches says so', shop.renderStoneList().includes('Nothing matches'));

            check('the wallet strip renders the balance', (() => {
                shop.tab = 'eggs'; shop.render();
                return stub.innerHTML.includes(cfg.formatMoney(e.getMoney()));
            })());
        })();
    }

    console.log('\n=== the shop is wired into the extension ===');
    {
        const fs = require('fs');
        const manifest = JSON.parse(fs.readFileSync(ROOT + 'manifest.json', 'utf8'));
        const js = manifest.content_scripts[0].js;
        check('flickemon-shop.js ships', js.includes('content/flickemon-shop.js'));
        check('it loads after the engine it calls',
            js.indexOf('content/flickemon-shop.js') > js.indexOf('content/flickemon-engine.js'));
        const build = fs.readFileSync(ROOT + 'build.sh', 'utf8');
        for (const f of js) {
            check(`build.sh packages ${f.split('/').pop()}`, build.includes(f));
        }
        const rules = fs.readFileSync(ROOT + 'firestore.rules', 'utf8');
        const save = fs.readFileSync(ROOT + 'background/firestore.js', 'utf8');

        check('rules pin both wallet counters as monotonic',
            /moneyEarned >= earnedBefore/.test(rules) && /moneySpent >= spentBefore/.test(rules));
        check('rules cap how much one write may mint',
            /moneyEarned - earnedBefore <= allowance/.test(rules));
        check('the cap is measured against SERVER time, not the device clock',
            /serverAt' in before/.test(rules) && /request\.time\.toMillis\(\)/.test(rules));
        // The load-bearing line: without it a client could back-date serverAt
        // and hand itself an unbounded allowance on the following write.
        check('serverAt cannot be forged',
            /request\.resource\.data\.serverAt == request\.time/.test(rules));
        check('the counters cannot be dropped to escape the comparison',
            /'moneyEarned' in resource\.data\)\s*\|\|\s*'moneyEarned' in request\.resource\.data/
                .test(rules.replace(/\n\s*/g, ' ')));
        check('the window is capped so going dark does not bank allowance',
            /86400000/.test(rules));

        check('the save writes the counters rules read', /moneyEarned:/.test(save));
        check('the save asks the SERVER to stamp serverAt',
            /setToServerValue: 'REQUEST_TIME'/.test(save) && /updateTransforms/.test(save));
        check('which means it must commit rather than PATCH',
            /documents\}?:commit|\}:commit|:commit`/.test(save) && !/method: 'PATCH'/.test(save));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
})();
