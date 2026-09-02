/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                          ║
 * ║   YOUR OWN POKÉMON                                                       ║
 * ║                                                                          ║
 * ║   Copy one block, change the bits, drop a PNG in sprites/custom/.        ║
 * ║                                                                          ║
 * ║       {                                                                  ║
 * ║           key:    'mosscat',           // never change this again        ║
 * ║           name:   'Mosscat',                                             ║
 * ║           types:  ['grass'],                                             ║
 * ║           stats:  { hp: 60, attack: 55, defense: 50, speed: 70 },        ║
 * ║           sprite: 'mosscat.png',       // sits in sprites/custom/        ║
 * ║       },                                                                 ║
 * ║                                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * When you are done:
 *   1. Save this file.
 *   2. Go to chrome://extensions and press ↻ on Flickémon.
 *   3. Refresh the lecture page.
 *
 * If you get an entry wrong nothing breaks — that one is skipped and the
 * console says which and why. Open DevTools and look for "[Flickémon custom]".
 *
 * ── `key` is the one thing you must not change ──
 *
 * The id your Pokémon is saved under is worked out from `key`, so the same key
 * always means the same Pokémon. That is what lets you reorder this file,
 * insert entries in the middle, or delete one, without any of your saved
 * Pokémon turning into something else.
 *
 * Renaming a key is the one edit that breaks a save: anything you had caught
 * under the old key becomes an unknown species. Change `name` freely — that is
 * only what it is called on screen. Never recycle a key for a different
 * Pokémon.
 *
 * ── What is optional ──
 *
 *   shinySprite: 'mosscat-shiny.png'   a shiny; falls back to the normal one
 *   backSprite:  'mosscat-back.png'    the view from behind in PVP
 *   isLegendary: true                  see below — `legendary: true` also works
 *   wild:        true                  can turn up in lectures (default: no)
 *   evolvesTo:   'mosscat-elder'       another key here, or a Pokédex number
 *   evolvesAt:   30                    the level it evolves at
 *
 * ── the ตัวซีเคร็ท tag ──
 *
 * Every Pokémon in this file wears it automatically — there is nothing to set.
 * It is a third rarity tag beside Legendary and Shiny, and independent of both:
 * one of yours can be legendary, shiny, both or neither, and shows every tag it
 * has earned rather than one standing in for the others.
 *
 * It appears on the party row, on the Game Hub partner, on the widget when one
 * turns up wild, on PVP nameplates, and in a trade — including on the screen of
 * whoever you trade it to. The name is set once in CUSTOM_LABEL in
 * flickemon-config.js; nothing else spells it out.
 *
 * ── isLegendary ──
 *
 * Marks it the way Mewtwo and Rayquaza are marked, and it gets everything that
 * comes with that: the gold ★ beside its name in the party, on PVP nameplates
 * and in a trade preview — and, because legendaries are never lost, it is
 * caught the moment you beat it, ignores the 40% capture roll, and will not
 * flee however far above your level it is.
 *
 * It does NOT join the Lv.40 legendary encounter draw. That one is the 94 real
 * legendaries; yours has its own way in, below.
 *
 * ── How you get one ──
 *
 * The intended route is an admin handing one over in a **trade**. That works
 * with no special handling: a custom Pokémon crosses a trade like any other,
 * keeping its level, its shininess and its stones. The person receiving it
 * needs this same file, which they have — it ships with the extension.
 *
 * Two other ways in:
 *
 *   - **Summon it by name** from the admin panel. Works whatever else is set.
 *   - **`wild: true`** enters it in the lottery: CUSTOM_ENCOUNTER_CHANCE is
 *     1 in 10,000 encounters, about one sighting per 420 hours of lectures.
 *     That is close enough to never that it is a rumour rather than a plan —
 *     which is the point. Ones without the flag never spawn at all, so an
 *     unmarked roster changes nothing whatsoever about the game.
 *
 * ── The sprite ──
 *
 * Any PNG in sprites/custom/. 96×96 matches the rest of the game and keeps the
 * pixel look; bigger works but will be scaled. Transparent background.
 *
 * ── What this does NOT touch ──
 *
 * The Pokédex stays the 1,025 real ones. Yours do not appear in that grid, are
 * not counted in "caught out of 1,025", and cannot be filled in by mistake.
 * They live in your party, battle normally, and can hold their own in PVP —
 * the stats travel with them, so an opponent who has never seen your file
 * still fights the Pokémon you built.
 */

window.FlickemonCustom = [

    // ─────────────── Add your Pokémon below ───────────────

    // A worked example. Delete it once you have your own — or keep it: with no
    // `wild: true` it will never turn up unless you summon it.
    {
        key:    'example-mon',
        name:   'Examplemon',
        types:  ['normal'],
        stats:  { hp: 55, attack: 50, defense: 50, speed: 55 },
        sprite: 'example-mon.png',
    },

];
