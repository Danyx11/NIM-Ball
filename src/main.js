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
  ['modeOverlay', 'vibeSubOverlay', 'connectGateOverlay', 'classicCustomOverlay', 'customSettingsOverlay', 'matchNetworkOverlay', 'comingSoonOverlay', 'joinCodeOverlay', 'replayUploadOverlay'].forEach((id) => {
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
// #mobileController's own on/off look (see .mc-gray-overlay in style.css) —
// same isBasicLaser() state as the cap-src swap below: gray while off.
const powerBtnGray = document.getElementById('tbtn-power-gray');
function syncPowerButton() {
  const off = isBasicLaser();
  powerCap.src = off ? POWER_CAP_SRC.off : POWER_CAP_SRC.on;
  powerBtnGray.classList.toggle('hidden', !off);
}
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
// #mobileController's own state icons (see index.html's comment on
// #tbtn-sound and .mc-icon-overlay/.mc-icon-backdrop in style.css) —
// desktop keeps the slash, mobile hides it and swaps these two real vector
// icons instead, both driven off the same isMuted() state.
const soundOnIcon = document.getElementById('tbtn-sound-on-icon');
const soundOffIcon = document.getElementById('tbtn-sound-off-icon');
function syncSoundButton() {
  const muted = audio.isMuted();
  soundSlash.classList.toggle('show', muted);
  soundOnIcon.classList.toggle('hidden', muted);
  soundOffIcon.classList.toggle('hidden', !muted);
}
syncSoundButton();
// Factored out so the "sound" HUD rock (see startGame's onRockSound option)
// can trigger the exact same logic as the old toolbar button.
function triggerSound() {
  // Order matters: audio.play() (inside playToolbarClick) checks the
  // *current* muted flag and no-ops silently if it's already true (see
  // audio.js) — flipping the mute state first, then playing the click,
  // means muting itself stays silent (you're turning sound off, hearing a
  // click would contradict that) while unmuting still gets its own
  // confirmation click (audio is back on by the time it plays).
  audio.setMuted(!audio.isMuted());
  playToolbarClick(soundCap);
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
  fsRecommendText.textContent = 'Add Nim-Curl to your Home Screen to play fullscreen (Safari share icon)';
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
// Same priority as the sidebar identity pill below (syncIdentityPill): a
// claimed handle beats everything, "Guest" if that's this device's decided
// identity, otherwise no override at all — game.js falls back to a shortened
// address on its own in that last case (see its formatAddressShort). Only
// ever populated for `team`, i.e. whichever side this device's own identity
// controls (see identiconOverride's own comment above) — the opponent/AI
// side never gets a label override here.
function identityLabelOverride(team) {
  if (hubAddress) {
    const handle = getHandle(hubAddress);
    return handle ? { [team]: handle } : {};
  }
  if (getIdentity()?.type === 'guest') return { [team]: 'Guest' };
  return {};
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
const connectText = document.querySelector('.connect-text');
const sidebar = document.getElementById('sidebar');
// Spins .connect-text 500ms round-trip (rotateX, style.css's perspective on
// .nq-connect-btn gives it real depth) when the menu <-> in-match state
// actually flips — see conversation. Content is swapped by `applyChanges`
// exactly at the edge-on 90deg midpoint (invisible either way), then the
// column rotates back in already showing the new state, so there's never a
// frame of upside-down/mirrored text. `flipToken` guards against a second
// flip landing mid-transition (e.g. a very fast handoff) firing its
// `applyChanges` out of order or twice.
// Two mobile-only bug fixes baked in here, both found via an iOS Safari
// report (whole pill — avatar included — flashing fully transparent on the
// very first tap during a live match, every time, gone again on the next
// unrelated tap):
// 1. style.css's `perspective` now lives on a `.flip-perspective` class
//    (added/removed right around this function's own run, see below)
//    instead of being permanently set on .nq-connect-btn — a static 3D
//    context sitting there for the whole match turned out to be the actual
//    trigger, not anything about the animation itself: this only ever runs
//    once, at match start/end, so a tap seconds later mid-match was never
//    "mid-flip" to begin with, yet still vanished, because perspective was
//    still statically present. Scoping it to the ~500ms this function
//    actually runs means a normal in-match tap now hits a plain 2D pill
//    with no 3D context for iOS to drop.
// 2. Driven by setTimeout matching style.css's .25s half-duration, not a
//    `transitionend` listener, which is known to be unreliable for 3D
//    transforms on some mobile WebKit builds.
let flipToken = 0;
function flipConnectText(applyChanges) {
  const token = ++flipToken;
  connectBtn.classList.add('flip-perspective');
  connectText.style.transform = 'rotateX(90deg)';
  setTimeout(() => {
    if (token !== flipToken) return;
    applyChanges();
    connectText.style.transition = 'none';
    connectText.style.transform = 'rotateX(-90deg)';
    void connectText.offsetHeight;
    connectText.style.transition = '';
    requestAnimationFrame(() => {
      if (token !== flipToken) return;
      connectText.style.transform = 'rotateX(0deg)';
      setTimeout(() => {
        if (token === flipToken) connectBtn.classList.remove('flip-perspective');
      }, 260);
    });
  }, 250);
}
// Mobile-only nav accordion (see style.css's .mobile-layout .nav-section) —
// desktop's .nav-label click never does anything visible there (.open has no
// desktop CSS effect), so this listener is just inert weight on desktop, not
// worth an IS_MOBILE guard around it. Each .nav-label toggles its own
// .nav-section's .open; opening one always closes every other section
// first, so at most one is ever expanded — plain CSS siblings-only selectors
// (~, +) can't reach "every other section" from one label, hence doing the
// accordion exclusivity here instead.
// Scroll thumb for an open .nav-section-items that overflows its own
// max-height (see style.css's .mobile-layout .nav-scroll-pill) — a real
// element rather than native scrollbar styling, since iOS Safari doesn't
// support ::-webkit-scrollbar at all. Recomputed on scroll/resize and once
// the open/close max-height transition actually finishes — reading
// scrollHeight/clientHeight mid-transition would give a wrong, still-
// animating size.
function updateNavScrollPill(section) {
  const items = section.querySelector('.nav-section-items');
  const pill = section.querySelector('.nav-scroll-pill');
  if (!items || !pill) return;
  const overflow = items.scrollHeight - items.clientHeight;
  if (!section.classList.contains('open') || overflow <= 1) {
    pill.classList.remove('visible');
    return;
  }
  const trackHeight = items.clientHeight;
  const thumbHeight = Math.max(24, trackHeight * (items.clientHeight / items.scrollHeight));
  const thumbTop = items.offsetTop + (items.scrollTop / overflow) * (trackHeight - thumbHeight);
  pill.style.height = `${thumbHeight}px`;
  pill.style.top = `${thumbTop}px`;
  pill.classList.add('visible');
}
const navSections = [...document.querySelectorAll('.nav-section')];
navSections.forEach((section) => {
  const label = section.querySelector('.nav-label');
  const items = section.querySelector('.nav-section-items');
  label.addEventListener('click', () => {
    const wasOpen = section.classList.contains('open');
    navSections.forEach((s) => {
      s.classList.remove('open');
      s.querySelector('.nav-label').setAttribute('aria-expanded', 'false');
    });
    if (!wasOpen) {
      section.classList.add('open');
      label.setAttribute('aria-expanded', 'true');
    }
    navSections.forEach(updateNavScrollPill);
  });
  items.addEventListener('scroll', () => updateNavScrollPill(section));
  items.addEventListener('transitionend', (e) => { if (e.propertyName === 'max-height') updateNavScrollPill(section); });
});
window.addEventListener('resize', () => navSections.forEach(updateNavScrollPill));
// address -> "abc…xyz" (first/last 3 chars), the sidebar pill's compact
// format for the status line (both platforms now — mobile used to keep its
// own plain `${slice(0,9)}…`/"Connected" pairing here, predating the
// handle-claim flow below, but that was its own bottom-right CTA pill; now
// that mobile reuses this same in-column sidebar pill, it gets the same
// handle-claim treatment too).
function shortenAddressCompact(address) {
  return address.length <= 8 ? address : `${address.slice(0, 3)}…${address.slice(-3)}`;
}
// Shows immediately once the sidebar itself does (both platforms, right
// after the home-screen animation — see conversation), not gated on the
// player having been through the connect gate yet: undecided reads the same
// as Guest here (hubAddress null, no persisted identity) rather than hiding
// the pill outright, per explicit request. Used to hide until decided, to
// avoid "Guest" reading as already-chosen while the gate was still open —
// reversed since the pill is now expected to always be visible, gate open
// or not.
// During a live match (activeStopGame set) the pill is pure display, never a
// trigger (see its own click handler below, already gated on this same
// flag) — so it never shows an actionable "Claim a handle"/"Connect wallet"
// line then either, just whatever identity is already resolved: the handle
// (+ address below it) if one's claimed, otherwise a single line — just the
// address, or just "Guest" — hiding the other line outright (see style.css's
// #connectBtnLabel.hidden/.connect-status.hidden) rather than merely
// emptying it, so .connect-text shrinks to it and it centers against the
// avatar for free via .nq-connect-btn's own align-items:center.
function applyIdentityPillState() {
  const inMatch = !!activeStopGame;
  connectBtn.classList.toggle('connected', !!hubAddress);
  connectBtnLabel.classList.remove('claim-cta');
  connectBtnLabel.classList.remove('hidden');
  connectBtnStatus.classList.remove('mono');
  connectBtnStatus.classList.remove('hidden');
  connectAvatar.classList.toggle('has-identicon', !!hubAddress);
  connectAvatar.style.backgroundImage = '';
  if (!hubAddress) {
    connectBtnLabel.textContent = 'Guest';
    if (inMatch) {
      connectBtnStatus.textContent = '';
      connectBtnStatus.classList.add('hidden');
    } else {
      connectBtnStatus.textContent = 'Connect wallet';
    }
    return;
  }
  getIdenticonPngDataUrl(hubAddress).then((url) => {
    if (hubAddress) connectAvatar.style.backgroundImage = `url(${url})`;
  });
  const handle = getHandle(hubAddress);
  connectBtnStatus.textContent = shortenAddressCompact(hubAddress);
  connectBtnStatus.classList.add('mono');
  if (handle) {
    connectBtnLabel.textContent = handle;
  } else if (inMatch) {
    connectBtnLabel.textContent = '';
    connectBtnLabel.classList.add('hidden');
  } else {
    connectBtnLabel.textContent = 'Claim a handle';
    connectBtnLabel.classList.add('claim-cta');
  }
}
// pillInMatch tracks the menu/in-match side of the pill's *last applied*
// state, separately from every other reason syncIdentityPill() gets called
// (claiming a handle, connecting/disconnecting, switching mode) — only an
// actual menu <-> match flip should trigger flipConnectText; everything
// else applies immediately, same as before this animation existed. null on
// the very first call means "nothing applied yet", so that first paint is
// instant too, not a flip out of nowhere on load.
let pillInMatch = null;
function syncIdentityPill() {
  const inMatch = !!activeStopGame;
  const changedMode = pillInMatch !== null && pillInMatch !== inMatch;
  pillInMatch = inMatch;
  if (changedMode) {
    flipConnectText(applyIdentityPillState);
  } else {
    applyIdentityPillState();
  }
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
// Reveals the tile grid — the staggered pop-in (see style.css's
// .mode-drawer:not(.hidden) .half) is driven entirely by CSS off .hidden
// itself, so it replays every time this is called: home screen handoff,
// Classic/Custom's back arrow, returnToModeSelect, the connect gate, etc.
function showModeDrawer() {
  vibeSubOverlay.classList.add('hidden');
  modeDrawer.classList.remove('hidden');
  modeOverlay.classList.remove('hidden');
}
const modeDrawer = document.getElementById('modeDrawer');
const modeHockey = document.getElementById('modeHockey');
const modeCurling = document.getElementById('modeCurling');
const modeSolo = document.getElementById('modeSolo');
const modeJoinCode = document.getElementById('modeJoinCode');
const startOverlay = document.getElementById('startOverlay');
const overlay = document.getElementById('overlay');
const ovContent = document.getElementById('ovContent');

// ---- Vibe pick (Hockey/Curling, see conversation) — one level above P&P/
// Remote now: #modeHockey/#modeCurling (the top row of #modeDrawer) open
// #vibeSubOverlay's own 2-tile drawer (#modeLocal/#modeMatch, untouched)
// instead of going straight into Classic/Custom. `activeVibe` drives every
// downstream tint (Classic/Custom, Custom Settings, Remote Match's 3
// screens, the exit-confirm dialog, the in-match +1 goal panel in game.js)
// — always set before any of those screens is reachable, since they all
// live behind #vibeSubOverlay now.
let activeVibe = null;
const vibeSubOverlay = document.getElementById('vibeSubOverlay');
const vibeBackBtn = document.getElementById('vibeBackBtn');
const modeLocal = document.getElementById('modeLocal');
const modeMatch = document.getElementById('modeMatch');
// Cloned into each of #modeLocal/#modeMatch's own top (.tile-vibe-logo, see
// index.html) rather than a separate external header (see conversation) —
// aria-hidden in the markup since each tile's own tag ("PASS & PLAY"/
// "REMOTE MATCH") already gives screen readers a real name; this is a
// purely decorative reinforcement, redundant to announce on both tiles.
const modeLocalVibeLogo = document.getElementById('modeLocalVibeLogo');
const modeMatchVibeLogo = document.getElementById('modeMatchVibeLogo');
const VIBE_LABELS = { hockey: 'NimiCurl', curling: 'Pure Curling' };
const VIBE_TILES = { hockey: modeHockey, curling: modeCurling };
function vibeTintClass() { return activeVibe === 'curling' ? 'mode-curling' : 'mode-hockey'; }
function showVibeDrawer(vibe) {
  activeVibe = vibe;
  const vibeIcon = VIBE_TILES[vibe].querySelector('.mode-icon');
  modeLocalVibeLogo.replaceChildren(vibeIcon.cloneNode(true));
  modeMatchVibeLogo.replaceChildren(vibeIcon.cloneNode(true));
  vibeSubOverlay.classList.remove('mode-hockey', 'mode-curling');
  vibeSubOverlay.classList.add(vibeTintClass());
  modeDrawer.classList.add('hidden');
  vibeSubOverlay.classList.remove('hidden');
  modeOverlay.classList.remove('hidden');
}
modeHockey.addEventListener('click', () => { audio.play('button'); showVibeDrawer('hockey'); });
modeCurling.addEventListener('click', () => { audio.play('button'); showVibeDrawer('curling'); });
// Lives inside #modeMatch now (see index.html's own comment there) — without
// stopPropagation this click would also bubble up into modeMatch's own
// listener below and immediately jump into Remote Match right after going
// back.
vibeBackBtn.addEventListener('click', (e) => { e.stopPropagation(); audio.play('button'); showModeDrawer(); });

// ---- Curling: tiles/menus are live (see conversation), the actual match
// engine isn't plugged in yet — every path that would otherwise call
// startGame()/hostMatch() lands here instead. Its own small .config-panel
// (see index.html's #comingSoonOverlay comment) rather than showLobby/
// #overlay, which desktop's menuHost move keeps behind #menuStage — this
// needs to sit on top of #modeOverlay's still-visible backdrop like every
// other pre-match menu panel.
const comingSoonOverlay = document.getElementById('comingSoonOverlay');
const csoIcon = document.getElementById('csoIcon');
const csoOkBtn = document.getElementById('csoOkBtn');
function showComingSoonScreen() {
  // Defensive: reached from more than one screen (Classic/Custom's own
  // launch callback, which already hides itself first — but also straight
  // off Match réseau's "Rejoindre", which hasn't hidden matchNetworkOverlay
  // yet) — hiding both here regardless of which path called in keeps
  // returnToModeSelect() below from leaving a stale panel behind it.
  classicCustomOverlay.classList.add('hidden');
  hideNetPanel();
  csoIcon.replaceChildren(VIBE_TILES[activeVibe].querySelector('.mode-icon').cloneNode(true));
  csoIcon.setAttribute('aria-label', VIBE_LABELS[activeVibe]);
  comingSoonOverlay.classList.remove('mode-hockey', 'mode-curling');
  comingSoonOverlay.classList.add(vibeTintClass());
  comingSoonOverlay.classList.remove('hidden');
}
csoOkBtn.addEventListener('click', () => {
  audio.play('button');
  comingSoonOverlay.classList.add('hidden');
  returnToModeSelect();
});

const OVERLAY_TINT_CLASSES = ['mode-hockey', 'mode-curling', 'mode-solo', 'mode-replay'];
// mode: 'passplay'/'remote' (tint follows activeVibe — hockey/curling), or
// 'solo'/'replay' (fixed tint, untouched by the vibe system).
function showLobby(html, mode = null) {
  // Defensive, same reasoning as showComingSoonScreen's own hideNetPanel()
  // call: Match Réseau's host-waiting screen (showMatchHostWaitingScreen)
  // lives on the separate #matchNetworkOverlay panel (showNetPanel), not
  // this one — every path from there into the shared LAN/Remote lobby
  // (showWaitingScreen/showReadyScreen below) swaps in this overlay on TOP
  // of it without ever tearing the net panel down first, which left it
  // visually stuck in front (see conversation: the Ready button was
  // rendering correctly underneath, just fully obscured — nobody could ever
  // actually start a Match Réseau game).
  hideNetPanel();
  // Same bug, same fix, for the joiner's side: "Join with a code"
  // (showJoinCodeScreen) never hides its own #joinCodeOverlay panel before
  // handing off into this shared lobby on a successful connectMatch(), so it
  // sat on top of the waiting/ready screen forever — neither ever visibly
  // went away, and the Ready button underneath was unreachable.
  joinCodeOverlay.classList.add('hidden');
  // showNetPanel (every Match Réseau screen above) deliberately keeps
  // #modeOverlay itself visible throughout, for its own arena-illustration
  // backdrop (see its own comment) — but #modeOverlay (z-index 3) sits above
  // #game-card (z-index 1), which is what #overlay/this lobby actually lives
  // in, so that backdrop was left fully covering the waiting/ready screen
  // too, same invisible-Ready-button bug as above. #modeOverlay is a no-op
  // to hide here for Duel LAN (never shown in the first place — the `?duel`
  // link skips mode-select entirely), and showNetPanel() unhides it again on
  // the way back out (disconnect -> showCreateMatchScreen), so this doesn't
  // strand Remote Match's own "back" path either.
  modeOverlay.classList.add('hidden');
  overlay.classList.remove(...OVERLAY_TINT_CLASSES);
  let cls = null;
  if (mode === 'passplay' || mode === 'remote') cls = vibeTintClass();
  else if (mode === 'solo' || mode === 'replay') cls = `mode-${mode}`;
  if (cls) overlay.classList.add(cls);
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
  // Mobile's utility column shares #mobileController's reserved width —
  // brand/nav are menu-only, hidden in lockstep with the controller
  // appearing, but the identity pill stays up throughout a match too now
  // (persistent, per explicit request), same as desktop's #sidebar always
  // does (see style.css's .mobile-layout #sidebar.in-match).
  if (IS_MOBILE) sidebar.classList.add('in-match');
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
  syncIdentityPill();
  toolbarTop.classList.add('hidden');
  toolbarBottom.classList.add('hidden');
  mobileController.classList.add('hidden');
  startOverlay.classList.add('hidden');
  if (IS_MOBILE) sidebar.classList.remove('in-match');
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
const ccCreateLabel = document.getElementById('ccCreateLabel');
const ccError = document.getElementById('ccError');
const classicBtn = document.getElementById('classicBtn');
const customBtn = document.getElementById('customBtn');
const customSettingsOverlay = document.getElementById('customSettingsOverlay');
const csModeIcon = document.getElementById('csModeIcon');
const csBackBtn = document.getElementById('csBackBtn');
const csResetBtn = document.getElementById('csResetBtn');
const csSaveBtn = document.getElementById('csSaveBtn');
const segControls = [...customSettingsOverlay.querySelectorAll('.seg-control')];
// Remote Match's own 3 sub-screens (choice, generated code, code to fill in)
// — same tile-colored/centered-header/exit-arrow language as the two
// screens above. Tint now follows the active vibe (set in showNetPanel,
// same mode-hockey/mode-curling classes as classicCustomOverlay/
// customSettingsOverlay below) rather than being fixed gold in the markup —
// Remote Match lives under either vibe now, not just its own thing.
const matchNetworkOverlay = document.getElementById('matchNetworkOverlay');
const matchNetworkContent = document.getElementById('matchNetworkContent');
const matchNetworkBackBtn = document.getElementById('matchNetworkBackBtn');
const matchNetworkModeIcon = document.getElementById('matchNetworkModeIcon');

const MODE_LABELS = { passplay: 'PASS & PLAY', remote: 'REMOTE MATCH', joincode: 'JOIN WITH A CODE' };
// Reuses #modeOverlay's own tile icons (cloned, never a new asset) — see
// explicit request not to introduce a new logo for these screens. Replay
// dropped (see conversation) — its own header is static markup now, not
// cloned, since #modeReplay doesn't exist anymore (repurposed into
// #modeJoinCode, a different icon).
const MODE_TILES = { passplay: modeLocal, remote: modeMatch, joincode: modeJoinCode };
function modeIconSvg(mode) {
  return MODE_TILES[mode].querySelector('.mode-icon').cloneNode(true);
}
// Also tints the panel itself with the active vibe's color (see
// vibeTintClass above) — both screens are shared between Pass & Play and
// Remote Match, and between Hockey and Curling, rather than duplicated per
// mode/vibe, so the tint is applied here rather than baked into the markup.
// No visible title text anymore (icon only, see conversation) — MODE_LABELS
// still feeds the icon's aria-label so screen readers keep a name.
function fillModeHeader(panelEl, iconEl, mode) {
  iconEl.replaceChildren(modeIconSvg(mode));
  iconEl.setAttribute('aria-label', MODE_LABELS[mode]);
  panelEl.classList.remove('mode-hockey', 'mode-curling');
  panelEl.classList.add(vibeTintClass());
}

// Set once — this panel's icon never changes (always Remote Match).
matchNetworkModeIcon.replaceChildren(modeIconSvg('remote'));
matchNetworkModeIcon.setAttribute('aria-label', MODE_LABELS.remote);

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
  matchNetworkOverlay.classList.remove('mode-hockey', 'mode-curling');
  matchNetworkOverlay.classList.add(vibeTintClass());
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  vibeSubOverlay.classList.add('hidden');
  matchNetworkOverlay.classList.remove('hidden');
}
function hideNetPanel() { matchNetworkOverlay.classList.add('hidden'); }

// Back to the vibe sub-drawer (one level up, see conversation) — only ever
// reachable from showMatchHostWaitingScreen now (the Create/Join choice and
// in-flow Join screens this used to also cover are gone), which has no
// earlier step of its own the way Classic/Custom's Back does.
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
  showVibeDrawer(activeVibe);
});

// Called once a mode/config choice is actually ready to launch — resumes
// that mode's own existing entry flow exactly as before this feature
// (Pass & Play's #startOverlay ready-tap, Remote Match's hostMatch()), just
// now carrying a matchConfig through it.
let onConfigReady = null;
// Where this screen's own Back arrow goes — Pass & Play reaches Classic/
// Custom straight from #modeOverlay, so Back lands there; Remote Match now
// does too (see conversation — the old Create/Join choice screen in
// between is gone), so both just go straight back to the vibe sub-drawer.
let onConfigBack = null;

// errorMsg: Remote Match only (see hostMatch's own catch below and
// showMatchHostWaitingScreen's onDisconnect/onLost) — this screen doubles
// as the connection-failure retry point now that there's no separate
// Create/Join screen to show it on.
function showClassicCustomScreen(mode, launch, goBack, errorMsg) {
  onConfigReady = launch;
  onConfigBack = goBack;
  fillModeHeader(classicCustomOverlay, ccModeIcon, mode);
  // "CREATE A MATCH" only for Remote (see conversation) — P&P has no
  // create/join distinction, straight into Classic/Custom is self-
  // explanatory there.
  ccCreateLabel.classList.toggle('hidden', mode !== 'remote');
  ccError.classList.toggle('hidden', !errorMsg);
  ccError.textContent = errorMsg || '';
  hideLobby();
  hideNetPanel();
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  vibeSubOverlay.classList.add('hidden');
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
// Remote Match's own entry point (see conversation): straight into Classic/
// Custom now, no Create/Join choice in between — this screen IS "create"
// for Remote (Join lives entirely on the separate #modeJoinCode tile).
// Reused as the retry target on a connection failure too (hostMatch's catch,
// showMatchHostWaitingScreen's onDisconnect/onLost below).
function showCreateMatchScreen(errorMsg) {
  showClassicCustomScreen('remote', (config) => hostMatch(config), () => showVibeDrawer(activeVibe), errorMsg);
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
  fillModeHeader(customSettingsOverlay, csModeIcon, mode);
  renderCustomSettingsDraft();
  hideLobby();
  hideNetPanel();
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  vibeSubOverlay.classList.add('hidden');
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
  vibeSubOverlay.classList.add('hidden');
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
      ...rockHandlers, identiconAddress: identiconOverride('A'), identiconLabel: identityLabelOverride('A'), mobile: IS_MOBILE, matchConfig: config, vibe: activeVibe,
      onChangeSettings: () => { hideMatchChrome(); showCustomSettingsScreen('passplay', config); },
    });
    syncIdentityPill();
  }, () => showVibeDrawer(activeVibe));
});

modeMatch.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  showCreateMatchScreen();
});

// Solo vs IA: only one human, controlling team A — no ready-tap lobby needed
// (game.js's aiTeam branch skips #startOverlay itself), straight into aimA.
modeSolo.addEventListener('click', () => {
  audio.play('button');
  modeOverlay.classList.add('hidden');
  showToolbar();
  activeMatchMode = 'solo';
  activeStopGame = startGame({ ...rockHandlers, aiTeam: 'B', identiconAddress: identiconOverride('A'), identiconLabel: identityLabelOverride('A'), mobile: IS_MOBILE });
  syncIdentityPill();
});

// ---- Replay mode (see CLAUDE.md replay section) — upload a saved ticket
// image, decode whichever of its up-to-5 point QR tiles are present (see
// src/replay.js's decodePointsFromTicketImage, which crops the ticket's
// known fixed layout rather than doing general multi-QR detection), and
// assemble them into a playable replay. No arcade #toolbar here — replay
// gets its own custom playback bar, wired inside game.js's startGame().
// No longer a mode-grid tile (see conversation — that slot is
// #modeJoinCode now): reachable only from the sidebar's own Replay entry
// below, so its header is static markup in index.html rather than cloned
// from a tile that doesn't exist anymore.
const replayUploadOverlay = document.getElementById('replayUploadOverlay');
const replayUploadBox = document.getElementById('replayUploadBox');
const replayFileInput = document.getElementById('replayFileInput');
const replayChooseFileBtn = document.getElementById('replayChooseFileBtn');
const replayUploadBackBtn = document.getElementById('replayUploadBackBtn');
const replayUploadStatus = document.getElementById('replayUploadStatus');

function showReplayUpload() {
  audio.play('button');
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  vibeSubOverlay.classList.add('hidden');
  replayUploadStatus.textContent = '';
  replayUploadOverlay.classList.remove('hidden');
}
// Sidebar's own Replay entry (see index.html) — same activeStopGame guard as
// the identity pill, since this is reachable from outside mode-select too.
const navReplay = document.getElementById('navReplay');
navReplay.addEventListener('click', () => { if (!activeStopGame) showReplayUpload(); });

// ---- "Join with a code" (see conversation) — was the Replay tile's slot,
// now a direct shortcut into joining an already-created private match by
// its 4-character code, skipping the vibe/P&P-Remote picker entirely. Own
// fixed Nimiq-Green tint (index.html's #joinCodeOverlay, style.css's
// .mode-joincode) rather than the vibe-driven tint every other config-panel
// here uses, since this screen exists outside that picker. Reuses
// joinMatch() below (same connect logic Remote Match's own Join screen
// uses), just with its own entry/retry screen.
const joinCodeOverlay = document.getElementById('joinCodeOverlay');
const joinCodeBackBtn = document.getElementById('joinCodeBackBtn');
const joinCodeModeIcon = document.getElementById('joinCodeModeIcon');
const joinCodeContent = document.getElementById('joinCodeContent');
// Set once — this panel's icon never changes.
joinCodeModeIcon.replaceChildren(modeIconSvg('joincode'));
joinCodeModeIcon.setAttribute('aria-label', MODE_LABELS.joincode);

function showJoinCodeScreen(errorMsg) {
  hostedRoomNet = null;
  classicCustomOverlay.classList.add('hidden');
  customSettingsOverlay.classList.add('hidden');
  hideNetPanel();
  modeOverlay.classList.remove('hidden');
  modeDrawer.classList.add('hidden');
  vibeSubOverlay.classList.add('hidden');
  joinCodeContent.innerHTML = `
    <h2>Join with a code</h2>
    <input id="joinCodeInput" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="XXXX" />
    <button class="bigbtn" id="joinCodeSubmitBtn">Join</button>
    ${errorMsg ? `<p class="lan-error">${errorMsg}</p>` : ''}
  `;
  const input = document.getElementById('joinCodeInput');
  const joinBtn = document.getElementById('joinCodeSubmitBtn');
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  joinBtn.onclick = () => { audio.play('button'); joinMatch(input.value, joinBtn, showJoinCodeScreen); };
  joinCodeOverlay.classList.remove('hidden');
}
modeJoinCode.addEventListener('click', () => { audio.play('button'); showJoinCodeScreen(); });
joinCodeBackBtn.addEventListener('click', () => {
  audio.play('button');
  joinCodeOverlay.classList.add('hidden');
  returnToModeSelect();
});
// League/How to/About/Partnership/Nimiq (index.html's #navLeague/#navHowTo/
// #navAbout/#navPartnership/#navNimiq) have no destination yet — visual sidebar shell
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
    syncIdentityPill();
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
    <p>Server address (already pre-filled if you ran <code>npm run duel</code>):</p>
    <input id="lanAddr" type="text" value="${defaultLanAddress()}" autocomplete="off" />
    <button class="bigbtn" id="lanJoinBtn">Join</button>
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

// Shared by Duel LAN and Match Réseau (see joinMatch/hostMatch below) —
// both connect the exact same way from here on (same net.js
// interface, see CLAUDE.md "Network match"), only how `net` was obtained
// differs. `onLost(msg)` decides where "opponent disconnected" sends the
// player back to — each mode's own entry screen, so an error there offers
// the right retry (LAN address vs. match code) rather than a generic dead end.
function showWaitingScreen(net, onLost, matchConfig) {
  const teamLabel = net.myTeam === 'A' ? 'TEAM BLUE' : 'TEAM YELLOW';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  showLobby(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>Waiting for opponent…</h2>
    <p>Share the link with the other player if you haven't already.</p>
  `);
  net.onOpponentJoined(() => showReadyScreen(net, teamLabel, cls, onLost, matchConfig));
  net.onDisconnect(() => onLost('The other player disconnected.'));
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
    <h2>Opponent connected!</h2>
    <p>Tap to start the match.</p>
    <button class="bigbtn" id="lanReadyBtn">Ready</button>
  `);
  document.getElementById('lanReadyBtn').onclick = () => {
    audio.unlock();
    audio.play('button');
    net.sendReady();
    showLobby(`
      <span class="team-pill ${cls}">${teamLabel}</span>
      <h2>Waiting for the other player…</h2>
    `);
  };
  net.onBothReady(() => {
    hideLobby();
    showToolbar();
    activeMatchMode = 'remote';
    // activeVibe is already correct for both roles by this point: the
    // creator's own local pick, or (Remote Match joiner only) overridden to
    // the creator's actual vibe as soon as the room was joined — see
    // joinMatch's net.vibe handling above.
    activeStopGame = startGame({
      ...rockHandlers, net, myTeam: net.myTeam, identiconAddress: identiconOverride(net.myTeam), identiconLabel: identityLabelOverride(net.myTeam), mobile: IS_MOBILE, matchConfig, vibe: activeVibe,
      // Remote Match only in practice (Duel LAN's magic link never goes
      // through Classic/Custom, see conversation) — either player is free to
      // reconfigure a fresh room after the match ends, creator/joiner roles
      // don't carry over past a match's end.
      onChangeSettings: () => { hideMatchChrome(); showCustomSettingsScreen('remote', matchConfig || DEFAULT_MATCH_CONFIG); },
    });
    syncIdentityPill();
  });
  net.onDisconnect(() => onLost('The other player disconnected.'));
}

// ---- Match Réseau (see CLAUDE.md "Network match") — same lobby flow as Duel
// LAN above (showWaitingScreen/showReadyScreen, same net.js interface), just
// reached via a 4-character room code instead of typing a LAN address.
// hostMatch() below generates the code and is team A (first to connect to
// that PartyKit room, see party/arbiter.js); "Join with a code" (its own
// #modeJoinCode tile, see conversation) is the only way in as team B now —
// there's no in-Remote-Match Create/Join choice anymore, this whole screen
// pair used to live behind one (showMatchChoiceScreen/showMatchJoinScreen,
// both removed) that's since been replaced by showCreateMatchScreen going
// straight to Classic/Custom.
//
// Alphabet excludes visually ambiguous characters (0/O, 1/I) since the code
// is read off one screen and typed on another, often by voice or a glance
// across a room — a misread digit would just bounce off `full`/an empty room
// instead of erroring clearly, so cutting the ambiguity avoids that class of
// mistake at the source.
//
// Purely a room password now — carries no information of its own (see
// conversation: an earlier version packed vibe+matchConfig into the code
// itself as a hedge against a possibly-stale arbiter deployment, but that
// traded away most of the code's entropy for no real gain once the arbiter
// relay was confirmed correct). The room itself is authoritative on its own
// ruleset: hostMatch below sends matchConfig+vibe to the room the moment it
// connects, before the code is ever shared, and a joiner's connectMatch()
// promise only resolves once the room's own 'joined' reply — carrying that
// same matchConfig+vibe back — has arrived (see net.js), so there's no
// window where a joiner could render anything under the wrong ruleset.
const MATCH_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateMatchCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += MATCH_CODE_ALPHABET[Math.floor(Math.random() * MATCH_CODE_ALPHABET.length)];
  return code;
}

async function hostMatch(matchConfig) {
  const code = generateMatchCode();
  showLoadingOverlay();
  try {
    const net = await connectMatch(code);
    // Stored server-side against this room (see party/arbiter.js) before
    // sharing the code with anyone — the joiner receives it back in its own
    // 'joined' message (net.js) once it connects, never sends its own. Vibe
    // rides along the same message/room field for the same reason (see
    // joinMatch's own net.vibe handling) — "Join with a code" has no vibe
    // tile of its own, but the actual match must still run whichever vibe
    // the creator chose.
    net.sendMatchConfig(matchConfig, activeVibe);
    hideLoadingOverlay();
    showMatchHostWaitingScreen(net, code, matchConfig);
  } catch (err) {
    hideLoadingOverlay();
    showCreateMatchScreen(err.message);
  }
}

// Same shape as showWaitingScreen above, but also displays the code (the
// host is the one waiting to share it) and sends a disconnected opponent
// back to Classic/Custom (a fresh Classic/Custom pick gets a fresh code —
// the old one, tied to this now-empty room, isn't reused).
function showMatchHostWaitingScreen(net, code, matchConfig) {
  const teamLabel = net.myTeam === 'A' ? 'TEAM BLUE' : 'TEAM YELLOW';
  const cls = net.myTeam === 'A' ? 'a' : 'b';
  // Alone with a generated code, nobody's joined yet — see
  // matchNetworkBackBtn's own comment for what this gates.
  hostedRoomNet = net;
  showNetPanel(`
    <span class="team-pill ${cls}">${teamLabel}</span>
    <h2>Waiting for opponent…</h2>
    <div class="match-code">${code}</div>
  `);
  net.onOpponentJoined(() => {
    hostedRoomNet = null;
    showReadyScreen(net, teamLabel, cls, (msg) => showCreateMatchScreen(msg), matchConfig);
  });
  net.onDisconnect(() => { hostedRoomNet = null; showCreateMatchScreen('The other player disconnected.'); });
}

// retryScreen: where an error (bad code, connect failure) or a later
// disconnect sends the player back to re-enter a code — "Join with a code"
// (see conversation) is the only caller left now that Remote Match's own
// in-flow Join screen is gone, so it always passes its own
// showJoinCodeScreen to retry in place.
async function joinMatch(code, joinBtn, retryScreen) {
  if (code.length !== 4) return;
  if (joinBtn) joinBtn.disabled = true;
  showLoadingOverlay();
  try {
    const net = await connectMatch(code);
    hideLoadingOverlay();
    // Adopt the creator's actual vibe (see hostMatch's sendMatchConfig /
    // party/arbiter.js) instead of trusting whatever tile this client
    // happened to be on before typing the code in — that pick only got them
    // to the "enter code" screen, it was never a promise the match itself
    // would run that vibe. Reassigning activeVibe here (not just threading
    // net.vibe into this one startGame() call) keeps every other vibe-aware
    // bit of UI between here and kickoff (tint classes, Change Settings)
    // consistent too. No-op for Duel LAN, which never sends a vibe (net.vibe
    // stays null there, see net.js) and for "Join with a code", which has no
    // vibe tile of its own to have picked in the first place. connectMatch()'s
    // promise only resolves once the room's own 'joined' reply — carrying
    // this same vibe (and matchConfig below) — has arrived (see net.js), so
    // showLoadingOverlay above already covers the entire window where we
    // don't yet know the room's real ruleset; nothing renders before then.
    if (net.vibe) activeVibe = net.vibe;
    // The creator's matchConfig, as stored server-side and handed back in
    // this connection's own 'joined' message (see net.js/party/arbiter.js)
    // — this client never chooses/sends its own (point 13 of the brief).
    showWaitingScreen(net, (msg) => retryScreen(msg), net.matchConfig);
  } catch (err) {
    hideLoadingOverlay();
    retryScreen(err.message);
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
  syncIdentityPill();
} else if (new URLSearchParams(location.search).has('duel')) {
  homeOverlay.classList.add('hidden');
  joinLan(defaultLanAddress(), null);
}
