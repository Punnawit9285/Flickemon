# Your own sprites

PNGs for the Pokémon you define in `content/flickemon-custom.js`. The filename
is whatever you put in that entry's `sprite:` field — no numbering, no naming
rule.

  - **96×96** matches the rest of the game and keeps the pixel look. Larger art
    works and is scaled down, but will look softer beside the real sprites.
  - **Transparent background.** The widget, the party list and the battle screen
    all sit on coloured surfaces.
  - **PNG only** — `build.sh` and the extension manifest both glob `*.png`.

Optional extras, per entry: `shinySprite:` for an alternate colouring, and
`backSprite:` for the view from behind in PVP. Leave either out and the
ordinary sprite is used instead.

Nothing here is checked in by default and nothing here is Nintendo's — this
folder exists for art you made. See `../PROVENANCE.md` for where the other
4,484 files came from and the rights question that hangs over them.
