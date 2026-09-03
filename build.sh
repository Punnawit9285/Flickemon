#!/usr/bin/env bash
#
# Builds a clean, minimal extension bundle into dist/.
#
# Why this exists: Chrome's "Pack extension" and the Web Store uploader both
# take an entire directory with no way to exclude anything, so they happily
# sweep in .git/ and node_modules/. This copies ONLY the files the manifest
# actually references.
#
# Usage:
#   ./build.sh          → dist/ (load unpacked from here, or pack from here)
#   ./build.sh --zip    → dist/ plus flickemon.zip for Chrome Web Store upload
#
set -euo pipefail

cd "$(dirname "$0")"
OUT="dist"

rm -rf "$OUT"
mkdir -p "$OUT"

# Runtime files, mirroring what manifest.json references.
cp manifest.json "$OUT/"
mkdir -p "$OUT/content" "$OUT/background" "$OUT/icons" "$OUT/popup" "$OUT/player"
cp content/flickemon-config.js \
   content/flickemon-custom.js \
   content/flickemon-playlist.js \
   content/flickemon-music.js \
   content/flickemon-battle.js \
   content/flickemon-engine.js \
   content/flickemon-pvp.js \
   content/flickemon-trade.js \
   content/flickemon-friends.js \
   content/flickemon-shop.js \
   content/flickemon-ui.js \
   content/content-script.js \
   content/styles.css        "$OUT/content/"
cp background/firebase-config.js \
   background/auth.js \
   background/firestore.js \
   background/pvp.js \
   background/trade.js \
   background/friends.js \
   background/cache.js \
   background/service-worker.js "$OUT/background/"
cp icons/flickemon-48.png icons/flickemon-128.png "$OUT/icons/"
# Optional: the support page shows this if it exists, and says so if it doesn't.
[ -f icons/promptpay-qr.png ] && cp icons/promptpay-qr.png "$OUT/icons/" || true
cp popup/popup.html "$OUT/popup/"
mkdir -p "$OUT/player"
cp player/player.html player/player.js "$OUT/player/"

# Not referenced by the manifest, but the attribution has to travel with the
# package: a zip passed around without the repo is how most people get this.
cp LEGAL.md LICENSE "$OUT/"

# 4,100 sprite PNGs — 1,025 species x {front, back} x {normal, shiny}, ~3.9MB.
# Bundled so the extension never reaches out to a third-party host to draw a
# Pokémon. PNGs only: PROVENANCE.md documents the set for this repo, not for
# the shipped package.
mkdir -p "$OUT/sprites/back/shiny" "$OUT/sprites/shiny" "$OUT/sprites/custom"
cp sprites/*.png            "$OUT/sprites/"
cp sprites/back/*.png       "$OUT/sprites/back/"
cp sprites/shiny/*.png      "$OUT/sprites/shiny/"
cp sprites/back/shiny/*.png "$OUT/sprites/back/shiny/"
# Player-drawn art from flickemon-custom.js. Optional by nature: an empty
# folder is the normal case, so a missing match must not fail the build.
cp sprites/custom/*.png     "$OUT/sprites/custom/" 2>/dev/null || true

echo "Built $OUT/ — $(du -sh "$OUT" | cut -f1)"

if [[ "${1:-}" == "--zip" ]]; then
    # The Web Store assigns its own extension ID from your developer account,
    # so the local "key" (which pins the ID during development, and with it the
    # OAuth redirect URI) is stripped from the uploaded copy only. dist/ keeps
    # its key, so it stays loadable unpacked straight after packaging.
    python3 - <<'PY'
import json
m = json.load(open('dist/manifest.json'))
m.pop('key', None)
json.dump(m, open('dist/manifest.store.json', 'w'), indent=4, ensure_ascii=False)
PY
    rm -f flickemon.zip
    (
        cd "$OUT"
        mv manifest.json manifest.dev.json
        mv manifest.store.json manifest.json
        zip -qr ../flickemon.zip . -x 'manifest.dev.json'
        mv manifest.json manifest.store.json
        mv manifest.dev.json manifest.json
    )
    rm -f "$OUT/manifest.store.json"
    echo "Packaged flickemon.zip — $(du -h flickemon.zip | cut -f1) (key stripped in the zip only)"
fi
