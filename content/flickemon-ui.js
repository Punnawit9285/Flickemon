/**
 * Flickemon UI Components (Chrome Extension)
 * ───────────────────────────────────────────
 * Port of flickemon-widget.component.ts, flickemon-modal.component.ts,
 * flickemon-starter.component.ts, and flickemon-settings-modal.component.ts.
 */

class FlickemonUI {
    constructor(engine) {
        this.engine = engine;
        this.config = window.FlickemonConfig;

        this.widgetCard = null;
        this.activeModal = null;
        this.popoverOpen = false;

        document.addEventListener('click', () => {
            this.popoverOpen = false;
            if (this.widgetCard) {
                const popover = this.widgetCard.querySelector('.options-popover-menu');
                if (popover) popover.style.display = 'none';
            }
        });
    }

    renderWidget() {
        const card = document.createElement('div');
        card.className = 'flickemon-card flickemon-widget-card';

        this.engine.onStateChange((state) => {
            this.updateWidgetView(card, state, this.engine.wildOpponent);
        });

        this.engine.onWildChange((wild) => {
            this.updateWidgetView(card, this.engine.getGameState(), wild);
        });

        this.engine.onEvolution((evo) => {
            this.showEvolutionOverlay(evo);
        });

        this.widgetCard = card;
        return card;
    }

    updateWidgetView(card, state, wild) {
        const gameControllerSvg = `<svg class="header-icon-svg" viewBox="0 0 512 512" width="22" height="22" fill="currentColor"><path d="M483.13 245.38C461.92 149.49 430 98.31 382.65 84.33A107.1 107.1 0 0 0 352 80c-13.71 0-25.65 3.34-38.28 6.88C298.5 91.15 281.21 96 256 96s-42.51-4.84-57.76-9.11C185.6 83.34 173.67 80 160 80a115.7 115.7 0 0 0-31.73 4.32c-47.1 13.92-79 65.08-100.52 161C4.61 348.54 16 413.71 59.69 428.83a56.6 56.6 0 0 0 18.64 3.22c29.93 0 53.93-24.93 70.33-45.34 18.53-23.1 40.22-34.82 107.34-34.82 59.95 0 84.76 8.13 106.19 34.82 13.47 16.78 26.2 28.52 38.9 35.91 16.89 9.82 33.77 12 50.16 6.37 25.82-8.81 40.62-32.1 44-69.24 2.57-28.48-1.39-65.89-12.12-114.37M208 240h-32v32a16 16 0 0 1-32 0v-32h-32a16 16 0 0 1 0-32h32v-32a16 16 0 0 1 32 0v32h32a16 16 0 0 1 0 32m84 4a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-19.95A20 20 0 0 1 336 288m0-88a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-20 20 20 0 0 1-20 20"/></svg>`;
        const ellipsisSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor"><circle cx="256" cy="96" r="48"/><circle cx="256" cy="256" r="48"/><circle cx="256" cy="416" r="48"/></svg>`;
        const chevronDownSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48"><path d="M112 184l144 144 144-144"/></svg>`;
        const chevronUpSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48"><path d="M112 328l144-144 144 144"/></svg>`;
        const menuGameControllerSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor"><path d="M483.13 245.38C461.92 149.49 430 98.31 382.65 84.33A107.1 107.1 0 0 0 352 80c-13.71 0-25.65 3.34-38.28 6.88C298.5 91.15 281.21 96 256 96s-42.51-4.84-57.76-9.11C185.6 83.34 173.67 80 160 80a115.7 115.7 0 0 0-31.73 4.32c-47.1 13.92-79 65.08-100.52 161C4.61 348.54 16 413.71 59.69 428.83a56.6 56.6 0 0 0 18.64 3.22c29.93 0 53.93-24.93 70.33-45.34 18.53-23.1 40.22-34.82 107.34-34.82 59.95 0 84.76 8.13 106.19 34.82 13.47 16.78 26.2 28.52 38.9 35.91 16.89 9.82 33.77 12 50.16 6.37 25.82-8.81 40.62-32.1 44-69.24 2.57-28.48-1.39-65.89-12.12-114.37M208 240h-32v32a16 16 0 0 1-32 0v-32h-32a16 16 0 0 1 0-32h32v-32a16 16 0 0 1 32 0v32h32a16 16 0 0 1 0 32m84 4a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-19.95A20 20 0 0 1 336 288m0-88a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-20 20 20 0 0 1-20 20"/></svg>`;
        const gearSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor"><path d="M262.29 192.31a64 64 0 1 0 57.4 57.4 64.13 64.13 0 0 0-57.4-57.4zM416.39 256a154.34 154.34 0 0 1-1.53 20.79l45.84 35.76a16.74 16.74 0 0 1 4.33 19.69l-43.7 75.71a16.63 16.63 0 0 1-19.81 7.51l-54-21.78a156.76 156.76 0 0 1-35.93 20.73l-8.34 57.53A16.69 16.69 0 0 1 286.61 480h-87.2a16.69 16.69 0 0 1-16.59-14.36l-8.26-57.34a156 156 0 0 1-35.82-20.7l-54.05 21.77a16.73 16.73 0 0 1-19.77-7.49l-43.7-75.59a16.71 16.71 0 0 1 4.22-19.73l45.89-35.79a154.94 154.94 0 0 1-1.54-20.76c0-6.93.53-13.77 1.54-20.79l-45.89-35.76a16.74 16.74 0 0 1-4.22-19.73l43.7-75.71a16.7 16.7 0 0 1 19.7-7.51l54.06 21.79A155.65 155.65 0 0 1 174.5 125l8.26-57.46A16.69 16.69 0 0 1 199.41 32h87.2a16.69 16.69 0 0 1 16.59 14.36l8.34 57.53a156.47 156.47 0 0 1 35.93 20.73l54-21.78a16.65 16.65 0 0 1 19.81 7.51l43.7 75.71a16.72 16.72 0 0 1-4.33 19.69l-45.84 35.75a155.51 155.51 0 0 1 1.53 20.8zM256 160a96 96 0 1 0 96 96 96.11 96.11 0 0 0-96-96z"/></svg>`;

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
                this.openStarterModal();
            });
            return;
        }

        const active = this.engine.getActivePokemon();
        const activeSpecies = active ? this.engine.getSpeciesForPokemon(active) : null;
        if (!active || !activeSpecies) return;

        const expProg = this.engine.getExpProgress(active);

        card.innerHTML = `
            <div class="flickemon-header">
                <div class="header-left">
                    ${gameControllerSvg}
                    <span class="header-title">Flickémon</span>
                </div>
                <div class="header-actions">
                    <button class="icon-btn menu-trigger-btn" title="Options">${ellipsisSvg}</button>
                    <button class="icon-btn widget-collapse-btn" title="Toggle Collapse">${chevronUpSvg}</button>

                    <!-- Options Popover Menu -->
                    <div class="options-popover-menu" style="display: none;">
                        <div class="popover-item game-hub-item"><span class="popover-icon">${menuGameControllerSvg}</span> Game Hub</div>
                        <div class="popover-item settings-item"><span class="popover-icon">${gearSvg}</span> Settings</div>
                    </div>
                </div>
            </div>
            <div class="widget-body">
                <div class="hud-columns">
                    <!-- Left: Active Partner -->
                    <div class="hud-col partner-col">
                        <img src="${this.config.getSpriteUrl(activeSpecies.id)}" alt="${activeSpecies.name}" class="partner-mini-sprite"/>
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
                            <img src="${this.config.getSpriteUrl(wild.wildSpecies.id)}" alt="${wild.wildSpecies.name}" class="wild-mini-sprite ${wild.status}"/>
                            <div class="battle-info">
                                <div class="name-line">
                                    <strong class="pk-name">${wild.wildSpecies.name}</strong>
                                    <span class="pk-lvl">Lv.${wild.wildLevel}</span>
                                </div>
                                <div class="hp-bar-track">
                                    <div class="hp-bar-fill" style="width: ${Math.round((wild.currentHp / wild.maxHp) * 100)}%;"></div>
                                </div>
                                <div class="status-line ${wild.status}">
                                    ${wild.status === 'captured' ? `🏆 Captured! (+${wild.expGained || 0} EXP)` : wild.status === 'escaped' ? `💨 Escaped! (+${wild.expGained || 0} EXP)` : `⚔️ Fighting... (HP ${wild.currentHp}/${wild.maxHp})`}
                                </div>
                            </div>
                        ` : '<div class="searching-text">Searching for wild Pokémon...</div>'}
                    </div>
                </div>
            </div>
        `;

        const menuBtn = card.querySelector('.menu-trigger-btn');
        const popover = card.querySelector('.options-popover-menu');
        const collapseBtn = card.querySelector('.widget-collapse-btn');
        const widgetBody = card.querySelector('.widget-body');

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
    }

    // ────────────────────────── Starter Selection Modal ──────────────────────────

    openStarterModal() {
        const modal = this.createModalOverlay('Select Your Starter Pokémon');
        const options = this.engine.getStarterOptions();

        let activeTab = 1;
        const genTabs = [
            { gen: 1, label: 'Gen 1', region: 'Kanto', games: 'Red & Blue' },
            { gen: 2, label: 'Gen 2', region: 'Johto', games: 'Gold, Silver, Crystal' },
            { gen: 3, label: 'Gen 3', region: 'Hoenn', games: 'Ruby, Sapphire, Emerald' },
            { gen: 4, label: 'Gen 4', region: 'Sinnoh', games: 'Diamond, Pearl, Platinum' },
            { gen: 5, label: 'Gen 5', region: 'Unova', games: 'Black & White' },
            { gen: 6, label: 'Gen 6', region: 'Kalos', games: 'X & Y' },
            { gen: 7, label: 'Gen 7', region: 'Alola', games: 'Sun & Moon' },
            { gen: 8, label: 'Gen 8', region: 'Galar', games: 'Sword & Shield' },
            { gen: 9, label: 'Gen 9', region: 'Paldea', games: 'Scarlet & Violet' },
            { gen: 0, label: 'Special', region: 'Special Starters', games: 'Yellow & Let\'s Go' },
        ];

        modal.body.innerHTML = `
            <div class="starter-modal-content">
                <div class="starter-modal-header-text">
                    <h1 class="starter-hero-title">Choose Your Partner!</h1>
                    <p class="starter-hero-subtitle">Select a Pokémon to begin your Flickémon journey</p>
                </div>
                <div class="gen-tabs">
                    ${genTabs.map(t => `
                        <button class="gen-tab-btn ${t.gen === 1 ? 'active' : ''}" data-gen="${t.gen}">
                            <strong>${t.gen === 0 ? t.label : `${t.region} (GEN ${t.gen})`}</strong><br/>
                            <small>${t.games}</small>
                        </button>
                    `).join('')}
                </div>
                <div class="starters-grid"></div>
                <div class="starter-confirm-container" style="display: none; margin-top: 1.5rem; text-align: center;">
                    <button class="starter-confirm-btn" style="background: var(--flick-primary); color: #fff; border: none; padding: 16px 24px; border-radius: 32px; font-size: 1.2rem; font-weight: 800; width: 100%; cursor: pointer; transition: all 0.2s;">I CHOOSE YOU!</button>
                </div>
            </div>
        `;

        let currentSelectedId = null;

        const renderGrid = (gen) => {
            const grid = modal.body.querySelector('.starters-grid');
            const confirmContainer = modal.body.querySelector('.starter-confirm-container');
            const confirmBtn = modal.body.querySelector('.starter-confirm-btn');

            confirmContainer.style.display = 'none';
            currentSelectedId = null;

            let starters;
            if (gen === 0) {
                starters = options.filter(s => s.id === 25 || s.id === 133);
            } else if (gen === 1) {
                starters = options.filter(s => s.generation === 1 && s.id !== 25 && s.id !== 133);
            } else {
                starters = options.filter(s => s.generation === gen);
            }

            grid.innerHTML = starters.map(s => `
                <div class="starter-card" data-id="${s.id}">
                    <img class="starter-card-img" src="${this.config.getSpriteUrl(s.id)}" alt="${s.name}"/>
                    <h4 class="starter-card-name">${s.name}</h4>
                    <div class="types-row">
                        ${s.types.map(t => `<span class="type-pill ${t}">${t}</span>`).join('')}
                    </div>
                    <div class="starter-card-stats">
                        <div class="stat-col">
                            <span>HP ${s.baseStats.hp}</span>
                            <span>DEF ${s.baseStats.defense}</span>
                        </div>
                        <div class="stat-col">
                            <span>ATK ${s.baseStats.attack}</span>
                            <span>SPD ${s.baseStats.speed}</span>
                        </div>
                    </div>
                </div>
            `).join('');

            grid.querySelectorAll('.starter-card').forEach(card => {
                card.addEventListener('click', () => {
                    grid.querySelectorAll('.starter-card').forEach(c => c.classList.remove('selected'));
                    card.classList.add('selected');
                    const speciesId = parseInt(card.getAttribute('data-id'), 10);
                    currentSelectedId = speciesId;
                    const nameEl = card.querySelector('.starter-card-name');
                    const name = nameEl ? nameEl.textContent : '';
                    const activeBtn = modal.body.querySelector('.starter-confirm-btn');
                    if (activeBtn) {
                        activeBtn.textContent = `I CHOOSE YOU! (${name.toUpperCase()})`;
                    }
                    if (confirmContainer) {
                        confirmContainer.style.display = 'block';
                    }
                });
            });
        };

        const globalConfirmBtn = modal.body.querySelector('.starter-confirm-btn');
        globalConfirmBtn?.addEventListener('click', async () => {
            if (currentSelectedId) {
                await this.engine.chooseStarter(currentSelectedId);
                this.closeModal(modal.overlay);
            }
        });

        renderGrid(1);

        modal.body.querySelectorAll('.gen-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.body.querySelectorAll('.gen-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderGrid(parseInt(btn.getAttribute('data-gen'), 10));
            });
        });
    }

    // ────────────────────────── Game Hub Modal ──────────────────────────

    openGameHub() {
        const modal = this.createModalOverlay('Flickémon');
        const active = this.engine.getActivePokemon();
        const activeSpecies = active ? this.engine.getSpeciesForPokemon(active) : null;
        const party = this.engine.getParty();
        const pokedex = this.engine.getPokedex();

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
            if (tab === 'partner') {
                if (active && activeSpecies) {
                    const expProg = this.engine.getExpProgress(active);
                    content.innerHTML = `
                        <div class="partner-section">
                            <img src="${this.config.getSpriteUrl(activeSpecies.id)}" alt="${activeSpecies.name}" class="partner-big-sprite"/>
                            <h2 class="partner-big-name">${activeSpecies.name}</h2>
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
                content.innerHTML = `
                    <div class="flickemon-list-card">
                        ${party.map(pk => {
                            const sp = this.engine.getSpeciesForPokemon(pk);
                            if (!sp) return '';
                            const isActive = pk.instanceId === active?.instanceId;
                            return `
                                <div class="flickemon-party-row ${isActive ? 'active' : 'inactive'}" data-id="${pk.instanceId}" style="cursor: ${isActive ? 'default' : 'pointer'}">
                                    <img src="${this.config.getSpriteUrl(sp.id)}" alt="${sp.name}" class="party-sprite"/>
                                    <div class="party-info">
                                        <span class="party-name">${sp.name}</span>
                                        <span class="party-level">Lv. ${pk.level}</span>
                                    </div>
                                    ${isActive ? '<span class="party-star">★</span>' : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
                content.querySelectorAll('.flickemon-party-row.inactive').forEach(row => {
                    row.addEventListener('click', async (e) => {
                        const id = e.currentTarget.getAttribute('data-id');
                        await this.engine.switchActivePokemon(id);
                        renderTab('party');
                    });
                });
            } else if (tab === 'pokedex') {
                content.innerHTML = `
                    <div class="flickemon-pokedex-grid">
                        ${this.config.POKEMON_REGISTRY.map(sp => {
                            const entry = pokedex.find(p => p.speciesId === sp.id);
                            const caught = entry && entry.caught;
                            const seen = entry && entry.seen;
                            return `
                                <div class="pokedex-item">
                                    ${seen 
                                        ? `<img src="${this.config.getSpriteUrl(sp.id)}" alt="${sp.name}" class="pokedex-sprite" ${!caught ? 'style="filter: brightness(0); opacity: 0.4;"' : ''}/>` 
                                        : `<div class="pokedex-unknown">?</div>`
                                    }
                                    <span class="pokedex-num">#${sp.id}</span>
                                    ${caught ? `<span class="pokedex-name">${sp.name}</span>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            } else if (tab === 'stats') {
                content.innerHTML = `
                    <div class="flickemon-list-card">
                        <div class="flickemon-list-item">
                            <span class="flickemon-list-item-title">Total Watch Time</span>
                            <span class="flickemon-list-item-sub">${(this.engine.getGameState().totalMinutesWatched / 60).toFixed(1)} hours</span>
                        </div>
                        <div class="flickemon-list-item">
                            <span class="flickemon-list-item-title">Pokémon Caught</span>
                            <span class="flickemon-list-item-sub">${this.engine.getCaughtCount()} / ${this.config.POKEMON_REGISTRY.length}</span>
                        </div>
                        <div class="flickemon-list-item">
                            <span class="flickemon-list-item-title">Party Size</span>
                            <span class="flickemon-list-item-sub">${party.length}</span>
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
                    <span class="flickemon-list-item-title">Reset Game Progress</span>
                    <span class="flickemon-list-item-sub">Restart starter selection and reset party to 0</span>
                </div>
            </div>
            <button class="flickemon-danger-btn reset-progress-btn">RESET MY GAME PROGRESS</button>
            <br/><br/>
            <div class="flickemon-list-card">
                <div class="flickemon-list-item">
                    <span class="flickemon-list-item-title">Cloud Save Sync</span>
                    <span class="flickemon-list-item-sub">Manually pull the latest save from your Chrome profile</span>
                </div>
            </div>
            <button class="flickemon-primary-btn force-sync-btn" style="background: #10b981; color: white; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; width: 100%; margin-top: 8px;">☁️ FORCE CLOUD SYNC</button>
            <br/><br/>
            <div class="flickemon-list-card admin-section">
                <div class="flickemon-list-item">
                    <span class="flickemon-list-item-title">Admin Monitoring Portal</span>
                    <span class="flickemon-list-item-sub">Student Player Monitoring Portal (Firestore cloud backend)</span>
                </div>
                <div class="flickemon-list-item">
                    <div style="display: flex; gap: 8px;">
                        <input type="password" class="admin-passcode-input" placeholder="Enter Admin Passcode" style="flex:1; padding:8px; border-radius:4px; border:1px solid #ccc;"/>
                        <button class="unlock-admin-btn" style="background:#e91e63; color:white; border:none; border-radius:4px; padding:0 16px; cursor:pointer;">Unlock</button>
                    </div>
                </div>
                <div class="flickemon-list-item admin-unlocked-panel" style="display: none; padding: 12px;">
                    <span class="flickemon-list-item-title" style="color: #10b981; display: block; margin-bottom: 12px;">✅ Admin Access Granted (Passcode 9285)</span>
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
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-size:0.85rem; font-weight:600;">Set Level:</span>
                            <input type="number" class="admin-lvl-input" min="1" max="100" value="5" style="width:60px; padding:4px; border-radius:4px; border:1px solid #ccc; background:var(--flick-card-bg); color:var(--flick-text);"/>
                            <button class="admin-set-lvl-btn" style="background:var(--flick-primary); color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-weight:700;">Set Level</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        modal.body.querySelector('.reset-progress-btn').addEventListener('click', async () => {
            if (confirm('Are you sure you want to reset your Flickémon progress? This will reset your starter, party, and Pokédex.')) {
                await this.engine.resetGameState();
                this.closeModal(modal.overlay);
            }
        });

        const forceSyncBtn = modal.body.querySelector('.force-sync-btn');
        if (forceSyncBtn) {
            forceSyncBtn.addEventListener('click', async () => {
                const success = await this.engine.forceCloudSync();
                if (success) {
                    forceSyncBtn.textContent = '✅ SYNCED SUCCESSFULLY';
                    forceSyncBtn.style.background = '#059669';
                    setTimeout(() => {
                        forceSyncBtn.textContent = '☁️ FORCE CLOUD SYNC';
                        forceSyncBtn.style.background = '#10b981';
                    }, 2000);
                } else {
                    forceSyncBtn.textContent = '❌ SYNC FAILED';
                    forceSyncBtn.style.background = '#ef4444';
                    setTimeout(() => {
                        forceSyncBtn.textContent = '☁️ FORCE CLOUD SYNC';
                        forceSyncBtn.style.background = '#10b981';
                    }, 2000);
                }
            });
        }

        const passcodeBtn = modal.body.querySelector('.unlock-admin-btn');
        const passcodeInput = modal.body.querySelector('.admin-passcode-input');
        const adminPanel = modal.body.querySelector('.admin-unlocked-panel');

        passcodeBtn.addEventListener('click', () => {
            if (passcodeInput.value.trim() === '9285') {
                adminPanel.style.display = 'block';
            } else {
                alert('Invalid Admin Passcode!');
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

        adminPanel.querySelector('.admin-set-lvl-btn').addEventListener('click', async () => {
            const lvl = parseInt(adminPanel.querySelector('.admin-lvl-input').value, 10);
            if (lvl >= 1 && lvl <= 100) {
                await this.engine.adminSetPokemonLevel(lvl);
            }
        });
    }

    // ────────────────────────── Evolution Overlay ──────────────────────────

    showEvolutionOverlay(evo) {
        const overlay = document.createElement('div');
        overlay.className = 'evolution-overlay-screen';
        overlay.innerHTML = `
            <div class="evo-box">
                <div class="evo-sparkles">✨</div>
                <h2>Evolution!</h2>
                <div class="evo-sprites">
                    <img src="${this.config.getSpriteUrl(evo.from.id)}" class="old-sprite"/>
                    <span class="arrow">➡️</span>
                    <img src="${this.config.getSpriteUrl(evo.to.id)}" class="new-sprite"/>
                </div>
                <p class="evo-desc">${evo.from.name} evolved into ${evo.to.name}!</p>
            </div>
        `;
        document.body.appendChild(overlay);
        setTimeout(() => overlay.remove(), 5000);
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
