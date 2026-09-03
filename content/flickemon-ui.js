/**
 * Flickemon UI Components (Chrome Extension)
 * ───────────────────────────────────────────
 * Port of flickemon-widget.component.ts, flickemon-modal.component.ts,
 * flickemon-starter.component.ts, and flickemon-settings-modal.component.ts.
 */

// The staged sequence runs 4.75s; the remainder holds the new form on screen
// long enough to read. The animation delays in styles.css are keyed to this.
const EVOLUTION_OVERLAY_MS = 6000;

// Sparks thrown by the burst. Twelve reads as a full ring without the DOM
// churn of a real particle system.
const EVOLUTION_SPARK_COUNT = 12;

// Mega evolution runs longer than an ordinary one and is meant to: it is a
// once-per-Pokémon event rather than something that happens every few levels,
// and the extra time buys the stone its own entrance before the transformation
// begins. Keyed to the delays in styles.css, same as EVOLUTION_OVERLAY_MS.
const MEGA_OVERLAY_MS = 8500;

// More shards than the evolution's sparks, thrown in two rings — this is the
// stone breaking apart, not a glow.
const MEGA_SHARD_COUNT = 20;

// Starter base stats span 31-90, so bars are drawn against a fixed 100 rather
// than the trio's own maximum: that keeps a Gen 1 bar comparable to a Gen 9 one.
const STARTER_STAT_SCALE = 100;

// Tabs for the starter chooser. Gen 0 is the odd one out: Pikachu and Eevee are
// Kanto species but were never part of the starter trio, so they get their own
// tab instead of crowding Bulbasaur's.
const STARTER_REGIONS = [
    { gen: 1, region: 'Kanto',   games: 'Red & Blue' },
    { gen: 2, region: 'Johto',   games: 'Gold & Silver' },
    { gen: 3, region: 'Hoenn',   games: 'Ruby & Sapphire' },
    { gen: 4, region: 'Sinnoh',  games: 'Diamond & Pearl' },
    { gen: 5, region: 'Unova',   games: 'Black & White' },
    { gen: 6, region: 'Kalos',   games: 'X & Y' },
    { gen: 7, region: 'Alola',   games: 'Sun & Moon' },
    { gen: 8, region: 'Galar',   games: 'Sword & Shield' },
    { gen: 9, region: 'Paldea',  games: 'Scarlet & Violet' },
    { gen: 0, region: 'Special', games: "Yellow & Let's Go" },
];

// Kanto species offered on the Special tab rather than with the Kanto trio.
const SPECIAL_STARTER_IDS = [25, 133];

class FlickemonUI {
    constructor(engine) {
        this.engine = engine;
        this.config = window.FlickemonConfig;

        this.widgetCard = null;
        this.activeModal = null;
        this.popoverOpen = false;

        // Evolutions that happened while the video was fullscreen, waiting to be
        // replayed on exit. See showEvolutionOverlay.
        this.pendingEvolutions = [];
        this.evolutionPlaying = false;
        this.currentEvolution = null;
        this.currentOverlayEl = null;
        this.watchFullscreen();

        document.addEventListener('click', () => {
            this.popoverOpen = false;
            if (this.widgetCard) {
                const popover = this.widgetCard.querySelector('.options-popover-menu');
                if (popover) popover.style.display = 'none';
            }
        });
    }

    renderWidget() {
        // Navigating course -> list -> course removes and re-injects the widget,
        // and every call registers engine listeners. Without dropping the old
        // ones they accumulate, so a single evolution would queue one overlay
        // per past injection and the detached cards would still be updated.
        (this.engineSubscriptions || []).forEach(unsubscribe => unsubscribe());

        const card = document.createElement('div');
        card.className = 'flickemon-card flickemon-widget-card';

        this.engineSubscriptions = [
            this.engine.onStateChange((state) => {
                this.updateWidgetView(card, state, this.engine.wildOpponent);
            }),
            this.engine.onWildChange((wild) => {
                this.updateWidgetView(card, this.engine.getGameState(), wild);
            }),
            this.engine.onEvolution((evo) => {
                this.showEvolutionOverlay(evo);
            }),
        ];

        // The widget redraws on engine events and video progress, neither of
        // which fires while a lecture is paused — so the boost clock would sit
        // frozen at whatever second it was drawn at, on the one screen where a
        // student is watching it run down. A 1s tick patches the countdown in
        // place; a full re-render each second would close the options popover
        // mid-click and restart the damage flash.
        clearInterval(this.rewardTicker);
        this.rewardTicker = setInterval(() => this.tickRewardBanner(card), 1000);

        this.widgetCard = card;
        return card;
    }

    /** Share of the boost still to run, for the draining bar. */
    rewardPercentLeft(reward) {
        if (!reward || !Number.isFinite(reward.durationMs) || reward.durationMs <= 0) return 100;
        return Math.max(0, Math.min(100, (reward.msLeft / reward.durationMs) * 100));
    }

    paintRewardBanner(banner, reward) {
        const left = banner.querySelector('.reward-left');
        if (left) left.textContent = this.config.formatCountdown(reward.msLeft);
        const fill = banner.querySelector('.reward-drain-fill');
        if (fill) fill.style.width = `${this.rewardPercentLeft(reward)}%`;
    }

    /**
     * One second of the boost timer.
     *
     * Appearing and disappearing is left to the normal render path: the reward
     * type is part of the widget signature, so asking for a full update is what
     * adds the banner on a win and removes it on expiry.
     */
    tickRewardBanner(card) {
        if (!card.isConnected) {
            clearInterval(this.rewardTicker);
            this.rewardTicker = null;
            return;
        }
        const banner = card.querySelector('.reward-banner');
        const reward = this.engine.getActiveReward ? this.engine.getActiveReward() : null;

        if (!!reward !== !!banner) {
            this.updateWidgetView(card, this.engine.getGameState(), this.engine.wildOpponent);
            return;
        }
        if (reward) this.paintRewardBanner(banner, reward);
    }

    updateWidgetView(card, state, wild) {
        const gameControllerSvg = `<svg class="header-icon-svg" viewBox="0 0 512 512" width="22" height="22" fill="currentColor"><path d="M483.13 245.38C461.92 149.49 430 98.31 382.65 84.33A107.1 107.1 0 0 0 352 80c-13.71 0-25.65 3.34-38.28 6.88C298.5 91.15 281.21 96 256 96s-42.51-4.84-57.76-9.11C185.6 83.34 173.67 80 160 80a115.7 115.7 0 0 0-31.73 4.32c-47.1 13.92-79 65.08-100.52 161C4.61 348.54 16 413.71 59.69 428.83a56.6 56.6 0 0 0 18.64 3.22c29.93 0 53.93-24.93 70.33-45.34 18.53-23.1 40.22-34.82 107.34-34.82 59.95 0 84.76 8.13 106.19 34.82 13.47 16.78 26.2 28.52 38.9 35.91 16.89 9.82 33.77 12 50.16 6.37 25.82-8.81 40.62-32.1 44-69.24 2.57-28.48-1.39-65.89-12.12-114.37M208 240h-32v32a16 16 0 0 1-32 0v-32h-32a16 16 0 0 1 0-32h32v-32a16 16 0 0 1 32 0v32h32a16 16 0 0 1 0 32m84 4a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-19.95A20 20 0 0 1 336 288m0-88a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-20 20 20 0 0 1-20 20"/></svg>`;
        const ellipsisSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor"><circle cx="256" cy="96" r="48"/><circle cx="256" cy="256" r="48"/><circle cx="256" cy="416" r="48"/></svg>`;
        const chevronDownSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48"><path d="M112 184l144 144 144-144"/></svg>`;
        const chevronUpSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48"><path d="M112 328l144-144 144 144"/></svg>`;
        const menuGameControllerSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor"><path d="M483.13 245.38C461.92 149.49 430 98.31 382.65 84.33A107.1 107.1 0 0 0 352 80c-13.71 0-25.65 3.34-38.28 6.88C298.5 91.15 281.21 96 256 96s-42.51-4.84-57.76-9.11C185.6 83.34 173.67 80 160 80a115.7 115.7 0 0 0-31.73 4.32c-47.1 13.92-79 65.08-100.52 161C4.61 348.54 16 413.71 59.69 428.83a56.6 56.6 0 0 0 18.64 3.22c29.93 0 53.93-24.93 70.33-45.34 18.53-23.1 40.22-34.82 107.34-34.82 59.95 0 84.76 8.13 106.19 34.82 13.47 16.78 26.2 28.52 38.9 35.91 16.89 9.82 33.77 12 50.16 6.37 25.82-8.81 40.62-32.1 44-69.24 2.57-28.48-1.39-65.89-12.12-114.37M208 240h-32v32a16 16 0 0 1-32 0v-32h-32a16 16 0 0 1 0-32h32v-32a16 16 0 0 1 32 0v32h32a16 16 0 0 1 0 32m84 4a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-19.95A20 20 0 0 1 336 288m0-88a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-20 20 20 0 0 1-20 20"/></svg>`;
        const pokeballSvg = `<svg viewBox="0 0 512 512" width="13" height="13" fill="none" stroke="currentColor" stroke-width="42" aria-hidden="true"><circle cx="256" cy="256" r="204"/><path d="M52 256h132M328 256h132" stroke-linecap="round"/><circle cx="256" cy="256" r="62"/></svg>`;
        const boltSvg = `<svg viewBox="0 0 512 512" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M394.23 197.56a20 20 0 0 0-17.15-9.56H272V32a20 20 0 0 0-36.65-11.09l-160 240A20 20 0 0 0 92 292h105v156a20 20 0 0 0 36.65 11.09l160-240a20 20 0 0 0 .58-21.53z"/></svg>`;
        const tradeSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M368 112l64 64-64 64M416 176H208M144 400l-64-64 64-64M96 336h208"/></svg>`;
        // Two figures, because this is the one header button that is about
        // people rather than about Pokémon.
        const friendsSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="196" cy="152" r="60"/><path d="M100 400c0-53 43-96 96-96s96 43 96 96"/><circle cx="356" cy="176" r="48"/><path d="M300 400h112c0-45 -30-80 -70-88"/></svg>`;
        const shopSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M96 176h320l-28 240a32 32 0 0 1-32 28H156a32 32 0 0 1-32-28z"/><path d="M176 176v-32a80 80 0 0 1 160 0v32"/></svg>`;
        const swordsSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M424 64l-56 0-208 208 56 56L424 120zM88 64l56 0 208 208-56 56L88 120z"/><path d="M136 400l40 40M376 400l-40 40"/></svg>`;
        // Solid, like the other four. An outlined glyph sitting among filled
        // ones reads as a different weight, not a different icon.
        const bookSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M240 96c-40-32-110-40-176-32-8 1-16 8-16 18v318c0 10 8 18 18 17 62-7 130 1 166 31 4 3 8 1 8-4z"/><path d="M272 96c40-32 110-40 176-32 8 1 16 8 16 18v318c0 10-8 18-18 17-62-7-130 1-166 31-4 3-8 1-8-4z"/></svg>`;
        const noteSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M421.84 37.37a25.86 25.86 0 0 0-22.6-4.63L199 86.86a32.09 32.09 0 0 0-23.6 30.94v210.79A94 94 0 0 0 144 320c-35.3 0-64 21.5-64 48s28.7 48 64 48 64-21.5 64-48V199.62l192-51.2v134.39A94 94 0 0 0 368 272c-35.3 0-64 21.5-64 48s28.7 48 64 48 64-21.5 64-48V58a25.85 25.85 0 0 0-10.16-20.63"/></svg>`;
        const heartSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M352.92 80C288 80 256 144 256 144s-32-64-96.92-64c-52.76 0-94.54 44.14-95.08 96.81-1.1 109.33 86.73 187.08 183 252.42a16 16 0 0 0 18 0c96.26-65.34 184.09-143.09 183-252.42-.54-52.67-42.32-96.81-95.08-96.81z"/></svg>`;
        const gearSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor"><path d="M262.29 192.31a64 64 0 1 0 57.4 57.4 64.13 64.13 0 0 0-57.4-57.4zM416.39 256a154.34 154.34 0 0 1-1.53 20.79l45.84 35.76a16.74 16.74 0 0 1 4.33 19.69l-43.7 75.71a16.63 16.63 0 0 1-19.81 7.51l-54-21.78a156.76 156.76 0 0 1-35.93 20.73l-8.34 57.53A16.69 16.69 0 0 1 286.61 480h-87.2a16.69 16.69 0 0 1-16.59-14.36l-8.26-57.34a156 156 0 0 1-35.82-20.7l-54.05 21.77a16.73 16.73 0 0 1-19.77-7.49l-43.7-75.59a16.71 16.71 0 0 1 4.22-19.73l45.89-35.79a154.94 154.94 0 0 1-1.54-20.76c0-6.93.53-13.77 1.54-20.79l-45.89-35.76a16.74 16.74 0 0 1-4.22-19.73l43.7-75.71a16.7 16.7 0 0 1 19.7-7.51l54.06 21.79A155.65 155.65 0 0 1 174.5 125l8.26-57.46A16.69 16.69 0 0 1 199.41 32h87.2a16.69 16.69 0 0 1 16.59 14.36l8.34 57.53a156.47 156.47 0 0 1 35.93 20.73l54-21.78a16.65 16.65 0 0 1 19.81 7.51l43.7 75.71a16.72 16.72 0 0 1-4.33 19.69l-45.84 35.75a155.51 155.51 0 0 1 1.53 20.8zM256 160a96 96 0 1 0 96 96 96.11 96.11 0 0 0-96-96z"/></svg>`;

        if (wild && wild.wildSpecies) {
            const isSameSpecies = this.lastWildSpeciesId === wild.wildSpecies.id;
            if (isSameSpecies && this.lastWildHp !== undefined && wild.currentHp < this.lastWildHp && wild.status === 'fighting') {
                this.isFlashingDamage = true;
                if (this.damageFlashTimer) clearTimeout(this.damageFlashTimer);
                this.damageFlashTimer = setTimeout(() => {
                    this.isFlashingDamage = false;
                }, 400);
            }
            this.lastWildHp = wild.currentHp;
            this.lastWildSpeciesId = wild.wildSpecies.id;
        } else {
            this.lastWildHp = undefined;
            this.lastWildSpeciesId = undefined;
            this.isFlashingDamage = false;
        }

        if (!state.hasStarted) {
            // Not started view
            card.innerHTML = `
                <div class="flickemon-header start-header">
                    <div class="header-left">
                        ${gameControllerSvg}
                        <span class="header-title">Flickémon</span>
                    </div>
                    <button class="start-game-badge-btn">Start Game ✨</button>
                </div>
            `;
            card.querySelector('.start-game-badge-btn').addEventListener('click', () => {
                this.beginGameFlow();
            });
            return;
        }

        const active = this.engine.getActivePokemon();
        const activeSpecies = active ? this.engine.getSpeciesForPokemon(active) : null;
        if (!active || !activeSpecies) return;

        const expProg = this.engine.getExpProgress(active);
        const isCaptureMode = this.engine.isCaptureMode();
        const reward = this.engine.getActiveReward ? this.engine.getActiveReward() : null;
        const money = this.engine.getMoney ? this.engine.getMoney() : 0;
        const expDebt = this.engine.getExpDebt ? this.engine.getExpDebt() : 0;

        // onVideoProgress fires ~4x/sec, and rebuilding innerHTML each time tore
        // down every button mid-click and wiped the open popover — the widget
        // was effectively unusable while a lecture played. Anything that changes
        // continuously (HP, EXP) is patched in place instead; only a structural
        // change rebuilds.
        const signature = [
            activeSpecies.id, active.level, isCaptureMode,
            // The MEGA form, not just the species. getSpeciesForPokemon returns
            // the base species by design, so a mega toggle changes none of the
            // other fields here -- the signature matched, the widget took the
            // patch path, and patchWidgetView does not touch the partner
            // sprite. The HUD went on showing the ordinary sprite until some
            // unrelated structural change happened to force a rebuild.
            this.engine.activeMegaForm ? (this.engine.activeMegaForm(active)?.key ?? '-') : '-',
            wild ? wild.wildSpecies.id : '-', wild ? wild.status : '-',
            // Shiny decides the sprite AND whether the catch is guaranteed, so
            // two encounters with the same species must not share a signature.
            wild ? (wild.shiny === true) : '-',
            // Structural: it adds a line and takes the catch button away. It
            // moves only on a win or a button press, never on a video tick.
            expDebt,
            // Only the type, not the countdown: the minutes are patched in
            // place, so a ticking clock must not force a rebuild every minute.
            reward ? reward.type : '-',
            money,
        ].join('|');

        if (card.dataset.sig === signature && card.querySelector('.widget-body')) {
            this.patchWidgetView(card, expProg, wild);
            return;
        }
        card.dataset.sig = signature;

        card.innerHTML = `
            <div class="flickemon-header">
                <div class="header-left">
                    ${gameControllerSvg}
                    <span class="header-title">Flickémon</span>
                </div>
                <div class="header-actions">
                    <div class="mode-switch" role="group" aria-label="Battle mode">
                        <button class="mode-seg" data-mode="capture"
                                aria-pressed="${isCaptureMode}"
                                title="Capture mode — defeated Pokémon join your party and Pokédex.">
                            ${pokeballSvg}<span class="mode-seg-label">Capture</span>
                        </button>
                        <button class="mode-seg" data-mode="exp"
                                aria-pressed="${!isCaptureMode}"
                                title="EXP mode — no captures, but roughly 2x faster levelling.">
                            ${boltSvg}<span class="mode-seg-label">EXP</span>
                        </button>
                    </div>
                    <button class="pvp-header-btn" title="Battle another trainer">${swordsSvg}<span class="pvp-header-label">PVP</span></button>
                    <button class="trade-header-btn" title="Trade with another trainer">${tradeSvg}<span class="pvp-header-label">Trade</span></button>
                    <button class="friends-header-btn" title="Friends and the global board">${friendsSvg}<span class="pvp-header-label">Friends</span></button>
                    <button class="shop-header-btn" title="Poké Mart — spend what you have earned">${shopSvg}<span class="shop-header-label">${this.config.formatMoney(money)}</span></button>
                    <button class="icon-btn menu-trigger-btn" title="Options">${ellipsisSvg}</button>
                    <button class="icon-btn widget-collapse-btn" title="Toggle Collapse">${chevronUpSvg}</button>

                    <!-- Options Popover Menu -->
                    <div class="options-popover-menu" style="display: none;">
                        <div class="popover-item game-hub-item"><span class="popover-icon">${menuGameControllerSvg}</span> Game Hub</div>
                        <div class="popover-item guide-item"><span class="popover-icon">${bookSvg}</span> How to Play</div>
                        <div class="popover-item music-item"><span class="popover-icon">${noteSvg}</span> Music</div>
                        <div class="popover-item settings-item"><span class="popover-icon">${gearSvg}</span> Settings</div>
                        <div class="popover-item support-item"><span class="popover-icon">${heartSvg}</span> Support the Creator</div>
                    </div>
                </div>
            </div>
            <div class="widget-body">
                <div class="music-bar" hidden></div>
                ${reward ? `
                    <div class="reward-banner reward-${reward.type}">
                        <span class="reward-icon">${this.config.REWARD_INFO[reward.type].icon}</span>
                        <div class="reward-copy">
                            <span class="reward-label">${this.config.REWARD_INFO[reward.type].label}</span>
                            <span class="reward-note">Boosts never stack — win again once this runs out.</span>
                        </div>
                        <span class="reward-left" title="Time left on this boost">${this.config.formatCountdown(reward.msLeft)}</span>
                        <span class="reward-drain"><span class="reward-drain-fill" style="width: ${this.rewardPercentLeft(reward)}%;"></span></span>
                    </div>` : ''}
                <div class="hud-columns">
                    <!-- Left: Active Partner -->
                    <div class="hud-col partner-col">
                        <img src="${this.config.getSpriteUrl(this.engine.spriteIdFor(active), active.shiny)}" alt="${activeSpecies.name}" class="partner-mini-sprite${active.shiny ? ' is-shiny' : ''}${this.engine.activeMegaForm(active) ? ' is-mega' : ''}"/>
                        <div class="partner-info">
                            <div class="name-line">
                                <strong class="pk-name">${activeSpecies.name}</strong>
                                <span class="pk-lvl">Lv.${active.level}</span>
                            </div>
                            <div class="exp-bar-track">
                                <div class="exp-bar-fill" style="width: ${expProg.percent}%;"></div>
                            </div>
                            <div class="exp-text">EXP ${expProg.current}/${expProg.needed}</div>
                        </div>
                    </div>

                    <!-- Right: Wild Opponent Battle (Outlined Box) -->
                    <div class="hud-col battle-col-box">
                        ${wild ? `
                            <span class="vs-badge">VS</span>
                            <img src="${this.config.getSpriteUrl(this.wildSpriteId(wild), wild.shiny)}" alt="${wild.wildSpecies.name}" class="wild-mini-sprite ${wild.status} ${wild.shiny ? 'is-shiny' : ''} ${wild.megaForm ? 'is-mega' : ''} ${this.isFlashingDamage ? 'damage-flash' : ''}"/>
                            <div class="battle-info">
                                <div class="name-line">
                                    <strong class="pk-name">${wild.wildSpecies.name}</strong>
                                    <span class="pk-lvl">Lv.${wild.wildLevel}</span>
                                </div>
                                <div class="hp-bar-track">
                                    <div class="hp-bar-fill" style="width: ${Math.round((wild.currentHp / wild.maxHp) * 100)}%;"></div>
                                </div>
                                ${wild.wildSpecies.isCustom ? `<div class="custom-flag">${this.config.CUSTOM_MARK} ${this.config.CUSTOM_LABEL}!</div>` : ''}
                                ${wild.wildSpecies.isLegendary ? '<div class="legendary-flag">★ Legendary!</div>' : ''}
                                ${wild.shiny ? '<div class="shiny-flag">✦ Shiny!</div>' : ''}
                                ${wild.megaForm ? `<div class="mega-flag">◆ ${this.wildMegaName(wild)}!</div>` : ''}
                                <div class="status-line ${wild.status}">
                                    ${wild.status === 'captured'
                                        ? `🏆 ${wild.guaranteed ? 'Caught — too rare to lose!' : 'Caught!'}${wild.instant ? '' : ` (+${wild.expGained || 0} EXP, +${this.config.formatMoney(wild.moneyGained || 0)})`}`
                                        : wild.status === 'defeated'
                                        // A capture that missed its roll is still a win —
                                        // it just did not end with a Pokémon. Saying so is
                                        // what stops a 60% miss reading as a lost catch.
                                        ? `${wild.brokeFree ? '💨 It broke free and fled!' : '💥 Defeated!'} (+${wild.expGained || 0} EXP, +${this.config.formatMoney(wild.moneyGained || 0)})`
                                        : wild.status === 'escaped'
                                        ? `💨 Escaped! (+${wild.expGained || 0} EXP, +${this.config.formatMoney(wild.moneyGained || 0)})`
                                        : `⚔️ Fighting... (HP ${wild.currentHp}/${wild.maxHp})`}
                                </div>
                                ${wild.status === 'fighting' ? (
                                    // Shown in BOTH modes: this is the one thing
                                    // EXP mode does catch, and a capture there
                                    // with no warning reads as a bug.
                                    //
                                    // It also replaces the button rather than
                                    // sitting beside it. Never offer to sell
                                    // what is already free — ten wins of EXP for
                                    // nothing you were not getting anyway.
                                    (wild.wildSpecies.isLegendary || wild.shiny)
                                    ? `<div class="guaranteed-flag">Guaranteed catch — just win</div>`
                                    : isCaptureMode
                                    ? `<button class="catch-now-btn"
                                            title="Catch it now, without finishing the fight. Costs the EXP from your next ${this.config.INSTANT_CAPTURE_EXP_DEBT} wins.">
                                        ${pokeballSvg} CATCH NOW
                                    </button>`
                                    : '') : ''}
                                ${expDebt > 0 ? `
                                    <div class="exp-debt-flag"
                                         title="You spent this on an instant capture. Catching still works normally.">
                                        No EXP for ${expDebt} more win${expDebt === 1 ? '' : 's'}
                                    </div>` : ''}
                            </div>
                        ` : '<div class="searching-text">Searching for wild Pokémon...</div>'}
                    </div>
                </div>
            </div>
        `;

        // Irreversible, and expensive enough to be worth a beat of thought:
        // ten wins is roughly twenty-five minutes of lectures with nothing to
        // show for them. Confirm rather than let a mis-click spend it.
        card.querySelector('.catch-now-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const cost = this.config.INSTANT_CAPTURE_EXP_DEBT;
            const owed = this.engine.getExpDebt();
            if (!confirm(
                `Catch it now, without finishing the fight?\n\n`
                + `Your next ${cost} wins will award no EXP`
                + (owed > 0 ? ` — on top of the ${owed} you already owe.` : '.')
                + `\nCatching still works normally the whole time.`
            )) return;
            const res = await this.engine.instantCapture();
            if (res.ok && !res.joined) {
                alert('Your party is full, so it could not join — but it is '
                    + 'recorded in your Pokédex.');
            }
        });

        // Each segment selects its own mode directly, rather than one button
        // cycling — with two states a switch shows both options and which is on.
        card.querySelectorAll('.mode-seg').forEach(seg => {
            seg.addEventListener('click', async (e) => {
                e.stopPropagation(); // the document handler would close the popover first
                await this.engine.setBattleMode(seg.dataset.mode);
            });
        });

        card.querySelector('.pvp-header-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openPvp();
        });

        card.querySelector('.friends-header-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openFriends();
        });

        card.querySelector('.trade-header-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openTrade();
        });

        card.querySelector('.shop-header-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openShop();
        });

        const menuBtn = card.querySelector('.menu-trigger-btn');
        const popover = card.querySelector('.options-popover-menu');
        const collapseBtn = card.querySelector('.widget-collapse-btn');
        const widgetBody = card.querySelector('.widget-body');

        // Rebuilds always emit the popover hidden; restore whatever it was.
        popover.style.display = this.popoverOpen ? 'block' : 'none';

        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.popoverOpen = !this.popoverOpen;
            popover.style.display = this.popoverOpen ? 'block' : 'none';
        });



        card.querySelector('.game-hub-item').addEventListener('click', (e) => {
            e.stopPropagation();
            this.popoverOpen = false;
            popover.style.display = 'none';
            this.openGameHub();
        });

        card.querySelector('.settings-item').addEventListener('click', (e) => {
            e.stopPropagation();
            this.popoverOpen = false;
            popover.style.display = 'none';
            this.openSettingsModal();
        });

        card.querySelector('.music-item').addEventListener('click', (e) => {
            e.stopPropagation();
            this.popoverOpen = false;
            popover.style.display = 'none';
            this.openMusicModal();
        });

        card.querySelector('.guide-item').addEventListener('click', (e) => {
            e.stopPropagation();
            this.popoverOpen = false;
            popover.style.display = 'none';
            this.openGuideModal();
        });

        card.querySelector('.support-item').addEventListener('click', (e) => {
            e.stopPropagation();
            this.popoverOpen = false;
            popover.style.display = 'none';
            this.openSupportModal();
        });

        if (this.isCollapsed === undefined) {
            this.isCollapsed = false;
        }
        
        // Restore collapse state
        widgetBody.style.display = this.isCollapsed ? 'none' : 'block';
        collapseBtn.innerHTML = this.isCollapsed ? chevronDownSvg : chevronUpSvg;

        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.isCollapsed = !this.isCollapsed;
            widgetBody.style.display = this.isCollapsed ? 'none' : 'block';
            collapseBtn.innerHTML = this.isCollapsed ? chevronDownSvg : chevronUpSvg;
        });

        // A rebuild wipes the bar, so redraw it from the player's current state.
        this.renderMusicBar(card);
    }

    /**
     * Updates only the values that move every tick, leaving the DOM (and any
     * in-flight click or open menu) intact.
     */
    patchWidgetView(card, expProg, wild) {
        const banner = card.querySelector('.reward-banner');
        if (banner && this.engine.getActiveReward) {
            const r = this.engine.getActiveReward();
            if (r) this.paintRewardBanner(banner, r);
        }

        const expFill = card.querySelector('.exp-bar-fill');
        if (expFill) expFill.style.width = `${expProg.percent}%`;
        const expText = card.querySelector('.exp-text');
        if (expText) expText.textContent = `EXP ${expProg.current}/${expProg.needed}`;

        if (!wild) return;

        const hpFill = card.querySelector('.hp-bar-fill');
        if (hpFill) hpFill.style.width = `${Math.round((wild.currentHp / wild.maxHp) * 100)}%`;

        const statusEl = card.querySelector('.status-line');
        if (statusEl && wild.status === 'fighting') {
            statusEl.textContent = `⚔️ Fighting... (HP ${wild.currentHp}/${wild.maxHp})`;
        }

        // Damage flash is a transient class, so it is toggled rather than baked in.
        const sprite = card.querySelector('.wild-mini-sprite');
        if (sprite) sprite.classList.toggle('damage-flash', !!this.isFlashingDamage);
    }

    openFriends() {
        if (!window.FlickemonFriends) return;
        if (!this.friends) this.friends = new window.FlickemonFriends(this.engine, this);
        this.friends.open();
    }

    openShop() {
        if (!window.FlickemonShop) return;
        if (!this.shop) this.shop = new window.FlickemonShop(this.engine, this);
        this.shop.open();
    }

    openTrade() {
        if (!window.FlickemonTrade) return;
        if (!this.trade) this.trade = new window.FlickemonTrade(this.engine, this);
        this.trade.open();
    }

    openPvp() {
        if (!window.FlickemonPvp) return;
        if (!this.pvp) this.pvp = new window.FlickemonPvp(this.engine, this);
        this.pvp.open();
    }

    // ────────────────────────── Sign-In Gate ──────────────────────────

    /**
     * Entry point for "Start Game". Auth happens BEFORE starter selection on
     * purpose: if a student signs in on a second device after already picking
     * a starter locally, the monotonic cloud merge folds BOTH starters into
     * their account. Gating here means a returning student resumes their real
     * partner and is never offered a choice they've already made.
     */
    async beginGameFlow() {
        const status = await this.engine.getSyncStatus();

        // Sync not set up at all (dev build / missing Firebase config). Don't
        // make the game unplayable — fall back to local-only play.
        if (status.reachable && !status.configured) {
            this.openStarterModal();
            return;
        }

        if (!status.signedIn) {
            this.openSignInGateModal({ workerDown: !status.reachable });
            return;
        }

        await this.resumeOrChooseStarter();
    }

    /** Restore the account's existing save, or pick a starter if it's a new account. */
    async resumeOrChooseStarter() {
        await this.engine.pullFromCloud();

        // A save just came down from the account — resume it instead of
        // offering a starter choice.
        if (this.engine.hasStarted()) return;

        this.openStarterModal();
    }

    /**
     * Signing in is the intended path, so it's the only thing offered up front.
     * But auth can be genuinely unavailable — a misconfigured OAuth client, an
     * offline student, a background worker that won't wake — and walling the
     * game off behind a broken dependency is worse than syncing late. The
     * bypass is therefore revealed only once an attempt has actually failed,
     * and a save made that way is dropped if the account already has one (see
     * FlickemonEngine.signIn), so it can never create a second starter.
     */
    openSignInGateModal({ workerDown = false } = {}) {
        const modal = this.createModalOverlay('Sign in to play');

        modal.body.innerHTML = `
            <div class="signin-gate">
                <div class="signin-gate-icon">☁️</div>
                <h2 class="signin-gate-title">Sign in to start</h2>
                <p class="signin-gate-text">
                    Your Pokémon, Pokédex and study time are saved to your account,
                    so your progress follows you to any device you study on.
                </p>
                <button class="signin-gate-btn">Sign in with Google</button>
                <p class="signin-gate-error"></p>
                <button class="signin-gate-skip">Continue without signing in</button>
                <p class="signin-gate-skip-note">
                    Progress stays on this device only, and will not appear on your
                    other devices until you sign in.
                </p>
            </div>
        `;

        const btn = modal.body.querySelector('.signin-gate-btn');
        const errEl = modal.body.querySelector('.signin-gate-error');
        const skipBtn = modal.body.querySelector('.signin-gate-skip');
        const skipNote = modal.body.querySelector('.signin-gate-skip-note');

        const revealBypass = () => {
            skipBtn.classList.add('visible');
            skipNote.classList.add('visible');
        };

        // Nothing to attempt if the worker never answered — offer the bypass now.
        if (workerDown) {
            errEl.textContent = 'Could not reach the sync service.';
            errEl.classList.add('visible');
            revealBypass();
        }

        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Signing in…';
            errEl.classList.remove('visible');

            try {
                // signIn() already pulls the account's save down, so branch on
                // the merged result rather than paying for a second read.
                await this.engine.signIn();
                this.closeModal(modal.overlay);
                if (!this.engine.hasStarted()) this.openStarterModal();
            } catch (e) {
                errEl.textContent = e.message || 'Sign-in failed';
                errEl.classList.add('visible');
                btn.disabled = false;
                btn.textContent = 'Try signing in again';
                revealBypass();
            }
        });

        skipBtn.addEventListener('click', () => {
            this.closeModal(modal.overlay);
            this.openStarterModal();
        });
    }

    // ────────────────────────── Starter Selection Modal ──────────────────────────

    openStarterModal() {
        const modal = this.createModalOverlay('Choose Your Partner');
        modal.overlay.classList.add('starter-overlay');
        const options = this.engine.getStarterOptions();

        modal.body.innerHTML = `
            <div class="starter-modal-content">
                <header class="starter-hero">
                    <p class="starter-hero-eyebrow">New Trainer</p>
                    <h1 class="starter-hero-title">Choose Your Partner</h1>
                    <p class="starter-hero-subtitle">
                        They gain EXP for every minute of lecture you watch, and evolve as you go.
                    </p>
                </header>

                <div class="gen-tabs" role="tablist" aria-label="Region">
                    ${STARTER_REGIONS.map(r => `
                        <button class="gen-tab-btn ${r.gen === 1 ? 'active' : ''}"
                                role="tab" aria-selected="${r.gen === 1}" data-gen="${r.gen}">
                            <strong>${r.region}</strong>
                            <small>${r.games}</small>
                        </button>
                    `).join('')}
                </div>

                <div class="starters-grid" role="radiogroup" aria-label="Starter Pokémon"></div>
                <section class="starter-detail" aria-live="polite"></section>
            </div>

            <footer class="starter-confirm-bar">
                <button class="starter-confirm-btn" disabled>Select a Pokémon</button>
            </footer>
        `;

        const grid    = modal.body.querySelector('.starters-grid');
        const detail  = modal.body.querySelector('.starter-detail');
        const confirm = modal.body.querySelector('.starter-confirm-btn');

        let selected = null;

        const select = (species) => {
            selected = species;

            grid.querySelectorAll('.starter-card').forEach(card => {
                const isIt = Number(card.dataset.id) === species.id;
                card.classList.toggle('selected', isIt);
                card.setAttribute('aria-checked', String(isIt));
                card.tabIndex = isIt ? 0 : -1;
            });

            detail.innerHTML = this.renderStarterDetail(species);
            confirm.disabled = false;
            confirm.textContent = `I choose you, ${species.name}!`;
        };

        const renderGrid = (gen) => {
            const starters = this.startersForRegion(options, gen);

            grid.innerHTML = starters.map(s => `
                <div class="starter-card" role="radio" aria-checked="false" tabindex="-1" data-id="${s.id}">
                    <div class="starter-card-orb">
                        <img class="starter-card-img" src="${this.config.getSpriteUrl(s.id)}" alt="${s.name}"/>
                    </div>
                    <h4 class="starter-card-name">${s.name}</h4>
                    <div class="types-row">
                        ${s.types.map(t => `<span class="type-pill ${t}">${t}</span>`).join('')}
                    </div>
                </div>
            `).join('');

            const cards = [...grid.querySelectorAll('.starter-card')];
            cards.forEach((card, i) => {
                const species = starters[i];
                card.addEventListener('click', () => select(species));
                card.addEventListener('keydown', (e) => {
                    // Arrow keys walk the trio; Enter takes the one in focus.
                    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
                    if (step) {
                        e.preventDefault();
                        const next = (i + step + cards.length) % cards.length;
                        select(starters[next]);
                        cards[next].focus();
                    } else if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        select(species);
                    }
                });
            });

            // Never show an empty detail panel — the first of the trio stands in
            // until the trainer picks. Confirming still takes a deliberate click.
            if (starters.length) select(starters[0]);
        };

        confirm.addEventListener('click', async () => {
            if (!selected || confirm.disabled) return;
            confirm.disabled = true;                  // chooseStarter is async; no double-taps
            try {
                await this.engine.chooseStarter(selected.id);
                this.closeModal(modal.overlay);
            } catch (err) {
                // A failed save must not strand the trainer on a dead button.
                console.error('[Flickémon] Could not set starter:', err);
                confirm.disabled = false;
                confirm.textContent = 'Try again';
            }
        });

        modal.body.querySelectorAll('.gen-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.body.querySelectorAll('.gen-tab-btn').forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                renderGrid(Number(btn.dataset.gen));
            });
        });

        renderGrid(1);
    }

    /** The starters shown on one region tab. Every option belongs to exactly one. */
    startersForRegion(options, gen) {
        const isSpecial = s => SPECIAL_STARTER_IDS.includes(s.id);
        if (gen === 0) return options.filter(isSpecial);
        if (gen === 1) return options.filter(s => s.generation === 1 && !isSpecial(s));
        return options.filter(s => s.generation === gen);
    }

    /**
     * The panel under the trio: who they are, how they compare, and — the part
     * that actually decides the choice — what they become and when.
     */
    renderStarterDetail(species) {
        const line  = this.config.getEvolutionLine(species.id);
        const total = this.config.totalBaseStats(species);
        const final = line[line.length - 1].species;
        const branches = line[0].branches;

        return `
            <div class="starter-detail-inner accent-${species.types[0]}">
                <div class="starter-detail-head">
                    <div class="starter-detail-portrait">
                        <img src="${this.config.getSpriteUrl(species.id)}" alt="${species.name}"/>
                    </div>
                    <div class="starter-detail-id">
                        <span class="starter-dex-no">No. ${String(species.id).padStart(3, '0')}</span>
                        <h3 class="starter-detail-name">${species.name}</h3>
                        <div class="types-row">
                            ${species.types.map(t => `<span class="type-pill ${t}">${t}</span>`).join('')}
                        </div>
                    </div>
                </div>

                <div class="starter-stats">
                    <div class="starter-stats-head">
                        <span>Base stats</span>
                        <span class="starter-stat-total">${total} total</span>
                    </div>
                    ${this.renderStatBars(species)}
                </div>

                <div class="starter-evo">
                    <div class="starter-evo-head">Evolution line</div>
                    <div class="starter-evo-chain">
                        ${line.map((step, i) => `
                            ${i ? `<span class="starter-evo-arrow">
                                       <span class="starter-evo-lvl">Lv.${line[i - 1].evolvesAt}</span>
                                       <span class="starter-evo-tick">→</span>
                                   </span>` : ''}
                            <figure class="starter-evo-step">
                                <img src="${this.config.getSpriteUrl(step.species.id)}" alt="${step.species.name}"/>
                                <figcaption>${step.species.name}</figcaption>
                            </figure>
                        `).join('')}
                    </div>
                    <p class="starter-evo-note">
                        ${line.length > 1
                            ? `Becomes ${final.name} at Lv.${line[line.length - 2].evolvesAt}.`
                            : `${species.name} does not evolve.`}
                        ${branches > 1 ? ` ${species.name} has ${branches} known evolutions; Flickémon takes this one.` : ''}
                    </p>
                </div>
            </div>
        `;
    }

    /** Base stats as bars, scaled to a fixed maximum so trios compare across tabs. */
    renderStatBars(species) {
        const rows = [
            ['HP',  species.baseStats.hp],
            ['ATK', species.baseStats.attack],
            ['DEF', species.baseStats.defense],
            ['SPD', species.baseStats.speed],
        ];

        return rows.map(([label, value]) => `
            <div class="starter-stat-row">
                <span class="starter-stat-label">${label}</span>
                <span class="starter-stat-track">
                    <span class="starter-stat-fill" style="width: ${Math.min(100, Math.round((value / STARTER_STAT_SCALE) * 100))}%;"></span>
                </span>
                <span class="starter-stat-value">${value}</span>
            </div>
        `).join('');
    }
    // ────────────────────────── Game Hub Modal ──────────────────────────

    openGameHub() {
        const modal = this.createModalOverlay('Flickémon');

        // Inject Tab Bar outside of the modal.body to keep it sticky at the top
        const tabRow = document.createElement('div');
        tabRow.className = 'flickemon-tabs';
        tabRow.innerHTML = `
            <button class="flickemon-tab-btn active" data-tab="partner">My Partner</button>
            <button class="flickemon-tab-btn" data-tab="party">Party</button>
            <button class="flickemon-tab-btn" data-tab="pokedex">Pokédex</button>
            <button class="flickemon-tab-btn" data-tab="stats">Stats</button>
        `;
        // Insert it right after the header
        modal.body.parentElement.insertBefore(tabRow, modal.body);

        const content = modal.body;

        const renderTab = (tab) => {
            // Read live every time. These were previously captured once when the
            // hub opened, so after switching partner or editing the team the
            // list re-rendered against stale data: the ACTIVE badge never moved
            // (looking like partner selection was broken) and a row that was
            // really the active partner rendered as an ordinary member.
            const active = this.engine.getActivePokemon();
            const activeSpecies = active ? this.engine.getSpeciesForPokemon(active) : null;
            const party = this.engine.getParty();
            const pokedex = this.engine.getPokedex();
            if (tab === 'partner') {
                if (active && activeSpecies) {
                    const expProg = this.engine.getExpProgress(active);
                    content.innerHTML = `
                        <div class="partner-section">
                            <img src="${this.config.getSpriteUrl(this.engine.spriteIdFor(active), active.shiny)}" alt="${activeSpecies.name}" class="partner-big-sprite${active.shiny ? ' is-shiny' : ''}${this.engine.activeMegaForm(active) ? ' is-mega' : ''}"/>
                            <h2 class="partner-big-name">
                                ${activeSpecies.name}
                                ${activeSpecies.isCustom ? `<span class="badge badge-custom" title="${this.config.CUSTOM_LABEL}">${this.config.CUSTOM_LABEL}</span>` : ''}
                                ${activeSpecies.isLegendary ? '<span class="badge badge-legendary" title="Legendary">★</span>' : ''}
                                ${active.shiny ? '<span class="badge badge-shiny" title="Shiny">✦</span>' : ''}
                                ${this.engine.activeMegaForm(active) ? `<span class="badge badge-mega" title="${this.engine.activeMegaForm(active).name} — deals 1.3x damage">MEGA</span>` : ''}
                            </h2>
                            <div class="partner-types">${activeSpecies.types.map(t => `<span class="type-badge" data-type="${t}">${t}</span>`).join('')}</div>
                            <p class="partner-big-level">Level ${active.level}</p>
                            
                            <div class="partner-exp-wrap">
                                <div class="partner-exp-bar-bg">
                                    <div class="partner-exp-bar-fill" style="width: ${expProg.percent}%;"></div>
                                </div>
                                <div class="partner-exp-text">EXP ${expProg.current} / ${expProg.needed}</div>
                            </div>
                            
                            <div class="partner-stats-grid">
                                <div class="stat-box"><span class="stat-box-label">HP</span> <span class="stat-box-value">${this.config.calculateRealMaxHp(activeSpecies.baseStats.hp, active.level)}</span></div>
                                <div class="stat-box"><span class="stat-box-label">Attack</span> <span class="stat-box-value">${activeSpecies.baseStats.attack}</span></div>
                                <div class="stat-box"><span class="stat-box-label">Defense</span> <span class="stat-box-value">${activeSpecies.baseStats.defense}</span></div>
                                <div class="stat-box"><span class="stat-box-label">Speed</span> <span class="stat-box-value">${activeSpecies.baseStats.speed}</span></div>
                            </div>
                        </div>
                    `;
                } else {
                    content.innerHTML = `<div class="partner-section"><p>No partner selected.</p></div>`;
                }
            } else if (tab === 'party') {
                const team = this.engine.getTeam();
                const maxTeam = this.config.MAX_TEAM_SIZE;
                const sharePct = Math.round(this.config.TEAM_EXP_SHARE * 100);

                // Favourites first, then by level. Sorting a copy: the stored
                // party order is meaningful elsewhere.
                const ordered = [...party].sort((a, b) => {
                    const fa = this.engine.isFavourite(a.instanceId) ? 0 : 1;
                    const fb = this.engine.isFavourite(b.instanceId) ? 0 : 1;
                    return fa !== fb ? fa - fb : b.level - a.level;
                });

                // Catching a species twice gives two separate Pokémon, and two
                // rows reading "Pikachu Lv.5" would be indistinguishable. Number
                // them, in the party's own order so a badge doesn't move around
                // when the list is re-sorted.
                const copiesOf = new Map();
                party.forEach(pk => copiesOf.set(pk.speciesId, (copiesOf.get(pk.speciesId) || 0) + 1));
                const ordinal = new Map();
                const nextOrdinal = new Map();
                party.forEach(pk => {
                    const n = (nextOrdinal.get(pk.speciesId) || 0) + 1;
                    nextOrdinal.set(pk.speciesId, n);
                    ordinal.set(pk.instanceId, n);
                });

                content.innerHTML = `
                    <div class="party-team-summary">
                        <strong>Team ${team.length}/${maxTeam}</strong>
                        <span>Team members earn ${sharePct}% of your partner's EXP</span>
                    </div>
                    <div class="party-list">
                        ${ordered.map(pk => {
                            const sp = this.engine.getSpeciesForPokemon(pk);
                            if (!sp) return '';
                            const isActive = pk.instanceId === active?.instanceId;
                            const fav = this.engine.isFavourite(pk.instanceId);
                            const onTeam = this.engine.isOnTeam(pk.instanceId);
                            const full = this.engine.isTeamFull();
                            const dupe = copiesOf.get(pk.speciesId) > 1
                                ? `<span class="party-row-copy">#${ordinal.get(pk.instanceId)}</span>` : '';
                            // Mega: what it is wearing now, what it could wear,
                            // and what it owns but cannot use yet.
                            const megaOn = this.engine.activeMegaForm(pk);
                            const megaReady = this.engine.availableMegaForms(pk);
                            const megaDormant = this.engine.dormantMegaStones(pk);
                            const stoneNames = [...megaReady, ...megaDormant].map(f => f.stone);
                            return `
                                <div class="party-row ${isActive ? 'is-active' : ''} ${onTeam ? 'on-team' : ''}"
                                     data-instance="${pk.instanceId}">
                                    <img src="${this.config.getSpriteUrl(this.engine.spriteIdFor(pk), pk.shiny)}" alt="${sp.name}" class="party-row-sprite${pk.shiny ? ' is-shiny' : ''}${megaOn ? ' is-mega' : ''}"/>
                                    <div class="party-row-info">
                                        <span class="party-row-name">
                                            ${sp.name}${dupe}
                                            ${sp.isCustom ? `<span class="badge badge-custom" title="${this.config.CUSTOM_LABEL}">${this.config.CUSTOM_LABEL}</span>` : ''}
                                            ${sp.isLegendary ? '<span class="badge badge-legendary" title="Legendary">★</span>' : ''}
                                            ${pk.shiny ? '<span class="badge badge-shiny" title="Shiny">✦</span>' : ''}
                                            ${isActive ? '<span class="badge badge-active">ACTIVE</span>' : ''}
                                            ${onTeam && !isActive ? '<span class="badge badge-team">TEAM</span>' : ''}
                                            ${megaOn ? `<span class="badge badge-mega" title="${megaOn.name} — deals 1.3x damage">MEGA</span>` : ''}
                                        </span>
                                        <span class="party-row-level">Lv. ${pk.level}${
                                            stoneNames.length
                                                ? `<span class="party-row-stones" title="Mega stones held by this Pokémon">◆ ${stoneNames.join(' · ')}${
                                                      megaDormant.length ? ' (locked until it evolves)' : ''}</span>`
                                                : ''}</span>
                                    </div>
                                    <div class="party-row-actions">
                                        <button class="row-btn partner-btn ${isActive ? 'on' : ''}"
                                                data-instance="${pk.instanceId}"
                                                ${isActive ? 'disabled' : ''}
                                                title="${isActive ? 'This is your active partner' : `Make ${sp.name} your partner`}">⚔</button>
                                        <button class="row-btn fav-btn ${fav ? 'on' : ''}"
                                                data-instance="${pk.instanceId}"
                                                title="${fav ? 'Remove from favourites' : 'Mark as favourite'}">${fav ? '★' : '☆'}</button>
                                        <button class="row-btn team-btn ${onTeam ? 'on' : ''}"
                                                data-instance="${pk.instanceId}"
                                                ${isActive ? 'disabled' : ''}
                                                title="${isActive ? 'Your partner is always on the team'
                                                        : onTeam ? 'Remove from team'
                                                        : full ? `Team is full (${maxTeam})` : 'Add to team'}">
                                            ${onTeam ? '✓' : '+'}
                                        </button>
                                        ${megaReady.length || megaDormant.length ? `
                                        <button class="row-btn mega-btn ${megaOn ? 'on' : ''}"
                                                data-instance="${pk.instanceId}"
                                                ${megaReady.length ? '' : 'disabled'}
                                                title="${megaReady.length
                                                    ? (megaOn
                                                        ? (megaReady.length > 1
                                                            ? `${megaOn.name} — click for the next form`
                                                            : `${megaOn.name} — click to revert`)
                                                        : `Mega Evolve into ${megaReady[0].name}`)
                                                    : `${megaDormant[0].stone} is held but unusable until ${sp.name} ${this.megaUnlockHint(pk)}`}">◆</button>` : ''}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;

                // Row click sets the active partner.
                content.querySelectorAll('.party-row').forEach(row => {
                    row.addEventListener('click', async () => {
                        if (row.classList.contains('is-active')) return;
                        await this.engine.switchActivePokemon(row.getAttribute('data-instance'));
                        renderTab('party');
                    });
                });

                // Buttons must not also trigger the row's set-active handler.
                content.querySelectorAll('.fav-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this.engine.toggleFavourite(btn.dataset.instance);
                        renderTab('party');
                    });
                });
                content.querySelectorAll('.partner-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (btn.disabled) return;
                        await this.engine.switchActivePokemon(btn.dataset.instance);
                        renderTab('party');
                    });
                });
                // Cycles owned forms and then back to normal. The row's own
                // click handler sets the active partner, so stopping the event
                // here is mandatory rather than tidy.
                content.querySelectorAll('.mega-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (btn.disabled) return;
                        const instanceId = btn.dataset.instance;
                        const res = await this.engine.toggleMega(instanceId);
                        if (!res.ok) {
                            if (res.reason === 'dormant') {
                                alert('That Pokémon holds a Mega Stone but has not reached '
                                    + 'its final form yet. It will be usable once it evolves.');
                            }
                            return;
                        }
                        renderTab('party');
                        // The engine hands back a form here only the first time
                        // this Pokémon takes it. Every later flick of the button
                        // is silent: replaying an 8.5-second takeover on a
                        // toggle would wear out the one moment it exists for.
                        if (res.scene) {
                            const member = this.engine.getParty()
                                .find(pk => pk.instanceId === instanceId);
                            this.showMegaOverlay(res.scene, member);
                        }
                    });
                });
                content.querySelectorAll('.team-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (btn.disabled) return;
                        const res = await this.engine.toggleTeamMember(btn.dataset.instance);
                        if (!res.ok) {
                            alert(res.reason === 'active'
                                ? 'Your partner is always on the team.'
                                : `Your team is full (${this.config.MAX_TEAM_SIZE}). Remove someone first.`);
                            return;
                        }
                        renderTab('party');
                    });
                });
            } else if (tab === 'pokedex') {
                // 1,025 entries, so both of these matter here and nowhere else:
                //   - a Map instead of pokedex.find() per row, which was a
                //     linear scan inside a 1,025-iteration loop;
                //   - loading="lazy", so the browser fetches the ~30 sprites on
                //     screen instead of firing 1,025 requests at the sprite host
                //     every time the tab is opened.
                const dex = new Map(pokedex.map(e => [e.speciesId, e]));
                content.innerHTML = `
                    <div class="flickemon-pokedex-grid">
                        ${this.config.POKEMON_REGISTRY.map(sp => {
                            const entry = dex.get(sp.id);
                            const caught = entry && entry.caught;
                            const seen = entry && entry.seen;
                            return `
                                <div class="pokedex-item">
                                    ${seen
                                        ? `<img src="${this.config.getSpriteUrl(sp.id, entry && entry.shiny)}" alt="${sp.name}" class="pokedex-sprite${caught ? '' : ' unseen-silhouette'}${entry && entry.shiny ? ' is-shiny' : ''}"
                                                width="64" height="64" loading="lazy" decoding="async"/>`
                                        : `<div class="pokedex-unknown">?</div>`
                                    }
                                    <span class="pokedex-num">#${sp.id}${sp.isLegendary && caught ? ' ★' : ''}</span>
                                    ${caught ? `<span class="pokedex-name">${sp.name}</span>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            } else if (tab === 'stats') {
                // The clock behind this is minutes of lecture watched, but that
                // is the last thing the panel should say. Every label here is
                // the adventure's, not the timetable's: "3h 12m on the road"
                // reads like a save file, "5.2 hours watched" reads like a
                // compliance report.
                const mins = Math.round(this.engine.getGameState().totalMinutesWatched);
                const playTime = mins < 60
                    ? `${mins}m`
                    : `${Math.floor(mins / 60)}h ${mins % 60}m`;
                const caught = this.engine.getCaughtCount();
                const total = this.config.POKEMON_REGISTRY.length;

                content.innerHTML = `
                    <div class="flickemon-list-card">
                        <div class="flickemon-list-item">
                            <span class="flickemon-list-item-title">Total Play Time</span>
                            <span class="flickemon-list-item-sub">${playTime} on the road</span>
                        </div>
                        <div class="flickemon-list-item">
                            <span class="flickemon-list-item-title">Pokémon Caught</span>
                            <span class="flickemon-list-item-sub">${caught} / ${total} in the Pokédex</span>
                        </div>
                        <div class="flickemon-list-item">
                            <span class="flickemon-list-item-title">Team on Hand</span>
                            <span class="flickemon-list-item-sub">${party.length} ${party.length === 1 ? 'partner' : 'partners'}</span>
                        </div>
                    </div>
                `;
            }
        };

        renderTab('partner');

        tabRow.querySelectorAll('.flickemon-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                tabRow.querySelectorAll('.flickemon-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderTab(btn.getAttribute('data-tab'));
            });
        });
    }

    // ────────────────────────── Settings Modal ──────────────────────────

    openSettingsModal() {
        const modal = this.createModalOverlay('Flickémon Settings');

        modal.body.innerHTML = `
            <div class="flickemon-list-card">
                <div class="flickemon-list-item">
                    <span class="flickemon-list-item-title">Cloud Save Sync</span>
                    <span class="flickemon-list-item-sub sync-status-line">Checking…</span>
                </div>
            </div>
            <div class="sync-actions">
                <button class="flickemon-primary-btn sync-signin-btn" style="display:none; background: var(--flick-primary); color: white; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; width: 100%; margin-top: 8px;">Sign in with Google</button>
                <button class="flickemon-primary-btn force-sync-btn" style="display:none; background: #10b981; color: white; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; width: 100%; margin-top: 8px;">☁️ SYNC NOW</button>
                <button class="flickemon-primary-btn sync-switch-btn" style="display:none; background: transparent; color: var(--flick-primary); border: 1px solid var(--flick-primary); padding: 10px; border-radius: 8px; font-weight: 700; cursor: pointer; width: 100%; margin-top: 8px;">Switch account</button>
                <button class="flickemon-primary-btn sync-signout-btn" style="display:none; background: transparent; color: var(--flick-text-muted); border: 1px solid var(--flick-border); padding: 10px; border-radius: 8px; font-weight: 700; cursor: pointer; width: 100%; margin-top: 8px;">Sign out</button>
            </div>
            <br/><br/>
            <div class="flickemon-list-card admin-section">
                <div class="flickemon-list-item">
                    <span class="flickemon-list-item-title">Admin Monitoring Portal</span>
                    <span class="flickemon-list-item-sub">Student Player Monitoring Portal (Firestore cloud backend)</span>
                </div>
                <div class="flickemon-list-item">
                    <button class="unlock-admin-btn" style="background:#e91e63; color:white; border:none; border-radius:4px; padding:10px 16px; cursor:pointer; font-weight:700; width:100%;">Unlock admin tools</button>
                    <span class="admin-unlock-note" style="font-size:0.75rem; color:var(--flick-text-muted); margin-top:6px; display:block;">
                        Access is granted to specific accounts, not by passcode.
                    </span>
                </div>
                <div class="flickemon-list-item admin-unlocked-panel" style="display: none; padding: 12px;">
                    <span class="flickemon-list-item-title" style="color: #10b981; display: block; margin-bottom: 12px;">✅ Admin Access Granted</span>
                    <div style="background: rgba(233,30,99,0.06); padding: 12px; border-radius: 8px;">
                        <h4 style="margin: 0 0 8px 0; color: var(--flick-primary);">⚡ Local Game Testing Tools</h4>
                        <div style="margin-bottom: 8px;">
                            <button class="admin-kill-btn" style="background:#ef4444; color:white; border:none; padding:6px 12px; border-radius:4px; font-weight:700; cursor:pointer;">⚠️ Instant Kill Opponent</button>
                        </div>
                        <div style="margin-bottom: 8px; display:flex; align-items:center; gap:8px;">
                            <span style="font-size:0.85rem; font-weight:600;">Damage Speed:</span>
                            <button class="dmg-spd-btn" data-spd="1" style="padding:4px 8px; border-radius:4px; border:1px solid #ccc; cursor:pointer; background:var(--flick-primary); color:#fff;">1x</button>
                            <button class="dmg-spd-btn" data-spd="10" style="padding:4px 8px; border-radius:4px; border:1px solid #ccc; cursor:pointer;">10x</button>
                            <button class="dmg-spd-btn" data-spd="100" style="padding:4px 8px; border-radius:4px; border:1px solid #ccc; cursor:pointer;">100x</button>
                            <button class="dmg-spd-btn" data-spd="1000" style="padding:4px 8px; border-radius:4px; border:1px solid #ccc; cursor:pointer;">1000x</button>
                            <button class="dmg-spd-btn" data-spd="10000" style="padding:4px 8px; border-radius:4px; border:1px solid #ccc; cursor:pointer;">10000x</button>
                        </div>
                        <div class="admin-summon-row">
                            <span class="admin-field-label">Summon:</span>
                            <input type="text" class="admin-summon-input" list="flickemon-species-list"
                                   placeholder="Name or #" autocomplete="off"/>
                            <datalist id="flickemon-species-list"></datalist>
                            <input type="number" class="admin-summon-lvl" min="1" max="100"
                                   placeholder="Lv" title="Level (defaults to your partner's)"/>
                            <label class="admin-shiny-toggle">
                                <input type="checkbox" class="admin-summon-shiny"/> Shiny
                            </label>
                            <button class="admin-summon-btn">Summon</button>
                        </div>
                        <p class="admin-summon-result"></p>

                        <div class="admin-summon-row">
                            <span class="admin-field-label">Mega Stone:</span>
                            <button class="admin-stone-btn">Give to partner</button>
                        </div>
                        <p class="admin-stone-result"></p>

                        <div class="admin-summon-row">
                            <span class="admin-field-label">EXP debt:</span>
                            <span class="admin-debt-state"></span>
                            <button class="admin-debt-btn">Clear</button>
                        </div>
                        <p class="admin-debt-result"></p>

                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-size:0.85rem; font-weight:600;">Set Level:</span>
                            <input type="number" class="admin-lvl-input" min="1" max="100" value="5" style="width:60px; padding:4px; border-radius:4px; border:1px solid #ccc; background:var(--flick-card-bg); color:var(--flick-text);"/>
                            <button class="admin-set-lvl-btn" style="background:var(--flick-primary); color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-weight:700;">Set Level</button>
                        </div>
                    </div>

                    <div style="background: rgba(239,68,68,0.06); padding: 12px; border-radius: 8px; margin-top: 12px;">
                        <h4 style="margin: 0 0 4px 0; color: var(--flick-danger);">⚠️ Danger Zone</h4>
                        <p style="margin: 0 0 10px 0; font-size: 0.75rem; color: var(--flick-text-muted);">
                            Wipes this student's party, Pokédex and study time on every signed-in device.
                            A snapshot is kept so it can be undone.
                        </p>
                        <button class="flickemon-danger-btn reset-progress-btn">RESET GAME PROGRESS</button>
                        <button class="admin-restore-btn" style="display:none; width:100%; margin-top:8px; padding:10px; background:transparent; border:2px solid var(--flick-success); color:var(--flick-success); font-weight:700; border-radius:4px; cursor:pointer; text-transform:uppercase; font-size:0.85rem;">Restore last snapshot</button>
                        <p class="admin-restore-note" style="margin:6px 0 0 0; font-size:0.7rem; color:var(--flick-text-muted);"></p>
                    </div>
                </div>
            </div>

            <!-- Attribution for the Pokémon material the game is built on. This is
                 the one screen every player can reach, so the notice lives here
                 rather than only in the repo. See LEGAL.md. -->
            <div class="flickemon-list-card flickemon-legal-card">
                <div class="flickemon-list-item">
                    <span class="flickemon-list-item-title">About &amp; legal</span>
                    <span class="flickemon-list-item-sub">
                        Flickémon is an unofficial, non-commercial fan project made by
                        students, free to play. It is not affiliated with, endorsed by, or
                        associated with Nintendo, Creatures Inc., GAME FREAK inc. or The
                        Pokémon Company.
                    </span>
                    <span class="flickemon-list-item-sub">
                        Pokémon and all related names, characters and artwork are the
                        trademarks and copyrighted works of their owners —
                        © 1995–2026 Nintendo / Creatures Inc. / GAME FREAK inc. — used
                        here without licence and with no claim of ownership.
                    </span>
                </div>
            </div>
        `;

        // Reset lives inside the admin panel now, so these elements exist but stay
        // hidden until the server confirms admin access.
        const resetBtn = modal.body.querySelector('.reset-progress-btn');
        const restoreBtn = modal.body.querySelector('.admin-restore-btn');
        const restoreNote = modal.body.querySelector('.admin-restore-note');

        /** Surfaces the snapshot taken before the last destructive action. */
        const refreshRestore = async () => {
            const backup = await this.engine.peekBackup();
            if (!backup) {
                restoreBtn.style.display = 'none';
                restoreNote.textContent = '';
                return;
            }
            restoreBtn.style.display = 'block';
            restoreNote.textContent = `Snapshot from ${new Date(backup.savedAt).toLocaleString()}`;
        };

        resetBtn.addEventListener('click', async () => {
            if (!confirm('Reset this student\'s Flickémon progress?\n\nParty, Pokédex and study time will be cleared on every signed-in device. A snapshot is kept so this can be undone.')) return;
            await this.engine.resetGameState();
            await refreshRestore();
            this.closeModal(modal.overlay);
        });

        restoreBtn.addEventListener('click', async () => {
            if (!confirm('Restore the last snapshot? This replaces current progress on every signed-in device.')) return;
            restoreBtn.disabled = true;
            restoreBtn.textContent = 'Restoring…';
            const ok = await this.engine.restoreBackup();
            if (ok) {
                this.closeModal(modal.overlay);
            } else {
                alert('No snapshot available to restore.');
                restoreBtn.disabled = false;
                restoreBtn.textContent = 'Restore last snapshot';
            }
        });

        // ── Cloud sync controls ──
        const statusLine = modal.body.querySelector('.sync-status-line');
        const signInBtn = modal.body.querySelector('.sync-signin-btn');
        const signOutBtn = modal.body.querySelector('.sync-signout-btn');
        const switchBtn = modal.body.querySelector('.sync-switch-btn');
        const forceSyncBtn = modal.body.querySelector('.force-sync-btn');

        const renderSyncStatus = async () => {
            const status = await this.engine.getSyncStatus();

            if (!status.configured) {
                statusLine.textContent = 'Not configured — see SETUP-SYNC.md';
                signInBtn.style.display = 'none';
                signOutBtn.style.display = 'none';
                switchBtn.style.display = 'none';
                forceSyncBtn.style.display = 'none';
                return;
            }

            if (!status.signedIn) {
                statusLine.textContent = 'Not signed in — progress stays on this device only';
                signInBtn.style.display = 'block';
                signOutBtn.style.display = 'none';
                switchBtn.style.display = 'none';
                forceSyncBtn.style.display = 'none';
                return;
            }

            statusLine.textContent = status.pending
                ? `Signed in as ${status.email} • offline, will sync later`
                : `Signed in as ${status.email} • synced`;
            signInBtn.style.display = 'none';
            signOutBtn.style.display = 'block';
            switchBtn.style.display = 'block';
            forceSyncBtn.style.display = 'block';
        };

        signInBtn?.addEventListener('click', async () => {
            signInBtn.disabled = true;
            signInBtn.textContent = 'Signing in…';
            try {
                await this.engine.signIn();
            } catch (err) {
                alert(`Sign-in failed: ${err.message}`);
            } finally {
                signInBtn.disabled = false;
                signInBtn.textContent = 'Sign in with Google';
                renderSyncStatus();
            }
        });

        switchBtn?.addEventListener('click', async () => {
            switchBtn.disabled = true;
            switchBtn.textContent = 'Switching…';
            try {
                await this.engine.switchAccount();
            } catch (err) {
                alert(err.message);
            } finally {
                switchBtn.disabled = false;
                switchBtn.textContent = 'Switch account';
                renderSyncStatus();
            }
        });

        signOutBtn?.addEventListener('click', async () => {
            await this.engine.signOut();
            renderSyncStatus();
        });

        forceSyncBtn?.addEventListener('click', async () => {
            const original = '☁️ SYNC NOW';
            forceSyncBtn.disabled = true;
            forceSyncBtn.textContent = 'Syncing…';
            const success = await this.engine.forceCloudSync();
            forceSyncBtn.textContent = success ? '✅ SYNCED' : '❌ SYNC FAILED';
            forceSyncBtn.style.background = success ? '#059669' : '#ef4444';
            setTimeout(() => {
                forceSyncBtn.disabled = false;
                forceSyncBtn.textContent = original;
                forceSyncBtn.style.background = '#10b981';
                renderSyncStatus();
            }, 2000);
        });

        renderSyncStatus();

        const unlockBtn = modal.body.querySelector('.unlock-admin-btn');
        const unlockNote = modal.body.querySelector('.admin-unlock-note');
        const adminPanel = modal.body.querySelector('.admin-unlocked-panel');

        // Admin status is decided by the server (a doc at admins/{uid} that no
        // client can create), not by a secret shipped inside the extension.
        unlockBtn.addEventListener('click', async () => {
            unlockBtn.disabled = true;
            unlockBtn.textContent = 'Checking…';
            try {
                if (await this.engine.isAdmin()) {
                    adminPanel.style.display = 'block';
                    unlockBtn.style.display = 'none';
                    unlockNote.style.display = 'none';
                    refreshRestore();
                    return;
                }
                const status = await this.engine.getSyncStatus();
                unlockNote.textContent = status.signedIn
                    ? `${status.email} is not an administrator.`
                    : 'Sign in first — admin access is tied to your account.';
                unlockNote.style.color = 'var(--flick-danger)';
            } catch {
                unlockNote.textContent = 'Could not verify admin access. Check your connection.';
                unlockNote.style.color = 'var(--flick-danger)';
            } finally {
                unlockBtn.disabled = false;
                unlockBtn.textContent = 'Unlock admin tools';
            }
        });

        adminPanel.querySelector('.admin-kill-btn').addEventListener('click', () => {
            this.engine.adminInstantKillOpponent();
        });

        adminPanel.querySelectorAll('.dmg-spd-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const spd = parseInt(btn.getAttribute('data-spd'), 10);
                this.engine.adminSetDamageMultiplier(spd);
                adminPanel.querySelectorAll('.dmg-spd-btn').forEach(b => {
                    b.style.background = 'transparent';
                    b.style.color = 'var(--flick-text)';
                });
                btn.style.background = 'var(--flick-primary)';
                btn.style.color = '#fff';
            });
        });

        // 1,025 <option>s is a lot of DOM for a panel most students never open,
        // but a datalist gets native type-ahead for free and the panel is built
        // only after an admin check has already passed.
        const speciesList = adminPanel.querySelector('#flickemon-species-list');
        if (speciesList) {
            speciesList.innerHTML = [
                // Custom ones first: a roster of three is far more likely to be
                // what an admin is reaching for than dex entry 412.
                ...this.config.customRoster().map(sp => `<option value="${sp.name}">custom</option>`),
                ...this.config.POKEMON_REGISTRY.map(sp => `<option value="${sp.name}">#${sp.id}</option>`),
            ].join('');
        }

        const summonBtn = adminPanel.querySelector('.admin-summon-btn');
        const summonResult = adminPanel.querySelector('.admin-summon-result');
        summonBtn?.addEventListener('click', async () => {
            const raw = (adminPanel.querySelector('.admin-summon-input').value || '').trim();
            const lvlRaw = adminPanel.querySelector('.admin-summon-lvl').value;
            const shiny = adminPanel.querySelector('.admin-summon-shiny').checked;
            if (!raw) return;

            // Accept a dex number, "#25", or a name in any casing. By name
            // this reaches the custom roster too, which is how a homemade
            // Pokemon gets into a game without being marked `wild`.
            const byNumber = Number(raw.replace(/^#/, ''));
            const species = Number.isFinite(byNumber) && byNumber > 0
                ? this.config.getSpeciesById(byNumber)
                : this.config.getSpeciesByName(raw);

            if (!species) {
                summonResult.textContent = `No Pokémon called "${raw}".`;
                summonResult.className = 'admin-summon-result bad';
                return;
            }

            const res = await this.engine.adminSummonOpponent(species.id, {
                shiny,
                level: lvlRaw ? Number(lvlRaw) : undefined,
            });
            summonResult.textContent = res.ok
                ? `${res.shiny ? 'Shiny ' : ''}${res.species.name} (Lv.${res.level}) is now the opponent.`
                : 'Could not summon that.';
            summonResult.className = `admin-summon-result ${res.ok ? 'good' : 'bad'}`;
        });

        // Gives the active partner the next stone its line can hold, and plays
        // the transformation when the stone is one it can actually use — the
        // same scene a 10% PVP win produces.
        const stoneBtn = adminPanel.querySelector('.admin-stone-btn');
        const stoneResult = adminPanel.querySelector('.admin-stone-result');
        // Shown live, because the number is the entire point of the control:
        // an admin needs to see whether a debt is outstanding before clearing it.
        const debtState = adminPanel.querySelector('.admin-debt-state');
        const debtResult = adminPanel.querySelector('.admin-debt-result');
        const debtBtn = adminPanel.querySelector('.admin-debt-btn');

        const refreshDebt = () => {
            const owed = this.engine.getExpDebt();
            if (debtState) {
                debtState.textContent = owed > 0
                    ? `${owed} win${owed === 1 ? '' : 's'} with no EXP`
                    : 'none owed';
                debtState.className = `admin-debt-state ${owed > 0 ? 'owing' : ''}`;
            }
            if (debtBtn) debtBtn.disabled = owed === 0;
        };
        refreshDebt();

        debtBtn?.addEventListener('click', async () => {
            const res = await this.engine.adminClearExpDebt();
            debtResult.textContent = res.cleared > 0
                ? `Cleared ${res.cleared} win${res.cleared === 1 ? '' : 's'} of debt.`
                : 'There was no debt to clear.';
            debtResult.className = `admin-debt-result ${res.cleared > 0 ? 'good' : ''}`;
            refreshDebt();
        });

        stoneBtn?.addEventListener('click', async () => {
            const before = this.engine.getActivePokemon();
            const res = await this.engine.adminGrantMegaStone();

            if (!res.ok) {
                stoneResult.textContent =
                    res.reason === 'nobody' ? 'No active partner to give it to.'
                    : res.reason === 'maxed' ? 'Your partner already holds every stone its line can.'
                    : 'Nothing in your partner\'s line has a Mega form.';
                stoneResult.className = 'admin-stone-result bad';
                return;
            }

            stoneResult.textContent = res.dormant
                ? `${res.holder} received ${res.form.stone} — dormant until it fully evolves.`
                : `${res.holder} received ${res.form.stone}.`;
            stoneResult.className = 'admin-stone-result good';

            if (res.scene && before) {
                this.showMegaOverlay(res.form, {
                    speciesId: before.speciesId, shiny: before.shiny === true,
                });
            }
        });

        adminPanel.querySelector('.admin-set-lvl-btn').addEventListener('click', async () => {
            const lvl = parseInt(adminPanel.querySelector('.admin-lvl-input').value, 10);
            if (lvl >= 1 && lvl <= 100) {
                await this.engine.adminSetPokemonLevel(lvl);
            }
        });
    }

    // ────────────────────────── Music ──────────────────────────

    /** One player for the whole page; the modal and the mini-bar both drive it. */
    getMusic() {
        if (!this.music && window.FlickemonMusic) {
            this.music = new window.FlickemonMusic();
            // Any change repaints the bar, wherever the widget currently is.
            this.music.onChange(() => this.renderMusicBar());
        }
        return this.music;
    }

    /** The strip inside the widget: what is playing, and enough to control it. */
    renderMusicBar(card = this.widgetCard) {
        if (!card || !card.querySelector) return;
        const bar = card.querySelector('.music-bar');
        if (!bar) return;

        const music = this.music;           // not getMusic: never create one just to draw
        const st = music && music.getState();
        if (!st || (!st.playing && !st.ready && !st.blocked)) {
            bar.setAttribute('hidden', '');
            bar.innerHTML = '';
            return;
        }
        bar.removeAttribute('hidden');

        if (st.blocked) {
            bar.innerHTML = `<span class="music-bar-blocked">Music blocked by this page</span>
                <button class="music-bar-btn music-bar-open" title="Details">Details</button>`;
        } else {
            bar.innerHTML = `
                <button class="music-bar-btn music-bar-toggle" title="${st.playing ? 'Pause' : 'Play'}">
                    ${st.playing ? '❚❚' : '▶'}
                </button>
                <button class="music-bar-btn music-bar-next" title="Next track">⏭</button>
                <span class="music-bar-title" title="${st.track ? st.track.title : ''}">${st.track ? st.track.title : ''}</span>
                <button class="music-bar-btn music-bar-open" title="Open the player">⋯</button>`;
        }

        bar.querySelector('.music-bar-toggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.getMusic().toggle();
        });
        bar.querySelector('.music-bar-next')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.getMusic().next();
        });
        bar.querySelector('.music-bar-open')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openMusicModal();
        });
    }

    openMusicModal() {
        const modal = this.createModalOverlay('Music');
        modal.overlay.classList.add('music-overlay');
        const music = this.getMusic();

        if (!music) {
            modal.body.innerHTML = `<div class="music-empty">
                <p class="music-empty-title">Music unavailable</p>
                <p>The player did not load. Reload the extension and try again.</p>
            </div>`;
            return;
        }

        const draw = () => {
            const st = music.getState();

            // A redraw replaces the whole body, which would send the playlist
            // back to the top mid-scroll when a track changes. Carry the
            // scroll position across.
            const before = modal.body.querySelector('.music-list');
            const listTop = before ? before.scrollTop : 0;

            if (!st.count) {
                modal.body.innerHTML = `<div class="music-empty">
                    <p class="music-empty-title">No music yet</p>
                    <p>Paste YouTube links into <code>content/flickemon-playlist.js</code>,
                    reload the extension, then refresh this page.</p>
                    <p class="music-empty-hint">Any YouTube link works — a video, a share link,
                    or a whole playlist.</p>
                </div>`;
                return;
            }

            modal.body.innerHTML = `
                <div class="music">
                    ${st.blocked ? `
                        <div class="music-blocked">
                            <p class="music-blocked-title">This page is blocking the player</p>
                            <p>Flick's own security policy decides which sites may be embedded,
                            and YouTube is not on its list. Nothing here can override that —
                            it is the page's call, not the extension's.</p>
                        </div>` : ''}

                    <div class="music-now">
                        <span class="music-now-label">Now playing</span>
                        <h3 class="music-now-title">${st.track ? st.track.title : '—'}</h3>
                    </div>

                    <div class="music-controls">
                        <button class="music-btn music-prev" title="Previous">⏮</button>
                        <button class="music-btn music-play primary" title="${st.playing ? 'Pause' : 'Play'}">
                            ${st.playing ? '❚❚' : '▶'}
                        </button>
                        <button class="music-btn music-next" title="Next">⏭</button>
                        <button class="music-btn music-stop" title="Stop and unload">■</button>
                    </div>

                    <label class="music-volume">
                        <span>Volume</span>
                        <input type="range" class="music-volume-input" min="0" max="100" value="${st.volume}"/>
                        <span class="music-volume-value">${st.volume}</span>
                    </label>

                    <ol class="music-list">
                        ${music.tracks.map((t, i) => `
                            <li class="music-track ${i === st.index && !st.battle ? 'current' : ''}" data-i="${i}">
                                <span class="music-track-n">${i + 1}</span>
                                <span class="music-track-title">${t.title}</span>
                                ${t.listId && !t.videoId ? '<span class="music-track-tag">playlist</span>' : ''}
                                ${i === st.index && st.playing && !st.battle ? '<span class="music-track-eq">♪</span>' : ''}
                            </li>`).join('')}
                    </ol>

                    ${st.badEntries.length ? `
                        <div class="music-bad">
                            <p><strong>${st.badEntries.length} line${st.badEntries.length > 1 ? 's' : ''}
                            could not be read</strong> — only YouTube links work here.</p>
                            <ul>${st.badEntries.map(b => `<li><code>${b}</code></li>`).join('')}</ul>
                        </div>` : ''}

                    <div class="music-fallback">
                        <button class="music-btn-wide music-tab">Open the player in its own tab</button>
                        <p>If the player will not start on this page, run it as a pinned tab
                        instead. Nothing the lecture site does can reach it there, and a click
                        inside that tab is the user gesture browsers require before playing
                        audio. It still stops when a lecture starts.</p>
                    </div>

                    <p class="music-note">Music stops the moment a lecture starts playing, and does
                    not resume on its own. It keeps playing while you browse the site.</p>
                </div>`;

            const list = modal.body.querySelector('.music-list');
            if (list) list.scrollTop = listTop;

            modal.body.querySelector('.music-play')?.addEventListener('click', () => music.toggle());
            modal.body.querySelector('.music-next')?.addEventListener('click', () => music.next());
            modal.body.querySelector('.music-prev')?.addEventListener('click', () => music.previous());
            modal.body.querySelector('.music-stop')?.addEventListener('click', () => music.stop());
            modal.body.querySelector('.music-tab')?.addEventListener('click', () => {
                music.openInTab();
                this.closeModal(modal.overlay);
            });

            const vol = modal.body.querySelector('.music-volume-input');
            vol?.addEventListener('input', () => {
                const v = Number(vol.value);
                music.volume = v;                                  // no redraw mid-drag
                music.command('setVolume', [v]);
                const out = modal.body.querySelector('.music-volume-value');
                if (out) out.textContent = String(v);
            });
            vol?.addEventListener('change', () => music.setVolume(Number(vol.value)));

            modal.body.querySelectorAll('.music-track').forEach(li => {
                li.addEventListener('click', () => music.play(Number(li.dataset.i)));
            });
        };

        draw();
        // Keep the modal honest while it is open, then stop listening.
        const off = music.onChange(() => { if (modal.overlay.parentNode) draw(); else off(); });
    }

    /**
     * Says that time studied elsewhere was just counted, and at what rate.
     *
     * A student who is not told will read the discount as a bug: they watched an
     * hour on the phone and their Pokemon moved by eighteen minutes' worth. The
     * rate is only defensible if it is visible, so this says both numbers.
     */
    showFlickCredit(result) {
        if (!result || !(result.credited > 0)) return;
        const wrapper = document.querySelector('.flickemon-widgets-wrapper');
        if (!wrapper) return;

        // One at a time: two harvests in quick succession should replace the
        // notice, not stack a column of them down the page.
        const existing = wrapper.querySelector('.flick-credit');
        if (existing) existing.remove();

        // Coming back to the game is a different moment from a phone playing in
        // the next room, and deserves different words. Twenty minutes is the
        // line: below it this is a trickle nobody left the room for.
        const away = result.awayMinutes || 0;
        const returning = away >= 20;
        const dur = m => m >= 60
            ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
            : `${Math.max(1, Math.round(m))}m`;

        // Species names are usually from the registry, but a player-drawn one
        // in flickemon-custom.js is whatever its author typed.
        const esc = t => String(t == null ? '' : t)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const p = result.partner;
        const el = document.createElement('div');
        el.className = 'flick-credit' + (returning ? ' is-return' : '');

        if (returning) {
            // The headline is the studying, not the discount. A student who
            // watched two hours on the bus did two hours of work, and being
            // told the game only counted part of it is a footnote to that,
            // not the news.
            const bits = [];
            if (p && p.evolvedInto) bits.push(`<b>${esc(p.evolvedInto)}</b> evolved`);
            else if (p && p.levelsGained > 0) {
                bits.push(`<b>${esc(p.name)}</b> reached <b>Lv.${p.level}</b>`);
            } else if (p) bits.push(`<b>${esc(p.name)}</b> gained <b>${result.exp} EXP</b>`);

            el.innerHTML = `
                <span class="flick-credit-mark">✦</span>
                <span class="flick-credit-text">
                    <b>While you were away</b>
                    <span class="flick-credit-line">${dur(result.rawMinutes)} studied on Flick
                        ${p && p.levelsGained > 0 ? ` &middot; +${result.exp} EXP` : ''}</span>
                    ${bits.length ? `<span class="flick-credit-line">${bits[0]}</span>` : ''}
                    <small>Counted at ${Math.round(this.config.FLICK_CREDIT_RATE * 100)}% —
                        watching here is worth more</small>
                </span>`;
        } else {
            const mins = Math.max(1, Math.round(result.credited));
            const from = Math.max(1, Math.round(result.rawMinutes || result.credited));
            el.innerHTML = `
                <span class="flick-credit-mark">✦</span>
                <span class="flick-credit-text">
                    <b>+${mins} min</b> counted from Flick
                    <small>${from} min watched elsewhere, at ${
                        Math.round(this.config.FLICK_CREDIT_RATE * 100)}%${
                        result.exp > 0 ? ` &middot; +${result.exp} EXP` : ''}</small>
                </span>`;
        }

        wrapper.appendChild(el);

        // A summary of a whole afternoon is worth reading twice; a one-line
        // trickle is not.
        const life = returning ? 16000 : 7000;
        setTimeout(() => el.classList.add('is-leaving'), life);
        setTimeout(() => el.remove(), life + 600);
    }

    // ────────────────────────── How to Play ──────────────────────────

    /**
     * The rules, in one place.
     *
     * Every number is read from FlickemonConfig at render time rather than
     * written out here, so tuning the game cannot leave the guide quietly
     * lying about it. The hour figures come from BALANCE_REFERENCE, which is
     * measured against the real engine and re-checked by tests/test_guide.js.
     */
    openGuideModal() {
        const modal = this.createModalOverlay('How to Play');
        modal.overlay.classList.add('guide-overlay');
        const c = this.config;

        const pct = n => `${(n * 100).toFixed(n < 0.01 ? 2 : 0)}%`;
        const oneIn = n => `1 in ${Math.round(1 / n).toLocaleString()}`;
        const mins = ms => Math.round(ms / 60000);
        const bal = c.BALANCE_REFERENCE;

        const section = (title, body) => `
            <section class="guide-section">
                <h3 class="guide-h">${title}</h3>
                ${body}
            </section>`;

        const rows = pairs => `<dl class="guide-rows">${pairs
            .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

        // Rendered from ENCOUNTER_STAGE_WEIGHTS rather than written out, so
        // retuning the table cannot leave this paragraph quietly wrong.
        const stageWord = { 1: 'first forms', 2: 'middle forms', 3: 'final forms' };
        const encounterMix = tier => (c.ENCOUNTER_STAGE_WEIGHTS[tier] || [])
            .map(w => `${pct(w.weight)} ${stageWord[w.stage] || `stage ${w.stage}`}`)
            .join(', ');

        // Mega lives on its own branch for now. Render the section only when
        // the data is actually present, so this guide never describes a feature
        // the running build does not have.
        const megaForms = c.MEGA_FORMS || null;
        const boost = c.MEGA_STAT_BOOST || {};
        const megaBlock = megaForms ? section('Mega Evolution', `
            <p>Some Pokémon can Mega Evolve: a different sprite, a different name,
            and more power. What that power is depends on where you are fighting.</p>
            ${rows([
                ['While studying', `Toggle it on in Party and your partner deals
                    <strong>${c.MEGA_DAMAGE_MULTIPLIER}x damage</strong> to wild Pokémon
                    for as long as it is on. Permanent — it is yours once won.`],
                ['In PVP', `Press <strong>MEGA EVOLVE</strong> during the battle, then pick
                    your move. It transforms before either side attacks, and stays that way
                    until the battle ends. <strong>Once per battle</strong>, so the timing
                    is the decision.`],
                ['What it gives you', `Attack x${boost.attack}, Defense x${boost.defense},
                    Speed x${boost.speed}. <strong>HP never changes</strong> — no mega in any
                    Pokémon game heals on transforming, and one that did would be a mega
                    worth saving until you were nearly dead.`],
                ['How to get one', `Winning a PVP battle has a ${pct(c.MEGA_STONE_CHANCE)} chance of dropping a stone.`],
                ['Who it belongs to', 'The individual Pokémon that won it, not the species.'],
                ['Forms', `${Object.values(megaForms).reduce((n, f) => n + f.length, 0)} across ${Object.keys(megaForms).length} species.`],
            ])}
            <p class="guide-note">Types are untouched either way, so a Mega does not change
            what it is strong or weak against, or how fast it levels.</p>`) : '';

        modal.body.innerHTML = `
            <div class="guide">
                <p class="guide-lead">Watch lectures, your partner gets stronger. That is the
                whole game — everything below is detail.</p>

                ${section('Study time', `
                    <p>EXP comes from <strong>time actually spent watching</strong>, not from
                    video position. Playing at 2x or 10x earns exactly the same as 1x, and
                    skipping ahead earns nothing: the clock only runs while a video is playing.</p>
                    <p>Time from every device you sign in on is added together.</p>`)}

                ${section('Battles', `
                    <p>A wild Pokémon appears and your partner wears it down. Every battle
                    takes about <strong>${bal.battleMinutes} minutes</strong> of watching, whatever
                    its level — a stronger opponent is not slower, just worth more.</p>
                    ${rows([
                        ['Capture mode', `A defeated Pokémon joins your party ${pct(c.CAPTURE_CHANCE)} of the time. ${c.BATTLE_WIN_EXP_BONUS}x EXP per win either way.`],
                        ['EXP mode', `No ordinary captures, but ${c.EXP_MODE_WIN_EXP_BONUS}x EXP — about twice as fast.`],
                        ['Shinies and legendaries', 'Always caught, in either mode, and they never flee.'],
                        ['Escapes', `A Pokémon ${4}+ levels above you flees after 90 seconds, leaving ${pct(c.ESCAPE_EXP_MULTIPLIER)} EXP.`],
                        ['Catch now', `Skips the fight and the roll. Costs the EXP from your next ${c.INSTANT_CAPTURE_EXP_DEBT} wins.`],
                    ])}
                    <p>Who you meet depends on how far your partner has come — the world
                    grows up with it.</p>
                    ${rows([
                        ['Partner on its first form', encounterMix(c.ENCOUNTER_TIERS.BASIC)],
                        ['Partner on its middle form', encounterMix(c.ENCOUNTER_TIERS.MIDDLE)],
                        ['Partner fully evolved', encounterMix(c.ENCOUNTER_TIERS.FINAL)],
                    ])}
                    <p class="guide-note">A win that does not end in a capture is still a win —
                    the EXP is the same. <strong>Catch now</strong> appears on the battle box in
                    capture mode; while you are paying for one, catching carries on working
                    normally, including the ${pct(c.CAPTURE_CHANCE)} roll. Switch modes any time
                    from the widget header.</p>`)}

                ${section('Levelling and evolution', `
                    <p>Evolution is by level: <strong>Lv.${c.EVOLUTION_LEVELS.stage1ToStage2}</strong>
                    for the first stage and <strong>Lv.${c.EVOLUTION_LEVELS.stage2ToStage3}</strong>
                    for the second. The ceiling is Lv.${c.MAX_LEVEL}.</p>
                    ${rows([
                        ['Fully evolved', `about ${bal.fullyEvolvedHours.capture} hours in capture mode, ${bal.fullyEvolvedHours.exp} in EXP mode`],
                        [`Level ${c.MAX_LEVEL}`, `about ${bal.maxLevelHours.capture} hours in capture mode, ${bal.maxLevelHours.exp} in EXP mode`],
                    ])}
                    <p class="guide-block"><strong>One block, one fully evolved Pokémon.</strong>
                    A block of a medical subject averages around ${bal.blockHours} hours of
                    recordings — so watching a block through gets a starter to its final form
                    in capture mode, or two of them in EXP mode.</p>
                    <p class="guide-note">The middle levels are the long part. The last few are
                    quick, because wild Pokémon scale up with you.</p>`)}

                ${section('Your team', `
                    <p>Up to <strong>${c.MAX_TEAM_SIZE}</strong> Pokémon, your partner always among
                    them. Everyone else on the team earns <strong>${pct(c.TEAM_EXP_SHARE)}</strong>
                    of what your partner earns, and evolves in their own right.</p>
                    <p>Catching a species you already own gives you a <strong>second, separate
                    Pokémon</strong> — both keep their own level, and both can battle.</p>`)}

                ${section('Rare encounters', `
                    ${rows([
                        ['Shiny', `${oneIn(c.SHINY_CHANCE)} encounters — different colours, identical stats.`],
                        ['Legendary', 'about 1 in 100, and only once your partner reaches Lv.40.'],
                    ])}
                    <p class="guide-note">Both are cosmetic. A shiny fights exactly like any other
                    of its species; the point is that it is rare and it is yours.</p>`)}

                ${section('PVP', `
                    <p>Share your 6-digit code with another trainer. Turn-based, with real type
                    matchups, and no items.</p>
                    ${rows((c.PVP_MODES || []).map(m => [m.label, `${m.blurb} Reward lasts ${m.rewardLabel}.`]))}
                    <p><strong>Winning</strong> grants one of three boosts at random:</p>
                    ${rows(Object.values(c.REWARDS || {}).map(k => {
                        const info = c.REWARD_INFO[k];
                        return [`${info.icon} ${info.label}`, info.detail];
                    }))}
                    <p class="guide-note">Only one boost runs at a time, and a second win while
                    it is running grants nothing. That is deliberate: the way to use a boost is
                    to go back to a lecture, not to queue for another match.
                    ${c.PVP_LOSS_LOCKOUT_MS ? `Losing costs you ${mins(c.PVP_LOSS_LOCKOUT_MS)} minutes of prizes — you can
                    still battle, but nothing pays out until that runs down.` : ''}</p>`)}

                ${section('Trading', `
                    <p>The same 6-digit code. Both trainers put one Pokémon on the table, both
                    see both offers, and nothing moves until both confirm. Changing your offer
                    clears both confirmations.</p>
                    <p class="guide-note">Your last Pokémon is never tradable. Trade with people
                    you know — nothing here can verify that the other side is playing fairly.</p>`)}

                ${megaBlock}

                ${section('Friends', `
                    <p>Add people by username or their @docchula.com email, and see what
                    they have studied today. Everything shown is <strong>game progress</strong> —
                    EXP earned, levels gained, a streak — and <strong>never how long anyone
                    studied</strong>. Hours reward sitting still; this does not.</p>
                    ${rows([
                        ['Who sees you', 'Only people you accepted. A request has to be agreed.'],
                        ['What they see', `You choose, under Friends → Privacy:
                            ${c.FRIEND_FIELDS.map(f => f.label.toLowerCase()).join(', ')}.`],
                        ['Turning something off', `It stops being <b>sent</b>, not just shown.
                            Anything switched off never leaves your device at all.`],
                        ['Streaks', 'Days in a row with any progress. Yesterday still counts today, so a streak never breaks before you have had the chance to study.'],
                        ['The day', 'Resets at midnight Bangkok time, the same moment for everyone.'],
                    ])}
                    <p class="guide-note">The <b>global board</b> is separate and off unless you
                    join it. Joining shows your username — or the first three letters of your
                    email if you have not set one — with today's EXP and your streak, to every
                    signed-in student. Nothing else, and leaving removes your row entirely.</p>`)}

                ${section('Your progress', `
                    <p>Everything is saved to your account and follows you to any device you sign
                    in on. Progress is kept locally as well, so a lost connection costs nothing.</p>
                    <p>Watching on your <b>phone, or any device without the extension</b>, still
                    counts. Flick keeps its own record of how far through each lecture you are,
                    and Flickémon reads it the next time you open that course here — so a session
                    on the bus is not lost.</p>
                    ${rows([
                        ['What it is worth', `${pct(c.FLICK_CREDIT_RATE)} of the same time watched
                            with the extension open. Flick records where you got <i>to</i>, not
                            how long you sat there, so skipping to the end of a lecture would
                            otherwise read as having watched all of it.`],
                        ['EXP only', 'No money and no catches — those need a battle you were actually here for.'],
                        ['Rewatching', 'Earns nothing until you pass where you got to before. It is progress that counts, not replays.'],
                        ['The ceiling', 'You can never be credited more than the time that has genuinely passed since Flickémon last looked.'],
                    ])}`)}
            </div>`;
    }

    // ────────────────────────── Support ──────────────────────────

    openSupportModal() {
        const modal = this.createModalOverlay('Support the Creator');
        modal.overlay.classList.add('support-overlay');

        const qrUrl = this.config.getAssetUrl
            ? this.config.getAssetUrl('icons/promptpay-qr.png')
            : 'icons/promptpay-qr.png';

        modal.body.innerHTML = `
            <div class="support">
                <p class="support-lead">Flickémon is free, and there is nothing to buy in it.
                It will stay that way.</p>

                <div class="support-qr-wrap">
                    <img class="support-qr" src="${qrUrl}" alt="PromptPay QR code"/>
                    <div class="support-qr-missing" hidden>
                        <p>QR code not added yet.</p>
                        <p class="support-qr-hint">Drop a PromptPay QR image at
                        <code>icons/promptpay-qr.png</code>.</p>
                    </div>
                </div>
                <p class="support-qr-caption">Scan with any Thai banking app</p>

                <div class="support-why">
                    <h3>Where it goes</h3>
                    <p>Two things, and only these two:</p>
                    <ul>
                        <li><strong>Running costs.</strong> The database is on a free tier today.
                        If enough students play, it stops being free.</li>
                        <li><strong>Building the next one.</strong> AI tooling is what makes it
                        possible for one student to build something like this at all — and the
                        more of it there is, the more our faculty gets.</li>
                    </ul>
                    <p class="support-note">Give nothing and lose nothing: every feature is
                    already yours. This only decides how much comes next.</p>
                </div>
            </div>`;

        // A missing QR should read as "not set up yet", not a broken image.
        const img = modal.body.querySelector('.support-qr');
        const fallback = modal.body.querySelector('.support-qr-missing');
        if (img && fallback) {
            img.addEventListener('error', () => {
                img.setAttribute('hidden', '');
                fallback.removeAttribute('hidden');
                const cap = modal.body.querySelector('.support-qr-caption');
                if (cap) cap.setAttribute('hidden', '');
            });
        }
    }

    // ────────────────────────── Evolution Overlay ──────────────────────────

    /**
     * True while the page is in real fullscreen (the video player's expand
     * button). The webkit-prefixed property is checked too: some players still
     * request fullscreen through the old API, and Chrome only mirrors the state
     * onto the property that was used.
     */
    /**
     * What a Pokémon still has to do before a held stone works.
     *
     * Naming the form it is waiting for is the difference between "some day"
     * and "get this to Charizard". The already-fully-evolved branch should be
     * unreachable — a stone is only dormant because a later form owns it — but
     * saying "reaches its final form" to something that is already there would
     * be nonsense, so it is handled rather than assumed away.
     */
    megaUnlockHint(member) {
        if (this.config.isFullyEvolved(member.speciesId)) {
            return 'can use it — this stone belongs to a different form';
        }
        const finalSpecies = this.config.getSpeciesById(this.config.finalFormOf(member.speciesId));
        return finalSpecies ? `evolves into ${finalSpecies.name}` : 'reaches its final form';
    }

    /** Sprite id for a wild opponent — the mega form when one was summoned. */
    wildSpriteId(wild) {
        if (!wild) return null;
        const form = this.wildMegaForm(wild);
        return form ? form.spriteId : wild.wildSpecies.id;
    }

    wildMegaForm(wild) {
        if (!wild || !wild.megaForm) return null;
        return this.config.megaFormsFor(wild.wildSpecies.id)
            .find(f => f.key === wild.megaForm) || null;
    }

    wildMegaName(wild) {
        const form = this.wildMegaForm(wild);
        return form ? form.name : 'Mega';
    }

    isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    /**
     * The Fullscreen API paints only the fullscreen element's own subtree, so an
     * overlay appended to <body> during playback is composited *behind* the
     * video and never seen — the evolution would silently pass by. Rather than
     * inject into the player (whose DOM is not ours and gets rebuilt), hold the
     * evolution and replay it the moment fullscreen ends.
     */
    watchFullscreen() {
        const onChange = () => {
            if (this.isFullscreen()) this.suspendEvolutionOverlay();
            else this.drainEvolutionQueue();
        };
        document.addEventListener('fullscreenchange', onChange);
        document.addEventListener('webkitfullscreenchange', onChange);
    }

    /**
     * Going (back) into fullscreen mid-animation would hide the rest of it, so
     * the evolution goes back to the front of the queue and replays in full on
     * exit. Only re-queues — it never starts anything — so toggling fullscreen
     * repeatedly can't loop.
     */
    suspendEvolutionOverlay() {
        if (!this.currentEvolution) return;
        const { evo, cancel } = this.currentEvolution;
        cancel();
        this.currentEvolution = null;
        this.evolutionPlaying = false;
        this.pendingEvolutions.unshift({ ...evo, deferred: true });
    }

    showEvolutionOverlay(evo) {
        this.pendingEvolutions.push({ ...evo, deferred: this.isFullscreen() });
        if (this.isFullscreen()) return;   // watchFullscreen replays it on exit
        this.drainEvolutionQueue();
        // Several team members can cross a threshold on the same battle tick,
        // which queues them after the first overlay has already rendered its
        // count. Correct it rather than under-reporting the backlog.
        this.refreshQueueBadge();
    }

    /** Keeps the "+N more" line honest while an overlay is already on screen. */
    refreshQueueBadge() {
        const el = this.currentOverlayEl && this.currentOverlayEl.querySelector
            ? this.currentOverlayEl.querySelector('.evo-queue')
            : null;
        if (!el) return;
        const queued = this.pendingEvolutions.length;
        el.textContent = `+${queued} more`;
        if (queued > 0) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    }

    /**
     * Queues the mega transformation scene.
     *
     * `form` is a MEGA_FORMS entry; `member` is the party member wearing it, or
     * a {speciesId, shiny} shaped stand-in for an admin-summoned wild.
     */
    showMegaOverlay(form, member) {
        if (!form || !member) return;
        const species = this.config.getSpeciesById(member.speciesId);
        if (!species) return;
        this.showEvolutionOverlay({
            kind: 'mega',
            form,
            species,
            shiny: member.shiny === true,
        });
    }

    /**
     * Plays queued evolutions one at a time. A long fullscreen session can bank
     * several, and overlapping five-second takeovers would be unreadable.
     */
    drainEvolutionQueue() {
        if (this.evolutionPlaying || this.isFullscreen()) return;
        const evo = this.pendingEvolutions.shift();
        if (!evo) return;

        this.evolutionPlaying = true;
        // One queue, two scenes. Megas and evolutions share the fullscreen
        // suspend/replay machinery because the problem is identical, but they
        // are different animations and must not overlap each other either.
        const play = evo.kind === 'mega' ? this.playMegaOverlay
                   : evo.kind === 'hatch' ? this.playHatchOverlay
                   : this.playEvolutionOverlay;
        const cancel = play.call(this, evo, () => {
            this.currentEvolution = null;
            this.currentOverlayEl = null;
            this.evolutionPlaying = false;
            this.drainEvolutionQueue();
        });
        this.currentEvolution = { evo, cancel };
    }

    /**
     * Renders one evolution; calls `done` when it is dismissed or times out.
     * Returns an abort function that tears the overlay down *without* advancing
     * the queue, for when fullscreen resumes.
     *
     * The sequence is driven entirely by CSS animation-delays (see the timeline
     * in styles.css) so there is only one timer here: the one that ends it.
     */
    playEvolutionOverlay(evo, done) {
        const overlay = document.createElement('div');
        overlay.className = 'evolution-overlay-screen';

        const queued = this.pendingEvolutions.length;
        // The listener is handed bare {id, name}; the registry has the rest.
        const toSpecies = this.config.getSpeciesById(evo.to.id) || evo.to;
        const fromSpecies = this.config.getSpeciesById(evo.from.id) || evo.from;

        overlay.innerHTML = `
            <div class="evo-flash"></div>
            <div class="evo-box">
                ${evo.deferred ? '<p class="evo-deferred">While you were watching…</p>' : ''}
                ${evo.benched ? '<p class="evo-benched">On your team</p>' : ''}
                <p class="evo-lead">What? <b>${evo.from.name}</b> is evolving!</p>
                <div class="evo-stage">
                    <div class="evo-rays"></div>
                    <div class="evo-ring evo-ring-1"></div>
                    <div class="evo-ring evo-ring-2"></div>
                    <div class="evo-ring evo-ring-3"></div>
                    <div class="evo-burst"></div>
                    <div class="evo-morph">
                        <img src="${this.config.getSpriteUrl(evo.from.id, evo.shiny)}" alt="${evo.from.name}" class="old-sprite"/>
                        <img src="${this.config.getSpriteUrl(evo.to.id, evo.shiny)}" alt="${evo.to.name}" class="new-sprite"/>
                    </div>
                    <div class="evo-particles">${this.renderEvolutionSparks()}</div>
                </div>
                <div class="evo-outcome">
                    <p class="evo-desc">${evo.from.name} evolved into <b>${evo.to.name}</b>!</p>
                    ${toSpecies.types
                        ? `<div class="types-row">${toSpecies.types.map(t => `<span class="type-pill ${t}">${t}</span>`).join('')}</div>`
                        : ''}
                    ${this.renderEvolutionGains(fromSpecies, toSpecies)}
                </div>
                <p class="evo-queue"${queued ? '' : ' hidden'}>+${queued} more</p>
                <p class="evo-skip">Click anywhere to skip</p>
            </div>
        `;

        // The timeout, a click and an abort can all race; whichever lands first
        // wins and the rest become inert.
        let settled = false;
        const settle = (advance) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            overlay.remove();
            if (advance) done();
        };
        const timer = setTimeout(() => settle(true), EVOLUTION_OVERLAY_MS);
        overlay.addEventListener('click', () => settle(true));

        document.body.appendChild(overlay);
        this.currentOverlayEl = overlay;
        return () => { this.currentOverlayEl = null; settle(false); };
    }

    /** Sparks thrown outward by the burst, evenly spread with a scattered delay. */
    /**
     * Renders the mega transformation; calls `done` when dismissed or timed out.
     * Returns an abort function that tears it down WITHOUT advancing the queue,
     * exactly like playEvolutionOverlay — suspendEvolutionOverlay calls it on
     * entering fullscreen.
     *
     * Bigger than an evolution on purpose. An evolution happens every few
     * levels; this happens once per Pokémon, so it gets the longer runtime, the
     * stone's own entrance, and a shockwave the evolution scene has no
     * equivalent of. The timeline lives in styles.css and every beat is an
     * animation-delay — the only JS timer here is the one that ends it.
     */
    playMegaOverlay(evo, done) {
        const overlay = document.createElement('div');
        overlay.className = 'mega-overlay-screen';

        const queued = this.pendingEvolutions.length;
        const species = evo.species;
        const form = evo.form;

        overlay.innerHTML = `
            <div class="mega-flash"></div>
            <div class="mega-box">
                ${evo.deferred ? '<p class="evo-deferred">While you were watching…</p>' : ''}
                <p class="mega-lead"><b>${species.name}</b> is reacting to <b>${form.stone}</b>!</p>
                <div class="mega-stage">
                    <div class="mega-vortex"></div>
                    <div class="mega-ring mega-ring-1"></div>
                    <div class="mega-ring mega-ring-2"></div>
                    <div class="mega-ring mega-ring-3"></div>
                    <div class="mega-stone-orbit"><span class="mega-stone"></span></div>
                    <div class="mega-shock"></div>
                    <div class="mega-burst"></div>
                    <div class="mega-morph">
                        <img src="${this.config.getSpriteUrl(species.id, evo.shiny)}"
                             alt="${species.name}" class="old-sprite"/>
                        <img src="${this.config.getSpriteUrl(form.spriteId, evo.shiny)}"
                             alt="${form.name}" class="new-sprite"/>
                    </div>
                    <div class="mega-shards">${this.renderMegaShards()}</div>
                </div>
                <div class="mega-outcome">
                    <p class="mega-desc">${species.name} Mega Evolved into <b>${form.name}</b>!</p>
                    <div class="types-row">${species.types.map(t =>
                        `<span class="type-pill" data-type="${t}">${t}</span>`).join('')}</div>
                    <p class="mega-boon">◆ Deals 1.3x damage while studying and in PVP</p>
                </div>
                ${queued ? `<p class="evo-queue">+${queued} more</p>` : ''}
                <p class="evo-skip">Click anywhere to skip</p>
            </div>`;

        // Same three-way race as the evolution scene: the timer, a click, or an
        // abort from fullscreen. One `settled` flag so none of them can double-fire.
        let settled = false;
        const settle = (advance) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            overlay.remove();
            if (advance) done();
        };
        const timer = setTimeout(() => settle(true), MEGA_OVERLAY_MS);
        overlay.addEventListener('click', () => settle(true));

        document.body.appendChild(overlay);
        return () => settle(false);
    }

    /**
     * The hatching scene.
     *
     * Reuses the mega overlay's shell — same flash, rings and burst — because
     * the beat is the same one: a held breath, then a reveal. Only the thing in
     * the middle differs, so only that is new CSS.
     */
    playHatchOverlay(evo, done) {
        const overlay = document.createElement('div');
        overlay.className = 'mega-overlay-screen hatch-overlay-screen';

        const queued = this.pendingEvolutions.length;
        const species = evo.species;

        overlay.innerHTML = `
            <div class="mega-flash"></div>
            <div class="mega-box">
                ${evo.deferred ? '<p class="evo-deferred">While you were watching…</p>' : ''}
                <p class="mega-lead">The egg is hatching!</p>
                <div class="mega-stage">
                    <div class="mega-vortex"></div>
                    <div class="mega-ring mega-ring-1"></div>
                    <div class="mega-ring mega-ring-2"></div>
                    <div class="hatch-egg"><span class="hatch-crack"></span></div>
                    <div class="mega-burst"></div>
                    <div class="mega-morph">
                        <img src="${this.config.getSpriteUrl(species.id, evo.shiny)}"
                             alt="${species.name}" class="new-sprite"/>
                    </div>
                    <div class="mega-shards">${this.renderMegaShards()}</div>
                </div>
                <div class="mega-outcome">
                    <p class="mega-desc">It hatched into <b>${species.name}</b>!${
                        evo.shiny ? ' <span class="hatch-shiny">✦ Shiny!</span>' : ''}</p>
                    <div class="types-row">${species.types.map(t =>
                        `<span class="type-pill" data-type="${t}">${t}</span>`).join('')}</div>
                </div>
                ${queued ? `<p class="evo-queue">+${queued} more</p>` : ''}
                <p class="evo-skip">Click anywhere to skip</p>
            </div>`;

        let settled = false;
        const settle = (advance) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            overlay.remove();
            if (advance) done();
        };
        const timer = setTimeout(() => settle(true), MEGA_OVERLAY_MS);
        overlay.addEventListener('click', () => settle(true));

        document.body.appendChild(overlay);
        return () => settle(false);
    }

    /**
     * The stone's shards. Two rings rather than one — an inner fast ring and an
     * outer slow one — which reads as debris rather than as a starburst.
     */
    renderMegaShards() {
        let out = '';
        for (let i = 0; i < MEGA_SHARD_COUNT; i++) {
            const ring = i % 2;
            const angle = (360 / MEGA_SHARD_COUNT) * i + (ring ? 9 : 0);
            const reach = ring ? 230 : 150;
            const delay = (ring ? 0.08 : 0) + (i / MEGA_SHARD_COUNT) * 0.16;
            out += `<i style="--angle:${angle}deg;--reach:${reach}px;--delay:${delay.toFixed(3)}s"></i>`;
        }
        return out;
    }

    renderEvolutionSparks() {
        return Array.from({ length: EVOLUTION_SPARK_COUNT }, (_, i) => {
            const angle = Math.round((360 / EVOLUTION_SPARK_COUNT) * i);
            // Alternating reach and a staggered start keep it from reading as a
            // clock face expanding in lockstep.
            const reach = i % 2 ? 150 : 195;
            const delay = ((i % 4) * 0.045).toFixed(3);
            return `<i style="--angle: ${angle}deg; --reach: ${reach}px; --delay: ${delay}s"></i>`;
        }).join('');
    }

    /**
     * Base-stat deltas across the evolution. Losses are shown as well as gains:
     * not every evolution is a straight upgrade here. Metapod trades attack and
     * speed for defence, and Shedinja drops 30 HP — in the real games those are
     * offset by special stats, which this four-stat model doesn't carry. Hiding
     * the minuses would promise an improvement the player doesn't get.
     *
     * Unchanged stats are omitted; a row of "+0"s is noise.
     */
    renderEvolutionGains(fromSpecies, toSpecies) {
        const before = fromSpecies && fromSpecies.baseStats;
        const after = toSpecies && toSpecies.baseStats;
        if (!before || !after) return '';

        const deltas = [['HP', 'hp'], ['ATK', 'attack'], ['DEF', 'defense'], ['SPD', 'speed']]
            .map(([label, key]) => [label, after[key] - before[key]])
            .filter(([, delta]) => delta !== 0)
            .map(([label, delta]) => delta > 0
                ? `<span>${label} <b>+${delta}</b></span>`
                : `<span>${label} <b class="down">${delta}</b></span>`);

        return deltas.length ? `<div class="evo-gains">${deltas.join('')}</div>` : '';
    }

    createModalOverlay(title) {
        const overlay = document.createElement('div');
        overlay.className = 'flickemon-modal-overlay';
        overlay.innerHTML = `
            <div class="flickemon-modal-container">
                <div class="flickemon-modal-header">
                    <h2 class="flickemon-modal-title">${title}</h2>
                    <button class="flickemon-modal-close">✕</button>
                </div>
                <div class="flickemon-modal-content"></div>
            </div>
        `;
        overlay.querySelector('.flickemon-modal-close').addEventListener('click', () => this.closeModal(overlay));
        document.body.appendChild(overlay);
        return { overlay, body: overlay.querySelector('.flickemon-modal-content') };
    }

    closeModal(modal) {
        if (modal.overlay) modal.overlay.remove();
        else if (modal.remove) modal.remove();
    }
}

window.FlickemonUI = FlickemonUI;
