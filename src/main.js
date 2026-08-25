import './style.css';
// Nimiq's brand typeface (nimiq-style design system: Muli/Mulish 400/600/700,
// per the official kit's own typography.css) — now the default UI font, not
// just the score digits; 800 kept for the score/ticket's existing bold use.
import '@fontsource/mulish/400.css';
import '@fontsource/mulish/600.css';
import '@fontsource/mulish/700.css';
import '@fontsource/mulish/800.css';
// Nimiq UI Kit's monospace pairing for addresses/on-chain data — the sidebar
// identity pill's address line (see style.css's #connectBtnLabel).
import '@fontsource/fira-mono/500.css';
import { startGame, preloadCoreAssets } from './game.js';
import { connectNimiq, connectIdentity, getIdentity, setGuest, clearIdentity, getHandle, setHandle } from './nimiq.js';
import { getIdenticonPngDataUrl } from './identicons.js';
import { initBackground, preloadBackgroundAssets } from './background.js';
import { connectLan, connectMatch } from './net.js';
import { isBasicLaser, setBasicLaser } from './settings.js';
import { DEFAULT_MATCH_CONFIG, getCustomConfig, setCustomConfig } from './matchConfig.js';
import { decodePointsFromTicketImage, parseReplayFromLocation } from './replay.js';
import { audio } from './audio.js';
import { COLORS, CSS_VAR_NAMES } from './colors.js';

// Single source of truth for the 7 colors style.css and ticket.js both need
// (see src/colors.js) — pushed onto :root here, synchronously, before
// anything else in this module runs (in particular before the branded
// #loadingOverlay in index.html ever lifts), so style.css's own literal
// :root values — kept as a static fallback, not the live source anymore —
// are overwritten before a single frame the player sees. setProperty() is
// an in-memory operation (no network, no async), effectively instant.
for (const key in COLORS) {
  document.documentElement.style.setProperty(CSS_VAR_NAMES[key], COLORS[key]);
}

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
  ['overlay', 'replayBar', 'syncToast'].forEach((id) => {
    gameCard.appendChild(document.getElementById(id));
  });
  // The pre-game menu screens (mode-select + Classic/Custom + Settings +
  // Remote Match lobby + the Replay upload picker — everything reached from
  // a mode tile before a match/replay actually starts) go to #menuStage
  // instead of #game-card, desktop only — #menuStage is sized off the true
  // viewport (see style.css), not #card-w/#card-h, so these render at
  // #homeOverlay's own full-screen scale rather than shrunk into the game's
  // smaller box. #replayBar (live replay PLAYBACK chrome, shown over the
  // canvas once a replay is actually running) stays with #game-card above,
  // same as #overlay/#syncToast — it's gameplay chrome, not a menu screen.
  // Mobile keeps its existing behavior untouched (still #game-card children)
  // — #menuStage isn't part of mobile's layout yet.
  const menuHost = IS_MOBILE ? gameCard : document.getElementById('menuStage');
  ['modeOverlay', 'connectGateOverlay', 'classicCustomOverlay', 'customSettingsOverlay', 'matchNetworkOverlay', 'replayUploadOverlay'].forEach((id) => {
    menuHost.appendChild(document.getElementById(id));
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
    <h2>Quit the match?</h2>
    <p>The current match will be lost.</p>
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="exitYesBtn">Yes</button>
      <button class="bigbtn" id="exitNoBtn">No</button>
    </div>
  `, activeMatchMode);
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
// Set alongside activeStopGame at every startGame() call site, cleared in
// hideMatchChrome() — drives showLobby()'s mode-tint below.
let activeMatchMode = null;
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
    <h2>Back to menu?</h2>
    <p>${inReplay ? 'The current replay will be stopped.' : 'The current match will be lost.'}</p>
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="logoYesBtn">Yes</button>
      <button class="bigbtn" id="logoNoBtn">No</button>
    </div>
  `, activeMatchMode);
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
// otherwise the connect gate (#connectGateOverlay, see showConnectGate below)
// if the player hasn't decided Connect/Guest yet, otherwise straight to the
// mode-select screen. Self-contained (sets the final state outright rather
// than assuming what ran before it), so both the initial entry below and the
// orientation listener can just call it.
function revealAfterGates() {
  if (IOS_FULLSCREEN_FIX_ENABLED && !IS_STANDALONE) {
    modeOverlay.classList.add('hidden');
    fsRecommendOverlay.style.display = '';
    fsRecommendOverlay.classList.remove('hidden');
  } else if (!getIdentity()) {
    showConnectGate();
  } else {
    showModeDrawer();
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

// ---- Player identity (see src/nimiq.js's getIdentity/connectIdentity) —
// resolved once via the #connectGateOverlay gate below (Connect or Play as
// guest), right after the home screen. A connected address is remembered and
// swapped into whichever team the local player ends up controlling, in
// place of the placeholder identicon, so it's visible in-game once a match
// starts.
let hubAddress = getIdentity()?.address || null;
function identiconOverride(team) {
  return hubAddress ? { [team]: hubAddress } : {};
}
// The corner pill is now a pure display of the resolved identity (address,
// or "Guest") — no longer the connect trigger itself, that's #connectGateOverlay's
// job. Clicking it reopens the gate to switch (disconnect), same "tap your
// own identity to change it" pattern as elsewhere, gated to mode-select only
// (activeStopGame, set further down) — reopening the gate mid-match would
// yank the identicon out from under a running game.
const connectBtn = document.getElementById('connectBtn');
const connectBtnLabel = document.getElementById('connectBtnLabel');
const connectBtnStatus = document.getElementById('connectBtnStatus');
const connectAvatar = document.getElementById('connectAvatar');
// address -> "abc…xyz" (first/last 3 chars), the sidebar pill's own compact
// format for the status line — distinct from the `${slice(0,9)}…` format
// mobile's pill still uses (see below), which predates this and has its own
// established look, not revisited here.
function shortenAddressCompact(address) {
  return address.length <= 8 ? address : `${address.slice(0, 3)}…${address.slice(-3)}`;
}
// Hidden entirely until the player has actually been through the connect
// gate at least once (still hubAddress===null AND no persisted 'guest' flag
// right after a disconnect too) — showing "Guest" here while the gate is
// still open asking the player to decide would read as already decided.
function syncIdentityPill() {
  const decided = !!hubAddress || getIdentity()?.type === 'guest';
  connectBtn.classList.toggle('hidden', !decided);
  if (!decided) return;
  connectBtn.classList.toggle('connected', !!hubAddress);
  connectBtnLabel.classList.remove('claim-cta');
  connectBtnStatus.classList.remove('mono');
  connectAvatar.classList.toggle('has-identicon', !!hubAddress);
  connectAvatar.style.backgroundImage = '';
  if (!hubAddress) {
    connectBtnLabel.textContent = 'Guest';
    connectBtnStatus.textContent = 'Connect wallet';
    return;
  }
  getIdenticonPngDataUrl(hubAddress).then((url) => {
    if (hubAddress) connectAvatar.style.backgroundImage = `url(${url})`;
  });
  // Mobile's pill predates the handle-claim flow below and hasn't been
  // redesigned for it yet (see CLAUDE.md's mobile-deferred stance) — keeps
  // its original plain address/"Connected" pairing instead.
  if (IS_MOBILE) {
    connectBtnLabel.textContent = `${hubAddress.slice(0, 9)}…`;
    connectBtnStatus.textContent = 'Connected';
    return;
  }
  const handle = getHandle(hubAddress);
  connectBtnLabel.textContent = handle || 'Claim a handle';
  connectBtnLabel.classList.toggle('claim-cta', !handle);
  connectBtnStatus.textContent = shortenAddressCompact(hubAddress);
  connectBtnStatus.classList.add('mono');
}
syncIdentityPill();
connectBtn.addEventListener('click', () => {
  if (activeStopGame) return;
  audio.play('button');
  clearIdentity();
  hubAddress = null;
  syncIdentityPill();
  showConnectGate();
});
// "Claim a handle" CTA (desktop only, see syncIdentityPill above — the label
// never gets the .claim-cta class on mobile, so this never fires there):
// stopPropagation so it doesn't also trigger #connectBtn's own
// disconnect-and-reopen-the-gate click above. Reuses the same
// showLobby()/#overlay dialog mechanism as the "Revenir au menu ?" confirm
// (bgLogo's own click handler above) rather than a new component, and the
// same activeStopGame guard as #connectBtn's click, since #sidebar stays
// visible (and #overlay may be mid-match's own goal panel) during a live
// match on desktop, unlike mobile's match-only controller.
connectBtnLabel.addEventListener('click', (e) => {
  if (!connectBtnLabel.classList.contains('claim-cta')) return;
  e.stopPropagation();
  if (activeStopGame) return;
  audio.play('button');
  openClaimHandleDialog();
});
function openClaimHandleDialog() {
  if (!hubAddress) return;
  showLobby(`
    <h2>Claim a handle</h2>
    <p>Pick a public display name for ${shortenAddressCompact(hubAddress)}. You'll be able to change it later.</p>
    <input type="text" id="handleInput" maxlength="20" placeholder="Your handle">
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="handleConfirmBtn">Claim</button>
      <button class="bigbtn" id="handleCancelBtn">Cancel</button>
    </div>
  `);
  const handleInput = document.getElementById('handleInput');
  handleInput.focus();
  document.getElementById('handleConfirmBtn').onclick = () => {
    const value = handleInput.value.trim();
    if (!value) return;
    audio.play('button');
    setHandle(hubAddress, value);
    hideLobby();
    syncIdentityPill();
  };
  document.getElementById('handleCancelBtn').onclick = () => { audio.play('button'); hideLobby(); };
}

// ---- Mode select: Pass & Play / Remote Match / AI Training / Replay ----
// startGame() isn't called until a mode is picked, so it only ever runs once
// per page load. Duel LAN isn't offered here anymore (dropped from the
// picker), but it's still reachable via the `?duel` magic link below, which
// passes {net, myTeam} once both players are connected — see joinLan().
const modeOverlay = document.getElementById('modeOverlay');
// The tile grid specifically, not the whole #modeOverlay — Classic/Custom
// and Custom Settings (see below) keep #modeOverlay itself visible so its
// arena backdrop (#modeOverlayBg + .mode-select-scrim) shows through their
// own translucent panel, same as the mode tiles do; only the tiles
// themselves need hiding underneath.
const modeDrawer = modeOverlay.querySelector('.mode-drawer');
// Reveals the tile grid — the staggered pop-in (see style.css's
// .mode-drawer:not(.hidden) .half) is driven entirely by CSS off .hidden
// itself, so it replays every time this is called: home screen handoff,
// Classic/Custom's back arrow, returnToModeSelect, the connect gate, etc.
function showModeDrawer() {
  modeDrawer.classList.remove('hidden');
  modeOverlay.classList.remove('hidden');
}
const modeLocal = document.getElementById('modeLocal');
const modeMatch = document.getElementById('modeMatch');
const modeSolo = document.getElementById('modeSolo');
const modeReplay = document.getElementById('modeReplay');
const startOverlay = document.getElementById('startOverlay');
const overlay = document.getElementById('overlay');
const ovContent = document.getElementById('ovContent');

const OVERLAY_TINT_CLASSES = ['mode-passplay', 'mode-solo', 'mode-replay', 'mode-remote'];
function showLobby(html, mode = null) {
  overlay.classList.remove(...OVERLAY_TINT_CLASSES);
  if (mode) overlay.classList.add(`mode-${mode}`);
  overlay.classList.add('overlay-boxed');
  overlay.classList.remove('hidden');
  ovContent.innerHTML = html;
}
function hideLobby() { overlay.classList.add('hidden'); overlay.classList.remove(...OVERLAY_TINT_CLASSES, 'overlay-boxed'); }

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
// Split out of returnToModeSelect (below) so "Change Settings" (see
// showVictory's onChangeSettings in game.js) can tear down the same match
// chrome without necessarily landing back on #modeOverlay — it lands on
// Custom Settings instead, pre-filled with the match that just ended.
function hideMatchChrome() {
  activeStopGame = null;
  activeMatchMode = null;
  toolbarTop.classList.add('hidden');
  toolbarBottom.classList.add('hidden');
  mobileController.classList.add('hidden');
  startOverlay.classList.add('hidden');
}

function returnToModeSelect() {
  hideMatchChrome();
  showModeDrawer();
}

// ---- Classic / Custom match settings (Pass & Play + Remote Match only —
// vs AI stays Classic-only and untouched, see conversation) — a screen
// inserted after #modeOverlay's tiles (never modified, per explicit
// request) and before each of those two modes' own existing entry flow.
// Custom's per-field choices persist locally per mode (src/matchConfig.js,
// same localStorage-backed pattern as src/settings.js's basicLaser flag) —
// Pass & Play's Custom config and Remote's are two fully independent
// presets, never cross-applied.
const classicCustomOverlay = document.getElementById('classicCustomOverlay');
const ccBackBtn = document.getElementById('ccBackBtn');
const ccModeIcon = document.getElementById('ccModeIcon');
const ccModeTitle = document.getElementById('ccModeTitle');
const classicBtn = document.getElementById('classicBtn');
const customBtn = document.getElementById('customBtn');
const customSettingsOverlay = document.getElementById('customSettingsOverlay');
const csModeIcon = document.getElementById('csModeIcon');
const csModeTitle = document.getElementById('csModeTitle');
const csBackBtn = document.getElementById('csBackBtn');
const csResetBtn = document.getElementById('csResetBtn');
const csSaveBtn = document.getElementById('csSaveBtn');
const segControls = [...customSettingsOverlay.querySelectorAll('.seg-control')];
// Remote Match's own 3 sub-screens (choice, generated code, code to fill in)
// — same tile-colored/centered-header/exit-arrow language as the two
// screens above, always the Remote Match tint (fixed in the markup, unlike
// classicCustomOverlay/customSettingsOverlay which switch tint per mode)
// since this whole overlay is Remote-Match-only.
const matchNetworkOverlay = document.getElementById('matchNetworkOverlay');
const matchNetworkContent = document.getElementById('matchNetworkContent');
const matchNetworkBackBtn = document.getElementById('matchNetworkBackBtn');
const matchNetworkModeIcon = document.getElementById('matchNetworkModeIcon');

const MODE_LABELS = { passplay: 'PASS & PLAY', remote: 'REMOTE MATCH', replay: 'REPLAY' };
// Reuses #modeOverlay's own tile icons (cloned, never a new asset) — see
// explicit request not to introduce a new logo for these screens.
const MODE_TILES = { passplay: modeLocal, remote: modeMatch, replay: modeReplay };
function modeIconSvg(mode) {
  return MODE_TILES[mode].querySelector('.mode-icon').cloneNode(true);
}
// Also tints the panel itself with the same background as the mode-select
// tile this screen follows (see .half.a/.half.e in style.css) — both screens
// are shared between Pass & Play and Remote Match rather than duplicated per
// mode, so the tint is applied here rather than baked into the markup.
function fillModeHeader(panelEl, iconEl, titleEl, mode) {
  iconEl.replaceChildren(modeIconSvg(mode));
  titleEl.textContent = MODE_LABELS[mode];
  panelEl.classList.remove('mode-passplay', 'mode-remote');
  panelEl.classList.add(mode === 'passplay' ? 'mode-passplay' : 'mode-remote');
}

// Set once — this panel's icon never changes (always Remote Match).
matchNetworkModeIcon.replaceChildren(modeIconSvg('remote'));

// Tracks a room this client created and is still alone in (generated code
// shown, nobody joined yet) — see matchNetworkBackBtn below: leaving one of
// these 3 screens while this is set cancels that room server-side instead of
// just walking away and leaving the code silently still working for anyone
// who has it. Cleared the moment an opponent actually joins (showReadyScreen
// takes over from there, out of this scope — see conversation) or the room
// is cancelled/left.
let hostedRoomNet = null;

function showNetPanel(html) {
  matchNetworkContent.innerHTML = html;
  hideLobby();
  classicCustomOverlay.classList.add('hidden');
  customSettingsOverlay.classList.add('hidden');
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  matchNetworkOverlay.classList.remove('hidden');
}
function hideNetPanel() { matchNetworkOverlay.classList.add('hidden'); }

// Always straight back to mode-select (see conversation) — none of these 3
// screens has an earlier step of its own the way Classic/Custom's Back does.
matchNetworkBackBtn.addEventListener('click', () => {
  audio.play('button');
  if (hostedRoomNet) {
    // Suppress the stale "opponent disconnected" handler this same net
    // still has registered (showMatchHostWaitingScreen's own onDisconnect)
    // — this is an intentional cancel, not a dropped connection, same
    // reasoning as game.js's stopGame() doing this before net.close().
    hostedRoomNet.onDisconnect(() => {});
    hostedRoomNet.cancelRoom();
    hostedRoomNet.close();
    hostedRoomNet = null;
  }
  hideNetPanel();
  returnToModeSelect();
});

// Called once a mode/config choice is actually ready to launch — resumes
// that mode's own existing entry flow exactly as before this feature
// (Pass & Play's #startOverlay ready-tap, Remote Match's Créer/Rejoindre
// choice), just now carrying a matchConfig through it.
let onConfigReady = null;
// Where this screen's own Back arrow goes — Pass & Play reaches Classic/
// Custom straight from #modeOverlay, so Back lands there; Remote Match
// reaches it from the Créer/Rejoindre choice screen (see showMatchChoiceScreen
// below), one step later, so Back should land there instead, not skip past
// it straight to mode-select.
let onConfigBack = null;

function showClassicCustomScreen(mode, launch, goBack) {
  onConfigReady = launch;
  onConfigBack = goBack;
  fillModeHeader(classicCustomOverlay, ccModeIcon, ccModeTitle, mode);
  hideLobby();
  hideNetPanel();
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  customSettingsOverlay.classList.add('hidden');
  classicCustomOverlay.classList.remove('hidden');
  classicBtn.onclick = () => {
    audio.play('button');
    classicCustomOverlay.classList.add('hidden');
    onConfigReady?.({ ...DEFAULT_MATCH_CONFIG });
  };
  customBtn.onclick = () => {
    audio.play('button');
    showCustomSettingsScreen(mode, getCustomConfig(mode));
  };
}

ccBackBtn.addEventListener('click', () => {
  audio.play('button');
  classicCustomOverlay.classList.add('hidden');
  onConfigBack?.();
});

let customSettingsMode = null;
let customSettingsDraft = { ...DEFAULT_MATCH_CONFIG };

function renderCustomSettingsDraft() {
  segControls.forEach((seg) => {
    const field = seg.dataset.field;
    const value = String(customSettingsDraft[field]);
    seg.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
  });
}

// Reused both as the Custom Settings entry point from the Classic/Custom
// fork above and directly by "Change Settings" (game.js's onChangeSettings)
// on an already-finished match — the latter skips the fork entirely and
// lands here pre-filled with whatever that match was actually playing with.
function showCustomSettingsScreen(mode, initialConfig) {
  customSettingsMode = mode;
  customSettingsDraft = { ...initialConfig };
  fillModeHeader(customSettingsOverlay, csModeIcon, csModeTitle, mode);
  renderCustomSettingsDraft();
  hideLobby();
  hideNetPanel();
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  classicCustomOverlay.classList.add('hidden');
  customSettingsOverlay.classList.remove('hidden');
}

segControls.forEach((seg) => {
  const field = seg.dataset.field;
  const numeric = field !== 'skin';
  seg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.play('button');
      customSettingsDraft[field] = numeric ? parseInt(btn.dataset.value, 10) : btn.dataset.value;
      renderCustomSettingsDraft();
    });
  });
});

// Back: Custom Settings -> Classic/Custom fork (never straight to
// mode-select — see explicit back-navigation request). Reopening the fork
// with the same mode is enough; the in-progress Custom draft simply isn't
// saved unless SAVE was actually pressed, matching RESET's own "preview
// only" behavior below.
csBackBtn.addEventListener('click', () => {
  audio.play('button');
  customSettingsOverlay.classList.add('hidden');
  classicCustomOverlay.classList.remove('hidden');
});

// RESET previews the Classic values on-screen — it does not launch and does
// not persist by itself (see conversation: SAVE is the only thing that
// writes to localStorage), so a player can back out of an accidental Reset.
csResetBtn.addEventListener('click', () => {
  audio.play('button');
  customSettingsDraft = { ...DEFAULT_MATCH_CONFIG };
  renderCustomSettingsDraft();
});

csSaveBtn.addEventListener('click', () => {
  audio.play('button');
  setCustomConfig(customSettingsMode, customSettingsDraft);
  customSettingsOverlay.classList.add('hidden');
  onConfigReady?.({ ...customSettingsDraft });
});

// ---- Connect gate (#connectGateOverlay) — shown once, right after the home
// screen and before mode-select, whenever getIdentity() (src/nimiq.js) says
// the player hasn't decided yet (never chose Connect or Guest this device).
// Reuses #modeOverlay's own arena backdrop, same trick as Classic/Custom
// above: only #modeDrawer (the tile grid) needs hiding underneath. Also
// reopened later by the corner identity pill's disconnect action (see
// connectBtn above).
const connectGateOverlay = document.getElementById('connectGateOverlay');
const cgConnectBtn = document.getElementById('cgConnectBtn');
const cgGuestBtn = document.getElementById('cgGuestBtn');
const cgError = document.getElementById('cgError');

function showConnectGate() {
  cgError.classList.add('hidden');
  cgConnectBtn.disabled = false;
  cgGuestBtn.disabled = false;
  hideLobby();
  hideNetPanel();
  classicCustomOverlay.classList.add('hidden');
  customSettingsOverlay.classList.add('hidden');
  replayUploadOverlay.classList.add('hidden');
  modeDrawer.classList.add('hidden');
  modeOverlay.classList.remove('hidden');
  connectGateOverlay.classList.remove('hidden');
}

// Lands on the actual mode tiles once the gate resolves either way — same
// reveal returnToModeSelect() does, minus the match-teardown half (there's
// never a match running yet at this point).
function proceedPastConnectGate() {
  connectGateOverlay.classList.add('hidden');
  showModeDrawer();
}

cgConnectBtn.addEventListener('click', () => {
  audio.play('button');
  cgError.classList.add('hidden');
  cgConnectBtn.disabled = true;
  cgGuestBtn.disabled = true;
  connectIdentity()
    .then((address) => {
      hubAddress = address;
      syncIdentityPill();
      proceedPastConnectGate();
    })
    .catch((err) => {
      // The player simply closing the Hub popup/Nimiq Pay prompt without
      // picking anything isn't a failure worth a red error message — just
      // silently drop back to the two tiles so they can try again (or pick
      // Guest instead). Hub's own popup rejects with a "CANCELED"-style
      // message for this; anything else (popup blocked, network error, no
      // account returned) still surfaces.
      if (/cancel/i.test(err.message || '')) return;
      cgError.textContent = err.message || 'Connection failed.';
      cgError.classList.remove('hidden');
    })
    .finally(() => {
      cgConnectBtn.disabled = false;
      cgGuestBtn.disabled = false;
    });
});

cgGuestBtn.addEventListener('click', () => {
  audio.play('button');
  setGuest();
  hubAddress = null;
  syncIdentityPill();
  proceedPastConnectGate();
});

modeLocal.addEventListener('click', () => {
  audio.play('button');
  showClassicCustomScreen('passplay', (config) => {
    modeOverlay.classList.add('hidden');
    startOverlay.classList.remove('hidden');
    showToolbar();
    activeMatchMode = 'passplay';
    activeStopGame = startGame({
      ...rockHandlers, identiconAddress: identiconOverride('A'), mobile: IS_MOBILE, matchConfig: config,
      onChangeSettings: () => { hideMatchChrome(); showCustomSettingsScreen('passplay', config); },
    });
  }, returnToModeSelect);
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
  activeMatchMode = 'solo';
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
const replayUploadBackBtn = document.getElementById('replayUploadBackBtn');
const replayUploadStatus = document.getElementById('replayUploadStatus');
const replayModeIcon = document.getElementById('replayModeIcon');
const replayModeTitle = document.getElementById('replayModeTitle');

modeReplay.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  replayModeIcon.replaceChildren(modeIconSvg('replay'));
  replayModeTitle.textContent = MODE_LABELS.replay;
  replayUploadStatus.textContent = '';
  replayUploadOverlay.classList.remove('hidden');
});
// Sidebar's own Replay entry (see index.html) reuses the exact tile above
// rather than duplicating its upload-flow logic — same activeStopGame guard
// as the identity pill, since this is reachable from outside mode-select too.
const navReplay = document.getElementById('navReplay');
navReplay.addEventListener('click', () => { if (!activeStopGame) modeReplay.click(); });
// League/How to/About/Partnership (index.html's #navLeague/#navHowTo/
// #navAbout/#navPartnership) have no destination yet — visual sidebar shell
// only for this pass, intentionally left unwired.
replayUploadBackBtn.addEventListener('click', () => {
  audio.play('button');
  replayUploadOverlay.classList.add('hidden');
  returnToModeSelect();
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
      replayUploadStatus.textContent = 'No points found on this ticket.';
      return;
    }
    replayUploadOverlay.classList.add('hidden');
    beginAmbience();
    activeMatchMode = 'replay';
    activeStopGame = startGame({ ...rockHandlers, replayPoints: points, mobile: IS_MOBILE });
  } catch (err) {
    hideLoadingOverlay();
    replayUploadStatus.textContent = "Couldn't read this file.";
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
    showWaitingScreen(net, (msg) => showLanJoinScreen(msg), net.matchConfig);
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
function showWaitingScreen(net, onLost, matchConfig) {
  const teamLabel = net.myTeam === 'A' ? 'ÉQUIPE BLEUE' : 'ÉQUIPE JAUNE';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  showLobby(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>En attente de l'adversaire…</h2>
    <p>Partage le lien avec l'autre joueur si ce n'est pas déjà fait.</p>
  `);
  net.onOpponentJoined(() => showReadyScreen(net, teamLabel, cls, onLost, matchConfig));
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
function showReadyScreen(net, teamLabel, cls, onLost, matchConfig) {
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
    activeMatchMode = 'remote';
    activeStopGame = startGame({
      ...rockHandlers, net, myTeam: net.myTeam, identiconAddress: identiconOverride(net.myTeam), mobile: IS_MOBILE, matchConfig,
      // Remote Match only in practice (Duel LAN's magic link never goes
      // through Classic/Custom, see conversation) — either player is free to
      // reconfigure a fresh room after the match ends, creator/joiner roles
      // don't carry over past a match's end.
      onChangeSettings: () => { hideMatchChrome(); showCustomSettingsScreen('remote', matchConfig || DEFAULT_MATCH_CONFIG); },
    });
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
  hostedRoomNet = null;
  showNetPanel(`
    <h2>Match réseau</h2>
    <div style="display:flex; gap:12px;">
      <button class="bigbtn" id="matchHostBtn">Créer</button>
      <button class="bigbtn" id="matchJoinBtn">Rejoindre</button>
    </div>
    ${errorMsg ? `<p class="lan-error">${errorMsg}</p>` : ''}
  `);
  // "Créer" is the room creator — routes through Classic/Custom first (see
  // conversation, point 13: the creator defines the rules, the joiner below
  // never sees this screen at all and just receives whatever the creator
  // saved). Persists/reads Remote's own Custom preset, independent from
  // Pass & Play's (src/matchConfig.js).
  document.getElementById('matchHostBtn').onclick = () => {
    audio.play('button');
    showClassicCustomScreen('remote', (config) => hostMatch(config), () => showMatchChoiceScreen());
  };
  document.getElementById('matchJoinBtn').onclick = () => { audio.play('button'); showMatchJoinScreen(); };
}

async function hostMatch(matchConfig) {
  const code = generateMatchCode();
  showLoadingOverlay();
  try {
    const net = await connectMatch(code);
    // Stored server-side against this room (see party/arbiter.js) before
    // sharing the code with anyone — the joiner receives it back in its own
    // 'joined' message (net.js) once it connects, never sends its own.
    net.sendMatchConfig(matchConfig);
    hideLoadingOverlay();
    showMatchHostWaitingScreen(net, code, matchConfig);
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
function showMatchHostWaitingScreen(net, code, matchConfig) {
  const teamLabel = net.myTeam === 'A' ? 'ÉQUIPE BLEUE' : 'ÉQUIPE JAUNE';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  // Alone with a generated code, nobody's joined yet — see
  // matchNetworkBackBtn's own comment for what this gates.
  hostedRoomNet = net;
  showNetPanel(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>En attente de l'adversaire…</h2>
    <div class="match-code">${code}</div>
  `);
  net.onOpponentJoined(() => {
    hostedRoomNet = null;
    showReadyScreen(net, teamLabel, cls, (msg) => showMatchChoiceScreen(msg), matchConfig);
  });
  net.onDisconnect(() => { hostedRoomNet = null; showMatchChoiceScreen("L'autre joueur s'est déconnecté."); });
}

function showMatchJoinScreen(errorMsg) {
  hostedRoomNet = null;
  showNetPanel(`
    <h2>Rejoindre un match</h2>
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
    // The creator's matchConfig, as stored server-side and handed back in
    // this connection's own 'joined' message (see net.js/party/arbiter.js)
    // — this client never chooses/sends its own (point 13 of the brief).
    showWaitingScreen(net, (msg) => showMatchJoinScreen(msg), net.matchConfig);
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
// Timings mirror style.css's #homeOverlay.leaving transition (480ms slide,
// then a 160ms fade once it's lined up with whatever comes next). What's
// revealed underneath (rotate gate / connect gate / mode tiles — see
// revealMenu() above) only appears once the slide itself is done, same "not
// before it's aligned" beat the fade waits for.
const HOME_SLIDE_MS = 480;
const HOME_FADE_MS = 160;
homeOverlay.addEventListener('click', () => {
  audio.play('button');
  homeOverlay.classList.add('leaving');
  setTimeout(revealMenu, HOME_SLIDE_MS);
  setTimeout(() => {
    homeOverlay.classList.add('hidden');
    homeOverlay.classList.remove('leaving');
  }, HOME_SLIDE_MS + HOME_FADE_MS);
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
  activeMatchMode = 'replay';
  activeStopGame = startGame({ ...rockHandlers, replayPoints: [replayFromLink], mobile: IS_MOBILE });
} else if (new URLSearchParams(location.search).has('duel')) {
  homeOverlay.classList.add('hidden');
  joinLan(defaultLanAddress(), null);
}
