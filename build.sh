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
mkdir -p "$OUT/content" "$OUT/background" "$OUT/icons" "$OUT/popup"
cp content/flickemon-config.js \
   content/flickemon-engine.js \
   content/flickemon-ui.js \
   content/content-script.js \
   content/styles.css        "$OUT/content/"
cp background/firebase-config.js \
   background/auth.js \
   background/firestore.js \
   background/service-worker.js "$OUT/background/"
cp icons/flickemon-48.png icons/flickemon-128.png "$OUT/icons/"
cp popup/popup.html "$OUT/popup/"

echo "Built $OUT/ — $(du -sh "$OUT" | cut -f1)"

if [[ "${1:-}" == "--zip" ]]; then
    # The Web Store assigns its own extension ID from your developer account,
    # so the local "key" (used to pin the ID during development) is stripped.
    python3 - <<'PY'
import json
m = json.load(open('dist/manifest.json'))
m.pop('key', None)
json.dump(m, open('dist/manifest.json','w'), indent=4, ensure_ascii=False)
print('  stripped "key" from dist/manifest.json (Web Store assigns its own ID)')
PY
    rm -f flickemon.zip
    (cd "$OUT" && zip -qr ../flickemon.zip .)
    echo "Packaged flickemon.zip — $(du -h flickemon.zip | cut -f1)"
fi
