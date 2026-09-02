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
        this.clockTimer = null;
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
        this.musicOn = false;      // is the battle theme ours to hand back?

        // Lobby state, kept across re-renders of the lobby screen.
        this.modeId = this.config.DEFAULT_PVP_MODE;
        this.rosterOpen = false;
        this.megaInfoOpen = false;
        this.rosterFilter = '';
        this.lossRecorded = false;
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
        this.startClock();

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

        if (this.engine.getPvpTeam().length === 0) {
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
                    ${this.config.PVP_MODES.map(m => {
                        // Say up front which formats are out of reach. Finding
                        // out on the Host button, after picking one, is a worse
                        // way to learn you are two Pokémon short.
                        const fit = this.engine.canFieldPvpMode(m.id);
                        return `
                        <button class="pvp-mode ${m.id === this.modeId ? 'on' : ''}${fit.ok ? '' : ' short'}"
                                data-mode="${m.id}"
                                title="${fit.ok ? m.blurb : `Needs ${fit.need} Pokémon — you have ${fit.have}`}">
                            <span class="pvp-mode-label">${m.label}</span>
                            <span class="pvp-mode-reward">${fit.ok
                                ? `${m.rewardLabel} boost`
                                : `need ${fit.need}, have ${fit.have}`}</span>
                        </button>`;
                    }).join('')}
                </div>
                <p class="pvp-sub">${mode.blurb} Winning grants one boost for
                   ${mode.rewardLabel} — boosts never stack, so let one run out
                   before the next win can pay.</p>

                ${this.renderLobbyTeam(mode, team)}

                ${this.renderPrizeList(mode)}

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

        // `spriteId` is the mega form when one is active and equals speciesId
        // otherwise, so the fallback covers documents written before megas.
        const chip = (c, out) => `
            <div class="pvp-team-chip ${out ? 'benched' : ''} ${c.megaForm ? 'is-mega' : ''}" title="${esc(c.name)} Lv${c.level}${out ? ' — benched in this format' : ''}">
                <img src="${this.config.getSpriteUrl(c.spriteId ?? c.speciesId, c.shiny)}" alt="${esc(c.name)}"/>
                <span>Lv${c.level}</span>
            </div>`;

        return `
            <p class="pvp-8bit small">YOUR PVP LINE-UP ${fielded.length}/${mode.size}</p>
            <div class="pvp-team-strip">
                ${fielded.map(c => chip(c, false)).join('')}
                ${benched.map(c => chip(c, true)).join('')}
            </div>
            ${benched.length ? `<p class="pvp-sub">The faded ${benched.length === 1 ? 'one stays' : 'ones stay'}
                behind in ${mode.label} — pick a bigger format or reorder below.</p>` : ''}
            <button class="pvp-btn ghost pvp-roster-btn">${this.rosterOpen ? 'DONE' : 'EDIT LINE-UP'}</button>
            ${this.rosterOpen ? this.renderRoster() : ''}
        `;
    }

    /**
     * Every Pokémon in the party, not just the six sharing study EXP.
     *
     * A battle line-up is picked to answer whoever is in front of you, and the
     * right answer is regularly a Pokémon that has no business soaking up EXP
     * all day — so the whole party is selectable here. The EXP six are listed
     * first anyway, because they are who a student thinks of as "my team".
     *
     * There is no lead button. Choosing the lead by promoting a Pokémon to
     * active partner changed who earned EXP for the rest of the day, which is
     * a heavy side effect for a decision about one battle. Slot 1 leads, and
     * slot 1 is whoever was added first.
     */
    renderRoster() {
        const party = this.engine.getParty();
        const pvpTeam = this.engine.getPvpTeam();
        const expTeam = this.engine.getTeam();
        const full = this.engine.isPvpTeamFull();
        const mode = this.config.getPvpMode(this.modeId);

        // Two of the same species at the same level would be indistinguishable,
        // so number the copies — in party order, so a badge does not move when
        // the list below is sorted or filtered differently.
        const copies = new Map();
        party.forEach(pk => copies.set(pk.speciesId, (copies.get(pk.speciesId) || 0) + 1));
        const ordinal = new Map();
        const seen = new Map();
        party.forEach(pk => {
            const n = (seen.get(pk.speciesId) || 0) + 1;
            seen.set(pk.speciesId, n);
            ordinal.set(pk.instanceId, n);
        });

        // Picked line-up first in slot order, then the EXP team, then the rest
        // of the party by level. So the two groups a student already has a name
        // for sit at the top, and the long tail is still reachable below.
        const group = (id) => {
            const p = pvpTeam.indexOf(id);
            if (p >= 0) return [0, p];
            const e = expTeam.indexOf(id);
            if (e >= 0) return [1, e];
            return [2, 0];
        };

        const needle = this.rosterFilter.trim().toLowerCase();
        const rows = party
            .map(pk => ({ pk, sp: this.engine.getSpeciesForPokemon(pk) }))
            .filter(({ sp }) => sp && (!needle || sp.name.toLowerCase().includes(needle)))
            .sort((a, b) => {
                const [ga, ia] = group(a.pk.instanceId);
                const [gb, ib] = group(b.pk.instanceId);
                if (ga !== gb) return ga - gb;
                if (ia !== ib) return ia - ib;
                return b.pk.level - a.pk.level;
            });

        return `
            ${party.length > 12 ? `<input class="pvp-roster-filter" placeholder="Search your party..."
                       value="${esc(this.rosterFilter)}"/>` : ''}
            <div class="pvp-roster">
                ${rows.length === 0 ? '<p class="pvp-sub pvp-roster-empty">Nothing matches that name.</p>' : ''}
                ${rows.map(({ pk, sp }) => {
                    const slot = pvpTeam.indexOf(pk.instanceId);
                    const onTeam = slot >= 0;
                    const onExpTeam = expTeam.includes(pk.instanceId);
                    const benched = onTeam && slot >= mode.size;
                    const dupe = copies.get(pk.speciesId) > 1
                        ? `<span class="pvp-roster-copy">#${ordinal.get(pk.instanceId)}</span>` : '';
                    return `
                        <div class="pvp-roster-row ${onTeam ? 'on-team' : ''} ${benched ? 'benched' : ''}"
                             data-instance="${esc(pk.instanceId)}">
                            <span class="pvp-roster-slot">${onTeam ? slot + 1 : '·'}</span>
                            <img src="${this.config.getSpriteUrl(this.engine.spriteIdFor(pk), pk.shiny)}" alt="${esc(sp.name)}"
                                 loading="lazy"
                                 class="pvp-roster-sprite${pk.shiny ? ' is-shiny' : ''}${this.engine.activeMegaForm(pk) ? ' is-mega' : ''}"/>
                            <span class="pvp-roster-name">
                                ${esc(sp.name)}${dupe}
                                ${sp.isCustom ? `<span class="pvp-rarity custom" title="${esc(this.config.CUSTOM_LABEL)}">${this.config.CUSTOM_MARK}</span>` : ''}
                                ${sp.isLegendary ? '<span class="pvp-rarity legendary" title="Legendary">★</span>' : ''}
                                ${pk.shiny ? '<span class="pvp-rarity shiny" title="Shiny">✦</span>' : ''}
                                ${this.engine.activeMegaForm(pk) ? `<span class="pvp-rarity mega" title="${esc(this.engine.activeMegaForm(pk).name)}">◆</span>` : ''}
                                <span class="pvp-roster-lv">Lv${pk.level}</span>
                                ${onExpTeam ? '<span class="pvp-roster-tag" title="Also on your EXP team">EXP</span>' : ''}
                            </span>
                            <button class="pvp-roster-btn-sm join-btn ${onTeam ? 'on' : ''}"
                                    data-instance="${esc(pk.instanceId)}"
                                    title="${onTeam ? 'Remove from the line-up'
                                            : full ? `Line-up is full (${this.config.MAX_TEAM_SIZE})` : 'Add to the line-up'}">
                                ${onTeam ? '\u2713' : '+'}
                            </button>
                        </div>`;
                }).join('')}
            </div>
            <p class="pvp-sub">Slot 1 leads, and slots run in the order you added them —
               remove and re-add to move someone. In ${mode.label} the first
               ${mode.size} enter the battle. This line-up is only used for PVP;
               your EXP team is untouched.</p>
        `;
    }

    /**
     * What a win is actually worth.
     *
     * All three were previously a surprise revealed on the results screen,
     * which made "is this match worth playing" impossible to answer before
     * playing it. The draw is still random — naming the three does not make it
     * a choice — but the student can now see the whole prize table, how long
     * this format runs it for, and whether they are eligible at all.
     */
    renderPrizeList(mode) {
        const lockMs = this.engine.getRewardLock();
        const running = this.engine.getActiveReward();

        const boostPct = Math.round((1 - this.config.MEGA_STONE_CHANCE) / 3 * 100);
        const stonePct = Math.round(this.config.MEGA_STONE_CHANCE * 100);

        const open = this.megaInfoOpen;

        return `
            <div class="pvp-prizes">
                <p class="pvp-8bit small">WIN ONE OF THESE</p>
                <div class="pvp-prize-board">
                    <div class="pvp-prize-row">
                        ${Object.values(this.config.REWARDS).map(type => {
                            const info = this.config.REWARD_INFO[type];
                            return `
                                <div class="pvp-prize">
                                    <span class="pvp-prize-odds">${boostPct}%</span>
                                    <span class="pvp-prize-icon">${info.icon}</span>
                                    <span class="pvp-prize-label">${info.label}</span>
                                    <span class="pvp-prize-detail">${info.detail}</span>
                                    <span class="pvp-prize-dur">${mode.rewardLabel}</span>
                                </div>`;
                        }).join('')}
                    </div>
                    <button type="button" class="pvp-mega-bar${open ? ' is-open' : ''}"
                            aria-expanded="${open}"
                            title="${open ? 'Hide' : 'Show'} how Mega Stones work">
                        <span class="pvp-mega-bar-odds">${stonePct}%</span>
                        <span class="pvp-mega-bar-icon">${this.config.MEGA_STONE_SVG}</span>
                        <span class="pvp-mega-bar-label">Mega Stone</span>
                        <span class="pvp-mega-bar-dur">permanent</span>
                        <span class="pvp-mega-bar-caret">${open ? '▾' : '▸'}</span>
                    </button>
                    ${open ? `<div class="pvp-mega-info">${this.renderStoneRules()}</div>` : ''}
                </div>
                <p class="pvp-sub">One prize per win, drawn at random.</p>
                ${lockMs > 0 ? `
                    <p class="pvp-lock pvp-lock-timer">⛔ You lost recently — wins pay nothing for
                       <span class="pvp-lock-left">${this.config.formatCountdown(lockMs)}</span>.</p>` : ''}
                ${running ? `
                    <p class="pvp-lock pvp-boost-timer">${this.config.REWARD_INFO[running.type].icon}
                       ${this.config.REWARD_INFO[running.type].label} is already running
                       (<span class="pvp-boost-left">${this.config.formatCountdown(running.msLeft)}</span> left).
                       Boosts never stack, so a win now earns nothing.</p>` : ''}
            </div>`;
    }

    /**
     * How the stone works, revealed on demand.
     *
     * This used to sit open under the prize table, five lines of rules for the
     * one prize in four. That made the board read as mostly-mega when the
     * common case is a boost. Behind the bar it is one click away for the
     * player who has just won their first stone and wants to know what it is.
     */
    renderStoneRules() {
        const mult = this.config.MEGA_DAMAGE_MULTIPLIER;
        return `
            <ul class="pvp-mega-rules">
                <li>Binds to one Pokémon in your line-up, picked at random. It never expires.</li>
                <li>That Pokémon wears its Mega form and deals <b>${mult}x damage</b>
                    while studying and in PVP. Switch it on and off any time from the Party tab.</li>
                <li>A stone can land even while a boost is running — only boosts refuse
                    to stack. A loss lockout still blocks both.</li>
                <li>Only a fully evolved Pokémon can use one. Won by one that is not,
                    the stone is kept and waits for it to evolve.</li>
                <li>Some Pokémon have two Mega forms. Win a second stone for one of them
                    and you are given the other.</li>
            </ul>
            ${this.renderStoneOutlook()}`;
    }

    /**
     * Whether the 10% can actually pay out, and to whom.
     *
     * A line-up of Pokémon with no mega anywhere in their lines re-rolls into a
     * boost, and a line-up that already holds every stone does the same. Both
     * are invisible without saying so — the player would just see the stone
     * chance never landing and assume it was bad luck.
     */
    renderStoneOutlook() {
        const party = this.engine.getParty();
        let eligible = 0, maxed = 0, noMega = 0;
        for (const id of this.engine.getPvpTeam()) {
            const m = party.find(p => p.instanceId === id);
            if (!m) continue;
            const source = this.config.megaSourceFor(m.speciesId);
            if (source === null) { noMega++; continue; }
            const missing = this.config.megaFormsFor(source)
                .filter(f => !(m.megaStones || []).includes(f.key));
            if (missing.length) eligible++; else maxed++;
        }
        if (eligible > 0) {
            return `<p class="pvp-sub">${eligible} of your line-up
                    ${eligible === 1 ? 'is' : 'are'} still in line for a stone.</p>`;
        }
        if (maxed > 0) {
            return `<p class="pvp-lock">Your whole line-up already holds every stone
                    it can — the 10% will pay a boost instead.</p>`;
        }
        return `<p class="pvp-lock">None of your ${noMega} line-up
                ${noMega === 1 ? 'member has' : 'members have'} a Mega form in
                ${noMega === 1 ? 'its' : 'their'} line — the 10% will pay a boost instead.</p>`;
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

        body.querySelector('.pvp-mega-bar')?.addEventListener('click', () => {
            this.megaInfoOpen = !this.megaInfoOpen;
            this.renderLobby();
        });

        body.querySelector('.pvp-roster-btn')?.addEventListener('click', () => {
            this.rosterOpen = !this.rosterOpen;
            this.renderLobby();
        });

        // Re-rendering on every keystroke would drop focus, so put the caret
        // back where the student left it.
        const filter = body.querySelector('.pvp-roster-filter');
        filter?.addEventListener('input', () => {
            this.rosterFilter = filter.value;
            const caret = filter.selectionStart;
            this.renderLobby();
            const again = this.modal.body.querySelector('.pvp-roster-filter');
            if (again) { again.focus(); again.setSelectionRange(caret, caret); }
        });

        body.querySelectorAll('.join-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                const res = await this.engine.togglePvpTeamMember(btn.dataset.instance);
                if (!res.ok) {
                    fail(res.reason === 'last'
                        ? 'Keep at least one Pokémon in the line-up.'
                        : res.reason === 'full'
                        ? `Your line-up is full (${this.config.MAX_TEAM_SIZE}). Remove someone first.`
                        : 'That Pokémon is not in your party.');
                    return;
                }
                this.renderLobby();
            });
        });

        body.querySelector('.pvp-host-btn').addEventListener('click', async () => {
            err.classList.remove('visible');
            try {
                const fit = this.engine.canFieldPvpMode(mode.id);
                if (!fit.ok) {
                    throw new Error(`${mode.label} needs ${fit.need} Pokémon on your team — you have ${fit.have}.`);
                }
                const team = this.engine.buildPvpTeam(mode.size);
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
        // The host chose the format, so the guest is the one who has to be told
        // they cannot meet it — and told before anything is written.
        const fit = this.engine.canFieldPvpMode(mode.id);
        if (!fit.ok) {
            throw new Error(`They opened a ${mode.label}. That needs ${fit.need} Pokémon on your team — you have ${fit.have}.`);
        }
        const team = this.engine.buildPvpTeam(mode.size);

        this.modal.body.innerHTML = `
            <div class="pvp-notice">
                <p class="pvp-8bit">${esc(battle.hostName)} IS WAITING</p>
                <p class="pvp-8bit small">${mode.label}</p>
                <p class="pvp-sub">${mode.blurb} A win is worth one ${mode.rewardLabel} boost.</p>
                <div class="pvp-team-strip">
                    ${team.map(c => `
                        <div class="pvp-team-chip ${c.megaForm ? 'is-mega' : ''}">
                            <img src="${this.config.getSpriteUrl(c.spriteId ?? c.speciesId, c.shiny)}" alt="${esc(c.name)}"/>
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

    // ────────────────────────── Countdowns ──────────────────────────

    /**
     * Drives every countdown on the PVP screen.
     *
     * The loss penalty is shown here rather than on the widget on purpose. It
     * is the one number a student has no way to act on — no amount of studying
     * shortens it — so putting it beside the lecture would be a clock to stare
     * at instead of the video. Here it is only in front of the person who came
     * looking for a battle, which is exactly who needs to know a win pays
     * nothing yet.
     *
     * Unlike polling this keeps running while the tab is hidden: it costs one
     * timer and no network, and a clock that resumes stale reads as broken.
     */
    startClock() {
        clearInterval(this.clockTimer);
        this.clockTimer = setInterval(() => this.paintClocks(), 1000);
    }

    /** One second, patched into whichever screen is currently up. */
    paintClocks() {
        if (!this.modal) {
            clearInterval(this.clockTimer);
            this.clockTimer = null;
            return;
        }

        const boostEls = this.modal.body.querySelectorAll('.pvp-boost-left');
        if (boostEls.length) {
            const running = this.engine.getActiveReward();
            if (running) {
                boostEls.forEach(el => {
                    el.textContent = this.config.formatCountdown(running.msLeft);
                });
            } else {
                // Ran out while this screen was open — which is the moment a win
                // starts paying again, so say that rather than leave a sentence
                // about a boost that has ended written in the present tense.
                this.modal.body.querySelectorAll('.pvp-boost-timer').forEach(el => {
                    el.classList.remove('pvp-lock');
                    el.classList.add('pvp-lock-cleared');
                    el.textContent = '✅ Boost finished — the next win can grant another.';
                });
            }
        }

        const lockEls = this.modal.body.querySelectorAll('.pvp-lock-left');
        if (!lockEls.length) return;

        const msLeft = this.engine.getRewardLock();
        if (msLeft > 0) {
            lockEls.forEach(el => { el.textContent = this.config.formatCountdown(msLeft); });
            return;
        }

        // Served its time. The line is rewritten in place rather than the
        // screen re-rendered: this can fire over a finished battle the student
        // is still reading, and throwing that away to clear a warning would be
        // the more annoying bug.
        this.modal.body.querySelectorAll('.pvp-lock-timer').forEach(el => {
            el.classList.remove('pvp-lock');
            el.classList.add('pvp-lock-cleared');
            el.textContent = '✅ Loss penalty over — the next win pays as normal.';
        });
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

        const limit = this.config.pvpTurnLimit(this.config.getPvpMode(st.mode).size);

        if (!hostAlive || !guestAlive) {
            next.phase = 'over';
            next.winner = !hostAlive ? 'guest' : 'host';
            next.log.push(!hostAlive
                ? `${battle.guestName} wins!`
                : `${battle.hostName} wins!`);
        } else if (next.turn > limit) {
            // A stall, not a match. Decided the way competitive Pokémon decides
            // one: most left standing, then the healthiest team.
            next.phase = 'over';
            next.winner = this.config.pvpStallWinner(p1Team, p2Team);
            next.stalled = true;
            next.log.push(`Time! The battle ran to ${limit} turns.`);
            next.log.push(next.winner === null
                ? "It's a draw — both teams are equally worn down."
                : `${next.winner === 'host' ? battle.hostName : battle.guestName} wins on remaining Pokémon!`);
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

        // Stage changes are invisible without this, and an invisible mechanic
        // is one nobody plays around: a +2 Attack means nothing to the other
        // player if their screen looks exactly the same as before.
        const stages = (c) => {
            const st = (c && c.stages) || {};
            const SHORT = { attack: 'ATK', defense: 'DEF', speed: 'SPE' };
            const out = Object.entries(SHORT)
                .map(([stat, label]) => {
                    const n = Math.max(-6, Math.min(6, Number(st[stat]) || 0));
                    if (!n) return '';
                    // The multiplier, not the stage: "ATK x2" says what it does
                    // to the next hit. "ATK +2" asks you to remember a table.
                    const mult = n >= 0 ? (2 + n) / 2 : 2 / (2 - n);
                    const shown = Number.isInteger(mult) ? mult : mult.toFixed(2).replace(/0+$/, '');
                    return `<span class="pvp-stage ${n > 0 ? 'up' : 'down'}"
                                  title="${label} ${n > 0 ? '+' : ''}${n}">${label} \u00d7${shown}</span>`;
                })
                .join('');
            const conf = c && c.confusedTurns > 0
                ? '<span class="pvp-stage confused" title="Confused">CNF</span>' : '';
            return out + conf;
        };
        // Worth knowing what you are up against before choosing a move.
        const rarity = c => `${c.legendary ? '<span class="pvp-rarity legendary" title="Legendary">★</span>' : ''}`
                          + `${c.custom ? `<span class="pvp-rarity custom" title="${esc(this.config.CUSTOM_LABEL)}">${this.config.CUSTOM_MARK}</span>` : ''}`
                          + `${c.shiny ? '<span class="pvp-rarity shiny" title="Shiny">✦</span>' : ''}`
                          + `${c.megaForm ? '<span class="pvp-rarity mega" title="Mega — deals 1.3x damage">◆</span>' : ''}`;

        const over = phase === 'over';
        const drawn = over && !st.winner;

        // The result screen is where a win tells you to go and spend the boost
        // on a lecture, so the theme stops there rather than looping under it.
        if (over) this.stopBattleMusic();
        else this.startBattleMusic();

        const iWon = over && !drawn && ((st.winner === 'host') === (this.role === 'host'));

        // Claim the victory reward once, on the first render that shows a win.
        // renderBattle runs on every poll, so the flag is what keeps a single
        // win from being claimed repeatedly. The format sets how long it runs.
        if (iWon && !this.rewardClaimed) {
            this.rewardClaimed = true;
            this.engine.grantPvpReward(mode.rewardMs)
                .then(res => {
                    this.rewardResult = res;
                    this.renderBattle();
                    // `scene` is the engine's answer to "did this win actually
                    // transform something, for the first time". A dormant stone
                    // changes nothing yet, and a second stone for a Pokémon
                    // already wearing its other form changes nothing either;
                    // both get the notice and no takeover.
                    if (res.granted && res.kind === 'stone' && res.scene) {
                        const member = this.engine.getParty()
                            .find(p => p.instanceId === res.instanceId);
                        this.ui.showMegaOverlay(res.stone, member);
                    }
                })
                .catch(() => {});
        }

        // A defeat starts the no-reward window. Same once-only guard, for the
        // same reason — and recorded on the loser's own device, so it is the
        // person who lost who carries it.
        // A draw is not a defeat: nobody was beaten, so nobody carries the
        // lockout. Without the `drawn` guard a timed-out battle would punish
        // both players for a stalemate neither chose.
        if (over && !iWon && !drawn && !this.lossRecorded) {
            this.lossRecorded = true;
            this.engine.recordPvpLoss()
                .then(() => this.renderBattle())
                .catch(() => {});
        }

        this.modal.body.innerHTML = `
            <div class="pvp-battle">
                ${this.renderAudioToggle()}
                <div class="pvp-mode-tag">${mode.label}</div>
                <div class="pvp-field">
                    <!-- The diagonal the series has used since 1996: the foe up
                         and to the right, you down and to the left, each on its
                         own platform. Absolute placement rather than flex rows,
                         because that composition is the whole look. -->
                    <div class="pvp-scene">
                        <!-- Sky and ground are separate layers so each can be
                             textured on its own terms: clouds and a treeline
                             above the horizon, furrows and scrub below it.
                             Doing it in one background means every texture has
                             to be clipped to half the box, which CSS makes
                             far more painful than two divs. -->
                        <div class="pvp-sky"></div>
                        <div class="pvp-ground"></div>
                        <div class="pvp-plate foe-plate"></div>
                        <div class="pvp-plate my-plate"></div>

                        <img class="pvp-sprite foe-sprite${foe.shiny ? ' is-shiny' : ''}${foe.megaForm ? ' is-mega' : ''}"
                             src="${this.config.getSpriteUrl(foe.spriteId ?? foe.speciesId, foe.shiny)}"
                             onerror="this.classList.add('sprite-missing'); this.removeAttribute('src');"
                             alt="${esc(foe.name)}"/>
                        <img class="pvp-sprite my-sprite${me.shiny ? ' is-shiny' : ''}${me.megaForm ? ' is-mega' : ''}"
                             src="${this.config.getBackSpriteUrl(me.spriteId ?? me.speciesId, me.shiny)}"
                             onerror="this.src='${this.config.getSpriteUrl(me.spriteId ?? me.speciesId, me.shiny)}'"
                             alt="${esc(me.name)}"/>

                        <div class="pvp-plateinfo foe-info">
                            ${stages(foe)}
                            <div class="pvp-nameplate">
                                <div class="pvp-plate-top">
                                    <span class="pvp-mon-name">${esc(foe.name)}</span>
                                    <span class="pvp-mon-lv">Lv${foe.level}</span>
                                    <span class="pvp-plate-marks">${rarity(foe)}${badge(foe)}</span>
                                </div>
                                <div class="pvp-hp-row">
                                    <span class="pvp-hp-tag">HP</span>
                                    <div class="pvp-hp"><div class="pvp-hp-fill ${hpClass(hpPct(foe))}" style="width:${hpPct(foe)}%"></div></div>
                                    ${this.renderBalls(foeTeam, foeIndex)}
                                </div>
                            </div>
                        </div>

                        <div class="pvp-plateinfo my-info">
                            ${stages(me)}
                            <div class="pvp-nameplate">
                                <div class="pvp-plate-top">
                                    <span class="pvp-mon-name">${esc(me.name)}</span>
                                    <span class="pvp-mon-lv">Lv${me.level}</span>
                                    <span class="pvp-plate-marks">${rarity(me)}${badge(me)}</span>
                                </div>
                                <div class="pvp-hp-row">
                                    <span class="pvp-hp-tag">HP</span>
                                    <div class="pvp-hp"><div class="pvp-hp-fill ${hpClass(hpPct(me))}" style="width:${hpPct(me)}%"></div></div>
                                    <span class="pvp-hp-num">${me.hp}/${me.maxHp}</span>
                                    ${this.renderBalls(myTeam, myIndex)}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pvp-log">${(log || []).slice(-4).map(l => `<div>${esc(l)}</div>`).join('')}</div>

                ${over ? `
                    <div class="pvp-result ${drawn ? 'draw' : iWon ? 'win' : 'lose'}">
                        <p class="pvp-8bit">${drawn ? 'DRAW' : iWon ? 'YOU WIN!' : 'YOU LOSE...'}</p>
                        ${drawn
                            ? '<p class="pvp-sub">Time ran out with both teams equally worn down. No boost, and no lockout.</p>'
                            : iWon ? this.renderRewardNotice() : this.renderLossNotice()}
                        <button class="pvp-btn pvp-exit-btn">BACK</button>
                    </div>
                ` : this.renderActions(me, myTeam, myIndex, phase)}
            </div>`;

        this.bindBattle();
    }

    /**
     * A speaker in the corner of the battle screen.
     *
     * The music dock sits under the modal overlay, so while a battle is on
     * screen there is no other way to silence the theme — and someone in a
     * library needs one button, not a trip out of the battle and back.
     * Nothing is drawn at all when no battle theme is configured.
     */
    renderAudioToggle() {
        if (!this.musicOn) return '';
        const st = this.ui.music && this.ui.music.getState();
        const on = Boolean(st && st.playing);
        const label = on ? 'Mute the battle theme' : 'Play the battle theme';
        return `<button class="pvp-audio${on ? '' : ' off'}" title="${label}"
                        aria-label="${label}">♪</button>`;
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

        // What a move actually does, since half of them no longer deal damage
        // and "GRASS · 15/15" says nothing about Sleep Powder.
        const moveHint = (m) => {
            const bits = [];
            if (m.power) bits.push(`${m.power} pow`);
            if (m.stages) {
                const who = m.stagesTarget === 'self' ? 'your' : 'foe';
                bits.push(Object.entries(m.stages)
                    .map(([k, v]) => `${who} ${k.slice(0, 3).toUpperCase()} ${v > 0 ? '+' : ''}${v}`)
                    .join(' '));
            }
            if (m.heal) bits.push(`heal ${Math.round(m.heal * 100)}%`);
            if (m.effect && m.effect !== 'flinch') {
                const label = m.effect === 'confuse' ? 'confuse' : this.B.STATUS_LABEL[m.effect] || m.effect;
                bits.push(m.chance >= 1 ? label : `${label} ${Math.round((m.chance || 0) * 100)}%`);
            }
            return bits.join(' · ');
        };

        // Every move exhausted used to leave four disabled buttons and no legal
        // action — a soft-lock. Struggle is what the games do instead.
        const outOfPP = me.moves.every(m => m.ppLeft <= 0);
        if (outOfPP) {
            return `
                <div class="pvp-moves">
                    <button class="pvp-move struggle" data-move="struggle"
                            ${this.pendingAction ? 'disabled' : ''}>
                        <span class="pvp-move-name">Struggle</span>
                        <span class="pvp-move-meta">NO PP LEFT · HURTS YOU</span>
                    </button>
                </div>
                ${bench.length ? `
                    <button class="pvp-btn ghost pvp-switch-open" ${this.pendingAction ? 'disabled' : ''}>
                        SWITCH (${bench.length})
                    </button>` : ''}`;
        }

        return `
            <div class="pvp-moves">
                ${me.moves.map(m => `
                    <button class="pvp-move ${m.type}" data-move="${m.id}"
                            ${this.pendingAction || m.ppLeft <= 0 ? 'disabled' : ''}>
                        <span class="pvp-move-name">${esc(m.name)}</span>
                        <span class="pvp-move-meta">${m.type.toUpperCase()} · ${m.ppLeft}/${m.pp}</span>
                        <span class="pvp-move-hint">${esc(moveHint(m))}</span>
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
                <button class="pvp-bench-mon ${btnClass} ${c.megaForm ? 'is-mega' : ''}" data-index="${i}" ${this.pendingAction ? 'disabled' : ''}>
                    <img src="${this.config.getSpriteUrl(c.spriteId ?? c.speciesId, c.shiny)}" alt="${esc(c.name)}"/>
                    <span class="pvp-bench-name">${esc(c.name)}</span>
                    <span class="pvp-bench-hp">${c.hp}/${c.maxHp}</span>
                </button>`).join('')}
        </div>`;
    }

    bindBattle() {
        const body = this.modal.body;

        // Flipped straight away rather than waiting for the frame to confirm:
        // pause() and play() set `playing` synchronously, and a mute button
        // that looks unpressed for half a second reads as broken.
        body.querySelector('.pvp-audio')?.addEventListener('click', (e) => {
            const music = this.ui.music;
            if (!music) return;
            music.toggle();
            const on = music.playing;
            const btn = e.currentTarget;
            btn.classList.toggle('off', !on);
            btn.title = on ? 'Mute the battle theme' : 'Play the battle theme';
            btn.setAttribute('aria-label', btn.title);
        });

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

        // A lockout has no reward attached to name, so it is handled before
        // the REWARD_INFO lookup rather than falling through it.
        if (!res.granted && res.reason === 'locked') {
            return `<div class="pvp-reward held">
                <p class="pvp-8bit small">⛔ NO BOOST — RECENT LOSS</p>
                <p class="pvp-sub pvp-lock-timer">A defeat costs you
                ${Math.round(this.config.PVP_LOSS_LOCKOUT_MS / 60000)} minutes of prizes, and
                <span class="pvp-lock-left">${this.config.formatCountdown(res.msLeft || 0)}</span>
                of that is left. Win again after that and the draw pays as normal.</p>
            </div>`;
        }

        // A stone is not a REWARD_INFO type, so it is handled before that lookup.
        if (res.granted && res.kind === 'stone') {
            return `<div class="pvp-reward won is-stone">
                <p class="pvp-8bit small">◆ ${esc(res.stone.stone)}</p>
                <p class="pvp-sub">${esc(res.holder)} won ${esc(res.stone.stone)}.
                ${res.dormant
                    ? `It cannot be used until ${esc(res.holder)} reaches its final form —
                       the stone keeps waiting until then.`
                    : `Turn it on in Game Hub → Party to become
                       <b>${esc(res.stone.name)}</b> and deal 1.3x damage.`}</p>
            </div>`;
        }

        const info = this.config.REWARD_INFO[res.reward && res.reward.type];
        if (!info) return '';

        if (!res.granted) {
            return `<div class="pvp-reward held">
                <p class="pvp-8bit small">${info.icon} ${info.label} STILL RUNNING</p>
                <p class="pvp-sub pvp-boost-timer"><span class="pvp-boost-left">${this.config.formatCountdown(res.reward.msLeft || 0)}</span>
                left. One boost at a time — go and spend it on a lecture, and the next
                win can grant another.</p>
            </div>`;
        }

        return `<div class="pvp-reward won">
            <p class="pvp-8bit small">${info.icon} ${info.label}</p>
            <p class="pvp-sub">${info.detail} Runs for ${this.mode.rewardLabel}.</p>
        </div>`;
    }

    /** What the defeat cost, so the lockout is never a silent surprise later. */
    renderLossNotice() {
        const mins = Math.round(this.config.PVP_LOSS_LOCKOUT_MS / 60000);
        return `<div class="pvp-reward held">
            <p class="pvp-8bit small pvp-lock-timer">⛔ NO BOOST FOR
               <span class="pvp-lock-left">${this.config.formatCountdown(this.engine.getRewardLock() || this.config.PVP_LOSS_LOCKOUT_MS)}</span></p>
            <p class="pvp-sub">Nothing pays out for ${mins} min, even if you win again —
            otherwise two trainers could take turns losing and collect every time.
            Your line-up is saved; go and study, then come back.</p>
        </div>`;
    }

    // ─────────────────────────── Battle music ───────────────────────────
    //
    // Only during an actual battle. The lobby is where one student reads six
    // digits out to another, and music over that is an obstacle, not
    // atmosphere.
    //
    // The page's existing player is reused rather than a second one created:
    // two YouTube frames would talk over each other, and the rule that a
    // lecture silences music lives on that one player — so a lecture starting
    // mid-battle still wins, which is the whole point of the feature.

    startBattleMusic() {
        if (this.musicOn || !this.ui || typeof this.ui.getMusic !== 'function') return;
        const music = this.ui.getMusic();
        if (!music || typeof music.playBattleTheme !== 'function') return;
        // False means the playlist file names no battle theme. Nothing was
        // taken over, so there will be nothing to hand back.
        this.musicOn = music.playBattleTheme();
    }

    /** Hands the player back to whatever the student was listening to before. */
    stopBattleMusic() {
        if (!this.musicOn) return;
        this.musicOn = false;
        const music = this.ui && this.ui.music;
        if (music && typeof music.endBattleTheme === 'function') music.endBattleTheme();
    }

    onOpponentLeft() {
        this.stopBattleMusic();
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
        this.stopBattleMusic();
        this.stopPolling();
        clearInterval(this.clockTimer);
        this.clockTimer = null;
        if (this.code && this.role === 'host') {
            try { await this.engine.pvpClose(this.code); } catch { /* best effort */ }
        }
        this.code = null; this.role = null; this.local = null; this.remote = null;
        if (this.modal) this.ui.closeModal(this.modal.overlay);
        this.modal = null;
    }
}

window.FlickemonPvp = FlickemonPvp;
