/**
 * Sandbox controls. Not part of the extension.
 *
 * Everything here is scaffolding around the real game: a video that actually
 * plays so the engine ticks, and a couple of buttons so you can be holding six
 * Pokemon ten seconds after opening the page instead of twenty-five minutes.
 */
(function () {
    'use strict';

    const sb = window.FLICKEMON_SANDBOX;
    const who = sb.player.uid.endsWith('-b') ? 'b' : 'a';

    const badge = document.getElementById('sb-who');
    badge.textContent = sb.player.name;
    if (who === 'b') badge.classList.add('b');
    document.getElementById('sb-code').textContent =
        ` — 6-digit code ${sb.codeForUid(sb.player.uid)}`;

    // ── a real, playing <video> ─────────────────────────────────────────────
    //
    // content-script.js counts study time from `timeupdate` and refuses to
    // count while readyState < 2. A canvas capture stream satisfies both with
    // no media file to ship: it is a genuine live MediaStream, so the element
    // plays, ticks at the usual ~4Hz, and pauses when told to.
    const video = document.getElementById('sb-video');
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    setInterval(() => {
        frame++;
        ctx.fillStyle = '#101018';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = video.paused ? '#6b6f7a' : '#4fd1c5';
        ctx.font = 'bold 15px system-ui, sans-serif';
        ctx.fillText(video.paused ? 'lecture paused' : 'lecture playing', 16, 92);
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillStyle = '#8b8f99';
        ctx.fillText(`t+${Math.floor(frame / 10)}s`, 16, 116);
    }, 100);
    video.srcObject = canvas.captureStream(10);
    video.play().catch(() => {
        document.getElementById('sb-code').textContent +=
            ' — click "Play / pause the video" to start the clock';
    });

    document.getElementById('sb-play').addEventListener('click', () => {
        if (video.paused) video.play().catch(() => {}); else video.pause();
    });

    // ── a party, immediately ────────────────────────────────────────────────
    document.getElementById('sb-fill').addEventListener('click', async () => {
        const e = window.flickemonEngine;
        const cfg = window.FlickemonConfig;
        if (!e) return;

        if (!e.gameState.hasStarted) await e.chooseStarter(who === 'b' ? 4 : 1);

        // Two different line-ups, so a battle between the tabs is legible at a
        // glance rather than mirror-matched.
        const roster = who === 'b'
            ? [[6, 55], [130, 48], [65, 46], [94, 44], [143, 50], [149, 52]]
            : [[3, 54], [9, 47], [25, 45], [131, 49], [59, 51], [112, 46]];

        for (const [speciesId, level] of roster) {
            if (e.gameState.party.some(p => p.speciesId === speciesId)) continue;
            e.gameState.party.push({
                instanceId: e.generateId(),
                speciesId, level,
                totalExp: cfg.expForLevel(level),
                shiny: false,
                megaStones: [], megaSeen: [], megaActive: null, megaActiveAt: 0,
            });
        }

        await e.saveGameState({ immediate: true });

        // ── Things that only show up if they are actually FIELDED ──
        //
        // The line-up is what a battle sees, and it is the first few of the PVP
        // team. A stone on a party member who never takes the field means the
        // MEGA EVOLVE button never appears and the feature reads as broken, so
        // both of these are placed by line-up position rather than by whoever
        // happens to come first in the party.
        const lineup = e.getPvpTeam()
            .map(id => e.gameState.party.find(p => p.instanceId === id))
            .filter(Boolean);

        // The stone goes to the lead, so it is usable in 1v1 as well as 3v3.
        const holder = lineup.find(p => cfg.megaSourceFor(p.speciesId) !== null
                                     && cfg.isFullyEvolved(p.speciesId));
        if (holder) {
            const form = cfg.megaFormsFor(holder.speciesId)[0];
            if (form) { holder.megaStones = [form.key]; holder.megaSeen = []; }
        }

        // One shiny in the first three, so the ✦ on the nameplate, the sparkle
        // on the sprite and the marks on the chips and bench all have something
        // to show in every format.
        const sparkler = lineup.slice(0, 3).find(p => p !== holder) || lineup[1];
        if (sparkler) sparkler.shiny = true;

        await e.saveGameState({ immediate: true });
        e.emitState();
        console.log('[sandbox] party ready:', e.gameState.party.map(p => `${p.speciesId}@${p.level}`));
        console.log('[sandbox] line-up:', lineup.map(p =>
            `${cfg.getSpeciesById(p.speciesId).name}${p.shiny ? ' ✦' : ''}`
            + `${p.megaStones.length ? ' ◆' + p.megaStones[0] : ''}`).join('  '));
    });

    // ── resets ──────────────────────────────────────────────────────────────
    document.getElementById('sb-wipe').addEventListener('click', () => {
        sb.store.write({});
        location.reload();
    });
    document.getElementById('sb-wipe-lobbies').addEventListener('click', () => {
        sb.lobbies.write({});
        console.log('[sandbox] all lobbies cleared');
    });

    console.log(`[sandbox] ${sb.player.name} — uid ${sb.player.uid}, `
              + `code ${sb.codeForUid(sb.player.uid)}`);
})();
