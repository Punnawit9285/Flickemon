# PVP sandbox

Click through PVP in a real browser without two Google accounts, without
Firestore, and without the extension installed anywhere.

    cd /Users/0nigiri/Flickemon
    python3 -m http.server 8000

Then open **two tabs**:

  - http://localhost:8000/tests/pvp-sandbox/?p=a
  - http://localhost:8000/tests/pvp-sandbox/?p=b

Serve it over HTTP rather than opening the file directly — two `file://` tabs
do not reliably share localStorage, and the shared battle document lives there.

## What to do

1. **Give me a party** in both tabs. Each gets six Pokémon (different line-ups,
   so a battle is legible), one of them holding a Mega Stone.
2. The video autoplays; the widget appears because a `<video>` is on the page,
   which is the same signal the real content script uses.
3. Open the widget menu → **PVP**. Player A's six-digit code is printed at the
   top of the page and in the console.
4. A hosts, B types A's code. Both are then in the same battle.

Admin tools are enabled, so the damage multiplier buttons (10x … 10000x) can
push a battle to its end in seconds rather than 2.5 minutes.

## What it actually is

The **real** content scripts — config, battle, engine, ui, pvp, trade. Only two
things are faked, both in `sandbox.js`:

  - the `chrome.*` APIs (`storage.local`, `runtime.sendMessage`, `getURL`)
  - the service worker's message handlers, mirroring `background/pvp.js`

The battle document lives in `localStorage` instead of Firestore, under one key
shared by both tabs, with the same read-modify-write version check the real
transport uses — so a lost race fails here the way it would in production.
`?p=a` and `?p=b` each get their own save namespace and their own uid, so the
two tabs are as separate as two Chrome profiles.

`tests/test_sandbox.js` holds this shim to the same contract as
`background/pvp.js`: codes, lobby lifecycle, self-join and version-mismatch
refusals, per-turn action slots, commits, and save isolation.

## What it does NOT test

Firestore security rules, real Google auth, network latency and the retries
built on it, and the service worker sleeping mid-battle. For those, two signed-in
Chrome profiles on the real site are still the only answer.

Nothing in this directory ships: `build.sh` copies `content/`, `background/`,
`icons/`, `sprites/`, `player/`, `popup/` and `manifest.json`, and never `tests/`.
