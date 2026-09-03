/**
 * Flickémon Friends
 * ─────────────────
 * The part of studying that is not solitary: seeing that other people are at it
 * too. Built on the same furniture as PVP and trading — one modal, polling that
 * stops when nobody is looking, and no page but this one.
 *
 * ── Progress, not hours ──
 *
 * Every figure here is game progress: EXP earned today, levels gained, a
 * streak. Never a duration. That was the explicit ask and it is also the
 * kinder measure — hours reward sitting still, and a student who learns a block
 * in forty minutes has not done worse than one who took three hours.
 *
 * ── Privacy is not implemented here ──
 *
 * Nothing in this file hides anything. What a friend can see is decided by what
 * the engine PUBLISHES and by firestore.rules, both of which are outside this
 * renderer's reach. A field that is off never reaches a document, and a blocked
 * friend is not in the audience list, so the server refuses them. This file
 * only draws what came back — which is the property that makes the promise
 * survive somebody editing the extension.
 *
 * ── Reads ──
 *
 * Feeds are read only while this modal is open, and the friendship list is
 * cached for the session because it changes only when somebody is added or
 * removed. See the budget at the top of flickemon-engine.js.
 */

const FRIENDS_POLL_MS = 30000;        // while open and visible, and only then
const FRIENDS_POLL_MAX_MS = 120000;   // backs off as a panel is left sitting
const FRIENDS_BACKOFF = 1.5;

/** Names arrive from other students' accounts, so nothing is trusted raw. */
function fesc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 12,400 rather than 12400 — a ranking is read at a glance or not at all. */
const num = (n) => Number(n || 0).toLocaleString();

class FlickemonFriends {
    constructor(engine, ui) {
        this.engine = engine;
        this.ui = ui;
        this.config = window.FlickemonConfig;

        this.tab = 'today';          // today | global | add | privacy
        this.pollTimer = null;
        this.polls = 0;
        this.friends = [];
        this.feeds = {};
        this.board = null;
        this.boardError = '';
        this.busy = false;
        this.notice = '';

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') this.stopPolling();
                else if (this.modal) this.refresh();
            });
        }
    }

    // ─────────────────────────── Entry ───────────────────────────

    async open() {
        const modal = this.ui.createModalOverlay('Friends');
        modal.overlay.classList.add('friends-overlay');
        this.modal = modal;

        modal.overlay.addEventListener('click', (e) => {
            if (e.target === modal.overlay) this.leave();
        });
        modal.overlay.querySelector('.flickemon-modal-close')
            ?.addEventListener('click', () => this.leave());

        const status = await this.engine.pvpMyCode();
        if (!status || !status.signedIn) {
            modal.body.innerHTML = `<div class="pvp-notice">
                <p class="pvp-8bit">SIGN IN FOR FRIENDS</p>
                <p class="pvp-sub">Friends need an account so people can find each other.</p>
            </div>`;
            return;
        }
        this.myEmail = status.email || '';
        this.myUid = status.uid || '';

        this.render();
        await this.refresh({ fresh: true });
    }

    async leave() {
        this.stopPolling();
        if (this.modal) this.ui.closeModal(this.modal.overlay);
        this.modal = null;
    }

    // ─────────────────────────── Loading ───────────────────────────

    /**
     * Pulls whatever the current tab actually shows.
     *
     * Deliberately tab-aware: opening Friends should not also cost a
     * leaderboard query, and sitting on the board should not re-read every
     * friend's feed. Reads are the metered resource here.
     */
    async refresh({ fresh = false } = {}) {
        if (!this.modal) return;

        try {
            if (this.tab === 'today' || this.tab === 'add' || this.tab === 'privacy') {
                const res = await this.engine.loadFriends({ fresh });
                this.friends = (res && res.friendships) || [];
                if (this.tab === 'today') {
                    const uids = this.friends.filter(f => f.accepted).map(f => f.uid);
                    if (uids.length) {
                        const feeds = await this.engine.friendFeeds(uids);
                        this.feeds = (feeds && feeds.feeds) || {};
                    } else {
                        this.feeds = {};
                    }
                }
            } else if (this.tab === 'global') {
                this.boardError = '';
                const res = await this.engine.friendBoardRead(this.engine.today());
                if (res && res.ok) this.board = res.board || [];
                else this.boardError = (res && res.error) || 'Could not load the board.';
            }
        } catch (e) {
            if (this.tab === 'global') this.boardError = e.message;
        }

        // Publishing rides the refresh rather than a timer of its own: the
        // moment a student looks at their friends is exactly when they would
        // like their friends to be able to see them.
        this.engine.publishFriendFeed().catch(() => {});

        this.render();
        this.startPolling();
    }

    startPolling() {
        this.stopPolling();
        if (!this.modal || (typeof document !== 'undefined'
            && document.visibilityState === 'hidden')) return;

        // Backs off the longer a panel is left open, because a modal somebody
        // walked away from should not cost the same as one being watched.
        const delay = Math.min(FRIENDS_POLL_MAX_MS,
            FRIENDS_POLL_MS * Math.pow(FRIENDS_BACKOFF, this.polls));
        this.polls++;
        this.pollTimer = setTimeout(() => this.refresh(), delay);
    }

    stopPolling() {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    // ─────────────────────────── Rendering ───────────────────────────

    render() {
        if (!this.modal) return;
        const tabs = [
            ['today', 'TODAY'],
            ['global', 'GLOBAL'],
            ['add', 'ADD'],
            ['privacy', 'PRIVACY'],
        ];
        const pending = this.friends.filter(f => f.incoming).length;

        this.modal.body.innerHTML = `
            <div class="friends">
                <div class="friends-tabs">
                    ${tabs.map(([id, label]) => `
                        <button class="friends-tab ${this.tab === id ? 'on' : ''}" data-tab="${id}">
                            ${label}${id === 'add' && pending
                                ? `<span class="friends-badge">${pending}</span>` : ''}
                        </button>`).join('')}
                </div>
                ${this.notice ? `<p class="friends-notice">${fesc(this.notice)}</p>` : ''}
                <div class="friends-panel">${this.renderTab()}</div>
            </div>`;

        this.bind();
    }

    renderTab() {
        if (this.tab === 'today') return this.renderToday();
        if (this.tab === 'global') return this.renderGlobal();
        if (this.tab === 'add') return this.renderAdd();
        return this.renderPrivacy();
    }

    // ── Today ──

    renderToday() {
        const accepted = this.friends.filter(f => f.accepted);
        if (accepted.length === 0) {
            return `<div class="friends-empty">
                <p class="pvp-8bit small">NOBODY YET</p>
                <p class="pvp-sub">Add a friend and you will see what they have been
                studying today — and they will see yours.</p>
                <button class="pvp-btn friends-goto-add">ADD A FRIEND</button>
            </div>`;
        }

        const today = this.engine.todayProgress();
        const mine = {
            uid: 'me', me: true,
            label: this.engine.getUsername() || 'You',
            exp: today.exp, levels: today.levels,
            streak: this.engine.currentStreak(),
            active: true,
            shared: true,
        };

        const rows = accepted.map(f => {
            const feed = this.feeds[f.uid];
            const p = (feed && feed.payload) || null;
            return {
                uid: f.uid,
                label: (p && p.username) || 'Trainer',
                // A friend who shares nothing is not an error and not a zero:
                // they are simply private, and the row says so rather than
                // ranking them last for it.
                shared: Boolean(p && p.today),
                exp: (p && p.today && p.today.exp) || 0,
                levels: (p && p.today && p.today.levels) || 0,
                streak: (p && p.streak) || 0,
                // Aged here rather than trusted from the document: a feed
                // published twenty minutes ago said "studying" then, and the
                // person has almost certainly stopped. This is what lets the
                // dot go out without anyone spending a write to say so.
                active: Boolean(p && p.activeAt
                    && (Date.now() - p.activeAt) < this.config.FRIEND_ACTIVE_WINDOW_MS),
                mon: (p && p.mon) || null,
                quiet: !p,
            };
        });

        // Ranked: anyone sharing progress, by today's EXP. Everyone else sits
        // below rather than being ranked last, because "private" is not "worst".
        const ranked = [...rows.filter(r => r.shared), mine]
            .sort((a, b) => b.exp - a.exp);
        const unranked = rows.filter(r => !r.shared);

        return `
            <p class="friends-heading">TODAY · among ${ranked.length} trainer${ranked.length === 1 ? '' : 's'}</p>
            <ol class="friends-rank">
                ${ranked.map((r, i) => this.renderRow(r, i + 1)).join('')}
            </ol>
            ${unranked.length ? `
                <p class="friends-heading quiet">NOT SHARING PROGRESS</p>
                <ol class="friends-rank">
                    ${unranked.map(r => this.renderRow(r, null)).join('')}
                </ol>` : ''}
            <p class="friends-foot">Progress is EXP and levels earned today, never how
            long you studied. It resets at midnight.</p>`;
    }

    renderRow(r, rank) {
        const mon = r.mon;
        return `
            <li class="friends-row ${r.me ? 'me' : ''} ${r.active ? 'is-active' : ''}">
                <span class="friends-rank-n">${rank ? rank : '·'}</span>
                <span class="friends-dot ${r.active ? 'on' : ''}"
                      title="${r.active ? 'Studying now' : 'Not studying'}"></span>
                <span class="friends-name">${fesc(r.label)}${r.me ? ' <b>(you)</b>' : ''}</span>
                ${r.shared ? `
                    <span class="friends-exp">${num(r.exp)} EXP</span>
                    ${r.levels ? `<span class="friends-lv">▲${r.levels}</span>` : ''}
                ` : `<span class="friends-private">private</span>`}
                ${r.streak ? `<span class="friends-streak" title="${r.streak} day streak">🔥${r.streak}</span>` : ''}
                ${mon ? `
                    <span class="friends-mon" title="${fesc(mon.name)} Lv${mon.level} — ATK ${mon.stats.attack} · DEF ${mon.stats.defense} · SPD ${mon.stats.speed} · HP ${mon.stats.hp}">
                        <img src="${this.config.getSpriteUrl(mon.spriteId || mon.speciesId, mon.shiny)}"
                             class="${mon.shiny ? 'is-shiny' : ''}" alt="${fesc(mon.name)}"/>
                        <span class="friends-mon-lv">Lv${mon.level}</span>
                    </span>` : ''}
            </li>`;
    }

    // ── Global ──

    renderGlobal() {
        const joined = this.engine.isOnLeaderboard();
        const label = this.config.leaderboardLabel(this.engine.getUsername(), this.myEmail);

        const join = `
            <div class="friends-join ${joined ? 'in' : ''}">
                ${joined ? `
                    <p class="pvp-sub">You are on the board as <b>${fesc(label)}</b>.
                    Every signed-in student can see that name, today's EXP and your streak —
                    nothing else.</p>
                    <button class="pvp-btn ghost friends-leave-board">LEAVE THE BOARD</button>
                ` : `
                    <p class="pvp-sub">You are not on the board. Joining publishes
                    <b>${fesc(label)}</b>, today's EXP and your streak to every signed-in
                    student. Nothing else, and you can leave at any time.</p>
                    ${this.engine.getUsername() ? '' : `<p class="pvp-sub small">Set a
                        username under ADD and you will appear by that name instead.</p>`}
                    <button class="pvp-btn friends-join-board">JOIN THE BOARD</button>
                `}
            </div>`;

        if (this.boardError) {
            return `${join}<p class="friends-error">${fesc(this.boardError)}</p>`;
        }
        if (!this.board) return `${join}<p class="pvp-sub">Loading…</p>`;
        if (this.board.length === 0) {
            return `${join}<p class="pvp-sub">Nobody has posted a score today yet.</p>`;
        }

        const myRow = this.board.findIndex(r => r.uid === this.myUid);
        return `
            ${join}
            <p class="friends-heading">GLOBAL · TODAY</p>
            <ol class="friends-rank">
                ${this.board.map((r, i) => `
                    <li class="friends-row ${r.uid === this.myUid ? 'me' : ''}">
                        <span class="friends-rank-n">${i + 1}</span>
                        <span class="friends-name">${fesc(r.label || '—')}</span>
                        <span class="friends-exp">${num(r.todayExp)} EXP</span>
                        ${r.levels ? `<span class="friends-lv">▲${r.levels}</span>` : ''}
                        ${r.streak ? `<span class="friends-streak">🔥${r.streak}</span>` : ''}
                    </li>`).join('')}
            </ol>
            ${joined && myRow < 0 ? `<p class="friends-foot">You are on the board but
                outside today's top ${this.board.length}. Keep going.</p>` : ''}`;
    }

    // ── Add ──

    renderAdd() {
        const incoming = this.friends.filter(f => f.incoming);
        const outgoing = this.friends.filter(f => f.outgoing);
        const accepted = this.friends.filter(f => f.accepted);
        const name = this.engine.getUsername();

        return `
            <div class="friends-name-box">
                <p class="pvp-8bit small">YOUR USERNAME</p>
                <p class="pvp-sub">${name
                    ? `Friends can find you as <b>${fesc(name)}</b>.`
                    : 'Set one so people can find you without knowing your email.'}</p>
                <div class="friends-inline">
                    <input class="friends-name-input" maxlength="${this.config.USERNAME_MAX}"
                           placeholder="${name ? fesc(name) : 'yourname'}"/>
                    <button class="pvp-btn friends-name-save">SAVE</button>
                </div>
                <p class="friends-error friends-name-error"></p>
            </div>

            <div class="friends-add-box">
                <p class="pvp-8bit small">ADD SOMEONE</p>
                <p class="pvp-sub">Their username, or their @docchula.com email.</p>
                <div class="friends-inline">
                    <input class="friends-add-input" placeholder="username or email"/>
                    <button class="pvp-btn friends-add-send">SEND</button>
                </div>
                <p class="friends-error friends-add-error"></p>
                <p class="friends-foot">${accepted.length} of ${this.config.FRIEND_MAX} friends.</p>
            </div>

            ${incoming.length ? `
                <p class="pvp-8bit small">WAITING FOR YOU</p>
                <ul class="friends-requests">
                    ${incoming.map(f => `
                        <li class="friends-request">
                            <span class="friends-name">${fesc(f.uid.slice(0, 8))}…</span>
                            <button class="pvp-btn friends-accept" data-uid="${fesc(f.uid)}">ACCEPT</button>
                            <button class="pvp-btn ghost friends-decline" data-uid="${fesc(f.uid)}">DECLINE</button>
                        </li>`).join('')}
                </ul>` : ''}

            ${outgoing.length ? `
                <p class="pvp-8bit small">SENT</p>
                <ul class="friends-requests">
                    ${outgoing.map(f => `
                        <li class="friends-request">
                            <span class="friends-name">${fesc(f.uid.slice(0, 8))}…</span>
                            <span class="friends-private">waiting</span>
                            <button class="pvp-btn ghost friends-decline" data-uid="${fesc(f.uid)}">CANCEL</button>
                        </li>`).join('')}
                </ul>` : ''}`;
    }

    // ── Privacy ──

    renderPrivacy() {
        const privacy = this.engine.getFriendPrivacy();
        const accepted = this.friends.filter(f => f.accepted);

        return `
            <p class="pvp-8bit small">WHAT FRIENDS CAN SEE</p>
            <ul class="friends-privacy">
                ${this.config.FRIEND_FIELDS.map(f => `
                    <li class="friends-priv-row">
                        <label>
                            <input type="checkbox" class="friends-priv" data-key="${f.key}"
                                   ${privacy[f.key] ? 'checked' : ''}/>
                            <span class="friends-priv-label">${fesc(f.label)}</span>
                        </label>
                        <span class="friends-priv-detail">${fesc(f.detail)}</span>
                    </li>`).join('')}
            </ul>
            <p class="friends-foot">Turning one off does not hide it — it stops it being
            sent at all. Nothing that is off ever leaves this device.</p>

            ${accepted.length ? `
                <p class="pvp-8bit small">PER FRIEND</p>
                <ul class="friends-requests">
                    ${accepted.map(f => {
                        const blocked = this.engine.isBlocked(f.uid);
                        const feed = this.feeds[f.uid];
                        const named = (feed && feed.payload && feed.payload.username) || null;
                        return `
                        <li class="friends-request ${blocked ? 'blocked' : ''}">
                            <span class="friends-name">${fesc(named || (f.uid.slice(0, 8) + '…'))}</span>
                            <span class="friends-private">${blocked ? 'sees nothing' : 'sees the above'}</span>
                            <button class="pvp-btn ghost friends-block" data-uid="${fesc(f.uid)}"
                                    data-on="${blocked ? '1' : '0'}">${blocked ? 'UNHIDE' : 'HIDE'}</button>
                            <button class="pvp-btn ghost friends-remove" data-uid="${fesc(f.uid)}">REMOVE</button>
                        </li>`;
                    }).join('')}
                </ul>` : ''}`;
    }

    // ─────────────────────────── Wiring ───────────────────────────

    bind() {
        const body = this.modal.body;

        body.querySelectorAll('.friends-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.tab = btn.dataset.tab;
                this.notice = '';
                this.polls = 0;          // a deliberate move deserves a fresh look
                this.render();
                this.refresh();
            });
        });

        body.querySelector('.friends-goto-add')?.addEventListener('click', () => {
            this.tab = 'add'; this.render(); this.refresh();
        });

        // ── Username ──
        const nameErr = body.querySelector('.friends-name-error');
        body.querySelector('.friends-name-save')?.addEventListener('click', async () => {
            const raw = body.querySelector('.friends-name-input').value;
            const res = await this.guard(() => this.engine.setUsername(raw));
            if (res && res.ok) {
                this.notice = `You are ${res.name}.`;
                this.render();
            } else if (nameErr) {
                nameErr.textContent = (res && res.reason) || 'Could not save that.';
                nameErr.classList.add('visible');
            }
        });

        // ── Adding ──
        const addErr = body.querySelector('.friends-add-error');
        body.querySelector('.friends-add-send')?.addEventListener('click', async () => {
            const raw = (body.querySelector('.friends-add-input').value || '').trim();
            if (!raw) return;
            if (this.friends.filter(f => f.accepted).length >= this.config.FRIEND_MAX) {
                addErr.textContent = `You already have ${this.config.FRIEND_MAX} friends.`;
                addErr.classList.add('visible');
                return;
            }

            const query = raw.includes('@') ? { email: raw } : { username: raw };
            const found = await this.guard(() => this.engine.friendLookup(query));
            if (!found || !found.found) {
                // Deliberately the same message for a wrong name and for an
                // address nobody has used: confirming that a classmate's email
                // exists but has never opened the game is more than a stranger
                // needs to learn.
                addErr.textContent = found && found.reason === 'self'
                    ? "That's you."
                    : 'Nobody found with that username or email.';
                addErr.classList.add('visible');
                return;
            }

            const res = await this.guard(() => this.engine.friendRequest(found.uid));
            this.notice = res && res.outcome === 'accepted'
                ? 'They had already asked you — you are now friends.'
                : res && res.outcome === 'already' ? 'You are already friends.'
                : res && res.outcome === 'pending' ? 'You have already asked them.'
                : 'Request sent.';
            this.refresh({ fresh: true });
        });

        body.querySelectorAll('.friends-accept').forEach(btn => {
            btn.addEventListener('click', async () => {
                await this.guard(() => this.engine.friendAccept(btn.dataset.uid));
                this.refresh({ fresh: true });
            });
        });
        body.querySelectorAll('.friends-decline, .friends-remove').forEach(btn => {
            btn.addEventListener('click', async () => {
                await this.guard(() => this.engine.friendRemove(btn.dataset.uid));
                this.refresh({ fresh: true });
            });
        });

        // ── Privacy ──
        body.querySelectorAll('.friends-priv').forEach(box => {
            box.addEventListener('change', async () => {
                await this.guard(() =>
                    this.engine.setFriendPrivacy(box.dataset.key, box.checked));
                this.notice = box.checked
                    ? 'Sharing that again.'
                    : 'That is no longer sent to anyone.';
                this.render();
            });
        });
        body.querySelectorAll('.friends-block').forEach(btn => {
            btn.addEventListener('click', async () => {
                await this.guard(() =>
                    this.engine.setBlocked(btn.dataset.uid, btn.dataset.on !== '1'));
                this.render();
            });
        });

        // ── The board ──
        body.querySelector('.friends-join-board')?.addEventListener('click', async () => {
            await this.guard(() => this.engine.setOnLeaderboard(true, this.myEmail));
            this.refresh();
        });
        body.querySelector('.friends-leave-board')?.addEventListener('click', async () => {
            await this.guard(() => this.engine.setOnLeaderboard(false, this.myEmail));
            this.board = null;
            this.refresh();
        });
    }

    /**
     * Runs one action at a time and never lets a rejection escape.
     *
     * Every button here writes to Firestore, and a double-click that fires two
     * conflicting writes is the sort of thing that leaves a friendship in a
     * state neither side asked for.
     */
    async guard(fn) {
        if (this.busy) return null;
        this.busy = true;
        try {
            return await fn();
        } catch (e) {
            this.notice = e && e.message ? e.message : 'That did not work.';
            return null;
        } finally {
            this.busy = false;
        }
    }
}

window.FlickemonFriends = FlickemonFriends;
