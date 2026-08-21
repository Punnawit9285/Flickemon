/**
 * Flickémon PVP UI
 * ────────────────
 * An 8-bit battle screen rendered inside the extension. Nothing opens an
 * external page: lobby, matchmaking, battle and result all live in one modal.
 *
 * Turn flow — both clients run this identically:
 *   1. Each player submits an action to battles/{code}.
 *   2. Both poll until both actions for the current turn are present.
 *   3. Both replay the turn locally with seed `code:turn`, so the same rolls
 *      occur on both sides. Whoever notices first writes the result back.
 */

// ─────────────────────────── Read cadence ───────────────────────────
//
// Firestore's free tier allows 50,000 document reads a day across every user,
// and a flat 1.5s loop spends 2,400 of them per player-hour — three trainers
// battling for an hour would burn a seventh of the whole day's budget between
// them. So the loop only runs fast in the one window where the delay is
// actually visible: after I have moved and am waiting on my opponent.
//
// Nothing else can change quickly. A lobby needs a human to read out six
// digits and type them; on my own turn the battle cannot advance at all until
// I act, so a poll there does nothing but notice an opponent walking away.
//
// 2s rather than 1.5s for the fast case: this is a turn-based battle, and the
// move animation in the games it is imitating takes longer than the gap.
const POLL_AWAITING_MS  = 2000;     // they could answer any moment
const POLL_MY_TURN_MS   = 12000;    // only catches them leaving
const POLL_LOBBY_MS     = 2500;     // backs off from here
const POLL_LOBBY_MAX_MS = 15000;
const LOBBY_BACKOFF     = 1.6;
const LOBBY_GIVE_UP_MS  = 300000;   // 5 minutes unanswered, then close the lobby

class FlickemonPvp {
    constructor(engine, ui) {
        this.engine = engine;
        this.ui = ui;
        this.config = window.FlickemonConfig;
        this.B = window.FlickemonBattle;

        this.pollTimer = null;
        this.pollPaused = false;
        this.pollingSince = 0;
        this.lobbyPolls = 0;
        this.code = null;
        this.role = null;      // 'host' | 'guest'
        this.local = null;     // { p1, p2, p1Team, p2Team } from MY perspective
        this.pendingAction = null;
        this.lastTurnRendered = -1;

        // A hidden tab has nobody watching the battle, so reads there are pure
        // waste. Students alt-tab constantly, which makes this a real saving.
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
        const modal = this.ui.createModalOverlay('PVP Battle');
        modal.overlay.classList.add('pvp-overlay');
        this.modal = modal;

        modal.overlay.addEventListener('click', (e) => {
            if (e.target === modal.overlay) this.leave();
        });
        modal.overlay.querySelector('.flickemon-modal-close')
            ?.addEventListener('click', () => this.leave());

        const status = await this.engine.pvpMyCode();
        if (!status || !status.signedIn) {
            modal.body.innerHTML = `<div class="pvp-notice">
                <p class="pvp-8bit">SIGN IN TO BATTLE</p>
                <p class="pvp-sub">PVP needs an account so trainers can find each other.</p>
            </div>`;
            return;
        }

        const team = this.engine.buildPvpTeam();
        if (team.length === 0) {
            modal.body.innerHTML = `<div class="pvp-notice">
                <p class="pvp-8bit">NO TEAM</p>
                <p class="pvp-sub">Pick at least one Pokémon in Game Hub → Party first.</p>
            </div>`;
            return;
        }

        this.myCode = status.code;
        this.myName = (status.email || 'Trainer').split('@')[0];
        this.renderLobby(team);
    }

    // ─────────────────────────── Lobby ───────────────────────────

    renderLobby(team) {
        const digits = this.myCode.split('').map(d => `<span class="pvp-digit">${d}</span>`).join('');
        this.modal.body.innerHTML = `
            <div class="pvp-lobby">
                <p class="pvp-8bit">YOUR CODE</p>
                <div class="pvp-code">${digits}</div>
                <p class="pvp-sub">Share this with a friend so they can challenge you.</p>

                <div class="pvp-team-strip">
                    ${team.map(c => `
                        <div class="pvp-team-chip">
                            <img src="${this.config.getSpriteUrl(c.speciesId)}" alt="${c.name}"/>
                            <span>Lv${c.level}</span>
                        </div>`).join('')}
                </div>

                <button class="pvp-btn pvp-host-btn">WAIT FOR CHALLENGER</button>

                <div class="pvp-divider"><span>OR</span></div>

                <p class="pvp-8bit small">ENTER THEIR CODE</p>
                <input class="pvp-code-input" inputmode="numeric" maxlength="6" placeholder="000000"/>
                <button class="pvp-btn pvp-join-btn">CHALLENGE</button>
                <p class="pvp-error"></p>
            </div>
        `;

        const err = this.modal.body.querySelector('.pvp-error');
        const fail = (m) => { err.textContent = m; err.classList.add('visible'); };

        this.modal.body.querySelector('.pvp-host-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            try {
                const res = await this.engine.pvpOpen({ displayName: this.myName, team });
                if (!res || res.error) throw new Error(res?.error || 'Could not open lobby');
                this.code = res.code; this.role = 'host';
                this.renderWaiting();
                this.startPolling();
            } catch (e) { fail(e.message); }
        });

        this.modal.body.querySelector('.pvp-join-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            const code = (this.modal.body.querySelector('.pvp-code-input').value || '').trim();
            if (!/^\d{6}$/.test(code)) return fail('Enter the 6 digits of their code.');
            try {
                const res = await this.engine.pvpJoin(code, { displayName: this.myName, team });
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
                <button class="pvp-btn ghost pvp-cancel-btn">CANCEL</button>
            </div>`;
        this.modal.body.querySelector('.pvp-cancel-btn').addEventListener('click', () => this.leave());
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

    /**
     * One read, then schedule the next at whatever cadence the current phase
     * deserves. Self-scheduling rather than setInterval so the gap can change
     * between reads, and so a slow response can never stack up requests.
     */
    async poll() {
        this.stopPolling();          // only ever one chain in flight
        if (!this.code || this.pollPaused) return;

        try {
            await this.tick();
        } catch {
            // Transient — the next scheduled read retries.
        }

        if (!this.code) return;      // tick may have ended the battle
        const delay = this.nextPollDelay();
        if (delay === null) return;
        this.pollTimer = setTimeout(() => this.poll(), delay);
    }

    /** How long to wait before the next read, or null to stop reading. */
    nextPollDelay() {
        const phase = this.remote && this.remote.state && this.remote.state.phase;

        if (phase === 'over') return null;            // nothing left to watch
        if (phase === 'battling') {
            return this.pendingAction ? POLL_AWAITING_MS : POLL_MY_TURN_MS;
        }

        // Still in the lobby, waiting for someone to type the code.
        if (Date.now() - this.pollingSince > LOBBY_GIVE_UP_MS) {
            this.onLobbyTimeout();
            return null;
        }
        const delay = POLL_LOBBY_MS * Math.pow(LOBBY_BACKOFF, this.lobbyPolls++);
        return Math.min(POLL_LOBBY_MAX_MS, Math.round(delay));
    }

    /** Nobody came. Closing the lobby also keeps the document out of storage. */
    onLobbyTimeout() {
        this.stopPolling();
        const code = this.code;
        this.code = null;
        if (this.role === 'host' && code) {
            this.engine.pvpClose(code).catch(() => {});
        }
        if (!this.modal) return;
        this.modal.body.innerHTML = `<div class="pvp-notice">
            <p class="pvp-8bit">NO CHALLENGER</p>
            <p class="pvp-sub">Nobody joined in five minutes, so the lobby closed.</p>
            <button class="pvp-btn pvp-retry-btn">TRY AGAIN</button>
        </div>`;
        this.modal.body.querySelector('.pvp-retry-btn')
            .addEventListener('click', () => this.open());
    }

    async tick() {
        if (!this.code) return;
        const res = await this.engine.pvpRead(this.code);
        const battle = res && res.battle;
        if (!battle) return this.onOpponentLeft();

        const st = battle.state || {};
        if (st.phase === 'waiting') return;

        this.remote = battle;
        this.syncLocalFrom(battle);

        // Both actions in for this turn? Resolve it — deterministically, so both
        // clients reach the same outcome without a server arbitrating.
        const ha = st.hostAction, ga = st.guestAction;
        if (st.phase === 'battling' && ha && ga && ha.turn === st.turn && ga.turn === st.turn) {
            await this.resolveTurn(battle);
            return;
        }

        if (st.turn !== this.lastTurnRendered) {
            this.lastTurnRendered = st.turn;
            this.pendingAction = null;
        }
        this.renderBattle();
    }

    /** Rebuilds my view of the battle from the shared document. */
    syncLocalFrom(battle) {
        const st = battle.state || {};
        const iAmHost = this.role === 'host';
        const myTeam  = iAmHost ? st.hostTeam  : st.guestTeam;
        const foeTeam = iAmHost ? st.guestTeam : st.hostTeam;
        if (!myTeam || !foeTeam) return;

        this.local = {
            me: myTeam[st.myActiveIndex ?? 0] || myTeam[0],
            foe: foeTeam[0],
            myTeam, foeTeam,
            log: st.log || [],
            turn: st.turn,
            phase: st.phase,
        };
        // Live copies come from the doc so both sides agree on HP/status.
        this.local.me = (iAmHost ? st.hostActive : st.guestActive) || this.local.me;
        this.local.foe = (iAmHost ? st.guestActive : st.hostActive) || this.local.foe;
    }

    async resolveTurn(battle) {
        const st = battle.state;
        const iAmHost = this.role === 'host';

        // p1 is always the host, on both clients, so the seeded rolls line up.
        const p1 = st.hostActive || st.hostTeam[0];
        const p2 = st.guestActive || st.guestTeam[0];

        const state = {
            p1: JSON.parse(JSON.stringify(p1)),
            p2: JSON.parse(JSON.stringify(p2)),
            p1Team: st.hostTeam,
            p2Team: st.guestTeam,
        };

        const log = this.B.resolveTurn(state, st.hostAction, st.guestAction, `${this.code}:${st.turn}`);

        const next = {
            ...st,
            turn: st.turn + 1,
            hostAction: null,
            guestAction: null,
            hostActive: state.p1,
            guestActive: state.p2,
            log: [...(st.log || []), ...log].slice(-40),
        };

        if (state.p1.hp <= 0 || state.p2.hp <= 0) {
            next.phase = 'over';
            next.winner = state.p1.hp <= 0 ? 'guest' : 'host';
            next.log.push(state.p1.hp <= 0
                ? `${battle.guestName} wins!`
                : `${battle.hostName} wins!`);
        }

        // Both clients compute this; the host writes to avoid a needless double
        // write. The guest still has the result locally either way.
        if (iAmHost) await this.engine.pvpCommit(this.code, next);

        this.remote = { ...battle, state: next };
        this.lastTurnRendered = next.turn;
        this.pendingAction = null;
        this.syncLocalFrom(this.remote);
        this.renderBattle();
    }

    // ─────────────────────────── Battle screen ───────────────────────────

    renderBattle() {
        if (!this.local) return;
        const { me, foe, log, phase } = this.local;
        const st = this.remote?.state || {};

        const hpPct = c => Math.max(0, Math.round((c.hp / c.maxHp) * 100));
        const hpClass = p => p > 50 ? 'ok' : p > 20 ? 'warn' : 'low';
        const badge = c => c.status
            ? `<span class="pvp-status ${c.status}">${this.B.STATUS_LABEL[c.status]}</span>` : '';

        const over = phase === 'over';
        const iWon = over && ((st.winner === 'host') === (this.role === 'host'));

        this.modal.body.innerHTML = `
            <div class="pvp-battle">
                <div class="pvp-field">
                    <div class="pvp-side foe">
                        <div class="pvp-nameplate">
                            <span class="pvp-mon-name">${foe.name}</span>
                            <span class="pvp-mon-lv">Lv${foe.level}</span>${badge(foe)}
                            <div class="pvp-hp"><div class="pvp-hp-fill ${hpClass(hpPct(foe))}" style="width:${hpPct(foe)}%"></div></div>
                        </div>
                        <img class="pvp-sprite foe-sprite" src="${this.config.getSpriteUrl(foe.speciesId)}" alt="${foe.name}"/>
                    </div>
                    <div class="pvp-side mine">
                        <img class="pvp-sprite my-sprite" src="${this.config.getBackSpriteUrl(me.speciesId)}"
                             onerror="this.src='${this.config.getSpriteUrl(me.speciesId)}'" alt="${me.name}"/>
                        <div class="pvp-nameplate">
                            <span class="pvp-mon-name">${me.name}</span>
                            <span class="pvp-mon-lv">Lv${me.level}</span>${badge(me)}
                            <div class="pvp-hp"><div class="pvp-hp-fill ${hpClass(hpPct(me))}" style="width:${hpPct(me)}%"></div></div>
                            <div class="pvp-hp-num">${me.hp}/${me.maxHp}</div>
                        </div>
                    </div>
                </div>

                <div class="pvp-log">${(log || []).slice(-4).map(l => `<div>${l}</div>`).join('')}</div>

                ${over ? `
                    <div class="pvp-result ${iWon ? 'win' : 'lose'}">
                        <p class="pvp-8bit">${iWon ? 'YOU WIN!' : 'YOU LOSE...'}</p>
                        <button class="pvp-btn pvp-exit-btn">BACK</button>
                    </div>
                ` : `
                    <div class="pvp-moves">
                        ${me.moves.map(m => `
                            <button class="pvp-move ${m.type}" data-move="${m.id}"
                                    ${this.pendingAction || m.ppLeft <= 0 ? 'disabled' : ''}>
                                <span class="pvp-move-name">${m.name}</span>
                                <span class="pvp-move-meta">${m.type.toUpperCase()} · ${m.ppLeft}/${m.pp}</span>
                            </button>`).join('')}
                    </div>
                    <p class="pvp-turn">${this.pendingAction ? 'WAITING FOR OPPONENT...' : 'CHOOSE A MOVE'}</p>
                `}
            </div>`;

        this.modal.body.querySelectorAll('.pvp-move').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.disabled) return;
                this.pendingAction = { type: 'move', moveId: btn.dataset.move };
                this.renderBattle();
                try {
                    await this.engine.pvpAction(this.code, this.pendingAction);
                    // They may already be waiting on me — check now rather than
                    // sitting out the 12s my-turn gap that was just in effect.
                    this.poll();
                } catch {
                    this.pendingAction = null;
                    this.renderBattle();
                }
            });
        });

        this.modal.body.querySelector('.pvp-exit-btn')?.addEventListener('click', () => this.leave());
    }

    onOpponentLeft() {
        this.stopPolling();
        if (!this.modal) return;
        this.modal.body.innerHTML = `<div class="pvp-notice">
            <p class="pvp-8bit">BATTLE ENDED</p>
            <p class="pvp-sub">The other trainer left.</p>
            <button class="pvp-btn pvp-exit-btn">BACK</button>
        </div>`;
        this.modal.body.querySelector('.pvp-exit-btn').addEventListener('click', () => this.leave());
    }

    async leave() {
        this.stopPolling();
        if (this.code && this.role === 'host') {
            try { await this.engine.pvpClose(this.code); } catch { /* best effort */ }
        }
        this.code = null; this.role = null; this.local = null;
        if (this.modal) this.ui.closeModal(this.modal.overlay);
        this.modal = null;
    }
}

window.FlickemonPvp = FlickemonPvp;
