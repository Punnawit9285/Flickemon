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
        function harvestFlickProgress() {
            const engine = window.flickemonEngine;
            if (!engine || !window.FlickProgress || harvesting) return;

            const wait = (engine.config && engine.config.FLICK_HARVEST_INTERVAL_MS) || 60000;
            const now = Date.now();
            if (now - lastHarvestAt < wait) return;

            const reading = window.FlickProgress.readCourse(document);
            // Null means "not a course page", which must not look like "a course
            // where nothing has been watched" -- navigating away would otherwise
            // read as progress being lost.
            if (!reading) return;

            lastHarvestAt = now;
            harvesting = true;
            Promise.resolve(engine.creditFlickProgress(reading))
                .then(result => {
                    if (result && result.credited > 0 && flickemonUI.showFlickCredit) {
                        flickemonUI.showFlickCredit(result);
                    }
                })
                // A parser fault must never take the rest of the widget with it.
                .catch(err => console.warn('[Flickémon] Flick progress read failed:', err))
                .finally(() => { harvesting = false; });
        }
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

        function hookVideoPlayer() {
            const video = document.querySelector('video');
            if (!video || video.dataset.flickemonHooked) return;
            video.dataset.flickemonHooked = 'true';

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
