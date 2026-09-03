/**
 * Flickémon Poké Mart
 * ───────────────────
 * Where Poké Dollars turn into things the grind cannot produce: an egg of a
 * chosen evolution stage, a Mega Stone for a species, and three permanent
 * boosts that stack on top of the temporary ones PVP hands out.
 *
 * Built on the same furniture as PVP, trading and friends — one modal, tabs
 * rendered from a config list, and every write behind a mutex.
 *
 * ── This is not a store ──
 *
 * Nothing here costs money. The only currency is time already spent watching
 * lectures, and there is deliberately no way to acquire it faster than by
 * studying — no bundles, no top-ups, no second currency. See LEGAL.md; the
 * project's rule is no monetisation of any kind, and an in-game sink is only
 * consistent with that for as long as it stays impossible to buy into.
 *
 * ── No network ──
 *
 * Every purchase is a change to the local save, which syncs on the normal
 * debounce like everything else. This file opens no sockets and polls nothing,
 * so leaving the mart open costs no Firestore reads.
 */

/** Species names come from the registry, but stone and item labels are strings. */
function sesc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class FlickemonShop {
    constructor(engine, ui) {
        this.engine = engine;
        this.ui = ui;
        this.config = window.FlickemonConfig;

        this.tab = 'eggs';           // eggs | stones | boosts
        this.stoneQuery = '';
        this.busy = false;
        this.notice = '';
    }

    // ─────────────────────────── Entry ───────────────────────────

    open() {
        const modal = this.ui.createModalOverlay('Poké Mart');
        modal.overlay.classList.add('shop-overlay');
        this.modal = modal;

        modal.overlay.addEventListener('click', (e) => {
            if (e.target === modal.overlay) this.ui.closeModal(modal);
        });

        this.render();
    }

    // ─────────────────────────── Render ───────────────────────────

    render() {
        if (!this.modal) return;
        const tabs = [['eggs', 'SPAWN EGG'], ['stones', 'MEGA STONE'],
                      ['boosts', 'BOOSTER']];
        const money = this.engine.getMoney();

        this.modal.body.innerHTML = `
            <div class="shop">
                <div class="shop-wallet">
                    <span class="shop-wallet-label">YOUR MONEY</span>
                    <span class="shop-wallet-amount">${this.config.formatMoney(money)}</span>
                </div>
                <div class="shop-tabs">
                    ${tabs.map(([id, label]) => `
                        <button class="shop-tab ${this.tab === id ? 'on' : ''}" data-tab="${id}">${label}</button>
                    `).join('')}
                </div>
                ${this.notice ? `<p class="shop-notice">${sesc(this.notice)}</p>` : ''}
                <div class="shop-panel">${this.renderTab()}</div>
            </div>`;

        this.bind();
    }

    renderTab() {
        if (this.tab === 'stones') return this.renderStones();
        if (this.tab === 'boosts') return this.renderBoosts();
        return this.renderEggs();
    }

    /**
     * A price, plus what it still costs you.
     *
     * Showing the shortfall rather than only greying the button out is the
     * difference between "no" and "not yet", and the second one is the honest
     * answer — everything here is reachable by watching more lectures.
     */
    renderPrice(price) {
        const money = this.engine.getMoney();
        const short = price - money;
        const hours = this.config.hoursForPrice(price);
        return `
            <div class="shop-price">
                <span class="shop-price-amount">${this.config.formatMoney(price)}</span>
                <span class="shop-price-hours">≈ ${hours} h of lectures</span>
                ${short > 0 ? `<span class="shop-price-short">${this.config.formatMoney(short)} to go</span>` : ''}
            </div>`;
    }

    renderEggs() {
        const money = this.engine.getMoney();
        const eggs = this.config.SHOP_ITEMS.filter(i => i.kind === this.config.SHOP_ITEM_KINDS.EGG);

        return `
            ${this.renderIncubator()}
            <p class="shop-blurb">An egg goes in the incubator and hatches after a
               number of encounters. What is inside is decided the moment you buy it.</p>
            <div class="shop-grid">
                ${eggs.map(item => `
                    <div class="shop-card">
                        <span class="shop-card-icon">${sesc(item.icon)}</span>
                        <div class="shop-card-copy">
                            <p class="shop-card-name">${sesc(item.label)}</p>
                            <p class="shop-card-detail">${sesc(item.detail)}</p>
                            <p class="shop-card-meta">Hatches in ${item.hatchEncounters} encounters</p>
                        </div>
                        ${this.renderPrice(item.price)}
                        <button class="shop-buy" data-buy-egg="${item.id}"
                                ${money < item.price ? 'disabled' : ''}>BUY</button>
                    </div>
                `).join('')}
            </div>`;
    }

    renderStones() {
        const item = this.config.shopItemById('mega-stone');

        return `
            <p class="shop-blurb">A stone belongs to the <b>species</b>, not to one
               Pokémon — every ${sesc(item.label)} you buy unlocks that Mega Evolution
               for every one you own now and every one you catch later.</p>
            <div class="shop-flatrate">
                <span class="shop-flatrate-label">ANY STONE</span>
                ${this.renderPrice(item.price)}
            </div>
            <input class="shop-search" type="text" placeholder="Search a Pokémon or a stone…"
                   value="${sesc(this.stoneQuery)}"/>
            ${this.renderStoneList()}`;
    }

    /**
     * The stone list on its own, so typing in the search box redraws only this
     * and the field keeps its focus and caret.
     *
     * Listed by FORM rather than by species: nine species have more than one
     * and Tatsugiri has three, so a species list could not say which you bought.
     */
    renderStoneList() {
        const money = this.engine.getMoney();
        const item = this.config.shopItemById('mega-stone');
        const owned = new Set(this.engine.gameState.megaSpecies || []);
        const query = this.stoneQuery.trim().toLowerCase();

        const forms = this.config.allMegaForms()
            .map(f => ({ ...f, species: this.config.getSpeciesById(f.speciesId) }))
            .filter(f => f.species)
            .filter(f => !query
                || f.species.name.toLowerCase().includes(query)
                || f.stone.toLowerCase().includes(query))
            .sort((a, b) => a.species.name.localeCompare(b.species.name));

        return `
            <div class="shop-stone-list">
                ${forms.length === 0 ? '<p class="shop-empty">Nothing matches that.</p>' : ''}
                ${forms.map(f => `
                    <div class="shop-stone-row ${owned.has(f.key) ? 'is-owned' : ''}">
                        <img class="shop-stone-sprite" loading="lazy"
                             src="${this.config.getSpriteUrl(f.speciesId, false)}"
                             alt="${sesc(f.species.name)}"/>
                        <div class="shop-stone-copy">
                            <p class="shop-card-name">${sesc(f.name)}</p>
                            <p class="shop-card-detail">${sesc(f.stone)}</p>
                        </div>
                        ${owned.has(f.key)
                            ? '<span class="shop-owned">OWNED</span>'
                            : `<button class="shop-buy" data-buy-stone="${sesc(f.key)}"
                                       ${money < item.price ? 'disabled' : ''}>BUY</button>`}
                    </div>
                `).join('')}
            </div>`;
    }

    renderBoosts() {
        const money = this.engine.getMoney();

        return `
            <p class="shop-blurb">These never run out, and they <b>multiply</b> the
               temporary boost a PVP win gives you rather than replacing it.</p>
            <div class="shop-grid">
                ${this.config.SHOP_BOOSTS.map(boost => {
                    const info = this.config.REWARD_INFO[boost.reward];
                    const tier = this.engine.shopBoostTier(boost.reward);
                    const next = this.config.nextBoostTier(tier);
                    const now = this.config.shopBoostMultiplier(boost.reward, tier);
                    const then = next ? this.config.shopBoostMultiplier(boost.reward, next.tier) : null;
                    return `
                        <div class="shop-card">
                            <span class="shop-card-icon">${info.icon}</span>
                            <div class="shop-card-copy">
                                <p class="shop-card-name">${sesc(info.label)}</p>
                                <p class="shop-card-detail">${sesc(boost.detail)}</p>
                                <p class="shop-card-meta">
                                    ${tier === 0
                                        ? (then ? `Not owned. ${then}x from tier 1.` : 'Not owned.')
                                        : `Tier ${tier} — ${now}x now${
                                            then ? `, ${then}x at tier ${next.tier}` : ' (the highest)'}.`}
                                </p>
                                <div class="shop-pips">
                                    ${[1, 2, 3].map(t =>
                                        `<span class="shop-pip ${tier >= t ? 'on' : ''}"></span>`).join('')}
                                </div>
                            </div>
                            ${next ? this.renderPrice(next.price) : ''}
                            ${next
                                ? `<button class="shop-buy" data-buy-boost="${boost.reward}"
                                           ${money < next.price ? 'disabled' : ''}>
                                       ${tier === 0 ? 'BUY' : 'UPGRADE'}</button>`
                                : '<span class="shop-owned">MAXED</span>'}
                        </div>`;
                }).join('')}
            </div>`;
    }

    /**
     * What you are already carrying, above the shelf.
     *
     * Empty until the first egg is bought, so a new student sees a shop rather
     * than a shop plus an empty container asking to be filled.
     */
    renderIncubator() {
        const eggs = this.engine.getEggs();
        const carrying = this.engine.getIncubatingEgg();

        if (eggs.length === 0) return '';

        const row = (egg) => {
            const item = this.config.shopItemById(egg.itemId);
            const total = item ? item.hatchEncounters : 1;
            const done = Math.max(0, total - egg.encountersLeft);
            const pct = Math.round((done / total) * 100);
            const isCarrying = carrying && carrying.eggId === egg.eggId;
            return `
                <div class="shop-egg-row ${isCarrying ? 'is-carrying' : ''}">
                    <span class="shop-card-icon">${item ? sesc(item.icon) : '○'}</span>
                    <div class="shop-egg-copy">
                        <p class="shop-card-name">${item ? sesc(item.label) : 'Egg'}</p>
                        ${isCarrying ? `
                            <div class="shop-egg-bar"><span style="width:${pct}%"></span></div>
                            <p class="shop-card-meta">${egg.encountersLeft} encounters to go</p>
                        ` : '<p class="shop-card-meta">Waiting in the bag</p>'}
                    </div>
                    ${isCarrying
                        ? '<span class="shop-owned">CARRYING</span>'
                        : `<button class="shop-buy" data-incubate="${sesc(egg.eggId)}">CARRY</button>`}
                </div>`;
        };

        // Whatever is being carried goes first — it is the one that is moving.
        const ordered = [...eggs].sort((a, b) => {
            const ca = carrying && carrying.eggId === a.eggId ? 0 : 1;
            const cb = carrying && carrying.eggId === b.eggId ? 0 : 1;
            return ca - cb;
        });

        return `
            <div class="shop-incubator">
                <p class="shop-section">YOUR EGGS · ${eggs.length}</p>
                <div class="shop-egg-list">${ordered.map(row).join('')}</div>
                <p class="shop-card-meta">One egg is carried at a time. Every wild
                   encounter you finish — win or lose — brings it one step closer.</p>
            </div>`;
    }

    // ─────────────────────────── Actions ───────────────────────────

    bind() {
        const body = this.modal.body;

        body.querySelectorAll('.shop-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.tab = btn.dataset.tab;
                this.notice = '';
                this.render();
            });
        });

        const search = body.querySelector('.shop-search');
        if (search) {
            search.addEventListener('input', () => {
                this.stoneQuery = search.value;
                const list = body.querySelector('.shop-stone-list');
                if (!list) return;
                // Only the list is redrawn. A full render() would rebuild the
                // input too, which loses focus and sends the caret to the end
                // on every keystroke.
                list.outerHTML = this.renderStoneList();
                this.bindBuys();
            });
        }

        this.bindBuys();
    }

    bindBuys() {
        const body = this.modal.body;

        body.querySelectorAll('[data-buy-egg]').forEach(btn => {
            btn.addEventListener('click', () => this.guard(async () => {
                const res = await this.engine.buyEgg(btn.dataset.buyEgg);
                this.notice = res.ok
                    ? 'An egg! Carry it and it will hatch as you watch.'
                    : this.reasonText(res);
                this.render();
            }));
        });

        body.querySelectorAll('[data-buy-stone]').forEach(btn => {
            btn.addEventListener('click', () => this.guard(async () => {
                const res = await this.engine.buyMegaStone(btn.dataset.buyStone);
                this.notice = res.ok
                    ? `${res.form.stone} is yours. Every ${res.form.name.replace(/^Mega /, '')} you own can use it.`
                    : this.reasonText(res);
                this.render();
            }));
        });

        body.querySelectorAll('[data-buy-boost]').forEach(btn => {
            btn.addEventListener('click', () => this.guard(async () => {
                const res = await this.engine.buyBoost(btn.dataset.buyBoost);
                this.notice = res.ok
                    ? `Tier ${res.tier}. This one never runs out.`
                    : this.reasonText(res);
                this.render();
            }));
        });

        body.querySelectorAll('[data-incubate]').forEach(btn => {
            btn.addEventListener('click', () => this.guard(async () => {
                await this.engine.setIncubating(btn.dataset.incubate);
                this.render();
            }));
        });
    }

    reasonText(res) {
        if (!res) return 'That did not work.';
        if (res.reason === 'poor') {
            const short = res.price - this.engine.getMoney();
            return `Not enough — ${this.config.formatMoney(short)} short.`;
        }
        if (res.reason === 'owned') return 'You already own that one.';
        if (res.reason === 'maxed') return 'That is already at its highest tier.';
        return 'That did not work.';
    }

    /**
     * One purchase at a time.
     *
     * A double-click on BUY would otherwise run two purchases against the same
     * balance check and spend twice for one item. Same mutex the friends panel
     * uses, and for the same reason.
     */
    async guard(fn) {
        if (this.busy) return null;
        this.busy = true;
        try {
            return await fn();
        } catch (e) {
            this.notice = (e && e.message) || 'That did not work.';
            this.render();
            return null;
        } finally {
            this.busy = false;
        }
    }
}

window.FlickemonShop = FlickemonShop;
