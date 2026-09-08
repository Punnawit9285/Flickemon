const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CAPTURE_DIR = path.join(ROOT, 'tools', 'capture');
const STORE_DIR = path.join(ROOT, 'store_assets');

if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ── Common SVG Icons from flickemon-ui.js ──
const gameControllerSvg = `<svg class="header-icon-svg" viewBox="0 0 512 512" width="22" height="22" fill="currentColor"><path d="M483.13 245.38C461.92 149.49 430 98.31 382.65 84.33A107.1 107.1 0 0 0 352 80c-13.71 0-25.65 3.34-38.28 6.88C298.5 91.15 281.21 96 256 96s-42.51-4.84-57.76-9.11C185.6 83.34 173.67 80 160 80a115.7 115.7 0 0 0-31.73 4.32c-47.1 13.92-79 65.08-100.52 161C4.61 348.54 16 413.71 59.69 428.83a56.6 56.6 0 0 0 18.64 3.22c29.93 0 53.93-24.93 70.33-45.34 18.53-23.1 40.22-34.82 107.34-34.82 59.95 0 84.76 8.13 106.19 34.82 13.47 16.78 26.2 28.52 38.9 35.91 16.89 9.82 33.77 12 50.16 6.37 25.82-8.81 40.62-32.1 44-69.24 2.57-28.48-1.39-65.89-12.12-114.37M208 240h-32v32a16 16 0 0 1-32 0v-32h-32a16 16 0 0 1 0-32h32v-32a16 16 0 0 1 32 0v32h32a16 16 0 0 1 0 32m84 4a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-19.95A20 20 0 0 1 336 288m0-88a20 20 0 1 1 20-20 20 20 0 0 1-20 20m44 44a20 20 0 1 1 20-20 20 20 0 0 1-20 20"/></svg>`;
const pokeballSvg = `<svg viewBox="0 0 512 512" width="13" height="13" fill="none" stroke="currentColor" stroke-width="42" aria-hidden="true"><circle cx="256" cy="256" r="204"/><path d="M52 256h132M328 256h132" stroke-linecap="round"/><circle cx="256" cy="256" r="62"/></svg>`;
const boltSvg = `<svg viewBox="0 0 512 512" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M394.23 197.56a20 20 0 0 0-17.15-9.56H272V32a20 20 0 0 0-36.65-11.09l-160 240A20 20 0 0 0 92 292h105v156a20 20 0 0 0 36.65 11.09l160-240a20 20 0 0 0 .58-21.53z"/></svg>`;
const swordsSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M424 64l-56 0-208 208 56 56L424 120zM88 64l56 0 208 208-56 56L88 120z"/><path d="M136 400l40 40M376 400l-40 40"/></svg>`;
const tradeSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M368 112l64 64-64 64M416 176H208M144 400l-64-64 64-64M96 336h208"/></svg>`;
const friendsSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="196" cy="152" r="60"/><path d="M100 400c0-53 43-96 96-96s96 43 96 96"/><circle cx="356" cy="176" r="48"/><path d="M300 400h112c0-45 -30-80 -70-88"/></svg>`;
const shopSvg = `<svg viewBox="0 0 512 512" width="15" height="15" fill="none" stroke="currentColor" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M96 176h320l-28 240a32 32 0 0 1-32 28H156a32 32 0 0 1-32-28z"/><path d="M176 176v-32a80 80 0 0 1 160 0v32"/></svg>`;
const ellipsisSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor"><circle cx="256" cy="96" r="48"/><circle cx="256" cy="256" r="48"/><circle cx="256" cy="416" r="48"/></svg>`;
const chevronUpSvg = `<svg viewBox="0 0 512 512" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48"><path d="M112 328l144-144 144 144"/></svg>`;

// ── 1. Screenshot 1: Actual In-Lecture Battle UI (1280x800) ──
const html1 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Flick - In-Lecture Battle</title>
<link rel="stylesheet" href="../../content/styles.css"/>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f8fafc; color: #1e293b;
    overflow: hidden;
  }
  .top-navbar {
    height: 56px; background: #ffffff; border-bottom: 1px solid #e2e8f0;
    display: flex; align-items: center; justify-content: space-between; padding: 0 24px;
  }
  .nav-left { display: flex; align-items: center; gap: 14px; }
  .logo { font-weight: 800; font-size: 1.2rem; color: #2563eb; }
  .course-crumb { font-weight: 600; font-size: 0.95rem; color: #64748b; }
  .nav-right { display: flex; align-items: center; gap: 12px; }
  .badge-study { background: #dbeafe; color: #1d4ed8; padding: 4px 10px; border-radius: 20px; font-weight: 700; font-size: 0.8rem; }
  
  .layout-grid {
    display: grid; grid-template-columns: 1fr 340px; gap: 20px;
    max-width: 1240px; margin: 20px auto; padding: 0 16px;
  }
  .player-box {
    background: #000; border-radius: 12px; height: 380px; position: relative;
    display: flex; flex-direction: column; justify-content: space-between;
    overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.15);
  }
  .slide-sim {
    padding: 30px; color: #fff; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    height: 100%; display: flex; flex-direction: column; justify-content: center;
  }
  .slide-tag { color: #38bdf8; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
  .slide-h1 { font-size: 1.6rem; font-weight: 800; margin: 8px 0; }
  .slide-desc { color: #94a3b8; font-size: 0.95rem; max-width: 600px; line-height: 1.5; }
  .video-bar {
    height: 44px; background: rgba(15,23,42,0.85); backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: space-between; padding: 0 16px; color: #fff; font-size: 0.85rem;
  }
  .video-progress { height: 4px; background: #334155; position: absolute; bottom: 44px; left: 0; right: 0; }
  .video-progress-fill { width: 55%; height: 100%; background: #38bdf8; }

  .sidebar-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; height: 720px; }
  .sidebar-h2 { font-size: 1rem; font-weight: 700; margin: 0 0 14px; color: #0f172a; }
  .lec-item { padding: 10px; border-radius: 8px; margin-bottom: 8px; border: 1px solid #f1f5f9; background: #f8fafc; }
  .lec-item.active { border-color: #3b82f6; background: #eff6ff; }
  .lec-title { font-size: 0.88rem; font-weight: 700; color: #1e293b; }
  .lec-meta { font-size: 0.75rem; color: #64748b; margin-top: 4px; }
  .lec-bar { height: 4px; background: #e2e8f0; border-radius: 2px; margin-top: 6px; overflow: hidden; }
  .lec-bar-fill { height: 100%; background: #10b981; }

  .flickemon-card { margin-top: 14px; box-shadow: 0 8px 20px rgba(0,0,0,0.06); }
  .hud-col { display: flex; align-items: center; gap: 12px; }
  .partner-mini-sprite, .wild-mini-sprite { image-rendering: pixelated; width: 64px; height: 64px; }
</style>
</head>
<body>
  <div class="top-navbar">
    <div class="nav-left">
      <span class="logo">Flick</span>
      <span class="course-crumb">Cardiology &bull; Lecture 04: Heart Rhythm Management</span>
    </div>
    <div class="nav-right">
      <span class="badge-study">⏱️ Studied: 42 mins today</span>
    </div>
  </div>

  <div class="layout-grid">
    <div class="main-column">
      <div class="player-box">
        <div class="slide-sim">
          <div class="slide-tag">Clinical Pharmacology</div>
          <div class="slide-h1">Antiarrhythmic Drug Classification & Mechanisms</div>
          <div class="slide-desc">Vaughan Williams Class I–IV actions on cardiac action potential curves and refractory periods.</div>
        </div>
        <div class="video-progress"><div class="video-progress-fill"></div></div>
        <div class="video-bar">
          <span>▶ 38:15 / 1:15:00</span>
          <span>Quality: 1080p &bull; Speed: 1.25x</span>
        </div>
      </div>

      <!-- ACTUAL FLICKEMON CARD -->
      <div class="flickemon-card flickemon-widget-card" style="display: block;">
        <div class="flickemon-header">
          <div class="header-left">
            ${gameControllerSvg}
            <span class="header-title">Flickémon</span>
          </div>
          <div class="header-actions">
            <div class="mode-switch" role="group" aria-label="Battle mode">
              <button class="mode-seg" data-mode="capture" aria-pressed="true" style="font-weight: 700;">
                ${pokeballSvg}<span class="mode-seg-label">Capture</span>
              </button>
              <button class="mode-seg" data-mode="exp" aria-pressed="false">
                ${boltSvg}<span class="mode-seg-label">EXP</span>
              </button>
            </div>
            <button class="pvp-header-btn">${swordsSvg}<span class="pvp-header-label">PVP</span></button>
            <button class="trade-header-btn">${tradeSvg}<span class="pvp-header-label">Trade</span></button>
            <button class="friends-header-btn">${friendsSvg}<span class="pvp-header-label">Friends</span></button>
            <button class="shop-header-btn">${shopSvg}<span class="shop-header-label">₽ 250</span></button>
            <button class="icon-btn menu-trigger-btn">${ellipsisSvg}</button>
            <button class="icon-btn widget-collapse-btn">${chevronUpSvg}</button>
          </div>
        </div>

        <div class="widget-body">
          <div class="hud-columns" style="display: flex; gap: 12px;">
            <div class="hud-col partner-col" style="flex: 1; padding: 8px 12px; background: rgba(0,0,0,0.03); border-radius: 8px;">
              <img src="../../sprites/130.png" alt="Gyarados" class="partner-mini-sprite" style="width: 56px; height: 56px;"/>
              <div class="partner-info" style="flex: 1;">
                <div class="name-line" style="display: flex; justify-content: space-between;">
                  <strong class="pk-name">Gyarados</strong>
                  <span class="pk-lvl" style="color: #64748b; font-weight: 700;">Lv.42</span>
                </div>
                <div class="exp-bar-track" style="height: 6px; background: #e2e8f0; border-radius: 3px; margin: 6px 0; overflow: hidden;">
                  <div class="exp-bar-fill" style="width: 65%; height: 100%; background: #3b82f6;"></div>
                </div>
                <div class="exp-text" style="font-size: 0.72rem; color: #64748b;">EXP 2,440 / 5,419 (+15 EXP/min study)</div>
              </div>
            </div>

            <div class="hud-col battle-col-box" style="flex: 1; padding: 8px 12px; border-radius: 8px; position: relative;">
              <span class="vs-badge" style="position: absolute; left: -10px; top: 18px; padding: 2px 6px; font-size: 0.7rem; font-weight: 800; border-radius: 10px;">VS</span>
              <img src="../../sprites/288.png" alt="Vigoroth" class="wild-mini-sprite fighting" style="width: 56px; height: 56px;"/>
              <div class="battle-info" style="flex: 1;">
                <div class="name-line" style="display: flex; justify-content: space-between;">
                  <strong class="pk-name">Vigoroth</strong>
                  <span class="pk-lvl" style="color: #64748b; font-weight: 700;">Lv.42</span>
                </div>
                <div class="hp-bar-track" style="height: 6px; background: #e2e8f0; border-radius: 3px; margin: 6px 0; overflow: hidden;">
                  <div class="hp-bar-fill" style="width: 48%; height: 100%; background: #10b981;"></div>
                </div>
                <div class="status-line fighting" style="font-size: 0.72rem; color: #059669; font-weight: 600;">
                  ⚔️ Fighting... (HP 57/119) &bull; Watching Lecture...
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sidebar -->
    <div class="sidebar-column">
      <div class="sidebar-card">
        <h2 class="sidebar-h2">Course Lectures</h2>
        <div class="lec-item">
          <div class="lec-title">01. Cardiac Conduction Overview</div>
          <div class="lec-meta">Completed &bull; 45 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill" style="width: 100%;"></div></div>
        </div>
        <div class="lec-item">
          <div class="lec-title">02. Bradyarrhythmias & Heart Block</div>
          <div class="lec-meta">Completed &bull; 50 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill" style="width: 100%;"></div></div>
        </div>
        <div class="lec-item">
          <div class="lec-title">03. Tachyarrhythmias: SVT vs VT</div>
          <div class="lec-meta">Completed &bull; 65 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill" style="width: 100%;"></div></div>
        </div>
        <div class="lec-item active">
          <div class="lec-title">04. Heart Rhythm Management</div>
          <div class="lec-meta">Now Playing &bull; 38/75 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill" style="width: 55%; background: #3b82f6;"></div></div>
        </div>
        <div class="lec-item">
          <div class="lec-title">05. Implantable Devices (ICD/Pacemaker)</div>
          <div class="lec-meta">Next up &bull; 55 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill" style="width: 0%;"></div></div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

// ── 2. Screenshot 2: Actual Full-Webpage Pokémon Theme UI (1280x800) ──
const html2 = `<!DOCTYPE html>
<html lang="en" class="pokemon-theme">
<head>
<meta charset="utf-8"/>
<title>Flick - Full Pokémon Theme</title>
<link rel="stylesheet" href="../../content/styles.css"/>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--pkmn-bg); color: var(--pkmn-text);
    overflow: hidden;
  }
  .layout-grid {
    display: grid; grid-template-columns: 1fr 340px; gap: 20px;
    max-width: 1240px; margin: 20px auto; padding: 0 16px;
  }
  .player-box {
    border-radius: 12px; height: 380px; position: relative;
    display: flex; flex-direction: column; justify-content: space-between;
    overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5);
  }
  .slide-sim {
    padding: 30px; color: #fff; background: linear-gradient(135deg, #0f172a 0%, #16213e 100%);
    height: 100%; display: flex; flex-direction: column; justify-content: center;
  }
  .slide-tag { color: var(--pkmn-border); font-size: 0.85rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
  .slide-h1 { font-size: 1.6rem; font-weight: 800; margin: 8px 0; color: var(--pkmn-white); }
  .slide-desc { color: var(--pkmn-text-muted); font-size: 0.95rem; max-width: 600px; line-height: 1.5; }
  .video-bar {
    height: 44px; background: rgba(22, 33, 62, 0.9); backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: space-between; padding: 0 16px; color: #fff; font-size: 0.85rem;
  }
  .video-progress { height: 4px; background: #334155; position: absolute; bottom: 44px; left: 0; right: 0; }
  .video-progress-fill { width: 70%; height: 100%; background: var(--pkmn-blue); }

  /* Sidebar styling in theme */
  .sidebar-card {
    background: linear-gradient(135deg, var(--pkmn-card-bg) 0%, var(--pkmn-card-mid) 100%);
    border: 1px solid var(--pkmn-slate-border); border-radius: 12px;
    padding: 16px; height: 720px;
  }
  .sidebar-h2 { font-size: 1rem; font-weight: 700; margin: 0 0 14px; color: var(--pkmn-white); }
  .lec-item {
    background: var(--pkmn-card-bg); border: 1px solid var(--pkmn-slate-border);
    padding: 10px; border-radius: 8px; margin-bottom: 8px;
  }
  .lec-item.active { border-left: 4px solid var(--pkmn-primary) !important; background: var(--pkmn-card-mid); }
  .lec-title { font-size: 0.88rem; font-weight: 700; color: var(--pkmn-text); }
  .lec-meta { font-size: 0.75rem; margin-top: 4px; color: var(--pkmn-text-muted); }
  .lec-bar { height: 6px; background: var(--pkmn-fill-item); border-radius: 3px; margin-top: 6px; overflow: hidden; }
  .lec-bar-fill { height: 100%; background: linear-gradient(90deg, var(--pkmn-blue), var(--pkmn-blue-light)); }
  .lec-bar-fill.done { background: linear-gradient(90deg, var(--pkmn-success), var(--pkmn-gold-light)); }

  .partner-mini-sprite, .wild-mini-sprite { image-rendering: pixelated; width: 64px; height: 64px; }
</style>
</head>
<body class="pokemon-theme">
  <!-- Actual Pokéball Top Navigation Bar -->
  <div style="background: linear-gradient(90deg, var(--pkmn-primary) 0%, var(--pkmn-primary-tint) 100%); border-bottom: 3px solid var(--pkmn-dark); display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; min-height: 60px; box-shadow: 0 4px 16px var(--pkmn-shadow-heavy);">
    <div style="display: flex; align-items: center; gap: 14px;">
      <span style="font-size: 1.25rem; font-weight: 800; color: #ffffff; text-shadow: 0 1px 3px rgba(0,0,0,0.5);">
        Flick &bull; Faculty of Medicine
      </span>
      <span style="color: var(--pkmn-gold-light); font-size: 0.9rem; font-weight: 600;">
        &bull; Neurobiology: Synaptic Transmission
      </span>
    </div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <span style="padding: 6px 14px; font-weight: 800; font-size: 0.8rem; background: var(--pkmn-dark); color: var(--pkmn-border); border-radius: 20px; border: 1px solid var(--pkmn-border);">
        ⚡ Pokéball Theme Active
      </span>
    </div>
  </div>

  <div class="layout-grid">
    <div class="main-column">
      <div class="player-box">
        <div class="slide-sim">
          <div class="slide-tag">Neuroscience Core</div>
          <div class="slide-h1">Neurotransmitter Release & Vesicle Docking</div>
          <div class="slide-desc">Role of SNARE complexes, synaptotagmin Ca2+ sensors, and ionotropic vs metabotropic receptor cascades.</div>
        </div>
        <div class="video-progress"><div class="video-progress-fill"></div></div>
        <div class="video-bar">
          <span>▶ 52:10 / 1:15:00</span>
          <span>Quality: 1080p &bull; Speed: 1.0x</span>
        </div>
      </div>

      <!-- ACTUAL THEMED FLICKEMON CARD -->
      <div class="flickemon-card flickemon-widget-card pokemon-theme" style="display: block;">
        <div class="flickemon-header">
          <div class="header-left">
            ${gameControllerSvg}
            <span class="header-title">Flickémon</span>
          </div>
          <div class="header-actions">
            <div class="mode-switch" role="group" aria-label="Battle mode">
              <button class="mode-seg" data-mode="capture" aria-pressed="true">
                ${pokeballSvg}<span class="mode-seg-label">Capture</span>
              </button>
              <button class="mode-seg" data-mode="exp" aria-pressed="false">
                ${boltSvg}<span class="mode-seg-label">EXP</span>
              </button>
            </div>
            <button class="pvp-header-btn">${swordsSvg}<span class="pvp-header-label">PVP</span></button>
            <button class="trade-header-btn">${tradeSvg}<span class="pvp-header-label">Trade</span></button>
            <button class="friends-header-btn">${friendsSvg}<span class="pvp-header-label">Friends</span></button>
            <button class="shop-header-btn">${shopSvg}<span class="shop-header-label">₽ 640</span></button>
            <button class="icon-btn menu-trigger-btn">${ellipsisSvg}</button>
            <button class="icon-btn widget-collapse-btn">${chevronUpSvg}</button>
          </div>
        </div>

        <div class="widget-body">
          <div class="hud-columns" style="display: flex; gap: 12px;">
            <div class="hud-col partner-col" style="flex: 1; padding: 10px 14px; background: var(--pkmn-fill-item); border-radius: 8px;">
              <img src="../../sprites/448.png" alt="Lucario" class="partner-mini-sprite" style="width: 56px; height: 56px;"/>
              <div class="partner-info" style="flex: 1;">
                <div class="name-line" style="display: flex; justify-content: space-between;">
                  <strong class="pk-name">Lucario</strong>
                  <span class="pk-lvl">Lv.62</span>
                </div>
                <div class="exp-bar-track">
                  <div class="exp-bar-fill" style="width: 78%;"></div>
                </div>
                <div class="exp-text">EXP 8,920 / 11,400 (+15 EXP/min)</div>
              </div>
            </div>

            <div class="hud-col battle-col-box" style="flex: 1; padding: 10px 14px; border-radius: 8px; position: relative;">
              <span class="vs-badge">VS</span>
              <img src="../../sprites/94.png" alt="Gengar" class="wild-mini-sprite fighting" style="width: 56px; height: 56px;"/>
              <div class="battle-info" style="flex: 1;">
                <div class="name-line" style="display: flex; justify-content: space-between;">
                  <strong class="pk-name">Gengar</strong>
                  <span class="pk-lvl">Lv.60</span>
                </div>
                <div class="hp-bar-track">
                  <div class="hp-bar-fill" style="width: 35%;"></div>
                </div>
                <div class="status-line fighting">
                  ⚔️ Fighting... (HP 62/178)
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sidebar with Themed Items -->
    <div class="sidebar-column">
      <div class="sidebar-card">
        <h2 class="sidebar-h2">Course Modules</h2>
        <div class="lec-item">
          <div class="lec-title">01. Resting Membrane Potential</div>
          <div class="lec-meta">100% Completed &bull; 40 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill done" style="width: 100%;"></div></div>
        </div>
        <div class="lec-item">
          <div class="lec-title">02. Voltage-Gated Na+/K+ Channels</div>
          <div class="lec-meta">100% Completed &bull; 50 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill done" style="width: 100%;"></div></div>
        </div>
        <div class="lec-item active">
          <div class="lec-title">03. Synaptic Vesicle Dynamics</div>
          <div class="lec-meta" style="color: var(--pkmn-gold-light);">Now Studying &bull; 52/75 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill" style="width: 70%;"></div></div>
        </div>
        <div class="lec-item">
          <div class="lec-title">04. Long-Term Potentiation (LTP)</div>
          <div class="lec-meta">Upcoming &bull; 60 mins</div>
          <div class="lec-bar"><div class="lec-bar-fill" style="width: 0%;"></div></div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

// ── 3. Screenshot 3: Actual Offline Study Credit Modal (1280x800) ──
const html3 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Flick - Welcome Back Modal</title>
<link rel="stylesheet" href="../../content/styles.css"/>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; width: 1280px; height: 800px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b1120;
    overflow: hidden;
    position: relative;
    display: flex; align-items: center; justify-content: center;
  }
  .bg-mockup {
    position: absolute; inset: 0; padding: 30px 40px;
    filter: blur(8px) brightness(0.35);
    background: #1e293b; color: #fff;
  }
  .mock-player { background: #000; height: 420px; border-radius: 12px; margin-top: 20px; }

  /* Actual Flickemon Modal classes from styles.css */
  .flickemon-modal-overlay {
    position: relative; z-index: 10;
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%;
  }
  .flickemon-modal-container {
    width: 460px; max-width: 460px; height: auto; max-height: 95vh;
    box-shadow: 0 25px 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.1);
  }
  .flick-return-sprite { image-rendering: pixelated; width: 72px; height: 72px; }
</style>
</head>
<body>
  <div class="bg-mockup">
    <h2>Flick &bull; Cardiology Course Lecture 04</h2>
    <div class="mock-player"></div>
  </div>

  <div class="flickemon-modal-overlay flick-return-overlay">
    <div class="flickemon-modal-container">
      <div class="flickemon-modal-header">
        <h3 class="flickemon-modal-title">Welcome Back, Trainer!</h3>
      </div>
      <div class="flickemon-modal-content" style="padding: 20px;">
        <div class="flick-return-modal">
          <div class="flick-return-badge">
            <span class="flick-return-device-icon">📱</span>
            <span>Studied on Another Device</span>
          </div>

          <div class="flick-return-hero">
            <img src="../../sprites/6.png" alt="Charizard" class="flick-return-sprite"/>
            <div class="flick-return-partner-info">
              <h3 class="flick-return-partner-name">Charizard</h3>
              <span class="flick-return-partner-lvl">Lv.26</span>
            </div>
          </div>

          <div class="flick-return-lvl-badge">
            🎉 Level Up! <b>Lv.24</b> ➔ <b>Lv.26</b> (+2 Levels!)
          </div>

          <div class="flick-return-stats" style="width: 100%;">
            <div class="flick-return-stat-row">
              <span class="flick-return-stat-label">⏱️ Studied on Flick</span>
              <span class="flick-return-stat-val">1h 45m</span>
            </div>
            <div class="flick-return-stat-row">
              <span class="flick-return-stat-label">📈 Credited Study Time</span>
              <span class="flick-return-stat-val">+32 min <small>(30% offline rate)</small></span>
            </div>
            <div class="flick-return-stat-row is-exp">
              <span class="flick-return-stat-label">⭐ EXP Earned</span>
              <span class="flick-return-stat-val exp-val">+480 EXP</span>
            </div>
            <div class="flick-return-stat-row">
              <span class="flick-return-stat-label">📅 Daily Allowance Remaining</span>
              <span class="flick-return-stat-val">2h 15m left</span>
            </div>
          </div>

          <button class="flick-return-btn" style="width: 100%; margin-top: 10px; cursor: pointer;">
            Awesome! ✨
          </button>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

// ── 4. Small Promo Tile (440x280) — Plain Retro 8-bit Style ──
const html4 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Flickémon Small Promo</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; width: 440px; height: 280px;
    background: #0e121e; color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 16px; border: 4px solid #ee1515; overflow: hidden;
  }
  .header-row { display: flex; align-items: center; justify-content: space-between; }
  .logo-box { display: flex; align-items: center; gap: 10px; }
  .pokeball-8bit { width: 36px; height: 36px; image-rendering: pixelated; }
  .title { font-size: 1.5rem; font-weight: 900; letter-spacing: -0.02em; color: #ffffff; text-shadow: 2px 2px 0 #ee1515; }
  .badge-tag { background: #ee1515; color: #fff; font-size: 0.65rem; font-weight: 800; padding: 3px 8px; border-radius: 4px; }

  .hero-row { display: flex; align-items: center; justify-content: space-around; margin: 4px 0; }
  .sprite-8bit { width: 68px; height: 68px; image-rendering: pixelated; filter: drop-shadow(0 4px 0 rgba(0,0,0,0.6)); }
  .vs-sign { font-size: 0.85rem; font-weight: 900; color: #f59e0b; }

  .footer-row {
    background: #171d2e; border: 2px solid #334155; border-radius: 6px;
    padding: 8px 12px; text-align: center;
  }
  .callout { font-size: 0.78rem; font-weight: 800; color: #38bdf8; letter-spacing: 0.04em; }
  .sub { font-size: 0.65rem; color: #94a3b8; margin-top: 2px; }
</style>
</head>
<body>
  <div class="header-row">
    <div class="logo-box">
      <img src="../../store_assets/store_icon_128x128.png" class="pokeball-8bit" alt="Pokeball"/>
      <span class="title">FLICKÉMON</span>
    </div>
    <span class="badge-tag">CHROME EXTENSION</span>
  </div>

  <div class="hero-row">
    <img src="../../sprites/25.png" class="sprite-8bit" alt="Pikachu"/>
    <span class="vs-sign">&bull; LEVEL UP WHILE STUDYING &bull;</span>
    <img src="../../sprites/94.png" class="sprite-8bit" alt="Gengar"/>
  </div>

  <div class="footer-row">
    <div class="callout">TURN LECTURE TIME INTO POKÉMON EXP</div>
    <div class="sub">Battle &bull; Catch &bull; Evolve &bull; PVP &bull; 100% Free Fan Project</div>
  </div>
</body>
</html>`;

// ── 5. Marquee Promo Banner (1400x560) — Plain Retro 8-bit Style ──
const html5 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Flickémon Marquee Promo</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; width: 1400px; height: 560px;
    background: #0a0d17; color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 36px 48px; border: 8px solid #ee1515; overflow: hidden;
    position: relative;
  }
  .top-strip { display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 20px; }
  .pokeball-8bit { width: 72px; height: 72px; image-rendering: pixelated; }
  .brand-text { font-size: 3.2rem; font-weight: 900; letter-spacing: -0.02em; text-shadow: 4px 4px 0 #ee1515; }
  .pill-version { background: #ee1515; color: #fff; font-size: 1.1rem; font-weight: 800; padding: 8px 18px; border-radius: 8px; }

  .center-stage {
    display: flex; align-items: center; justify-content: space-between;
    background: #141a29; border: 3px solid #334155; border-radius: 16px;
    padding: 24px 36px; margin: 20px 0;
  }
  .stage-left { flex: 1; }
  .h1-tagline { font-size: 2.1rem; font-weight: 900; color: #38bdf8; margin: 0 0 10px; }
  .p-desc { font-size: 1.15rem; color: #cbd5e1; line-height: 1.6; margin: 0; max-width: 720px; }

  .sprites-gallery { display: flex; align-items: center; gap: 24px; }
  .pk-sprite { width: 96px; height: 96px; image-rendering: pixelated; filter: drop-shadow(0 6px 0 rgba(0,0,0,0.6)); }

  .feature-pills { display: flex; gap: 16px; }
  .fpill {
    background: #1a2235; border: 2px solid #334155; border-radius: 8px;
    padding: 10px 18px; font-size: 0.95rem; font-weight: 800; color: #f8fafc;
  }
  .fpill.active { border-color: #f59e0b; color: #f59e0b; }
</style>
</head>
<body>
  <div class="top-strip">
    <div class="brand">
      <img src="../../store_assets/store_icon_128x128.png" class="pokeball-8bit" alt="8-bit Pokeball"/>
      <span class="brand-text">FLICKÉMON</span>
    </div>
    <span class="pill-version">CHROME WEB STORE</span>
  </div>

  <div class="center-stage">
    <div class="stage-left">
      <div class="h1-tagline">STUDY LECTURES. TRAIN POKÉMON. LEVEL UP.</div>
      <p class="p-desc">
        The non-profit study companion for Flick. Converts active lecture watch time
        into battle EXP, wild catches, and team evolutions without leaving your course page.
      </p>
    </div>
    <div class="sprites-gallery">
      <img src="../../sprites/6.png" class="pk-sprite" alt="Charizard"/>
      <img src="../../sprites/25.png" class="pk-sprite" alt="Pikachu"/>
      <img src="../../sprites/130.png" class="pk-sprite" alt="Gyarados"/>
      <img src="../../sprites/94.png" class="pk-sprite" alt="Gengar"/>
    </div>
  </div>

  <div class="feature-pills">
    <span class="fpill active">⚡ Real-Time Study EXP</span>
    <span class="fpill">⚔️ 1,025 Catchable Pokémon</span>
    <span class="fpill">📱 Multi-Device Study Sync</span>
    <span class="fpill">🎨 Whole-Webpage Theme</span>
    <span class="fpill">🛡️ 100% Free & Open Source</span>
  </div>
</body>
</html>`;

fs.writeFileSync(path.join(CAPTURE_DIR, 'screenshot_1.html'), html1);
fs.writeFileSync(path.join(CAPTURE_DIR, 'screenshot_2.html'), html2);
fs.writeFileSync(path.join(CAPTURE_DIR, 'screenshot_3.html'), html3);
fs.writeFileSync(path.join(CAPTURE_DIR, 'small_promo.html'), html4);
fs.writeFileSync(path.join(CAPTURE_DIR, 'marquee_promo.html'), html5);

console.log('HTML templates updated in tools/capture/.');

// ── Capture Images with Headless Chrome ──
const captures = [
  { html: 'screenshot_1.html', out: 'screenshot_1_1280x800.png', w: 1280, h: 800 },
  { html: 'screenshot_2.html', out: 'screenshot_2_1280x800.png', w: 1280, h: 800 },
  { html: 'screenshot_3.html', out: 'screenshot_3_1280x800.png', w: 1280, h: 800 },
  { html: 'small_promo.html',   out: 'small_promo_440x280.png',   w: 440,  h: 280 },
  { html: 'marquee_promo.html', out: 'marquee_promo_1400x560.png', w: 1400, h: 560 }
];

for (const c of captures) {
  const filePath = path.join(CAPTURE_DIR, c.html);
  const outPath = path.join(STORE_DIR, c.out);
  const cmd = `"${CHROME}" --headless --disable-gpu --window-size=${c.w},${c.h} --screenshot="${outPath}" "file://${filePath}"`;
  console.log(`Capturing ${c.out} (${c.w}x${c.h})...`);
  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch (err) {
    console.error(`Error capturing ${c.out}:`, err.message);
  }
}

console.log('All real screenshots and 8-bit promotional assets generated successfully!');
