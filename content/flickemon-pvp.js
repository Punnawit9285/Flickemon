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
 *      occur on both sides. The host writes the result back; the guest has it
 *      locally either way.
 *
 * Formats (see PVP_MODES in flickemon-config.js) change the team size and the
 * length of the winner's boost. Anything above 1v1 needs a Pokémon to be
 * replaceable when it faints, which is the 'switching' phase below: the turn
 * pauses, whoever lost their active picks a replacement, and play resumes. A
 * side loses when its whole team is down, not on the first faint.
 *
 * Because that rule lives in each client rather than in the document, both
 * players must be running the same PVP_RULES_VERSION — joinBattle refuses the
 * match otherwise rather than letting two builds compute different battles.
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

/** Names reach this screen from the opponent's account, so never raw. */
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
        this.local = null;     // { me, foe, myTeam, foeTeam, ... } from MY perspective
        this.pendingAction = null;
        this.lastTurnRendered = -1;
        this.rewardClaimed = false;
        this.rewardResult = null;

        // Lobby state, kept across re-renders of the lobby screen.
        this.modeId = this.config.DEFAULT_PVP_MODE;
        this.rosterOpen = false;
        this.switchPanelOpen = false;

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

    /** The format this screen is currently working in. */
    get mode() {
        const fromDoc = this.remote && this.remote.state && this.remote.state.mode;
        return this.config.getPvpMode(fromDoc || this.modeId);
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

        if (this.engine.getTeam().length === 0) {
            modal.body.innerHTML = `<div class="pvp-notice">
                <p class="pvp-8bit">NO TEAM</p>
                <p class="pvp-sub">Catch a Pokémon first — you need at least one to battle.</p>
            </div>`;
            return;
        }

        this.myCode = status.code;
        this.myName = (status.email || 'Trainer').split('@')[0];
        this.remote = null;
        this.renderLobby();
    }

    // ─────────────────────────── Lobby ───────────────────────────

    /**
     * The lobby doubles as the team screen.
     *
     * Sending a student to Game Hub → Party to fix their line-up and back again
     * meant losing the code they had just been given, and in a format that only
     * fields one Pokémon the choice of which one is the whole decision. So the
     * roster is editable here, and it edits the same stored team the rest of the
     * game uses rather than a PVP-only copy.
     */
    renderLobby() {
        const mode = this.config.getPvpMode(this.modeId);
        const team = this.engine.buildPvpTeam(this.config.MAX_TEAM_SIZE);
        const digits = this.myCode.split('').map(d => `<span class="pvp-digit">${d}</span>`).join('');

        this.modal.body.innerHTML = `
            <div class="pvp-lobby">
                <p class="pvp-8bit">YOUR CODE</p>
                <div class="pvp-code">${digits}</div>
                <p class="pvp-sub">Share this with a friend so they can challenge you.</p>

                <p class="pvp-8bit small">FORMAT</p>
                <div class="pvp-modes">
                    ${this.config.PVP_MODES.map(m => `
                        <button class="pvp-mode ${m.id === this.modeId ? 'on' : ''}" data-mode="${m.id}">
                            <span class="pvp-mode-label">${m.label}</span>
                            <span class="pvp-mode-reward">${m.rewardLabel} boost</span>
                        </button>`).join('')}
                </div>
                <p class="pvp-sub">${mode.blurb} Winning grants one boost for
                   ${mode.rewardLabel} — boosts never stack, so let one run out
                   before the next win can pay.</p>

                ${this.renderLobbyTeam(mode, team)}

                <button class="pvp-btn pvp-host-btn">WAIT FOR CHALLENGER</button>

                <div class="pvp-divider"><span>OR</span></div>

                <p class="pvp-8bit small">ENTER THEIR CODE</p>
                <p class="pvp-sub">The host picks the format — yours is only used when you host.</p>
                <input class="pvp-code-input" inputmode="numeric" maxlength="6" placeholder="000000"/>
                <button class="pvp-btn pvp-join-btn">CHALLENGE</button>
                <p class="pvp-error"></p>
            </div>
        `;

        this.bindLobby(mode);
    }

    /** The line-up strip, plus the roster editor when it is open. */
    renderLobbyTeam(mode, team) {
        const fielded = team.slice(0, mode.size);
        const benched = team.slice(mode.size);

        const chip = (c, out) => `
            <div class="pvp-team-chip ${out ? 'benched' : ''}" title="${esc(c.name)} Lv${c.level}${out ? ' — benched in this format' : ''}">
                <img src="${this.config.getSpriteUrl(c.speciesId, c.shiny)}" alt="${esc(c.name)}"/>
                <span>Lv${c.level}</span>
            </div>`;

        return `
            <p class="pvp-8bit small">YOUR LINE-UP ${fielded.length}/${mode.size}</p>
            <div class="pvp-team-strip">
                ${fielded.map(c => chip(c, false)).join('')}
                ${benched.map(c => chip(c, true)).join('')}
            </div>
            ${benched.length ? `<p class="pvp-sub">The faded ${benched.length === 1 ? 'one stays' : 'ones stay'}
                behind in ${mode.label} — pick a bigger format or reorder below.</p>` : ''}
            <button class="pvp-btn ghost pvp-roster-btn">${this.rosterOpen ? 'DONE' : 'EDIT TEAM'}</button>
            ${this.rosterOpen ? this.renderRoster() : ''}
        `;
    }

    /**
     * The party, with the same two controls the Game Hub offers: who leads, and
     * who is on the team at all. Leading matters more here than it does there —
     * the team is ordered partner-first, so in 1v1 the partner IS the entrant.
     */
    renderRoster() {
        const party = this.engine.getParty();
        const active = this.engine.getActivePokemon();
        const full = this.engine.isTeamFull();

        // Two of the same species at the same level would be indistinguishable,
        // so number the copies — in party order, so a badge does not move when
        // the list below is sorted differently.
        const copies = new Map();
        party.forEach(pk => copies.set(pk.speciesId, (copies.get(pk.speciesId) || 0) + 1));
        const ordinal = new Map();
        const seen = new Map();
        party.forEach(pk => {
            const n = (seen.get(pk.speciesId) || 0) + 1;
            seen.set(pk.speciesId, n);
            ordinal.set(pk.instanceId, n);
        });

        // Team first, in team order, so the line-up above reads top-down here.
        const teamOrder = this.engine.getTeam();
        const ordered = [...party].sort((a, b) => {
            const ia = teamOrder.indexOf(a.instanceId);
            const ib = teamOrder.indexOf(b.instanceId);
            if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
            return b.level - a.level;
        });

        return `
            <div class="pvp-roster">
                ${ordered.map(pk => {
                    const sp = this.engine.getSpeciesForPokemon(pk);
                    if (!sp) return '';
                    const isActive = active && pk.instanceId === active.instanceId;
                    const onTeam = this.engine.isOnTeam(pk.instanceId);
                    const slot = teamOrder.indexOf(pk.instanceId);
                    const dupe = copies.get(pk.speciesId) > 1
                        ? `<span class="pvp-roster-copy">#${ordinal.get(pk.instanceId)}</span>` : '';
                    return `
                        <div class="pvp-roster-row ${onTeam ? 'on-team' : ''}" data-instance="${esc(pk.instanceId)}">
                            <span class="pvp-roster-slot">${slot >= 0 ? slot + 1 : '·'}</span>
                            <img src="${this.config.getSpriteUrl(sp.id, pk.shiny)}" alt="${esc(sp.name)}"
                                 class="pvp-roster-sprite${pk.shiny ? ' is-shiny' : ''}"/>
                            <span class="pvp-roster-name">
                                ${esc(sp.name)}${dupe}
                                ${sp.isLegendary ? '<span class="pvp-rarity legendary" title="Legendary">★</span>' : ''}
                                ${pk.shiny ? '<span class="pvp-rarity shiny" title="Shiny">✦</span>' : ''}
                                <span class="pvp-roster-lv">Lv${pk.level}</span>
                            </span>
                            <button class="pvp-roster-btn-sm lead-btn ${isActive ? 'on' : ''}"
                                    data-instance="${esc(pk.instanceId)}" ${isActive ? 'disabled' : ''}
                                    title="${isActive ? 'Leads the team' : `Lead with ${esc(sp.name)}`}">⚔</button>
                            <button class="pvp-roster-btn-sm join-btn ${onTeam ? 'on' : ''}"
                                    data-instance="${esc(pk.instanceId)}" ${isActive ? 'disabled' : ''}
                                    title="${isActive ? 'Your lead is always on the team'
                                            : onTeam ? 'Remove from team'
                                            : full ? `Team is full (${this.config.MAX_TEAM_SIZE})` : 'Add to team'}">
                                ${onTeam ? '✓' : '+'}
                            </button>
                        </div>`;
                }).join('')}
            </div>
            <p class="pvp-sub">Slot 1 leads. In ${this.config.getPvpMode(this.modeId).label}
               the first ${this.config.getPvpMode(this.modeId).size} enter the battle.</p>
        `;
    }

    bindLobby(mode) {
        const body = this.modal.body;
        const err = body.querySelector('.pvp-error');
        const fail = (m) => { err.textContent = m; err.classList.add('visible'); };

        body.querySelectorAll('.pvp-mode').forEach(btn => {
            btn.addEventListener('click', () => {
                this.modeId = btn.dataset.mode;
                this.renderLobby();
            });
        });

        body.querySelector('.pvp-roster-btn')?.addEventListener('click', () => {
            this.rosterOpen = !this.rosterOpen;
            this.renderLobby();
        });

        body.querySelectorAll('.lead-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                await this.engine.switchActivePokemon(btn.dataset.instance);
                this.renderLobby();
            });
        });

        body.querySelectorAll('.join-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                const res = await this.engine.toggleTeamMember(btn.dataset.instance);
                if (!res.ok) {
                    fail(res.reason === 'active'
                        ? 'Your lead is always on the team.'
                        : `Your team is full (${this.config.MAX_TEAM_SIZE}). Remove someone first.`);
                    return;
                }
                this.renderLobby();
            });
        });

        body.querySelector('.pvp-host-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            try {
                const team = this.engine.buildPvpTeam(mode.size);
                if (team.length === 0) throw new Error('Add at least one Pokémon to your team.');
                const res = await this.engine.pvpOpen({
                    displayName: this.myName,
                    team,
                    mode: mode.id,
                    rulesVersion: this.config.PVP_RULES_VERSION,
                });
                if (!res || res.error) throw new Error(res?.error || 'Could not open lobby');
                this.code = res.code; this.role = 'host';
                this.renderWaiting(mode);
                this.startPolling();
            } catch (e) { fail(e.message); }
        });

        body.querySelector('.pvp-join-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            const code = (body.querySelector('.pvp-code-input').value || '').trim();
            if (!/^\d{6}$/.test(code)) return fail('Enter the 6 digits of their code.');
            try {
                await this.confirmJoin(code);
            } catch (e) { fail(e.message); }
        });
    }

    /**
     * Look before joining.
     *
     * The host owns the format, so the guest cannot know how many Pokémon they
     * are bringing — or how long a win is worth — until the lobby has been read.
     * One extra read per join, which is rare, buys a guest who is never
     * surprised by a 6v6 they thought was a 1v1.
     */
    async confirmJoin(code) {
        const res = await this.engine.pvpRead(code);
        const battle = res && res.battle;
        if (!battle) throw new Error(`No trainer is waiting on code ${code}.`);
        if (battle.guest && battle.guest !== battle.me) throw new Error('That trainer is already in a battle.');
        if (battle.host === battle.me) throw new Error("That's your own code — share it with someone else.");

        const theirVersion = battle.state?.rulesVersion || 1;
        if (theirVersion !== this.config.PVP_RULES_VERSION) {
            throw new Error(theirVersion < this.config.PVP_RULES_VERSION
                ? 'That trainer is on an older Flickémon. Ask them to update.'
                : 'That trainer is on a newer Flickémon. Update yours to battle them.');
        }

        const mode = this.config.getPvpMode(battle.state?.mode);
        const team = this.engine.buildPvpTeam(mode.size);
        if (team.length === 0) throw new Error('Add at least one Pokémon to your team.');

        this.modal.body.innerHTML = `
            <div class="pvp-notice">
                <p class="pvp-8bit">${esc(battle.hostName)} IS WAITING</p>
                <p class="pvp-8bit small">${mode.label}</p>
                <p class="pvp-sub">${mode.blurb} A win is worth one ${mode.rewardLabel} boost.</p>
                <div class="pvp-team-strip">
                    ${team.map(c => `
                        <div class="pvp-team-chip">
                            <img src="${this.config.getSpriteUrl(c.speciesId, c.shiny)}" alt="${esc(c.name)}"/>
                            <span>Lv${c.level}</span>
                        </div>`).join('')}
                </div>
                ${team.length < mode.size
                    ? `<p class="pvp-sub">You only have ${team.length} of ${mode.size} — you can still
                       battle, but you are a Pokémon down.</p>` : ''}
                <button class="pvp-btn pvp-confirm-btn">BATTLE</button>
                <button class="pvp-btn ghost pvp-back-btn">BACK</button>
                <p class="pvp-error"></p>
            </div>`;

        const err = this.modal.body.querySelector('.pvp-error');
        this.modal.body.querySelector('.pvp-back-btn')
            .addEventListener('click', () => this.renderLobby());
        this.modal.body.querySelector('.pvp-confirm-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            try {
                const joined = await this.engine.pvpJoin(code, {
                    displayName: this.myName,
                    team,
                    rulesVersion: this.config.PVP_RULES_VERSION,
                });
                if (!joined || joined.error) throw new Error(joined?.error || 'Could not join');
                this.code = code; this.role = 'guest';
                this.startPolling();
            } catch (e) {
                err.textContent = e.message;
                err.classList.add('visible');
            }
        });
    }

    renderWaiting(mode) {
        this.modal.body.innerHTML = `
            <div class="pvp-notice">
                <p class="pvp-8bit blink">WAITING...</p>
                <div class="pvp-code">${this.myCode.split('').map(d => `<span class="pvp-digit">${d}</span>`).join('')}</div>
                <p class="pvp-8bit small">${mode.label} · ${mode.rewardLabel} boost</p>
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
        // A replacement is one click away for whoever owes it, so watch closely
        // whenever the wait is on them rather than on me.
        if (phase === 'switching') {
            return this.iMustSwitch() && !this.pendingAction ? POLL_MY_TURN_MS : POLL_AWAITING_MS;
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

        const ha = st.hostAction, ga = st.guestAction;
        const forTurn = a => a && a.turn === st.turn;

        // Both actions in for this turn? Resolve it — deterministically, so both
        // clients reach the same outcome without a server arbitrating.
        if (st.phase === 'battling' && forTurn(ha) && forTurn(ga)) {
            await this.resolveTurn(battle);
            return;
        }

        // A replacement is only owed by the side whose active fainted, so the
        // battle resumes as soon as everyone who owes one has sent it.
        if (st.phase === 'switching') {
            const need = this.sidesOwedSwitch(st);
            const ready = (!need.host || forTurn(ha)) && (!need.guest || forTurn(ga));
            if (ready) {
                await this.applySwitches(battle);
                return;
            }
        }

        if (st.turn !== this.lastTurnRendered) {
            this.lastTurnRendered = st.turn;
            this.pendingAction = null;
        }
        this.renderBattle();
    }

    // ────────────────────── Battle state helpers ──────────────────────

    /** Which sides have a fainted active and someone left to send out. */
    sidesOwedSwitch(st) {
        const owed = (team, index) => {
            const list = team || [];
            const active = list[index ?? 0];
            return !!active && active.hp <= 0 && list.some(c => c.hp > 0);
        };
        return {
            host: owed(st.hostTeam, st.hostIndex),
            guest: owed(st.guestTeam, st.guestIndex),
        };
    }

    iMustSwitch() {
        const st = this.remote && this.remote.state;
        if (!st || st.phase !== 'switching') return false;
        const need = this.sidesOwedSwitch(st);
        return this.role === 'host' ? need.host : need.guest;
    }

    /** Rebuilds my view of the battle from the shared document. */
    syncLocalFrom(battle) {
        const st = battle.state || {};
        const iAmHost = this.role === 'host';
        const myTeam  = iAmHost ? st.hostTeam  : st.guestTeam;
        const foeTeam = iAmHost ? st.guestTeam : st.hostTeam;
        if (!myTeam || !foeTeam) return;

        const myIndex  = (iAmHost ? st.hostIndex  : st.guestIndex) ?? 0;
        const foeIndex = (iAmHost ? st.guestIndex : st.hostIndex) ?? 0;

        // Teams carry live HP in the document, so both sides agree on the state
        // of every Pokémon, not just the two currently out.
        this.local = {
            myTeam, foeTeam, myIndex, foeIndex,
            me: myTeam[myIndex] || myTeam[0],
            foe: foeTeam[foeIndex] || foeTeam[0],
            log: st.log || [],
            turn: st.turn,
            phase: st.phase,
        };
    }

    /**
     * Replays one turn locally and, if I am the host, publishes the result.
     *
     * The teams are cloned whole rather than just the two active Pokémon: damage
     * has to persist on a Pokémon that gets switched out, and the switch logic
     * in the battle core moves `state.p1` to a member of `state.p1Team`, so the
     * active must be a reference into that array rather than a copy of it.
     */
    async resolveTurn(battle) {
        const st = battle.state;
        const iAmHost = this.role === 'host';

        // p1 is always the host, on both clients, so the seeded rolls line up.
        const p1Team = JSON.parse(JSON.stringify(st.hostTeam));
        const p2Team = JSON.parse(JSON.stringify(st.guestTeam));
        const state = {
            p1Team, p2Team,
            p1: p1Team[st.hostIndex ?? 0],
            p2: p2Team[st.guestIndex ?? 0],
        };

        const log = this.B.resolveTurn(state, st.hostAction, st.guestAction, `${this.code}:${st.turn}`);

        const next = {
            ...st,
            turn: st.turn + 1,
            hostAction: null,
            guestAction: null,
            hostTeam: p1Team,
            guestTeam: p2Team,
            // A voluntary switch moves the active, so read the index back off
            // the arrays rather than assuming it is unchanged.
            hostIndex: Math.max(0, p1Team.indexOf(state.p1)),
            guestIndex: Math.max(0, p2Team.indexOf(state.p2)),
            log: [...(st.log || []), ...log].slice(-40),
        };

        // A side is beaten when its whole team is down — the first faint only
        // ends the match in 1v1, where there is nobody left to send out.
        const hostAlive  = p1Team.some(c => c.hp > 0);
        const guestAlive = p2Team.some(c => c.hp > 0);

        if (!hostAlive || !guestAlive) {
            next.phase = 'over';
            next.winner = !hostAlive ? 'guest' : 'host';
            next.log.push(!hostAlive
                ? `${battle.guestName} wins!`
                : `${battle.hostName} wins!`);
        } else {
            const owed = this.sidesOwedSwitch(next);
            if (owed.host || owed.guest) {
                next.phase = 'switching';
                next.log.push(owed.host && owed.guest
                    ? 'Both trainers must send out another Pokémon!'
                    : `${owed.host ? battle.hostName : battle.guestName} must send out another Pokémon!`);
            }
        }

        // Both clients compute this; the host writes to avoid a needless double
        // write. The guest still has the result locally either way.
        if (iAmHost) await this.engine.pvpCommit(this.code, next);

        this.commitLocal(battle, next);
    }

    /**
     * Puts the chosen replacements on the field and resumes.
     *
     * Kept out of the battle core deliberately: it consumes no rng() call, so a
     * faint cannot shift the roll sequence that the rest of the match depends on.
     */
    async applySwitches(battle) {
        const st = battle.state;
        const iAmHost = this.role === 'host';

        const hostTeam  = JSON.parse(JSON.stringify(st.hostTeam));
        const guestTeam = JSON.parse(JSON.stringify(st.guestTeam));
        const need = this.sidesOwedSwitch(st);
        const log = [];

        const place = (team, currentIndex, action, name) => {
            if (!action || action.type !== 'switchIn') return currentIndex;
            const picked = team[action.index];
            // Falling back to the first survivor keeps the battle moving if the
            // chosen Pokémon fainted in the same turn the request was written.
            const index = picked && picked.hp > 0
                ? action.index
                : team.findIndex(c => c.hp > 0);
            if (index < 0) return currentIndex;
            log.push(`${name} sent out ${team[index].name}!`);
            return index;
        };

        const hostIndex = need.host
            ? place(hostTeam, st.hostIndex ?? 0, st.hostAction, battle.hostName)
            : (st.hostIndex ?? 0);
        const guestIndex = need.guest
            ? place(guestTeam, st.guestIndex ?? 0, st.guestAction, battle.guestName)
            : (st.guestIndex ?? 0);

        const next = {
            ...st,
            phase: 'battling',
            turn: st.turn + 1,
            hostAction: null,
            guestAction: null,
            hostTeam, guestTeam,
            hostIndex, guestIndex,
            log: [...(st.log || []), ...log].slice(-40),
        };

        if (iAmHost) await this.engine.pvpCommit(this.code, next);

        this.commitLocal(battle, next);
    }

    /** Adopt a freshly computed state as my own view and redraw. */
    commitLocal(battle, next) {
        this.remote = { ...battle, state: next };
        this.lastTurnRendered = next.turn;
        this.pendingAction = null;
        this.switchPanelOpen = false;
        this.syncLocalFrom(this.remote);
        this.renderBattle();
    }

    // ─────────────────────────── Battle screen ───────────────────────────

    renderBattle() {
        if (!this.local) return;
        const { me, foe, log, phase, myTeam, foeTeam, myIndex, foeIndex } = this.local;
        const st = this.remote?.state || {};
        const mode = this.mode;

        const hpPct = c => Math.max(0, Math.round((c.hp / c.maxHp) * 100));
        const hpClass = p => p > 50 ? 'ok' : p > 20 ? 'warn' : 'low';
        const badge = c => c.status
            ? `<span class="pvp-status ${c.status}">${this.B.STATUS_LABEL[c.status]}</span>` : '';
        // Worth knowing what you are up against before choosing a move.
        const rarity = c => `${c.legendary ? '<span class="pvp-rarity legendary" title="Legendary">★</span>' : ''}`
                          + `${c.shiny ? '<span class="pvp-rarity shiny" title="Shiny">✦</span>' : ''}`;

        const over = phase === 'over';
        const iWon = over && ((st.winner === 'host') === (this.role === 'host'));

        // Claim the victory reward once, on the first render that shows a win.
        // renderBattle runs on every poll, so the flag is what keeps a single
        // win from being claimed repeatedly. The format sets how long it runs.
        if (iWon && !this.rewardClaimed) {
            this.rewardClaimed = true;
            this.engine.grantPvpReward(mode.rewardMs)
                .then(res => { this.rewardResult = res; this.renderBattle(); })
                .catch(() => {});
        }

        this.modal.body.innerHTML = `
            <div class="pvp-battle">
                <div class="pvp-mode-tag">${mode.label}</div>
                <div class="pvp-field">
                    <div class="pvp-side foe">
                        <div class="pvp-nameplate">
                            ${this.renderBalls(foeTeam, foeIndex)}
                            <span class="pvp-mon-name">${esc(foe.name)}</span>
                            <span class="pvp-mon-lv">Lv${foe.level}</span>${rarity(foe)}${badge(foe)}
                            <div class="pvp-hp"><div class="pvp-hp-fill ${hpClass(hpPct(foe))}" style="width:${hpPct(foe)}%"></div></div>
                        </div>
                        <img class="pvp-sprite foe-sprite${foe.shiny ? ' is-shiny' : ''}" src="${this.config.getSpriteUrl(foe.speciesId, foe.shiny)}" alt="${esc(foe.name)}"/>
                    </div>
                    <div class="pvp-side mine">
                        <img class="pvp-sprite my-sprite${me.shiny ? ' is-shiny' : ''}" src="${this.config.getBackSpriteUrl(me.speciesId, me.shiny)}"
                             onerror="this.src='${this.config.getSpriteUrl(me.speciesId, me.shiny)}'" alt="${esc(me.name)}"/>
                        <div class="pvp-nameplate">
                            ${this.renderBalls(myTeam, myIndex)}
                            <span class="pvp-mon-name">${esc(me.name)}</span>
                            <span class="pvp-mon-lv">Lv${me.level}</span>${rarity(me)}${badge(me)}
                            <div class="pvp-hp"><div class="pvp-hp-fill ${hpClass(hpPct(me))}" style="width:${hpPct(me)}%"></div></div>
                            <div class="pvp-hp-num">${me.hp}/${me.maxHp}</div>
                        </div>
                    </div>
                </div>

                <div class="pvp-log">${(log || []).slice(-4).map(l => `<div>${esc(l)}</div>`).join('')}</div>

                ${over ? `
                    <div class="pvp-result ${iWon ? 'win' : 'lose'}">
                        <p class="pvp-8bit">${iWon ? 'YOU WIN!' : 'YOU LOSE...'}</p>
                        ${iWon ? this.renderRewardNotice() : ''}
                        <button class="pvp-btn pvp-exit-btn">BACK</button>
                    </div>
                ` : this.renderActions(me, myTeam, myIndex, phase)}
            </div>`;

        this.bindBattle();
    }

    /** One marker per Pokémon: filled if it can still fight, hollow if it can't. */
    renderBalls(team, index) {
        if (!team || team.length < 2) return '';
        return `<span class="pvp-balls">${team.map((c, i) => {
            const cls = c.hp <= 0 ? 'out' : i === index ? 'active' : 'ready';
            return `<span class="pvp-ball ${cls}" title="${esc(c.name)} ${c.hp <= 0 ? '— fainted' : `${c.hp}/${c.maxHp}`}"></span>`;
        }).join('')}</span>`;
    }

    /** Moves, a forced replacement, or a wait — whichever the phase calls for. */
    renderActions(me, myTeam, myIndex, phase) {
        const bench = (myTeam || [])
            .map((c, i) => ({ c, i }))
            .filter(({ c, i }) => i !== myIndex && c.hp > 0);

        if (phase === 'switching') {
            if (!this.iMustSwitch()) {
                return `<p class="pvp-turn">WAITING FOR OPPONENT...</p>`;
            }
            return `
                <p class="pvp-8bit small">${esc(me.name)} FAINTED — CHOOSE THE NEXT</p>
                ${this.renderBench(bench, 'switchin-btn')}
            `;
        }

        if (this.switchPanelOpen) {
            return `
                <p class="pvp-8bit small">SWITCH — COSTS YOUR TURN</p>
                ${this.renderBench(bench, 'switch-btn')}
                <button class="pvp-btn ghost pvp-cancel-switch">BACK TO MOVES</button>
            `;
        }

        return `
            <div class="pvp-moves">
                ${me.moves.map(m => `
                    <button class="pvp-move ${m.type}" data-move="${m.id}"
                            ${this.pendingAction || m.ppLeft <= 0 ? 'disabled' : ''}>
                        <span class="pvp-move-name">${esc(m.name)}</span>
                        <span class="pvp-move-meta">${m.type.toUpperCase()} · ${m.ppLeft}/${m.pp}</span>
                    </button>`).join('')}
            </div>
            ${bench.length ? `
                <button class="pvp-btn ghost pvp-switch-open" ${this.pendingAction ? 'disabled' : ''}>
                    SWITCH (${bench.length})
                </button>` : ''}
            <p class="pvp-turn">${this.pendingAction ? 'WAITING FOR OPPONENT...' : 'CHOOSE A MOVE'}</p>
        `;
    }

    renderBench(bench, btnClass) {
        if (bench.length === 0) return `<p class="pvp-turn">Nobody left to send out.</p>`;
        return `<div class="pvp-bench">
            ${bench.map(({ c, i }) => `
                <button class="pvp-bench-mon ${btnClass}" data-index="${i}" ${this.pendingAction ? 'disabled' : ''}>
                    <img src="${this.config.getSpriteUrl(c.speciesId, c.shiny)}" alt="${esc(c.name)}"/>
                    <span class="pvp-bench-name">${esc(c.name)}</span>
                    <span class="pvp-bench-hp">${c.hp}/${c.maxHp}</span>
                </button>`).join('')}
        </div>`;
    }

    bindBattle() {
        const body = this.modal.body;

        body.querySelectorAll('.pvp-move').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                this.send({ type: 'move', moveId: btn.dataset.move });
            });
        });

        body.querySelector('.pvp-switch-open')?.addEventListener('click', () => {
            if (this.pendingAction) return;
            this.switchPanelOpen = true;
            this.renderBattle();
        });
        body.querySelector('.pvp-cancel-switch')?.addEventListener('click', () => {
            this.switchPanelOpen = false;
            this.renderBattle();
        });

        body.querySelectorAll('.switch-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                this.send({ type: 'switch', index: Number(btn.dataset.index) });
            });
        });
        body.querySelectorAll('.switchin-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                this.send({ type: 'switchIn', index: Number(btn.dataset.index) });
            });
        });

        body.querySelector('.pvp-exit-btn')?.addEventListener('click', () => this.leave());
    }

    /** Publish my action for this turn, then look at once for the opponent's. */
    async send(action) {
        this.pendingAction = action;
        this.switchPanelOpen = false;
        this.renderBattle();
        try {
            await this.engine.pvpAction(this.code, this.pendingAction);
            // They may already be waiting on me — check now rather than sitting
            // out the 12s my-turn gap that was just in effect.
            this.poll();
        } catch {
            this.pendingAction = null;
            this.renderBattle();
        }
    }

    /** The prize, or an honest explanation of why there isn't one. */
    renderRewardNotice() {
        const res = this.rewardResult;
        if (!res) return '<p class="pvp-sub">Claiming your reward…</p>';

        const info = this.config.REWARD_INFO[res.reward && res.reward.type];
        if (!info) return '';

        if (!res.granted) {
            const mins = Math.ceil((res.reward.msLeft || 0) / 60000);
            return `<div class="pvp-reward held">
                <p class="pvp-8bit small">${info.icon} ${info.label} STILL RUNNING</p>
                <p class="pvp-sub">${mins} min left. One boost at a time — go and spend it
                on a lecture, and the next win can grant another.</p>
            </div>`;
        }

        return `<div class="pvp-reward won">
            <p class="pvp-8bit small">${info.icon} ${info.label}</p>
            <p class="pvp-sub">${info.detail} Runs for ${this.mode.rewardLabel}.</p>
        </div>`;
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
        this.code = null; this.role = null; this.local = null; this.remote = null;
        if (this.modal) this.ui.closeModal(this.modal.overlay);
        this.modal = null;
    }
}

window.FlickemonPvp = FlickemonPvp;
