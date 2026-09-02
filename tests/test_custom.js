const ROOT = require('path').join(__dirname, '..') + '/';
// Player-authored Pokemon (content/flickemon-custom.js). Two things matter
// most and are tested hardest: an id must depend on the key and nothing else,
// or reordering the file silently rewrites saved Pokemon; and none of this may
// leak into the 1,025-entry Pokedex.
global.window = { addEventListener() {} };

// A roster of our own, in place of whatever the author currently has. Set
// BEFORE the config loads so the lazy normaliser reads it.
global.window.FlickemonCustom = [
    { key: 'mosscat', name: 'Mosscat', types: ['grass'],
      stats: { hp: 60, attack: 55, defense: 50, speed: 70 }, sprite: 'mosscat.png' },
    { key: 'mosscat-elder', name: 'Mosscat Elder', types: ['grass', 'dark'],
      stats: { hp: 90, attack: 85, defense: 78, speed: 84 }, sprite: 'elder.png',
      shinySprite: 'elder-shiny.png', backSprite: 'elder-back.png' },
    { key: 'emberling', name: 'Emberling', types: ['fire'],
      stats: { hp: 50, attack: 62, defense: 44, speed: 66 }, sprite: 'ember.png',
      wild: true, evolvesTo: 'mosscat-elder', evolvesAt: 22 },
    { key: 'tinylegend', name: 'Tinylegend', types: ['psychic'],
      stats: { hp: 70, attack: 70, defense: 70, speed: 70 }, sprite: 'tl.png',
      legendary: true, wild: true },
    { key: 'oldlegend', name: 'Oldlegend', types: ['dragon'],
      stats: { hp: 88, attack: 92, defense: 80, speed: 84 }, sprite: 'ol.png',
      isLegendary: true },

    // ── the ones that must be rejected, not crash ──
    { name: 'No Key', types: ['normal'], stats: { hp: 1, attack: 1, defense: 1, speed: 1 }, sprite: 'a.png' },
    { key: 'mosscat', name: 'Duplicate', types: ['normal'],
      stats: { hp: 1, attack: 1, defense: 1, speed: 1 }, sprite: 'b.png' },
    { key: 'no-name', types: ['normal'], stats: { hp: 1, attack: 1, defense: 1, speed: 1 }, sprite: 'c.png' },
    { key: 'no-types', name: 'No Types', types: [], stats: { hp: 1, attack: 1, defense: 1, speed: 1 }, sprite: 'd.png' },
    { key: 'three-types', name: 'Three', types: ['fire', 'water', 'grass'],
      stats: { hp: 1, attack: 1, defense: 1, speed: 1 }, sprite: 'e.png' },
    { key: 'bad-type', name: 'Bad Type', types: ['sparkle'],
      stats: { hp: 1, attack: 1, defense: 1, speed: 1 }, sprite: 'f.png' },
    { key: 'no-stats', name: 'No Stats', types: ['normal'], sprite: 'g.png' },
    { key: 'silly-stats', name: 'Silly', types: ['normal'],
      stats: { hp: 9999, attack: 1, defense: 1, speed: 1 }, sprite: 'h.png' },
    { key: 'no-sprite', name: 'No Sprite', types: ['normal'],
      stats: { hp: 1, attack: 1, defense: 1, speed: 1 } },
    null,
];

const warn = console.warn; console.warn = () => {};   // the skip report is expected
require(ROOT + 'content/flickemon-config.js');
require(ROOT + 'content/flickemon-battle.js');
console.warn = warn;

const cfg = global.window.FlickemonConfig;
const B = global.window.FlickemonBattle;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

console.log('\n=== the file is read, and bad entries are skipped not fatal ===');
const roster = cfg.customRoster();
check('the five good entries load', roster.length === 5,
      JSON.stringify(roster.map(r => r.key)));
check('and all ten bad ones are reported', cfg.customRosterProblems().length === 10,
      JSON.stringify(cfg.customRosterProblems()));
check('including a line that is not an entry at all',
      cfg.customRosterProblems().some(p => p.includes('not an entry')));
for (const [why, frag] of [
    ['a missing key', 'needs a key'],
    ['a duplicate key', 'already used'],
    ['a missing name', 'needs a name'],
    ['no types', 'one or two types'],
    ['three types', 'one or two types'],
    ['an unknown type', 'unknown type'],
    ['missing stats', 'hp, attack'],
    ['an absurd stat', 'hp, attack'],
    ['no sprite', 'sprite filename'],
]) {
    check(`${why} is named in the report`,
          cfg.customRosterProblems().some(p => p.includes(frag)),
          JSON.stringify(cfg.customRosterProblems()));
}

console.log('\n=== ids come from the key, and only the key ===');
const moss = cfg.getCustomByKey('mosscat');
check('an id is derived', Number.isFinite(moss.id), String(moss.id));
check('it is inside the custom range', cfg.isCustomSpeciesId(moss.id));
check('and reproducible from the key alone', cfg.customIdFor('mosscat') === moss.id);
check('position in the file is irrelevant',
      cfg.customIdFor('emberling') === cfg.getCustomByKey('emberling').id);
check('a different key is a different id',
      cfg.customIdFor('mosscat') !== cfg.customIdFor('mosscat-elder'));
check('every id is unique', new Set(roster.map(r => r.id)).size === roster.length);
check('none collides with a real dex number',
      roster.every(r => !cfg.POKEMON_REGISTRY.some(p => p.id === r.id)));
check('nor with a mega form id',
      roster.every(r => r.id > 20000));
check('renaming the display name does not move the id',
      cfg.customIdFor('mosscat') === moss.id && moss.name === 'Mosscat');

console.log('\n=== the Pokedex is untouched ===');
check('the registry is still 1,025', cfg.POKEMON_REGISTRY.length === 1025);
check('no custom is in it',
      !cfg.POKEMON_REGISTRY.some(p => p.isCustom));
check('getSpeciesByStage never returns one',
      [1, 2, 3].every(st => !cfg.getSpeciesByStage(st).some(p => p.isCustom)));

console.log('\n=== but they are real species everywhere else ===');
check('getSpeciesById resolves one', cfg.getSpeciesById(moss.id).name === 'Mosscat');
check('and still resolves a real one', cfg.getSpeciesById(25).name === 'Pikachu');
check('an unknown id is still undefined', cfg.getSpeciesById(999999999) === undefined);
check('by name, case-insensitively', cfg.getSpeciesByName('MOSSCAT').id === moss.id);
check('by name reaches the real roster too', cfg.getSpeciesByName('pikachu').id === 25);
check('an unknown name is undefined', cfg.getSpeciesByName('nobody') === undefined);
check('flagged as custom', moss.isCustom === true);
// Two spellings on purpose: `isLegendary` matches the field name used
// everywhere else in the codebase, `legendary` is what gets typed by hand.
check('isLegendary marks one', cfg.getCustomByKey('oldlegend').isLegendary === true);
check('legendary marks one too', cfg.getCustomByKey('tinylegend').isLegendary === true);
check('and it is off by default', moss.isLegendary === false);
check('the flag reaches a combatant, as it does for a real legendary',
      B.toCombatant({ instanceId: 'L', speciesId: cfg.getCustomByKey('oldlegend').id,
                      level: 50, shiny: false, megaStones: [], megaActive: null },
                    cfg.getCustomByKey('oldlegend'), cfg).legendary === true);

console.log('\n=== sprites ===');
check('a custom draws from sprites/custom',
      cfg.getSpriteUrl(moss.id).endsWith('sprites/custom/mosscat.png'), cfg.getSpriteUrl(moss.id));
const elder = cfg.getCustomByKey('mosscat-elder');
check('a shiny variant is used when given',
      cfg.getSpriteUrl(elder.id, true).endsWith('elder-shiny.png'));
check('and falls back to the ordinary art when not',
      cfg.getSpriteUrl(moss.id, true).endsWith('mosscat.png'), cfg.getSpriteUrl(moss.id, true));
check('a back sprite is used when given',
      cfg.getBackSpriteUrl(elder.id).endsWith('elder-back.png'));
check('and falls back to the front view when not',
      cfg.getBackSpriteUrl(moss.id).endsWith('mosscat.png'));
// Outside the extension there is no chrome.runtime.getURL, so these fall back
// to the remote host -- the path shape is what matters, not the prefix.
check('real sprites are unaffected',
      /(^|\/)25\.png$/.test(cfg.getSpriteUrl(25))
   && !cfg.getSpriteUrl(25).includes('/custom/')
   && cfg.getBackSpriteUrl(25, true).includes('back/shiny/'),
      `${cfg.getSpriteUrl(25)} | ${cfg.getBackSpriteUrl(25, true)}`);

console.log('\n=== evolution is optional and self-contained ===');
const ember = cfg.getCustomByKey('emberling');
check('a custom with no evolvesTo is fully evolved', cfg.isFullyEvolved(moss.id));
check('one with it is not', !cfg.isFullyEvolved(ember.id));
check('the target resolves by key', cfg.getEvolution(ember.id).toId === elder.id);
check('at the level asked for', cfg.getEvolution(ember.id).level === 22);
check('canEvolveAt agrees', !!cfg.canEvolveAt(ember.id, 22) && !cfg.canEvolveAt(ember.id, 21));
check('the line walks through', cfg.finalFormOf(ember.id) === elder.id);
check('getAllEvolutions reports the one branch', cfg.getAllEvolutions(ember.id).length === 1);
check('and none for a final custom', cfg.getAllEvolutions(moss.id).length === 0);
check('real evolution chains still work',
      cfg.getEvolution(4).toId === 5 && cfg.finalFormOf(4) === 6);
check('no mega stone is ever in line for one', cfg.megaSourceFor(moss.id) === null);

console.log('\n=== they fight ===');
const member = { instanceId: 'c1', speciesId: elder.id, level: 40,
                 shiny: false, megaStones: [], megaSeen: [], megaActive: null };
const c = B.toCombatant(member, elder, cfg);
check('a combatant is built', c.name === 'Mosscat Elder');
// Scaled to the level, the same way maxHp is on the next line — attack,
// defense and speed used to be the raw base stat at every level.
check('carrying its own stats, not a lookup',
      c.attack === cfg.calculateRealStat(85, 40)
      && c.defense === cfg.calculateRealStat(78, 40)
      && c.speed === cfg.calculateRealStat(84, 40),
      `${c.attack}/${c.defense}/${c.speed}`);
check('and those stats grow with level',
      B.toCombatant({ ...member, level: 80 }, elder, cfg).attack > c.attack);
check('its HP comes from its own base', c.maxHp === cfg.calculateRealMaxHp(90, 40));
check('its types travel', c.types.join('/') === 'grass/dark');
check('it gets a real moveset', c.moves.length > 0, JSON.stringify(c.moves.map(m => m.name)));
check('the moves match its types',
      c.moves.some(m => m.type === 'grass' || m.type === 'dark'),
      JSON.stringify(c.moves.map(m => `${m.name}:${m.type}`)));
// Nothing on the wire is re-derived from speciesId except the picture, which
// is what makes a homemade Pokemon safe to take into PVP at all.
check('everything the opponent needs is on the wire',
      ['name', 'types', 'level', 'maxHp', 'attack', 'defense', 'speed', 'moves', 'damageMult']
        .every(k => c[k] !== undefined));

console.log('\n=== the wild pool is opt-in ===');
check('only marked entries are wild',
      cfg.customRoster().filter(s => s.wild).map(s => s.key).sort().join() === 'emberling,tinylegend');
check('and it is off by default', moss.wild === false);
// The whole design intent, as a number: these are handed out in trades, and
// the wild chance exists only so "could it just turn up?" is not flatly no.
check('the wild chance stays close to zero',
      cfg.CUSTOM_ENCOUNTER_CHANCE > 0 && cfg.CUSTOM_ENCOUNTER_CHANCE <= 0.001,
      `${cfg.CUSTOM_ENCOUNTER_CHANCE} — about 1 in ${Math.round(1 / cfg.CUSTOM_ENCOUNTER_CHANCE)}`);

console.log('\n=== the ตัวซีเคร็ท tag ===');
{
    const fs = require('fs');
    const read = f => fs.readFileSync(ROOT + f, 'utf8');
    const ui = read('content/flickemon-ui.js');
    const pvp = read('content/flickemon-pvp.js');
    const trade = read('content/flickemon-trade.js');
    const css = read('content/styles.css');

    check('the label is Thai and lives in config', cfg.CUSTOM_LABEL === 'ตัวซีเคร็ท', cfg.CUSTOM_LABEL);
    check('there is a compact mark for tight spots',
          typeof cfg.CUSTOM_MARK === 'string' && cfg.CUSTOM_MARK.length === 1, cfg.CUSTOM_MARK);
    check('the mark is not one of the other three',
          !['★', '✦', '◆'].includes(cfg.CUSTOM_MARK), cfg.CUSTOM_MARK);
    // Emoji presentation would render in colour beside three monochrome glyphs.
    check('and it is a text glyph, not an emoji',
          cfg.CUSTOM_MARK.codePointAt(0) < 0x1F000, cfg.CUSTOM_MARK.codePointAt(0).toString(16));

    // Every custom wears it, with nothing to opt into — unlike `wild`.
    check('every custom species is tagged', cfg.customRoster().every(sp => sp.isCustom === true));
    check('and no real one is', !cfg.POKEMON_REGISTRY.some(sp => sp.isCustom));

    // It travels, or an opponent sees an ordinary-looking Pokémon.
    const c = B.toCombatant({ instanceId: 'x', speciesId: moss.id, level: 30,
                              shiny: false, megaStones: [], megaActive: null }, moss, cfg);
    check('a combatant carries the tag', c.custom === true);
    check('an ordinary one does not',
          B.toCombatant({ level: 10 }, cfg.getSpeciesById(19), cfg).custom === false);
    check('it does not touch the stats',
          B.toCombatant({ level: 30 }, moss, cfg).maxHp === c.maxHp);

    // It is independent of the other two, exactly as legendary and shiny are
    // independent of each other.
    const legendCustom = cfg.getCustomByKey('oldlegend');
    const lc = B.toCombatant({ level: 50, shiny: true }, legendCustom, cfg);
    check('a custom can be legendary and shiny at once',
          lc.custom === true && lc.legendary === true && lc.shiny === true);

    check('the widget flags a custom encounter', ui.includes('custom-flag'));
    check('party rows carry the badge', ui.includes('badge-custom'));
    check('the Game Hub partner shows it',
          /partner-big-name[\s\S]{0,420}badge-custom/.test(ui));
    check('PVP line-up rows show it', /pvp-rarity custom/.test(pvp));
    check('PVP nameplates show it', /c\.custom \?/.test(pvp));
    check('a trade offer shows it', /trade-slot-name[\s\S]{0,220}isCustom/.test(trade));
    check('and a trade preview row too', /Lv\$\{pk\.level\}[\s\S]{0,60}isCustom/.test(trade));

    // Rendered from config, never written out — one edit renames it everywhere.
    check('no render site hardcodes the Thai text',
          ![ui, pvp, trade].some(f => f.includes('ตัวซีเคร็ท')));

    check('it has its own colour token', css.includes('--flick-custom:'));
    check('not borrowed from legendary',
          !/--flick-custom:\s*var\(--flick-legendary/.test(css));
    check('the badge is styled', /\.badge-custom\s*\{/.test(css));
    check('so is the widget flag', /\.custom-flag\s*\{/.test(css));
    check('and the PVP rarity mark', /\.pvp-rarity\.custom\s*\{/.test(css));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
