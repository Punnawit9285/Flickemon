const ROOT = require('path').join(__dirname, '..') + '/';
// Music: YouTube-only by construction, silenced by a lecture, and surviving
// the widget being rebuilt underneath it.
const fs = require('fs');
// Listeners are captured, not discarded: the ENDED handling that keeps a
// battle theme from handing over to the playlist lives inside one of them.
const winListeners = {};
global.window = {
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
};
global.location = { origin: 'https://flick.docchula.com' };
require(ROOT + 'content/flickemon-playlist.js');
require(ROOT + 'content/flickemon-music.js');
const Music = global.window.FlickemonMusic;

/**
 * Source with comments blanked out.
 *
 * Assertions about what the code does must not be satisfied — or defeated — by
 * prose. Three checks in this suite have been fooled by their own explanatory
 * comment already: a rule explaining why the frame is not display:none, and a
 * comment explaining why tabs.query is not called.
 */
const code = (rel) => fs.readFileSync(ROOT + rel, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const P = Music.parseYouTubeUrl;

console.log('\n=== every shape of YouTube link a student might paste ===');
{
    const ID = 'jfKfPfyJRdk';
    for (const [label, url] of [
        ['address bar',   `https://www.youtube.com/watch?v=${ID}`],
        ['no www',        `https://youtube.com/watch?v=${ID}`],
        ['share link',    `https://youtu.be/${ID}`],
        ['share + time',  `https://youtu.be/${ID}?t=42`],
        ['mobile',        `https://m.youtube.com/watch?v=${ID}`],
        ['embed',         `https://www.youtube.com/embed/${ID}`],
        ['shorts',        `https://www.youtube.com/shorts/${ID}`],
        ['live',          `https://www.youtube.com/live/${ID}`],
        ['nocookie',      `https://www.youtube-nocookie.com/embed/${ID}`],
        ['no scheme',     `youtube.com/watch?v=${ID}`],
        ['bare id',       ID],
        ['extra params',  `https://www.youtube.com/watch?app=desktop&v=${ID}&feature=share`],
    ]) {
        const r = P(url);
        check(`${label} -> ${ID}`, r && r.videoId === ID, JSON.stringify(r));
    }

    const withList = P('https://www.youtube.com/watch?v=jfKfPfyJRdk&list=PLabc123');
    check('a video inside a playlist keeps both',
        withList.videoId === 'jfKfPfyJRdk' && withList.listId === 'PLabc123', JSON.stringify(withList));
    const listOnly = P('https://www.youtube.com/playlist?list=PLabc123');
    check('a playlist link needs no video id',
        listOnly && listOnly.listId === 'PLabc123' && listOnly.videoId === null, JSON.stringify(listOnly));
}

console.log('\n=== anything that is not YouTube is refused ===');
{
    // This is what keeps the feature legitimate: there is no code path that
    // plays a file we host or link to directly.
    for (const bad of [
        'https://example.com/song.mp3',
        'https://soundcloud.com/artist/track',
        'https://drive.google.com/file/d/abc/view',
        'file:///Users/me/music.mp3',
        'https://notyoutube.com/watch?v=jfKfPfyJRdk',
        'https://youtube.com.evil.example/watch?v=jfKfPfyJRdk',
        'https://www.youtube.com/', 'not a url', '', null, undefined, 42, {},
    ]) {
        check(`refuses ${JSON.stringify(bad)}`.slice(0, 62), P(bad) === null, JSON.stringify(P(bad)));
    }
}

console.log('\n=== the playlist file ===');
{
    const src = fs.readFileSync(ROOT + 'content/flickemon-playlist.js', 'utf8');
    check('sets a global the player reads', /window\.FlickemonPlaylist\s*=/.test(src));
    check('ships with working examples', Array.isArray(global.window.FlickemonPlaylist)
        && global.window.FlickemonPlaylist.length > 0);
    check('every shipped example parses',
        global.window.FlickemonPlaylist.every(e => P(Music.readEntry(e).url)));
    check('shows the name-and-url shape up front', /\{ name: .*url: /.test(src));
    check('every shipped line uses that shape',
        global.window.FlickemonPlaylist.every(e => e && typeof e === 'object' && e.name && e.url));
    check('tells the reader where to add', /Add your music below/.test(src));
    check('says what to do after saving', /chrome:\/\/extensions/.test(src));
    check('explains why it is links and not files',
        /piracy|rights holder|pays whoever/i.test(src));
}

console.log('\n=== the format forgives a hand-edited file ===');
{
    // Documented shape is { name, url }, but this is edited by hand at midnight.
    const cases = [
        ['documented',    { name: 'A', url: 'https://youtu.be/jfKfPfyJRdk' }, 'A'],
        ['title instead', { title: 'B', url: 'https://youtu.be/jfKfPfyJRdk' }, 'B'],
        ['link instead',  { name: 'C', link: 'https://youtu.be/jfKfPfyJRdk' }, 'C'],
        ['pair',          ['D', 'https://youtu.be/jfKfPfyJRdk'], 'D'],
        ['pair reversed', ['https://youtu.be/jfKfPfyJRdk', 'E'], 'E'],
        ['bare url',      'https://youtu.be/jfKfPfyJRdk', ''],
    ];
    for (const [label, entry, expectName] of cases) {
        const r = Music.readEntry(entry);
        check(`reads a ${label} entry`,
            P(r.url) && r.name === expectName, JSON.stringify(r));
    }
    check('an unnamed entry still plays, just numbered',
        (() => {
            const saved = global.window.FlickemonPlaylist;
            global.window.FlickemonPlaylist = ['https://youtu.be/jfKfPfyJRdk'];
            const m = new Music();
            global.window.FlickemonPlaylist = saved;
            return m.tracks.length === 1 && /^Track 1$/.test(m.tracks[0].title);
        })());
}

console.log('\n=== a hand-edited file is never allowed to throw ===');
{
    const saved = global.window.FlickemonPlaylist;
    global.window.FlickemonPlaylist = [
        'https://youtu.be/jfKfPfyJRdk',
        'https://example.com/pirated.mp3',       // wrong host
        'total nonsense',
        null, undefined, 42, {}, { url: null },
        { name: 'Named', url: 'https://youtu.be/4xDzrJKXOOY' },
    ];
    const m = new Music();
    check('good entries survive', m.tracks.length === 2, JSON.stringify(m.tracks.map(t => t.title)));
    check('a given name is kept', m.tracks[1].title === 'Named');
    check('an unnamed track is numbered', /^Track \d+$/.test(m.tracks[0].title), m.tracks[0].title);
    check('bad lines are reported, not swallowed', m.badEntries.length >= 3,
        JSON.stringify(m.badEntries));
    check('empty entries are not reported as errors',
        !m.badEntries.includes('undefined'), JSON.stringify(m.badEntries));

    global.window.FlickemonPlaylist = 'not an array';
    check('a broken file yields no tracks rather than crashing', new Music().tracks.length === 0);
    global.window.FlickemonPlaylist = saved;
}

console.log('\n=== the embed itself ===');
{
    const src = fs.readFileSync(ROOT + 'content/flickemon-music.js', 'utf8');
    check('uses YouTube\'s own embed', /youtube-nocookie\.com/.test(src));
    check('no remote script is loaded',
        !/iframe_api|<script/.test(src), 'MV3 forbids remote code');
    check('drives the player over postMessage', /postMessage\(/.test(src));
    check('messages are targeted, not wildcarded',
        !/postMessage\([^)]*,\s*['"]\*['"]/.test(src), 'a wildcard target leaks to any frame');
    check('inbound messages are origin-checked', /e\.origin !== MUSIC_ORIGIN/.test(src));
    check('and source-checked',
        /e\.source !== this\.frame\.contentWindow/.test(src), 'origin alone is not enough');
    check('autoplay is passed through to the frame', /allow="autoplay/.test(src));
    // Comments out first: the rule's own explanation mentions display:none.
    const css = fs.readFileSync(ROOT + 'content/styles.css', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    check('the dock is a real, visible size',
        /\.flickemon-music-host[^}]*width:\s*\d{2,}px/.test(css)
        && !/\.flickemon-music-host[^}]*opacity:\s*0/.test(css)
        && !/\.flickemon-music-host[^}]*left:\s*-\d{3,}px/.test(css),
        'Chrome will not autoplay an effectively invisible iframe');
    check('collapsing keeps the frame non-zero',
        /collapsed \.music-dock-frame[^}]*height:\s*1px/.test(css),
        'a zero-height frame stops playing');

    check('the frame is not display:none',
        !/\.flickemon-music-host[^}]*display:\s*none/.test(css),
        'a display:none frame gets throttled and may not play');
}

console.log('\n=== a lecture silences it ===');
{
    const m = new Music();
    let paused = 0;
    m.pause = () => { paused++; m.playing = false; };
    m.playing = true;

    const handlers = {};
    const video = { dataset: {}, addEventListener: (e, f) => { handlers[e] = f; } };
    m.bindLectureVideo(video);
    check('the video is hooked', typeof handlers.play === 'function');

    handlers.play();
    check('starting a lecture pauses the music', paused === 1);

    // Idempotent: the content script re-offers the same element every second.
    m.bindLectureVideo(video);
    m.bindLectureVideo(video);
    check('re-binding does not stack handlers', paused === 1);

    // Nothing playing, nothing to pause.
    m.playing = false;
    handlers.play();
    check('a lecture with no music playing is a no-op', paused === 1);

    check('there is no auto-resume path',
        !/addEventListener\('pause'[\s\S]{0,120}play\(\)/.test(
            fs.readFileSync(ROOT + 'content/flickemon-music.js', 'utf8')),
        'pausing a lecture usually means stopping to think');
}

console.log('\n=== it survives the widget being rebuilt ===');
{
    const src = fs.readFileSync(ROOT + 'content/flickemon-music.js', 'utf8');
    check('mounts on body, not inside the widget',
        /document\.body\.appendChild\(host\)/.test(src));

    const ui = fs.readFileSync(ROOT + 'content/flickemon-ui.js', 'utf8');
    check('the widget only draws a bar, never the player',
        !/flickemon-music-host/.test(ui));
    check('the bar is repainted after a rebuild', /this\.renderMusicBar\(card\)/.test(ui));
    check('the player is created once and reused', /if \(!this\.music && window\.FlickemonMusic\)/.test(ui));
    check('drawing never creates a player',
        /not getMusic: never create one just to draw/.test(ui));

    const cs = fs.readFileSync(ROOT + 'content/content-script.js', 'utf8');
    check('the lecture hook is re-offered as videos appear', /bindLectureVideo\(video\)/.test(cs));
}

console.log('\n=== wiring ===');
{
    const mf = JSON.parse(fs.readFileSync(ROOT + 'manifest.json', 'utf8'));
    const js = mf.content_scripts[0].js;
    check('playlist is loaded', js.includes('content/flickemon-playlist.js'));
    check('player is loaded', js.includes('content/flickemon-music.js'));
    check('the playlist loads before the player reads it',
        js.indexOf('content/flickemon-playlist.js') < js.indexOf('content/flickemon-music.js'));
    check('no new permission was needed',
        !JSON.stringify(mf.permissions || []).includes('youtube'), JSON.stringify(mf.permissions));

    const build = fs.readFileSync(ROOT + 'build.sh', 'utf8');
    check('both ship in the build',
        build.includes('flickemon-playlist.js') && build.includes('flickemon-music.js'));

    const ui = fs.readFileSync(ROOT + 'content/flickemon-ui.js', 'utf8');
    check('Music is in the menu', ui.includes('music-item') && ui.includes('> Music<'));
    check('and wired up', /music-item'\)\.addEventListener/.test(ui));
}

console.log('\n=== the tab fallback ===');
{
    const src = fs.readFileSync(ROOT + 'content/flickemon-music.js', 'utf8');
    const sw = fs.readFileSync(ROOT + 'background/service-worker.js', 'utf8');
    const mf = JSON.parse(fs.readFileSync(ROOT + 'manifest.json', 'utf8'));

    check('the player can be opened as a tab', /MUSIC_OPEN_TAB/.test(src) && /MUSIC_OPEN_TAB/.test(sw));
    check('the standalone page exists', fs.existsSync(ROOT + 'player/player.html'));
    check('and its script', fs.existsSync(ROOT + 'player/player.js'));
    check('it reuses the same player', /flickemon-music\.js/.test(
        fs.readFileSync(ROOT + 'player/player.html', 'utf8')));
    check('it opens pinned and in the background', /pinned: true/.test(sw) && /active: false/.test(sw));

    // Finding the tab by URL needs the "tabs" permission, which warns about
    // browsing history. A music player must not cost that.
    check('no tabs permission is requested',
        !(mf.permissions || []).includes('tabs'), JSON.stringify(mf.permissions));
    check('the tab is remembered instead of queried',
        /MUSIC_TAB_KEY/.test(sw) && !/tabs\.query\(/.test(code('background/service-worker.js')));
    check('a closed tab is forgotten', /onRemoved/.test(sw));
    check('a lecture silences the tab too',
        /MUSIC_LECTURE_STARTED/.test(sw) && /MUSIC_LECTURE_STARTED/.test(
            fs.readFileSync(ROOT + 'player/player.js', 'utf8')));

    const build = fs.readFileSync(ROOT + 'build.sh', 'utf8');
    check('the player page ships', /player\/player\.html/.test(build));
}

console.log('\n=== the PVP battle theme ===');
{
    // A player that never touches a DOM: mount is the only method that needs
    // one, and what these tests care about is which track it is handed.
    const build = () => {
        const before = (winListeners.message || []).length;
        const m = new Music();
        // Each instance registers its own listener, bound to its own `this`.
        // Taking [0] would drive the first player built anywhere in this file
        // — whose frame is null, so every message would be dropped and the
        // assertions would pass on an empty log.
        m.onMessage = (winListeners.message || [])[before];
        m.mounted = [];
        m.mount = (track, autoplay) => {
            m.mounted.push({ track, autoplay });
            m.playing = Boolean(autoplay);
        };
        return m;
    };

    const m = build();
    check('the battle theme is read from the playlist file',
        m.battleTrack && m.battleTrack.videoId, JSON.stringify(m.battleTrack));
    check('and it loops, because a battle runs as long as it runs',
        m.battleTrack.loop === true);

    // The whole reason it is a separate entry rather than a flagged line: it is
    // not a member of the list, so Next never reaches it and pressing play
    // never starts it. Identity, not the URL — the same music being in the
    // playlist as well is a perfectly reasonable thing for someone to want.
    check('it is not a member of the playlist', !m.tracks.includes(m.battleTrack));
    check('and it does not lengthen it',
        m.tracks.length === window.FlickemonPlaylist.length,
        `${m.tracks.length} vs ${window.FlickemonPlaylist.length}`);

    console.log('\n  -- it gives the music back when the battle ends --');
    {
        const m = build();
        m.index = 2;
        m.playing = true;                       // already listening to track 3
        check('the theme starts', m.playBattleTheme() === true);
        check('and it is what is in the frame',
            m.mounted.at(-1).track === m.battleTrack && m.mounted.at(-1).autoplay === true);
        check('the screen says so', m.getState().battle === true
            && m.getState().track === m.battleTrack);
        check('a second call is a no-op, not a restart',
            m.playBattleTheme() === true && m.mounted.length === 1, m.mounted.length);

        m.endBattleTheme();
        check('the previous track comes back',
            m.mounted.at(-1).track === m.tracks[2] && m.mounted.at(-1).autoplay === true);
        check('and the playlist is in charge again',
            m.override === null && m.resume === null && m.getState().battle === false);
    }

    console.log('\n  -- and leaves silence alone --');
    {
        const m = build();
        m.playing = false;                      // music was off
        m.playBattleTheme();
        m.endBattleTheme();
        check('nothing is playing afterwards', m.playing === false);
        check('no track was started on the way out', m.mounted.length === 1,
            JSON.stringify(m.mounted.map(x => x.track.title)));
    }

    console.log('\n  -- a deliberate choice mid-battle wins --');
    {
        const m = build();
        m.playing = false;
        m.playBattleTheme();
        m.load(1, true);                        // the student picked something
        check('picking a track drops the override', m.override === null && m.resume === null);
        m.endBattleTheme();
        check('so the battle ending does not overrule them',
            m.mounted.at(-1).track === m.tracks[1], m.mounted.at(-1).track.title);
    }

    console.log('\n  -- it repeats instead of handing over --');
    {
        const m = build();
        check('the player listens for the frame', typeof m.onMessage === 'function');

        const contentWindow = { postMessage() {} };
        m.frame = { contentWindow, addEventListener() {} };
        m.playBattleTheme();

        const ended = () => m.onMessage({
            origin: 'https://www.youtube-nocookie.com',
            source: contentWindow,
            data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 0 } }),
        });

        ended();
        check('a battle theme that runs out starts again',
            m.mounted.at(-1).track === m.battleTrack, m.mounted.at(-1).track.title);
        check('and does not drop the playlist into the battle',
            m.override === m.battleTrack && m.mounted.length === 2, m.mounted.length);

        // Outside a battle the same event must still advance normally.
        m.endBattleTheme();
        m.index = 0;
        m.frame = { contentWindow, addEventListener() {} };
        const before = m.mounted.length;
        ended();
        check('an ordinary track still advances to the next one',
            m.mounted.length === before + 1 && m.mounted.at(-1).track === m.tracks[1],
            m.mounted.at(-1).track.title);
    }

    console.log('\n  -- the embed URL --');
    {
        const m = build();
        const src = m.frameSrc(m.battleTrack, true);
        check('points at the no-cookie host', src.startsWith('https://www.youtube-nocookie.com/embed/'));
        check('asks the embed to loop', /[?&]loop=1/.test(src), src);
        check('autoplays', /[?&]autoplay=1/.test(src));

        // A lone video needs a one-item playlist of itself or `loop` does nothing.
        const solo = m.frameSrc({ videoId: 'jfKfPfyJRdk', listId: null, loop: true }, true);
        check('a single video is given itself to loop over',
            /[?&]playlist=jfKfPfyJRdk/.test(solo), solo);
        const listed = m.frameSrc({ videoId: 'jfKfPfyJRdk', listId: 'PLabc', loop: true }, true);
        check('a real playlist is not', !/[?&]playlist=/.test(listed), listed);

        const plain = m.frameSrc(m.tracks[0], true);
        check('ordinary tracks do not loop', !/[?&]loop=/.test(plain), plain);
    }

    console.log('\n  -- no battle theme configured is a supported answer --');
    {
        const saved = global.window.FlickemonBattleMusic;
        global.window.FlickemonBattleMusic = null;
        const m = build();
        check('nothing is parsed', m.battleTrack === null);
        check('and the caller is told nothing happened', m.playBattleTheme() === false);
        check('so ending it does nothing either',
            (m.endBattleTheme(), m.mounted.length === 0));
        global.window.FlickemonBattleMusic = saved;
    }
}

console.log('\n=== PVP asks for it, and hands it back ===');
{
    const pvp = code('content/flickemon-pvp.js');

    check('the battle screen starts the theme', /startBattleMusic\(\)/.test(pvp)
        && /playBattleTheme/.test(pvp));

    // The three ways out of a battle. Missing any one leaves a theme looping
    // over a lecture the student has gone back to.
    check('the result screen ends it', /if \(over\) this\.stopBattleMusic\(\)/.test(pvp));
    check('closing the modal ends it',
        /async leave\(\) \{\s*this\.stopBattleMusic\(\);/.test(pvp));
    check('an opponent walking out ends it',
        /onOpponentLeft\(\) \{\s*this\.stopBattleMusic\(\);/.test(pvp));

    // The lobby is where six digits get read out loud.
    check('the lobby stays quiet',
        !/renderLobby\(\)[\s\S]{0,400}?BattleMusic/.test(pvp));

    // One player, so the lecture rule still reaches it.
    check('it reuses the page player rather than making a second one',
        /this\.ui\.getMusic\(\)/.test(pvp) && !/new (window\.)?FlickemonMusic/.test(pvp));

    check('and there is a mute inside the battle screen',
        /pvp-audio/.test(pvp) && /music\.toggle\(\)/.test(pvp));
    check('which is styled where the dock cannot be reached',
        /\.pvp-audio\b/.test(code('content/styles.css')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
