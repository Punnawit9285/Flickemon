/**
 * Flickémon Trading UI
 * ────────────────────
 * A link trade rendered inside the extension, on the same 8-bit furniture as
 * PVP. Both trainers put one Pokémon on the table, both see both offers, and
 * nothing moves until both have confirmed.
 *
 * Read cadence follows the same reasoning as flickemon-pvp.js: fast only while
 * genuinely waiting on the other person, and stopped entirely when the tab is
 * hidden or the trade is over. See background/trade.js for the transport, and
 * for the honest limits of a swap with no server refereeing it.
 */

const TRADE_POLL_ACTIVE_MS = 2000;    // they are at the table, deciding
const TRADE_POLL_LOBBY_MS  = 2500;    // backs off from here
const TRADE_POLL_MAX_MS    = 15000;
const TRADE_BACKOFF        = 1.6;
const TRADE_GIVE_UP_MS     = 300000;  // five minutes unanswered

// How long the trade scene runs, start to finish. Kept beside the stylesheet's
// timings rather than derived from them: a test asserts the two agree.
const TRADE_SCENE_MS = 6600;

/**
 * Names reach the scene from flickemon-custom.js, which students edit by hand,
 * and one apostrophe in a species name would otherwise break out of the
 * aria-label attribute it sits in.
 *
 * Deliberately its own copy rather than the identical `esc` in
 * flickemon-pvp.js: that is a bare global that happens to be in scope because
 * of the order in manifest.json, and a trade blowing up with a ReferenceError
 * because someone reordered a list is not a failure worth risking.
 */
function tradeEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class FlickemonTrade {
    constructor(engine, ui) {
        this.engine = engine;
        this.ui = ui;
        this.config = window.FlickemonConfig;

        this.pollTimer = null;
        this.pollPaused = false;
        this.pollingSince = 0;
        this.lobbyPolls = 0;
        this.code = null;
        this.role = null;         // 'host' | 'guest'
        this.remote = null;
        this.applied = false;

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                this.pollPaused = document.visibilityState === 'hidden';
                if (this.pollPaused) this.stopPolling();
                else if (this.code) this.poll();
            });
        }
    }

    // ─────────────────────────── Entry ───────────────────────────

    async open() {
        const modal = this.ui.createModalOverlay('Trade');
        modal.overlay.classList.add('pvp-overlay', 'trade-overlay');
        this.modal = modal;

        modal.overlay.addEventListener('click', (e) => {
            if (e.target === modal.overlay) this.leave();
        });
        modal.overlay.querySelector('.flickemon-modal-close')
            ?.addEventListener('click', () => this.leave());

        const status = await this.engine.pvpMyCode();
        if (!status || !status.signedIn) {
            return this.notice('SIGN IN TO TRADE',
                'Trading needs an account so trainers can find each other.');
        }

        const tradable = this.engine.tradableParty();
        if (tradable.length === 0) {
            return this.notice('NOTHING TO TRADE',
                'You need at least two Pokémon — your last one stays with you.');
        }

        this.myCode = status.code;
        this.myName = (status.email || 'Trainer').split('@')[0];
        this.renderLobby();
    }

    notice(title, sub) {
        this.modal.body.innerHTML = `<div class="pvp-notice">
            <p class="pvp-8bit">${title}</p>
            <p class="pvp-sub">${sub}</p>
        </div>`;
    }

    // ─────────────────────────── Lobby ───────────────────────────

    renderLobby() {
        const digits = this.myCode.split('').map(d => `<span class="pvp-digit">${d}</span>`).join('');
        this.modal.body.innerHTML = `
            <div class="pvp-lobby">
                <p class="pvp-8bit">YOUR CODE</p>
                <div class="pvp-code">${digits}</div>
                <p class="pvp-sub">The same code you battle with. Share it to trade.</p>

                <button class="pvp-btn trade-host-btn">OPEN A TRADE</button>

                <div class="pvp-divider"><span>OR</span></div>

                <p class="pvp-8bit small">ENTER THEIR CODE</p>
                <input class="pvp-code-input" inputmode="numeric" maxlength="6" placeholder="000000"/>
                <button class="pvp-btn trade-join-btn">JOIN</button>
                <p class="pvp-error"></p>
            </div>
        `;

        const err = this.modal.body.querySelector('.pvp-error');
        const fail = (m) => { err.textContent = m; err.classList.add('visible'); };

        this.modal.body.querySelector('.trade-host-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            try {
                const res = await this.engine.tradeOpen({ displayName: this.myName });
                if (!res || res.error) throw new Error(res?.error || 'Could not open a trade');
                this.code = res.code; this.role = 'host';
                this.renderWaiting();
                this.startPolling();
            } catch (e) { fail(e.message); }
        });

        this.modal.body.querySelector('.trade-join-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            const code = (this.modal.body.querySelector('.pvp-code-input').value || '').trim();
            if (!/^\d{6}$/.test(code)) return fail('Enter the 6 digits of their code.');
            try {
                const res = await this.engine.tradeJoin(code, { displayName: this.myName });
                if (!res || res.error) throw new Error(res?.error || 'Could not join');
                this.code = code; this.role = 'guest';
                this.startPolling();
            } catch (e) { fail(e.message); }
        });
    }

    renderWaiting() {
        this.modal.body.innerHTML = `
            <div class="pvp-notice">
                <p class="pvp-8bit blink">WAITING...</p>
                <div class="pvp-code">${this.myCode.split('').map(d => `<span class="pvp-digit">${d}</span>`).join('')}</div>
                <p class="pvp-sub">Tell your friend to enter this code.</p>
                <button class="pvp-btn ghost trade-cancel-btn">CANCEL</button>
            </div>`;
        this.modal.body.querySelector('.trade-cancel-btn')
            .addEventListener('click', () => this.leave());
    }

    // ─────────────────────────── Sync loop ───────────────────────────

    startPolling() {
        this.pollingSince = Date.now();
        this.lobbyPolls = 0;
        this.poll();
    }

    stopPolling() {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    async poll() {
        this.stopPolling();
        if (!this.code || this.pollPaused) return;

        try {
            await this.tick();
        } catch {
            // Transient — the next scheduled read retries.
        }

        if (!this.code) return;
        const delay = this.nextPollDelay();
        if (delay === null) return;
        this.pollTimer = setTimeout(() => this.poll(), delay);
    }

    nextPollDelay() {
        const phase = this.remote && this.remote.state && this.remote.state.phase;
        if (phase === 'done' && this.applied) return null;   // nothing left to watch
        if (phase && phase !== 'waiting') return TRADE_POLL_ACTIVE_MS;

        if (Date.now() - this.pollingSince > TRADE_GIVE_UP_MS) {
            this.onTimeout();
            return null;
        }
        return Math.min(TRADE_POLL_MAX_MS,
            Math.round(TRADE_POLL_LOBBY_MS * Math.pow(TRADE_BACKOFF, this.lobbyPolls++)));
    }

    onTimeout() {
        this.stopPolling();
        const code = this.code;
        this.code = null;
        if (this.role === 'host' && code) this.engine.tradeClose(code).catch(() => {});
        if (!this.modal) return;
        this.modal.body.innerHTML = `<div class="pvp-notice">
            <p class="pvp-8bit">NOBODY CAME</p>
            <p class="pvp-sub">The trade closed after five minutes.</p>
            <button class="pvp-btn trade-exit-btn">BACK</button>
        </div>`;
        this.modal.body.querySelector('.trade-exit-btn').addEventListener('click', () => this.open());
    }

    async tick() {
        if (!this.code) return;
        const res = await this.engine.tradeRead(this.code);
        const trade = res && res.trade;
        if (!trade) return this.onPartnerLeft();

        this.remote = trade;
        const st = trade.state || {};
        if (st.phase === 'waiting') return;

        // Sealed: both confirmed. Apply it to this save, once.
        if (st.phase === 'done' && !this.applied) {
            await this.settle(trade);
            return;
        }
        this.renderTable();
    }

    /** Applies the agreed swap locally, then tells the other side it landed. */
    async settle(trade) {
        const st = trade.state;
        const iAmHost = this.role === 'host';
        const mine = iAmHost ? st.hostOffer : st.guestOffer;
        const theirs = iAmHost ? st.guestOffer : st.hostOffer;
        if (!mine || !theirs) return;

        const result = await this.engine.applyTrade(st.tradeId, mine.instanceId, theirs);
        this.applied = true;
        // Acknowledged BEFORE the animation, never after. The other trainer is
        // polling for exactly this, and making them wait out our six seconds of
        // scenery would be rude at best; if this tab is closed mid-scene, the
        // trade has still landed on both sides.
        this.engine.tradeAck(this.code).catch(() => {});

        if (result && result.ok) {
            this.playTradeScene(mine, theirs, () => this.renderResult(result, theirs, mine));
        } else {
            this.renderResult(result, theirs, mine);
        }
    }

    /**
     * The trade animation.
     *
     * The one the games have: each Pokémon is recalled into a ball, the two
     * balls travel the link in opposite directions and cross in the middle,
     * and the one that arrives opens to let the new Pokémon out.
     *
     * Played only AFTER the swap has landed and been acknowledged, so it is
     * pure theatre -- nothing here can fail in a way that costs a Pokémon, and
     * skipping it costs nothing either. It is skippable for that reason: this
     * is a study extension, and a student who has seen it forty times should
     * not have to sit through the forty-first.
     */
    playTradeScene(sent, received, done) {
        const cfg = this.config;
        const sentSp = cfg.getSpeciesById(sent.speciesId);
        const gotSp = cfg.getSpeciesById(received.speciesId);

        // Reduced motion gets the outcome without the journey. Same for a
        // species the roster cannot resolve -- an empty frame is worse than
        // no frame.
        const reduced = typeof window !== 'undefined' && window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced || !sentSp || !gotSp) return done();

        this.modal.body.innerHTML = `
            <div class="trade-scene" role="img"
                 aria-label="${tradeEsc(sentSp.name)} is traded for ${tradeEsc(gotSp.name)}">
                <div class="trade-link"></div>
                <div class="trade-stars">${'<i></i>'.repeat(9)}</div>

                <!-- Leaving: shown, recalled into its ball, then carried right. -->
                <div class="trade-traveller going">
                    <img class="trade-mon" alt=""
                         src="${cfg.getSpriteUrl(sent.speciesId, sent.shiny)}"/>
                    ${this.ballSvg()}
                </div>

                <!-- Arriving: the mirror, ending with the ball opening. -->
                <div class="trade-traveller coming">
                    ${this.ballSvg()}
                    <img class="trade-mon" alt=""
                         src="${cfg.getSpriteUrl(received.speciesId, received.shiny)}"/>
                </div>

                <div class="trade-flash"></div>
                <p class="trade-scene-caption">
                    <span class="trade-cap-a">${tradeEsc(sentSp.name)} is on its way…</span>
                    <span class="trade-cap-b">${tradeEsc(gotSp.name)} arrived!</span>
                </p>
                <button class="trade-skip">SKIP</button>
            </div>`;

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(this.sceneTimer);
            this.sceneTimer = null;
            done();
        };
        // Time-based rather than animationend: the scene has a dozen animated
        // parts and the last one to end is a detail of the stylesheet, not
        // something this file should have to know.
        this.sceneTimer = setTimeout(finish, TRADE_SCENE_MS);
        this.modal.body.querySelector('.trade-skip').addEventListener('click', finish);
    }

    /** The ball both travellers ride in. Drawn, so it needs no image. */
    ballSvg() {
        return `<svg class="trade-ball" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <circle class="tb-bottom" cx="16" cy="16" r="14"/>
            <path class="tb-top" d="M2,16 a14,14 0 0,1 28,0 z"/>
            <rect class="tb-band" x="1" y="14" width="30" height="4"/>
            <circle class="tb-button" cx="16" cy="16" r="4.5"/>
            <circle class="tb-centre" cx="16" cy="16" r="2"/>
        </svg>`;
    }

    onPartnerLeft() {
        this.stopPolling();
        this.code = null;
        if (!this.modal) return;
        // Only alarming if a swap was in flight; otherwise they just walked away.
        this.modal.body.innerHTML = `<div class="pvp-notice">
            <p class="pvp-8bit">TRADE ENDED</p>
            <p class="pvp-sub">The other trainer left. Nothing changed hands.</p>
            <button class="pvp-btn trade-exit-btn">BACK</button>
        </div>`;
        this.modal.body.querySelector('.trade-exit-btn').addEventListener('click', () => this.leave());
    }

    // ─────────────────────────── The table ───────────────────────────

    renderTable() {
        const st = this.remote.state || {};
        const iAmHost = this.role === 'host';
        const myOffer = iAmHost ? st.hostOffer : st.guestOffer;
        const theirOffer = iAmHost ? st.guestOffer : st.hostOffer;
        const iConfirmed = iAmHost ? st.hostConfirmed : st.guestConfirmed;
        const theyConfirmed = iAmHost ? st.guestConfirmed : st.hostConfirmed;
        const theirName = iAmHost ? this.remote.guestName : this.remote.hostName;

        const slot = (offer, who) => {
            if (!offer) {
                return `<div class="trade-slot empty"><span class="trade-slot-empty">—</span>
                        <span class="trade-slot-who">${who}</span></div>`;
            }
            const sp = this.config.getSpeciesById(offer.speciesId);
            return `<div class="trade-slot">
                <img src="${this.config.getSpriteUrl(offer.speciesId, offer.shiny)}"
                     class="${offer.shiny ? 'is-shiny' : ''}" alt="${sp ? sp.name : ''}"/>
                <span class="trade-slot-name">${sp ? sp.name : '???'}${sp && sp.isCustom ? ` ${this.config.CUSTOM_MARK}` : ''}${sp && sp.isLegendary ? ' ★' : ''}${offer.shiny ? ' ✦' : ''}</span>
                <span class="trade-slot-lv">Lv${offer.level}</span>
                <span class="trade-slot-who">${who}</span>
            </div>`;
        };

        const canConfirm = Boolean(myOffer && theirOffer);

        this.modal.body.innerHTML = `
            <div class="trade-table">
                <div class="trade-slots">
                    ${slot(myOffer, 'YOU')}
                    <span class="trade-arrows">⇄</span>
                    ${slot(theirOffer, (theirName || 'THEM').toUpperCase())}
                </div>

                <div class="trade-status">
                    <span class="${iConfirmed ? 'on' : ''}">YOU ${iConfirmed ? '✓' : '…'}</span>
                    <span class="${theyConfirmed ? 'on' : ''}">${(theirName || 'THEM').toUpperCase()} ${theyConfirmed ? '✓' : '…'}</span>
                </div>

                <p class="pvp-8bit small">${myOffer ? 'YOUR OFFER' : 'CHOOSE A POKÉMON'}</p>
                <div class="trade-picker"></div>

                <div class="trade-actions">
                    <button class="pvp-btn trade-confirm-btn" ${canConfirm ? '' : 'disabled'}>
                        ${iConfirmed ? 'WITHDRAW' : 'CONFIRM'}
                    </button>
                    <button class="pvp-btn ghost trade-exit-btn">LEAVE</button>
                </div>
                <p class="pvp-sub trade-hint">${canConfirm
                    ? 'Both must confirm. Changing your offer clears both.'
                    : 'Both trainers need something on the table.'}</p>
            </div>`;

        const picker = this.modal.body.querySelector('.trade-picker');
        picker.innerHTML = this.engine.tradableParty().map(pk => {
            const sp = this.config.getSpeciesById(pk.speciesId);
            if (!sp) return '';
            const chosen = myOffer && myOffer.instanceId === pk.instanceId;
            return `<button class="trade-chip ${chosen ? 'chosen' : ''}" data-instance="${pk.instanceId}"
                            title="${sp.name} Lv.${pk.level}">
                <img src="${this.config.getSpriteUrl(pk.speciesId, pk.shiny)}"
                     class="${pk.shiny ? 'is-shiny' : ''}" alt="${sp.name}"/>
                <span>Lv${pk.level}${sp.isCustom ? ` ${this.config.CUSTOM_MARK}` : ''}${sp.isLegendary ? ' ★' : ''}${pk.shiny ? ' ✦' : ''}</span>
            </button>`;
        }).join('');

        picker.querySelectorAll('.trade-chip').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.instance;
                const pk = this.engine.tradableParty().find(p => p.instanceId === id);
                if (!pk) return;
                // Tapping the one already on the table takes it back.
                const same = myOffer && myOffer.instanceId === id;
                await this.engine.tradeOffer(this.code, same ? null : {
                    instanceId: pk.instanceId, speciesId: pk.speciesId,
                    level: pk.level, totalExp: pk.totalExp, shiny: pk.shiny === true,
                    // Stones travel with the Pokémon, so the offer has to name
                    // them — otherwise the receiver is shown a mega and handed
                    // something that can no longer become one. The receiving
                    // side filters this list against the species it is actually
                    // getting; see sanitizeTradedStones.
                    megaStones: Array.isArray(pk.megaStones) ? pk.megaStones : [],
                });
                this.poll();
            });
        });

        this.modal.body.querySelector('.trade-confirm-btn').addEventListener('click', async (e) => {
            if (e.currentTarget.disabled) return;
            await this.engine.tradeConfirm(this.code, !iConfirmed);
            this.poll();
        });
        this.modal.body.querySelector('.trade-exit-btn')
            .addEventListener('click', () => this.leave());
    }

    renderResult(result, received, given) {
        const rs = this.config.getSpeciesById(received.speciesId);
        const gs = this.config.getSpeciesById(given.speciesId);
        const ok = result && result.ok;

        this.modal.body.innerHTML = `
            <div class="pvp-notice trade-result">
                <p class="pvp-8bit">${ok ? 'TRADE COMPLETE!' : 'TRADE FAILED'}</p>
                ${ok ? `
                    <div class="trade-slots">
                        <div class="trade-slot">
                            <img src="${this.config.getSpriteUrl(received.speciesId, received.shiny)}"
                                 class="${received.shiny ? 'is-shiny' : ''}" alt=""/>
                            <span class="trade-slot-name">${rs ? rs.name : '???'}${rs && rs.isCustom ? ` ${this.config.CUSTOM_MARK}` : ''}${rs && rs.isLegendary ? ' ★' : ''}${received.shiny ? ' ✦' : ''}</span>
                            <span class="trade-slot-lv">Lv${received.level}</span>
                        </div>
                    </div>
                    <p class="pvp-sub">${gs ? gs.name : 'Your Pokémon'} went to a good home.</p>
                ` : `<p class="pvp-sub">Nothing changed hands. Your party is untouched.</p>`}
                <button class="pvp-btn trade-exit-btn">DONE</button>
            </div>`;
        this.modal.body.querySelector('.trade-exit-btn')
            .addEventListener('click', () => this.leave());
    }

    async leave() {
        this.stopPolling();
        const code = this.code;
        this.code = null;
        // Only the host owns the document, and only tear it down once the swap
        // has landed on this side — otherwise a slow partner loses the trade.
        if (code && this.role === 'host') {
            try { await this.engine.tradeClose(code); } catch { /* best effort */ }
        }
        this.role = null; this.remote = null; this.applied = false;
        if (this.modal) this.ui.closeModal(this.modal.overlay);
        this.modal = null;
    }
}

window.FlickemonTrade = FlickemonTrade;
