/**
 * The player tab.
 *
 * Reuses FlickemonMusic for parsing and for the postMessage protocol, but
 * mounts the frame here at a real size in a page the lecture site has no say
 * over. Playback starts from a click in this tab, which is a genuine user
 * gesture — the one thing an in-page player cannot guarantee itself.
 */
(function () {
    'use strict';

    const music = new window.FlickemonMusic();
    const slot = document.getElementById('frame-slot');
    const list = document.getElementById('list');
    const empty = document.getElementById('empty');
    const playBtn = document.getElementById('play');

    // Mount the frame in this page rather than the floating dock.
    music.ensureHost = () => slot;

    if (!music.tracks.length) {
        empty.removeAttribute('hidden');
        list.setAttribute('hidden', '');
        playBtn.disabled = true;
    }

    function draw() {
        const st = music.getState();
        playBtn.textContent = st.playing ? '❚❚ Pause' : '▶ Play';
        document.title = st.playing && st.track
            ? `♪ ${st.track.title}` : 'Flickémon Music';
        list.innerHTML = music.tracks.map((t, i) =>
            `<li class="${i === st.index ? 'current' : ''}" data-i="${i}">
                <span class="n">${i + 1}</span><span>${t.title}</span>
            </li>`).join('');
        list.querySelectorAll('li').forEach(li =>
            li.addEventListener('click', () => music.play(Number(li.dataset.i))));
    }

    music.onChange(draw);
    draw();

    playBtn.addEventListener('click', () => music.toggle());
    document.getElementById('next').addEventListener('click', () => music.next());
    document.getElementById('prev').addEventListener('click', () => music.previous());

    // A lecture starting anywhere silences this tab too.
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'MUSIC_LECTURE_STARTED' && music.playing) music.pause();
    });
})();
