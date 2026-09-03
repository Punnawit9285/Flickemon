# Flickémon

A Chrome extension that gamifies studying on [Flick](https://flick.docchula.com) (FlickPlayer) — catch, battle, and evolve Pokémon while you watch lectures.

> **Unofficial fan project.** Flickémon is not affiliated with, endorsed by, or
> associated with Nintendo, Creatures Inc., GAME FREAK inc. or The Pokémon
> Company. Pokémon and all related names and artwork are their trademarks and
> copyrighted works — © 1995–2026 Nintendo / Creatures Inc. / GAME FREAK inc.
> This is a non-commercial student project, free to use, distributed within one
> university faculty for study purposes. See **[LEGAL.md](LEGAL.md)**.

Flickémon runs entirely client-side as a content script. It doesn't talk to Flick's servers or the [FlickPlayer](https://github.com/docchula/FlickPlayer) source — it just watches the page DOM for lecture playback and reacts to it, storing all progress locally via `chrome.storage.local`.

## How to download & Beta-testing !! (very important -- infact you only need this)
**All progress during Beta-testing will be reset when offical launch and all admin authorities given wilk be revoked !!

1.<img width="2637" height="1590" alt="image" src="https://github.com/user-attachments/assets/40134d36-941f-4791-97f5-7cee820470f7" />

2. extract zip file --> Go to `chrome://extensions`, enable **Developer mode** (top right) --> Click **Load unpacked** and select the repo folder
หรือทำตามคลิปนี้ : https://youtu.be/xiT8c8M1OIw?si=o59vWJUzexEsaT3W

3. เข้าไปเล่นใน Flick (https://flick.docchula.com/) ได้เลยย (ถ้ายังไม่ขึ้นให้รีเฟรข)
   
*4. ถ้าอยากได้สิทธิ์ admin(เร่งสปีด เซ็ตเลเวล) ทักหาข้าวปั้น + ส่ง email docchula ให้ในไลน์


## How it works

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 config — permissions, content script matches (`*.docchula.com`, `localhost`) |
| `content/flickemon-config.js` | Game data: Pokémon stats, EXP curves, sprite paths. Single source of truth for balance changes. |
| `sprites/` | 2,050 bundled sprite PNGs (1–1025, front and back). See [PROVENANCE](sprites/PROVENANCE.md). |
| `content/flickemon-engine.js` | Game state machine: party, Pokédex, battles, leveling, persistence to `chrome.storage.local` |
| `content/flickemon-ui.js` | Renders the on-page widget and battle UI |
| `content/content-script.js` | Entry point — boots the engine, injects the UI into the course page DOM, hooks video playback |
| `content/styles.css` | Widget styling |
| `popup/popup.html` | Toolbar popup (click the extension icon) |

No build step — it's vanilla JS loaded directly by the browser.

## Development setup

1. Clone the repo.
2. Go to `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the repo folder.
4. Open a lecture page on Flick (or `localhost` if you're running FlickPlayer locally) and the widget should appear.
5. After editing files, click the reload icon on the extension card in `chrome://extensions` to see changes (content scripts also need a page refresh).

## Contributing

- Open an issue before starting a large feature (new game mechanic, battle rework, etc.) so we can align on approach first. Small fixes/bugs can go straight to a PR.
- Keep game balance/data changes in `flickemon-config.js` rather than hardcoding numbers elsewhere.
- Test on an actual Flick lecture page before opening a PR — describe what you tested in the PR description.
- Match the existing code style (vanilla JS, no framework, JSDoc-style file banners).
- Don't add new permissions to `manifest.json` without discussing in an issue first — this extension intentionally requests only `storage`.
- Keep the constraints in [LEGAL.md](LEGAL.md) intact: nothing sold and nothing paywalled (voluntary donations buy nothing), no official Pokémon logo or branding, no assets taken from game files or ROMs, and no public store listing without discussing it in an issue first.

## Status

Early / experimental. Expect breaking save-format changes between versions for now.

## License and rights

The project's own code and content are [MIT](LICENSE) licensed.

The Pokémon material it uses — the sprites in `sprites/`, the species, type,
move and item names — is **not** ours and is **not** covered by that licence. It
belongs to Nintendo, Creatures Inc. and GAME FREAK inc., and is used here
without licence in a non-commercial fan project.

[**LEGAL.md**](LEGAL.md) sets out who owns what, the constraints that keep this
project's use narrow (non-commercial, no store listing, no game files, no
official branding), and how to reach us with a takedown request — which we will
honour promptly and in full. Read it before forking, redistributing, or
publishing this anywhere public.
