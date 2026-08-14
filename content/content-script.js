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
            const isHome = window.location.pathname === '/home' || window.location.pathname === '/' || window.location.pathname === '/home/';
            
            // Do not inject Flickémon widget on the home page
            if (isHome) {
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
        const observer = new MutationObserver(() => injectUI());
        observer.observe(document.body, { childList: true, subtree: true });

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

        // Hook Video progress
        let lastVideoTime = 0;
        function hookVideoPlayer() {
            const video = document.querySelector('video');
            if (!video || video.dataset.flickemonHooked) return;
            video.dataset.flickemonHooked = 'true';

            video.addEventListener('timeupdate', () => {
                if (video.paused || video.seeking) {
                    lastVideoTime = video.currentTime;
                    return;
                }

                const delta = video.currentTime - lastVideoTime;
                if (delta > 0 && delta < 10) {
                    // If main website's Pomodoro timer is on break, pause battle damage!
                    const isOnBreak = isMainWebsitePomodoroOnBreak();

                    if (!isOnBreak && window.flickemonEngine) {
                        window.flickemonEngine.onVideoProgress(delta);
                    }
                }
                lastVideoTime = video.currentTime;
            });
        }

        setInterval(hookVideoPlayer, 1000);
        console.log('[Flickémon Extension] Fully initialized and hooked to page.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initExtension);
    } else {
        initExtension();
    }
})();
