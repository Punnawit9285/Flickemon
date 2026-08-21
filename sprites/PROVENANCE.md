# Sprite assets

2,050 PNGs — front and back sprites for National Pokédex numbers 1–1025 —
vendored from [PokeAPI/sprites](https://github.com/PokeAPI/sprites)
(`sprites/pokemon/` and `sprites/pokemon/back/`).

## Why they are committed rather than fetched

Opening the Pokédex asks for up to 1,025 images at once. Fetched from
`raw.githubusercontent.com` that is 1,025 requests to a host that serves source
files, not a CDN, on every open — and if it throttles, or a campus network
blocks it, every sprite in the game goes blank together. Vendored, the extension
makes no third-party request at all.

1.93 MB total; the packaged extension is 2.3 MB.

## Refreshing them

    git clone --depth 1 --filter=blob:none --sparse \
        https://github.com/PokeAPI/sprites.git /tmp/pkspr
    cd /tmp/pkspr && git sparse-checkout set --no-cone \
        '/sprites/pokemon/*.png' '/sprites/pokemon/back/*.png'

then copy ids 1–1025 from `sprites/pokemon/` and `sprites/pokemon/back/` into
`sprites/` and `sprites/back/` here. The blob filter matters: a full clone of
that repository is over a gigabyte.

`test_sprites_bundle.js` checks that every species in `POKEMON_REGISTRY` has
both a front and a back file, that each is a real PNG, and that the manifest
still exposes them.

## Rights

PokeAPI/sprites carries no LICENSE file, and the artwork is owned by Nintendo,
Creatures Inc. and GAME FREAK. Flickémon is a non-commercial student project and
claims no ownership of it. Hotlinking these same images, which is what the
extension did previously, does not put the project in a materially different
position — but shipping them inside a package submitted to the Chrome Web Store
is a more visible use, and Nintendo has historically acted against fan projects.
Worth a decision before any public listing.
