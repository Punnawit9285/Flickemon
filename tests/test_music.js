const ROOT = require('path').join(__dirname, '..') + '/';
// Music: YouTube-only by construction, silenced by a lecture, and surviving
// the widget being rebuilt underneath it.
const fs = require('fs');
global.window = { addEventListener() {} };
require(ROOT + 'content/flickemon-playlist.js');
require(ROOT + 'content/flickemon-music.js');
const Music = global.window.FlickemonMusic;

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
        global.window.FlickemonPlaylist.every(e => P(typeof e === 'string' ? e : e.url)));
    check('tells the reader where to paste', /Paste below this line/.test(src));
    check('explains why it is links and not files',
        /piracy|rights holder|pays whoever/i.test(src));
}

console.log('\n=== a hand-edited file is never allowed to throw ===');
{
    const saved = global.window.FlickemonPlaylist;
    global.window.FlickemonPlaylist = [
        'https://youtu.be/jfKfPfyJRdk',
        'https://example.com/pirated.mp3',       // wrong host
        'total nonsense',
        null, undefined, 42, {}, { url: null },
        { url: 'https://youtu.be/4xDzrJKXOOY', title: 'Named' },
    ];
    const m = new Music();
    check('good entries survive', m.tracks.length === 2, JSON.stringify(m.tracks.map(t => t.title)));
    check('a given title is kept', m.tracks[1].title === 'Named');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
