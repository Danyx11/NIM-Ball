import './style.css';
// Nimiq's brand typeface (nimiq-style design system) — used for the score digits.
import '@fontsource/mulish/800.css';
import { startGame } from './game.js';
import { connectNimiq, chooseAddress, getStoredAddress } from './nimiq.js';
import { initBackground } from './background.js';
import { connectLan } from './net.js';
import { isBasicLaser, setBasicLaser } from './settings.js';
import { decodePointsFromTicketImage, parseReplayFromLocation } from './replay.js';
import { audio } from './audio.js';

const ASSET_BASE = import.meta.env.BASE_URL;

initBackground();

// Loaded once here rather than per-match (see src/audio.js) — game.js's
// startGame() just plays SFX off this same shared instance. Ambience starts
// muted-safe: playAmbience() only ever gets called below, once this promise
// resolves AND a real user gesture has unlocked the context.
const audioReady = audio.load();

// Unlocks the WebAudio context on the very first user gesture anywhere on
// the page (mode tile, connect button, logo…) — see audio.js's unlock() doc:
// resume() only actually takes effect from inside a real gesture handler,
// and pointerdown always fires before the click handlers below that call
// audio.play('button').
document.addEventListener('pointerdown', () => audio.unlock(), { once: true });

// ---- Master VU meter (mixing aid, #vuMeter in index.html) — reads the real
// combined output via audio.js's getMasterPeakDb(), not a per-sound gauge.
// Linear-in-dB scale from VU_FLOOR_DB (bottom, 0% lit) to 0dBFS (top, 100%
// lit) — the standard convention for this kind of meter. Zone colors are
// baked into #vuTrack's CSS gradient (green/yellow/red); this loop only
// moves the dark mask (#vuFill) that covers the unlit portion from the top,
// plus a peak-hold marker that jumps to the loudest recent instant and decays
// back down, so a brief transient is still readable a moment later instead
// of only flickering by for one frame.
const VU_FLOOR_DB = -48;
const VU_HOLD_MS = 2500;      // was 1200 — sits still noticeably longer before decaying
const VU_DECAY_DB_PER_S = 12; // was 24 — half as fast once it does start decaying
const vuFill = document.getElementById('vuFill');
const vuPeakHold = document.getElementById('vuPeakHold');
const vuPeakLabel = document.getElementById('vuPeakLabel');
const vuMaxLabel = document.getElementById('vuMaxLabel');
function dbToPercent(db) {
  return Math.max(0, Math.min(100, ((db - VU_FLOOR_DB) / (0 - VU_FLOOR_DB)) * 100));
}
function colorForDb(db) { return db > -3 ? '#e74c3c' : db > -6 ? '#f1c40f' : '#dbe6ff'; }
let vuHoldDb = -Infinity;
let vuHoldAt = 0;
let vuLastFrame = performance.now();
// Absolute max ever seen (since load, or since the last click-to-reset below)
// — never decays on its own, unlike vuHoldDb above, so a single loud outlier
// hours into a session is never missed just because it wasn't glanced at
// the instant it happened.
let vuMaxDb = -Infinity;
vuMaxLabel.addEventListener('click', () => { vuMaxDb = -Infinity; });
function updateVuMeter() {
  const now = performance.now();
  const dt = (now - vuLastFrame) / 1000;
  vuLastFrame = now;
  const db = audio.getMasterPeakDb();
  if (db >= vuHoldDb) {
    vuHoldDb = db;
    vuHoldAt = now;
  } else if (now - vuHoldAt > VU_HOLD_MS) {
    vuHoldDb = Math.max(db, vuHoldDb - VU_DECAY_DB_PER_S * dt);
  }
  if (db > vuMaxDb) vuMaxDb = db;
  const levelPct = dbToPercent(db);
  vuFill.style.height = `${100 - levelPct}%`;
  const holdPct = dbToPercent(vuHoldDb);
  vuPeakHold.style.bottom = `${holdPct}%`;
  vuPeakHold.style.opacity = vuHoldDb > VU_FLOOR_DB ? '1' : '0';
  vuPeakLabel.textContent = vuHoldDb > VU_FLOOR_DB ? vuHoldDb.toFixed(1) : '-∞';
  vuPeakLabel.style.color = colorForDb(vuHoldDb);
  vuMaxLabel.textContent = vuMaxDb > VU_FLOOR_DB ? vuMaxDb.toFixed(1) : '-∞';
  vuMaxLabel.style.color = colorForDb(vuMaxDb);
  requestAnimationFrame(updateVuMeter);
}
requestAnimationFrame(updateVuMeter);

// ---- Sound trigger log (#soundLog in index.html, debug aid) — shows a
// one-shot SFX's own name for SOUND_LOG_MS every time audio.js's onPlay()
// fires, so a sound you can hear but can't place shows itself here as it
// triggers. Fixed row count, round-robin: a new trigger claims the next row
// in order (wrapping around) regardless of whether older rows have expired
// yet, so several sounds firing close together each get their own visible
// row instead of overwriting one shared line.
const SOUND_LOG_ROWS = 6;
const SOUND_LOG_MS = 3000;
const soundLogEl = document.getElementById('soundLog');
const soundLogSlots = Array.from({ length: SOUND_LOG_ROWS }, () => {
  const row = document.createElement('div');
  row.className = 'sound-log-row';
  soundLogEl.appendChild(row);
  return { el: row, expiresAt: 0 };
});
let soundLogNext = 0;
audio.onPlay((name) => {
  const slot = soundLogSlots[soundLogNext];
  soundLogNext = (soundLogNext + 1) % SOUND_LOG_ROWS;
  slot.el.textContent = name;
  slot.el.classList.add('show');
  slot.expiresAt = performance.now() + SOUND_LOG_MS;
});
function updateSoundLog() {
  const now = performance.now();
  for (const slot of soundLogSlots) {
    if (slot.expiresAt && now >= slot.expiresAt) {
      slot.el.classList.remove('show');
      slot.expiresAt = 0;
    }
  }
  requestAnimationFrame(updateSoundLog);
}
requestAnimationFrame(updateSoundLog);

// ---- Toolbar: 6 buttons pulled from design-lab's "boutons" layer (+
// hand-supplied "exit" and "chat" icons), sat above the board in two rows of
// 3 (see style.css #toolbar/.tbtn-row and index.html for the row split).
// "play" replaced the old canvas PLAY cap and is wired to the real launch
// action inside game.js's startGame(); "power" toggles game.js's aim-laser
// mode (full predictive cascade vs a basic direction/energy line, see
// settings.js); "sweep" (id kept as "sweep", asset files renamed from the old
// btn-clear-*.png — see git history — since its broom art turned out to be
// the perfect fit for the curling-style "balai" slippery-patch feature) is
// wired inside game.js's startGame() alongside "play", since it needs live
// access to phase/entities state; "exit" shows a quit-confirm dialog in the
// shared #overlay (below); "sound" toggles the shared audio singleton's mute
// (see below); "chat" (reserved for an eventual in-match chat window) is
// still a placeholder, so this just plays the click SFX/animation and logs a
// stub for it.
const TOOLBAR_BUTTONS = ['sound', 'power', 'sweep', 'play', 'exit', 'chat'];
const TOOLBAR_STUB_BUTTONS = ['chat'];
TOOLBAR_BUTTONS.forEach((id) => {
  document.getElementById(`tbtn-${id}-img`).src = `${ASSET_BASE}ui/btn-${id}.png`;
  document.getElementById(`tbtn-${id}-cap`).src = `${ASSET_BASE}ui/btn-${id}-cap.png`;
});
// Routed through the shared WebAudio singleton (see src/audio.js) rather
// than a standalone <audio> element — keeps the toolbar's click in sync
// with the "sound" mute toggle instead of always playing regardless of it.
function playToolbarClick(cap) {
  audio.play('button');
  cap.classList.remove('pressed');
  void cap.offsetWidth; // restart the animation if pressed again mid-tween
  cap.classList.add('pressed');
}
TOOLBAR_STUB_BUTTONS.forEach((id) => {
  const cap = document.getElementById(`tbtn-${id}-cap`);
  const btn = document.getElementById(`tbtn-${id}`);
  btn.addEventListener('click', () => {
    playToolbarClick(cap);
    console.log(`[toolbar] ${id} pressed — function not implemented yet`);
  });
});

// "power" off (basic laser) swaps in a hollowed-out variant of the bolt icon
// (thin outline, near-white fill instead of solid black — see
// scripts/make_power_off_icon.py) so the toggle reads as disengaged without
// dimming the whole disc. Read the persisted preference (see settings.js) at
// load so a reload doesn't silently reset it back to the full predictive laser.
const POWER_CAP_SRC = { on: `${ASSET_BASE}ui/btn-power-cap.png`, off: `${ASSET_BASE}ui/btn-power-cap-off.png` };
const powerBtn = document.getElementById('tbtn-power');
const powerCap = document.getElementById('tbtn-power-cap');
function syncPowerButton() { powerCap.src = isBasicLaser() ? POWER_CAP_SRC.off : POWER_CAP_SRC.on; }
syncPowerButton();
powerBtn.addEventListener('click', () => {
  playToolbarClick(powerCap);
  setBasicLaser(!isBasicLaser());
  syncPowerButton();
});

// "sound": mutes/unmutes the shared audio singleton — every in-match SFX
// (game.js) plus the ambience loop below all read the same muted flag, so
// this one button silences everything at once. No second baked icon for the
// muted state (unlike power's off variant) — a CSS-drawn slash over the cap
// instead (see .tbtn-muted-slash, style.css), same technique already used
// for the sweep button's "used" cross.
const soundBtn = document.getElementById('tbtn-sound');
const soundCap = document.getElementById('tbtn-sound-cap');
const soundSlash = document.getElementById('tbtn-sound-slash');
function syncSoundButton() { soundSlash.classList.toggle('show', audio.isMuted()); }
syncSoundButton();
soundBtn.addEventListener('click', () => {
  playToolbarClick(soundCap);
  audio.setMuted(!audio.isMuted());
  syncSoundButton();
});

// "exit": standard confirm dialog in the shared #overlay/#ovContent modal
// (see showLobby/hideLobby below, also used for the LAN lobby screens) rather
// than a bespoke one — reloading the page on confirm is the simplest way to
// get back to a clean mode-select screen, since startGame() has no teardown
// path of its own to unwind an in-progress match.
const exitBtn = document.getElementById('tbtn-exit');
const exitCap = document.getElementById('tbtn-exit-cap');
exitBtn.addEventListener('click', () => {
  playToolbarClick(exitCap);
  showLobby(`
    <h2>Quitter la partie ?</h2>
    <p>La partie en cours sera perdue.</p>
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="exitYesBtn">Oui</button>
      <button class="bigbtn" id="exitNoBtn">Non</button>
    </div>
  `);
  // stopAmbience() explicitly rather than relying on reload()'s teardown —
  // makes the cut instant instead of trailing for whatever the navigation
  // takes to commit. reload() itself waits for exitPanel's onEnded so the
  // clip is never cut short by the navigation (muted/missing still resolves
  // instantly, see play()'s onEnded contract).
  document.getElementById('exitYesBtn').onclick = () => {
    audio.stopAmbience();
    audio.play('exitPanel', { volume: 0.501, onEnded: () => location.reload() }); // -6dB
  };
  document.getElementById('exitNoBtn').onclick = () => { audio.play('button'); hideLobby(); };
});

// Nimiq logo doubles as a "back to menu" shortcut, same confirm dialog as
// the exit toolbar button above (only relevant once a match is running —
// on the mode-select screen there's no game in progress to lose) — always
// confirmed, replay included, so an accidental click never dumps the player
// straight out. In replay, "Oui" reuses replayExitBtn's own exit path
// (game.js): a plain reload() would re-read a still-present ?replay= param
// and jump straight back into the same replay.
const bgLogo = document.getElementById('bg-logo');
const replayBar = document.getElementById('replayBar');
bgLogo.addEventListener('click', () => {
  if (!modeOverlay.classList.contains('hidden')) return;
  audio.play('button');
  const inReplay = !replayBar.classList.contains('hidden');
  showLobby(`
    <h2>Revenir au menu ?</h2>
    <p>${inReplay ? 'Le replay en cours sera interrompu.' : 'La partie en cours sera perdue.'}</p>
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="logoYesBtn">Oui</button>
      <button class="bigbtn" id="logoNoBtn">Non</button>
    </div>
  `);
  document.getElementById('logoYesBtn').onclick = () => {
    audio.stopAmbience();
    if (inReplay) {
      // Replay's "Oui" keeps the plain button click (same as replayExitBtn's
      // own direct exit) — only a live match's quit gets the exit-panel sound.
      audio.play('button');
      location.href = location.pathname;
    } else {
      // Navigation waits for exitPanel's onEnded so the clip is never cut
      // short by the reload (muted/missing still resolves instantly).
      audio.play('exitPanel', { volume: 0.501, onEnded: () => location.reload() }); // -6dB
    }
  };
  document.getElementById('logoNoBtn').onclick = () => { audio.play('button'); hideLobby(); };
});

// Best-effort: only succeeds when the app is opened inside Nimiq Pay.
// Logged for now — wire this up to real features (wallet identity,
// on-chain results, etc.) as the Mini App integration grows.
connectNimiq()
  .then((nimiq) => console.log('[nimiq] provider ready', nimiq))
  .catch((err) => console.log('[nimiq] not running inside Nimiq Pay:', err.message));

// ---- Desktop wallet identity (Nimiq Hub, see src/nimiq.js's chooseAddress,
// still pointed at testnet — see CLAUDE.md-worthy note there on the endpoint
// gotcha). The chosen address is remembered and swapped into whichever team
// the local player ends up controlling, in place of the placeholder
// identicon, so it's visible in-game once a match starts.
let hubAddress = getStoredAddress();
function identiconOverride(team) {
  return hubAddress ? { [team]: hubAddress } : {};
}
const connectBtn = document.getElementById('connectBtn');
const connectBtnLabel = document.getElementById('connectBtnLabel');
if (hubAddress) {
  connectBtnLabel.textContent = `${hubAddress.slice(0, 9)}…`;
  connectBtn.classList.add('connected');
}
connectBtn.addEventListener('click', () => {
  audio.play('button');
  chooseAddress()
    .then((result) => {
      hubAddress = result.address;
      connectBtnLabel.textContent = `${result.address.slice(0, 9)}…`;
      connectBtn.classList.add('connected');
      console.log('[hub] address chosen', result);
    })
    .catch((err) => console.log('[hub] chooseAddress failed:', err.message || err));
});

// ---- Mode select: local pass-and-play vs LAN duel (see CLAUDE.md "LAN mode") ----
// startGame() isn't called until a mode is picked, so it only ever runs once
// per page load — local mode calls it plain, LAN mode passes {net, myTeam}
// once both players are connected.
const modeOverlay = document.getElementById('modeOverlay');
const modeLocal = document.getElementById('modeLocal');
const modeLan = document.getElementById('modeLan');
const modeSolo = document.getElementById('modeSolo');
const modeReplay = document.getElementById('modeReplay');
const startOverlay = document.getElementById('startOverlay');
const overlay = document.getElementById('overlay');
const ovContent = document.getElementById('ovContent');

function showLobby(html) { overlay.classList.remove('hidden'); ovContent.innerHTML = html; }
function hideLobby() { overlay.classList.add('hidden'); }

// Ambience plays during an actual match or replay, never behind the
// mode-select menu — called directly from the replay entry points below
// (replay has no arcade toolbar or match-start intro of its own, see "Replay
// mode" below). For a live match (local/solo/LAN), it's instead kicked off
// by game.js itself once the match-start intro's SFX has finished (see
// beginMatchIntro() in game.js) rather than here at showToolbar() time, so
// the forest loop doesn't talk over the match-start clip. Each of these call
// sites runs inside a click/change handler, a real user gesture, so unlock()
// here is safe; playAmbience() itself waits for load() to have actually
// decoded the track.
function beginAmbience() {
  audio.unlock();
  audioReady.then(() => audio.playAmbience());
}

// Toolbar reads as arena chrome, not app UI — stays hidden through mode-select
// (and, for LAN, the address-entry/waiting-for-opponent lobby) and is only
// revealed right at each of the 3 actual startGame() call sites below.
const toolbar = document.getElementById('toolbar');
function showToolbar() {
  toolbar.classList.remove('hidden');
}

modeLocal.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  startOverlay.classList.remove('hidden');
  showToolbar();
  startGame({ identiconAddress: identiconOverride('A') });
});

modeLan.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  showLanJoinScreen();
});

// Solo vs IA: only one human, controlling team A — no ready-tap lobby needed
// (game.js's aiTeam branch skips #startOverlay itself), straight into aimA.
modeSolo.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  showToolbar();
  startGame({ aiTeam: 'B', identiconAddress: identiconOverride('A') });
});

// ---- Replay mode (see CLAUDE.md replay section) — upload a saved ticket
// image, decode whichever of its up-to-5 point QR tiles are present (see
// src/replay.js's decodePointsFromTicketImage, which crops the ticket's
// known fixed layout rather than doing general multi-QR detection), and
// assemble them into a playable replay. No arcade #toolbar here — replay
// gets its own custom playback bar, wired inside game.js's startGame().
const replayUploadOverlay = document.getElementById('replayUploadOverlay');
const replayUploadBox = document.getElementById('replayUploadBox');
const replayFileInput = document.getElementById('replayFileInput');
const replayChooseFileBtn = document.getElementById('replayChooseFileBtn');
const replayUploadCancelBtn = document.getElementById('replayUploadCancelBtn');
const replayUploadStatus = document.getElementById('replayUploadStatus');

modeReplay.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  replayUploadStatus.textContent = '';
  replayUploadOverlay.classList.remove('hidden');
});
replayUploadCancelBtn.addEventListener('click', () => {
  audio.play('button');
  replayUploadOverlay.classList.add('hidden');
  modeOverlay.classList.remove('hidden');
});
replayChooseFileBtn.addEventListener('click', () => { audio.play('button'); replayFileInput.click(); });
replayFileInput.addEventListener('change', () => {
  const file = replayFileInput.files[0];
  if (file) handleReplayFile(file);
});
['dragover', 'dragenter'].forEach((evt) => {
  replayUploadBox.addEventListener(evt, (e) => { e.preventDefault(); replayUploadBox.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach((evt) => {
  replayUploadBox.addEventListener(evt, (e) => { e.preventDefault(); replayUploadBox.classList.remove('dragover'); });
});
replayUploadBox.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleReplayFile(file);
});
async function handleReplayFile(file) {
  replayUploadStatus.textContent = 'Lecture du ticket…';
  try {
    const points = await decodePointsFromTicketImage(file);
    if (points.length === 0) {
      replayUploadStatus.textContent = 'Aucun point trouvé sur ce ticket.';
      return;
    }
    replayUploadOverlay.classList.add('hidden');
    beginAmbience();
    startGame({ replayPoints: points });
  } catch (err) {
    replayUploadStatus.textContent = 'Impossible de lire ce fichier.';
    console.log('[replay] decode failed:', err);
  }
}

// Same-origin default: correct as-is for `npm run duel` (page + arbiter share
// one port, see server/duel-server.js), just needs editing for the advanced
// two-process flow (`npm run lan-server` on its own port).
function defaultLanAddress() {
  return `ws://${location.host}`;
}

function showLanJoinScreen(errorMsg) {
  showLobby(`
    <h2>Duel LAN</h2>
    <p>Adresse du serveur (déjà pré-remplie si tu as lancé <code>npm run duel</code>) :</p>
    <input id="lanAddr" type="text" value="${defaultLanAddress()}" autocomplete="off" />
    <button class="bigbtn" id="lanJoinBtn">Rejoindre</button>
    ${errorMsg ? `<p class="lan-error">${errorMsg}</p>` : ''}
  `);
  const addrInput = document.getElementById('lanAddr');
  const joinBtn = document.getElementById('lanJoinBtn');
  joinBtn.onclick = () => { audio.play('button'); joinLan(addrInput.value.trim(), joinBtn); };
}

async function joinLan(raw, joinBtn) {
  if (!raw) return;
  const addr = /^wss?:\/\//.test(raw) ? raw : `ws://${raw}`;
  if (joinBtn) joinBtn.disabled = true;
  try {
    const net = await connectLan(addr);
    showWaitingScreen(net);
  } catch (err) {
    showLanJoinScreen(err.message);
  }
}

function showWaitingScreen(net) {
  const teamLabel = net.myTeam === 'A' ? 'ÉQUIPE BLEUE' : 'ÉQUIPE JAUNE';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  showLobby(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>En attente de l'adversaire…</h2>
    <p>Partage le lien avec l'autre joueur si ce n'est pas déjà fait.</p>
  `);
  net.onOpponentJoined(() => {
    hideLobby();
    showToolbar();
    startGame({ net, myTeam: net.myTeam, identiconAddress: identiconOverride(net.myTeam) });
  });
  net.onDisconnect(() => {
    showLanJoinScreen("L'autre joueur s'est déconnecté.");
  });
}

// Magic links, both skip mode-select entirely: ?duel (printed by `npm run
// duel`) connects straight to this same page's arbiter; ?replay=<data>
// (from a point QR — see src/replay.js buildReplayUrl) jumps straight into
// replaying that single point, same "no menu detour" idea as ?duel.
const replayFromLink = parseReplayFromLocation();
if (replayFromLink) {
  modeOverlay.classList.add('hidden');
  beginAmbience();
  startGame({ replayPoints: [replayFromLink] });
} else if (new URLSearchParams(location.search).has('duel')) {
  modeOverlay.classList.add('hidden');
  showLobby(`<h2>Connexion…</h2><p>Connexion au serveur du duel.</p>`);
  joinLan(defaultLanAddress(), null);
}
