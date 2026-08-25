/**
 * Flickémon Music
 * ───────────────
 * Background music for the browsing-and-choosing part of studying, that gets
 * out of the way the instant a lecture starts.
 *
 * ── Why an iframe and not an audio element ──
 *
 * Everything plays through YouTube's own embedded player. YouTube serves the
 * audio, runs its ads and pays the rights holders, so nothing here touches a
 * copyrighted file. It also means no remote code: MV3 forbids loading
 * YouTube's IFrame API script, but an <iframe> is a nested browsing context
 * rather than script we execute, and the same player accepts the API's
 * commands over postMessage. That is the documented protocol the API itself
 * speaks — we just skip the loader.
 *
 * The embed is youtube-nocookie.com, YouTube's own privacy-preserving host:
 * identical playback and identical licensing, without tracking cookies until
 * something is actually played.
 *
 * ── Why it survives the page ──
 *
 * The player mounts on document.body, not inside the widget. injectUI tears
 * the widget down and rebuilds it whenever the site's router changes the DOM,
 * and a player inside it would stop mid-bar every time. A full page reload
 * still stops the music — nothing short of an offscreen document survives
 * that, and an offscreen document has no user gesture to autoplay with.
 */

const MUSIC_HOST_ID = 'flickemon-music-host';
const MUSIC_ORIGIN = 'https://www.youtube-nocookie.com';
const MUSIC_STATE_KEY = 'flickemon_music_v1';

/** Player states reported by the embed, from the IFrame API's vocabulary. */
const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

class FlickemonMusic {
    constructor() {
        this.tracks = [];
        this.index = 0;
        this.playing = false;
        this.ready = false;
        this.volume = 40;
        this.frame = null;
        this.host = null;
        this.listeners = [];
        this.blocked = false;

        this.loadTracks();
        this.bindPlayerMessages();
        this.restoreSettings();
    }

    // ─────────────────────── Playlist ───────────────────────

    /**
     * Reads whatever is in flickemon-playlist.js.
     *
     * A student is editing that file by hand, so every entry is treated as
     * possibly malformed: a bad line is skipped and reported, never thrown.
     */
    loadTracks() {
        const raw = Array.isArray(window.FlickemonPlaylist) ? window.FlickemonPlaylist : [];
        this.badEntries = [];

        this.tracks = raw.map((entry, i) => {
            const { url, name } = FlickemonMusic.readEntry(entry);
            const parsed = FlickemonMusic.parseYouTubeUrl(url);
            if (!parsed) {
                const shown = url || (entry && typeof entry === 'object'
                    ? JSON.stringify(entry) : String(entry ?? ''));
                if (shown) this.badEntries.push(shown.slice(0, 60));
                return null;
            }
            return {
                ...parsed,
                title: name || (parsed.listId && !parsed.videoId
                    ? `Playlist ${i + 1}`
                    : `Track ${i + 1}`),
            };
        }).filter(Boolean);
    }

    /**
     * Reads one playlist line into { url, name }.
     *
     * The documented shape is { name, url }, but this is a file people edit by
     * hand at midnight. A bare URL works, `title` works as well as `name`, and
     * so does a plain [name, url] pair — being forgiving here costs nothing and
     * saves someone puzzling over why their song vanished.
     */
    static readEntry(entry) {
        if (typeof entry === 'string') return { url: entry, name: '' };

        if (Array.isArray(entry)) {
            // Either order: whichever half looks like a link is the link.
            const [a, b] = entry.map(v => (typeof v === 'string' ? v.trim() : ''));
            return FlickemonMusic.parseYouTubeUrl(a)
                ? { url: a, name: b }
                : { url: b, name: a };
        }

        if (entry && typeof entry === 'object') {
            const name = entry.name || entry.title || entry.label || '';
            return { url: entry.url || entry.link || entry.href || '', name: String(name).trim() };
        }
        return { url: '', name: '' };
    }

    /**
     * Pulls the video and/or playlist id out of any YouTube URL shape.
     * Returns null for anything that is not YouTube — including, deliberately,
     * a direct link to an audio file, which is the thing this design avoids.
     */
    static parseYouTubeUrl(input) {
        if (!input || typeof input !== 'string') return null;
        const raw = input.trim();
        if (!raw) return null;

        // A bare id has to be recognised BEFORE the URL parser sees it: adding
        // a scheme to "jfKfPfyJRdk" produces a perfectly valid URL whose
        // hostname is "jfkfpfyjrdk", so it would never reach a catch branch.
        // No real hostname matches this — a dot is not a word character.
        if (/^[\w-]{11}$/.test(raw)) return { videoId: raw, listId: null };

        let url;
        try {
            url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
        } catch {
            return null;
        }

        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        const isYouTube = host === 'youtube.com' || host === 'm.youtube.com'
            || host === 'youtube-nocookie.com' || host === 'youtu.be';
        if (!isYouTube) return null;

        const listId = url.searchParams.get('list');
        let videoId = url.searchParams.get('v');

        if (!videoId && host === 'youtu.be') {
            videoId = url.pathname.slice(1).split('/')[0];
        }
        if (!videoId && /^\/(embed|shorts|live|v)\//.test(url.pathname)) {
            videoId = url.pathname.split('/')[2];
        }

        if (videoId && !/^[\w-]{11}$/.test(videoId)) videoId = null;
        if (!videoId && !listId) return null;
        return { videoId: videoId || null, listId: listId || null };
    }

    // ─────────────────────── The player ───────────────────────

    /**
     * Creates the docked panel once, outside anything the site rebuilds.
     *
     * It is genuinely visible, and that is not cosmetic. Chrome refuses to
     * autoplay an iframe that is effectively invisible, and YouTube's player
     * will not start in a zero-size frame — the first version of this hid the
     * frame at 1x1 with opacity:0 and simply never played. The frame is also
     * never re-parented once mounted: moving an iframe in the DOM reloads it,
     * which would restart the track.
     */
    ensureHost() {
        if (this.host && document.body.contains(this.host)) return this.host;

        const host = document.createElement('div');
        host.id = MUSIC_HOST_ID;
        host.className = 'flickemon-music-host';
        host.innerHTML = `
            <div class="music-dock-bar">
                <span class="music-dock-title">Music</span>
                <button class="music-dock-btn music-dock-collapse" title="Shrink">–</button>
                <button class="music-dock-btn music-dock-close" title="Stop the music">✕</button>
            </div>
            <div class="music-dock-frame"></div>`;
        document.body.appendChild(host);

        host.querySelector('.music-dock-close').addEventListener('click', () => this.stop());
        host.querySelector('.music-dock-collapse').addEventListener('click', () => {
            // Collapsing shrinks the video away but keeps the frame on screen
            // and non-zero, because a hidden frame stops playing.
            host.classList.toggle('collapsed');
            const btn = host.querySelector('.music-dock-collapse');
            const small = host.classList.contains('collapsed');
            btn.textContent = small ? '+' : '–';
            btn.title = small ? 'Expand' : 'Shrink';
        });

        this.host = host;
        return host;
    }

    /**
     * Loads a track. `autoplay` only ever comes from a click, because YouTube
     * will not start unmuted audio without one — and `allow="autoplay"` is what
     * passes that gesture through to the frame.
     */
    load(index, autoplay) {
        const track = this.tracks[index];
        if (!track) return;

        this.index = index;
        this.ready = false;
        this.blocked = false;
        const host = this.ensureHost();

        const params = new URLSearchParams({
            enablejsapi: '1',
            origin: location.origin,
            autoplay: autoplay ? '1' : '0',
            rel: '0',
            playsinline: '1',
            modestbranding: '1',
        });
        if (track.listId) {
            params.set('list', track.listId);
            if (!track.videoId) params.set('listType', 'playlist');
        }

        const path = track.videoId
            ? `/embed/${track.videoId}`
            : `/embed/videoseries`;

        const slot = host.querySelector('.music-dock-frame');
        slot.innerHTML = `<iframe
            class="flickemon-music-frame"
            src="${MUSIC_ORIGIN}${path}?${params.toString()}"
            title="Flickémon music player"
            allow="autoplay; encrypted-media"
            referrerpolicy="strict-origin-when-cross-origin"
            frameborder="0"></iframe>`;

        const label = host.querySelector('.music-dock-title');
        if (label) label.textContent = track.title;

        this.frame = slot.querySelector('.flickemon-music-frame');
        this.playing = Boolean(autoplay);
        this.emit();

        // The host page's CSP can refuse the frame outright. Nothing throws
        // when that happens, so the only signal is that the player never
        // reports readiness — say so rather than looking silently broken.
        clearTimeout(this.blockTimer);
        this.blockTimer = setTimeout(() => {
            if (!this.ready) {
                this.blocked = true;
                this.playing = false;
                this.emit();
            }
        }, 6000);
    }

    /**
     * Speaks the IFrame API's postMessage protocol directly. Sending before
     * the frame is ready is harmless — it is dropped, and the `autoplay`
     * parameter covers the only case that matters.
     */
    command(func, args = []) {
        if (!this.frame || !this.frame.contentWindow) return;
        this.frame.contentWindow.postMessage(
            JSON.stringify({ event: 'command', func, args }), MUSIC_ORIGIN);
    }

    /** Subscribes to the frame's state so our controls reflect reality. */
    bindPlayerMessages() {
        window.addEventListener('message', (e) => {
            if (e.origin !== MUSIC_ORIGIN || !this.frame || e.source !== this.frame.contentWindow) return;

            let data;
            try {
                data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            } catch {
                return;
            }
            if (!data) return;

            if (data.event === 'onReady' || data.event === 'initialDelivery') {
                this.ready = true;
                this.blocked = false;
                clearTimeout(this.blockTimer);
                this.command('setVolume', [this.volume]);
                this.emit();
            }

            const state = data.info && typeof data.info.playerState === 'number'
                ? data.info.playerState
                : (typeof data.info === 'number' ? data.info : null);

            if (state !== null) {
                if (state === YT_STATE.ENDED) {
                    this.next();
                } else if (state === YT_STATE.PLAYING || state === YT_STATE.PAUSED) {
                    this.playing = state === YT_STATE.PLAYING;
                    this.emit();
                }
            }
        });
    }

    // ─────────────────────── Controls ───────────────────────

    play(index = this.index) {
        if (!this.tracks.length) return;
        if (index !== this.index || !this.frame) {
            this.load(index, true);
            return;
        }
        this.command('playVideo');
        this.playing = true;
        this.emit();
    }

    pause() {
        this.command('pauseVideo');
        this.playing = false;
        this.emit();
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    next() { if (this.tracks.length) this.load((this.index + 1) % this.tracks.length, true); }

    previous() {
        if (!this.tracks.length) return;
        this.load((this.index - 1 + this.tracks.length) % this.tracks.length, true);
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(100, Math.round(v)));
        this.command('setVolume', [this.volume]);
        this.saveSettings();
        this.emit();
    }

    /** Tears the player down entirely, freeing the frame. */
    stop() {
        clearTimeout(this.blockTimer);
        this.command('pauseVideo');
        if (this.host) {
            this.host.remove();
            this.host = null;
        }
        this.frame = null;
        this.ready = false;
        this.playing = false;
        this.emit();
    }

    /**
     * Opens the player as its own pinned tab.
     *
     * The last-resort answer: an extension page is not subject to anything the
     * lecture site does, and a click inside that tab is a real user gesture, so
     * playback cannot be refused for want of one. The cost is a visible tab.
     */
    openInTab() {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
        this.stop();
        chrome.runtime.sendMessage({ type: 'MUSIC_OPEN_TAB' }, () => {
            // A closed port here just means the worker was asleep; the tab
            // still opens. Reading lastError keeps it from being logged.
            void chrome.runtime.lastError;
        });
    }

    // ─────────────────────── The lecture wins ───────────────────────

    /**
     * A lecture starting silences the music at once — that is the whole point
     * of having it. Deliberately no auto-resume: pausing a lecture is usually
     * someone stopping to think, and music restarting into that is worse than
     * pressing play again.
     */
    bindLectureVideo(video) {
        if (!video || video.dataset.flickemonMusicHooked) return;
        video.dataset.flickemonMusicHooked = 'true';
        video.addEventListener('play', () => {
            if (this.playing) this.pause();
            // The standalone tab is a different page with its own player, and
            // only the worker can reach it.
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: 'MUSIC_LECTURE_STARTED' },
                    () => void chrome.runtime.lastError);
            }
        });
    }

    // ─────────────────────── State ───────────────────────

    onChange(cb) {
        this.listeners.push(cb);
        return () => { this.listeners = this.listeners.filter(l => l !== cb); };
    }

    emit() {
        const snapshot = this.getState();
        this.listeners.forEach(cb => cb(snapshot));
    }

    getState() {
        return {
            playing: this.playing,
            ready: this.ready,
            blocked: this.blocked,
            index: this.index,
            volume: this.volume,
            track: this.tracks[this.index] || null,
            count: this.tracks.length,
            badEntries: this.badEntries || [],
        };
    }

    saveSettings() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        // Volume only. Which track was playing is not worth restoring — a page
        // reload is a fresh start, and autoplaying into someone's ears on load
        // would be hostile.
        const write = chrome.storage.local.set({ [MUSIC_STATE_KEY]: { volume: this.volume } });
        if (write && write.catch) write.catch(() => {});
    }

    async restoreSettings() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        try {
            const data = await chrome.storage.local.get([MUSIC_STATE_KEY]);
            const saved = data && data[MUSIC_STATE_KEY];
            if (saved && Number.isFinite(saved.volume)) {
                this.volume = Math.max(0, Math.min(100, saved.volume));
                this.emit();
            }
        } catch { /* defaults are fine */ }
    }
}

window.FlickemonMusic = FlickemonMusic;
