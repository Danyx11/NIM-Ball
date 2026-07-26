import './style.css';
// Nimiq's brand typeface (nimiq-style design system) — used for the score digits.
import '@fontsource/mulish/800.css';
import { startGame } from './game.js';
import { connectNimiq } from './nimiq.js';
import { initBackground } from './background.js';
import { connectLan } from './net.js';
import { isBasicLaser, setBasicLaser } from './settings.js';

const ASSET_BASE = import.meta.env.BASE_URL;

initBackground();

// ---- Toolbar: 5 buttons pulled from design-lab's "boutons" layer (+ a 5th,
// hand-supplied "exit" icon), sat above the board (see style.css #toolbar).
// "play" replaced the old canvas PLAY cap and is wired to the real launch
// action inside game.js's startGame(); "power" toggles game.js's aim-laser
// mode (full predictive cascade vs a basic direction/energy line, see
// settings.js); "sweep" (id kept as "sweep", asset files renamed from the old
// btn-clear-*.png — see git history — since its broom art turned out to be
// the perfect fit for the curling-style "balai" slippery-patch feature) is
// wired inside game.js's startGame() alongside "play", since it needs live
// access to phase/entities state; "exit" shows a quit-confirm dialog in the
// shared #overlay (below) — "sound" is still a placeholder, so this just
// plays the click SFX/animation and logs a stub for it.
const TOOLBAR_BUTTONS = ['sound', 'power', 'sweep', 'play', 'exit'];
const TOOLBAR_STUB_BUTTONS = ['sound'];
const toolbarClickSfx = new Audio(`${ASSET_BASE}sfx/button.wav`);
TOOLBAR_BUTTONS.forEach((id) => {
  document.getElementById(`tbtn-${id}-img`).src = `${ASSET_BASE}ui/btn-${id}.png`;
  document.getElementById(`tbtn-${id}-cap`).src = `${ASSET_BASE}ui/btn-${id}-cap.png`;
});
function playToolbarClick(cap) {
  toolbarClickSfx.currentTime = 0;
  toolbarClickSfx.play().catch(() => {});
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
  document.getElementById('exitYesBtn').onclick = () => location.reload();
  document.getElementById('exitNoBtn').onclick = () => hideLobby();
});

// Best-effort: only succeeds when the app is opened inside Nimiq Pay.
// Logged for now — wire this up to real features (wallet identity,
// on-chain results, etc.) as the Mini App integration grows.
connectNimiq()
  .then((nimiq) => console.log('[nimiq] provider ready', nimiq))
  .catch((err) => console.log('[nimiq] not running inside Nimiq Pay:', err.message));

// ---- Mode select: local pass-and-play vs LAN duel (see CLAUDE.md "LAN mode") ----
// startGame() isn't called until a mode is picked, so it only ever runs once
// per page load — local mode calls it plain, LAN mode passes {net, myTeam}
// once both players are connected.
const modeOverlay = document.getElementById('modeOverlay');
const modeLocal = document.getElementById('modeLocal');
const modeLan = document.getElementById('modeLan');
const modeSolo = document.getElementById('modeSolo');
const startOverlay = document.getElementById('startOverlay');
const overlay = document.getElementById('overlay');
const ovContent = document.getElementById('ovContent');

function showLobby(html) { overlay.classList.remove('hidden'); ovContent.innerHTML = html; }
function hideLobby() { overlay.classList.add('hidden'); }

// Toolbar reads as arena chrome, not app UI — stays hidden through mode-select
// (and, for LAN, the address-entry/waiting-for-opponent lobby) and is only
// revealed right at each of the 3 actual startGame() call sites below.
const toolbar = document.getElementById('toolbar');
function showToolbar() { toolbar.classList.remove('hidden'); }

modeLocal.addEventListener('click', () => {
  modeOverlay.classList.add('hidden');
  startOverlay.classList.remove('hidden');
  showToolbar();
  startGame();
});

modeLan.addEventListener('click', () => {
  modeOverlay.classList.add('hidden');
  showLanJoinScreen();
});

// Solo vs IA: only one human, controlling team A — no ready-tap lobby needed
// (game.js's aiTeam branch skips #startOverlay itself), straight into aimA.
modeSolo.addEventListener('click', () => {
  modeOverlay.classList.add('hidden');
  showToolbar();
  startGame({ aiTeam: 'B' });
});

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
  joinBtn.onclick = () => joinLan(addrInput.value.trim(), joinBtn);
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
  const teamLabel = net.myTeam === 'A' ? 'ÉQUIPE BLEUE' : 'ÉQUIPE ROUGE';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  showLobby(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>En attente de l'adversaire…</h2>
    <p>Partage le lien avec l'autre joueur si ce n'est pas déjà fait.</p>
  `);
  net.onOpponentJoined(() => {
    hideLobby();
    showToolbar();
    startGame({ net, myTeam: net.myTeam });
  });
  net.onDisconnect(() => {
    showLanJoinScreen("L'autre joueur s'est déconnecté.");
  });
}

// Magic link (?duel, printed by `npm run duel`): skip mode-select and the
// address form entirely, connect straight to this same page's arbiter.
if (new URLSearchParams(location.search).has('duel')) {
  modeOverlay.classList.add('hidden');
  showLobby(`<h2>Connexion…</h2><p>Connexion au serveur du duel.</p>`);
  joinLan(defaultLanAddress(), null);
}
