# Sprite assets

4,484 PNGs vendored from [PokeAPI/sprites](https://github.com/PokeAPI/sprites)
(`sprites/pokemon/` and `sprites/pokemon/back/`):

  - National Pokedex numbers **1-1025**, front and back, normal and shiny.
  - **96 Mega Evolution forms** across 86 species, same four variants.

1,121 files in each of `sprites/`, `sprites/back/`, `sprites/shiny/` and
`sprites/back/shiny/`. 18 MB on disk.

Filenames are the bare PokeAPI id, which is why the mega forms needed no new
directory, no `manifest.json` entry and no `build.sh` line: `sprites/*.png`
already matches `10034.png`. `getSpriteUrl(id, shiny)` is likewise unchanged --
callers pass a mega form id instead of a species id. See `MEGA_FORMS` in
`content/flickemon-config.js`.

## Why they are committed rather than fetched

Opening the Pokedex asks for up to 1,025 images at once. Fetched from
`raw.githubusercontent.com` that is 1,025 requests to a host that serves source
files, not a CDN, on every open -- and if it throttles, or a campus network
blocks it, every sprite in the game goes blank together. Vendored, the extension
makes no third-party request at all.

## Refreshing them

    git clone --depth 1 --filter=blob:none --sparse \
        https://github.com/PokeAPI/sprites.git /tmp/pkspr
    cd /tmp/pkspr && git sparse-checkout set --no-cone \
        '/sprites/pokemon/*.png' '/sprites/pokemon/back/*.png' \
        '/sprites/pokemon/shiny/*.png' '/sprites/pokemon/back/shiny/*.png'

then copy ids 1-1025 **and the mega ids below** from each of
`sprites/pokemon/`, `back/`, `shiny/` and `back/shiny/` into the matching
directory here. The blob filter matters: a full clone of that repository is over
a gigabyte.

## Mega form ids

These are **not** contiguous and **not** ordered by dex number -- the Gen 6
(X/Y + ORAS) wave sits at 10033-10090 and the Legends Z-A wave at 10278-10326,
interleaved. Do not derive them by arithmetic. They were taken from
`data/v2/csv/pokemon.csv` in [PokeAPI/pokeapi](https://github.com/PokeAPI/pokeapi)
and each was checked to have **both** the expected `identifier` and the expected
`species_id`. Checking one direction is not enough: an id can resolve to the
right slug under the wrong species.

    10033  venusaur-mega
    10034  charizard-mega-x
    10035  charizard-mega-y
    10036  blastoise-mega
    10037  alakazam-mega
    10038  gengar-mega
    10039  kangaskhan-mega
    10040  pinsir-mega
    10041  gyarados-mega
    10042  aerodactyl-mega
    10043  mewtwo-mega-x
    10044  mewtwo-mega-y
    10045  ampharos-mega
    10046  scizor-mega
    10047  heracross-mega
    10048  houndoom-mega
    10049  tyranitar-mega
    10050  blaziken-mega
    10051  gardevoir-mega
    10052  mawile-mega
    10053  aggron-mega
    10054  medicham-mega
    10055  manectric-mega
    10056  banette-mega
    10057  absol-mega
    10058  garchomp-mega
    10059  lucario-mega
    10060  abomasnow-mega
    10062  latias-mega
    10063  latios-mega
    10064  swampert-mega
    10065  sceptile-mega
    10066  sableye-mega
    10067  altaria-mega
    10068  gallade-mega
    10069  audino-mega
    10070  sharpedo-mega
    10071  slowbro-mega
    10072  steelix-mega
    10073  pidgeot-mega
    10074  glalie-mega
    10075  diancie-mega
    10076  metagross-mega
    10079  rayquaza-mega
    10087  camerupt-mega
    10088  lopunny-mega
    10089  salamence-mega
    10090  beedrill-mega
    10278  clefable-mega
    10279  victreebel-mega
    10280  starmie-mega
    10281  dragonite-mega
    10282  meganium-mega
    10283  feraligatr-mega
    10284  skarmory-mega
    10285  froslass-mega
    10286  emboar-mega
    10287  excadrill-mega
    10288  scolipede-mega
    10289  scrafty-mega
    10290  eelektross-mega
    10291  chandelure-mega
    10292  chesnaught-mega
    10293  delphox-mega
    10294  greninja-mega
    10295  pyroar-mega
    10296  floette-mega
    10297  malamar-mega
    10298  barbaracle-mega
    10299  dragalge-mega
    10300  hawlucha-mega
    10302  drampa-mega
    10303  falinks-mega
    10304  raichu-mega-x
    10305  raichu-mega-y
    10306  chimecho-mega
    10307  absol-mega-z
    10308  staraptor-mega
    10309  garchomp-mega-z
    10310  lucario-mega-z
    10311  heatran-mega
    10312  darkrai-mega
    10313  golurk-mega
    10314  meowstic-male-mega
    10315  crabominable-mega
    10316  golisopod-mega
    10317  magearna-mega
    10318  magearna-original-mega
    10319  zeraora-mega
    10320  scovillain-mega
    10321  glimmora-mega
    10322  tatsugiri-curly-mega
    10323  tatsugiri-droopy-mega
    10324  tatsugiri-stretchy-mega
    10325  baxcalibur-mega
    10326  meowstic-female-mega

`zygarde-mega` (10301) is deliberately absent -- PokeAPI lists the form but
ships no sprite for it, so it is not in `MEGA_FORMS`. Every id above was
verified to have all four variants present and to be a real PNG.

## Rights

PokeAPI/sprites carries no LICENSE file, and the artwork is owned by Nintendo,
Creatures Inc. and GAME FREAK. Flickemon is a non-commercial student project and
claims no ownership of it. Hotlinking these same images, which is what the
extension did previously, does not put the project in a materially different
position -- but shipping them inside a package submitted to the Chrome Web Store
is a more visible use, and Nintendo has historically acted against fan projects.
Worth a decision before any public listing. The Mega Evolution forms add 384
more files to that question.

The project's full position on this — who owns what, the constraints that keep
the use narrow, and the takedown commitment — is in [LEGAL.md](../LEGAL.md).

Mega Stone names are a mixed bag worth knowing about: the Gen 6 wave uses the
real item names (Charizardite X, Gengarite, ...), while the Legends Z-A wave has
no established stone names and those are derived from the species name. Those
ones are ours, not Nintendo's.
