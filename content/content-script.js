/**
 * Content Script Entry Point (Chrome Extension)
 * ──────────────────────────────────────────────
 * Boots game engine, injects Flickémon widget into Flick course page DOM, and hooks video playback.
 * Automatically respects main website Pomodoro breaks if present.
 */

(function () {
    'use strict';

    console.log('[Flickémon Extension] Loading content script...');

    async function initExtension() {
        // Initialize core game engine
        if (window.flickemonEngine) await window.flickemonEngine.init();

        // Shared-computer handover watch. Library machines are the reason: a
        // student who signs in to Flick after the previous one walked away must
        // not inherit their still-authenticated Flickémon session.
        if (window.flickemonEngine
            && typeof window.flickemonEngine.startFlickAccountGuard === 'function') {
            window.flickemonEngine.startFlickAccountGuard();
        }

        // Apply Pokémon theme to document as early as possible if enabled
        if (window.flickemonEngine && typeof window.flickemonEngine.getPokemonTheme === 'function') {
            window.flickemonEngine.getPokemonTheme().then(on => {
                if (on) {
                    if (document.documentElement) document.documentElement.classList.add('pokemon-theme');
                    if (document.body) {
                        document.body.classList.add('pokemon-theme');
                    } else {
                        document.addEventListener('DOMContentLoaded', () => {
                            if (document.body) document.body.classList.add('pokemon-theme');
                        });
                    }
                }
            }).catch(() => {});
        }

        // Create extension container root
        const rootContainer = document.createElement('div');
        rootContainer.className = 'flickemon-ext-root';

        // Instantiate Flickémon UI
        const flickemonUI = new window.FlickemonUI(window.flickemonEngine);

        // Inject widget into DOM
        function injectUI() {
            // The widget only makes sense where there is a lecture to watch, and
            // study time is measured from a <video> element. Its presence is the
            // signal — matching on URL shape would need updating whenever the
            // site's routes change, and course/list pages share a path prefix.
            const hasPlayer = !!document.querySelector('video');

            if (!hasPlayer) {
                const existingWrapper = document.querySelector('.flickemon-widgets-wrapper');
                if (existingWrapper) existingWrapper.remove();
                return;
            }

            const containerTarget = document.querySelector('ion-col[size="12"]') || document.querySelector('.scroll-area') || document.body;
            let existingWrapper = document.querySelector('.flickemon-widgets-wrapper');
            
            if (existingWrapper) {
                if (existingWrapper.parentElement !== containerTarget) {
                    containerTarget.appendChild(existingWrapper);
                }
            } else if (containerTarget) {
                const widgetWrapper = document.createElement('div');
                widgetWrapper.className = 'flickemon-widgets-wrapper';
                widgetWrapper.appendChild(flickemonUI.renderWidget());
                containerTarget.appendChild(widgetWrapper);
                if (flickemonUI && flickemonUI.pendingFlickCredit) {
                    const pending = flickemonUI.pendingFlickCredit;
                    flickemonUI.pendingFlickCredit = null;
                    flickemonUI.showFlickCredit(pending);
                }
            }
        }

        injectUI();

        // The player mutates its DOM constantly during playback (progress bar,
        // captions, buffering indicators), and injectUI queries the document on
        // every call. Running it per mutation put a steady query load on the
        // main thread for the entire lecture. Coalesce instead: bursts collapse
        // into one check, and the page still settles within a frame or two.
        let injectQueued = false;
        const observer = new MutationObserver(() => {
            if (injectQueued) return;
            injectQueued = true;
            requestAnimationFrame(() => {
                injectQueued = false;
                injectUI();
                harvestFlickProgress();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // ── Studying somewhere this extension is not ────────────────────────
        //
        // Flick records progress from every device the student uses and renders
        // it on the course page, refreshed by its own 60-second poll and pushed
        // live over a websocket. So a phone session is already on this screen;
        // it just has to be read. See content/flickemon-flick-progress.js.
        //
        // Rides the coalesced tick above rather than a timer of its own, so the
        // page is only re-read when it has actually changed -- but deliberately
        // NOT inside injectUI: that returns early when there is no <video>, and
        // the case that matters most is opening a course after a phone session,
        // before pressing play on anything.
        let lastHarvestAt = 0;
        let harvesting = false;
        function harvestFlickProgress(opts = {}) {
            const force = Boolean(opts && opts.force);
            const isLogin = Boolean(opts && opts.isLogin);
            const engine = window.flickemonEngine;
            if (!engine || !window.FlickProgress || harvesting) return;

            const wait = (engine.config && engine.config.FLICK_HARVEST_INTERVAL_MS) || 60000;
            const now = Date.now();
            if (!force && now - lastHarvestAt < wait) return;

            const reading = window.FlickProgress.readCourse(document);
            // Null means "not a course page", which must not look like "a course
            // where nothing has been watched" -- navigating away would otherwise
            // read as progress being lost.
            if (!reading) return;

            lastHarvestAt = now;
            harvesting = true;
            Promise.resolve(engine.creditFlickProgress(reading))
                .then(result => {
                    if (result && isLogin) {
                        result.isLogin = true;
                    }
                    // The cap is surfaced too: credit that stops without a
                    // word reads as a bug rather than a rule.
                    const worthSaying = result
                        && (result.credited > 0 || result.reason === 'daily-cap');
                    if (worthSaying && flickemonUI.showFlickCredit) {
                        flickemonUI.showFlickCredit(result);
                    }
                })
                // A parser fault must never take the rest of the widget with it.
                .catch(err => console.warn('[Flickémon] Flick progress read failed:', err))
                .finally(() => { harvesting = false; });
        }
        window.flickemonHarvestProgress = harvestFlickProgress;
        harvestFlickProgress();

        /** Check if main website's Pomodoro timer is currently on a break */
        function isMainWebsitePomodoroOnBreak() {
            // Check DOM for main site Pomodoro widget break status
            const pomoBadge = document.querySelector('app-pomodoro-timer .phase-badge') || document.querySelector('.pomodoro-card .phase-badge');
            if (pomoBadge && pomoBadge.textContent && pomoBadge.textContent.toLowerCase().includes('break')) {
                return true;
            }
            // Check global variable if emitted by main app
            if (window.isPomodoroBreak === true) {
                return true;
            }
            return false;
        }

        // ── Study time ────────────────────────────────────────────────────
        //
        // Progress is measured in real seconds spent watching, not in seconds of
        // video crossed. Those are the same thing at 1x and nothing like it
        // anywhere else: reading video.currentTime paid 2x speed double and 10x
        // speed tenfold, so the fastest way to level up was to stop listening.
        // Wall-clock time also makes seeking worthless by construction — dragging
        // the scrubber moves currentTime but no time passes — instead of relying
        // on a delta threshold to guess which jumps were scrubs.
        //
        // The clamp covers gaps this loop can't account for: a backgrounded tab
        // gets its timers throttled, and a laptop closed mid-lecture may not fire
        // anything for hours. Neither is time spent watching.
        const MAX_TICK_SECONDS = 2;
        let lastTickAt = null;

        function stopCounting() { lastTickAt = null; }

        function countWatchedTime(video) {
            const watching = !video.paused && !video.seeking && !video.ended
                             && video.readyState >= 2;
            if (!watching) return stopCounting();

            const now = Date.now();
            if (lastTickAt === null) {      // first tick since play resumed
                lastTickAt = now;
                return;
            }

            const seconds = Math.min((now - lastTickAt) / 1000, MAX_TICK_SECONDS);
            lastTickAt = now;
            if (seconds <= 0) return;

            // If main website's Pomodoro timer is on break, pause battle damage!
            if (isMainWebsitePomodoroOnBreak()) return;
            if (window.flickemonEngine) window.flickemonEngine.onVideoProgress(seconds);
        }

        // ── What this device's own player did to Flick's record ────────────
        //
        // Watching here moves Flick's record exactly as a phone does, so the
        // harvest above sees the same progress again and cannot tell whose it
        // was. The player therefore reports the stretch of the lecture it
        // covered, and that stretch is never paid for. See recordPlayedHere.
        //
        // Measured from where the player RESUMED. video.js holds a seek made
        // while a source is loading until canplay, which is where FlickPlayer's
        // jump to the saved position lands -- so canplay is the first moment the
        // position means "where this device picked the lecture up". Anything
        // below it was studied somewhere else, and must still be paid.
        function trackPlayedHere(video) {
            const engine = window.flickemonEngine;
            const FP = window.FlickProgress;
            if (!engine || !FP || typeof engine.recordPlayedHere !== 'function') return;

            let span = null;

            const begin = () => {
                const at = video.currentTime;
                if (!Number.isFinite(at) || at < 0) return;
                span = { from: at, to: at, sentTo: -1, lecture: null, course: '', lookedAt: 0 };
                // Hooked late, after part of this source had already played.
                const played = video.played;
                if (played && played.length) {
                    span.from = Math.min(span.from, played.start(0));
                    span.to = Math.max(span.to, played.end(played.length - 1));
                }
            };

            const report = (force) => {
                if (!span) return;
                const at = video.currentTime;
                if (Number.isFinite(at) && at > span.to) span.to = at;
                if (!force && span.to - span.sentTo < 1) return;

                // Named once per source and then remembered: a search typed
                // while it plays can filter the highlighted row off the page.
                if (!span.lecture && Date.now() - span.lookedAt >= 1000) {
                    span.lookedAt = Date.now();
                    span.lecture = FP.activeLecture(document);
                    span.course = FP.parseCourseName(document);
                }
                span.sentTo = span.to;
                Promise.resolve(engine.recordPlayedHere({
                    course: span.course, lecture: span.lecture, from: span.from, to: span.to,
                })).catch(err => console.warn('[Flickémon] Could not record playback:', err));
            };

            // A new source is a new lecture, or the same one opened again.
            video.addEventListener('loadstart', () => { span = null; });
            video.addEventListener('emptied', () => { span = null; });
            video.addEventListener('canplay', () => { if (!span) { begin(); report(true); } });
            video.addEventListener('timeupdate', () => report(false));
            // The moments FlickPlayer itself posts, so the stretch is never
            // behind what Flick has recorded.
            for (const evt of ['seeked', 'pause', 'ended']) {
                video.addEventListener(evt, () => report(true));
            }
            if (video.readyState >= 3) { begin(); report(true); }
        }

        function hookVideoPlayer() {
            const video = document.querySelector('video');
            if (!video || video.dataset.flickemonHooked) return;
            video.dataset.flickemonHooked = 'true';

            trackPlayedHere(video);

            // timeupdate fires on a wall-clock cadence (~4Hz in Chrome) rather
            // than per frame of media, so it stays a good heartbeat at any rate.
            video.addEventListener('timeupdate', () => countWatchedTime(video));

            // Anything that interrupts playback also breaks the accounting: the
            // next tick must start a fresh interval rather than bill the pause.
            for (const evt of ['pause', 'seeking', 'ended', 'waiting', 'stalled']) {
                video.addEventListener(evt, stopCounting);
            }

            // A lecture always wins over the music. Bound here rather than in
            // the player because this is the one place that knows when a <video>
            // appears — the site's router creates them long after load.
            if (flickemonUI.music) flickemonUI.music.bindLectureVideo(video);
        }

        // Cheap by design: one querySelector, and the dataset flag makes every
        // call after the first a no-op. The player is created asynchronously by
        // the site's router, so polling is the only reliable hook point.
        setInterval(() => {
            hookVideoPlayer();
            // Music can be started after the video was already hooked; the
            // dataset flag inside bindLectureVideo keeps this idempotent.
            const video = document.querySelector('video');
            if (video && flickemonUI.music) flickemonUI.music.bindLectureVideo(video);
        }, 1000);
        console.log('[Flickémon Extension] Fully initialized and hooked to page.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initExtension);
    } else {
        initExtension();
    }
})();
