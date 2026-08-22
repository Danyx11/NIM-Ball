import './style.css';
// Nimiq's brand typeface (nimiq-style design system) — used for the score digits.
import '@fontsource/mulish/800.css';
import { startGame, preloadCoreAssets } from './game.js';
import { connectNimiq, chooseAddress, getStoredAddress } from './nimiq.js';
import { initBackground, preloadBackgroundAssets } from './background.js';
import { connectLan, connectMatch } from './net.js';
import { isBasicLaser, setBasicLaser } from './settings.js';
import { decodePointsFromTicketImage, parseReplayFromLocation } from './replay.js';
import { audio } from './audio.js';

const ASSET_BASE = import.meta.env.BASE_URL;

// Branded loading screen (index.html's #loadingOverlay, self-contained/
// inline there since it must render before this module's own CSS/JS have
// finished downloading — see the comment above it). Visible by default in
// the raw HTML; stays up (see the preloadBackgroundAssets() await further
// down) only until the home/mode-select screens' own images are ready —
// whoever opens Nim-Curl is here to play, so match assets (preloadCoreAssets())
// start downloading in the background right as the overlay lifts rather than
// also gating it, so the menu appears sooner while the match itself is
// already most of the way loaded by the time a player picks a mode. Reused
// below (showLoadingOverlay/hideLoadingOverlay) for the LAN/match connection
// wait and the replay-ticket decode wait.
const loadingOverlay = document.getElementById('loadingOverlay');
function showLoadingOverlay() { loadingOverlay.classList.remove('hidden'); }
function hideLoadingOverlay() { loadingOverlay.classList.add('hidden'); }

// PWA offline shell (public/sw.js, public/manifest.json) — production only:
// registering it during `npm run dev` would let it start intercepting fetch
// requests and serving stale cached responses over Vite's own dev
// server/HMR traffic.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${ASSET_BASE}sw.js`).catch(() => {});
  });
}

// Mobile port (see CLAUDE.md/joystick design notes): detected once at load
// via the standard coarse-vs-fine pointer media feature (true for
// touch-primary devices, false for mouse/trackpad) rather than screen width,
// since a touch laptop shouldn't get the phone layout and a resized desktop
// window shouldn't lose it. Drives both the CSS stack (.mobile-layout, see
// style.css) and game.js's input mode (tap-select + joystick vs. direct
// mouse drag) — passed into every startGame() call below.
const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches;
if (IS_MOBILE) document.body.classList.add('mobile-layout');

// TEMP debug readout (?debuglayout) — on-screen instead of devtools since
// this is being diagnosed on a device we can't attach an inspector to
// easily. Remove once the mobile #game-card sizing issue is confirmed fixed.
if (new URLSearchParams(location.search).has('debuglayout')) {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;top:0;left:0;z-index:999999;background:#000;color:#0f0;font:11px monospace;padding:6px;margin:0;white-space:pre-wrap;max-width:100vw;';
  document.body.appendChild(box);
  function report() {
    const gc = document.getElementById('game-card');
    const r = gc ? gc.getBoundingClientRect() : null;
    const cs = gc ? getComputedStyle(gc) : null;
    const sw = document.getElementById('stage-wrap');
    const swr = sw ? sw.getBoundingClientRect() : null;
    const swcs = sw ? getComputedStyle(sw) : null;
    const canvas = document.getElementById('stage');
    const cr = canvas ? canvas.getBoundingClientRect() : null;
    box.textContent = [
      `IS_MOBILE=${IS_MOBILE}`,
      `bodyClass=${document.body.className}`,
      `win=${window.innerWidth}x${window.innerHeight}`,
      `screen=${screen.width}x${screen.height}`,
      `viewport-fit-cover=${document.querySelector('meta[name="viewport"]')?.content.includes('viewport-fit=cover')}`,
      `pointer:coarse=${window.matchMedia('(pointer: coarse)').matches}`,
      `orientation:portrait=${window.matchMedia('(orientation: portrait)').matches}`,
      gc ? `game-card rect: left=${r.left.toFixed(1)} right=${r.right.toFixed(1)} top=${r.top.toFixed(1)} bottom=${r.bottom.toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)}` : 'game-card NOT FOUND',
      cs ? `computed --card-w=${cs.getPropertyValue('--card-w')} width=${cs.width}` : '',
      sw ? `stage-wrap class=${sw.className} rect: left=${swr.left.toFixed(1)} right=${swr.right.toFixed(1)} top=${swr.top.toFixed(1)} bottom=${swr.bottom.toFixed(1)} w=${swr.width.toFixed(1)} h=${swr.height.toFixed(1)}` : 'stage-wrap NOT FOUND',
      swcs ? `stage-wrap computed width=${swcs.width}` : '',
      cr ? `canvas#stage rect: left=${cr.left.toFixed(1)} right=${cr.right.toFixed(1)} w=${cr.width.toFixed(1)} h=${cr.height.toFixed(1)}` : 'canvas NOT FOUND',
    ].join('\n');
  }
  report();
  window.addEventListener('resize', report);
  setInterval(report, 1000);
}

// Detach #stage-wrap (the canvas, plus #startOverlay — the ready-tap team
// pick, the one overlay whose team-color wash needs to align with the ice
// rect *as drawn on the canvas*, see the .team-select comment in style.css)
// out from under #app/#scene's transform-scaled subtree, onto #game-card
// directly (never transform-scaled, only ever translateY'd for vertical
// centering — see .stage-wrap-detached in style.css for the real-size CSS
// this relies on and why: CSS `transform: scale()` rasterizes a layer at
// ~its pre-transform size and blows that bitmap up for display, reading as
// soft on mobile GPUs no matter how high-res the canvas backing buffer is).
// #overlay, #modeOverlay, #replayUploadOverlay, #replayBar and #syncToast
// also live inside #stage-wrap in the markup (index.html) but don't want the
// canvas's own zoomed real size — they're plain edge/corner-anchored panels
// (e.g. #modeOverlay's right-docked drawer, #replayBar's bottom transport
// pill, #syncToast's top-centered pill) meant to fill #game-card at its
// true, un-zoomed size, not get stretched into the same oversized box as
// the board and then have their non-centered edges clipped off by
// #game-card's overflow:hidden. So those five get pulled out to their own
// #game-card children instead, each keeping its own existing
// position:absolute (now resolving against #game-card's real size).
// #syncToast was missed in an earlier pass of this same fix — left nested in
// #stage-wrap, its `top:6%` resolved against the cropped/zoomed mobile box
// instead, landing entirely off-screen above the viewport (confirmed via
// getBoundingClientRect returning a negative top/bottom pair) rather than
// merely misplaced. This runs on EVERY device, not just mobile: the base #scene
// rule (see style.css) applies its own always-on scale(1.3) "zoom" for
// desktop too (mobile's .mobile-layout #scene rule just overrides it with a
// bigger value), so an edge-anchored panel left inside #stage-wrap gets
// pushed outside #game-card's clip on desktop exactly the same way it did on
// mobile before this fix — #replayBar's transport controls silently
// clipped off-screen was the reported symptom.
// Happens once here at load, before #modeOverlay is ever shown, rather than
// inside startGame()'s own `mobile` branch — mode-select is the very first
// screen a player sees and it's nested inside stage-wrap too, so waiting
// until a match actually starts left it (and every other overlay sharing
// that nesting) positioned against #scene's still-applied zoom on that first
// screen, which is what the old `.mobile-layout #overlay`/
// `.mobile-layout .team-select` counter-scale(0.5) rules were trying to
// compensate for — imprecisely (transform-origin mismatches between the two
// nested scales, not a real cancellation, and wrong entirely for
// edge-anchored content like the mode-select drawer), which is why panels
// ran off-screen or half cut-off at some real phone aspect ratios despite
// looking fine in a quick emulator check.
{
  const gameCard = document.getElementById('game-card');
  const stageWrap = document.getElementById('stage-wrap');
  // #stage-wrap itself (the canvas) only needs detaching on mobile, to
  // escape the blurry CSS transform:scale() upscale on mobile GPUs (see
  // .stage-wrap-detached in style.css) — desktop's own zoom is meant to
  // keep scaling the canvas along with the rest of #scene.
  if (IS_MOBILE) {
    stageWrap.classList.add('stage-wrap-detached');
    gameCard.prepend(stageWrap);
    // #chatBar (the LAN chat windows) is #stage-wrap's own flex sibling
    // inside #app on desktop, stacking directly below the board in that
    // flex column — but #app is still nested inside #scene, which keeps its
    // own mobile zoom transform (scale(1.627) etc., see .mobile-layout
    // #scene) even after #stage-wrap itself is pulled out of it above. Left
    // in place, #chatBar was the only remaining child of that still-
    // transformed #app, so it inherited the same crop math meant only for
    // the board — confirmed via getBoundingClientRect landing entirely
    // above the viewport (top ~-190px), not just misplaced. Detached here,
    // mobile-only (desktop's own #chatBar positioning already works, it
    // never lost its stage-wrap sibling), with its own absolute
    // bottom-anchored position picking up in style.css's
    // `.mobile-layout #chatBar` rule instead of the flex layout it can no
    // longer participate in as a #game-card child.
    gameCard.appendChild(document.getElementById('chatBar'));
  }
  ['overlay', 'replayBar', 'modeOverlay', 'replayUploadOverlay', 'syncToast'].forEach((id) => {
    gameCard.appendChild(document.getElementById(id));
  });
}

// iOS Safari never implements Element.requestFullscreen() for anything but a
// <video> — document.fullscreenEnabled reads false there rather than the
// call throwing, so this is a real feature-detect, not a UA sniff. The only
// way to actually shed Safari's chrome on that browser is launching an
// icon added to the home screen (see index.html's apple-mobile-web-app-*
// meta tags), which reports as 'standalone' display-mode/navigator.standalone
// once running that way.
//
// Parked for now (IOS_FULLSCREEN_FIX_ENABLED = false): testing is moving
// into the Nimiq Pay in-app WebView, which may not have the same fullscreen
// gap plain mobile Safari does — no point hiding the button/swapping copy
// there until we actually see it misbehave. Detection itself stays real
// either way (cheap, side-effect-free); flip the flag back on to reinstate
// the hidden-button + "add to home screen" behavior once we revisit this.
const IOS_FULLSCREEN_FIX_ENABLED = false;
const FULLSCREEN_API_AVAILABLE = !!(document.documentElement.requestFullscreen && document.fullscreenEnabled);
const IS_STANDALONE_MODE = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const FULLSCREEN_SUPPORTED = IOS_FULLSCREEN_FIX_ENABLED ? FULLSCREEN_API_AVAILABLE : true;
const IS_STANDALONE = IOS_FULLSCREEN_FIX_ENABLED && IS_STANDALONE_MODE;

initBackground();

// Guards the loading screen against one slow/broken menu asset hanging it
// forever — after this, the game just proceeds and lets the normal
// per-frame .complete checks in game.js fill sprites in as they arrive.
const ASSET_PRELOAD_TIMEOUT_MS = 8000;
Promise.race([
  preloadBackgroundAssets(),
  new Promise((resolve) => setTimeout(resolve, ASSET_PRELOAD_TIMEOUT_MS)),
]).then(() => {
  hideLoadingOverlay();
  preloadCoreAssets(IS_MOBILE); // not awaited: warms the match assets in the background from here on
});

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
// (see below); "chat" toggles the local player's own Duel LAN chat mute —
// also wired inside game.js's startGame() (needs net/myTeam/phase), same
// pattern as "sweep"/"play".
const TOOLBAR_BUTTONS = ['sound', 'power', 'sweep', 'play', 'exit', 'chat'];
const TOOLBAR_STUB_BUTTONS = [];
TOOLBAR_BUTTONS.forEach((id) => {
  document.getElementById(`tbtn-${id}-img`).src = `${ASSET_BASE}ui/btn-${id}.png`;
  document.getElementById(`tbtn-${id}-cap`).src = `${ASSET_BASE}ui/btn-${id}-cap.png`;
});
// Mobile-only unified controller art (see index.html's #mobileController
// comment) — two pieces, not one, so the top strip can be hidden per-mode
// later without touching the rest of the panel.
document.getElementById('mcTopImg').src = `${ASSET_BASE}ui/controller-top.webp`;
document.getElementById('mcBodyImg').src = `${ASSET_BASE}ui/controller-body.webp`;
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
// Factored out so the "laser" HUD rock (see startGame's onRockPower option,
// wired to game.js's own canvas click hit-testing) can trigger the exact
// same logic as the old toolbar button, not a separate copy of it.
function triggerPower() {
  playToolbarClick(powerCap);
  setBasicLaser(!isBasicLaser());
  syncPowerButton();
}
powerBtn.addEventListener('click', triggerPower);

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
// Factored out so the "sound" HUD rock (see startGame's onRockSound option)
// can trigger the exact same logic as the old toolbar button.
function triggerSound() {
  playToolbarClick(soundCap);
  audio.setMuted(!audio.isMuted());
  syncSoundButton();
}
soundBtn.addEventListener('click', triggerSound);

// "exit": standard confirm dialog in the shared #overlay/#ovContent modal
// (see showLobby/hideLobby below, also used for the LAN lobby screens)
// rather than a bespoke one. "Oui" tears the match down in place via
// activeStopGame (game.js's stopGame(), see rockHandlers below) and reveals
// mode-select directly (returnToModeSelect) — no page reload, so this used
// to wait for the exitPanel clip's onEnded before reload() could even start;
// now there's no navigation to wait on, so the clip just plays fire-and-
// forget alongside the instant cut instead of gating it.
const exitBtn = document.getElementById('tbtn-exit');
const exitCap = document.getElementById('tbtn-exit-cap');
// Factored out so the "exit" HUD rock (see startGame's onRockExit option)
// can trigger the exact same logic as the old toolbar button.
function triggerExit() {
  playToolbarClick(exitCap);
  showLobby(`
    <h2>Quitter la partie ?</h2>
    <p>La partie en cours sera perdue.</p>
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="exitYesBtn">Oui</button>
      <button class="bigbtn" id="exitNoBtn">Non</button>
    </div>
  `);
  document.getElementById('exitYesBtn').onclick = () => {
    audio.stopAmbience();
    audio.play('exitPanel', { volume: 0.501 }); // -6dB, fire-and-forget
    hideLobby();
    activeStopGame?.();
    returnToModeSelect();
  };
  document.getElementById('exitNoBtn').onclick = () => { audio.play('button'); hideLobby(); };
}
exitBtn.addEventListener('click', triggerExit);

// The 5 HUD rocks baked into the V2 arena art (see design-lab's
// arena-v2-hud-buttons.html for the original zone-mapping prototype) replace
// the old round toolbar buttons entirely (see style.css hiding #toolbar-top/
// #toolbar-bottom) — game.js does the actual canvas-space click
// hit-testing (it already owns all pointer input on the canvas), and calls
// back out to these 3 for the buttons main.js itself owns. "play"/"ice" stay
// inside game.js's own startGame() closure (triggerPlay/triggerSweep) since
// they need live phase/entities state, same as before.
// Current match's teardown fn (see game.js's stopGame(), returned from
// startGame() — see each call site below) — null on mode-select, where
// there's nothing running to tear down.
let activeStopGame = null;
// onExit: returnToModeSelect (a hoisted function declaration further down —
// safe to reference here) is how game.js's own internal exit buttons
// (post-match "Menu", replay's exit) reach the same "show mode-select" reveal
// after calling stopGame() themselves.
const rockHandlers = { onRockSound: triggerSound, onRockExit: triggerExit, onRockPower: triggerPower, onExit: returnToModeSelect };

// Nimiq logo doubles as a "back to menu" shortcut, same confirm dialog as
// the exit toolbar button above (only relevant once a match is running —
// on the mode-select screen there's no game in progress to lose) — always
// confirmed, replay included, so an accidental click never dumps the player
// straight out. No page reload either way now (see triggerExit above) — a
// still-present ?replay= param no longer matters for landing on mode-select,
// but stopGame() itself still strips it (history.replaceState) so a later
// real page refresh doesn't relaunch the same replay.
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
    // Replay's "Oui" keeps the plain button click — only a live match's
    // quit gets the exit-panel sound.
    audio.play(inReplay ? 'button' : 'exitPanel', inReplay ? undefined : { volume: 0.501 }); // -6dB, fire-and-forget
    hideLobby();
    activeStopGame?.();
    returnToModeSelect();
  };
  document.getElementById('logoNoBtn').onclick = () => { audio.play('button'); hideLobby(); };
});

// ---- "Fullscreen recommended" intro gate (mobile only, see IS_MOBILE above)
// — shown in front of #modeOverlay before the player ever sees a mode tile;
// only actually revealed at the bottom of this file, once we know this isn't
// a magic-link entry (?duel/?replay=) that intentionally skips every overlay.
// Tapping the icon requests fullscreen (best-effort — a denied/unsupported
// request still just falls through to revealing the menu) and hands off to
// the normal mode-select screen.
const fsRecommendOverlay = document.getElementById('fsRecommendOverlay');
const fsRecommendIcon = document.getElementById('fsRecommendIcon');
const fsRecommendText = document.getElementById('fsRecommendText');
// iOS Safari (not already standalone) can't be put into fullscreen at all
// (see FULLSCREEN_SUPPORTED above) — tapping the icon there would silently
// do nothing, so the copy instead points at the one thing that actually
// works on that browser: installing to the home screen.
if (!FULLSCREEN_SUPPORTED && !IS_STANDALONE) {
  fsRecommendText.textContent = 'Ajoute Nim-Curl à l’écran d’accueil pour jouer en plein écran (icône de partage Safari)';
}
fsRecommendIcon.addEventListener('click', () => {
  audio.play('button');
  if (FULLSCREEN_SUPPORTED) {
    document.documentElement.requestFullscreen()
      .catch((err) => console.log('[fullscreen] request failed:', err.message));
  }
  fsRecommendOverlay.classList.add('hidden');
  modeOverlay.classList.remove('hidden');
});

// ---- "Rotate to landscape" intro gate (mobile only) — the whole mobile
// layout (right-margin joystick column, see style.css's .mobile-layout
// rules) only works in landscape, so this comes ahead of even the
// fullscreen-recommend gate above whenever a phone starts out in portrait.
// Purely illustrative icon, no tap target — dismisses itself once the
// orientation media query actually flips (see the listener below), same
// "no menu detour until the real thing happened" spirit as everything else
// gating #modeOverlay.
const rotateOverlay = document.getElementById('rotateOverlay');
function isPortraitMobile() { return IS_MOBILE && window.matchMedia('(orientation: portrait)').matches; }
// What comes after the gate(s): the fullscreen-recommend prompt if that
// parked feature gets switched back on (IOS_FULLSCREEN_FIX_ENABLED above),
// otherwise straight to the mode-select screen. Self-contained (sets the
// final state outright rather than assuming what ran before it), so both
// the initial entry below and the orientation listener can just call it.
function revealAfterGates() {
  if (IOS_FULLSCREEN_FIX_ENABLED && !IS_STANDALONE) {
    modeOverlay.classList.add('hidden');
    fsRecommendOverlay.style.display = '';
    fsRecommendOverlay.classList.remove('hidden');
  } else {
    modeOverlay.classList.remove('hidden');
  }
}
window.matchMedia('(orientation: portrait)').addEventListener('change', (e) => {
  // Only acts while the rotate gate is actually the thing on screen — a
  // later rotation back to portrait (already past it, mid mode-select or
  // mid-match) is out of scope for what's just a one-time intro screen.
  if (IS_MOBILE && !e.matches && !rotateOverlay.classList.contains('hidden')) {
    rotateOverlay.classList.add('hidden');
    revealAfterGates();
  }
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

// ---- Mode select: Pass & Play / Remote Match / AI Training / Replay ----
// startGame() isn't called until a mode is picked, so it only ever runs once
// per page load. Duel LAN isn't offered here anymore (dropped from the
// picker), but it's still reachable via the `?duel` magic link below, which
// passes {net, myTeam} once both players are connected — see joinLan().
const modeOverlay = document.getElementById('modeOverlay');
const modeLocal = document.getElementById('modeLocal');
const modeMatch = document.getElementById('modeMatch');
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
// revealed right at each of the 3 actual startGame() call sites below. Split
// across two bars now (see style.css #toolbar-top/#toolbar-bottom) — both
// toggle together, there's no case where one should show without the other.
const toolbarTop = document.getElementById('toolbar-top');
const toolbarBottom = document.getElementById('toolbar-bottom');
// Mobile relocation target for all 6 toolbar buttons (see style.css's
// #mobileController and game.js's mobile branch, which reparents those
// buttons here) — starts hidden like the other two, revealed together.
const mobileController = document.getElementById('mobileController');
function showToolbar() {
  toolbarTop.classList.remove('hidden');
  toolbarBottom.classList.remove('hidden');
  mobileController.classList.remove('hidden');
}

// "Now show mode-select" half of the exit flow — the actual match teardown
// (rAF loop, listeners, LAN socket, timers) is owned by game.js's own
// stopGame(), captured below into activeStopGame at every startGame() call
// site and returned again as opts.onExit so game.js's own internal exit
// buttons (post-match "Menu", replay's exit) can reach this same reveal
// without going through main.js's toolbar/logo at all. A function
// declaration (not const) so it's hoisted — rockHandlers below references it
// before this line runs.
function returnToModeSelect() {
  activeStopGame = null;
  toolbarTop.classList.add('hidden');
  toolbarBottom.classList.add('hidden');
  mobileController.classList.add('hidden');
  startOverlay.classList.add('hidden');
  modeOverlay.classList.remove('hidden');
}

modeLocal.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  startOverlay.classList.remove('hidden');
  showToolbar();
  activeStopGame = startGame({ ...rockHandlers, identiconAddress: identiconOverride('A'), mobile: IS_MOBILE });
});

modeMatch.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  showMatchChoiceScreen();
});

// Solo vs IA: only one human, controlling team A — no ready-tap lobby needed
// (game.js's aiTeam branch skips #startOverlay itself), straight into aimA.
modeSolo.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  showToolbar();
  activeStopGame = startGame({ ...rockHandlers, aiTeam: 'B', identiconAddress: identiconOverride('A'), mobile: IS_MOBILE });
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
  showLoadingOverlay();
  try {
    const points = await decodePointsFromTicketImage(file);
    hideLoadingOverlay();
    if (points.length === 0) {
      replayUploadStatus.textContent = 'Aucun point trouvé sur ce ticket.';
      return;
    }
    replayUploadOverlay.classList.add('hidden');
    beginAmbience();
    activeStopGame = startGame({ ...rockHandlers, replayPoints: points, mobile: IS_MOBILE });
  } catch (err) {
    hideLoadingOverlay();
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
  showLoadingOverlay();
  try {
    const net = await connectLan(addr);
    hideLoadingOverlay();
    showWaitingScreen(net, (msg) => showLanJoinScreen(msg));
  } catch (err) {
    hideLoadingOverlay();
    showLanJoinScreen(err.message);
  }
}

// Shared by Duel LAN and Match Réseau (see showMatchJoinScreen/hostMatch
// below) — both connect the exact same way from here on (same net.js
// interface, see CLAUDE.md "Network match"), only how `net` was obtained
// differs. `onLost(msg)` decides where "opponent disconnected" sends the
// player back to — each mode's own entry screen, so an error there offers
// the right retry (LAN address vs. match code) rather than a generic dead end.
function showWaitingScreen(net, onLost) {
  const teamLabel = net.myTeam === 'A' ? 'ÉQUIPE BLEUE' : 'ÉQUIPE JAUNE';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  showLobby(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>En attente de l'adversaire…</h2>
    <p>Partage le lien avec l'autre joueur si ce n'est pas déjà fait.</p>
  `);
  net.onOpponentJoined(() => showReadyScreen(net, teamLabel, cls, onLost));
  net.onDisconnect(() => onLost("L'autre joueur s'est déconnecté."));
}

// One more explicit tap between "opponent joined" and startGame(), same
// idea as local/solo's own #startOverlay ready-tap — this used to call
// startGame() straight from the onOpponentJoined network callback, an async
// event with no user gesture of its own. If this player's tab had been
// sitting idle on the waiting screen for a while, beginMatchIntro() (called
// synchronously inside startGame() for net mode) could fire without a fresh
// rendered frame and without WebAudio properly unlocked, and the match-start
// slide tween would silently never play (stones stuck at their pre-animation
// spot) — a real bug report, not a hypothetical. A real click here
// guarantees both a fresh frame and a fresh gesture right before it matters.
//
// The tap alone isn't synced across the two players though — net.sendReady()
// / onBothReady() (see src/net.js, server/arbiter.js) hold off calling
// startGame() until BOTH sides have tapped, so one fast player can't start
// their own match (and start chatting) while the other is still sitting on
// this screen with no startGame()/onChat() wired up yet to receive it —
// those messages used to just silently vanish.
function showReadyScreen(net, teamLabel, cls, onLost) {
  showLobby(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>Adversaire connecté !</h2>
    <p>Touche pour démarrer la partie.</p>
    <button class="bigbtn" id="lanReadyBtn">Prêt</button>
  `);
  document.getElementById('lanReadyBtn').onclick = () => {
    audio.unlock();
    audio.play('button');
    net.sendReady();
    showLobby(`
      <span class="team-pill ${cls}">${teamLabel}</span>
      <h2>En attente de l'autre joueur…</h2>
    `);
  };
  net.onBothReady(() => {
    hideLobby();
    showToolbar();
    activeStopGame = startGame({ ...rockHandlers, net, myTeam: net.myTeam, identiconAddress: identiconOverride(net.myTeam), mobile: IS_MOBILE });
  });
  net.onDisconnect(() => onLost("L'autre joueur s'est déconnecté."));
}

// ---- Match Réseau (see CLAUDE.md "Network match") — same lobby flow as Duel
// LAN above (showWaitingScreen/showReadyScreen, same net.js interface), just
// reached via a 4-character room code instead of typing a LAN address:
// whoever taps "Créer" generates the code and is team A (first to connect to
// that PartyKit room, see party/arbiter.js), whoever taps "Rejoindre" and
// types it in is team B.
//
// Alphabet excludes visually ambiguous characters (0/O, 1/I) since the code
// is read off one screen and typed on another, often by voice or a glance
// across a room — a misread digit would just bounce off `full`/an empty room
// instead of erroring clearly, so cutting the ambiguity avoids that class of
// mistake at the source.
const MATCH_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateMatchCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += MATCH_CODE_ALPHABET[Math.floor(Math.random() * MATCH_CODE_ALPHABET.length)];
  return code;
}

function showMatchChoiceScreen(errorMsg) {
  showLobby(`
    <h2>Match réseau</h2>
    <p>Crée une partie et partage le code, ou rejoins avec un code reçu.</p>
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="matchHostBtn">Créer</button>
      <button class="bigbtn" id="matchJoinBtn">Rejoindre</button>
    </div>
    ${errorMsg ? `<p class="lan-error">${errorMsg}</p>` : ''}
  `);
  document.getElementById('matchHostBtn').onclick = () => { audio.play('button'); hostMatch(); };
  document.getElementById('matchJoinBtn').onclick = () => { audio.play('button'); showMatchJoinScreen(); };
}

async function hostMatch() {
  const code = generateMatchCode();
  showLoadingOverlay();
  try {
    const net = await connectMatch(code);
    hideLoadingOverlay();
    showMatchHostWaitingScreen(net, code);
  } catch (err) {
    hideLoadingOverlay();
    showMatchChoiceScreen(err.message);
  }
}

// Same shape as showWaitingScreen above, but also displays the code (the
// host is the one waiting to share it — the joiner already typed it in to
// get here, see joinMatch below) and sends a disconnected opponent back to
// the choice screen (a fresh "Créer" gets a fresh code — the old one, tied
// to this now-empty room, isn't reused).
function showMatchHostWaitingScreen(net, code) {
  const teamLabel = net.myTeam === 'A' ? 'ÉQUIPE BLEUE' : 'ÉQUIPE JAUNE';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  showLobby(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>En attente de l'adversaire…</h2>
    <p>Donne-lui ce code :</p>
    <div class="match-code">${code}</div>
  `);
  net.onOpponentJoined(() => showReadyScreen(net, teamLabel, cls, (msg) => showMatchChoiceScreen(msg)));
  net.onDisconnect(() => showMatchChoiceScreen("L'autre joueur s'est déconnecté."));
}

function showMatchJoinScreen(errorMsg) {
  showLobby(`
    <h2>Rejoindre un match</h2>
    <p>Code donné par l'autre joueur :</p>
    <input id="matchCodeInput" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="XXXX" />
    <button class="bigbtn" id="matchJoinSubmitBtn">Rejoindre</button>
    ${errorMsg ? `<p class="lan-error">${errorMsg}</p>` : ''}
  `);
  const input = document.getElementById('matchCodeInput');
  const joinBtn = document.getElementById('matchJoinSubmitBtn');
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  joinBtn.onclick = () => { audio.play('button'); joinMatch(input.value, joinBtn); };
}

async function joinMatch(code, joinBtn) {
  if (code.length !== 4) return;
  if (joinBtn) joinBtn.disabled = true;
  showLoadingOverlay();
  try {
    const net = await connectMatch(code);
    hideLoadingOverlay();
    showWaitingScreen(net, (msg) => showMatchJoinScreen(msg));
  } catch (err) {
    hideLoadingOverlay();
    showMatchJoinScreen(err.message);
  }
}

// ---- Title/splash screen (see index.html's #homeOverlay comment) — the
// very first thing a normal (non-magic-link) entry sees, above even the
// mobile rotate/fullscreen gates. Its own reveal logic is exactly what used
// to run unconditionally at the bottom of this file for a plain mobile
// entry; pulled into a function so both the mobile and desktop paths (which
// previously just relied on #modeOverlay's default-visible markup) go
// through the same explicit call once the player actually taps PLAY.
const homeOverlay = document.getElementById('homeOverlay');
function revealMenu() {
  if (IS_MOBILE && isPortraitMobile()) {
    rotateOverlay.style.display = '';
    rotateOverlay.classList.remove('hidden');
  } else {
    revealAfterGates();
  }
}
homeOverlay.addEventListener('click', () => {
  audio.play('button');
  homeOverlay.classList.add('hidden');
  revealMenu();
});

// Magic links, all three skip mode-select (and now the home screen) entirely:
// ?duel (printed by `npm run duel`) connects straight to this same page's
// arbiter; ?replay=<data> (from a point QR — see src/replay.js
// buildReplayUrl) jumps straight into replaying that single point — same
// "no menu detour" idea as ?duel, now also skipping the splash screen.
const replayFromLink = parseReplayFromLocation();
if (replayFromLink) {
  homeOverlay.classList.add('hidden');
  beginAmbience();
  activeStopGame = startGame({ ...rockHandlers, replayPoints: [replayFromLink], mobile: IS_MOBILE });
} else if (new URLSearchParams(location.search).has('duel')) {
  homeOverlay.classList.add('hidden');
  joinLan(defaultLanAddress(), null);
}
