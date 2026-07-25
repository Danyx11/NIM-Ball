import './style.css';
// Nimiq's brand typeface (nimiq-style design system) — used for the score digits.
import '@fontsource/mulish/800.css';
import { startGame } from './game.js';
import { connectNimiq } from './nimiq.js';
import { initBackground } from './background.js';
import { connectLan } from './net.js';

initBackground();

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

modeLocal.addEventListener('click', () => {
  modeOverlay.classList.add('hidden');
  startOverlay.classList.remove('hidden');
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
