# Flickémon

A Chrome extension that gamifies studying on [Flick](https://flick.docchula.com) (FlickPlayer) — catch, battle, and evolve Pokémon while you watch lectures.

Flickémon runs entirely client-side as a content script. It doesn't talk to Flick's servers or the [FlickPlayer](https://github.com/docchula/FlickPlayer) source — it just watches the page DOM for lecture playback and reacts to it, storing all progress locally via `chrome.storage.local`.

## How it works

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 config — permissions, content script matches (`*.docchula.com`, `localhost`) |
| `content/flickemon-config.js` | Game data: Pokémon stats, EXP curves, sprite URLs. Single source of truth for balance changes. |
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

## Status

Early / experimental. Expect breaking save-format changes between versions for now.

## License

[MIT](LICENSE)
