const ROOT = require('path').join(__dirname, '..') + '/';
// Starter chooser: region partition, detail panel, stat bars, evolution preview.
global.window = {};
require(ROOT + 'content/flickemon-config.js');
global.document = { addEventListener: () => {} };
require(ROOT + 'content/flickemon-ui.js');

const cfg = global.window.FlickemonConfig;
const FlickemonUI = global.window.FlickemonUI;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const options = cfg.STARTER_OPTIONS.map(id => cfg.getSpeciesById(id));
const ui = new FlickemonUI({ onStateChange(){}, onWildChange(){}, onEvolution(){} });
const REGIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

console.log('\n=== every starter is reachable from exactly one tab ===');
{
    const seen = new Map();
    for (const gen of REGIONS) {
        for (const s of ui.startersForRegion(options, gen)) {
            seen.set(s.id, (seen.get(s.id) || 0) + 1);
        }
    }
    const missing = options.filter(s => !seen.has(s.id)).map(s => s.name);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    check('no starter is unreachable', missing.length === 0, missing.join(', '));
    check('no starter appears on two tabs', dupes.length === 0, dupes.join(', '));
    check('every option accounted for', seen.size === options.length,
        `${seen.size} of ${options.length}`);
}

console.log('\n=== tabs hold the trios you would expect ===');
{
    const names = gen => ui.startersForRegion(options, gen).map(s => s.name);
    check('Kanto is the trio, without the specials',
        JSON.stringify(names(1)) === JSON.stringify(['Bulbasaur', 'Charmander', 'Squirtle']),
        JSON.stringify(names(1)));
    check('Special holds Pikachu and Eevee',
        JSON.stringify(names(0)) === JSON.stringify(['Pikachu', 'Eevee']), JSON.stringify(names(0)));
    for (const gen of [2, 3, 4, 5, 6, 7, 8, 9]) {
        check(`gen ${gen} offers three`, names(gen).length === 3, JSON.stringify(names(gen)));
    }
}

console.log('\n=== evolution line follows the path the game actually takes ===');
{
    const line = cfg.getEvolutionLine(1);
    check('Bulbasaur -> Ivysaur -> Venusaur',
        line.map(e => e.species.name).join('>') === 'Bulbasaur>Ivysaur>Venusaur',
        line.map(e => e.species.name).join('>'));
    check('thresholds carried', line[0].evolvesAt === 16 && line[1].evolvesAt === 32,
        `${line[0].evolvesAt}/${line[1].evolvesAt}`);
    check('final form has no threshold', line[2].evolvesAt === null, String(line[2].evolvesAt));

    // Eevee branches eight ways but canEvolveAt takes the first, so the preview
    // must promise Vaporeon rather than a menu the player never gets.
    const eevee = cfg.getEvolutionLine(133);
    check('Eevee line is the one the engine will pick',
        eevee.map(e => e.species.name).join('>') === 'Eevee>Vaporeon',
        eevee.map(e => e.species.name).join('>'));
    const engineChoice = cfg.canEvolveAt(133, 16);
    check('and it agrees with canEvolveAt', engineChoice.toId === eevee[1].species.id,
        `engine=${engineChoice.toId} preview=${eevee[1].species.id}`);
    check('branch count recorded', eevee[0].branches === 8, String(eevee[0].branches));

    check('a non-evolving species yields a single step',
        cfg.getEvolutionLine(144).length === 1, String(cfg.getEvolutionLine(144).length));
    check('an unknown id yields nothing', cfg.getEvolutionLine(99999).length === 0);

    // Every starter must produce a finite, non-empty line — a malformed chain
    // would otherwise hang the render.
    let worstLen = 0;
    for (const s of options) {
        const l = cfg.getEvolutionLine(s.id);
        worstLen = Math.max(worstLen, l.length);
        if (l.length === 0) { check(`${s.name} has a line`, false); break; }
    }
    check('all 29 starters resolve a line', worstLen > 0 && worstLen <= 4, 'longest=' + worstLen);
}

console.log('\n=== detail panel ===');
{
    const bulba = cfg.getSpeciesById(1);
    const html = ui.renderStarterDetail(bulba);
    check('tinted by the primary type', html.includes('accent-grass'), html.slice(0, 80));
    check('not tinted by the secondary', !html.includes('accent-poison'));
    check('dex number zero-padded', html.includes('No. 001'));
    check('shows both types',
        html.includes('type-pill grass') && html.includes('type-pill poison'));
    check('total base stats shown', html.includes(`${cfg.totalBaseStats(bulba)} total`),
        String(cfg.totalBaseStats(bulba)));
    check('names the final form and its level', html.includes('Becomes Venusaur at Lv.32.'));
    check('every step of the line is drawn',
        [1, 2, 3].every(id => html.includes(cfg.getSpriteUrl(id))));
    check('both thresholds labelled', html.includes('Lv.16') && html.includes('Lv.32'));
    check('no branch note for a linear line', !html.includes('known evolutions'));

    const eevee = ui.renderStarterDetail(cfg.getSpeciesById(133));
    check('branch note appears for Eevee', eevee.includes('8 known evolutions'), 'missing');
    check('and says which one is taken', eevee.includes('Flickémon takes this one'));

    const pika = ui.renderStarterDetail(cfg.getSpeciesById(25));
    check('Pikachu still evolves', pika.includes('Becomes Raichu at Lv.36.'));

    // A species with no evolution must not read "Becomes undefined".
    const ditto = ui.renderStarterDetail(cfg.getSpeciesById(132));
    check('non-evolving species says so', ditto.includes('does not evolve'), 'missing');
    check('no undefined leaked into the copy', !ditto.includes('undefined'),
        ditto.slice(ditto.indexOf('starter-evo-note'), ditto.indexOf('starter-evo-note') + 160));
}

console.log('\n=== stat bars ===');
{
    const bars = ui.renderStatBars(cfg.getSpeciesById(1));   // 45/49/49/45
    check('one row per stat', (bars.match(/starter-stat-row/g) || []).length === 4);
    check('HP 45 becomes a 45% bar', bars.includes('width: 45%'), bars.slice(0, 200));
    check('values printed alongside', bars.includes('>45<') && bars.includes('>49<'));

    // Fixed scale, so a strong stat in one gen looks stronger than a weak one
    // in another — a trio-relative scale would make every trio look identical.
    const pikaBars = ui.renderStatBars(cfg.getSpeciesById(25));  // speed 90
    check('Pikachu speed 90 outruns Bulbasaur 45',
        pikaBars.includes('width: 90%') && bars.includes('width: 45%'));

    let overflow = 0;
    for (const s of options) {
        for (const m of ui.renderStatBars(s).matchAll(/width: (\d+)%/g)) {
            if (+m[1] > 100 || +m[1] < 0) overflow++;
        }
    }
    check('no bar escapes 0-100% across all starters', overflow === 0, overflow + ' out of range');
}

console.log('\n=== evolution overlay extras ===');
{
    const sparks = ui.renderEvolutionSparks();
    const angles = [...sparks.matchAll(/--angle: (\d+)deg/g)].map(m => +m[1]);
    check('a full ring of sparks', angles.length === 12, String(angles.length));
    check('evenly spread around the circle',
        angles.every((a, i) => a === i * 30), JSON.stringify(angles));
    check('staggered so they do not move in lockstep',
        new Set([...sparks.matchAll(/--delay: ([\d.]+)s/g)].map(m => m[1])).size > 1);
    check('two reach distances', new Set([...sparks.matchAll(/--reach: (\d+)px/g)].map(m => m[1])).size === 2);

    const gains = ui.renderEvolutionGains(cfg.getSpeciesById(1), cfg.getSpeciesById(2));
    check('gains computed from the registry',
        gains.includes('HP <b>+15</b>') && gains.includes('ATK <b>+13</b>'), gains);
    check('every stat that grew is listed', (gains.match(/<span>/g) || []).length === 4, gains);

    // Guard the no-gain path: a same-stat pair must render nothing rather than
    // an empty bar of "+0"s.
    check('no row when nothing grows', ui.renderEvolutionGains(cfg.getSpeciesById(1), cfg.getSpeciesById(1)) === '');
    check('missing stats degrade quietly',
        ui.renderEvolutionGains({ name: 'x' }, cfg.getSpeciesById(2)) === '');

    // Some evolutions genuinely lose stats in this four-stat model (the real
    // games offset them with special stats), so the panel must not hide the
    // minuses behind a wall of pluses.
    const shedinja = ui.renderEvolutionGains(cfg.getSpeciesById(290), cfg.getSpeciesById(292));
    check('a losing stat is shown, not hidden', shedinja.includes('HP <b class="down">-30</b>'), shedinja);
    check('and its gain alongside', shedinja.includes('ATK <b>+45</b>'), shedinja);
    check('losses marked for separate styling', shedinja.includes('class="down"'));

    const metapod = ui.renderEvolutionGains(cfg.getSpeciesById(10), cfg.getSpeciesById(11));
    check('a flat-total evolution still itemises the trade',
        metapod.includes('ATK <b class="down">-10</b>') && metapod.includes('DEF <b>+20</b>'), metapod);

    // Unchanged stats stay out of it: Scyther -> Scizor moves HP by zero.
    const scizor = ui.renderEvolutionGains(cfg.getSpeciesById(123), cfg.getSpeciesById(212));
    check('unchanged stats omitted', !scizor.includes('HP'), scizor);
    check('but the rest are present', (scizor.match(/<span>/g) || []).length === 3, scizor);

    // Every chain must render without producing NaN or a bare sign.
    let malformed = 0;
    for (const c of cfg.EVOLUTION_CHAINS) {
        const html = ui.renderEvolutionGains(cfg.getSpeciesById(c.fromId), cfg.getSpeciesById(c.toId));
        if (html.includes('NaN') || html.includes('undefined') || /<b[^>]*>\s*<\/b>/.test(html)) malformed++;
    }
    check(`all ${cfg.EVOLUTION_CHAINS.length} chains render cleanly`, malformed === 0, malformed + ' malformed');
}

console.log('\n=== markup and stylesheet stay in step ===');
{
    // A class in the HTML with no rule behind it is the usual way these two
    // files drift apart after a rename.
    const css = require('fs').readFileSync(ROOT + 'content/styles.css', 'utf8');
    const surfaces = [
        ui.renderStarterDetail(cfg.getSpeciesById(1)),
        ui.renderStarterDetail(cfg.getSpeciesById(133)),
        ui.renderStatBars(cfg.getSpeciesById(4)),
        ui.renderEvolutionGains(cfg.getSpeciesById(1), cfg.getSpeciesById(2)),
    ].join('');

    const used = new Set();
    for (const m of surfaces.matchAll(/class="([^"]+)"/g)) {
        m[1].split(/\s+/).forEach(c => c && used.add(c));
    }
    const unstyled = [...used].filter(c =>
        !new RegExp('\\.' + c.replace(/-/g, '\\-') + '(?![\\w-])').test(css));
    check('every class in the starter markup has a rule', unstyled.length === 0, unstyled.join(', '));

    // The accent classes are generated per type, so all 18 must exist or a
    // Pokémon of the missing type would render untinted.
    const types = new Set();
    for (const s of cfg.POKEMON_REGISTRY) s.types.forEach(t => types.add(t));
    const noAccent = [...types].filter(t => !css.includes(`.accent-${t} {`));
    const noPill = [...types].filter(t => !css.includes(`.type-pill.${t} {`));
    check(`all ${types.size} types have an accent class`, noAccent.length === 0, noAccent.join(', '));
    check('all types have a pill colour', noPill.length === 0, noPill.join(', '));
    check('accents and pills draw from the same tokens',
        [...types].every(t => css.includes(`--type-${t}:`)), 'a token is missing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
