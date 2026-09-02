// Ported from prototypes/nimball-merged.html — merges the illustrated arena
// background, translucent bubble-style avatars, and arcade physics/goal
// capture mechanics explored across the earlier prototypes.

// Prefixed with BASE_URL (not a bare leading slash) so these public/ assets
// still resolve when the app is served from a subpath, e.g. GitHub Pages at
// https://danyx11.github.io/NIM-Ball/.
import { audio } from './audio.js';
import { getIdenticonCanvasStoneBust, getIdenticonPngDataUrl, getIdenticonBgColor } from './identicons.js';
import { computeAiShots, DEFAULT_AI_CONFIG } from './ai.js';
import { isBasicLaser } from './settings.js';
import { preloadTicketAssets, renderTicket } from './ticket.js';
import { loadImages } from './preload.js';
import * as recorder from './recorder.js';
import { MAX_POINTS_ON_TICKET, pointTileRect, buildReplayUrl, POINTS_SECTION_Y, POINTS_SECTION_H, TICKET_W, TICKET_H } from './replay.js';
import { DEFAULT_MATCH_CONFIG, STONE_SLOTS_BY_COUNT, TIMER_WARNING_SECONDS_BY_TURN_TIME, sanitizeMatchConfig } from './matchConfig.js';
import { HOWTO_STEPS } from './howto.js';

const ASSET_BASE = import.meta.env.BASE_URL;
// Placeholder demo addresses, used unless opts.identiconAddress overrides a
// team (see src/nimiq.js's chooseAddress() — main.js's Hub test button wires
// a real chosen address in for team A). The identicon pipeline below doesn't
// care where the address string comes from.
const DEFAULT_IDENTICON_ADDRESS = {
  A: 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG',
  B: 'NQ19 AXEU PPQ9 5610 YF48 VLTJ QR6Y 0HS1 UH89',
};
// Stone body art now bakes the 4 damage LEDs directly in, per how many are
// still alive (see conversation — hand-painted glow in GIMP, exported as
// scripts/export_led_states.py generated a flat first pass, then reworked
// into design/generated/led-states/rw/*rw.png). '0' reuses the plain colori
// art (no LEDs lit — nothing to bake, see LED_STATE_SRC below); '1dim' is
// the same single-LED state as '1' but at the pulse animation's dim floor —
// drawStone() crossfades '1dim'->'1' for the "last life" warning instead of
// a live shadowBlur/recompute, see stoneLedState().
const LED_STATE_SRC = {
  A: {
    0: `${ASSET_BASE}identicons/stone-navy-colori.webp`,
    1: `${ASSET_BASE}identicons/stone-navy-leds1.webp`,
    '1dim': `${ASSET_BASE}identicons/stone-navy-leds1dim.webp`,
    2: `${ASSET_BASE}identicons/stone-navy-leds2.webp`,
    3: `${ASSET_BASE}identicons/stone-navy-leds3.webp`,
    4: `${ASSET_BASE}identicons/stone-navy-leds4.webp`,
  },
  B: {
    0: `${ASSET_BASE}identicons/stone-gold-colori.webp`,
    1: `${ASSET_BASE}identicons/stone-gold-leds1.webp`,
    '1dim': `${ASSET_BASE}identicons/stone-gold-leds1dim.webp`,
    2: `${ASSET_BASE}identicons/stone-gold-leds2.webp`,
    3: `${ASSET_BASE}identicons/stone-gold-leds3.webp`,
    4: `${ASSET_BASE}identicons/stone-gold-leds4.webp`,
  },
};
const LED_STATE_KEYS = ['0', '1', '1dim', '2', '3', '4'];
const LIGHT_LAYER_SRC = `${ASSET_BASE}identicons/stone-light-layer.webp`;
const ARENA_FRAME_SRC = `${ASSET_BASE}arena/frame.webp`;
// Mobile-only pre-crop of the above (see scripts/bake_mobile_frame.py and
// the MOBILE_CROP comment in startGame() below) — same pixels, just the
// sub-rect mobile ever actually shows, so the phone downloads/decodes ~57%
// less image data for art it was always going to crop away anyway.
const ARENA_FRAME_MOBILE_SRC = `${ASSET_BASE}arena/frame-mobile.webp`;
// Winter arena variant (see conversation — art already baked, just not
// wired to a skin picker before matchConfig existed). Same desktop/mobile
// pre-crop pairing as the summer frame above.
const ARENA_FRAME_WINTER_SRC = `${ASSET_BASE}arena/frame-winter.webp`;
const ARENA_FRAME_WINTER_MOBILE_SRC = `${ASSET_BASE}arena/frame-winter-mobile.webp`;
// Curling vibe (see conversation / vibe param below): same desktop/mobile x
// summer/winter set as above, baked by scripts/bake_curling_arena.py — the
// target + its timer ring in place of the hexagon (hexagon/halfway-line
// erased; the goal-crease arcs and bars are kept as-is, a real hazard even
// though this mode never scores through them).
const ARENA_FRAME_CURLING_SRC = `${ASSET_BASE}arena/frame-curling.webp`;
const ARENA_FRAME_CURLING_MOBILE_SRC = `${ASSET_BASE}arena/frame-curling-mobile.webp`;
const ARENA_FRAME_CURLING_WINTER_SRC = `${ASSET_BASE}arena/frame-curling-winter.webp`;
const ARENA_FRAME_CURLING_WINTER_MOBILE_SRC = `${ASSET_BASE}arena/frame-curling-winter-mobile.webp`;
const BALL_SRC = `${ASSET_BASE}ball/ball.png`;
// HUD rock glow — each of the 5 rocks baked into the arena art has a
// hand-painted "flou"/soft halo + "light"/sharp core pair (Arena V2
// chat.xcf, see conversation), extracted as their own small sprites rather
// than baked permanently into frame.webp so their on/off state can be
// driven live. Positions/sizes are the xcf layer offsets ×2 (the fal.ai
// upscale baked into the current frame.webp).
const ROCK_GLOW = {
  ice: { x: 1432, y: 396, w: 116, h: 120, lx: 1462, ly: 426, lw: 56, lh: 60 },
  laser: { x: 1826, y: 406, w: 86, h: 110, lx: 1856, ly: 436, lw: 26, lh: 50 },
  play: { x: 1610, y: 384, w: 142, h: 150, lx: 1658, ly: 432, lw: 46, lh: 54 },
  sound: { x: 790, y: 762, w: 100, h: 92, lx: 814, ly: 786, lw: 52, lh: 44 },
  exit: { x: 870, y: 372, w: 126, h: 122, lx: 898, ly: 400, lw: 70, lh: 66 },
  // 6th rock, below the ice (chat bubble icon) — see scripts/bake_chat_rock.py
  // for provenance ("Arena V2 chat BAL work.xcf", cross-checked x2 against
  // this same file's own copies of the play/sound rocks above).
  chat: { x: 1420, y: 1402, w: 86, h: 78, lx: 1436, ly: 1416, lw: 54, lh: 50 },
};

// Replay bar icons (see CLAUDE.md replay section) — plain inline SVG rather
// than emoji glyphs, same convention as index.html's #connectBtn icon:
// currentColor fill/stroke so each button's own CSS color applies, and a
// fixed viewBox so they center reliably inside their round buttons instead
// of an emoji's inconsistent per-font metrics.
const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="6,4 20,12 6,20" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>`;
const ICON_SOUND_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9 L8 9 L13 4 L13 20 L8 15 L4 15 Z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M16 9a4.2 4.2 0 0 1 0 6"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M18.5 6.5a7.8 7.8 0 0 1 0 11"/></svg>`;
const ICON_SOUND_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9 L8 9 L13 4 L13 20 L8 15 L4 15 Z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M16 8l5 8M21 8l-5 8"/></svg>`;

// Awaited by main.js before the branded #loadingOverlay lifts, so the first
// match's opening frame never draws with sprites still mid-download (the
// symptom this was added to fix — startGame() below loads every one of these
// again itself since it re-creates fresh Image objects per match, but by
// then the browser's HTTP cache makes that instant). Mirrors the asset list
// startGame() loads below minus the per-address identicon bakes, which
// aren't static files. Keep this list in sync if those loads change.
//
// `mobile`: preload the cropped ARENA_FRAME_MOBILE_SRC instead of the full
// ARENA_FRAME_SRC — main.js already knows IS_MOBILE synchronously before
// calling this, so there's no reason to pay for the desktop-sized download
// on a phone that's about to load the small variant anyway in startGame().
export function preloadCoreAssets(mobile = false) {
  const urls = [
    LIGHT_LAYER_SRC,
    mobile ? ARENA_FRAME_MOBILE_SRC : ARENA_FRAME_SRC,
    BALL_SRC,
    ...Object.keys(ROCK_GLOW).flatMap((id) => [`${ASSET_BASE}rocks/${id}-flou.webp`, `${ASSET_BASE}rocks/${id}-light.webp`]),
    `${ASSET_BASE}rocks/chat-badge.webp`,
    ...['A', 'B'].flatMap((team) => ['0', '1', '2', '3'].map((d) => `${ASSET_BASE}score-digits/${team}-${d}.png`)),
    `${ASSET_BASE}hex-timer/ring-full.png`,
    `${ASSET_BASE}hex-timer/ring-full-red.png`,
    `${ASSET_BASE}waiting-label/word.png`,
    ...[0, 1, 2].map((i) => `${ASSET_BASE}waiting-label/dot-${i}.png`),
    `${ASSET_BASE}handoff/ice-mask.webp`,
    ...['A', 'B'].flatMap((team) => LED_STATE_KEYS.map((key) => LED_STATE_SRC[team][key])),
  ];
  // Also warms the default-address identicon bust canvases (see
  // tryBakeBubble/getIdenticonCanvasStoneBust below) — @nimiq/identicons
  // lazy-fetches its own shape/color SVG spritesheet on its very first call
  // per page load, which otherwise landed right at match start and showed as
  // flat-color "unicolor" stones (drawFallbackBubble) for a second or two
  // until tryBakeBubble had something to bake. Both caches this warms
  // (identicons.js's canvasCache/stoneBustCanvasCache) are module-level and
  // address-keyed, so startGame() below hits them for free as long as it
  // ends up using these same default addresses — a real Hub-connected
  // address picked later still pays its own (much smaller, spritesheet
  // already warm) first-render cost. Errors swallowed here since a failed
  // warm-up shouldn't be fatal — startGame() just retries the real fetch itself.
  const identiconWarmup = Promise.all([
    getIdenticonCanvasStoneBust(DEFAULT_IDENTICON_ADDRESS.A),
    getIdenticonCanvasStoneBust(DEFAULT_IDENTICON_ADDRESS.B),
  ]).catch(() => {});
  return Promise.all([loadImages(urls), preloadTicketAssets(), identiconWarmup]);
}

export function startGame(opts = {}) {
  const { net = null, myTeam = null, aiTeam = null, aiConfig = {}, identiconAddress = {}, identiconLabel = {}, replayPoints = null, mobile = false, onRockSound = null, onRockExit = null, onRockPower = null, onExit = null, onChangeSettings = null, matchConfig: rawMatchConfig = null, vibe = 'hockey', howTo = false } = opts;
  // Centralized match rules (see src/matchConfig.js) — Classic is just this
  // default preset; Custom is the same shape with different values. Every
  // caller not yet wired to the Classic/Custom flow (vs AI, replay) simply
  // omits `matchConfig` and gets Classic. Sanitized here (not trusted from
  // opts as-is) since it may come back out of localStorage or off the wire
  // (Remote Match's creator-sent config, see net.js/party/arbiter.js).
  // howTo (see the "How To" tutorial block near the bottom of this closure):
  // always a single stone on the default (Classic) skin, whatever matchConfig
  // opts.js might otherwise have passed — the tutorial isn't reachable from
  // any config screen, so overriding here instead of upstream keeps every
  // other caller untouched.
  const matchConfig = howTo ? sanitizeMatchConfig({ stonesPerTeam: 1 }) : sanitizeMatchConfig(rawMatchConfig || DEFAULT_MATCH_CONFIG);
  // Replay mode: replayPoints is an array of previously-recorded points (see
  // src/recorder.js + src/replay.js) — one if opened from a single-point QR
  // link, several if assembled from an uploaded ticket. Mutually exclusive
  // with `net`/`aiTeam`, both of which are live-input modes; replay instead
  // auto-feeds recorded shots through the exact same aim->pending->sim path
  // (see beginAimPhase/maybeAdvanceReplay below), so physics/rendering/goal
  // detection are all the same code as a live match.
  const isReplay = Array.isArray(replayPoints) && replayPoints.length > 0;
  const replayAllPoints = isReplay ? replayPoints : [];
  let replayCursor = { pointIdx: 0, mancheIdx: 0 };
  let replayPlaying = false;
  // Set by onGoal() the instant a point (not the whole replay) finishes,
  // consumed by beginAimPhase() once the repositioning animation is done and
  // the next point's first manche is about to actually launch — see the
  // comment on this flag's use site in onGoal for why the advance itself is
  // deferred that long.
  let replayPointAdvancePending = false;
  const AI_CONFIG = { ...DEFAULT_AI_CONFIG, ...aiConfig };
  const IDENTICON_ADDRESS = { ...DEFAULT_IDENTICON_ADDRESS, ...identiconAddress };
  // Handle/"Guest" override for whichever team maps to this device's own
  // connected identity (see main.js's identityLabelOverride, mirrors
  // identiconOverride above) — absent entirely for the opponent/AI team, or
  // for a connected-but-handle-less address, so the +1 goal panel falls back
  // to formatAddressShort(IDENTICON_ADDRESS[team]) below in both those cases.
  const IDENTICON_LABEL = { ...identiconLabel };
  function formatAddressShort(address) {
    return address.length <= 8 ? address : `${address.slice(0, 3)}…${address.slice(-3)}`;
  }
  const canvas = document.getElementById('stage');
  // Guards against startGame() ever running twice on the same canvas (e.g. a
  // stray reconnect/reload race) — canvas.width/height below are reflected
  // HTML attributes, so a second pass would read back the *already*
  // dpr-scaled size and scale it again, compounding on every call. The
  // backing buffer keeps growing while the CSS-displayed box stays the same
  // size, so the drawn scene ends up squeezed into a shrinking corner of it —
  // this is the exact "everything renders tiny" bug. Bailing out here makes
  // sizing idempotent regardless of what triggers a second call.
  if (canvas.dataset.nbStarted === 'true') {
    console.warn('[game] startGame() called again on an already-started canvas — ignoring.');
    return;
  }
  canvas.dataset.nbStarted = 'true';
  // Teardown plumbing for returning to mode-select without a page reload (see
  // stopGame() near the end of this closure, returned to the caller so
  // main.js can invoke it on "Quitter"/logo-menu/replay-exit/post-match
  // "Menu"). `signal` is threaded through every addEventListener call in this
  // closure so a single abort() removes all of them regardless of how many
  // there are — the previous approach (relying on a full location.reload())
  // never needed this because the whole page, listeners included, was
  // discarded every time; avoiding that reload is the whole point here, so
  // this closure now has to clean up after itself. gameTimeouts/rafId cover
  // the two other things a reload used to do for free: in-flight
  // setTimeout()s and the requestAnimationFrame loop.
  let torn = false;
  const abortController = new AbortController();
  const { signal } = abortController;
  let rafId = null;
  const gameTimeouts = [];
  function trackedTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    gameTimeouts.push(id);
    return id;
  }
  const ctx = canvas.getContext('2d');
  // Logical coordinate system used throughout this file (physics bounds,
  // getPointerPos, all drawing) stays 3312x1896 regardless of screen density —
  // matches index.html's <canvas width="3312" height="1896"> (the V2 arena
  // art's own native size after the fal.ai upscale, see ART_V2_SCALE above).
  // Read as fixed constants, not from canvas.width/height (which the dpr
  // scaling below mutates in place, so re-reading them would compound on
  // every call).
  const W = 3312, H = 1896;
  // The canvas's actual backing buffer is upsized to devicePixelRatio (capped
  // at 2 — Pixi/Phaser's standard tradeoff, since the per-frame shadow blur in
  // drawContactShadow scales with pixel count) and ctx.scale()'d once so every
  // existing drawImage/fillRect/arc call keeps working unmodified.
  // Mobile gets a higher cap than desktop: on mobile the canvas's own CSS
  // box (#stage-wrap.stage-wrap-detached, reparented in main.js at load —
  // see its comment there and in style.css) is grown to ~205% of
  // #game-card's width — a
  // real box size, not a CSS `transform: scale()` of a small one (that used
  // to be how this zoom worked; it rasterized the canvas at its small
  // pre-zoom size and blew the bitmap up, which read as soft on mobile GPUs
  // regardless of backing-buffer size). Since the box is genuinely bigger
  // now, it needs genuinely more backing-buffer resolution to stay crisp
  // than desktop's card-filling default — the 2 cap (vs desktop's 1.3)
  // keeps comfortable headroom above 1x there without paying for a full
  // uncapped devicePixelRatio (3 on many phones) that the perf audit ruled
  // out.
  // A #qualityBtn toggle (localStorage 'nb-quality', reload-to-apply) used to
  // let a player switch this and two other spots (LASER_FAKE_GLOW below,
  // the atmosphere.draw/update calls near the main loop) between this eco
  // default and a heavier "high" look (dpr capped at 2 instead of 1.3 here,
  // real ctx.shadowBlur on the laser, board dust particles on). Retired —
  // eco felt enough better that there was no reason to keep the heavier path
  // around as a live option — but if it's ever wanted back, that's the full
  // list of what it touched.
  // TEST (see mobile aim-laser lag conversation): mobile cap dropped from 2
  // to 1.3, matching desktop, to check whether the smoothed aim laser
  // (smoothLaserAim, frame-based not time-based) catches up faster once
  // mobile has fewer pixels to redraw per frame. Softer on mobile's bigger
  // CSS box than the reasoning above originally called for — revert to
  // `mobile ? 2 : 1.3` if the crispness loss isn't worth it.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.3);
  // Mobile-only pre-crop (see "crop tool" conversation): the CSS zoom below
  // (.stage-wrap-detached in style.css) only ever shows a sub-window of the
  // full 3312x1896 art — on any device shape, the outer #game-card
  // viewport-overflow clip can only narrow that further, never widen it, so
  // this rect is a generous, device-shape-independent superset of what's
  // ever actually visible on mobile. Everything outside it is guaranteed
  // dead weight: full physics/entities/HUD math still runs in the real
  // W x H logical space below (untouched — LAN determinism depends on that
  // staying identical across devices), but the backing buffer itself is
  // sized to just this rect instead of the full canvas, and ctx.translate
  // shifts drawing into it — so the GPU never has to rasterize/composite
  // the ~54% of the scene that CSS would've clipped away anyway. Desktop is
  // unaffected (cropW/cropH just fall back to the full W/H).
  const MOBILE_CROP = { x0: 793, y0: 286, x1: 3010, y1: 1580 };
  const cropW = mobile ? MOBILE_CROP.x1 - MOBILE_CROP.x0 : W;
  const cropH = mobile ? MOBILE_CROP.y1 - MOBILE_CROP.y0 : H;
  canvas.width = cropW * dpr;
  canvas.height = cropH * dpr;
  ctx.scale(dpr, dpr);
  if (mobile) ctx.translate(-MOBILE_CROP.x0, -MOBILE_CROP.y0);

  // ---------- Audio ----------
  // Shared singleton (src/audio.js) — loading, muting, and ambience are all
  // driven from main.js so they persist across mode switches; this closure
  // only ever calls audio.play()/unlock() for in-match SFX.

  // ---------- Identicons ----------
  // Official identicons (src/identicons.js, @nimiq/identicons) render straight
  // to a canvas with no matte behind them, so unlike the old static PNGs they
  // need no background-stripping step before going into downscaleToFit.
  // Shrinks in halving steps (each a properly box-filtered average) rather than
  // one big jump, which is what drawImage's own bilinear scaler does when asked
  // to shrink an image a lot in one go — that undersamples the diagonal hex
  // edge and left a dotted light fringe. Baking the result at the exact size
  // it's drawn at means the per-frame draw is ~1:1 with no further resampling.
  function downscaleToFit(src, targetW, targetH) {
    let cur = src, cw = src.width, ch = src.height;
    while (cw > targetW * 2 && ch > targetH * 2) {
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
      const step = document.createElement('canvas');
      step.width = nw; step.height = nh;
      const sctx = step.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(cur, 0, 0, nw, nh);
      cur = step; cw = nw; ch = nh;
    }
    const out = document.createElement('canvas');
    out.width = targetW; out.height = targetH;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(cur, 0, 0, targetW, targetH);
    return out;
  }
  // Hex glass window on the stone art (stone-navy/gold.webp, 500x500,
  // baked by scripts/bake_stones.py from the "big stone" render — a bigger
  // window than the original navy/gold pair, see conversation) — a real
  // cut-out window, not a solid embossed floor like the old bubble-v4 art,
  // so the identicon needs to be drawn UNDER it eventually; for now it's
  // clipped to the same hex and drawn on top, inset slightly from the
  // window's true edge (measured visually against the art) since the
  // painted hex isn't a mathematically perfect polygon and a same-size mask
  // let content bleed onto the wood at the corners. Pointy-top orientation
  // (vertex at top/bottom), matching the art — the old bubble-v4 hex was
  // flat-top.
  const HEX = { cxFrac: 0.5, cyFrac: 0.512, halfWFrac: 0.2512, halfHFrac: 0.29 };
  function hexPath(hctx, cx, cy, halfW, halfH) {
    hctx.beginPath();
    hctx.moveTo(cx, cy - halfH);
    hctx.lineTo(cx + halfW, cy - halfH / 2);
    hctx.lineTo(cx + halfW, cy + halfH / 2);
    hctx.lineTo(cx, cy + halfH);
    hctx.lineTo(cx - halfW, cy + halfH / 2);
    hctx.lineTo(cx - halfW, cy - halfH / 2);
    hctx.closePath();
  }

  const identiconSources = {};
  const identiconBgColors = {};
  const moduleImages = {};
  const bubbleSprites = {};
  // Glass-window treatment applied to the identicon only (not the wood rim
  // around it) before it's clipped into the hex — desaturate + reduce
  // contrast so it reads as sitting behind glass instead of pasted on top,
  // then a cool tint in soft-light so it picks up the same cold cast as the
  // rest of the scene. Values ported 1:1 from the local compositing test
  // validated in conversation (desaturate/contrast/tint tuned by eye against
  // the actual stone art, not arbitrary defaults).
  const IDENTICON_GLASS = { desaturate: 0.55, contrast: 0.82, tintColor: '#b8e7ff', tintOpacity: 0.30 };
  // Bakes the stone art + identicon into one sprite, at the given on-screen
  // diameter (2x-oversampled, same convention as ballSprite).
  function bakeBubble(mod, id, diameterPx, bgColor) {
    const S = Math.round(diameterPx * 2);
    const cx = S * HEX.cxFrac, cy = S * HEX.cyFrac;
    const halfW = S * HEX.halfWFrac, halfH = S * HEX.halfHFrac;

    const sizedModule = downscaleToFit(mod, S, S);

    const fit = Math.max(halfW * 2, halfH * 2) * 1.05;
    const scale = fit / Math.max(id.width, id.height);
    const dw = Math.round(id.width * scale), dh = Math.round(id.height * scale);
    const sizedIdenticon = downscaleToFit(id, dw, dh);

    const glass = document.createElement('canvas');
    glass.width = dw; glass.height = dh;
    const gctx = glass.getContext('2d');
    gctx.filter = `saturate(${1 - IDENTICON_GLASS.desaturate}) contrast(${IDENTICON_GLASS.contrast})`;
    gctx.drawImage(sizedIdenticon, 0, 0);
    gctx.filter = 'none';
    gctx.globalCompositeOperation = 'soft-light';
    gctx.globalAlpha = IDENTICON_GLASS.tintOpacity;
    gctx.fillStyle = IDENTICON_GLASS.tintColor;
    gctx.fillRect(0, 0, dw, dh);
    // re-mask to the identicon's own silhouette — soft-light + globalAlpha
    // would otherwise tint the fully-transparent margin too (its alpha goes
    // from 0 to globalAlpha under normal source-over compositing).
    gctx.globalAlpha = 1;
    gctx.globalCompositeOperation = 'destination-in';
    gctx.drawImage(sizedIdenticon, 0, 0);

    const bubble = document.createElement('canvas');
    bubble.width = S; bubble.height = S;
    const bctx = bubble.getContext('2d');
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(sizedModule, 0, 0);
    bctx.save();
    hexPath(bctx, cx, cy, halfW, halfH);
    bctx.clip();
    // Floor of the hex window: the player's own identicon background color
    // (stripped out of the bust canvas — see getIdenticonBgColor) run through
    // the same desaturate/contrast/tint pass as IDENTICON_GLASS below, so it
    // reads as part of the same "behind glass" surface instead of a flat
    // sticker color sitting under the character. Falls back to whatever the
    // stone art (sizedModule) already drew there if the color never resolved.
    if (bgColor) {
      bctx.filter = `saturate(${1 - IDENTICON_GLASS.desaturate}) contrast(${IDENTICON_GLASS.contrast})`;
      bctx.fillStyle = bgColor;
      bctx.fillRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2);
      bctx.filter = 'none';
      bctx.globalCompositeOperation = 'soft-light';
      bctx.globalAlpha = IDENTICON_GLASS.tintOpacity;
      bctx.fillStyle = IDENTICON_GLASS.tintColor;
      bctx.fillRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2);
      bctx.globalAlpha = 1;
      bctx.globalCompositeOperation = 'source-over';
    }
    bctx.drawImage(glass, cx - dw / 2, cy - dh / 2);
    bctx.restore();
    return bubble;
  }
  // Manual per-pixel desaturation (same luminance-preserving matrix CSS/SVG's
  // saturate() filter uses) instead of a live ctx.filter — that silently
  // no-ops in some mobile in-app WebViews (see conversation: Nimiq Pay's dead
  // stones never greyed out on phone even though the physics/hits state was
  // correct). Baked once here, during the same load-time pass that already
  // bakes every LED-state sprite, so drawStone() only ever needs a plain
  // drawImage() to show it — see the 'dead' sprite in tryBakeBubble below.
  // lighten (0..1): after desaturating, lerp toward white by this fraction —
  // the navy/gold source art is fairly dark, so a pure luminance-matched grey
  // reads much darker than the "light grey" dead look this is meant to match
  // (see conversation: a first pass with lighten=0 came out too dark/somber).
  function desaturateSprite(src, amount, lighten = 0) {
    const w = src.width, h = src.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.drawImage(src, 0, 0);
    const imgData = octx.getImageData(0, 0, w, h);
    const px = imgData.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const gray = 0.213 * r + 0.715 * g + 0.072 * b;
      px[i] = gray + amount * (r - gray);
      px[i + 1] = gray + amount * (g - gray);
      px[i + 2] = gray + amount * (b - gray);
      if (lighten > 0) {
        px[i] += (255 - px[i]) * lighten;
        px[i + 1] += (255 - px[i + 1]) * lighten;
        px[i + 2] += (255 - px[i + 2]) * lighten;
      }
    }
    octx.putImageData(imgData, 0, 0);
    return out;
  }
  // Bakes one composited sprite per LED state once the identicon AND every
  // one of that team's 6 state images have loaded — module ring + identicon
  // + LEDs all end up in the same pre-baked bitmap, so drawStone() never
  // does more than 1-2 plain drawImage() calls per frame regardless of
  // damage state (see conversation — this replaced a live shadowBlur redraw
  // of the LEDs every frame). The extra 'dead' sprite (LEDs-at-zero art,
  // desaturated) is what a killed stone crossfades to — see DEAD_SATURATION
  // and drawStone.
  function tryBakeBubble(team) {
    const id = identiconSources[team];
    const imgs = moduleImages[team];
    if (!id || !imgs) return;
    for (const key of LED_STATE_KEYS) if (!imgs[key]) return;
    bubbleSprites[team] = {};
    for (const key of LED_STATE_KEYS) bubbleSprites[team][key] = bakeBubble(imgs[key], id, STONE_R * 2, identiconBgColors[team]);
    bubbleSprites[team].dead = desaturateSprite(bubbleSprites[team]['0'], DEAD_SATURATION, DEAD_LIGHTEN);
  }
  for (const team of ['A', 'B']) {
    Promise.all([
      getIdenticonCanvasStoneBust(IDENTICON_ADDRESS[team]),
      getIdenticonBgColor(IDENTICON_ADDRESS[team]),
    ]).then(([canvas, bgColor]) => {
      let source = canvas;
      // team B starts on the right side of the pitch, so mirror it to face the
      // ball at kickoff instead of away from it
      if (team === 'B') {
        const flipped = document.createElement('canvas');
        flipped.width = source.width; flipped.height = source.height;
        const fctx = flipped.getContext('2d');
        fctx.translate(flipped.width, 0);
        fctx.scale(-1, 1);
        fctx.drawImage(source, 0, 0);
        source = flipped;
      }
      identiconBgColors[team] = bgColor;
      identiconSources[team] = source;
      tryBakeBubble(team);
    });

    moduleImages[team] = {};
    for (const key of LED_STATE_KEYS) {
      const modImg = new Image();
      modImg.onload = () => { moduleImages[team][key] = modImg; tryBakeBubble(team); };
      modImg.src = LED_STATE_SRC[team][key];
    }
  }

  // Mobile loads the pre-cropped ARENA_FRAME_MOBILE_SRC instead of the full
  // arena art (see its comment above and MOBILE_CROP below) — same pixels,
  // ~57% less to download/decode for the sub-rect mobile ever shows.
  const arenaFrameImage = new Image();
  arenaFrameImage.src = vibe === 'curling'
    ? (matchConfig.skin === 'winter'
      ? (mobile ? ARENA_FRAME_CURLING_WINTER_MOBILE_SRC : ARENA_FRAME_CURLING_WINTER_SRC)
      : (mobile ? ARENA_FRAME_CURLING_MOBILE_SRC : ARENA_FRAME_CURLING_SRC))
    : matchConfig.skin === 'winter'
      ? (mobile ? ARENA_FRAME_WINTER_MOBILE_SRC : ARENA_FRAME_WINTER_SRC)
      : (mobile ? ARENA_FRAME_MOBILE_SRC : ARENA_FRAME_SRC);

  // Ball sprite, baked at 2x its on-screen diameter: the ball rotates every
  // frame so it never sits on a 1:1 pixel grid anyway, and downsampling a 2x
  // source at draw time keeps the rotated edges crisp.
  let ballSprite = null;
  const ballImg = new Image();
  ballImg.onload = () => {
    const s = Math.round(BALL_R * 4);
    ballSprite = downscaleToFit(ballImg, s, s);
  };
  ballImg.src = BALL_SRC;

  // Shared specular decal (two soft highlight arcs, top-left + bottom-right —
  // the same source art the user supplied) — reused as-is for both teams'
  // stones despite their slightly different source crop heights (see
  // stone-navy vs stone-gold in bake_stones.py): it's drawn stretched to each
  // stone's own on-screen diameter at runtime (see drawStoneLightLayer), so a
  // few percent of vertical stretch on navy is imperceptible on a soft decal
  // like this one.
  let lightLayerSprite = null;
  const lightLayerImg = new Image();
  lightLayerImg.onload = () => {
    const s = Math.round(STONE_R * 4);
    lightLayerSprite = downscaleToFit(lightLayerImg, s, s);
  };
  lightLayerImg.src = LIGHT_LAYER_SRC;

  // HUD rock glow sprites (see ROCK_GLOW above) — loaded as plain <img>
  // pairs (flou + light) per rock, drawn at native size each frame by
  // drawRockGlow below, no baking needed since they're small and static.
  const rockGlowImages = {};
  for (const id in ROCK_GLOW) {
    const flou = new Image(); flou.src = `${ASSET_BASE}rocks/${id}-flou.webp`;
    const light = new Image(); light.src = `${ASSET_BASE}rocks/${id}-light.webp`;
    rockGlowImages[id] = { flou, light };
  }
  // Unread-message badge (see scripts/bake_chat_rock.py) — drawn on top of
  // the chat rock's corner by drawChatBadge below, desktop only.
  const chatBadgeImage = new Image();
  chatBadgeImage.src = `${ASSET_BASE}rocks/chat-badge.webp`;

  // Under-ice score digits (see drawUnderIceScore below) — pre-baked per
  // team+digit by scripts/bake_score_digits.py, which merges the hand-
  // exported glyph (design/0123.png -> scripts/crop_score_digits.py ->
  // design/score-digits/{0,1,2,3}.png) with the real ice pixels at the exact
  // spot they're drawn, "Assombrir"/darken + 42% opacity blended in linear-
  // light RGB (see that script's docstring for why: canvas's own
  // globalCompositeOperation can't do the opacity mix in linear light, only
  // gamma space, which read visibly darker/flatter than the GIMP source this
  // mimics). Each PNG is a fully opaque square (ice + digit already merged)
  // meant to be stamped as-is, not composited. Only 0-2 ever actually get
  // drawn live (WIN_SCORE=3 ends the match), 3 is here too since it was
  // baked anyway.
  // Curling: separate set baked at a different position (outside the
  // circular timer ring instead of flanking the hexagon, see
  // scripts/bake_curling_arena.py) — same folder, "curling-" prefixed files.
  const scoreDigitImages = { A: {}, B: {} };
  for (const team of ['A', 'B']) {
    for (const d of ['0', '1', '2', '3']) {
      const img = new Image();
      img.src = vibe === 'curling' ? `${ASSET_BASE}score-digits/curling-${team}-${d}.png` : `${ASSET_BASE}score-digits/${team}-${d}.png`;
      scoreDigitImages[team][d] = img;
    }
  }
  // Under-ice hex turn-timer ring (see drawHexTimer below) — pre-baked once
  // by scripts/bake_hex_timer.py, same technique as scoreDigitImages above.
  // The red variant (last 1/6 of the turn — see HEX_TIMER_RED_FRACTION) is a
  // second bake from the same script, glyph color = BALL_LASER_RED.
  const hexTimerRingImage = new Image();
  hexTimerRingImage.src = `${ASSET_BASE}hex-timer/ring-full.png`;
  const hexTimerRingRedImage = new Image();
  hexTimerRingRedImage.src = `${ASSET_BASE}hex-timer/ring-full-red.png`;
  // Under-ice "waiting…" label (see drawWaitingLabel below) — pre-baked once
  // by scripts/bake_waiting_label.py, same technique as hexTimerRingImage
  // above (real alpha, so the 3 dots can be faded in/out live).
  const waitingWordImage = new Image();
  waitingWordImage.src = `${ASSET_BASE}waiting-label/word.png`;
  const waitingDotImages = [0, 1, 2].map(i => {
    const img = new Image(); img.src = `${ASSET_BASE}waiting-label/dot-${i}.png`;
    return img;
  });
  // Pass & Play hand-off mask (see drawHandoffMask below) — a blurred,
  // white-blended crop of the real ice (public/arena/frame.webp), pre-baked
  // by scripts/bake_handoff_mask.py so it's guaranteed pixel-aligned with
  // FX0..FY1 (see that script's docstring for why it crops the shipped art
  // rather than compositing design/arena/xcf-terrain.png, the pre-lines
  // layer, which lives in a different/older coordinate space).
  const handoffMaskImage = new Image();
  handoffMaskImage.src = `${ASSET_BASE}handoff/ice-mask.webp`;
  // Click-driven state per rock:
  // - sound: no flash, pure state sync (see drawRockGlow) to audio.isMuted()
  // - ice: sweep[team].rockClicked (see triggerSweep) — lit by default each
  //   round, dark after the first click, until the round resets
  // - exit/play/laser/chat: always lit at baseline, with a brief dip-then-
  //   recover flicker on click (flashAt = timestamp, consumed in drawRockGlow)
  const rockFlash = { exit: -Infinity, play: -Infinity, chat: -Infinity };
  const ROCK_FLASH_MS = 260; // within the 200-300ms asked for
  function flashRock(id) { rockFlash[id] = performance.now(); }

  // ---------- Config ----------
  // Field bounds match the illustrated arena (light-blue Nimiq accents),
  // scaled from the reference art — the pitch bounds match where the ice
  // actually sits in that artwork. The center line/hexagon/goal circles are
  // baked into frame.webp, re-centered on this same CENTER_X/CY at the image
  // level so the ball spawn always lands exactly on the hexagon's core.
  // re-measured directly against frame.webp (1200x905, 1:1 with canvas) — was
  // FX0=169, FY0=234, FX1=1032, FY1=714; FY0 landed exactly on the ice edge
  // already, the other three left a visible gap before the true rail
  // (worst on FY1, ~11px short). CENTER_X/CY below shift by ~5-6px off the
  // hexagon baked into the art as a result — small enough to be within the
  // hexagon's own footprint, revisit if it reads as off-center.
  // FY0/FY1/FX1 absorbed the laser's eye-tuned fudges (+3/+4/+4) and those
  // fudges were then deleted below — laser and physics now share one source
  // of truth. Was FX0=159, FY0=234, FX1=1042, FY1=725; revert to those if this
  // reads worse than the split laser/physics bounds did.
  // FY0/FY1/GY0/GY1 recentered vertically — the field/goal were art-matched
  // (see history above) but that left them measurably off-center in the
  // 1200x905 canvas: top/bottom margins were 237/176px (61px apart) and the
  // goal sat 143px above / 181px below the field's own midpoint (38px apart).
  // The upcoming arena redesign targets these physics bounds directly rather
  // than the other way around, so centered now: FX0/FX1 untouched (already
  // near-symmetric, 159/154px), FY0/FY1 keep the same field height (492px)
  // but split the canvas margin evenly (206/207px), and GY0/GY1 keep the same
  // goal height (168px) centered on the new field midpoint. Was FX0=159,
  // FY0=237, FX1=1046, FY1=729, GY0=380, GY1=548.
  // ---- V2 arena art geometry (design-lab-validated — see conversation) ----
  // Hand-traced against design/generated/arena V2/chat summer.png (the
  // "Physics limit"/"bar zone" xcf layers), then scaled ×2 to match the
  // fal.ai clarity-upscaler pass baked into public/arena/frame.webp
  // (3312x1896, up from the 1659x948 the trace was measured on — see
  // ART_V2_SCALE below for the separate, unrelated scale that rebases every
  // OTHER spatial constant in this file from the pre-V2 shipped canvas).
  // FX0/FX1/FY0/FY1 are the flat wall (post) positions — NOT simply the
  // ice's own visual bounding box, which is misleading here: the art has a
  // real recessed notch at each goal mouth (NOTCH_X0/X1 below), so the ice
  // visually extends further than the true collision wall at that specific
  // y-range. Verified by scanning the ice mask row-by-row (see conversation)
  // rather than trusting a single global bounding box.
  const FX0 = 1086, FY0 = 626, FX1 = 2262, FY1 = 1274;
  const GY0 = 826, GY1 = 1074;                 // goal mouth y-range — also the vertical extent of the goal-mouth recess/bar zone below
  const NOTCH_X0 = 1050, NOTCH_X1 = 2298;      // the wall's recessed depth at the goal mouth (a real notch in the art, not an open gap)
  const CHAMFER_X = 110, CHAMFER_Y = 108;      // corner cut size (uniform across all 4 corners, see conversation)
  // Goal-bar collision zones — hand-traced ("bar zone" xcf layer), touching
  // it kills a stone (same dead/falling path as an 8th hit, see
  // registerStoneHit) or scores a goal for the ball. Supersedes the old
  // STONE_LOSS_FRACTION/BALL_GOAL_FRACTION area-crossing heuristic — the new
  // art has an actual physical bar object to hit instead of an abstract line.
  const BAR_LEFT = { x0: 1040, y0: 828, x1: 1052, y1: 1070 };
  const BAR_RIGHT = { x0: 2296, y0: 832, x1: 2308, y1: 1074 };
  // The 5 HUD rocks baked into the art (replace the old round toolbar — see
  // main.js/style.css), hit-tested in canvas space by onPointerDown below.
  // Coordinates are the "flou <name>" glow-halo layer offsets/sizes from
  // Arena V2 chat.xcf (design-lab's arena-v2-hud-buttons.html prototype),
  // ×2 for the fal.ai upscale baked into the current frame.webp. "ice"/"play"
  // call straight into game.js's own triggerSweep/triggerPlay (need live
  // phase/entities state); "sound"/"exit"/"power" call back out to main.js
  // via the onRock* callbacks above, since main.js owns that logic.
  const ROCK_ZONES = {
    ice: { x0: 1432, y0: 396, x1: 1548, y1: 516 },
    laser: { x0: 1826, y0: 406, x1: 1912, y1: 516 },
    play: { x0: 1610, y0: 384, x1: 1752, y1: 534 },
    sound: { x0: 790, y0: 762, x1: 890, y1: 854 },
    exit: { x0: 870, y0: 372, x1: 996, y1: 494 },
    chat: { x0: 1420, y0: 1402, x1: 1506, y1: 1480 },
  };
  function rockZoneAt(pos) {
    for (const id in ROCK_ZONES) {
      const z = ROCK_ZONES[id];
      if (pos.x >= z.x0 && pos.x <= z.x1 && pos.y >= z.y0 && pos.y <= z.y1) return id;
    }
    return null;
  }
  const CY = (FY0 + FY1) / 2;
  const CENTER_X = (FX0 + FX1) / 2;           // pitch's true horizontal center — ball spawn and score readout share this axis
  const GOAL_HALF_HEIGHT = (GY1 - GY0) / 2;

  // Rescales every OTHER spatial constant below (stone/ball size, drag
  // reach, speeds, sweep radius, intro stack spacing...) from the pre-V2
  // shipped canvas (1200x905, field width 887 = 1046-159) to the new one
  // (3312x1896, field width 1176 = FX1-FX0 above) — keeps their feel
  // proportional to the arena instead of shrinking/growing relative to it.
  // Applied to distances AND velocities/speeds together (not just
  // distances) so a shot still crosses the same FRACTION of the field in
  // the same number of frames — see conversation for the reasoning.
  const ART_V2_SCALE = 1176 / 887;

  const SCALE = 1200 / 900;                   // physics scaled up vs the original 900-wide prototype
  const STONE_R = 38 * 0.9 * ART_V2_SCALE * 0.9; // shrunk another 10% per feedback (was 38), rescaled for the V2 art (see ART_V2_SCALE), then another -10% per feedback
  const BALL_R = STONE_R / 2 * 0.9 * 0.9;       // half a stone's diameter, shrunk 10% twice more (~15.4 pre-V2), rendered as the puck sprite
  const STONE_MASS = 2.4;
  const BALL_MASS = 1.0;                        // was 0.55 (4.4:1) — narrowed ratio so stones bleed more speed on ball contact, feel test
  // Pace/bounce constants calibrated against frame-tracked Globulos footage
  // (foot 2 arena): launches glide about half the field width, impacts are
  // plain billiard exchanges with no added energy — puck/curling feel.
  // Per-frame decay factors, not spatial — unaffected by ART_V2_SCALE (see
  // its own comment: distances AND speeds scale together, so the number of
  // frames a shot takes to decay stays the same regardless of art scale).
  const FRICTION = 0.9868;                     // was 0.9852 — +12% glide distance, feel test
  const BALL_FRICTION = 0.9809;                // was 0.9786 — +12% glide distance, feel test; puck still bleeds speed a bit faster than the players (also true in Globulos)
  const WALL_RESTITUTION = 0.87;               // was 0.85 — livelier wall bounce, feel test (0.90 tried, too much)
  const BODY_RESTITUTION = 1.0;
  const BOUNCE_BOOST = 1.0;                   // >1 re-adds the old arcade kick on impacts
  const MAX_DRAG = 130 * SCALE * ART_V2_SCALE; // ~173 pre-V2
  const POWER_SCALE = 0.054;                   // unitless px-of-drag -> px/frame-of-velocity ratio — both scale together under ART_V2_SCALE, so this stays as-is (see its comment above)
  // Mobile only (see `mobile` opt): how a touch on a stone is told apart from
  // one meant to reach the joystick. A short tap (released before either
  // threshold trips) selects the stone for the joystick instead of arming a
  // shot; holding past LONG_PRESS_MS, or moving past TAP_MOVE_THRESHOLD
  // first, promotes straight into the same direct-drag gesture desktop uses
  // (see beginDrag/pendingTap below) — no separate mobile drag math needed.
  const LONG_PRESS_MS = 280;
  const TAP_MOVE_THRESHOLD = 10 * SCALE * ART_V2_SCALE;
  const DRAG_TICK_STEP = 8 * SCALE * ART_V2_SCALE; // px of drag distance between each dragTick retrigger, see onPointerMove
  const MAX_SPEED = 8 * ART_V2_SCALE;
  const STOP_THRESHOLD = 0.08 * ART_V2_SCALE;
  const WIN_SCORE = matchConfig.pointsToWin;
  // Stone "damage": each impact against an opposing-team stone counts one hit
  // toward STONE_MAX_HITS (8 — 2 hits per LED, see STONE_HITS_PER_LED below).
  // LEDs/ring quadrants go out one at a time, top first then clockwise (see
  // LED_RECTS order). On the last hit the stone dies (no longer selectable to
  // aim) and, once it finishes sliding from that final impact, plays the same
  // shrink-into-the-void animation as a goal loss (see the g.dead check in
  // physicsStep) — it keeps colliding/sliding normally right up until then.
  // Curling: 4 HP instead of 8, 1 hit per LED instead of 2 (per explicit
  // request) — the critical "last life" blink already triggers purely off
  // `hits === STONE_MAX_HITS - 1`, so this alone is enough to get it right
  // for curling too, no separate threshold to track.
  const STONE_MAX_HITS = vibe === 'curling' ? 4 : 8;
  const STONE_HITS_PER_LED = vibe === 'curling' ? 1 : 2; // hits needed to knock out each of the 4 LEDs/quadrants
  // debounce so a single prolonged/grazing contact (spanning several physics
  // frames) only ever counts as one hit — see registerStoneHit in resolveCollision
  const HIT_COOLDOWN_FRAMES = 20;
  const DEAD_SATURATION = 0.1;                 // 1 - 0.9: dead stones desaturate 90%
  const DEAD_LIGHTEN = 0.35;                   // lerp toward white after desaturating — see desaturateSprite

  const PW = FX1 - FX0, PH = FY1 - FY0;
  // Curling: target dead center of the ice (CENTER_X/CY, where the hexagon
  // sits) + its own timer ring — geometry must match
  // scripts/bake_curling_arena.py's own TARGET_DIAM_FRAC/RING_MARGIN_PX
  // exactly, the ring is baked directly into the arena art at these numbers.
  const CURLING_TARGET_DIAM = 0.432 * PW;
  const CURLING_TARGET_R = CURLING_TARGET_DIAM / 2;
  const CIRCLE_TIMER_MARGIN = 26;
  const CIRCLE_TIMER_R = CURLING_TARGET_R + CIRCLE_TIMER_MARGIN;
  // Always the same 3 hand-measured rack slots regardless of matchConfig —
  // never recomputed/re-spaced for fewer stones (see conversation: slot 1 is
  // the center spot, 0/2 are the two outer ones). ACTIVE_STONE_SLOTS below
  // picks which of these 3 indices actually get a stone; every other place
  // that indexes into startPositions[team] (beginRoundReset,
  // matchIntroHuddlePos, etc.) already does so by a stone's own id-encoded
  // slot number, not by array position, so this array itself never needs to
  // shrink/re-index (see resetPositions below for where slots become stones).
  const startPositions = {
    A: [{ x: FX0 + 0.16 * PW, y: FY0 + 0.267 * PH }, { x: FX0 + 0.13 * PW, y: FY0 + 0.5 * PH }, { x: FX0 + 0.16 * PW, y: FY0 + 0.733 * PH }],
    B: [{ x: FX1 - 0.16 * PW, y: FY0 + 0.267 * PH }, { x: FX1 - 0.13 * PW, y: FY0 + 0.5 * PH }, { x: FX1 - 0.16 * PW, y: FY0 + 0.733 * PH }],
  };
  const ACTIVE_STONE_SLOTS = STONE_SLOTS_BY_COUNT[matchConfig.stonesPerTeam] || STONE_SLOTS_BY_COUNT[3];

  // Match-start intro (see beginMatchIntro further below): both teams' 3
  // stones start stacked vertically right in front of their own goal —
  // same x, centered on CY, spaced just enough apart to not overlap — then
  // slide out to their real rack spot. Shared by beginMatchIntro() and, for
  // local pass-and-play, the very first resetPositions() call below (so the
  // ready-tap screen already shows the stack, not the spread rack).
  const MATCH_INTRO_START_INSET = 65 * ART_V2_SCALE;  // stack's distance from the wall, right in front of the goal mouth
  const MATCH_INTRO_STACK_GAP = 4 * ART_V2_SCALE;     // gap between adjacent stones' edges, so they touch without overlapping
  // beginMatchIntro()'s own slide duration — declared up here (not next to
  // beginMatchIntro() itself, further below) since aiTeam/net's own entry
  // branches call beginMatchIntro() synchronously earlier in this same
  // top-to-bottom closure than that function is defined; a `const` declared
  // down there would still be in its temporal dead zone at that call time
  // (see matchIntroStart above for the same reasoning/bug, hit for real).
  const MATCH_INTRO_MOVE_MS = 1500;
  function matchIntroHuddlePos(team, idx) {
    const x = team === 'A' ? FX0 + MATCH_INTRO_START_INSET : FX1 - MATCH_INTRO_START_INSET;
    const spacing = 2 * STONE_R + MATCH_INTRO_STACK_GAP;
    return { x, y: CY + (idx - 1) * spacing };
  }

  // "Balai" (curling-style sweep): one placeable-then-removable slippery ice
  // patch per team per round (see beginRoundReset for the `used` reset), a
  // circle (not the originally-floated hexagon — simpler math, no rotation/
  // in-polygon test). Purely cosmetic/tunable numbers, adjust freely by feel —
  // was a pitch-relative formula (fifth, then two-fifths of the shorter pitch
  // dimension), now a flat px value per feedback.
  const SWEEP_R = 130 * ART_V2_SCALE;
  // Above 1 the friction multiplier itself exceeds 1 (withSweepBoost's
  // (1-SWEEP_FRICTION_BONUS) factor goes negative), so this isn't "less
  // friction" anymore but active acceleration: anything inside ramps up to
  // MAX_SPEED and holds there (the existing clamp in physicsStep/
  // stepGhostBodies still applies) instead of just decaying slower.
  const SWEEP_FRICTION_BONUS = 1.1; // was ...0.8, 1, then 1.2 — 110%: accelerates rather than just gliding, tune by feel

  // Baked once (a soft white/ice radial falloff, 2x-oversampled like
  // ballSprite above) rather than recomputing a gradient every frame — a
  // brightening wash meant to read as thinner/glassier ice, not a flat
  // sticker. Drawn with 'soft-light' (see drawSweepZone), not 'lighten' —
  // 'lighten' just maxes toward the source color, so a high-alpha center
  // washed out the ice art's own scratch/grain texture underneath it;
  // 'soft-light' modulates off the existing pixel instead of overriding it,
  // keeping the grain/grooves visible through the patch.
  const sweepSprite = document.createElement('canvas');
  (function bakeSweepSprite() {
    const S = Math.round(SWEEP_R * 4);
    sweepSprite.width = S; sweepSprite.height = S;
    const sctx = sweepSprite.getContext('2d');
    const cx = S / 2, cy = S / 2, r = S / 2;
    const grad = sctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.97)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.72)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    sctx.fillStyle = grad;
    sctx.beginPath(); sctx.arc(cx, cy, r, 0, Math.PI * 2); sctx.fill();
    // Thin rim so the patch's own boundary reads clearly even where the
    // fill above is faint — inset slightly from the sprite's own edge so the
    // stroke isn't itself clipped/aliased against the canvas boundary.
    sctx.strokeStyle = 'rgba(255,255,255,0.75)';
    sctx.lineWidth = Math.max(1, S * 0.006);
    sctx.beginPath(); sctx.arc(cx, cy, r * 0.94, 0, Math.PI * 2); sctx.stroke();
  })();
  // Appear animation: "givre qui cristallise" (scale-in with a slight
  // overshoot, like the patch pops into frost) + "reflet" (a dim band
  // sweeping left-to-right across it, echoing the broom motion itself).
  // Driven off sw.appearedAt, stamped by updateSweepAppear below the instant
  // .active flips false->true — covers manual placement (sweepBtn), replay/
  // LAN reveal, and re-placement after a toggle-off, all from one spot
  // instead of stamping at every call site that sets .active.
  const SWEEP_APPEAR_MS = 380;
  // Shine runs on its own, longer clock than the scale-in (slower/subtler
  // per feedback — smaller, dimmer, and not tied to the pop's own timing).
  const SWEEP_SHINE_MS = 480;
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  function updateSweepAppear(sw) {
    if (sw.active && !sw._wasActive) sw.appearedAt = performance.now();
    sw._wasActive = sw.active;
  }
  // Clipped to the ice rect so a patch placed near an edge has its overflow
  // cropped away instead of spilling onto the wood frame art — cosmetic only,
  // physics itself never needs cropping (the in-circle test in
  // physicsStep/stepGhostBodies already only ever looks at whichever part of
  // the pitch entities can actually occupy).
  function drawSweepZone(sw) {
    const t = Math.min(1, (performance.now() - sw.appearedAt) / SWEEP_APPEAR_MS);
    ctx.save();
    ctx.beginPath();
    ctx.rect(FX0, FY0, FX1 - FX0, FY1 - FY0);
    ctx.clip();
    ctx.globalCompositeOperation = 'soft-light';
    const d = sw.r * 2;
    if (t < 1) {
      const dd = d * Math.max(0, easeOutBack(t));
      ctx.drawImage(sweepSprite, sw.x - dd / 2, sw.y - dd / 2, dd, dd);
    } else {
      ctx.drawImage(sweepSprite, sw.x - sw.r, sw.y - sw.r, d, d);
    }
    ctx.restore();
    const shineT = (performance.now() - sw.appearedAt) / SWEEP_SHINE_MS;
    if (shineT < 1) drawSweepShine(sw, Math.max(0, shineT));
  }
  // The reflet itself: a dim vertical band, clipped to the patch's own
  // circle (plus the ice rect, same as drawSweepZone), translated from just
  // past the left edge to just past the right edge over its own (slower)
  // window — mirrors the broom's natural left-to-right stroke. 'screen'
  // rather than 'soft-light' here — this is meant to read as a faint glint
  // of light passing over the ice, not a wash blended into it.
  function drawSweepShine(sw, t) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(FX0, FY0, FX1 - FX0, FY1 - FY0);
    ctx.clip();
    const bandW = sw.r * 0.6;
    // t=0: band sits just past the left edge; t=1: just past the right edge.
    const travel = sw.r * 2 + bandW * 2;
    const bandCx = (sw.x - sw.r - bandW) + t * travel;
    const grad = ctx.createLinearGradient(bandCx - bandW / 2, 0, bandCx + bandW / 2, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.fillRect(sw.x - sw.r - bandW, sw.y - sw.r - bandW, sw.r * 2 + bandW * 2, sw.r * 2 + bandW * 2);
    ctx.restore();
  }
  // Own patch while still being placed/dragged (pre-commit) is visible only
  // on the owning team's own screen (sweepViewTeam) — same phases the aim
  // laser itself stays visible through, so it vanishes at the same moment.
  // Once committed, both patches are drawn during 'sim'/'goal' regardless of
  // sweepViewTeam: the shared "reveal" moment both players see together.
  // updateSweepAppear runs unconditionally on both, every frame, regardless
  // of which (if either) actually gets drawn below — it only needs to see
  // the active->true edge once to stamp appearedAt, not be drawn itself.
  function drawSweepOverlay() {
    updateSweepAppear(sweep.A);
    updateSweepAppear(sweep.B);
    const ownTeam = sweepViewTeam();
    if (ownTeam && sweep[ownTeam].active && !sweep[ownTeam].committed) drawSweepZone(sweep[ownTeam]);
    if (phase === 'sim' || phase === 'goal') {
      if (sweep.A.committed) drawSweepZone(sweep.A);
      if (sweep.B.committed) drawSweepZone(sweep.B);
    }
  }

  // "Hand-off" screen (Pass & Play local mode only, see beginAimPhase/
  // onValidate): a mask hides the ice between aim phases so the other player
  // can't see it while the device is passed over, and once more before the
  // shared reveal. Visually the same family as the sweep patch above (a
  // white ice sprite + a light-band "shine" sweeping across), just covering
  // the whole rink instead of one circle, and drawn fully opaque (source-
  // over, not soft-light) since this has to hide the board, not tint it.
  // handoff.stage: 'in' (mask fading in, shine playing) -> 'shown' (fully
  // opaque, label up, waiting for a tap anywhere) -> 'out' (mask fading out,
  // shine playing again) -> null once completeHandoff() applies the real
  // phase transition it was deferring.
  let handoff = null;
  const HANDOFF_IN_MS = 550;
  const HANDOFF_OUT_MS = 550;
  // Same chamfered-octagon shape the physics CORNERS array above collides
  // against — traces the real ice boundary (not the FX0..FY1 bounding rect),
  // with the two flat side walls detouring out to NOTCH_X0/NOTCH_X1 across
  // the goal-mouth y-range (GY0..GY1) so the mask also covers the ice inside
  // each goal recess, right up to the black bar (per feedback: the physical
  // ice extends that far, not just to FX0/FX1) — GY0..GY1 sits entirely
  // within each flat wall segment (clear of the corner chamfers), so this
  // stays one simple, non-self-intersecting polygon.
  //
  // Built once as a Path2D (FX0/FY0/etc are fixed for the whole match)
  // instead of retraced via ctx.beginPath()/lineTo every frame the mask is
  // visible — drawHandoffMask/drawHandoffShine both clip to this same
  // object via ctx.clip(path) rather than rebuilding + ctx.clip() each time.
  const HANDOFF_MASK_PATH = new Path2D();
  HANDOFF_MASK_PATH.moveTo(FX0 + CHAMFER_X, FY0);
  HANDOFF_MASK_PATH.lineTo(FX1 - CHAMFER_X, FY0);
  HANDOFF_MASK_PATH.lineTo(FX1, FY0 + CHAMFER_Y);
  HANDOFF_MASK_PATH.lineTo(FX1, GY0);
  HANDOFF_MASK_PATH.lineTo(NOTCH_X1, GY0);
  HANDOFF_MASK_PATH.lineTo(NOTCH_X1, GY1);
  HANDOFF_MASK_PATH.lineTo(FX1, GY1);
  HANDOFF_MASK_PATH.lineTo(FX1, FY1 - CHAMFER_Y);
  HANDOFF_MASK_PATH.lineTo(FX1 - CHAMFER_X, FY1);
  HANDOFF_MASK_PATH.lineTo(FX0 + CHAMFER_X, FY1);
  HANDOFF_MASK_PATH.lineTo(FX0, FY1 - CHAMFER_Y);
  HANDOFF_MASK_PATH.lineTo(FX0, GY1);
  HANDOFF_MASK_PATH.lineTo(NOTCH_X0, GY1);
  HANDOFF_MASK_PATH.lineTo(NOTCH_X0, GY0);
  HANDOFF_MASK_PATH.lineTo(FX0, GY0);
  HANDOFF_MASK_PATH.lineTo(FX0, FY0 + CHAMFER_Y);
  HANDOFF_MASK_PATH.closePath();
  // Same left-to-right glint idea as drawSweepShine, stretched across the
  // whole rink instead of one patch's circle.
  function drawHandoffShine(t) {
    ctx.save();
    ctx.clip(HANDOFF_MASK_PATH);
    const bandW = (FX1 - FX0) * 0.35;
    const travel = (FX1 - FX0) + bandW * 2;
    const bandCx = (FX0 - bandW) + t * travel;
    const grad = ctx.createLinearGradient(bandCx - bandW / 2, 0, bandCx + bandW / 2, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.fillRect(FX0 - bandW, FY0, (FX1 - FX0) + bandW * 2, FY1 - FY0);
    ctx.restore();
  }
  // Label text is plain canvas fillText, unlike the rest of this file's UI
  // text (baked PNG glyphs, see CLAUDE.md) — placeholder styling, same spirit
  // as the LED stone-damage feature: mechanic ships now, art pass later.
  const HANDOFF_LABEL = { handoffA: 'BLUE TEAM PLAY', handoffB: 'YELLOW TEAM PLAY', handoffWatch: 'WATCH' };
  function drawHandoffLabel(alpha) {
    const label = HANDOFF_LABEL[phase];
    if (!label) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Same flat grey as the score digit/hex-timer glyphs (GLYPH_RGB in
    // scripts/bake_hex_timer.py) at partial opacity, per feedback — reads
    // closer to the ice's own baked line art than a solid dark-ink label.
    ctx.fillStyle = '#626262';
    ctx.globalAlpha = alpha * 0.55;
    ctx.font = "700 56px 'Mulish', -apple-system, sans-serif";
    ctx.fillText(label, CENTER_X, CY - 14);
    ctx.globalAlpha = alpha * 0.45;
    ctx.font = "600 24px 'Mulish', -apple-system, sans-serif";
    ctx.fillText('Touchez pour continuer', CENTER_X, CY + 48);
    ctx.restore();
  }
  function drawHandoffMask() {
    if (!handoff) return;
    if (!handoffMaskImage.complete || !handoffMaskImage.naturalWidth) return;
    const elapsed = performance.now() - handoff.stageStart;
    let maskAlpha = 1, shineT = null;
    if (handoff.stage === 'in') {
      shineT = Math.min(1, elapsed / HANDOFF_IN_MS);
      maskAlpha = shineT;
    } else if (handoff.stage === 'out') {
      shineT = Math.min(1, elapsed / HANDOFF_OUT_MS);
      maskAlpha = 1 - shineT;
    }
    ctx.save();
    ctx.clip(HANDOFF_MASK_PATH);
    ctx.globalAlpha = maskAlpha;
    // Baked wider than FX0..FX1 on purpose (NOTCH_X0..NOTCH_X1, see
    // scripts/bake_handoff_mask.py) to cover the goal-notch detours above —
    // the clip above discards whatever of that width falls outside the
    // actual mask shape (the wood corners at each notch's far edges).
    ctx.drawImage(handoffMaskImage, NOTCH_X0, FY0, NOTCH_X1 - NOTCH_X0, FY1 - FY0);
    ctx.restore();
    if (shineT !== null) drawHandoffShine(shineT);
    drawHandoffLabel(maskAlpha);
  }
  // Chat mask background: the same full-rink ice-mask texture/shape as the
  // Pass & Play handoff above, toggled by toggleChatMask instead of the
  // handoff state machine — plain instant show/hide, no in/out fade (the
  // handoff's fade exists to sell "the other player can't peek", which
  // doesn't apply here; a follow-up can add one for polish). The DOM chat
  // thread/compose bar (#chatMask, reparented over this same canvas box by
  // main.js) paint on top of this for the actual text.
  function drawChatMaskBg() {
    if (!chatMaskOpen) return;
    if (!handoffMaskImage.complete || !handoffMaskImage.naturalWidth) return;
    ctx.save();
    ctx.clip(HANDOFF_MASK_PATH);
    ctx.drawImage(handoffMaskImage, NOTCH_X0, FY0, NOTCH_X1 - NOTCH_X0, FY1 - FY0);
    ctx.restore();
  }
  // Kicks off the 'in' stage; completeHandoff() (see onValidate/beginAimPhase)
  // applies whatever real phase transition was deferred once 'out' finishes.
  // skipWhistle only matters for the handoffA->aimA leg (see beginAimPhase's
  // fromMatchIntro case, where the match-start SFX already covers this cue).
  function startHandoff(skipWhistle = false) {
    handoff = { stage: 'in', stageStart: performance.now(), skipWhistle };
  }
  function updateHandoff() {
    if (!handoff) return;
    const elapsed = performance.now() - handoff.stageStart;
    if (handoff.stage === 'in' && elapsed >= HANDOFF_IN_MS) {
      handoff.stage = 'shown';
    } else if (handoff.stage === 'out' && elapsed >= HANDOFF_OUT_MS) {
      completeHandoff();
    }
  }
  function completeHandoff() {
    if (phase === 'handoffA') {
      phase = 'aimA';
      if (!handoff.skipWhistle) audio.play('whistle', { volume: 0.78 }); // was 0.6, +30%
    } else if (phase === 'handoffB') {
      phase = 'aimB';
    } else if (phase === 'handoffWatch') {
      phase = 'pending';
      // No team arg here on purpose (see playLaunchEngine's own retractTeam
      // param): team B's laser was never visible under the mask, so there's
      // nothing to visibly "retract" once it lifts — per feedback, still
      // play the launch cue, just skip the retract animation for this leg.
      playLaunchEngine();
      scheduleGlideLeadIn(PRE_SIM_DELAY);
      trackedTimeout(launchSimulation, PRE_SIM_DELAY);
    }
    handoff = null;
  }

  let scoreA = 0, scoreB = 0;
  let round = 1;
  // Curling only: a point is 2 full aimA/aimB/reveal cycles (not "however
  // many until a goal/wipeout", like classic) — bumped in beginStraighten()
  // each time a manche settles without a goalResult, reset to 0 in
  // beginRoundReset() (a new point starting). See resolveCurlingPoint below.
  const CURLING_CYCLES_PER_POINT = 2;
  let curlingCycle = 0;
  // Match-ticket stats (see src/ticket.js) — not gameplay state, just tallies
  // for the shareable end-of-match ticket. Reset alongside score/round on Rejouer.
  let matchStartTime = performance.now();
  let totalCollisions = 0;
  let bestShotSpeed = 0;
  let stonesDestroyed = 0;
  // Which entity's glide whoosh (see audio.js's GLIDE_* — single voice only)
  // gets to sound for the round currently in flight: since every stone
  // launches on the same physics frame, picked once at launchSimulation()
  // time as whichever stone has the fastest launch speed, rather than
  // whichever entity happens to iterate first in physicsStep()'s loop. Null
  // when nothing launched with any speed this round (or before the first
  // round starts) — physicsStep() then just skips calling setGlide() entirely.
  let glideLeaderId = null;
  // Which team's aim laser/halo is mid-retract right now, and when that
  // retraction started — set by playLaunchEngine(team) at the exact moment
  // the reveal begins (see LASER_RETRACT_MS/laserRetractProgress below).
  // null/0 means "not retracting" (render()/haloMode fall back to their
  // normal phase-gated visibility).
  let retractTeam = null;
  let retractStart = 0;
  preloadTicketAssets();
  let phase = 'start';
  // Visual-only 30s turn timer for the score panel LED bar — resets whenever aiming
  // starts for either team, has no effect on the phase state machine (see turnTimerProgress).
  const TURN_TIMER_MS = matchConfig.turnTime * 1000;
  let turnTimerStart = 0;
  let turnTimerPhase = null;
  // beginMatchIntro()'s own animation clock + done-flag (see that function,
  // defined further below near beginRoundReset) — declared up here since
  // they're read by call sites that run earlier in this closure than that
  // definition. matchIntroAnimDone guards updateMatchIntro() against being
  // re-entered after it already finalized (its own safety-net setTimeout
  // fires again while phase is still 'matchIntro', which is the normal case
  // here since aiming only unlocks once the matchStart clip ends, later than
  // the tween itself) — without the guard, a second finalize pass reads its
  // own already-cleared _resetFromX/_resetToX fields, i.e. undefined
  // arithmetic, and every stone silently goes to NaN,NaN (invisible).
  let matchIntroStart = 0;
  let matchIntroAnimDone = false;
  let entities = { A: [], B: [], ball: null };
  // Network sync-check (see CLAUDE.md determinism work / net.onLaunch below,
  // computeMancheResult above). mancheValidated defaults true so local/AI/
  // replay matches (no `net`) never gate on it. mancheStartSnapshot is what a
  // 'mancheInvalid' rolls back to; currentMancheIndex is the arbiter-issued
  // id the eventual mancheValid/mancheInvalid must match to apply (a late
  // verdict for an already-superseded manche is ignored). pendingMancheAdvance
  // holds whichever "go to the next aim phase" call (beginAimPhase, either
  // direct for a plain manche or via maybeAdvanceRound for a scored one) is
  // waiting on validation — see tryAdvanceAfterManche.
  let mancheValidated = true;
  let mancheStartSnapshot = null;
  let currentMancheIndex = null;
  let pendingMancheAdvance = null;
  // Net dead-end watchdog (see onValidate's 'lanWait' branch / net.onLaunch /
  // net.onDisconnect below): there's no ping/pong on either arbiter, so a
  // silently dropped connection (wifi cut, no clean close frame ever sent)
  // never fires net.onDisconnect at all — the local player would just sit on
  // 'lanWait' forever with nothing telling them the match is over. Started
  // the moment our own shots go out and we start waiting on the opponent's;
  // cleared the moment that wait actually resolves, one way or another
  // (onLaunch = they answered, onDisconnect = we got a real close signal
  // instead). If neither happens within LAN_WAIT_TIMEOUT_MS, that silence
  // itself is treated as the disconnect.
  const LAN_WAIT_TIMEOUT_MS = 120000;
  let lanWaitWatchdogId = null;
  function clearLanWaitWatchdog() {
    if (lanWaitWatchdogId !== null) { clearTimeout(lanWaitWatchdogId); lanWaitWatchdogId = null; }
  }
  // Shown only if validation is still pending SYNC_WAIT_INDICATOR_MS after
  // the local animation itself already reached this gate — in normal LAN
  // conditions the arbiter's verdict arrives within milliseconds of launch
  // (see computeMancheResult), so this should be a rare, real-network-hiccup
  // indicator, not a routine one. syncWaitTimerActive just guards against
  // scheduling a redundant timer if tryAdvanceAfterManche is called more than
  // once for the same still-unvalidated manche (e.g. maybeAdvanceRound firing
  // from both the slide animation and the goal panel dismiss).
  const SYNC_WAIT_INDICATOR_MS = 1500;
  let syncWaitTimerActive = false;
  function tryAdvanceAfterManche(advanceFn) {
    if (mancheValidated) { pendingMancheAdvance = null; advanceFn(); return; }
    pendingMancheAdvance = advanceFn;
    if (!syncWaitTimerActive) {
      syncWaitTimerActive = true;
      trackedTimeout(() => {
        syncWaitTimerActive = false;
        if (!mancheValidated) showSyncWaiting();
      }, SYNC_WAIT_INDICATOR_MS);
    }
  }
  let drag = null;
  // Mobile only: the stone a tap has selected (see LONG_PRESS_MS above) —
  // the joystick's own drag reads/writes into this instead of whatever the
  // pointer happens to be over, since the joystick itself never sits on top
  // of a stone. pendingTap holds a touch that landed on a stone but hasn't
  // yet resolved into either a tap-select or a promoted drag.
  let selectedStone = null;
  let pendingTap = null;
  let joystickDrag = null;
  let readyA = false, readyB = false;
  // sweep.<team>.active: currently placed (visible only to that team while
  // aiming, or during 'sim' as the shared reveal — see sweepViewTeam/render).
  // .committed: this placement was locked in for the sim that's about to run
  // (or is running) — cleared again in beginAimPhase once that sim is over,
  // since the effect is a one-shot boost for the single exchange it was
  // played into, not a standing fixture for the rest of the round. .used:
  // this team's one placement for the round has been spent — persists across
  // exchanges until beginRoundReset (see CLAUDE.md: a "round"/manche can span
  // many aimA/aimB/sim cycles, only ending on a goal/wipeout).
  // appearedAt/_wasActive: appear-animation bookkeeping for drawSweepZone,
  // stamped by updateSweepAppear (see comment above that function). -Infinity
  // so a patch that's never been (re)placed this session reads as long past
  // its animation window rather than NaN.
  let sweep = {
    // rockClicked: drives the "ice" HUD rock's glow (see ROCK_GLOW/render
    // below) — lit by default each round, goes dark the first time this
    // team clicks the rock and stays dark until the same round-reset points
    // that clear `used` below bring it back.
    A: { active: false, committed: false, used: false, rockClicked: false, x: CENTER_X, y: CY, r: SWEEP_R, appearedAt: -Infinity, _wasActive: false },
    B: { active: false, committed: false, used: false, rockClicked: false, x: CENTER_X, y: CY, r: SWEEP_R, appearedAt: -Infinity, _wasActive: false },
  };
  let sweepDrag = null;
  // LAN mode: both teams aim simultaneously ('lanAim'), each client only
  // controls entities[myTeam]; 'lanWait' shows once the local shot is sent,
  // until the arbiter relays both sides' shots (see src/net.js).
  function isAimingPhase(p) { return p === 'aimA' || p === 'aimB' || p === 'lanAim'; }
  function firstAimPhase() { return net ? 'lanAim' : 'aimA'; }
  // Which team can currently drag stones/their own sweep patch — null once
  // committed (lanWait/pending/sim/etc.), unlike sweepViewTeam below which
  // stays truthy a bit longer purely for rendering continuity.
  function aimingTeam() {
    if (net) return phase === 'lanAim' ? myTeam : null;
    if (phase === 'aimA') return 'A';
    if (phase === 'aimB') return 'B';
    return null;
  }
  // Same idea, but stays truthy through 'lanWait' too (own screen only, shot
  // already sent) — mirrors exactly which phases renderAimCascade's own laser
  // stays visible through, so the sweep patch disappears at the same moment
  // the laser does.
  function sweepViewTeam() {
    if (net) return (phase === 'lanAim' || phase === 'lanWait') ? myTeam : null;
    return aimingTeam();
  }
  // Solo vs IA: the AI's shots for the coming turn are computed the instant
  // the board re-enters an aiming phase, using only the just-settled,
  // confirmed positions — never the human's in-progress drag (see the
  // "blind resolution" rule in the design brief) — so by the time the human
  // presses PLAY the AI's move is already decided and just needs applying
  // (see onValidate). Its own laser trajectory is never rendered either way:
  // render() only calls renderAimCascade() for the human's own aiming team.
  function beginAimPhase(fromMatchIntro = false) {
    // Retire whichever patch(es) were committed into the sim that just
    // finished — the effect and its shared reveal were only ever meant for
    // that one exchange (see the comment on the `sweep` state above); `used`
    // is untouched here, it only clears on a real round reset.
    sweep.A.active = false; sweep.A.committed = false;
    sweep.B.active = false; sweep.B.committed = false;
    if (isReplay) {
      // This is the actual "point N+1 starts here" moment (see onGoal) —
      // the repositioning animation that just finished belonged to the
      // previous point's own scoring beat, not to this one.
      if (replayPointAdvancePending) {
        replayPointAdvancePending = false;
        replayCursor.pointIdx++; replayCursor.mancheIdx = 0;
        renderReplaySegments();
      }
      phase = 'replayAim';
      maybeAdvanceReplay();
      return;
    }
    // howTo: single stone, no opponent, no hand-off mask ever — every "round"
    // (each tutorial step's own shot) goes straight back into 'aimA'. See the
    // "How To" tutorial block below for what actually drives the player
    // through this repeatedly.
    if (howTo) {
      phase = 'aimA';
      turnTimerStart = performance.now();
      turnTimerPhase = phase;
      onHowToAimPhase();
      return;
    }
    // Pass & Play (two humans sharing one screen, no net/aiTeam): mask the
    // ice before either team's aim starts — see startHandoff/completeHandoff
    // above. The whistle/turn-timer-start that used to happen right here now
    // fire once the mask actually lifts into 'aimA', not at this point.
    if (!net && !aiTeam) {
      phase = 'handoffA';
      startHandoff(fromMatchIntro);
      return;
    }
    // Whistle cues every turn timer about to start, except the match's very
    // first one — that moment already has its own "match start" SFX (see
    // beginMatchIntro) and doesn't need a second cue stacked on top.
    if (!fromMatchIntro) audio.play('whistle', { volume: 0.78 }); // was 0.6, +30%
    phase = firstAimPhase();
    // Reset the turn timer right here instead of waiting for loop()'s own
    // "phase !== turnTimerPhase" catch-up (further below): beginMatchIntro
    // reaches this via the 'matchStart' audio clip's onEnded callback, which
    // fires outside the requestAnimationFrame loop entirely. Without this,
    // the very next frame's 30s-expiry check (aiTeam && phase === 'aimA')
    // would see the new phase but a stale/zeroed turnTimerStart — measured
    // against performance.now(), which by match-intro time is already well
    // past 30000ms — and immediately auto-submit the human's still-empty
    // shot, firing only the AI's precomputed move before the player ever
    // gets to drag a stone.
    turnTimerStart = performance.now();
    turnTimerPhase = phase;
    if (aiTeam) prepareAiShots();
  }
  // ---------- Replay playback (auto-feeds recorded shots, see src/recorder.js
  // and src/replay.js) ----------
  // 'replayAim' is deliberately excluded from isAimingPhase()'s list — no
  // human drag ever applies here, both teams' shots are already decided.
  // Pausing only holds back the *next* manche from auto-starting; a shot
  // already mid-flight (phase 'sim') always finishes normally, same as the
  // "scrubber snaps to point boundaries, not mid-shot" call made for the UI.
  function maybeAdvanceReplay() {
    if (phase !== 'replayAim' || !replayPlaying) return;
    const point = replayAllPoints[replayCursor.pointIdx];
    const manche = point && point.manches[replayCursor.mancheIdx];
    if (!manche) { if (phase !== 'gameover') showReplayEndTicket(); return; }
    entities.A.forEach((g, i) => {
      const s = manche.stonesA[i];
      g.pendingVx = s ? s.vx : 0; g.pendingVy = s ? s.vy : 0; g.used = !!(s && s.used);
    });
    entities.B.forEach((g, i) => {
      const s = manche.stonesB[i];
      g.pendingVx = s ? s.vx : 0; g.pendingVy = s ? s.vy : 0; g.used = !!(s && s.used);
    });
    if (manche.sweepA) { sweep.A.active = true; sweep.A.committed = true; sweep.A.used = true; sweep.A.x = manche.sweepA.x; sweep.A.y = manche.sweepA.y; sweep.A.r = manche.sweepA.r; }
    if (manche.sweepB) { sweep.B.active = true; sweep.B.committed = true; sweep.B.used = true; sweep.B.x = manche.sweepB.x; sweep.B.y = manche.sweepB.y; sweep.B.r = manche.sweepB.r; }
    // replayCursor.mancheIdx is NOT bumped here — it stays pointing at the
    // manche that's actually playing right now (aim → pending → sim →
    // settle), so the segment bar shows the right one lit for that manche's
    // entire lifetime. It only advances in beginStraighten(), right as the
    // *next* manche is about to start — see that function's own comment.
    phase = 'pending';
    playLaunchEngine();
    scheduleGlideLeadIn(PRE_SIM_DELAY);
    trackedTimeout(launchSimulation, PRE_SIM_DELAY);
  }
  // Jump straight to the start of a given point (rail thumbnail / segment
  // click) — resets the board to the fixed rack position every point starts
  // from, recomputes the score tally up to (not including) that point purely
  // for display continuity, and resumes auto-play from its first manche.
  function jumpToPoint(pointIdx) { jumpToManche(pointIdx, 0); }
  // Jump to an arbitrary manche within a point (prev/next transport). Unlike
  // a point boundary, a manche doesn't start from a known fixed position —
  // the board is wherever the point's earlier manches left it (only a
  // goal/wipeout resets to the rack) — so getting there means silently
  // fast-forwarding through manches [0, mancheIdx) first (see
  // fastForwardManche), then playing the requested manche normally.
  function jumpToManche(pointIdx, mancheIdx) {
    if (!isReplay || pointIdx < 0 || pointIdx >= replayAllPoints.length) return;
    const point = replayAllPoints[pointIdx];
    if (mancheIdx < 0 || mancheIdx >= point.manches.length) return;
    // A manual jump always fully decides the cursor itself — any pending
    // "advance to the next point" from a goal that just fired (see onGoal)
    // is superseded, not layered on top of it.
    replayPointAdvancePending = false;
    scoreA = 0; scoreB = 0;
    for (let i = 0; i < pointIdx; i++) {
      const p = replayAllPoints[i];
      if (p.scoringTeam === 'A') scoreA++; else scoreB++;
    }
    resetPositions();
    sweep.A.used = false; sweep.B.used = false; sweep.A.rockClicked = false; sweep.B.rockClicked = false;
    for (let m = 0; m < mancheIdx; m++) fastForwardManche(point.manches[m]);
    replayCursor = { pointIdx, mancheIdx };
    hideOverlay();
    renderReplaySegments();
    updateReplayBar();
    beginAimPhase();
  }
  // Applies a manche's recorded shots directly (no pending/aim delay) and
  // runs physicsStep() to completion without rendering — same physics as a
  // normal replay manche, just silent/instant, purely to reconstruct the
  // board state a later manche of the same point depends on.
  function fastForwardManche(manche) {
    entities.A.forEach((g, i) => {
      const s = manche.stonesA[i];
      g.vx = s ? s.vx : 0; g.vy = s ? s.vy : 0; g.pendingVx = 0; g.pendingVy = 0; g.used = !!(s && s.used);
    });
    entities.B.forEach((g, i) => {
      const s = manche.stonesB[i];
      g.vx = s ? s.vx : 0; g.vy = s ? s.vy : 0; g.pendingVx = 0; g.pendingVy = 0; g.used = !!(s && s.used);
    });
    if (manche.sweepA) { sweep.A.active = true; sweep.A.committed = true; sweep.A.used = true; sweep.A.x = manche.sweepA.x; sweep.A.y = manche.sweepA.y; sweep.A.r = manche.sweepA.r; }
    if (manche.sweepB) { sweep.B.active = true; sweep.B.committed = true; sweep.B.used = true; sweep.B.x = manche.sweepB.x; sweep.B.y = manche.sweepB.y; sweep.B.r = manche.sweepB.r; }
    for (let i = 0; i < 4000; i++) {
      // A goal/wipeout shouldn't fire on any manche but a point's last one by
      // definition — bail out early if it somehow does, rather than loop on.
      if (physicsStep()) break;
      if (allSettled()) break;
    }
  }

  // ---------- Replay playback bar (custom, distinct from the arcade toolbar
  // — see CLAUDE.md replay section) ----------
  const replayBar = document.getElementById('replayBar');
  const replayRailEl = document.getElementById('replayRail');
  const replaySegmentsEl = document.getElementById('replaySegments');
  const replaySoundBtn = document.getElementById('replaySoundBtn');
  const replayPlayBtn = document.getElementById('replayPlayBtn');
  const replayPrevBtn = document.getElementById('replayPrevBtn');
  const replayNextBtn = document.getElementById('replayNextBtn');
  const replayExitBtn = document.getElementById('replayExitBtn');

  // Real per-point preview frames (not fake art): fast-forwards each point
  // to its final settled frame (reusing fastForwardManche) and snapshots the
  // actual board at that instant, since the shared match data never carries
  // images itself (see src/replay.js) — cheap to regenerate given how fast
  // fastForwardManche already proved to be. Runs once, before real playback
  // starts, then restores a clean board so the real replay begins from
  // point 1 exactly as if this never happened.
  let replayThumbDataUrls = null;
  function captureThumbnails() {
    if (replayThumbDataUrls) return;
    replayThumbDataUrls = replayAllPoints.map((point) => {
      resetPositions();
      sweep.A.used = false; sweep.B.used = false; sweep.A.rockClicked = false; sweep.B.rockClicked = false;
      point.manches.forEach(fastForwardManche);
      render();
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 220;
      thumbCanvas.height = Math.round(220 * 905 / 1200);
      thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      return thumbCanvas.toDataURL('image/webp', 0.7);
    });
    resetPositions();
    sweep.A.used = false; sweep.B.used = false; sweep.A.rockClicked = false; sweep.B.rockClicked = false;
    scoreA = 0; scoreB = 0;
  }
  function renderReplayRail() {
    if (!isReplay) return;
    replayRailEl.innerHTML = '';
    replayAllPoints.forEach((point, i) => {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'replay-rail-thumb';
      thumb.innerHTML = `
        <img src="${replayThumbDataUrls[i]}" alt="">
        <div class="replay-rail-thumb-meta">
          <span class="replay-rail-thumb-team ${point.scoringTeam === 'A' ? 'a' : 'b'}"></span>
          <span class="replay-rail-thumb-label">Point ${point.index + 1}</span>
          <span class="replay-rail-thumb-icon">${point.isWipeout ? '💥' : '⚽'}</span>
        </div>
      `;
      thumb.addEventListener('click', () => jumpToPoint(i), { signal });
      replayRailEl.appendChild(thumb);
    });
  }
  // One segment per manche of whichever point is currently selected on the
  // rail (not the whole match — points already have their own index there),
  // rebuilt every time the active point changes so the group always matches
  // what's showing. i is a plain manche index within that one point, so
  // updateReplayBar can compare it straight against replayCursor.mancheIdx —
  // no cross-point index math to get subtly wrong.
  function renderReplaySegments() {
    if (!isReplay) return;
    replaySegmentsEl.innerHTML = '';
    const point = replayAllPoints[replayCursor.pointIdx];
    if (!point) return;
    point.manches.forEach((_, mancheIdx) => {
      const seg = document.createElement('div');
      seg.className = 'replay-segment';
      seg.title = `Manche ${mancheIdx + 1}`;
      seg.addEventListener('click', () => jumpToManche(replayCursor.pointIdx, mancheIdx), { signal });
      replaySegmentsEl.appendChild(seg);
    });
  }
  function showReplayBar() {
    if (!isReplay) return;
    captureThumbnails();
    replayBar.classList.remove('hidden');
    renderReplayRail();
    renderReplaySegments();
    updateReplayBar();
  }
  function hideReplayBar() {
    replayBar.classList.add('hidden');
  }
  function updateReplayBar() {
    if (!isReplay) return;
    replayPlayBtn.innerHTML = replayPlaying ? ICON_PAUSE : ICON_PLAY;
    replaySoundBtn.innerHTML = audio.isMuted() ? ICON_SOUND_OFF : ICON_SOUND_ON;
    replaySoundBtn.classList.toggle('muted', audio.isMuted());
    [...replayRailEl.children].forEach((el, i) => el.classList.toggle('current', i === replayCursor.pointIdx));
    [...replaySegmentsEl.children].forEach((el, i) => {
      el.classList.toggle('current', i === replayCursor.mancheIdx);
      el.classList.toggle('done', i < replayCursor.mancheIdx);
    });
  }
  // Shared audio.js instance (see its own header comment) — toggling here
  // also mutes the arcade toolbar's sound state, same as it already would
  // from a live match, since there's only ever one audio singleton.
  // audio.play() is called before setMuted() flips the flag, so pressing
  // "unmute" stays silent (still muted at the moment play() checks) while
  // every other toggle direction/press gets the usual click.
  replaySoundBtn.addEventListener('click', () => {
    audio.play('button');
    audio.setMuted(!audio.isMuted());
    updateReplayBar();
  }, { signal });
  replayPlayBtn.addEventListener('click', () => {
    audio.play('button');
    replayPlaying = !replayPlaying;
    updateReplayBar();
    if (replayPlaying) maybeAdvanceReplay();
  }, { signal });
  // Manche-level transport — crosses point boundaries at either end (last
  // manche of the previous point / first manche of the next one) so it reads
  // as one continuous timeline, not one that resets at every point.
  replayPrevBtn.addEventListener('click', () => {
    audio.play('button');
    const { pointIdx, mancheIdx } = replayCursor;
    if (mancheIdx > 0) { jumpToManche(pointIdx, mancheIdx - 1); return; }
    if (pointIdx > 0) jumpToManche(pointIdx - 1, replayAllPoints[pointIdx - 1].manches.length - 1);
  }, { signal });
  replayNextBtn.addEventListener('click', () => {
    audio.play('button');
    const { pointIdx, mancheIdx } = replayCursor;
    const point = replayAllPoints[pointIdx];
    if (point && mancheIdx < point.manches.length - 1) { jumpToManche(pointIdx, mancheIdx + 1); return; }
    if (pointIdx < replayAllPoints.length - 1) jumpToManche(pointIdx + 1, 0);
  }, { signal });
  // No page navigation (see stopGame()'s own comment) — but a still-present
  // ?replay= param would make a future real page refresh jump straight back
  // into this same replay, so it's stripped from the URL bar in place
  // (history.replaceState, no navigation) rather than left there.
  replayExitBtn.addEventListener('click', () => {
    audio.play('button');
    history.replaceState(null, '', location.pathname);
    stopGame();
    onExit?.();
  }, { signal });
  function prepareAiShots() {
    const opponentTeam = aiTeam === 'A' ? 'B' : 'A';
    const stones = entities[aiTeam].filter(g => !g.out && !g.dead);
    const opponentStones = entities[opponentTeam].filter(g => !g.out && !g.dead);
    const shots = computeAiShots({
      aiTeam,
      aiStones: stones.map(g => ({ id: g.id, x: g.x, y: g.y })),
      opponentStones: opponentStones.map(g => ({ id: g.id, x: g.x, y: g.y })),
      ball: { x: entities.ball.x, y: entities.ball.y },
      bounds: { FX0, FX1, FY0, FY1, GY0, GY1, CY, GOAL_HALF_HEIGHT, MAX_DRAG, POWER_SCALE, STONE_R, BALL_R },
      config: AI_CONFIG,
    });
    stones.forEach(g => {
      const shot = shots[g.id];
      if (!shot) return;
      g._aiVx = shot.vx; g._aiVy = shot.vy;
      // Marks the stone "committed" for the halo pulse below (haloMode), the
      // same visual language a human's own dragged stone gets — it shows a
      // shot is queued, never the trajectory itself.
      g.used = true;
    });
  }

  function makeStone(team, idx, pos) {
    return {
      id: team + idx, team, x: pos.x, y: pos.y, vx: 0, vy: 0, r: STONE_R, mass: STONE_MASS,
      used: false, squish: 0, squishNX: 1, squishNY: 0, squishGain: 1.05, out: false,
      squishPhase: null, squishT: 0, squishPeak: 0,
      falling: false, fallScale: 1, rot: 0, rotVel: 0,
      hits: 0, dead: false, deadMix: 0, _hitCooldown: 0,
    };
  }
  function resetPositions() {
    // Only the active slots (matchConfig.stonesPerTeam) get a stone — each
    // one keeps its real rack-slot number as its id (e.g. team B's single
    // stone at stonesPerTeam=1 is still "B1", the center slot), so every
    // other place that reads a slot back off a stone's id (startPositions
    // lookups, matchIntroHuddlePos) needs no changes at all.
    // howTo: a single stone alone on the ice — no opponent team, no ball
    // (see the "How To" tutorial block below). entities.B stays a real,
    // permanently-empty array rather than being skipped/omitted — every
    // other place in this file already iterates state.B/entities.B with
    // .forEach/.filter/spread, all safe no-ops on an empty array, so no
    // other call site needs its own howTo check just to stay correct.
    entities.A = ACTIVE_STONE_SLOTS.map((slot) => makeStone('A', slot, startPositions.A[slot]));
    entities.B = howTo ? [] : ACTIVE_STONE_SLOTS.map((slot) => makeStone('B', slot, startPositions.B[slot]));
    entities.ball = {
      x: CENTER_X, y: CY, vx: 0, vy: 0, r: BALL_R, mass: BALL_MASS, rot: 0,
      falling: false, fallScale: 1, out: howTo,
    };
  }
  resetPositions();
  // Local pass-and-play only: both teams' stones are already visible on the
  // board during the ready-tap screen (#startOverlay), well before
  // beginMatchIntro() itself runs (see maybeStart()) — stack them in front of
  // their own goal from that very first frame (see matchIntroHuddlePos) so
  // there's no jump into place once both players tap ready. Solo/LAN/replay
  // skip straight past that screen (or, for replay, never show the stack at
  // all — see beginAimPhase's own isReplay branch), so there's no visible
  // gap for them to fix.
  if (!net && !aiTeam && !isReplay && !howTo) {
    for (const g of [...entities.A, ...entities.B]) {
      const idx = parseInt(g.id.slice(1), 10) || 0;
      const p = matchIntroHuddlePos(g.team, idx);
      g.x = p.x; g.y = p.y;
    }
  }
  if (!isReplay) recorder.reset();
  function allEntities() { return [...entities.A, ...entities.B, entities.ball]; }

  // team tint shown for the brief window before the module+identicon sprite has baked
  const FALLBACK_COLOR = { A: '#0582ca', B: '#e0c3a3' };
  function drawFallbackBubble(g) {
    ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
    ctx.fillStyle = FALLBACK_COLOR[g.team]; ctx.fill();
  }

  // ---------- Input ----------
  function getPointerPos(evt) {
    const rect = canvas.getBoundingClientRect();
    // rect covers cropW/cropH worth of logical space on mobile (see the
    // MOBILE_CROP backing-buffer setup above), not the full W/H — scale
    // against that, then shift back into full logical space by the same
    // crop origin ctx.translate offset the draw side uses.
    const scaleX = cropW / rect.width, scaleY = cropH / rect.height;
    const t = evt.touches ? (evt.touches[0] || evt.changedTouches[0]) : evt;
    const offX = mobile ? MOBILE_CROP.x0 : 0, offY = mobile ? MOBILE_CROP.y0 : 0;
    return { x: (t.clientX - rect.left) * scaleX + offX, y: (t.clientY - rect.top) * scaleY + offY };
  }
  function currentTeamStones() {
    const team = aimingTeam();
    return team ? entities[team].filter(g => !g.out && !g.falling && !g.dead) : [];
  }
  function findStoneAt(pos) {
    for (const g of currentTeamStones())
      if (Math.hypot(g.x - pos.x, g.y - pos.y) <= g.r + 12) return g;
    return null;
  }
  // Starts the actual pull gesture on a stone — shared by desktop's immediate
  // pickup-on-touch (onPointerDown below) and both of mobile's two ways in:
  // a promoted long-press (onPointerMove's pendingTap branch) and the
  // joystick's own pointerdown (onJoystickDown), which begins the drag at
  // curX/curY == startX/startY (zero pull) since the stick starts centered.
  function beginDrag(g, curX, curY) {
    g.pendingVx = 0; g.pendingVy = 0;
    // halo/LED "programmed" state (haloMode) starts the instant a stone is
    // picked up, not only once released — releaseDrag still reverts this to
    // false if the drag turns out too short to count as an actual shot.
    g.used = true;
    drag = { entity: g, startX: g.x, startY: g.y, curX, curY, lastTickDist: 0 };
    // Desktop only: hide the mouse pointer itself while dragging, since the
    // laser/stone now stand in for it — restored in releaseDrag. Mobile has
    // no visible cursor to hide (touch-drag and the joystick alike).
    if (!mobile) document.body.style.cursor = 'none';
    audio.play('stoneSelect', { volume: 0.316 }); // -10dB
    // aim-laser loop, runs for the whole drag until releaseDrag's stopLaser() — phase offset
    // syncs its filter sweep to this specific stone's own halo pulse, see pulseStrength()
    const haloIdx = parseInt(g.id.slice(1), 10) || 0;
    audio.startLaser((haloIdx / 3) * HALO_PULSE_PERIOD);
  }
  // Ratchet/"machine-gun" drag feedback: retrigger a short tick every
  // DRAG_TICK_STEP px of pull distance covered, only while stretching further
  // out (never while easing back in, per feedback) — so the tick rate rises
  // and falls with how fast the player is actually pulling without any
  // timer. Shared by the canvas drag (onPointerMove) and the joystick
  // (onJoystickMove), both of which just feed a pull distance in.
  function updateDragTickAudio(dist) {
    audio.setLaserIntensity(dist / MAX_DRAG);
    if (dist < MAX_DRAG) {
      if (dist - drag.lastTickDist >= DRAG_TICK_STEP) {
        drag.lastTickDist = dist;
        audio.play('dragTick', { volume: 0.221, rate: 0.95 + Math.random() * 0.1 }); // was 0.316, -30%
      } else if (dist < drag.lastTickDist) {
        // shortening: track silently so the next stretch resumes ticking
        // right away instead of first re-crossing the old high-water mark
        drag.lastTickDist = dist;
      }
    }
  }
  // Commits whatever the current drag object holds — same finalize path
  // whether that drag came from a direct canvas pull or the joystick.
  function releaseDrag() {
    let dx = drag.curX - drag.startX;
    let dy = drag.curY - drag.startY;
    let dist = Math.hypot(dx, dy);
    if (dist > MAX_DRAG) { const s = MAX_DRAG / dist; dx *= s; dy *= s; dist = MAX_DRAG; }
    const g = drag.entity;
    if (!mobile) document.body.style.cursor = '';
    audio.play('stoneSelect', { volume: 0.316 }); // -10dB, echoes the pickup cue on release too
    audio.stopLaser(); // aim-laser loop ends exactly when the release cue plays, whether or not this drag turns into a shot
    if (dist > 6) {
      g.pendingVx = dx * POWER_SCALE;
      g.pendingVy = dy * POWER_SCALE;
      g.used = true;
      audio.play('shot', { volume: 0.4 + 0.6 * Math.min(1, dist / MAX_DRAG), rate: 0.95 + Math.random() * 0.1 });
    } else {
      g.used = false;
    }
    drag = null;
  }
  function onPointerDown(evt) {
    audio.unlock();
    // howTo's "basic laser" step shows a preset demo shot (see
    // howToStartLaserDemo) rather than something the player aims — nothing
    // to grab/drag here at all while it's up, so this blocks the gesture
    // from ever starting rather than just its later move updates (that's
    // the other, narrower howToAimLocked guard already in onPointerMove).
    if (howToAimLocked) return;
    // Hand-off mask (Pass & Play, see startHandoff/completeHandoff above)
    // swallows all input while up — the whole point is nothing underneath is
    // reachable — and only reacts once fully opaque ('shown'), so a tap
    // can't land mid-fade and double-fire the dismiss.
    if (handoff) {
      if (handoff.stage === 'shown') {
        evt.preventDefault();
        audio.play('button'); // same UI click cue as the PLAY rock (see triggerPlay)
        handoff.stage = 'out';
        handoff.stageStart = performance.now();
      }
      return;
    }
    const pos = getPointerPos(evt);
    // HUD rocks: checked before the isAimingPhase gate below (unlike stone
    // drag/sweep) since sound/exit/laser must stay reachable across every
    // active gameplay phase, matching the old toolbar's own behavior —
    // gated on controlsEnabled instead, same flag that used to drive
    // showToolbar() in main.js.
    if (controlsEnabled) {
      const rockId = rockZoneAt(pos);
      if (rockId) {
        evt.preventDefault();
        if (rockId === 'play') { triggerPlay(); flashRock('play'); }
        else if (rockId === 'ice') triggerSweep();
        else if (rockId === 'sound' && onRockSound) onRockSound();
        else if (rockId === 'exit' && onRockExit) { onRockExit(); flashRock('exit'); }
        else if (rockId === 'laser' && onRockPower) onRockPower();
        else if (rockId === 'chat' && net) { toggleChatMask(); flashRock('chat'); }
        return;
      }
    }
    // Chat mask swallows all other board input while up (same spirit as the
    // handoff mask above) — the rock-zone check above still lets a tap on
    // the chat rock itself close it, since that runs unconditionally before
    // this gate.
    if (chatMaskOpen) return;
    if (!isAimingPhase(phase)) return;
    evt.preventDefault();
    const g = findStoneAt(pos);
    if (g) {
      if (mobile) {
        // Don't arm a shot yet — wait for onPointerMove/onPointerUp to tell a
        // tap bref (select this stone for the joystick) apart from a tap
        // long+drag (same direct gesture as desktop, once promoted).
        pendingTap = { entity: g, startX: pos.x, startY: pos.y, startTime: performance.now() };
        return;
      }
      beginDrag(g, pos.x, pos.y);
      return;
    }
    // No stone at this point — check for a grab on the aiming team's own
    // sweep patch (only reachable/visible to them, no placement restriction
    // per feedback: it can sit anywhere, including under a stone/the ball).
    const team = aimingTeam();
    if (!team) return;
    const sw = sweep[team];
    if (sw.active && !sw.used && Math.hypot(sw.x - pos.x, sw.y - pos.y) <= sw.r) {
      sweepDrag = { team, offsetX: pos.x - sw.x, offsetY: pos.y - sw.y };
    }
  }
  function onPointerMove(evt) {
    if (howToAimLocked) return;
    if (pendingTap) {
      evt.preventDefault();
      const pos = getPointerPos(evt);
      const dist = Math.hypot(pos.x - pendingTap.startX, pos.y - pendingTap.startY);
      const held = performance.now() - pendingTap.startTime;
      if (dist >= TAP_MOVE_THRESHOLD || held >= LONG_PRESS_MS) {
        const g = pendingTap.entity;
        pendingTap = null;
        beginDrag(g, pos.x, pos.y);
      }
      return;
    }
    // joystickDrag guard: on mobile, a touch that starts on the joystick
    // still bubbles touchmove up to this same window listener (touch target
    // capture keeps evt.target pinned to the ring, but bubbling still reaches
    // window) — this branch used to run anyway and get silently overwritten
    // a moment later by onJoystickMove's own correcting write every event.
    // That masked the redundant write as long as onJoystickMove always ran
    // its full update, but the aim-lock feature (see onJoystickMove) now
    // skips that update on purpose while locked, so this write would
    // otherwise clobber the frozen aim with a bogus position extrapolated
    // from a joystick touch that's nowhere near the canvas.
    if (drag && !joystickDrag) {
      evt.preventDefault();
      const pos = getPointerPos(evt);
      drag.curX = pos.x; drag.curY = pos.y;
      // the tick itself never fires on release — releaseDrag plays
      // 'stoneSelect'/'shot' instead.
      const dist = Math.min(MAX_DRAG, Math.hypot(drag.startX - drag.curX, drag.startY - drag.curY));
      updateDragTickAudio(dist);
      return;
    }
    if (sweepDrag) {
      evt.preventDefault();
      const pos = getPointerPos(evt);
      const sw = sweep[sweepDrag.team];
      sw.x = pos.x - sweepDrag.offsetX;
      sw.y = pos.y - sweepDrag.offsetY;
    }
  }
  function onPointerUp(evt) {
    if (sweepDrag) { evt.preventDefault(); sweepDrag = null; return; }
    if (pendingTap) {
      // Tap bref: released before either promotion threshold tripped above —
      // select this stone for the joystick instead of arming a shot.
      evt.preventDefault();
      selectedStone = pendingTap.entity;
      audio.play('stoneSelect', { volume: 0.316 });
      pendingTap = null;
      return;
    }
    // joystickDrag guard, same spirit as onPointerMove's own (see that
    // function's comment): a touch/mouse release anywhere still bubbles up
    // to this same window listener even when the drag it's ending belongs to
    // the joystick, not a direct canvas grab. Without this, both this
    // handler AND onJoystickUp would call releaseDrag() for the exact same
    // release — the second call then reads .curX off the `drag` the first
    // call already nulled out, throwing and killing the rAF loop outright
    // (found while testing the mobile joystick's own release path). Bail
    // here and let onJoystickUp own the whole release when it's active.
    if (joystickDrag) return;
    if (!drag) return;
    evt.preventDefault();
    releaseDrag();
  }
  canvas.addEventListener('mousedown', onPointerDown, { signal });
  window.addEventListener('mousemove', onPointerMove, { signal });
  window.addEventListener('mouseup', onPointerUp, { signal });
  canvas.addEventListener('touchstart', onPointerDown, { passive: false, signal });
  window.addEventListener('touchmove', onPointerMove, { passive: false, signal });
  window.addEventListener('touchend', onPointerUp, { passive: false, signal });

  // ---------- Mobile joystick ----------
  // Drives the exact same `drag` object the canvas gestures above populate
  // (see beginDrag/releaseDrag) — the stick's pull, converted from screen px
  // to a canvas-space curX/curY around the selected stone's own position, is
  // indistinguishable from a direct drag to every other system that reads
  // `drag` (laser preview, halo pulse, dragTick audio, releaseDrag itself).
  // Natural joystick semantics: push toward where you want the stone to go,
  // same sense as the canvas drag now uses — curX/curY are placed on the
  // same side of the stone as the push so releaseDrag's own curX-startX math
  // reproduces that direction.
  if (mobile) {
    // #stage-wrap (canvas + every DOM overlay nested inside it) is already
    // detached to #game-card by main.js, before startGame() ever runs — see
    // the comment there. Nothing to redo here.
    // Reparent all 6 toolbar buttons into #mobileController's #mcBody (see
    // index.html/style.css) so they sit inside the panel instead of below/
    // above the board — CSS alone can't do this because #stage-wrap (their
    // desktop parent) is `transform`ed, which traps `position: fixed`
    // descendants inside its own box instead of the viewport. Reparenting
    // doesn't affect the getElementById lookups / listeners wired up below
    // or in main.js (playBtn etc.) — those resolve by id regardless of
    // current DOM parent. Each button is absolutely positioned on its own
    // baked spot on the panel art (see style.css) — no grid/flex grouping
    // needed, so they all land in the same #mcBody. sound/chat/exit
    // previously never got this treatment and stayed trapped inside
    // #toolbar-top (nested in the ~2.05x-zoomed canvas box, with no
    // reparent of its own) — unreachable on mobile, since the
    // .mobile-layout #scene crop pans their baked positions out of the
    // visible viewport entirely.
    document.getElementById('mcBody').append(
      document.getElementById('tbtn-play'),
      document.getElementById('tbtn-sweep'),
      document.getElementById('tbtn-power'),
      document.getElementById('tbtn-chat'),
      document.getElementById('tbtn-sound'),
      document.getElementById('tbtn-exit'),
    );
    const joystickRing = document.getElementById('joystickRing');
    const joystickStick = document.getElementById('joystickStick');
    // Aim lock: the virtual joystick is prone to a specific mobile-only
    // annoyance direct canvas/desktop dragging never has — the thumb's own
    // motion while lifting off at release can nudge the stick just before
    // touchend fires, silently changing the aim from what was actually
    // intended. Holding the stick still for JOYSTICK_LOCK_MS freezes curX/curY
    // (ring lights up via joystickRing.locked, see style.css) so that release
    // wobble can no longer reach it. Deliberately re-aiming out of a lock
    // needs a real push: past JOYSTICK_UNLOCK_PX and *held* there for
    // JOYSTICK_UNLOCK_MS, not just a brief poke, so a lock re-engaged by
    // accident doesn't come loose from the same kind of stray touch it
    // exists to filter out. Thresholds are plain CSS/client px — unlike
    // TAP_MOVE_THRESHOLD above, joystickClientPos never converts into canvas
    // space, since the joystick's own math (below) all happens in screen px
    // relative to the ring's own getBoundingClientRect().
    const JOYSTICK_LOCK_MS = 1800;
    const JOYSTICK_UNLOCK_MS = 500;
    const JOYSTICK_STILL_PX = 4;
    const JOYSTICK_UNLOCK_PX = 8;
    // The visible ring shrank a lot in the white-panel redesign (now ~30-45px
    // radius vs. the old full-size joystick's 100px+), but power still needs
    // roughly that same physical finger travel to feel gradual rather than
    // "full power the instant you touch it" — so power is measured against
    // its own, bigger reference radius (joystickDrag.powerR, set in
    // onJoystickDown below), completely decoupled from joystickDrag.r (the
    // ring's actual radius, still used just to keep the visible stick pinned
    // inside the ring). The player can keep pulling well past the ring's
    // edge — the puck itself stops moving, but the shot keeps gaining power
    // until powerR, exactly like the old, physically bigger ring did.
    const JOYSTICK_POWER_RADIUS_MULT = 1.9;
    function joystickClientPos(evt) {
      const t = evt.touches ? (evt.touches[0] || evt.changedTouches[0]) : evt;
      return { x: t.clientX, y: t.clientY };
    }
    function applyJoystickPos(p) {
      let dx = p.x - joystickDrag.cx, dy = p.y - joystickDrag.cy;
      const rawDist = Math.hypot(dx, dy);
      const clampedDist = Math.min(rawDist, joystickDrag.r);
      const ux = rawDist > 0 ? dx / rawDist : 0, uy = rawDist > 0 ? dy / rawDist : 0;
      joystickStick.style.transform = `translate(calc(-50% + ${(ux * clampedDist).toFixed(1)}px), calc(-50% + ${(uy * clampedDist).toFixed(1)}px))`;
      const powerDist = Math.min(rawDist, joystickDrag.powerR);
      const pullDist = (powerDist / joystickDrag.powerR) * MAX_DRAG;
      drag.curX = drag.startX + ux * pullDist;
      drag.curY = drag.startY + uy * pullDist;
      updateDragTickAudio(pullDist);
    }
    function clearJoystickLockTimer() {
      if (joystickDrag.lockTimer != null) { clearTimeout(joystickDrag.lockTimer); joystickDrag.lockTimer = null; }
    }
    function clearJoystickUnlockTimer() {
      if (joystickDrag.unlockTimer != null) { clearTimeout(joystickDrag.unlockTimer); joystickDrag.unlockTimer = null; }
    }
    // (Re)starts the still-timer from `fromPos` — called on joystick-down and
    // every time a move event proves the stick is still actively being aimed
    // (see onJoystickMove), so JOYSTICK_LOCK_MS always measures time since the
    // *last* real movement, not since the drag began.
    function armJoystickLockTimer(fromPos) {
      clearJoystickLockTimer();
      joystickDrag.anchorPos = fromPos;
      joystickDrag.lockTimer = trackedTimeout(engageJoystickLock, JOYSTICK_LOCK_MS);
    }
    function engageJoystickLock() {
      if (!joystickDrag || joystickDrag.locked) return;
      joystickDrag.locked = true;
      joystickDrag.lockTimer = null;
      joystickDrag.lockPos = joystickDrag.lastPos || joystickDrag.anchorPos;
      joystickRing.classList.add('locked');
      // Same clip as any wall/bar contact (reflectOffBar uses this too) —
      // reused here as a "click" cue for the lock engaging, at a fixed
      // moderate-hit reference volume since there's no real impact energy
      // to derive it from.
      audio.play('hitWall', { volume: IMPACT_VOLUME_TRIM * 0.8 * GOLF_LAYER_TRIM * 1.5 }); // +50%
    }
    function disengageJoystickLock() {
      if (!joystickDrag || !joystickDrag.locked) return;
      joystickDrag.locked = false;
      joystickDrag.unlockTimer = null;
      joystickRing.classList.remove('locked');
      const p = joystickDrag.lastPos || joystickDrag.lockPos;
      applyJoystickPos(p);
      armJoystickLockTimer(p);
    }
    function onJoystickDown(evt) {
      audio.unlock();
      if (howToAimLocked) return; // see onPointerDown's own comment
      if (!isAimingPhase(phase)) return;
      const g = selectedStone;
      if (!g || !currentTeamStones().includes(g)) return;
      evt.preventDefault();
      const rect = joystickRing.getBoundingClientRect();
      const p = joystickClientPos(evt);
      joystickDrag = {
        cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, r: rect.width / 2,
        powerR: (rect.width / 2) * JOYSTICK_POWER_RADIUS_MULT,
        locked: false, lockTimer: null, unlockTimer: null, lockPos: null, anchorPos: p, lastPos: p,
      };
      joystickStick.classList.add('dragging');
      beginDrag(g, g.x, g.y);
      armJoystickLockTimer(p);
    }
    function onJoystickMove(evt) {
      if (!joystickDrag) return;
      // howTo's "basic laser" step shows a preset demo shot the player never
      // aims (see howToStartLaserDemo) — this only ever matters if that
      // guard on onJoystickDown somehow didn't catch it first.
      if (howToAimLocked) return;
      evt.preventDefault();
      const p = joystickClientPos(evt);
      joystickDrag.lastPos = p;
      if (joystickDrag.locked) {
        // Frozen: ignore the movement itself, only watch for a sustained
        // deliberate push past JOYSTICK_UNLOCK_PX to earn control back.
        const devDist = Math.hypot(p.x - joystickDrag.lockPos.x, p.y - joystickDrag.lockPos.y);
        if (devDist > JOYSTICK_UNLOCK_PX) {
          if (joystickDrag.unlockTimer == null) joystickDrag.unlockTimer = trackedTimeout(disengageJoystickLock, JOYSTICK_UNLOCK_MS);
        } else {
          clearJoystickUnlockTimer();
        }
        return;
      }
      applyJoystickPos(p);
      if (Math.hypot(p.x - joystickDrag.anchorPos.x, p.y - joystickDrag.anchorPos.y) > JOYSTICK_STILL_PX) {
        armJoystickLockTimer(p);
      }
    }
    function onJoystickUp(evt) {
      if (!joystickDrag) return;
      evt.preventDefault();
      clearJoystickLockTimer();
      clearJoystickUnlockTimer();
      joystickRing.classList.remove('locked');
      joystickDrag = null;
      joystickStick.classList.remove('dragging');
      joystickStick.style.transform = '';
      releaseDrag();
    }
    joystickRing.addEventListener('mousedown', onJoystickDown, { signal });
    window.addEventListener('mousemove', onJoystickMove, { signal });
    window.addEventListener('mouseup', onJoystickUp, { signal });
    joystickRing.addEventListener('touchstart', onJoystickDown, { passive: false, signal });
    window.addEventListener('touchmove', onJoystickMove, { passive: false, signal });
    window.addEventListener('touchend', onJoystickUp, { passive: false, signal });
  }

  // ---------- UI ----------
  const overlay = document.getElementById('overlay');
  const ovContent = document.getElementById('ovContent');
  const startOverlay = document.getElementById('startOverlay');
  const halfA = document.getElementById('halfA');
  const halfB = document.getElementById('halfB');
  const checkA = document.getElementById('checkA');
  const checkB = document.getElementById('checkB');
  // Network sync-check toast (see tryAdvanceAfterManche/beginMancheRollback
  // above) — only ever touched from LAN code paths, but the element itself
  // is always in the DOM (index.html), so these are safe no-ops otherwise.
  const syncToast = document.getElementById('syncToast');
  function showSyncWaiting() {
    syncToast.textContent = 'Syncing…';
    syncToast.classList.remove('problem', 'hidden');
  }
  function hideSyncToast() {
    syncToast.classList.remove('problem');
    syncToast.classList.add('hidden');
  }
  function showSyncProblem() {
    syncToast.textContent = 'Sync problem — the manche will be replayed.';
    syncToast.classList.add('problem');
    syncToast.classList.remove('hidden');
  }

  let controlsEnabled = false;

  halfA.addEventListener('click', () => { audio.unlock(); audio.play('button'); readyA = true; halfA.classList.add('ready'); checkA.textContent = '✓'; maybeStart(); }, { signal });
  halfB.addEventListener('click', () => { audio.unlock(); audio.play('button'); readyB = true; halfB.classList.add('ready'); checkB.textContent = '✓'; maybeStart(); }, { signal });
  function maybeStart() {
    if (readyA && readyB) {
      startOverlay.classList.add('hidden');
      controlsEnabled = true;
      beginMatchIntro();
      // ambience disabled for now — audio.playAmbience() to re-enable
    }
  }

  // ---- Duel LAN chat (see server/arbiter.js's per-team cooldown + CLAUDE.md
  // "chat" notes). One scrolling thread, both teams' bubbles appended in
  // order as they arrive — history persists for the rest of the match,
  // nothing recorded/replayed. Only ever wired up when net is set.
  //
  // CHAT_ENABLED: the feature itself is fully built (this whole block).
  // v1.2's rework: a full-rink mask (same ice-mask texture/shape as the Pass
  // & Play handoff mask, see drawChatMaskBg/toggleChatMask below) instead of
  // the old edge-to-edge two-window layout, opened/closed by the chat rock
  // (desktop, see ROCK_ZONES.chat in onPointerDown) or #tbtn-chat (mobile).
  const CHAT_ENABLED = true;
  const chatMask = document.getElementById('chatMask');
  const chatThread = document.getElementById('chatThread');
  const chatComposeForm = document.getElementById('chatComposeForm');
  const chatComposeInput = document.getElementById('chatComposeInput');
  const chatComposeSendBtn = document.getElementById('chatComposeSendBtn');
  const chatComposeEmojiBtn = document.getElementById('chatComposeEmojiBtn');
  const chatComposeEmojiPicker = document.getElementById('chatComposeEmojiPicker');
  const chatComposeTimerFill = document.getElementById('chatComposeTimerFill');
  const chatBadgeMobile = document.getElementById('tbtn-chat-badge');
  const CHAT_MAX_LEN = 60;
  // Unlimited sends, but at most one every CHAT_COOLDOWN_MS — a flat, real-
  // time cooldown instead of the old "2 slots tied to aim/reveal phase"
  // quota. Simpler to reason about, simpler to enforce (one timestamp per
  // team, no per-manche reset to keep in sync with the game's own phase
  // machine). Composing is never blocked by the cooldown, only the actual
  // send — see syncChatCompose below.
  const CHAT_COOLDOWN_MS = 20000;
  const CHAT_TIMER_C = 2 * Math.PI * 8; // matches the r=8 circle in index.html
  let chatLastSentAt = 0; // far enough in the past that the very first send is never blocked
  function chatCooldownRemaining() { return Math.max(0, CHAT_COOLDOWN_MS - (Date.now() - chatLastSentAt)); }
  let chatInputEnabledCache = null;
  let chatSendEnabledCache = null;
  function syncChatCompose() {
    const inputEnabled = !!net && !chatMuted;
    const sendEnabled = inputEnabled && chatCooldownRemaining() === 0;
    if (inputEnabled !== chatInputEnabledCache) {
      chatInputEnabledCache = inputEnabled;
      chatComposeInput.disabled = !inputEnabled;
      chatComposeEmojiBtn.disabled = !inputEnabled;
      if (!inputEnabled) chatComposeEmojiPicker.classList.add('hidden');
    }
    if (sendEnabled !== chatSendEnabledCache) {
      chatSendEnabledCache = sendEnabled;
      chatComposeSendBtn.disabled = !sendEnabled;
    }
    // Ring fill goes from empty (just sent) to full (ready) — updated every
    // frame while cooling down, cheap enough not to need its own dirty-check.
    const progress = 1 - chatCooldownRemaining() / CHAT_COOLDOWN_MS;
    chatComposeTimerFill.style.strokeDashoffset = String(CHAT_TIMER_C * (1 - progress));
    chatComposeTimerFill.classList.toggle('ready', sendEnabled);
  }
  // team here is whichever side the message came from (from the arbiter's
  // echo, see net.onChat below) — always drawn on that team's fixed board
  // side, same for both players' screens (the board itself isn't mirrored).
  // Appends a bubble (SMS-style thread, not a single overwritten line) and
  // scrolls it into view — history persists for the rest of the match,
  // nothing recorded/replayed.
  function showChatMessage(team, text) {
    if (!text) return;
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble chat-bubble-${team.toLowerCase()}`;
    bubble.textContent = text;
    chatThread.appendChild(bubble);
    chatThread.scrollTop = chatThread.scrollHeight;
  }
  // A small fixed set rather than a full system emoji grid — quick reactions,
  // not a general-purpose keyboard (see design brief: "sober, simple").
  const CHAT_EMOJI = ['🔥', '🎯', '👏', '😅', '💪', '🙌'];
  function buildEmojiPicker(picker, input) {
    // Cleared up front so a fresh startGame() call after an in-app return to
    // mode-select (see stopGame() below) doesn't append a second row of
    // buttons on top of whatever the previous match already built here —
    // #chatComposeEmojiPicker is shared, persistent DOM, not recreated per match.
    picker.innerHTML = '';
    for (const emoji of CHAT_EMOJI) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        input.value = Array.from(input.value + emoji).slice(0, CHAT_MAX_LEN).join('');
        picker.classList.add('hidden');
        input.focus();
      }, { signal });
      picker.appendChild(btn);
    }
  }
  buildEmojiPicker(chatComposeEmojiPicker, chatComposeInput);
  // tbtn-chat (mobile) / the chat rock (desktop, see ROCK_ZONES.chat in
  // onPointerDown) both call this same toggle — opens/closes the chat mask,
  // same show/hide gesture as clicking the icon again to dismiss it.
  const chatBtn = document.getElementById('tbtn-chat');
  const chatBtnCap = document.getElementById('tbtn-chat-cap');
  // Mute toggle (chatMuted/chatBtnSlash/chatBtnOnIcon/net.sendChatMute) is
  // deliberately parked, not wired to any control right now — see
  // conversation. chatMuted stays permanently false until that UI comes
  // back, so syncChatCompose's `!chatMuted` check below is a harmless no-op
  // in the meantime, and net.onChatMute (further down) simply never fires
  // since nothing calls net.sendChatMute anymore.
  let chatMuted = false;
  let chatLastSentMuted = false; // what the opponent currently believes, as far as we've told them
  function pressChatBtn() {
    chatBtnCap.classList.remove('pressed');
    void chatBtnCap.offsetWidth; // restart the animation if pressed again mid-tween
    chatBtnCap.classList.add('pressed');
    audio.play('button');
  }
  let chatMaskOpen = false;
  let chatUnread = false;
  function setChatUnread(v) {
    chatUnread = v;
    if (chatBadgeMobile) chatBadgeMobile.classList.toggle('show', v);
  }
  function toggleChatMask() {
    chatMaskOpen = !chatMaskOpen;
    chatMask.classList.toggle('hidden', !chatMaskOpen);
    if (chatMaskOpen) {
      setChatUnread(false);
      chatComposeInput.focus();
    }
    syncChatCompose();
  }
  // The button itself always responds, even without a chat channel to
  // actually use (local pass-and-play/solo vs AI) — gating entirely behind
  // `if (net)` would make it look dead/unresponsive outside net play.
  chatBtn.addEventListener('click', () => {
    pressChatBtn();
    if (net && CHAT_ENABLED) toggleChatMask();
    else console.log('[toolbar] chat pressed — no chat available');
  }, { signal });
  if (net && CHAT_ENABLED) {
    chatComposeEmojiBtn.addEventListener('click', () => {
      chatComposeEmojiPicker.classList.toggle('hidden');
    }, { signal });
    document.addEventListener('click', (e) => {
      if (chatComposeEmojiPicker.classList.contains('hidden')) return;
      // contains(), not === — a click on the emoji button's own SVG icon has
      // e.target set to the SVG (or one of its inner shapes), never the
      // <button> element itself, so the old strict-equality check missed it:
      // this same click bubbled up to here and immediately re-hid the picker
      // the button's own handler (above) had just shown, in one event.
      if (chatComposeEmojiBtn.contains(e.target) || chatComposeEmojiPicker.contains(e.target)) return;
      chatComposeEmojiPicker.classList.add('hidden');
    }, { signal });
    chatComposeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (chatMuted || chatCooldownRemaining() > 0) return;
      const text = Array.from(chatComposeInput.value.trim()).slice(0, CHAT_MAX_LEN).join('');
      if (!text) return;
      net.sendChat(text);
      chatLastSentAt = Date.now();
      audio.play('chatOut', { volume: 0.251 }); // -12dB
      // Shown locally right away rather than waiting on the arbiter's own
      // echo of this same send (net.onChat below) — same "own screen updates
      // instantly, network catches up" pattern used elsewhere in this file.
      showChatMessage(myTeam, text);
      chatComposeInput.value = '';
      chatComposeEmojiPicker.classList.add('hidden');
      syncChatCompose();
    }, { signal });
  }
  // Sends the local mute toggle's current state to the opponent as soon as
  // it's actually out of sync with what they were last told — so un-muting
  // before the "Chat OFF" ever went out just silently cancels. Unlike a real
  // chat send, this never touches the cooldown above — it has none of its own.
  function maybeAutoSyncMute() {
    if (!net || !CHAT_ENABLED || chatMuted === chatLastSentMuted) return;
    net.sendChatMute(chatMuted);
    chatLastSentMuted = chatMuted;
  }

  function showOverlay(html) { overlay.classList.remove('hidden'); ovContent.innerHTML = html; }
  function hideOverlay() { overlay.classList.add('hidden'); }
  // Net match dead-end (see net.onDisconnect / the 'lanWait' watchdog above)
  // — two distinct messages depending on which signal we actually got:
  // 'quit' when the arbiter/socket told us the opponent is gone (a real
  // close event — in practice this is what a deliberate exit or a browser
  // tab closing normally produces), 'timeout' when nothing ever told us
  // anything and LAN_WAIT_TIMEOUT_MS of silence is our only evidence
  // something's wrong (a genuinely dead connection, no graceful close frame
  // ever sent). Previously a true dead end (no button, no way out) — the
  // whole panel is now one big click target back to the menu, since there's
  // nothing else useful to do here (no reconnection support, see CLAUDE.md).
  const NET_DEAD_END_COPY = {
    quit: { title: 'Match over', body: 'The opponent left the match.' },
    timeout: { title: 'Connection lost', body: 'No response from the opponent for 2 minutes.' },
  };
  function showNetDeadEnd(kind) {
    clearLanWaitWatchdog();
    audio.stopAmbience();
    audio.stopAllGlides();
    const { title, body } = NET_DEAD_END_COPY[kind];
    showOverlay(`<h2>${title}</h2><p>${body}</p>`);
    overlay.onclick = () => { stopGame(); onExit?.(); };
    chatComposeInput.disabled = true; chatComposeSendBtn.disabled = true; chatComposeEmojiBtn.disabled = true;
    chatInputEnabledCache = false; chatSendEnabledCache = false;
  }
  // J1->J2: no "pass the device" screen, straight into the other team's aim phase.
  // J2->sim: a fixed beat after the PLAY press before the shots actually launch —
  // long enough for the launchEngine cue (played instantly at reveal start,
  // see playLaunchEngine()) to run its course before the whoosh/departure follow.
  const PRE_SIM_DELAY = 1700; // was 1000, +700ms so launchEngine finishes before the whoosh/stones
  // Locks in whichever patch a team had placed for the sim about to run —
  // `committed` is what physicsStep/the reveal actually key off; `used` is
  // the round-scoped "spent" flag the toolbar button crosses out.
  function commitSweep(team) {
    const sw = sweep[team];
    if (sw.active) { sw.used = true; sw.committed = true; }
  }
  function onValidate() {
    // Mobile: whichever stone was selected for the joystick belonged to the
    // team whose turn just ended — never carry it into the other team's turn
    // (or the next round), where it'd otherwise sit there pulsing for a stone
    // that isn't even this team's to aim.
    selectedStone = null;
    pendingTap = null;
    if (net) {
      if (phase !== 'lanAim') return;
      const stones = entities[myTeam].map(g => ({ vx: g.pendingVx || 0, vy: g.pendingVy || 0, used: g.used }));
      commitSweep(myTeam);
      const sw = sweep[myTeam];
      net.sendShots(stones, sw.active ? { x: sw.x, y: sw.y, r: sw.r } : null);
      phase = 'lanWait';
      // No full-screen overlay here on purpose — the arena stays visible while
      // waiting; see drawWaitingLabel() for the small under-ice "waiting" label.
      clearLanWaitWatchdog();
      lanWaitWatchdogId = trackedTimeout(() => {
        if (phase !== 'lanWait') return; // resolved (or the match already ended) in the meantime
        showNetDeadEnd('timeout');
      }, LAN_WAIT_TIMEOUT_MS);
      return;
    }
    if (aiTeam) {
      if (phase !== 'aimA') return;
      // Reveal: the AI's shots were already decided in prepareAiShots() at
      // the start of this turn — apply them now, exactly like launchSimulation
      // applies a human's own pendingVx/Vy, then launch both sides together.
      entities[aiTeam].forEach(g => {
        g.pendingVx = g._aiVx || 0;
        g.pendingVy = g._aiVy || 0;
        g._aiVx = g._aiVy = undefined;
      });
      // Human is always team 'A' in solo mode (see main.js) — the AI side
      // never places a sweep patch of its own (out of scope for now).
      commitSweep('A');
      phase = 'pending';
      playLaunchEngine('A');
      // Extra "thinking" pause on top of the usual pre-launch beat — purely a
      // feel beat (see reactionDelay in ai.js), not real computation time.
      const think = AI_CONFIG.reactionDelay[0] + Math.random() * (AI_CONFIG.reactionDelay[1] - AI_CONFIG.reactionDelay[0]);
      scheduleGlideLeadIn(PRE_SIM_DELAY + think);
      trackedTimeout(launchSimulation, PRE_SIM_DELAY + think);
      return;
    }
    // howTo: no second team, no hand-off — straight into the reveal/sim,
    // exactly like the AI branch above but with nothing to apply for "B".
    if (howTo) {
      if (phase !== 'aimA') return;
      // "Basic laser" step (7): a preset demo shot the tutorial stages
      // itself purely to look at (see howToStartLaserDemo) — per explicit
      // feedback, nothing should ever actually fire it, the power button's
      // toggle is the only thing this step reacts to (see syncHowTo's
      // 'laser' case, which calls scheduleHowToAdvance() directly on
      // toggle, no onValidate() involved at all anymore). Bail here too in
      // case a stray tap somehow still reaches Play during this step.
      if (howToStep === 7) return;
      commitSweep('A');
      // Per explicit feedback: a step's spotlight must never linger once
      // its action fires — without this, "Play"/"Slide on the ice" (3/6)
      // kept re-showing their OWN case's target for the whole settle+wait
      // window before the deferred advance actually landed (phase returns
      // to 'aimA' well before that), since only phase !== 'aimA' guarded
      // the top-level check, not this flag.
      howToStepDone = true;
      // Steps 3 ("Play") and 6 ("Slide on the ice") are the tutorial's
      // "a real shot is about to fly" steps — rather than advance right
      // away, flag it and let onHowToAimPhase() do the advancing once this
      // shot has actually finished settling (see that function +
      // scheduleHowToAdvance) — never chain into the next step while the
      // stone is still visibly moving.
      if (howToStep === 3 || howToStep === 6) howToShotAdvancePending = true;
      phase = 'pending';
      playLaunchEngine('A');
      scheduleGlideLeadIn(PRE_SIM_DELAY);
      trackedTimeout(launchSimulation, PRE_SIM_DELAY);
      return;
    }
    // Pass & Play: hand-off mask before the other team's aim, and again
    // before the shared reveal — completeHandoff() applies the deferred
    // phase transition (and, for the 'watch' leg, the actual pending/launch
    // sequence this used to fire immediately here) once each mask lifts.
    if (phase === 'aimA') { commitSweep('A'); phase = 'handoffB'; startHandoff(); }
    else if (phase === 'aimB') { commitSweep('B'); phase = 'handoffWatch'; startHandoff(); }
  }
  // Ticket stat (see src/ticket.js) — fastest stone launched all match, in the
  // same physics units as vx/vy (converted to a % of MAX_DRAG*POWER_SCALE for display).
  function trackShotSpeed(g) {
    const spd = Math.hypot(g.vx, g.vy);
    if (spd > bestShotSpeed) bestShotSpeed = spd;
  }
  // See glideLeaderId above: whichever of this round's 6 stones launches
  // fastest owns the round's single glide whoosh. Only stones, not the ball —
  // the ball never launches on its own, only gets hit mid-sim, which stays
  // outside this round-start pick by design. vxKey/vyKey let the same pick
  // run either off committed velocities (vx/vy, at the real launch instant)
  // or off pendingVx/pendingVy (already locked in by commit time, well
  // before launch) — see scheduleGlideLeadIn() below for why the latter matters.
  function pickGlideLeader(vxKey = 'vx', vyKey = 'vy') {
    let best = null, bestSpd = 0;
    for (const g of entities.A) { const spd = Math.hypot(g[vxKey] || 0, g[vyKey] || 0); if (spd > bestSpd) { bestSpd = spd; best = g; } }
    for (const g of entities.B) { const spd = Math.hypot(g[vxKey] || 0, g[vyKey] || 0); if (spd > bestSpd) { bestSpd = spd; best = g; } }
    return { entity: best, spd: bestSpd };
  }
  // How far ahead of the real physics launch the glide whoosh should start —
  // it read as starting late relative to the stones' visual motion, so the
  // cue now leads the movement by a fixed beat instead of starting exactly
  // when physicsStep first sees the stones move.
  const GLIDE_LEAD_MS = 200; // was 500, too far ahead of the stones' visual motion
  // How long the just-committed team's laser takes to retract into its
  // stones once the reveal starts (see retractTeam/laserRetractProgress) —
  // still inside PRE_SIM_DELAY (1700ms) so it's fully finished before the
  // glide whoosh (PRE_SIM_DELAY - GLIDE_LEAD_MS = 1500ms) and the stones'
  // actual departure at PRE_SIM_DELAY itself, just with a tighter margin
  // than a shorter retract would leave.
  const LASER_RETRACT_MS = 1200;
  // 0 (just started) -> 1 (fully retracted / nothing left to draw). 1 whenever
  // no retraction is in flight, so callers can just check `< 1`.
  function laserRetractProgress() {
    if (!retractTeam) return 1;
    return Math.min(1, (performance.now() - retractStart) / LASER_RETRACT_MS);
  }
  // First sound in the reveal, fired the instant phase flips to 'pending' —
  // ahead of both the glide whoosh (scheduleGlideLeadIn, GLIDE_LEAD_MS before
  // launch) and the stones' actual departure (launchSimulation, PRE_SIM_DELAY
  // later). Called from every path that starts a reveal (local, AI, LAN, replay).
  // `team`, when given, is whichever team's laser/halo was on screen right
  // before this reveal began — starts that team's retract animation in sync
  // with this same cue. Omitted for the replay path, which never shows a
  // laser during 'replayAim' in the first place (see isAimingPhase).
  function playLaunchEngine(team) {
    audio.play('launchEngine', { volume: 0.178 }); // -10dB, then another -5dB, ~-15dB total
    if (team) { retractTeam = team; retractStart = performance.now(); }
  }
  // Called right alongside every setTimeout(launchSimulation, delayMs) below:
  // pendingVx/Vy for every stone are already final by the time each of those
  // is scheduled (aim/reveal has fully committed), so the round's leader and
  // its launch speed are already knowable — this just fires audio.setGlide()
  // GLIDE_LEAD_MS earlier than physicsStep otherwise would.
  function scheduleGlideLeadIn(delayMs) {
    const { entity, spd } = pickGlideLeader('pendingVx', 'pendingVy');
    if (!entity || spd <= 0) return;
    glideLeaderId = entity.id;
    trackedTimeout(() => {
      audio.setGlide(entity.id, spd / MAX_SPEED, xToPan(entity.x));
    }, Math.max(0, delayMs - GLIDE_LEAD_MS));
  }
  function launchSimulation() {
    entities.A.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; trackShotSpeed(g); });
    entities.B.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; trackShotSpeed(g); });
    glideLeaderId = pickGlideLeader('vx', 'vy').entity?.id || null;
    if (!isReplay) recordCurrentManche();
    phase = 'sim';
    // Dev self-check (see diffMancheResults) — exercises the exact same
    // headless path LAN uses, but works in solo/AI play too since it never
    // needs a second machine: whatever the paced simulation actually
    // converges to (checked in beginStraighten/resolveGoal) should be
    // byte-identical to this.
    if (import.meta.env.DEV && !isReplay) devHeadlessExpected = computeMancheResult(entities);
  }
  // Shared by the local-commit path above and the LAN net.onLaunch handler
  // below — both are "apply this {vx,vy,used}x3 per team" moments, just fed
  // from a different source (pendingVx/Vy vs. the arbiter's wire payload).
  function recordCurrentManche() {
    recorder.recordManche({
      stonesA: entities.A.map(g => ({ vx: g.vx, vy: g.vy, used: g.used })),
      stonesB: entities.B.map(g => ({ vx: g.vx, vy: g.vy, used: g.used })),
      sweepA: sweep.A.committed ? { x: sweep.A.x, y: sweep.A.y, r: sweep.A.r } : null,
      sweepB: sweep.B.committed ? { x: sweep.B.x, y: sweep.B.y, r: sweep.B.r } : null,
    });
  }

  // howTo: straight into the tutorial, no ready-tap lobby (single player,
  // nothing to confirm) — see the "How To" tutorial block near the bottom of
  // this closure for onHowToAimPhase()/the rest of the orchestration.
  if (howTo) {
    startOverlay.classList.add('hidden');
    controlsEnabled = true;
    beginMatchIntro();
  }
  // Lobby (index.html) already confirms both players are connected before
  // calling startGame — no in-canvas ready-tap step needed for LAN mode.
  if (net) {
    startOverlay.classList.add('hidden');
    controlsEnabled = true;
    beginMatchIntro();
    if (CHAT_ENABLED) {
      // Mask itself starts hidden (chatMaskOpen=false) — CHAT_ENABLED just
      // means the plumbing is live, opening is always an explicit click on
      // the rock/#tbtn-chat.
      //
      // The arbiter echoes every chat message back to BOTH players,
      // including the sender (see server/arbiter.js) — our own send already
      // shows its bubble instantly at submit time (the optimistic
      // showChatMessage call there), so re-appending it here on our own
      // echo would double it up. Only the opponent's messages (team !==
      // myTeam) get appended/cued/badged here; while self-muted, those are
      // simply dropped — the opponent keeps chatting into a void without
      // knowing it (see the design note on tbtn-chat above).
      net.onChat(({ team, text }) => {
        if (team === myTeam) return;
        if (chatMuted) return;
        audio.play('chatIn', { volume: 0.251 }); // -12dB
        if (!chatMaskOpen) setChatUnread(true);
        showChatMessage(team, text);
      });
      // Separate channel from onChat above (see net.sendChatMute) — same
      // self-mute filter, since it's still "ignore everything from the other
      // side while I'm off".
      net.onChatMute(({ team, muted }) => {
        if (chatMuted && team !== myTeam) return;
        showChatMessage(team, muted ? 'Chat OFF' : '');
      });
    }
    net.onLaunch(({ shotsA, shotsB, sweepA, sweepB, mancheIndex }) => {
      clearLanWaitWatchdog();
      hideOverlay();
      phase = 'pending';
      playLaunchEngine(myTeam);
      // Sync-check: snapshot the resting state THIS manche started from
      // (before any of its shot velocities are applied below) — this is
      // exactly what a later 'mancheInvalid' rolls back to. mancheValidated
      // gates the next aim phase (see maybeAdvanceRound/beginStraighten)
      // until this manche's own 'mancheValid' comes back.
      mancheStartSnapshot = {
        entities: cloneEntityState(entities),
        sweepUsed: { A: sweep.A.used, B: sweep.B.used },
        sweepRockClicked: { A: sweep.A.rockClicked, B: sweep.B.rockClicked },
      };
      currentMancheIndex = mancheIndex;
      mancheValidated = false;
      syncWaitTimerActive = false;
      // Own patch is already active/committed locally from commitSweep() at
      // send time — this overwrites both sides fully from what the arbiter
      // actually relayed (same pattern as the `used` flag below) so both
      // clients' physics/reveal are byte-identical regardless of any local
      // state quirk, rather than trusting the local copy for our own team.
      sweep.A.active = !!sweepA; sweep.A.committed = !!sweepA;
      if (sweepA) { sweep.A.x = sweepA.x; sweep.A.y = sweepA.y; sweep.A.r = sweepA.r; sweep.A.used = true; }
      sweep.B.active = !!sweepB; sweep.B.committed = !!sweepB;
      if (sweepB) { sweep.B.x = sweepB.x; sweep.B.y = sweepB.y; sweep.B.r = sweepB.r; sweep.B.used = true; }
      // Both sides' shots are already fully known here (the arbiter only
      // sends this once it has both) — same "already committed ahead of the
      // delayed launch" situation as scheduleGlideLeadIn() handles for the
      // local/AI/replay paths above, just reading shotsA/shotsB (this
      // client's own entities.A/B never got real pendingVx/Vy for the
      // opponent's stones) instead of pendingVx/Vy directly.
      let leadEntity = null, leadSpd = 0;
      entities.A.forEach((g, i) => { const s = shotsA[i]; if (!s) return; const spd = Math.hypot(s.vx || 0, s.vy || 0); if (spd > leadSpd) { leadSpd = spd; leadEntity = g; } });
      entities.B.forEach((g, i) => { const s = shotsB[i]; if (!s) return; const spd = Math.hypot(s.vx || 0, s.vy || 0); if (spd > leadSpd) { leadSpd = spd; leadEntity = g; } });
      if (leadEntity && leadSpd > 0) {
        glideLeaderId = leadEntity.id;
        trackedTimeout(() => {
          audio.setGlide(leadEntity.id, leadSpd / MAX_SPEED, xToPan(leadEntity.x));
        }, Math.max(0, PRE_SIM_DELAY - GLIDE_LEAD_MS));
      }
      trackedTimeout(() => {
        // used flag comes from the network too, not just local drags — on this
        // client the opponent's own stones were never dragged locally, so their
        // g.used would otherwise stay permanently false and their halo would
        // never show 'on' during the reveal (see haloMode above).
        entities.A.forEach((g, i) => { g.vx = shotsA[i]?.vx || 0; g.vy = shotsA[i]?.vy || 0; g.used = !!shotsA[i]?.used; trackShotSpeed(g); });
        entities.B.forEach((g, i) => { g.vx = shotsB[i]?.vx || 0; g.vy = shotsB[i]?.vy || 0; g.used = !!shotsB[i]?.used; trackShotSpeed(g); });
        glideLeaderId = pickGlideLeader('vx', 'vy').entity?.id || null;
        recordCurrentManche();
        phase = 'sim';
        // Headless fast-forward, right as the real (paced, on-screen) sim
        // starts from this exact same state — see computeMancheResult. Ready
        // to send within milliseconds, well before the real animation the
        // player is watching gets anywhere near settling.
        const headlessResult = computeMancheResult(entities);
        if (import.meta.env.DEV) devHeadlessExpected = headlessResult; // see diffMancheResults
        net.sendMancheResult(mancheIndex, headlessResult);
      }, PRE_SIM_DELAY);
    });
    net.onMancheValid(({ mancheIndex: idx }) => {
      if (idx !== currentMancheIndex) return; // stale — already superseded
      mancheValidated = true;
      hideSyncToast();
      if (pendingMancheAdvance) { const fn = pendingMancheAdvance; pendingMancheAdvance = null; fn(); }
    });
    net.onMancheInvalid(({ mancheIndex: idx, resultA, resultB }) => {
      if (idx !== currentMancheIndex) return;
      if (import.meta.env.DEV) diffMancheResults(`network mismatch (manche ${idx})`, resultA, resultB);
      beginMancheRollback();
    });
    // Claim this slot away from the pre-match lobby's handler (main.js's
    // showReadyScreen, set via onOpponentJoined before startGame() ran): the
    // arbiter re-broadcasts 'opponentJoined' to BOTH sides whenever either
    // one (re)connects — including a same-team reconnect after a hard
    // refresh mid-match (see server/arbiter.js's wss.on('connection', ...)).
    // Left pointing at the stale lobby handler, that reconnect would pop the
    // "Prêt" ready screen back onto this client's shared #overlay mid-match
    // and, if tapped, fire a second startGame() call on this same
    // already-started canvas — even now that startGame() has a real
    // stopGame() (see its own comment), nothing here ever calls it, so a
    // second call would still hit the canvas.dataset.nbStarted guard and
    // bail (a warning, not a crash) rather than cleanly restarting the
    // match; this is what originally showed up as "the other machine keeps
    // the previous match's already-elapsed timer" (see "LAN Timer sync
    // problem nimball" design note). Once the real match is running, a
    // mid-match 'opponentJoined' carries no useful information, so no-op it.
    net.onOpponentJoined(() => {});
    // A real close/'opponentLeft' signal actually arrived (see
    // showNetDeadEnd's own comment on why that reads as 'quit' rather than
    // a silent drop, and the 'lanWait' watchdog above for the other case).
    net.onDisconnect(() => showNetDeadEnd('quit'));
  } else if (aiTeam) {
    // Solo vs IA: no lobby/ready-tap step needed (only one human) — straight
    // into the human's aim phase, same as LAN skips the local ready screen.
    startOverlay.classList.add('hidden');
    controlsEnabled = true;
    beginMatchIntro();
  } else if (isReplay) {
    // Click-to-start gate before any auto-play begins — not just UX, this is
    // the user gesture WebAudio needs to unlock (see audio.js) before any SFX
    // can play during the replay.
    startOverlay.classList.add('hidden');
    controlsEnabled = true;
    showOverlay(`
      <h2>Replay ready</h2>
      <p>${replayAllPoints.length} point${replayAllPoints.length > 1 ? 's' : ''} to watch</p>
      <div class="goal-actions">
        <button class="bigbtn" id="replayStartBtn">▶ Start replay</button>
      </div>
    `);
    document.getElementById('replayStartBtn').onclick = () => {
      audio.unlock();
      audio.play('button');
      hideOverlay();
      // Board is shown ready (rack position, first point's rail/segments
      // built) but paused — beginAimPhase() is safe to call while paused,
      // maybeAdvanceReplay() no-ops until the user actually presses play in
      // the bar below (see replayPlayBtn's own handler).
      showReplayBar();
      beginAimPhase();
    };
  }

  // ---------- Physics ----------
  // Squash-and-stretch timing: think of it as compressing under load, then
  // springing back — the "in" phase (squashing) takes a moment, like the
  // material is absorbing the hit, while the "out" phase (return) is a quick
  // springy release, not a slow float back to shape.
  const SQUISH_IN_FRAMES = 10, SQUISH_OUT_FRAMES = 9;
  // after the squash fully releases, a brief elastic overshoot — the shape
  // puffs slightly past its resting size once, like a spring passing its
  // rest point, before settling flat. Amplitude is a fraction of the squash
  // peak so a harder hit overshoots a bit more, same as it squashes more.
  const SQUISH_OVERSHOOT_FRAMES = 8, SQUISH_OVERSHOOT_FRAC = 0.22;
  const SQUISH_AMPLITUDE = 0.2;  // was 0 (0.7, 0.5, 1 before that) — near-imperceptible, testing a hint vs fully off
  function triggerSquish(e, nx, ny, strength) {
    // stones only: a contact spins them, torque coming from the tangential
    // slip at the point of impact (a dead-center hit has none) — decays back
    // out on its own in physicsStep, like real angular friction bleeding it off
    if (e.rotVel !== undefined) {
      const tx = -ny, ty = nx;
      const vt = e.vx * tx + e.vy * ty;
      // grip is friction-limited (Coulomb-style), not just "however tangential
      // the incoming velocity happens to be" — without this, a fast, even
      // slightly glancing hit spun stones far more than a real curling stone
      // ever would, since vt alone scales with shot power, not contact force.
      // Capping it to a multiple of the actual impact strength leaves small/
      // near-head-on hits untouched (vt rarely reaches the cap there) while
      // reining in the big oblique ones.
      const SPIN_GRIP = 1.4;
      const vtCapped = Math.sign(vt) * Math.min(Math.abs(vt), strength * SPIN_GRIP);
      e.rotVel -= vtCapped * 0.05; // was 0.04 (0.063 before the sign fix) — spin-up on contact felt too strong
    }
    if (e.squish === undefined) return; // ball: no contact deformation
    // capped well below the old 0.78 — a subtler, softer bump per feedback
    // SQUISH_AMPLITUDE applied after the cap, so it scales the effect even on
    // hits strong enough to saturate it (squishGain alone can't, most real
    // impacts already hit the cap before it gets a chance to act)
    const amt = Math.min(0.126, strength * 0.06 * (e.squishGain || 1)) * SQUISH_AMPLITUDE;
    if (amt > e.squish) {
      e.squish = amt; e.squishNX = nx; e.squishNY = ny;
      e.squishPeak = amt; e.squishPhase = 'in'; e.squishT = 0;
    }
  }
  // volume/pitch scale with impact speed so a graze and a full-power slam
  // don't sound the same; MAX_SPEED is the natural upper bound for spd/impact.
  // Volume rides a sqrt(t) curve rather than linear t — linear made hard hits
  // slam up to full volume far too fast/loud, sqrt compresses the top of the
  // range while still keeping soft/medium hits clearly differentiated.
  // IMPACT_VOLUME_TRIM: -6dB, then another -5dB, then +10dB, then +30% —
  // net a bit above the original unity level.
  const MIN_AUDIBLE_IMPACT = 0.06; // below this, jitter during settling would spam near-silent plays
  const IMPACT_VOLUME_TRIM = 1.1505; // was 0.885, +30%
  const GOLF_LAYER_TRIM = 0.2; // -8dB, then another -6dB (-14dB total), testing the golf-layer impact clips
  // Partial stereo pan from the impact's x position on the board — PAN_MAX
  // caps it well short of a hard left/right pan (a stone hitting the far
  // wall shouldn't vanish into one speaker), just enough to give impacts a
  // sense of where on the ice they actually happened.
  const PAN_MAX = 0.35;
  function xToPan(x) {
    const t = Math.max(0, Math.min(1, (x - FX0) / (FX1 - FX0)));
    return (t * 2 - 1) * PAN_MAX;
  }
  function playWallHit(spd, x, silent = false) {
    if (silent || spd < MIN_AUDIBLE_IMPACT) return;
    const t = Math.min(1, spd / MAX_SPEED);
    audio.play('hitWall', { volume: Math.sqrt(t) * IMPACT_VOLUME_TRIM * 0.8 * GOLF_LAYER_TRIM, rate: 0.9 + t * 0.2 + Math.random() * 0.08, group: 'impact', pan: xToPan(x) });
  }
  function playBodyHit(impact, isBallHit, x, silent = false) {
    if (silent || impact < MIN_AUDIBLE_IMPACT) return;
    const t = Math.min(1, impact / MAX_SPEED);
    // same volume/reverb formula as stone-stone — only the clip differs
    audio.play(isBallHit ? 'hitStoneBall' : 'hitStone', { volume: Math.sqrt(t) * IMPACT_VOLUME_TRIM * GOLF_LAYER_TRIM, rate: 0.9 + t * 0.2 + Math.random() * 0.08, group: 'impact', pan: xToPan(x) });
  }
  // Left/right walls (wallX = FX0 or FX1) are only solid above GY0 and below
  // GY1 — the goal mouth in between is open netting. Treated as two wall
  // SEGMENTS rather than one infinite line + a hard center-y switch: closestY
  // clamps to whichever segment is nearer, degenerating to a flat perpendicular
  // wall hit when e.y is already outside the mouth, and to the segment's own
  // endpoint (the goal post tip) when e.y falls inside the mouth range but the
  // circle still overlaps that tip. This replaces an earlier version that
  // picked the wall-vs-open-mouth branch purely from whether the center-y was
  // inside GOAL_HALF_HEIGHT — a circle grazing a post at an angle could have
  // its center dip into the "open mouth" branch (no collision at all, free to
  // penetrate past wallX) for a frame or two, then snap back into the flat-wall
  // branch once e.y drifted back out, correcting a now-large overlap in one
  // frame — reading as a teleport-then-bounce instead of a clean corner
  // deflection. Returns true (and applies the bounce) if the circle is
  // actually touching wall-or-post; false if it's clear (e.g. deep in the open
  // mouth, where the goal-fall check below takes over instead).
  function collideGoalSide(e, wallX, silent = false) {
    let closestY;
    if (e.y <= GY0) closestY = e.y;
    else if (e.y >= GY1) closestY = e.y;
    else closestY = (e.y - GY0 <= GY1 - e.y) ? GY0 : GY1;
    const dx = e.x - wallX, dy = e.y - closestY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0 || dist >= e.r) return false;
    let nx = dx / dist;
    const ny = dy / dist;
    // Flat-wall segment (dy === 0: y already outside the goal mouth, see
    // above) — the legal/interior side is fixed by which post this is, not
    // by the entity's current displacement. Pinning it defends against the
    // same already-crossed-the-line scenario GOAL_RECESSES' box-gating is
    // meant to prevent ever reaching this branch in the first place (see
    // conversation) — belt and suspenders at the recess-box boundary rather
    // than a load-bearing fix here. The tip branch below (dy !== 0, grazing
    // the post's own corner point) keeps the direction-from-displacement
    // math, which is correct there since both sides of a point really are
    // legitimate approach directions.
    if (dy === 0) nx = wallX < CENTER_X ? 1 : -1;
    const vDotN = e.vx * nx + e.vy * ny;
    const spd = Math.abs(vDotN);
    const overlap = e.r - dist;
    e.x += nx * overlap; e.y += ny * overlap;
    e.vx -= (1 + WALL_RESTITUTION) * vDotN * nx;
    e.vy -= (1 + WALL_RESTITUTION) * vDotN * ny;
    triggerSquish(e, nx, ny, spd);
    playWallHit(spd, e.x, silent);
    return true;
  }
  // Corner chamfers: each of the 4 corners stores both diagonal endpoints
  // (p on the wall it starts from, p2 on the wall it lands on) plus the
  // outward unit normal derived from them, and a bounding box that
  // exclusively owns that spot (see physicsStep below for why the flat-wall
  // checks must be gated out of it). Ported from design-lab's
  // arena-v2-physics-test.html after two rounds of bug-fixing there (an
  // infinite-line-plus-box version drew/collided the wrong direction on some
  // corners; a version that let flat walls fire unconditionally could catch
  // an entity that was actually in the cut corner) — see conversation.
  function cornerNorm(x, y) { const l = Math.sqrt(x * x + y * y) || 1; return { x: x / l, y: y / l }; }
  const CORNERS = [
    { p: { x: FX0, y: FY0 + CHAMFER_Y }, p2: { x: FX0 + CHAMFER_X, y: FY0 }, n: cornerNorm(-CHAMFER_Y, -CHAMFER_X), box: { x0: FX0 - 1, x1: FX0 + CHAMFER_X, y0: FY0 - 1, y1: FY0 + CHAMFER_Y } }, // TL
    { p: { x: FX1 - CHAMFER_X, y: FY0 }, p2: { x: FX1, y: FY0 + CHAMFER_Y }, n: cornerNorm(CHAMFER_Y, -CHAMFER_X), box: { x0: FX1 - CHAMFER_X, x1: FX1 + 1, y0: FY0 - 1, y1: FY0 + CHAMFER_Y } }, // TR
    { p: { x: FX0, y: FY1 - CHAMFER_Y }, p2: { x: FX0 + CHAMFER_X, y: FY1 }, n: cornerNorm(-CHAMFER_Y, CHAMFER_X), box: { x0: FX0 - 1, x1: FX0 + CHAMFER_X, y0: FY1 - CHAMFER_Y, y1: FY1 + 1 } }, // BL
    { p: { x: FX1 - CHAMFER_X, y: FY1 }, p2: { x: FX1, y: FY1 - CHAMFER_Y }, n: cornerNorm(CHAMFER_Y, CHAMFER_X), box: { x0: FX1 - CHAMFER_X, x1: FX1 + 1, y0: FY1 - CHAMFER_Y, y1: FY1 + 1 } }, // BR
  ];
  function inCornerBox(e, box) { return e.x >= box.x0 && e.x <= box.x1 && e.y >= box.y0 && e.y <= box.y1; }
  // Goal recess boundary: the outer post's flat-wall/tip approximation
  // (collideGoalSide below) used to also stand in for the recess interior —
  // one function pretending the wall was a straight line at FX0/FX1 for any
  // y outside the mouth, and a single point at the post tip for y inside it.
  // That missed the recess entirely: real art (confirmed 100% perpendicular,
  // see conversation) is a rectangular notch — a short return straight in
  // from the post tip to the back wall, the back wall itself, then the
  // mirrored return back out — three real, connected wall segments, not one
  // approximated line. Modeled here exactly like CORNERS above (a
  // box-gated, closed chain of clamped-segment checks, same collideCorner
  // math) instead of patching the old approximation further: this replaces
  // it for the recess area outright, so exactly one collision model ever
  // owns a given spot, same principle as the corner/flat-wall split.
  const GOAL_RECESS_MARGIN = 1;
  const GOAL_RECESSES = [
    { // left goal
      box: { x0: NOTCH_X0 - GOAL_RECESS_MARGIN, x1: FX0 + GOAL_RECESS_MARGIN, y0: GY0 - GOAL_RECESS_MARGIN, y1: GY1 + GOAL_RECESS_MARGIN },
      segments: [
        { p: { x: FX0, y: GY0 }, p2: { x: NOTCH_X0, y: GY0 } },      // top return
        { p: { x: NOTCH_X0, y: GY0 }, p2: { x: NOTCH_X0, y: GY1 } }, // back wall
        { p: { x: NOTCH_X0, y: GY1 }, p2: { x: FX0, y: GY1 } },      // bottom return
      ],
    },
    { // right goal, mirrored
      box: { x0: FX1 - GOAL_RECESS_MARGIN, x1: NOTCH_X1 + GOAL_RECESS_MARGIN, y0: GY0 - GOAL_RECESS_MARGIN, y1: GY1 + GOAL_RECESS_MARGIN },
      segments: [
        { p: { x: FX1, y: GY0 }, p2: { x: NOTCH_X1, y: GY0 } },
        { p: { x: NOTCH_X1, y: GY0 }, p2: { x: NOTCH_X1, y: GY1 } },
        { p: { x: NOTCH_X1, y: GY1 }, p2: { x: FX1, y: GY1 } },
      ],
    },
  ];
  function inRecessBox(e, box) { return e.x >= box.x0 && e.x <= box.x1 && e.y >= box.y0 && e.y <= box.y1; }
  // Proper clamped-segment closest point (not an infinite line) — degenerates
  // to circle-vs-point at the segment's own endpoints (p/p2), exactly where
  // the flat-wall checks in physicsStep stop applying, so the handoff
  // between the two collision models is continuous with no gap or overlap.
  function collideCorner(e, c, silent = false) {
    const dx0 = c.p2.x - c.p.x, dy0 = c.p2.y - c.p.y;
    const len2 = dx0 * dx0 + dy0 * dy0;
    let t = len2 > 0 ? ((e.x - c.p.x) * dx0 + (e.y - c.p.y) * dy0) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = c.p.x + dx0 * t, cy = c.p.y + dy0 * t;
    const dx = e.x - cx, dy = e.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0 || dist >= e.r) return false;
    const nx = dx / dist, ny = dy / dist;
    const vDotN = e.vx * nx + e.vy * ny;
    const spd = Math.abs(vDotN);
    const overlap = e.r - dist;
    e.x += nx * overlap; e.y += ny * overlap;
    e.vx -= (1 + WALL_RESTITUTION) * vDotN * nx;
    e.vy -= (1 + WALL_RESTITUTION) * vDotN * ny;
    triggerSquish(e, nx, ny, spd);
    playWallHit(spd, e.x, silent);
    return true;
  }
  // Goal bar: touching it kills a stone (same dead/falling path as an 8th
  // hit — see registerStoneHit) or, for the ball, bounces it back like a wall
  // while the goal still registers (see the ball branch in physicsStep's
  // bar-hit check — the ball no longer sinks/disappears, it plays out its
  // bounce same as any other wall contact). See BAR_LEFT/BAR_RIGHT above for
  // why this replaced the old STONE_LOSS_FRACTION/BALL_GOAL_FRACTION
  // area-crossing heuristic.
  // Shared wall-style reflection math for bar contact — used both by a killed
  // stone (still bounces off the bar like a wall instead of freezing/clipping
  // through it, only actually leaving play once the whole manche settles via
  // the shared dead/falling group animation further down) and by the ball on
  // a goal (see collideBar's call sites below).
  function reflectOffBar(g, bar, silent = false) {
    const cx = Math.max(bar.x0, Math.min(g.x, bar.x1));
    const cy = Math.max(bar.y0, Math.min(g.y, bar.y1));
    const dx = g.x - cx, dy = g.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / dist, ny = dy / dist;
    const vDotN = g.vx * nx + g.vy * ny;
    const spd = Math.abs(vDotN);
    const overlap = Math.max(0, g.r - dist);
    g.x += nx * overlap; g.y += ny * overlap;
    g.vx -= (1 + WALL_RESTITUTION) * vDotN * nx;
    g.vy -= (1 + WALL_RESTITUTION) * vDotN * ny;
    triggerSquish(g, nx, ny, spd);
    playWallHit(spd, g.x, silent);
  }
  // silent (see computeMancheResult's headless fast-forward): suppresses the
  // audio cue + stoneBarFlash timestamp + the match-wide stonesDestroyed
  // tally, so fast-forwarding a clone to its settled state can never
  // double-fire a sound/flash the real paced run will trigger itself later,
  // or double-count a stat. g.dead/deadMix (real physics state, needed for
  // the checksum) are set either way.
  function killStoneOnBar(g, bar, silent = false) {
    if (g.dead) return;
    g.dead = true; g.deadMix = 1;
    if (!silent) stonesDestroyed++;
    reflectOffBar(g, bar, silent);
    if (!silent) {
      audio.play('stoneFall', { volume: 0.178, pan: xToPan(g.x) }); // -10dB, then another -5dB, ~-15dB total — same cue the old goal-fall path used
      stoneBarFlash = { side: bar === BAR_LEFT ? 'left' : 'right', t0: performance.now() };
    }
  }
  function collideBar(e, bar) {
    const cx = Math.max(bar.x0, Math.min(e.x, bar.x1));
    const cy = Math.max(bar.y0, Math.min(e.y, bar.y1));
    const dx = e.x - cx, dy = e.y - cy;
    return Math.sqrt(dx * dx + dy * dy) < e.r;
  }
  // Less per-tick speed loss inside a currently-committed sweep patch (see
  // the `sweep` state comment) — scales the friction DEFICIT rather than fr
  // itself, since fr sits so close to 1 already that scaling it directly
  // would barely move the needle; this compounds into a clearly longer glide
  // over the many ticks of an actual shot.
  function withSweepBoost(fr) { return 1 - (1 - fr) * (1 - SWEEP_FRICTION_BONUS); }
  // state/silent (see computeMancheResult): a headless fast-forward runs this
  // against a cloned {A,B,ball} instead of the closure's own `entities`, and
  // with silent=true so no audio/flash fires early and no match-wide stat
  // counter double-counts — the real paced loop below still calls this with
  // no args (state defaults to `entities`, silent defaults to false), fully
  // unchanged from before.
  function physicsStep(state = entities, silent = false) {
    // Curling has no ball — excluding it here (not just skipping its draw)
    // keeps it out of the move/wall/bar/collision loops AND the SAFE_X0..Y1
    // backstop clamp below entirely, so its untouched {CENTER_X,CY} position
    // from resetPositions() never matters again for the rest of the match.
    const list = vibe === 'curling' ? [...state.A, ...state.B] : [...state.A, ...state.B, state.ball];
    const boostZones = [sweep.A, sweep.B].filter(s => s.committed);
    let goalResult = null;
    for (const e of list) {
      if (e.falling) {
        // shrinking-into-the-void animation; frozen otherwise, no normal physics while it plays
        if (!silent) audio.setGlide(e.id || 'ball', 0);
        e.fallScale -= 0.045;
        if (e.fallScale <= 0) { e.fallScale = 0; e.falling = false; e.out = true; }
        continue;
      }
      e.x += e.vx; e.y += e.vy;
      let fr = e === state.ball ? BALL_FRICTION : FRICTION;
      if (boostZones.some(z => { const zdx = e.x - z.x, zdy = e.y - z.y; return Math.sqrt(zdx * zdx + zdy * zdy) <= z.r; })) fr = withSweepBoost(fr);
      e.vx *= fr; e.vy *= fr;
      const spd0 = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      if (spd0 < STOP_THRESHOLD) { e.vx = 0; e.vy = 0; }
      else if (spd0 > MAX_SPEED) { const s = MAX_SPEED / spd0; e.vx *= s; e.vy *= s; }
      // Only the round's picked leader (see glideLeaderId) drives the single
      // glide voice — every other stone/the ball stays silent here even while
      // still sliding, so exactly one whoosh plays per round.
      if (!silent && (e.id || 'ball') === glideLeaderId) audio.setGlide(e.id || 'ball', spd0 / MAX_SPEED, xToPan(e.x));
      if (e.squishPhase === 'in') {
        e.squishT += 1 / SQUISH_IN_FRAMES;
        const t = Math.min(1, e.squishT);
        e.squish = e.squishPeak * (1 - (1 - t) * (1 - t)); // ease-out: decelerates into the squash
        if (t >= 1) { e.squishPhase = 'out'; e.squishT = 0; }
      } else if (e.squishPhase === 'out') {
        e.squishT += 1 / SQUISH_OUT_FRAMES;
        const t = Math.min(1, e.squishT);
        e.squish = e.squishPeak * (1 - t) * (1 - t); // ease-out: snaps back fast, settles gently — no lingering near the peak
        if (t >= 1) { e.squishPhase = 'settle'; e.squishT = 0; }
      } else if (e.squishPhase === 'settle') {
        e.squishT += 1 / SQUISH_OVERSHOOT_FRAMES;
        const t = Math.min(1, e.squishT);
        // negative squish reads as a slight puff/stretch past resting size
        e.squish = -e.squishPeak * SQUISH_OVERSHOOT_FRAC * Math.sin(Math.PI * t);
        if (t >= 1) { e.squish = 0; e.squishPeak = 0; e.squishPhase = null; }
      }
      if (e.rotVel !== undefined) {
        // stones: rotation is mostly a contact reaction (see triggerSquish), with
        // only a faint drift from rolling itself — otherwise near-static in flight,
        // unlike the ball's continuous spin below
        e.rot += e.rotVel + (e.vx * 0.0018 + e.vy * 0.00072);
        e.rotVel *= 0.975; // was 0.96 (0.92 originally) — spin still dying a bit before the stone itself stops
      } else if (e.rot !== undefined) {
        // ball: continuous roll-spin, well under its real rolling speed so the
        // (mostly symmetric) disc face doesn't blur/spin distractingly fast
        e.rot += (e.vx * 0.008 + e.vy * 0.003);
      }
      if (e._hitCooldown) e._hitCooldown--;
    }
    for (const e of list) {
      if (e.out || e.falling) continue; // fallen (or falling) into the goal: frozen until next round

      // Goal bars checked FIRST and with priority — touching one kills a
      // stone (same dead/falling path as an 8th hit) or scores a goal for
      // the ball, replacing the old STONE_LOSS_FRACTION/BALL_GOAL_FRACTION
      // area-crossing heuristic now that the art has a real bar object to
      // touch instead of an abstract line. Geometrically the bar always
      // sits closer to the field interior than the recessed notch wall
      // below (see NOTCH_X0/X1's own comment), so it's reached first in
      // practice — the notch wall never gets a chance to block entry to the
      // bar it's guarding.
      // Curling has no goal to score and no per-request "dies against the
      // bar" hazard either (see conversation — reverted from an earlier
      // ask): a stone touching the bar there just bounces off it exactly
      // like any other wall, same reflectOffBar() call the ball's own
      // no-death bounce already uses, deliberately with no dead flag, no
      // stonesDestroyed tally, and no stoneBarFlash — only the plain
      // wall-hit squish/SFX reflectOffBar already plays either way.
      // howTo: same "just bounces, no death" treatment as curling — the
      // tutorial's lone stone reaching the goal bar used to kill it outright
      // (killStoneOnBar, hockey vibe's normal behavior), which for a
      // single-stone tutorial with nothing else to teach with is just a
      // dead end. Per explicit request: react like a wall, same as the
      // curling arena.
      let barHit = false;
      if (collideBar(e, BAR_LEFT)) {
        barHit = true;
        if (e === state.ball || vibe === 'curling' || howTo) { reflectOffBar(e, BAR_LEFT, silent); if (e === state.ball) { goalResult = 'goalB'; if (!silent) barGlowSide = 'left'; } }
        else killStoneOnBar(e, BAR_LEFT, silent);
      }
      if (collideBar(e, BAR_RIGHT)) {
        barHit = true;
        if (e === state.ball || vibe === 'curling' || howTo) { reflectOffBar(e, BAR_RIGHT, silent); if (e === state.ball) { goalResult = 'goalA'; if (!silent) barGlowSide = 'right'; } }
        else killStoneOnBar(e, BAR_RIGHT, silent);
      }
      if (barHit) continue;

      // Corner boxes gate BOTH the flat-wall checks below AND the corner
      // check itself, so exactly one collision model ever applies to a
      // given spot — an unconditional flat-wall check can otherwise catch
      // an entity that's actually in a cut corner using the wrong
      // (horizontal/vertical instead of diagonal) normal in the same frame
      // the corner check should have owned it.
      const inTL = inCornerBox(e, CORNERS[0].box), inTR = inCornerBox(e, CORNERS[1].box);
      const inBL = inCornerBox(e, CORNERS[2].box), inBR = inCornerBox(e, CORNERS[3].box);

      if (!inTL && !inTR && e.y - e.r < FY0) { const spd = Math.abs(e.vy); e.y = FY0 + e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, -1, spd); playWallHit(spd, e.x, silent); }
      if (!inBL && !inBR && e.y + e.r > FY1) { const spd = Math.abs(e.vy); e.y = FY1 - e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, 1, spd); playWallHit(spd, e.x, silent); }
      // See collideGoalSide above: the post is the tip of the outer wall
      // segment flanking the goal mouth, so a stone grazing it bounces off
      // the post tip cleanly instead of the mouth/wall branches fighting
      // over it frame to frame. Only covers the OUTER wall now — the recess
      // interior (post tip -> return -> back wall -> return -> post tip) is
      // its own closed segment chain below (see GOAL_RECESSES above), gated
      // the same way CORNERS gates the flat walls, so exactly one collision
      // model ever owns a given spot here too.
      const inRecessL = inRecessBox(e, GOAL_RECESSES[0].box), inRecessR = inRecessBox(e, GOAL_RECESSES[1].box);
      if (!inTL && !inBL && !inRecessL && e.x - e.r < FX0) collideGoalSide(e, FX0, silent);
      if (!inTR && !inBR && !inRecessR && e.x + e.r > FX1) collideGoalSide(e, FX1, silent);
      if (inRecessL) for (const s of GOAL_RECESSES[0].segments) collideCorner(e, s, silent);
      if (inRecessR) for (const s of GOAL_RECESSES[1].segments) collideCorner(e, s, silent);
      for (const c of CORNERS) {
        if (inCornerBox(e, c.box)) collideCorner(e, c, silent);
      }
    }
    const activeList = list.filter(e => !e.out && !e.falling);
    for (let i = 0; i < activeList.length; i++) for (let j = i + 1; j < activeList.length; j++) resolveCollision(activeList[i], activeList[j], state, silent);
    // Re-clamp to MAX_SPEED right after collisions, not just at the top of
    // the next tick's move step. An entity hit by two overlapping pairwise
    // collisions in the SAME tick (e.g. a stone+ball pile-up wedged in the
    // goal-mouth recess, tight enough that a stone's own radius roughly
    // equals the recess depth) can leave this loop with a velocity well past
    // MAX_SPEED, since resolveCollision's impulses stack uncapped. Left
    // unclamped, next tick's `e.x += e.vx` (line ~2227) would apply that
    // whole spike in one uncapped jump — easily wider than the bar's
    // detection window — tunneling the entity clean through the goal bar
    // with no collision ever firing. Clamping here closes that gap: nothing
    // downstream of this point ever moves on an unclamped velocity.
    for (const e of activeList) {
      const spd = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      if (spd > MAX_SPEED) { const s = MAX_SPEED / spd; e.vx *= s; e.vy *= s; }
    }
    // Last-resort backstop: no entity should ever persist outside the
    // playfield's own outer envelope, goal pockets included, no matter the
    // cause. This is deliberately not trying to model the exact legal shape
    // (the octagon corners, the notch) — it's a generous rectangle a stone
    // or the ball can only ever reach the edge of through an already-broken
    // escape (the goal-bar tunneling above is one; a report of the ball/a
    // stone sliding clean off the ice on a scored goal, seen on a live
    // deploy with the tunneling fix already in place, suggests at least one
    // more still-unidentified path exists). Every legitimate position
    // (mid-ice, wedged in a corner cut, sitting in the goal pocket against
    // the bar) sits comfortably inside this box, so it never fires during
    // normal play — it only ever catches something that has already
    // escaped, snapping it back in and killing the outward velocity
    // component instead of letting it glide away forever, uncollided and
    // unrendered-in-bounds.
    const SAFE_X0 = BAR_LEFT.x0 - 4, SAFE_X1 = BAR_RIGHT.x1 + 4;
    const SAFE_Y0 = FY0 - 4, SAFE_Y1 = FY1 + 4;
    for (const e of activeList) {
      if (e.x < SAFE_X0) { e.x = SAFE_X0; if (e.vx < 0) e.vx = -e.vx * WALL_RESTITUTION; }
      else if (e.x > SAFE_X1) { e.x = SAFE_X1; if (e.vx > 0) e.vx = -e.vx * WALL_RESTITUTION; }
      if (e.y < SAFE_Y0) { e.y = SAFE_Y0; if (e.vy < 0) e.vy = -e.vy * WALL_RESTITUTION; }
      else if (e.y > SAFE_Y1) { e.y = SAFE_Y1; if (e.vy > 0) e.vy = -e.vy * WALL_RESTITUTION; }
    }
    // A knocked-dead stone (STONE_MAX_HITS, or bar contact, see
    // registerStoneHit/killStoneOnBar) doesn't play its shrink-into-the-void
    // animation the instant its own slide stops — the ball or other stones
    // are often still gliding at that point, and triggering per-stone would
    // vanish them one at a time as each happened to settle. Instead hold
    // every dead stone, still visible and desaturating, until the whole
    // manche has actually come to rest, then trigger them all together and
    // play the death cue once for the group. Checked BEFORE the goal/wipeout
    // returns below (not after) so the stone(s) whose death itself completes
    // a wipeout still get their fall triggered on later ticks — a wipeout
    // return short-circuits every physicsStep call from here on (see
    // runSimTick's 'goal' phase, which ignores the return value), so if this
    // ran after those checks it would never be reached again once the
    // wipeout condition was already true.
    const deadPending = activeList.filter(e => e.dead);
    if (deadPending.length && activeList.every(e => e.vx === 0 && e.vy === 0)) {
      for (const g of deadPending) { g.falling = true; g.fallScale = 1; }
      if (!silent) {
        const deadPanX = deadPending.reduce((sum, g) => sum + g.x, 0) / deadPending.length;
        audio.play('stoneDead', { volume: 0.159, pan: xToPan(deadPanX) }); // -5dB, -6dB, then another -5dB, ~-16dB total
      }
    }
    if (goalResult) return goalResult;
    // if every one of a team's stones is out of play — fallen into the goal or
    // knocked dead (STONE_MAX_HITS) — the other team scores the point, same as
    // a real goal. `.length &&` guards: a genuinely empty team (howTo mode's
    // solo stone with no team B, see resetPositions) must never vacuously
    // satisfy .every() on 0 elements — without this, howTo's every single shot
    // returned 'wipeoutA' on its very first physicsStep tick.
    if (state.A.length && state.A.every(g => g.out || g.dead)) return 'wipeoutB';
    if (state.B.length && state.B.every(g => g.out || g.dead)) return 'wipeoutA';
    return null;
  }
  function resolveCollision(a, b2, state = entities, silent = false) {
    const dx = b2.x - a.x, dy = b2.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = a.r + b2.r;
    if (dist === 0 || dist >= minDist) return;
    const rvx = b2.vx - a.vx, rvy = b2.vy - a.vy;
    // Position is only checked after this frame's move, so by the time this
    // runs the pair can already overlap by a few px — dx,dy then points toward
    // where the centers are NOW, not toward the true point of first contact.
    // On a near head-on hit that barely matters, but on a grazing hit it can
    // rotate the normal by several degrees. Fix: back-solve for the exact
    // moment this frame the circles were first exactly minDist apart (treating
    // this frame's relative velocity as constant, same idea reused in the aim
    // cascade's ghostResolveCollision below), and compute the normal from that reconstructed
    // position instead — the actual separation/impulse below still happens at
    // the real (overlapping) positions, only the normal's direction is
    // corrected. Ported from physics-lab/lab.js after verifying it there.
    let nx = dx / dist, ny = dy / dist;
    const A = rvx * rvx + rvy * rvy;
    if (A > 1e-6) {
      const pv = dx * rvx + dy * rvy;
      const C = dist * dist - minDist * minDist; // < 0, we're overlapping
      const D = pv * pv - A * C;
      if (D >= 0) {
        const t = Math.max(0, Math.min(1, (pv + Math.sqrt(D)) / A));
        const cdx = dx - rvx * t, cdy = dy - rvy * t;
        const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
        if (cdist > 1e-6) { nx = cdx / cdist; ny = cdy / cdist; }
      }
    }
    const overlap = (minDist - dist) / 2;
    a.x -= nx * overlap; a.y -= ny * overlap;
    b2.x += nx * overlap; b2.y += ny * overlap;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return;
    if (!silent) totalCollisions++;
    const invMassA = 1 / a.mass, invMassB = 1 / b2.mass;
    let j = -(1 + BODY_RESTITUTION) * velAlongNormal;
    j /= (invMassA + invMassB);
    j *= BOUNCE_BOOST;
    const impX = j * nx, impY = j * ny;
    a.vx -= impX * invMassA; a.vy -= impY * invMassA;
    b2.vx += impX * invMassB; b2.vy += impY * invMassB;
    const impact = Math.abs(velAlongNormal);
    // squish normal points from each entity's own center toward the contact
    // point (toward the other body), so the "far" side can be anchored in place
    triggerSquish(a, nx, ny, impact);
    triggerSquish(b2, -nx, -ny, impact);
    playBodyHit(impact, a === state.ball || b2 === state.ball, (a.x + b2.x) / 2, silent);
    // stone-vs-opposing-stone impact: each side takes one hit (see STONE_MAX_HITS)
    if (a.team && b2.team && a.team !== b2.team) {
      registerStoneHit(a, silent);
      registerStoneHit(b2, silent);
    }
  }
  // Knocks out the next LED (top first, then clockwise — see LED_RECTS) and
  // kills the stone on the 4th hit. Cooldown-gated so one prolonged/grazing
  // contact spanning several physics frames only ever counts as a single hit.
  function registerStoneHit(g, silent = false) {
    if (g.dead || g._hitCooldown > 0) return;
    g._hitCooldown = HIT_COOLDOWN_FRAMES;
    g.hits = Math.min(STONE_MAX_HITS, g.hits + 1);
    if (g.hits >= STONE_MAX_HITS) { g.dead = true; g.deadMix = 1; if (!silent) stonesDestroyed++; }
  }
  function allSettled(state = entities) { return [...state.A, ...state.B, state.ball].every(e => e.vx === 0 && e.vy === 0 && !e.falling); }

  // ---------- Network sync-check (see CLAUDE.md determinism work) ----------
  // Plain per-field copy — every entity field is a primitive (see makeStone),
  // no nested objects/arrays, so this is a real independent snapshot, safe to
  // fast-forward without touching whatever `entities` itself is doing.
  function cloneEntityState(state = entities) {
    return { A: state.A.map(g => ({ ...g })), B: state.B.map(g => ({ ...g })), ball: { ...state.ball } };
  }
  // Quantized to the nearest px — real divergence compounds to way more than
  // that by settle time, so this just absorbs harmless last-bit float noise
  // (see the Math.hypot -> Math.sqrt pass) rather than flagging it as a
  // mismatch. Fixed field order (not just "whatever JSON.stringify does with
  // the live objects") since the two clients' own key-insertion order for a
  // spread clone is already identical here (same makeStone shape both
  // sides), but being explicit costs nothing and removes any doubt.
  function quantizeMancheResult(state, goalResult) {
    const stone = g => [Math.round(g.x), Math.round(g.y), g.hits, g.dead ? 1 : 0, g.out ? 1 : 0];
    return {
      a: state.A.map(stone),
      b: state.B.map(stone),
      ball: [Math.round(state.ball.x), Math.round(state.ball.y), state.ball.out ? 1 : 0],
      result: goalResult || null,
    };
  }
  // Headless fast-forward: runs silent physicsStep() on a clone of
  // initialState until it settles, fully decoupled from the real paced
  // rAF/accumulator loop that will separately animate the same manche on
  // screen (see net.onLaunch) — so the checksum is ready to send within
  // milliseconds of the shot launching, regardless of how many real seconds
  // the on-screen animation itself takes to play out. Only the FIRST
  // goal/wipeout result is kept (matches runSimTick's 'goal' phase, which
  // likewise ignores every physicsStep() return after the first once a point
  // is already decided). MAX_TICKS is a generous safety net, not a tuned
  // value — real shots settle in well under 100 ticks; it only guards against
  // a genuinely pathological/never-converging state.
  const MANCHE_COMPUTE_MAX_TICKS = 3000;
  function computeMancheResult(initialState) {
    const state = cloneEntityState(initialState);
    let goalResult = null;
    for (let i = 0; i < MANCHE_COMPUTE_MAX_TICKS; i++) {
      const result = physicsStep(state, true);
      if (result && !goalResult) goalResult = result;
      if (allSettled(state) && !deadStonesStillAnimating(state)) break;
    }
    return quantizeMancheResult(state, goalResult);
  }
  // Dev-only diagnostic (see CLAUDE.md determinism work / conversation) — a
  // per-field breakdown of two quantizeMancheResult() payloads, in the
  // console only, never surfaced to the player. Used two ways: (1) a local
  // self-check comparing computeMancheResult()'s headless outcome against
  // what the real, paced, on-screen simulation actually converges to for
  // every single manche (LAN AND solo/AI play, no network needed at all) —
  // this is what would catch a mistake in the silent/state threading itself,
  // independent of any cross-client concern; (2) an actual network mismatch,
  // where the arbiter echoes both sides' results back on 'mancheInvalid' (see
  // net.onMancheInvalid) so a real divergence can be diagnosed field-by-field
  // instead of just "the manche was invalid".
  function diffMancheResults(label, expected, actual) {
    if (!expected || !actual) return;
    const lines = [];
    const stoneLabel = (team, i) => `${team}${i}`;
    ['a', 'b'].forEach((key, ti) => {
      const team = key === 'a' ? 'A' : 'B';
      (expected[key] || []).forEach((exp, i) => {
        const act = (actual[key] || [])[i];
        if (!act) return;
        const [ex, ey, ehits, edead, eout] = exp;
        const [ax, ay, ahits, adead, aout] = act;
        if (ex !== ax || ey !== ay) lines.push(`  stone ${stoneLabel(team, i)}: position expected=(${ex},${ey}) actual=(${ax},${ay})`);
        if (ehits !== ahits) lines.push(`  stone ${stoneLabel(team, i)}: hits expected=${ehits} actual=${ahits}`);
        if (edead !== adead) lines.push(`  stone ${stoneLabel(team, i)}: dead expected=${edead} actual=${adead}`);
        if (eout !== aout) lines.push(`  stone ${stoneLabel(team, i)}: out expected=${eout} actual=${aout}`);
      });
    });
    const [ebx, eby, ebout] = expected.ball || [];
    const [abx, aby, about] = actual.ball || [];
    if (ebx !== abx || eby !== aby) lines.push(`  ball: position expected=(${ebx},${eby}) actual=(${abx},${aby})`);
    if (ebout !== about) lines.push(`  ball: out expected=${ebout} actual=${about}`);
    if (expected.result !== actual.result) lines.push(`  result: expected=${expected.result} actual=${actual.result}`);
    if (lines.length) {
      console.error(`[sync] MISMATCH — ${label}\n${lines.join('\n')}`);
    } else if (import.meta.env.DEV) {
      console.debug(`[sync] OK — ${label}`);
    }
  }
  // Set right at launch (both the LAN path in net.onLaunch and the local/AI
  // path in launchSimulation below), consumed once at whichever of
  // beginStraighten()/resolveGoal() first sees the manche as truly settled —
  // see those two functions for the actual comparison call.
  let devHeadlessExpected = null;

  // ---------- Post-shot straighten ----------
  // Contact torque (see rotVel in physicsStep) leaves stones spun away from
  // their upright rest orientation once a shot settles. Before the next aim
  // phase they spin back upright via the shortest angular path, each on its
  // own randomized start offset so the six stones don't snap back as one
  // synchronized machine. Only runs between shots within a round — a fresh
  // round's stones come from resetPositions() already upright (rot: 0), so
  // the very first aim phase of a round skips this entirely.
  // off for now — feature on hold, code kept in place for a later re-enable
  const STRAIGHTEN_ENABLED = false;
  const STRAIGHTEN_STAGGER_MS = 2000, STRAIGHTEN_DURATION_MS = 1000;
  let straightenStart = 0;
  function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function beginStraighten() {
    // Dev self-check (see diffMancheResults) — this is the "manche settled
    // without scoring" side of the comparison; goalResult is null here by
    // construction (a scoring settle goes through resolveGoal() instead).
    if (import.meta.env.DEV && !isReplay && devHeadlessExpected) {
      diffMancheResults('headless vs real (no-goal settle)', devHeadlessExpected, quantizeMancheResult(entities, null));
      devHeadlessExpected = null;
    }
    // Curling: a point is a fixed CURLING_CYCLES_PER_POINT manches, not
    // "however many until a goal" — once the last one settles without
    // (early) wipeout, resolve who's closest instead of continuing to the
    // next manche. See CURLING_CYCLES_PER_POINT/curlingCycle above.
    if (vibe === 'curling') {
      curlingCycle++;
      if (curlingCycle >= CURLING_CYCLES_PER_POINT) { resolveCurlingPoint(); return; }
      tryAdvanceAfterManche(beginAimPhase);
      return;
    }
    // This function only ever runs when a manche settles *without* scoring
    // (see runSimTick) — i.e. "continue to the next manche of the same
    // point", the manche-level counterpart to onGoal's replayPointAdvancePending
    // for point boundaries. Bumping the cursor here, right before
    // beginAimPhase() shows/plays that next manche, is what keeps it
    // pointing at "the manche actually on screen" for that manche's whole
    // lifetime instead of jumping ahead the instant it launches.
    if (isReplay) replayCursor.mancheIdx++;
    if (!STRAIGHTEN_ENABLED) { tryAdvanceAfterManche(beginAimPhase); return; }
    const stones = [...entities.A, ...entities.B].filter(g => !g.out);
    let anyWork = false;
    for (const g of stones) {
      const from = g.rot || 0;
      const to = Math.round(from / (Math.PI * 2)) * Math.PI * 2; // nearest upright = shortest path
      g._straightenFrom = from;
      g._straightenTo = to;
      g._straightenDelay = Math.random() * STRAIGHTEN_STAGGER_MS;
      g._straightenDuration = STRAIGHTEN_DURATION_MS;
      if (Math.abs(to - from) > 1e-4) anyWork = true;
    }
    // Dead code while STRAIGHTEN_ENABLED is false (the branch above always
    // returns first) — routed through the same sync-check gate as that
    // branch so this stays correct if the feature is ever re-enabled.
    if (!anyWork) { tryAdvanceAfterManche(beginAimPhase); return; }
    straightenStart = performance.now();
    phase = 'straighten';
  }
  function updateStraighten() {
    const elapsed = performance.now() - straightenStart;
    let allDone = true;
    for (const g of [...entities.A, ...entities.B]) {
      if (g.out || g._straightenTo === undefined) continue;
      const t = (elapsed - g._straightenDelay) / g._straightenDuration;
      if (t <= 0) { g.rot = g._straightenFrom; allDone = false; }
      else if (t < 1) { g.rot = g._straightenFrom + (g._straightenTo - g._straightenFrom) * easeInOutQuad(t); allDone = false; }
      else { g.rot = g._straightenTo; }
    }
    if (allDone) {
      for (const g of [...entities.A, ...entities.B]) {
        g._straightenFrom = g._straightenTo = g._straightenDelay = g._straightenDuration = undefined;
      }
      tryAdvanceAfterManche(beginAimPhase);
    }
  }

  // How long the losing stones sit grey/desaturated (deadMix, see drawStone)
  // before the point panel shows — set directly here rather than a plain
  // .dead flag, since .dead is what physicsStep's deadPending block treats as
  // "knocked out, shrink into the void once settled" (see registerStoneHit) —
  // these stones didn't die, they just lost the point, so they stay fully
  // visible on the ice, just recolored. beginRoundReset()/updateRoundReset()
  // already fade any nonzero deadMix back to 0 while sliding stones back to
  // their kickoff spot (see g._reviveFrom there), so no separate revive logic
  // is needed here — the very next round reset undoes this for free.
  const CURLING_REVEAL_MS = 2000;
  // Curling-only scoring: after CURLING_CYCLES_PER_POINT manches (see
  // beginStraighten above), whichever alive (!dead, !out) stone sits closest
  // to the target's own center (CENTER_X/CY — same spot the hexagon used to
  // occupy) wins the point for its team. Reuses onGoal()/resolveGoal()
  // verbatim below (the +1 panel, WIN_SCORE check, beginRoundReset) exactly
  // like a real goal would — the "isWipeout" flag is always false here, a
  // curling point never has the classic wipeout SFX/framing even if one
  // team happens to have zero surviving stones by this point (see the
  // physicsStep 'wipeoutA'/'wipeoutB' early-exit above, which still applies
  // and reuses this same onGoal path if a team is fully wiped out before
  // all CURLING_CYCLES_PER_POINT manches even finish).
  function resolveCurlingPoint() {
    let bestTeam = null, bestStone = null, bestDist = Infinity;
    for (const team of ['A', 'B']) {
      for (const g of entities[team]) {
        if (g.dead || g.out) continue;
        const d = Math.hypot(g.x - CENTER_X, g.y - CY);
        if (d < bestDist) { bestDist = d; bestTeam = team; bestStone = g; }
      }
    }
    if (bestTeam) {
      // Every other still-alive stone (both teams, including the winning
      // team's own other two) reads as "lost this point" — grey out now so
      // it's visible under the reveal pause, not just implied by the panel.
      for (const g of [...entities.A, ...entities.B]) {
        if (g !== bestStone && !g.dead && !g.out) g.deadMix = 1;
      }
      // phase must flip to 'goal' in the same tick onGoal() is called (see
      // the identical pairing in runSimTick's 'sim' branch above) — leaving
      // it at 'sim' let runSimTick keep seeing an already-settled board every
      // frame and call beginStraighten() again and again, each time
      // re-entering here and replaying the goal SFX on top of itself with
      // nothing ever advancing (the bug this comment is fixing).
      phase = 'goal';
      onGoal(bestTeam, false, CURLING_REVEAL_MS);
      return;
    }
    // Every stone from both teams destroyed in the same manche this loses to
    // the physicsStep wipeout check are impossible (that returns earlier and
    // never reaches beginStraighten at all) — this is only reachable if
    // stonesPerTeam were ever 0, kept as a defensive fallback rather than an
    // assert so a future config change can't softlock the match here.
    tryAdvanceAfterManche(beginAimPhase);
  }

  // ---------- Round / goal flow ----------
  // Held after a goal before the board resets, so the ball's still visible
  // sitting in the net (and the goal/wipeout SFX has room to finish) instead
  // of the stones immediately snapping into their slide-back animation.
  const GOAL_PAUSE_MS = 3000;
  // A stone that died this manche (max hits or bar contact) only starts its
  // shrink-into-the-void animation once the whole manche is at rest (see the
  // deadPending block in physicsStep) and takes a few hundred ms to finish —
  // gates resolveGoal() below so the "point won" panel can never appear while
  // one is still visibly mid-vanish.
  function deadStonesStillAnimating(state = entities) {
    return state.A.some(g => g.dead && !g.out) || state.B.some(g => g.dead && !g.out);
  }
  let goalPauseElapsed = false;
  let goalPending = null;
  // Which goal bar (if either) is currently lit — set the instant the ball
  // touches it (see the ball branch in physicsStep's bar-hit check), cleared
  // in resolveGoal() right as the point actually gets displayed (goal panel
  // or replay-end ticket). 'left'/'right' rather than a team id since that's
  // what drawBarGlow needs to pick BAR_LEFT/BAR_RIGHT + the scoring team's
  // own HALO_RGB color (team B scores through the left bar, A through the right).
  let barGlowSide = null;
  // A stone dying on the bar gets its own short flash (see killStoneOnBar
  // below and drawStoneBarFlash) — independent of barGlowSide/drawBarGlow's
  // goal-scored glow, which stays lit through the whole celebration pause.
  // This is a one-shot timestamp + side, self-clears once FLASH_MS elapses.
  const STONE_FLASH_MS = 260;
  let stoneBarFlash = null; // { side: 'left'|'right', t0: number } | null
  function onGoal(scoringTeam, isWipeout, pauseMs = GOAL_PAUSE_MS) {
    // howTo: nothing to score against (no opponent team) — a stray shot that
    // wanders into the goal mouth is just silently put back on the ice
    // instead of running the real scoring/victory flow.
    if (howTo) { resetPositions(); beginAimPhase(); return; }
    if (isWipeout) audio.play('wipeout');
    else audio.play('goal', { volume: 0.447 }); // -7dB
    // Same GOAL_PAUSE_MS pause (or, for curling, resolveCurlingPoint's own
    // shorter CURLING_REVEAL_MS — pauseMs) whether the round continues or the
    // match just
    // ended — even a winning goal/wipeout is instantly resolved as a state
    // flip, but the shot's impact is still playing out (ball still sliding
    // into the net, other stones bouncing/squishing) and phase stays 'goal'
    // through this wait so physicsStep keeps running (see loop()) and lets
    // that finish before we cut to either the next round or the result panel.
    // The score itself is bumped only once that wait is over too — scoreA/B
    // feed the scoreboard digits every frame regardless of phase, so
    // incrementing them here immediately would flash the new score on the
    // board a full GOAL_PAUSE_MS before the result panel shows it.
    goalPending = { scoringTeam, isWipeout };
    goalPauseElapsed = false;
    trackedTimeout(() => { goalPauseElapsed = true; }, pauseMs);
  }
  // Runs once GOAL_PAUSE_MS has elapsed AND no dead stone from this manche is
  // still mid-disappear — polled from runSimTick's 'goal' phase branch below
  // instead of a plain setTimeout body, since a long-settling manche can
  // outlast the fixed pause.
  function resolveGoal() {
    const { scoringTeam, isWipeout } = goalPending;
    goalPending = null;
    // Dev self-check (see diffMancheResults) — the scoring-settle side of the
    // comparison; reconstructs the same 'goalA'/'wipeoutB'/etc string
    // physicsStep() itself returns, matching what computeMancheResult stored.
    if (import.meta.env.DEV && !isReplay && devHeadlessExpected) {
      const actualGoalResult = (isWipeout ? 'wipeout' : 'goal') + scoringTeam;
      diffMancheResults('headless vs real (goal settle)', devHeadlessExpected, quantizeMancheResult(entities, actualGoalResult));
      devHeadlessExpected = null;
    }
    barGlowSide = null; // bar stays lit through the whole pause/settle wait, cut right as the point is actually displayed below
    if (!isReplay) recorder.finishPoint(scoringTeam, isWipeout);
    if (scoringTeam === 'A') scoreA++; else scoreB++;
    if (isReplay) {
        // "End of replay" is "we've played through the last recorded point",
        // never the live WIN_SCORE check — a single shared point, or a
        // ticket's handful of highlighted points, won't generally reach it.
        const isLastPoint = replayCursor.pointIdx >= replayAllPoints.length - 1;
        if (isLastPoint) {
          showReplayEndTicket();
        } else {
          // Don't advance replayCursor/rebuild the segments yet — the
          // repositioning animation about to play (beginRoundReset) is still
          // this point's own scoring moment finishing out, not the next
          // point starting. The segment bar should keep showing this point's
          // last segment lit through all of that; only beginAimPhase(),
          // right as the next point's first manche is about to launch, is
          // the real "point 2 starts here" moment (see the flag below).
          replayPointAdvancePending = true;
          // No goal panel to click through between points in replay mode —
          // the playback bar already conveys progress; just clear the flag
          // beginRoundReset() sets so maybeAdvanceRound() isn't stuck waiting
          // on a dismiss that will never come.
          beginRoundReset();
          goalPanelDismissed = true;
        }
        return;
      }
      const isMatchWin = scoreA >= WIN_SCORE || scoreB >= WIN_SCORE;
      if (isMatchWin) {
        showVictory();
      } else {
        round++;
        // Both fire at once and run independently: beginRoundReset() keeps its
        // existing timing/animation untouched, the panel just sits on top of it
        // (mostly hiding it, same #overlay backdrop as any other dialog here).
        // The next aim phase (and its turn timer) only starts once the slide
        // animation AND the panel dismiss have both happened — see
        // maybeAdvanceRound(), called from both updateRoundReset() and the
        // panel's click handler below, whichever finishes last.
        beginRoundReset();
        showGoalPanel(scoringTeam);
      }
  }

  // ---------- Result panel (goal / match win) ----------
  // Same shared #overlay component as the exit-confirm dialog and every other
  // dialog in this file — a big identicon (raw, not the on-board hex bubble,
  // so it reads clearly at this size) with the team's handle/"Guest"/shortened
  // address underneath (IDENTICON_LABEL takes priority — see its own comment
  // above — else formatAddressShort's "abc…xyz", same convention as the
  // sidebar identity pill's shortenAddressCompact in main.js), a colored badge
  // next to the identicon ("+1" mid-match, "GAGNÉ"/"PERDU" on the deciding
  // goal — this one alone keeps the teamA/teamB accent color), and the
  // updated score below that. Address/score text color isn't set here at
  // all — see the CSS comment on .goal-address for why (inherits the mode
  // tint's own ambient ink color instead of a team color).
  const RESULT_IDENTICON_SIZE = 512; // its own cache entry, distinct from the stone bake's no-background variant (see getIdenticonCanvasStoneBust)
  function resultPanelHtml(team, badgeCls, badgeLabel, extraHtml) {
    return `
      <div class="goal-identicon-wrap">
        <img class="goal-identicon" id="goalIdenticonImg" alt="">
        <span class="goal-badge ${badgeCls}">${badgeLabel}</span>
      </div>
      <div class="goal-address">${IDENTICON_LABEL[team] || formatAddressShort(IDENTICON_ADDRESS[team])}</div>
      <div class="goal-score">
        <span class="goal-score-a">${scoreA}</span><span class="goal-score-sep">–</span><span class="goal-score-b">${scoreB}</span>
      </div>
      ${extraHtml || ''}
    `;
  }
  function fillResultIdenticon(team) {
    getIdenticonPngDataUrl(IDENTICON_ADDRESS[team], RESULT_IDENTICON_SIZE).then((url) => {
      const img = document.getElementById('goalIdenticonImg');
      if (img) img.src = url; // guard: overlay may already have moved on by the time this resolves
    });
  }

  let roundResetAnimDone = false;
  let goalPanelDismissed = false;
  function maybeAdvanceRound() {
    if (roundResetAnimDone && goalPanelDismissed) tryAdvanceAfterManche(beginAimPhase);
  }
  function showGoalPanel(scoringTeam) {
    const cls = scoringTeam === 'A' ? 'a' : 'b';
    // Nature ambience pauses under the +1 panel — restarts the instant the
    // player dismisses it below, back into the next round.
    audio.stopAmbience();
    audio.play('pointOk', { volume: 0.315 }); // was 0.45, -30%
    // Tinted by whichever team just scored (blue for A, gold for B — see
    // style.css's #overlay.team-a-scored/.team-b-scored), not by mode/vibe:
    // this panel is the one place in a live match where "who scored" matters
    // more than "which game we're playing" (see conversation — deliberately
    // decoupled from the vibe/mode-select tint system everything else uses,
    // including this same #overlay element's own exit-confirm dialog in
    // main.js's showLobby()). Toggled directly here rather than in
    // showOverlay() itself, since victory/disconnect/replay-loading overlays
    // elsewhere in this file still want the plain dark scrim. goal-box-70
    // shrinks just the box to 70% of the full-bleed size (see style.css) —
    // identicon/badge/address/score inside are untouched.
    const teamTintClass = scoringTeam === 'A' ? 'team-a-scored' : 'team-b-scored';
    overlay.classList.add(teamTintClass, 'goal-box-70');
    showOverlay(resultPanelHtml(scoringTeam, cls, '+1'));
    fillResultIdenticon(scoringTeam);
    // Click-anywhere dismiss (no buttons here) — closing early doesn't rush
    // beginAimPhase(): maybeAdvanceRound() still waits on the slide animation
    // if that hasn't finished yet.
    overlay.addEventListener('click', () => {
      hideOverlay();
      overlay.classList.remove(teamTintClass, 'goal-box-70');
      audio.playAmbience();
      goalPanelDismissed = true;
      maybeAdvanceRound();
    }, { once: true, signal });
  }
  // Match-win panel: the shareable "ticket" (see src/ticket.js) doubles as
  // this panel itself, per design brief — shows both teams' objective result
  // (score + winner), not a personalized "gagné/perdu" like the old panel, so
  // LAN opponents can look at the exact same ticket without inconsistency.
  async function showVictory() {
    phase = 'gameover';
    // Same rule as showGoalPanel()'s +1 panel: the winning goal is also a
    // point panel, just the last one — ambience must not keep humming behind
    // the ticket screen (it previously only ever got silenced by clicking
    // "Menu", which explicitly called stopAmbience() itself; "Rejouer" below
    // resumes it for the fresh match).
    audio.stopAmbience();
    audio.stopAllGlides();
    audio.play('pointOk', { volume: 0.315 }); // was 0.45, -30% — ticket2 fanfare removed
    const winningTeam = scoreA >= WIN_SCORE ? 'A' : 'B';
    showOverlay(`<p>Generating ticket…</p>`);
    const stats = {
      durationMs: performance.now() - matchStartTime,
      goals: scoreA + scoreB,
      collisions: totalCollisions,
      bestShotPercent: Math.min(100, (bestShotSpeed / (MAX_DRAG * POWER_SCALE)) * 100),
      stonesDestroyed,
    };
    // Up to MAX_POINTS_ON_TICKET points get a clickable replay QR baked onto
    // the ticket (see src/ticket.js + src/replay.js) — a full 50-point match
    // doesn't fit reliably in a QR (see CLAUDE.md), so a long match shows its
    // most recent points rather than all of them; short matches show every point.
    const allPoints = recorder.getPoints();
    const ticketPoints = allPoints.length <= MAX_POINTS_ON_TICKET ? allPoints : allPoints.slice(-MAX_POINTS_ON_TICKET);
    const ticketCanvas = await renderTicket({
      scoreA, scoreB,
      teamA: { address: IDENTICON_ADDRESS.A },
      teamB: { address: IDENTICON_ADDRESS.B },
      winner: winningTeam,
      stats,
      points: ticketPoints,
    });
    // Rejouer/Menu (or a LAN disconnect) may have already moved the overlay on
    // by the time this async render resolves — don't stomp on it.
    if (phase !== 'gameover') return;
    showOverlay(`
      <div class="ticket-wrap" id="ticketWrap">
        <img class="ticket-img" id="ticketImg" alt="Nim-Curl match ticket">
      </div>
      <div class="goal-actions">
        <button class="bigbtn" id="goalPlayAgainBtn">▶ Play Again</button>
        ${onChangeSettings ? '<button class="bigbtn" id="goalChangeSettingsBtn">⚙ Change Settings</button>' : ''}
        <button class="bigbtn" id="goalMatchReplayBtn">🔁 Replay</button>
        <button class="bigbtn" id="goalShareBtn">📤 Share</button>
        <button class="bigbtn" id="goalMenuBtn">🚪 Menu</button>
      </div>
    `);
    document.getElementById('ticketImg').src = ticketCanvas.toDataURL('image/png');
    // Each point QR baked onto the ticket is also directly clickable on the
    // same device (no second phone needed to scan it) — see CLAUDE.md replay
    // section. Covers the whole tile column (QR + label), not just the QR
    // pixels, for a comfortable hit target.
    const ticketWrap = document.getElementById('ticketWrap');
    ticketPoints.forEach((point, i) => {
      const rect = pointTileRect(i);
      const a = document.createElement('a');
      a.className = 'ticket-point-hit';
      a.href = buildReplayUrl(point);
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.left = `${(rect.tileX / TICKET_W) * 100}%`;
      a.style.width = `${(rect.tileW / TICKET_W) * 100}%`;
      a.style.top = `${(POINTS_SECTION_Y / TICKET_H) * 100}%`;
      a.style.height = `${(POINTS_SECTION_H / TICKET_H) * 100}%`;
      ticketWrap.appendChild(a);
    });
    // PLAY AGAIN: same matchConfig this instance was already started with
    // (WIN_SCORE/TURN_TIMER_MS/ACTIVE_STONE_SLOTS/skin never change mid-
    // instance) — an in-place reset, no new startGame() needed. Net mode:
    // deliberately no extra ready-handshake here (see conversation) — same
    // best-effort behavior "Rejouer" already had, each side's own tap just
    // resets its own board locally, matching net mode's existing "both
    // clients simulate independently" model.
    document.getElementById('goalPlayAgainBtn').onclick = () => {
      audio.play('button');
      scoreA = 0; scoreB = 0; round = 1;
      sweep.A.used = false; sweep.B.used = false; sweep.A.rockClicked = false; sweep.B.rockClicked = false;
      matchStartTime = performance.now();
      totalCollisions = 0; bestShotSpeed = 0; stonesDestroyed = 0;
      recorder.reset();
      resetSharedMatchChrome();
      // Net mode only — the match that just ended already settled its own
      // last manche (a win only ever resolves after that), so these are
      // realistically already at rest, but reset explicitly rather than
      // trust that: an in-place restart like this one doesn't get a fresh
      // closure to fall back on if any of it wasn't. chatMuted is
      // deliberately left alone — a real user preference for this session,
      // not leftover match state, see resetSharedMatchChrome's own comment.
      mancheValidated = true; currentMancheIndex = null; pendingMancheAdvance = null; syncWaitTimerActive = false;
      resetPositions(); beginAimPhase(); hideOverlay();
      // showVictory() above stopped it for the ticket screen — resume for
      // this fresh match (no matchIntro replay here, so no onEnded to do it).
      audio.playAmbience();
    };
    // CHANGE SETTINGS: tear this instance down and hand back to main.js,
    // which owns the Custom Settings screen (outside this closure) — same
    // teardown as Menu, just a different landing spot. For a net match this
    // also closes the socket (see stopGame()), so the opponent naturally
    // sees the existing "opponent left" screen rather than a new protocol.
    if (onChangeSettings) {
      document.getElementById('goalChangeSettingsBtn').onclick = () => {
        audio.play('button');
        stopGame();
        onChangeSettings();
      };
    }
    // REPLAY: replays this just-finished match from the in-memory points
    // recorder.js already captured (recordManche/finishPoint), reusing the
    // exact same replay engine as an uploaded ticket (see CLAUDE.md replay
    // section) — but sourced directly from memory, bypassing the
    // binary/QR round-trip entirely, so it works regardless of the 3-stone
    // hardcoding in replay.js's encode/decode (out of scope, untouched —
    // see conversation). Passes this same matchConfig through so a Custom
    // match (any stonesPerTeam/pointsToWin/turnTime/skin) replays exactly
    // as played, not as whatever Classic defaults to.
    document.getElementById('goalMatchReplayBtn').onclick = () => {
      audio.play('button');
      const pointsToReplay = recorder.getPoints();
      stopGame();
      startGame({ onRockSound, onRockExit, onRockPower, onExit, matchConfig, mobile, identiconAddress: IDENTICON_ADDRESS, identiconLabel: IDENTICON_LABEL, replayPoints: pointsToReplay });
    };
    document.getElementById('goalMenuBtn').onclick = () => { audio.play('button'); stopGame(); onExit?.(); };
    document.getElementById('goalShareBtn').onclick = async () => {
      audio.play('button');
      const shareBtn = document.getElementById('goalShareBtn');
      const resultText = `Score final sur Nim-Curl : ${scoreA}–${scoreB}`;
      const blob = await new Promise((resolve) => ticketCanvas.toBlob(resolve, 'image/png'));
      const file = blob && new File([blob], 'nimcurl-ticket.png', { type: 'image/png' });
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Nim-Curl', text: resultText }); }
        catch { /* user cancelled the native share sheet — nothing to do */ }
      } else if (blob) {
        // Desktop browsers mostly can't share files yet — download the ticket instead.
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'nimcurl-ticket.png';
        a.click();
        URL.revokeObjectURL(url);
      } else if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(`${resultText} ${location.href}`);
          const original = shareBtn.textContent;
          shareBtn.textContent = 'Copied!';
          trackedTimeout(() => { shareBtn.textContent = original; }, 1500);
        } catch { /* e.g. document lost focus right as this fired — nothing to do */ }
      }
    };
  }

  // Replay-variant end screen — same ticket visual as a live match's victory
  // panel, but no "Partager"/save action (this is already a replay of a
  // saved match, see CLAUDE.md replay vocabulary) and "Revoir" restarts the
  // same assembled points from the top instead of a brand-new match.
  async function showReplayEndTicket() {
    phase = 'gameover';
    audio.play('win');
    hideReplayBar();
    const winningTeam = scoreA >= scoreB ? 'A' : 'B';
    showOverlay(`<p>Loading…</p>`);
    const stats = {
      durationMs: performance.now() - matchStartTime,
      goals: scoreA + scoreB,
      collisions: totalCollisions,
      bestShotPercent: Math.min(100, (bestShotSpeed / (MAX_DRAG * POWER_SCALE)) * 100),
      stonesDestroyed,
    };
    const ticketCanvas = await renderTicket({
      scoreA, scoreB,
      teamA: { address: IDENTICON_ADDRESS.A },
      teamB: { address: IDENTICON_ADDRESS.B },
      winner: winningTeam,
      stats,
      points: [], // a replay of a replay doesn't offer further point QRs
    });
    if (phase !== 'gameover') return;
    showOverlay(`
      <img class="ticket-img" id="ticketImg" alt="Replay ticket">
      <div class="goal-actions">
        <button class="bigbtn" id="goalReplayAgainBtn">🔁 Watch Again</button>
        <button class="bigbtn" id="goalMenuBtn">🚪 Menu</button>
      </div>
    `);
    document.getElementById('ticketImg').src = ticketCanvas.toDataURL('image/png');
    document.getElementById('goalReplayAgainBtn').onclick = () => {
      audio.play('button');
      scoreA = 0; scoreB = 0;
      replayCursor = { pointIdx: 0, mancheIdx: 0 };
      replayPlaying = true;
      sweep.A.used = false; sweep.B.used = false; sweep.A.rockClicked = false; sweep.B.rockClicked = false;
      resetPositions(); hideOverlay(); showReplayBar(); beginAimPhase();
    };
    // See replayExitBtn's own comment above: no navigation, just strip a
    // still-present ?replay= param so a future real refresh doesn't
    // relaunch this same replay.
    document.getElementById('goalMenuBtn').onclick = () => {
      audio.play('button');
      history.replaceState(null, '', location.pathname);
      stopGame();
      onExit?.();
    };
  }

  // No more "ready" gate/button between rounds — the board resets itself:
  // stones still on the ice slide back to their starting spots; stones that
  // fell into the goal instead reappear directly at their spot and grow in
  // place (fallScale 0 -> 1, the reverse of the shrink-into-the-void fall
  // animation) — no slide, since they weren't anywhere sensible on the ice to
  // slide from. Dead stones fade their color back in throughout either way.
  const ROUND_RESET_MOVE_MS = 2000;
  const ROUND_RESET_REVIVE_MS = 1000;
  let roundResetStart = 0;
  function beginRoundReset() {
    // Gates the eventual beginAimPhase() call in updateRoundReset() — see
    // maybeAdvanceRound()/showGoalPanel(), fired alongside this same call.
    roundResetAnimDone = false;
    goalPanelDismissed = false;
    curlingCycle = 0; // new point starting — see CURLING_CYCLES_PER_POINT above
    // A real round boundary (goal/wipeout) — each team's single sweep
    // placement for the round to come is available again.
    sweep.A.used = false; sweep.B.used = false; sweep.A.rockClicked = false; sweep.B.rockClicked = false;
    for (const g of [...entities.A, ...entities.B]) {
      const idx = parseInt(g.id.slice(1), 10) || 0;
      const target = startPositions[g.team][idx];
      g._resetGrow = g.out;
      // fell in: "from" == target, so the position lerp below is a no-op and
      // it just grows in place; still on the ice: slides from where it is.
      g._resetFromX = g._resetGrow ? target.x : g.x;
      g._resetFromY = g._resetGrow ? target.y : g.y;
      g._resetFromRot = g._resetGrow ? 0 : (g.rot || 0);
      g._resetToX = target.x; g._resetToY = target.y;
      g.out = false; g.falling = false;
      g.fallScale = g._resetGrow ? 0 : 1;
      g.vx = 0; g.vy = 0;
      g.used = false; g.pendingVx = 0; g.pendingVy = 0;
      g.hits = 0; g._hitCooldown = 0;
      g.squish = 0; g.squishPhase = null; g.squishT = 0; g.squishPeak = 0;
      g._reviveFrom = g.dead ? 1 : g.deadMix;
      g.dead = false;
    }
    const b = entities.ball;
    b._resetGrow = b.out;
    b._resetFromX = b._resetGrow ? CENTER_X : b.x;
    b._resetFromY = b._resetGrow ? CY : b.y;
    b.out = false; b.falling = false;
    b.fallScale = b._resetGrow ? 0 : 1;
    b.vx = 0; b.vy = 0;
    roundResetStart = performance.now();
    phase = 'roundReset';
    // Safety net: updateRoundReset() only ever runs from inside loop()'s own
    // requestAnimationFrame, which a backgrounded/hidden tab can starve of
    // frames for the whole animation (rAF pauses, but setTimeout doesn't) —
    // without this, a stone/ball that fell in stays stuck invisible at
    // fallScale 0 forever, since nothing else ever finalizes it. This forces
    // one last call after the animation's nominal duration has really
    // elapsed; updateRoundReset() itself is a no-op once already finished
    // (see the guard at its top), so this is safe to fire even when rAF
    // handled everything normally.
    trackedTimeout(() => { if (phase === 'roundReset') updateRoundReset(); }, ROUND_RESET_MOVE_MS + 150);
  }
  function updateRoundReset() {
    // phase deliberately stays 'roundReset' until the goal panel is
    // dismissed (see maybeAdvanceRound/showGoalPanel), which is often many
    // frames after the slide/grow animation itself already finished — but
    // loop() keeps calling this every one of those frames regardless. Once
    // finalized, _resetFromX/_resetToX etc. are cleared to undefined, so
    // re-running the interpolation below would corrupt every stone's (and
    // the ball's) position. Bail out immediately once done; only the next
    // beginRoundReset() call clears this flag again.
    if (roundResetAnimDone) return;
    const elapsed = performance.now() - roundResetStart;
    const moveT = easeInOutQuad(Math.min(1, elapsed / ROUND_RESET_MOVE_MS));
    const reviveT = easeInOutQuad(Math.min(1, elapsed / ROUND_RESET_REVIVE_MS));
    for (const g of [...entities.A, ...entities.B]) {
      g.x = g._resetFromX + (g._resetToX - g._resetFromX) * moveT;
      g.y = g._resetFromY + (g._resetToY - g._resetFromY) * moveT;
      g.rot = g._resetFromRot * (1 - moveT);
      if (g._resetGrow) g.fallScale = moveT;
      g.deadMix = g._reviveFrom * (1 - reviveT);
    }
    const b = entities.ball;
    b.x = b._resetFromX + (CENTER_X - b._resetFromX) * moveT;
    b.y = b._resetFromY + (CY - b._resetFromY) * moveT;
    if (b._resetGrow) b.fallScale = moveT;
    if (moveT >= 1) {
      for (const g of [...entities.A, ...entities.B]) {
        g.x = g._resetToX; g.y = g._resetToY; g.rot = 0; g.fallScale = 1; g.deadMix = 0;
        g._resetFromX = g._resetFromY = g._resetToX = g._resetToY = undefined;
        g._resetFromRot = g._resetGrow = g._reviveFrom = undefined;
      }
      b.x = CENTER_X; b.y = CY; b.fallScale = 1;
      b._resetFromX = b._resetFromY = b._resetGrow = undefined;
      // Doesn't call beginAimPhase() directly — the goal panel shown alongside
      // beginRoundReset() (see onGoal) may still be up, and the next aim
      // phase/turn timer should only start once that's been dismissed too.
      roundResetAnimDone = true;
      maybeAdvanceRound();
    }
  }

  // ---------- Network sync rollback (see CLAUDE.md determinism work) ----------
  // Same slide/revive tween as beginRoundReset/updateRoundReset above, but
  // targeting the manche's own pre-shot snapshot (mancheStartSnapshot)
  // instead of the round's fixed kickoff formation — a manche invalidated
  // mid-round can leave stones with accumulated hits/lost stones from
  // *earlier* manches of the same point, so "go back to the start" here means
  // "back to this manche's own start", not hits=0/everyone alive. Kept as its
  // own separate function rather than parameterizing beginRoundReset() itself
  // — that one is a delicate, already-tuned round boundary (sweep/goal-panel
  // gating) this shouldn't risk disturbing for what's meant to be a rare,
  // narrowly-scoped correction path.
  const MANCHE_ROLLBACK_MOVE_MS = 2000;
  const MANCHE_ROLLBACK_REVIVE_MS = 1000;
  let mancheRollbackStart = 0;
  function beginMancheRollback() {
    // Always interrupt, unconditionally (see conversation) — even if the
    // local player has already started dragging the next manche's shot by
    // the time this rare verdict arrives.
    if (drag && !mobile) document.body.style.cursor = '';
    drag = null; selectedStone = null; pendingTap = null; joystickDrag = null;
    // This invalidated manche never got (and now never will get) its own
    // mancheValid — clear its gate state so we don't sit permanently blocked
    // waiting on a verdict that's not coming, and so a stray already-scheduled
    // "still waiting" toast (see tryAdvanceAfterManche) can't reappear after
    // we've already moved on to re-aiming.
    mancheValidated = true;
    pendingMancheAdvance = null;
    syncWaitTimerActive = false;
    currentMancheIndex = null;
    audio.stopAllGlides(); // whatever glide voice was mid-shot has nothing left to animate toward
    hideSyncToast();
    showSyncProblem();
    const snap = mancheStartSnapshot;
    if (!snap) { beginAimPhase(); return; } // defensive: never hang if there's somehow nothing to roll back to
    sweep.A.used = snap.sweepUsed.A; sweep.B.used = snap.sweepUsed.B;
    sweep.A.rockClicked = snap.sweepRockClicked.A; sweep.B.rockClicked = snap.sweepRockClicked.B;
    for (const g of [...entities.A, ...entities.B]) {
      const idx = parseInt(g.id.slice(1), 10) || 0;
      const target = snap.entities[g.team][idx];
      // Only "grow back in place" if the snapshot says it should be visible
      // but it isn't right now (this manche made it fall/die) — a stone
      // already out at snapshot time (lost in an earlier manche of the same
      // point) stays out, no animation; one still on the ice both before and
      // after just slides to its snapshot spot.
      g._resetGrow = !target.out && g.out;
      g._resetFromX = g._resetGrow ? target.x : g.x;
      g._resetFromY = g._resetGrow ? target.y : g.y;
      g._resetFromRot = g._resetGrow ? 0 : (g.rot || 0);
      g._resetToX = target.x; g._resetToY = target.y;
      g.out = target.out; g.falling = false;
      g.fallScale = g._resetGrow ? 0 : 1;
      g.vx = 0; g.vy = 0;
      g.used = false; g.pendingVx = 0; g.pendingVy = 0;
      g.hits = target.hits; g._hitCooldown = 0;
      g.squish = 0; g.squishPhase = null; g.squishT = 0; g.squishPeak = 0;
      g._reviveFrom = g.dead ? 1 : g.deadMix;
      g.dead = target.dead;
    }
    const b = entities.ball;
    const ballTarget = snap.entities.ball;
    b._resetGrow = !ballTarget.out && b.out;
    b._resetFromX = b._resetGrow ? ballTarget.x : b.x;
    b._resetFromY = b._resetGrow ? ballTarget.y : b.y;
    b._resetToX = ballTarget.x; b._resetToY = ballTarget.y;
    b.out = ballTarget.out; b.falling = false;
    b.fallScale = b._resetGrow ? 0 : 1;
    b.vx = 0; b.vy = 0;
    mancheRollbackStart = performance.now();
    phase = 'mancheRollback';
    // Safety net, same reasoning as beginRoundReset's own — a backgrounded
    // tab can starve rAF for the whole animation window.
    trackedTimeout(() => { if (phase === 'mancheRollback') updateMancheRollback(); }, MANCHE_ROLLBACK_MOVE_MS + 150);
  }
  function updateMancheRollback() {
    if (phase !== 'mancheRollback') return; // already finalized (safety-net timeout firing after the real thing)
    const elapsed = performance.now() - mancheRollbackStart;
    const moveT = easeInOutQuad(Math.min(1, elapsed / MANCHE_ROLLBACK_MOVE_MS));
    const reviveT = easeInOutQuad(Math.min(1, elapsed / MANCHE_ROLLBACK_REVIVE_MS));
    for (const g of [...entities.A, ...entities.B]) {
      g.x = g._resetFromX + (g._resetToX - g._resetFromX) * moveT;
      g.y = g._resetFromY + (g._resetToY - g._resetFromY) * moveT;
      g.rot = g._resetFromRot * (1 - moveT);
      if (g._resetGrow) g.fallScale = moveT;
      g.deadMix = g._reviveFrom * (1 - reviveT);
    }
    const b = entities.ball;
    b.x = b._resetFromX + (b._resetToX - b._resetFromX) * moveT;
    b.y = b._resetFromY + (b._resetToY - b._resetFromY) * moveT;
    if (b._resetGrow) b.fallScale = moveT;
    if (moveT >= 1) {
      for (const g of [...entities.A, ...entities.B]) {
        g.x = g._resetToX; g.y = g._resetToY; g.rot = 0; g.fallScale = g.out ? 0 : 1; g.deadMix = 0;
        g._resetFromX = g._resetFromY = g._resetToX = g._resetToY = undefined;
        g._resetFromRot = g._resetGrow = g._reviveFrom = undefined;
      }
      b.x = b._resetToX; b.y = b._resetToY; b.fallScale = b.out ? 0 : 1;
      b._resetFromX = b._resetFromY = b._resetToX = b._resetToY = b._resetGrow = undefined;
      hideSyncToast();
      beginAimPhase();
    }
  }

  // ---------- Match-start intro: "match start" SFX + stones sliding in from
  // their own goal ----------
  // Only for a live match's very first entry into aiming — not each round's
  // own beginRoundReset (a scored point resets mid-match, it doesn't restart
  // it) and not replay playback. Both teams' 3 stones start stacked right in
  // front of their own goal (see matchIntroHuddlePos above), then slide out
  // to their real rack spot — same plain position lerp updateRoundReset()
  // uses for a stone that's still on the ice (no grow/fade, these stones
  // were never "dead").
  function beginMatchIntro() {
    matchIntroAnimDone = false;
    for (const g of [...entities.A, ...entities.B]) {
      const idx = parseInt(g.id.slice(1), 10) || 0;
      // howTo: "a single stone alone in the middle" (per explicit request) —
      // slot 1 is only the middle of team A's own 3-stone rack, near A's own
      // goal, not the arena's actual center, so it needs its own target here.
      const target = howTo ? { x: CENTER_X, y: CY } : startPositions[g.team][idx];
      const from = matchIntroHuddlePos(g.team, idx);
      g._resetFromX = from.x; g._resetFromY = from.y;
      g._resetToX = target.x; g._resetToY = target.y;
      g.x = g._resetFromX; g.y = g._resetFromY;
    }
    matchIntroStart = performance.now();
    phase = 'matchIntro';
    audio.playAmbience(); // starts together with matchStart below, fades in under it
    audio.play('matchStart', {
      volume: 0.562, // was 1 (default), -5dB
      onEnded: () => {
        if (phase === 'matchIntro') beginAimPhase(true);
      },
    });
    // Safety net mirroring beginRoundReset's own: updateMatchIntro() only
    // ever runs from inside loop()'s own requestAnimationFrame, which a
    // backgrounded/hidden tab can starve of frames for the whole animation —
    // without this, a tab that comes back mid-intro (audio keeps playing on
    // its own clock regardless, so beginAimPhase() can already have fired by
    // then) would leave every stone stuck at its stacked starting spot. This
    // normally fires *after* the tween has already finished on its own
    // (phase stays 'matchIntro' until the longer matchStart clip ends, not
    // just until the slide is done) — matchIntroAnimDone below is what makes
    // that redundant call a no-op instead of corrupting positions.
    trackedTimeout(() => { if (phase === 'matchIntro') updateMatchIntro(); }, MATCH_INTRO_MOVE_MS + 150);
  }
  function updateMatchIntro() {
    // Without this guard, a call after the tween already finalized (its
    // fields below are cleared to undefined right when that happens) would
    // compute undefined arithmetic and send every stone to NaN,NaN — silently
    // invisible, since a NaN-centered arc just doesn't draw. See beginMatchIntro's
    // safety-net setTimeout for the call site that actually hits this in the
    // normal (non-backgrounded-tab) case.
    if (matchIntroAnimDone) return;
    const elapsed = performance.now() - matchIntroStart;
    const moveT = easeInOutQuad(Math.min(1, elapsed / MATCH_INTRO_MOVE_MS));
    for (const g of [...entities.A, ...entities.B]) {
      g.x = g._resetFromX + (g._resetToX - g._resetFromX) * moveT;
      g.y = g._resetFromY + (g._resetToY - g._resetFromY) * moveT;
    }
    if (moveT >= 1) {
      for (const g of [...entities.A, ...entities.B]) {
        g.x = g._resetToX; g.y = g._resetToY;
        g._resetFromX = g._resetFromY = g._resetToX = g._resetToY = undefined;
      }
      matchIntroAnimDone = true;
    }
  }

  // ---------- How To tutorial (mobile only) ----------
  // Single stone, no opponent (see resetPositions/beginAimPhase/onValidate
  // above), stepping a beginner through 9 fixed beats: select -> aim -> play
  // -> ice boost -> position the ice -> slide on the ice -> bounce off a
  // wall -> basic laser -> quit (see src/howto.js for the copy). Reuses the
  // real aimA phase and every real input path (stone select/drag, joystick,
  // sweep placement/drag, the power button's basicLaser toggle) rather than
  // building a parallel input system — this block only *observes* that real
  // state each frame to decide when a step is done and what to spotlight,
  // via a DOM overlay living outside #stage-wrap (see index.html's comment
  // on why). Every DOM ref below is looked up fresh by id, same convention
  // already used everywhere else DOM elements get reparented on mobile (see
  // the mobile joystick reparent comment above) — resolves fine regardless
  // of current parent.
  let howToStep = 0;
  // True while the "basic laser" step's preset demo shot is up (see
  // howToStartLaserDemo) — blocks the player from grabbing the stone/stick
  // at all (see onPointerDown/onJoystickDown's own guards), since there's
  // nothing here for them to aim themselves.
  let howToAimLocked = false;
  // Set true the first time joystickDrag goes non-null during the "aim"
  // step, so a release only counts as "done aiming" once the stick was
  // actually engaged (not an accidental release with nothing to release).
  // The 2s hold-to-lock is just an informational aside for this step, not a
  // requirement — release alone advances, locked or not (per explicit
  // feedback: forcing a full hold read as an obstacle, not a lesson). Set by
  // a real mousedown/touchstart listener on #joystickRing (below), NOT by
  // polling joystickDrag inside syncHowTo — a render() frame only runs on
  // its own schedule, so polling can in principle miss a very quick
  // tap-and-release entirely (never once observing joystickDrag truthy),
  // which would leave this permanently false and the spotlight stuck on.
  // The real listener can't miss it — it fires synchronously with the touch.
  let howToJoystickWasDown = false;
  // Set true the first time sweepDrag goes non-null during the "position the
  // ice" step, so a release only counts as "done repositioning" once an
  // actual drag happened (not on an accidental release with no movement).
  let howToSweepDragSeen = false;
  // Last-observed isBasicLaser() value for the "basic laser" step — null
  // when not currently watching. Updated (not reset to null) on every
  // change, so howToLaserToggleCount below can count actual toggles rather
  // than just detecting "different from where it started".
  let howToLaserBaseline = null;
  // Requires 4 clicks, not 1, before advancing (per explicit request) — one
  // click alone only ever shows whichever style the player didn't already
  // have, never both; several clicks make the alternation itself the thing
  // being demonstrated rather than a single glance.
  let howToLaserToggleCount = 0;
  // Set by onValidate()'s howTo branch for the two steps that fire a real
  // shot (Play/Slide the ice) — the actual advance is then deferred to
  // onHowToAimPhase(), which only ever runs once the shot has fully settled
  // (see beginStraighten/tryAdvanceAfterManche), so the stone is always done
  // moving before the next step's spotlight shows — and only then does
  // scheduleHowToAdvance's own HOWTO_ADVANCE_DELAY_MS beat start (per
  // explicit feedback: never chain into the next step while something is
  // still visibly sliding). "je veux pas de timer" turned out to be about a
  // different, since-removed central timer — this one stays.
  let howToShotAdvancePending = false;
  // Guards scheduleHowToAdvance's trackedTimeout below against being armed
  // twice (e.g. a step's case still running one extra frame before
  // howToStepDone/phase suppress it).
  let howToAdvancePending = false;
  // True the instant any step's completion is first detected (a tap, a
  // release, a toggle) — per explicit feedback, the spotlight itself must
  // disappear right at that click, not linger through a shot still
  // settling; it only comes back once the next step's own case in
  // syncHowTo starts computing its own target fresh. Reset in
  // advanceHowTo() (mid-round step changes, e.g. select -> aim, never see
  // another onHowToAimPhase() call) and, conditionally, in onHowToAimPhase()
  // (see that function's own comment on why it's conditional there).
  let howToStepDone = false;
  const howToOverlayEl = document.getElementById('howToOverlay');
  const howToHoleEl = document.getElementById('howToHole');
  const howToCorridorEl = document.getElementById('howToCorridor');
  const howToCorridorBarEl = document.getElementById('howToCorridorBar');
  const howToCorridorGradEl = document.getElementById('howToCorridorGrad');
  const howToCorridorBlurEl = document.getElementById('howToCorridorBlurPrimitive');
  const howToCorridorSpotEl = document.getElementById('howToCorridorSpot');
  const howToTileEl = document.getElementById('howToTile');
  const howToTileCountEl = document.getElementById('howToTileCount');
  const howToTileTitleEl = document.getElementById('howToTileTitle');
  const howToTileTextEl = document.getElementById('howToTileText');
  const howToGotItBtnEl = document.getElementById('howToGotItBtn');
  // "Meet your stone" (step 0) cycles the real damage-LED state through all
  // 4 quadrants going dark one at a time, pausing on the last one's built-in
  // critical pulse (see stoneLedState/lastLedPulseStrength above — this
  // reuses that exact mechanic rather than faking a separate animation),
  // then resets and loops — entirely time-derived from performance.now(), no
  // per-frame state to track. STONE_HITS_PER_LED apart per stage: 0 hits (4
  // lit) -> ... -> STONE_MAX_HITS-1 (last LED, pulsing) -> back to 0.
  const HOWTO_LED_STAGE_MS = 1000;
  const HOWTO_LED_CYCLE_MS = HOWTO_LED_STAGE_MS * 6; // 4 stages to knock out LEDs 1-3, hold the last one's pulse, then a held "dead" (all 4 out) stage before looping
  function howToUpdateLedDemo(stone) {
    const t = performance.now() % HOWTO_LED_CYCLE_MS;
    const stage = Math.min(5, Math.floor(t / HOWTO_LED_STAGE_MS));
    if (stage === 5) {
      // Dead stage: all 4 LEDs out, same real g.dead/deadMix the physics
      // side sets on an actual knockout (see registerStoneHit) — reuses the
      // existing desaturated "dead" sprite blend rather than faking a look.
      stone.hits = STONE_MAX_HITS;
      stone.dead = true;
      stone.deadMix = 1;
    } else {
      stone.dead = false;
      stone.deadMix = 0;
      stone.hits = stage === 4 ? STONE_MAX_HITS - 1 : stage * STONE_HITS_PER_LED;
    }
  }
  // The one step with no game action gating it — dismissed by this tap
  // alone. Only ever reachable/relevant while howToStep === 0 (the button
  // itself is hidden every other step, see howToRenderTile), so no extra
  // guard needed here. Restores the stone to a fresh, undamaged look before
  // moving on — the LED demo above leaves g.hits wherever its cycle was.
  howToGotItBtnEl.addEventListener('click', () => {
    const stone = entities.A[0];
    if (stone) { stone.hits = 0; stone.dead = false; stone.deadMix = 0; }
    howToStepDone = true;
    scheduleHowToAdvance();
  }, { signal });
  // See howToJoystickWasDown's own comment — a real listener, not frame
  // polling, so a very quick tap-and-release on the stick can't slip past
  // unnoticed. Only ever meaningful during the 'aim' step, but harmless to
  // leave armed the rest of the time (a stray flip of an already-unused flag).
  document.getElementById('joystickRing').addEventListener('mousedown', () => { howToJoystickWasDown = true; }, { signal });
  document.getElementById('joystickRing').addEventListener('touchstart', () => { howToJoystickWasDown = true; }, { passive: true, signal });
  // Canvas-space (x,y) -> real screen px — the exact inverse of getPointerPos
  // above, needed here because the spotlight overlay is real page DOM (fixed
  // positioning, outside #stage-wrap) while the stone/ice-zone targets it
  // sometimes points at only exist in canvas logical space. `scale` is
  // screen-px-per-canvas-unit, for sizing a hole/corridor width from a
  // canvas-space radius (STONE_R, sweep.A.r) the same way.
  function howToCanvasToScreen(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    const offX = mobile ? MOBILE_CROP.x0 : 0, offY = mobile ? MOBILE_CROP.y0 : 0;
    const scaleX = cropW / rect.width, scaleY = cropH / rect.height;
    return { x: rect.left + (cx - offX) / scaleX, y: rect.top + (cy - offY) / scaleY, scale: 1 / scaleX };
  }
  // Fully clear up to r*0.7, dim by r*1.4, softly feathered in between (per
  // explicit request — a hard-edged cutout read as too sharp) — CSS holds a
  // radial-gradient's last color stop steady past it automatically, so
  // nothing extra is needed to cover the rest of the screen beyond outer.
  function howToSetHole(cx, cy, r) {
    howToCorridorEl.classList.add('hidden');
    howToHoleEl.classList.remove('hidden');
    const inner = r * 0.7, outer = r * 1.4;
    howToHoleEl.style.background = `radial-gradient(circle at ${cx}px ${cy}px, rgba(4,10,14,0) 0px, rgba(4,10,14,0) ${inner}px, rgba(4,10,14,0.78) ${outer}px)`;
  }
  // No spotlight this frame — the whole board stays fully lit (the fallback
  // whenever a step's target isn't currently showable, e.g. mid-drag).
  function howToClearHole() {
    howToHoleEl.classList.add('hidden');
    howToCorridorEl.classList.add('hidden');
    howToCorridorSpotEl.setAttribute('r', 0);
  }
  // Circular spot layered inside the corridor's own SVG mask, alongside
  // howToCorridorBar — see index.html's howToCorridorSpot/howToSpotGrad for
  // why this lives there instead of reusing howToSetHole's #howToHole div:
  // the two need to render at once for the "slide on ice" step (persistent
  // corridor + stick-then-play spot, per explicit request), and a mask's
  // shapes brighten additively so they don't fight over visibility the way
  // #howToHole and #howToCorridor otherwise mutually hide each other.
  // r here is the target's own bounding radius (same convention as
  // howToSetHole's callers) — scaled up by 1.4 to match its outer/dim edge.
  function howToShowCorridorSpot(cx, cy, r) {
    howToCorridorSpotEl.setAttribute('cx', cx);
    howToCorridorSpotEl.setAttribute('cy', cy);
    howToCorridorSpotEl.setAttribute('r', r * 1.4);
  }
  // Tile follows whatever's currently spotlighted (per explicit feedback —
  // a fixed corner read as disconnected from what each step was actually
  // pointing at). Placed beside the target's own screen point: to its right
  // when there's room for the tile there, its left otherwise (covers both
  // canvas-space targets, mostly left-of-center on the board, and the
  // control-section buttons hugging the right edge, which never have room
  // to their own right). Only ever called from a step actively showing a
  // target — the "waiting to advance" / no-target states leave the tile
  // wherever it last was rather than snapping it back to some default.
  // Measured from the target's own center point, not the spotlight's outer
  // edge (that radius varies per target — see howToSetHole's callers) — 18
  // sat well inside most spotlights' own feathered edge, per explicit
  // feedback ("juste à l'extérieur... trop proches"). 55 clears the
  // smallest control-button spotlights with a visible gap and doesn't leave
  // the biggest (the stone's) looking disconnected either.
  const HOWTO_TARGET_TILE_GAP_PX = 55;
  const HOWTO_TILE_WIDTH_PX = 190; // was 170, per explicit feedback (kept modest — see style.css's own font bump)
  function howToPositionTileNear(cx, cy) {
    howToTileEl.style.transform = 'translateY(-50%)';
    howToTileEl.style.width = `${HOWTO_TILE_WIDTH_PX}px`;
    if (window.innerWidth - cx >= HOWTO_TILE_WIDTH_PX + HOWTO_TARGET_TILE_GAP_PX) {
      howToTileEl.style.right = '';
      howToTileEl.style.left = `${cx + HOWTO_TARGET_TILE_GAP_PX}px`;
    } else {
      howToTileEl.style.left = '';
      howToTileEl.style.right = `${window.innerWidth - cx + HOWTO_TARGET_TILE_GAP_PX}px`;
    }
    const halfH = 55; // rough half-height guess, just to keep it from clipping off the top/bottom edge
    howToTileEl.style.top = `${Math.min(Math.max(cy, halfH), window.innerHeight - halfH)}px`;
  }
  function howToShowDomTarget(id, show) {
    if (!show) { howToClearHole(); return; }
    const el = document.getElementById(id);
    if (!el) { howToClearHole(); return; }
    const rect = el.getBoundingClientRect();
    if (!rect.width) { howToClearHole(); return; }
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    howToSetHole(cx, cy, Math.max(rect.width, rect.height) / 2 + 10);
    howToPositionTileNear(cx, cy);
  }
  function howToShowEntityTarget(entity, show) {
    if (!show) { howToClearHole(); return; }
    const p = howToCanvasToScreen(entity.x, entity.y);
    howToSetHole(p.x, p.y, entity.r * p.scale + 24);
    howToPositionTileNear(p.x, p.y);
  }
  function howToShowSweepTarget(show) {
    if (!show) { howToClearHole(); return; }
    const sw = sweep.A;
    const p = howToCanvasToScreen(sw.x, sw.y);
    howToSetHole(p.x, p.y, sw.r * p.scale + 6);
    howToPositionTileNear(p.x, p.y);
  }
  // "Slide on the ice" step: a light corridor between the stone and the ice
  // zone, fading out at both ends rather than a hard-edged window (per
  // explicit request) — the one shape here that isn't a plain circle, so it
  // uses the SVG mask/gradient in index.html instead of #howToHole's
  // box-shadow trick. Positions/rotates the mask's own rect + gradient to
  // the live stone->zone axis every frame (the zone can still be sitting
  // wherever step 4bis left it).
  // Ray from (ox,oy) in direction (ux,uy), canvas-space, to where it first
  // crosses the field boundary (FX0/FX1/FY0/FY1) — the standard slab method,
  // just the one intersection this needs (t is always >= 0 in practice
  // since the origin is always inside the field). Used to stretch the
  // "slide on the ice" corridor past the ice zone to the arena edge (see
  // howToShowCorridor) instead of stopping at the zone itself.
  function howToRayToArenaEdge(ox, oy, ux, uy) {
    let t = Infinity;
    if (ux > 0) t = Math.min(t, (FX1 - ox) / ux);
    else if (ux < 0) t = Math.min(t, (FX0 - ox) / ux);
    if (uy > 0) t = Math.min(t, (FY1 - oy) / uy);
    else if (uy < 0) t = Math.min(t, (FY0 - oy) / uy);
    if (!isFinite(t) || t < 0) t = 0;
    return { x: ox + ux * t, y: oy + uy * t };
  }
  function howToShowCorridor(stone) {
    howToHoleEl.classList.add('hidden');
    howToCorridorEl.classList.remove('hidden');
    const sw = sweep.A;
    // Extends past the ice zone all the way to the arena edge in the aim
    // direction (per explicit request — "allonge jusqu'au bout de l'arène
    // côté visée") — reads as the stone's whole potential path, with the
    // ice zone just sitting somewhere along it, rather than stopping dead
    // at the zone.
    const dirLen = Math.hypot(sw.x - stone.x, sw.y - stone.y) || 1;
    const ux = (sw.x - stone.x) / dirLen, uy = (sw.y - stone.y) / dirLen;
    const edge = howToRayToArenaEdge(stone.x, stone.y, ux, uy);
    const p1 = howToCanvasToScreen(stone.x, stone.y);
    const p2 = howToCanvasToScreen(edge.x, edge.y);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    const width = stone.r * p1.scale * 2.6;
    const barLen = len + width * 2;
    const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
    howToCorridorBarEl.setAttribute('x', midX - barLen / 2);
    howToCorridorBarEl.setAttribute('y', midY - width / 2);
    howToCorridorBarEl.setAttribute('width', barLen);
    howToCorridorBarEl.setAttribute('height', width);
    howToCorridorBarEl.setAttribute('rx', width / 2);
    howToCorridorBarEl.setAttribute('transform', `rotate(${angleDeg} ${midX} ${midY})`);
    // Softens the corridor's long sides (per explicit request — a hard edge
    // read as too sharp there too, not just at the two ends the gradient
    // above already fades). Scaled off the corridor's own width so it reads
    // proportionally soft regardless of stone size/zoom.
    howToCorridorBlurEl.setAttribute('stdDeviation', `${width * 0.15}`);
    howToCorridorGradEl.setAttribute('x1', midX - barLen / 2);
    howToCorridorGradEl.setAttribute('y1', midY);
    howToCorridorGradEl.setAttribute('x2', midX + barLen / 2);
    howToCorridorGradEl.setAttribute('y2', midY);
    // Near the ice zone specifically (what the step's own text is actually
    // about), not the corridor's own midpoint — that now sits wherever
    // happens to be halfway to the arena edge, often nowhere near the zone.
    const zoneP = howToCanvasToScreen(sw.x, sw.y);
    howToPositionTileNear(zoneP.x, zoneP.y);
  }
  function howToRenderTile() {
    const step = HOWTO_STEPS[howToStep];
    howToTileCountEl.textContent = `${howToStep + 1}/${HOWTO_STEPS.length}`;
    howToTileTitleEl.textContent = step.title;
    howToTileTextEl.textContent = step.text;
    // Only step 0 ("meet your stone") has no game action to gate it — it's
    // dismissed by this pill alone (see its click handler below).
    howToGotItBtnEl.classList.toggle('hidden', howToStep !== 0);
  }
  function advanceHowTo() {
    if (howToStep >= HOWTO_STEPS.length - 1) return;
    howToStep++;
    howToJoystickWasDown = false;
    howToSweepDragSeen = false;
    howToLaserBaseline = null;
    howToLaserToggleCount = 0;
    howToStepDone = false;
    howToRenderTile();
    // Stages the 'laser' step's own demo shot the instant we arrive there —
    // see howToStartLaserDemo's own comment for why this step doesn't wait
    // on the player to aim anything itself.
    if (howToStep === 7) howToStartLaserDemo(entities.A[0]);
  }
  // Short beat before the next step's spotlight shows (per explicit
  // feedback — "il fallait garder le 1s", the earlier "je veux pas de
  // timer" was about a different, central timer, not this one). Guarded by
  // howToAdvancePending so a step whose case keeps running for one extra
  // frame after triggering this can't stack a second timeout on top.
  const HOWTO_ADVANCE_DELAY_MS = 1000;
  function scheduleHowToAdvance() {
    if (howToAdvancePending) return;
    howToAdvancePending = true;
    trackedTimeout(() => {
      howToAdvancePending = false;
      advanceHowTo();
    }, HOWTO_ADVANCE_DELAY_MS);
  }
  // Called every time beginAimPhase() re-enters 'aimA' in howTo mode — i.e.
  // once at the very start, then again after every shot settles (including
  // the very first "select/aim/play" one, before any ice-related step). The
  // step counter itself is never reset here — only advanceHowTo() moves it —
  // so this just makes sure a fresh round starts unlocked and shows whatever
  // step is currently in progress.
  function onHowToAimPhase() {
    howToAimLocked = false;
    howToJoystickWasDown = false;
    howToSweepDragSeen = false;
    howToLaserBaseline = null;
    // Every round after the very first one starts past step 1 ("select") —
    // onValidate() cleared selectedStone when the previous shot fired, but
    // there's only ever this one stone, and onJoystickDown requires
    // selectedStone to be set before the stick does anything at all (see
    // that function). Re-teaching the select gesture every round would just
    // be an extra, pointless tap once it's already been taught once.
    if (howToStep > 0) selectedStone = entities.A[0];
    // A shot just fired and has now fully settled (see onValidate's howTo
    // branch, which sets this instead of advancing immediately) — only now,
    // with the stone genuinely done moving, does the usual advance delay
    // start (per explicit feedback: never chain into the next step while
    // something is still visibly sliding).
    if (howToShotAdvancePending) {
      howToShotAdvancePending = false;
      scheduleHowToAdvance();
      // howToStepDone is deliberately left alone here (still true, set back
      // when Play was originally tapped) — this settle is just the shot
      // finishing, not a new step starting, so the OLD step's case must
      // stay suppressed through this final wait too. Without this, it was
      // popping back up for the whole settle-to-advance window (per
      // explicit feedback — a real, reproducible gap, not the same one the
      // onValidate-side fix already covered).
    } else {
      howToStepDone = false;
    }
    howToOverlayEl.classList.remove('hidden');
    howToTileEl.classList.remove('hidden');
    howToRenderTile();
    // Tile position itself isn't touched here — the very next syncHowTo()
    // call positions it fresh, next to whatever this new step's case shows
    // (see howToPositionTileNear).
  }
  // "Basic laser" step: rather than have the player hunt for a wall bounce
  // themselves (an earlier version of this step — see conversation, dropped
  // for reliability reasons), the tutorial now stages one itself — slides
  // the stone to a fixed spot on the center line just above middle, and
  // presets its pendingVx/pendingVy to a direction/power already known to
  // clip the top wall and bounce back across clearly, so both laser styles
  // have something worth comparing the instant this step starts. Direction
  // is up-and-slightly-right, normalized; pull length is a fixed fraction of
  // MAX_DRAG (a full-power-feeling shot, not a token tap). Tuned by eye —
  // nudge HOWTO_LASER_DEMO_POS/DIR/PULL together if the bounce ever needs to
  // land somewhere else legible.
  const HOWTO_LASER_DEMO_POS = { x: CENTER_X, y: CY - 150 };
  const HOWTO_LASER_DEMO_DIR = (() => {
    const ux = 0.35, uy = -0.94;
    const mag = Math.hypot(ux, uy);
    return { ux: ux / mag, uy: uy / mag };
  })();
  const HOWTO_LASER_DEMO_PULL = MAX_DRAG * 0.7;
  const HOWTO_LASER_DEMO_SLIDE_MS = 700;
  // { fromX, fromY, toX, toY, start } while the slide-into-place tween is
  // running, null once it's finished (or before it's ever started).
  let howToLaserDemoTween = null;
  function howToStartLaserDemo(stone) {
    if (!stone) return;
    howToAimLocked = true; // see onPointerDown/onJoystickDown's own guards — nothing to grab during this step
    howToLaserDemoTween = { fromX: stone.x, fromY: stone.y, toX: HOWTO_LASER_DEMO_POS.x, toY: HOWTO_LASER_DEMO_POS.y, start: performance.now() };
    stone.pendingVx = HOWTO_LASER_DEMO_DIR.ux * HOWTO_LASER_DEMO_PULL * POWER_SCALE;
    stone.pendingVy = HOWTO_LASER_DEMO_DIR.uy * HOWTO_LASER_DEMO_PULL * POWER_SCALE;
  }
  function howToUpdateLaserDemoSlide(stone) {
    if (!howToLaserDemoTween || !stone) return;
    const t = Math.min(1, (performance.now() - howToLaserDemoTween.start) / HOWTO_LASER_DEMO_SLIDE_MS);
    const e = easeInOutQuad(t);
    stone.x = howToLaserDemoTween.fromX + (howToLaserDemoTween.toX - howToLaserDemoTween.fromX) * e;
    stone.y = howToLaserDemoTween.fromY + (howToLaserDemoTween.toY - howToLaserDemoTween.fromY) * e;
    if (t >= 1) howToLaserDemoTween = null;
  }
  // Called once per render() frame (see render()'s own call site) — the
  // single dispatcher deciding what the current step spotlights and whether
  // it's done. Every step's actual *input handling* is the real game's own
  // (stone select/drag, joystick, sweep, the power button) — this only
  // observes that state, never reads/writes pointer events itself, with one
  // exception: the 'laser' step's demo shot, which this closure stages
  // itself (see howToStartLaserDemo) rather than waiting on the player.
  function syncHowTo() {
    const stone = entities.A[0];
    if (!stone) return;
    // Per explicit feedback: the instant any step's action is clicked, the
    // spotlight disappears outright — it doesn't linger through the advance
    // delay or through a shot still flying, only returning once the next
    // step's own case below starts computing its own target. howToStepDone
    // covers instant/released actions; phase !== 'aimA' covers a shot
    // already submitted (Play/Slide/the laser step's auto-fire).
    // The "Quit tutorial?" confirm dialog (main.js's triggerExit, shown in
    // the shared #overlay) sits inside #game-card's own stacking context
    // (z-index:1 there), while #howToOverlay/#howToTile are page-level fixed
    // siblings at z-index 8/9 — #overlay's own z-index:10 only wins locally,
    // so without this check the spotlight AND the tile (its own root-level
    // sibling, not touched by howToClearHole) would both paint over the
    // dialog instead of the other way around. Simplest fix scoped to howTo:
    // just go dark and hide the tile whenever that dialog is open, same as
    // any other paused state.
    if (!overlay.classList.contains('hidden')) { howToClearHole(); howToTileEl.classList.add('hidden'); return; }
    // Undoes the hide above once the dialog closes again — nothing else
    // re-shows the tile on a plain phase-unchanged dismissal (onHowToAimPhase,
    // the only other place that unhides it, only fires on a real phase
    // transition, which closing the dialog never causes).
    howToTileEl.classList.remove('hidden');
    if (howToStepDone || phase !== 'aimA') { howToClearHole(); return; }
    switch (howToStep) {
      case 0: // meet your stone — no game action gates this, only the
        // "Got it?" pill (see howToGotItBtnEl's click handler) — the LED
        // demo runs the whole time it's up.
        howToShowEntityTarget(stone, true);
        howToUpdateLedDemo(stone);
        break;
      case 1: { // select — advances only on the real tap-release (selectedStone,
        // set by onPointerUp's pendingTap branch), never mid-gesture.
        const chosen = selectedStone === stone;
        howToShowEntityTarget(stone, !chosen);
        if (chosen) { howToStepDone = true; scheduleHowToAdvance(); }
        break;
      }
      case 2: { // aim — advances on release (the 2s lock is just a bonus
        // callout, not required — see howToJoystickWasDown's own comment).
        // Three distinct states, checked in this order on purpose: showing
        // the spotlight is only correct for "not touched yet" — checking it
        // ahead of the "just released" branch (both share active===false)
        // used to flash the spotlight back on for one frame right at
        // release, before howToStepDone caught up on the next frame (per
        // explicit feedback: a stale spotlight must never reappear once
        // gone).
        // howToJoystickWasDown is set by a real listener on #joystickRing,
        // not read/written here (see its own comment on why).
        if (joystickDrag) {
          howToShowDomTarget('joystickRing', false);
        } else if (howToJoystickWasDown) {
          howToStepDone = true;
          scheduleHowToAdvance();
        } else {
          howToShowDomTarget('joystickRing', true);
        }
        break;
      }
      case 3: // play — advances on tap, see onValidate's howTo branch
        howToShowDomTarget('tbtn-play', true);
        break;
      case 4: { // ice boost
        howToShowDomTarget('tbtn-sweep', !sweep.A.active);
        if (sweep.A.active) { howToStepDone = true; scheduleHowToAdvance(); }
        break;
      }
      case 5: { // position the ice — same three-states-checked-in-order
        // reasoning as the 'aim' case above (dragging / just-released /
        // not-yet-touched all share "not currently dragging" otherwise).
        const dragging = !!sweepDrag;
        if (dragging) {
          howToSweepDragSeen = true;
          howToShowSweepTarget(false);
        } else if (howToSweepDragSeen) {
          howToStepDone = true;
          scheduleHowToAdvance();
        } else {
          howToShowSweepTarget(sweep.A.active);
        }
        break;
      }
      case 6: { // slide on the ice — advances on tap, see onValidate's howTo
        // branch. Corridor stays up the whole step (persistent until the
        // shot fires) AND, at once, a circular spot walks the same
        // stick-then-play sequence steps 2-3 already taught — spotlighting
        // the stick until a real aim has been committed (a release with
        // actual pendingVx/Vy, not just any touch), then Play once one has
        // — per explicit request that both visuals show together rather
        // than one replacing the other. The spot lives inside the
        // corridor's own SVG mask (see howToShowCorridorSpot) so the two
        // don't fight over #howToHole/#howToCorridor's usual mutual-hide.
        howToShowCorridor(stone);
        const aimed = !!(stone.pendingVx || stone.pendingVy);
        const targetEl = document.getElementById(aimed ? 'tbtn-play' : 'joystickRing');
        const rect = targetEl && targetEl.getBoundingClientRect();
        if (rect && rect.width) {
          const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
          howToShowCorridorSpot(cx, cy, Math.max(rect.width, rect.height) / 2 + 10);
          howToPositionTileNear(cx, cy); // overrides howToShowCorridor's own (near the ice zone) — the stick/play target is the actionable one here
        }
        break;
      }
      case 7: { // basic laser — a preset demo shot the tutorial stages
        // itself (see howToStartLaserDemo, triggered once from
        // advanceHowTo right as this step starts), not something the player
        // aims — the slide-into-place tween needs updating every frame
        // regardless of which branch below runs. Requires 4 clicks (see
        // howToLaserToggleCount's own comment), checked before the
        // spotlight call, not after, same reasoning as 'aim'/'position the
        // ice' above: showing the spotlight unconditionally first would
        // still paint it for the one frame the last toggle is detected. Per
        // explicit feedback, toggling is now the ENTIRE action — nothing
        // ever fires this shot for real (see onValidate's own
        // howToStep===7 bail-out too), so this advances straight away
        // instead of waiting on a settle that's never coming. The
        // spotlight itself only covers the FIRST click though (per
        // explicit feedback) — it comes off click 1, well before the step
        // itself is done at click 4.
        howToUpdateLaserDemoSlide(stone);
        if (howToLaserBaseline === null) howToLaserBaseline = isBasicLaser();
        else if (isBasicLaser() !== howToLaserBaseline) {
          howToLaserBaseline = isBasicLaser();
          howToLaserToggleCount++;
        }
        if (howToLaserToggleCount >= 4) {
          howToStepDone = true;
          scheduleHowToAdvance();
        } else if (howToLaserToggleCount >= 1) {
          howToClearHole();
        } else {
          howToShowDomTarget('tbtn-power', true);
        }
        break;
      }
      case 8: // quit — real exit button, no advance needed (ends the
        // session). Tapping it doesn't tear anything down right away — it
        // opens main.js's own "Quit the match?" Yes/No confirm first (see
        // triggerExit, shared #overlay) — per explicit feedback, the
        // spotlight has to disappear the instant that panel is up, not
        // linger behind it. Reappears if "No" is picked (overlay hides,
        // still this same step); a page reload/teardown follows immediately
        // on "Yes" either way, so no special-casing needed for that side.
        howToShowDomTarget('tbtn-exit', overlay.classList.contains('hidden'));
        break;
    }
  }
  function teardownHowTo() {
    howToOverlayEl.classList.add('hidden');
    howToTileEl.classList.add('hidden');
    howToHoleEl.classList.add('hidden');
    howToCorridorEl.classList.add('hidden');
  }

  // ---------- Render: arena background is the user's original artwork, used as-is ----------
  // The physics bounds (FX0..FY1, GY0/GY1) are invisible constraints only — the center
  // line/hexagon/goal circles are baked into the art itself, re-centered on CENTER_X/CY
  // at the image level (see the comment on FX0 above) so no runtime drawing is needed.
  function drawBackground() {
    ctx.clearRect(0, 0, W, H);

    if (arenaFrameImage.complete) {
      // Mobile's arenaFrameImage is pre-cropped to exactly the MOBILE_CROP
      // rect (see its comment above) — same pixels, just placed back at
      // that rect's own logical offset instead of (0,0) so nothing else
      // needs to know the image itself is smaller than W x H.
      if (mobile) ctx.drawImage(arenaFrameImage, MOBILE_CROP.x0, MOBILE_CROP.y0, cropW, cropH);
      else ctx.drawImage(arenaFrameImage, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#142451'; ctx.fillRect(0, 0, W, H);
    }

    drawScoreHud();
    drawRockGlow();
  }

  // HUD rock glow — see ROCK_GLOW/rockGlowImages/rockFlash above for the
  // per-rock behavior spec (feedback from conversation):
  // - sound: pure state sync, no flash — lit iff audio.isMuted() is false
  // - ice: sweep[team].rockClicked — lit by default each round, dark after
  //   the team's first click of it this round
  // - laser: pure state sync like sound, no flash — lit iff isBasicLaser()
  //   is false (matches the old toolbar cap's own on/off icon swap)
  // - exit/play: always lit at baseline, with a brief dip-then-recover
  //   flicker on click (ROCK_FLASH_MS)
  // - chat: lit iff a LAN opponent is actually reachable (net truthy) — dark/
  //   inert otherwise, same dip-then-recover flicker as exit/play on click
  //
  // Mobile-only: these rocks' functions are all reachable from the mobile
  // controller (see index.html's #mobileController), and their carved icons
  // are cleaned off frame-mobile.webp (see conversation), so the glow is
  // switched off there too rather than lighting up now-blank stone.
  function drawRockGlow() {
    if (mobile) return;
    const team = aimingTeam();
    const iceLit = team ? !sweep[team].rockClicked : !(sweep.A.rockClicked || sweep.B.rockClicked);
    const alphas = {
      sound: audio.isMuted() ? 0 : 1,
      ice: iceLit ? 1 : 0,
      laser: isBasicLaser() ? 0 : 1,
      exit: 1, play: 1,
      chat: net ? 1 : 0,
    };
    const now = performance.now();
    for (const id of ['exit', 'play', 'chat']) {
      const t = (now - rockFlash[id]) / ROCK_FLASH_MS;
      if (t >= 0 && t < 1) alphas[id] = 1 - 0.75 * Math.sin(Math.PI * t); // dip then recover
    }
    for (const id in ROCK_GLOW) {
      const a = alphas[id];
      if (a <= 0.01) continue;
      const g = ROCK_GLOW[id], imgs = rockGlowImages[id];
      ctx.save();
      ctx.globalAlpha = a;
      if (imgs.flou.complete) ctx.drawImage(imgs.flou, g.x, g.y, g.w, g.h);
      if (imgs.light.complete) ctx.drawImage(imgs.light, g.lx, g.ly, g.lw, g.lh);
      ctx.restore();
    }
    drawChatBadge();
  }
  // Unread-message pastille — top-right corner of the chat rock's halo box,
  // shown only while there's something new to see and the mask isn't already
  // open (opening it clears chatUnread, see toggleChatMask).
  function drawChatBadge() {
    if (!net || !chatUnread || chatMaskOpen) return;
    if (!chatBadgeImage.complete || !chatBadgeImage.naturalWidth) return;
    const g = ROCK_GLOW.chat;
    const size = g.w * 0.42;
    ctx.drawImage(chatBadgeImage, g.x + g.w - size * 0.7, g.y - size * 0.3, size, size);
  }

  // Score is a filigrane baked "under the ice" rather than on a wood plaque
  // (no plaque exists in the V2 art) — one big translucent digit per team,
  // flanking the center line just below the center hexagon (baked into
  // frame.webp, ~99px radius around CENTER_X/CY — see FX0 comment above).
  // The images themselves (public/score-digits/{A,B}-{0..3}.png) are
  // pre-baked opaque squares — ice + digit already merged in linear light by
  // scripts/bake_score_digits.py, see that script's docstring for why a live
  // canvas darken-blend can't reproduce the GIMP source this mimics — so
  // this just stamps them directly, no compositing here. These constants
  // double as the bake script's own position/size source of truth; changing
  // them means re-running it.
  const UNDERICE_SCORE_CY = 1158;             // midpoint between the hex's bottom edge (~1049) and FY1 (1274), nudged up ~4px per feedback
  const UNDERICE_SCORE_H = 200;                // rendered glyph height; native source glyphs are 109px tall
  // Curling: the hexagon's old flanking spot (CENTER_X∓130) is buried under
  // the target now — pinned outside the circular timer ring + 60px instead
  // (see CIRCLE_TIMER_R below, and scripts/bake_curling_arena.py's own
  // matching SCORE_CX, which is what's actually baked into these PNGs).
  const UNDERICE_SCORE_CX_A = vibe === 'curling' ? CENTER_X - CIRCLE_TIMER_R - 60 : CENTER_X - 130;
  const UNDERICE_SCORE_CX_B = vibe === 'curling' ? CENTER_X + CIRCLE_TIMER_R + 60 : CENTER_X + 130;
  function drawUnderIceScore() {
    drawUnderIceDigit('A', scoreA, UNDERICE_SCORE_CX_A);
    drawUnderIceDigit('B', scoreB, UNDERICE_SCORE_CX_B);
  }
  function drawUnderIceDigit(team, score, cx) {
    const img = scoreDigitImages[team][String(score)];
    if (!img || !img.complete || !img.naturalWidth) return;
    const h = UNDERICE_SCORE_H, w = img.naturalWidth * (h / img.naturalHeight);
    ctx.drawImage(img, Math.round(cx - w / 2), Math.round(UNDERICE_SCORE_CY - h / 2), w, h);
  }

  function drawScoreHud() {
    drawUnderIceScore();
    if (phase === 'lanWait') drawWaitingLabel();
    if (vibe === 'curling') drawCircleTimer(); else drawHexTimer();
  }

  // LAN mode, local shot already sent: "waiting" burned under the ice between
  // the top beam and the hex timer, same baked technique as the score digits
  // / hex ring (see scripts/bake_waiting_label.py) rather than a plain
  // overlay — the word is static, the 3 trailing dots step through a
  // classic loading-dots cycle by fading each baked dot patch in/out.
  const WAITING_DOT_STEP_MS = 350; // time per cycle step (000 -> 100 -> 110 -> 111 -> repeat)
  // Baked top-left draw positions — must match scripts/bake_waiting_label.py
  // exactly (the ice grain at these exact pixels is baked into each PNG).
  const WAITING_WORD_POS = [1551, 712];
  const WAITING_DOT_POS = [[1743, 731], [1763, 731], [1783, 731]];
  function drawWaitingLabel() {
    if (!waitingWordImage.complete || !waitingWordImage.naturalWidth) return;
    const step = Math.floor(performance.now() / WAITING_DOT_STEP_MS) % 4; // 0..3 dots lit
    ctx.drawImage(waitingWordImage, ...WAITING_WORD_POS);
    for (let i = 0; i < 3; i++) {
      const img = waitingDotImages[i];
      if (i >= step || !img.complete || !img.naturalWidth) continue;
      ctx.drawImage(img, ...WAITING_DOT_POS[i]);
    }
  }

  // 0..1 while a team is actively aiming, null the rest of the time (hides the bar).
  // lanWait keeps it showing too: the local shot is in but the round timer (and
  // the laser tracking it) keeps running for the still-aiming opponent.
  function turnTimerProgress() {
    if (!isAimingPhase(phase) && phase !== 'lanWait') return null;
    return Math.min(1, (performance.now() - turnTimerStart) / TURN_TIMER_MS);
  }

  // Under-ice hex turn-timer ring: fills the center hexagon clockwise over
  // 30s, like a clock hand sweeping — replaces the old top laser bar.
  // Same "burn a flat grey glyph into the real ice pixels once" technique as
  // drawUnderIceScore above (see scripts/bake_hex_timer.py for how
  // public/hex-timer/ring-full.png was made: a hexagonal ring at the same
  // position/radii as the two hexagons already baked into frame.webp's own
  // line art). Since the bake is spatially uniform, the fill animation is
  // just a clock-wipe pie-slice ctx.clip() revealing progressively more of
  // that one static image — no per-percentage frames needed, and the small
  // inner hex stays empty for free: the baked ring has no pixels there.
  // Must match HEX_TIMER_R_OUTER/MARGIN in scripts/bake_hex_timer.py exactly
  // — this defines the drawImage box the baked ring is stamped into, so any
  // mismatch would stretch it off its baked position.
  const HEX_TIMER_R_OUTER = 90, HEX_TIMER_MARGIN = 6;
  // Last stretch of the turn switches to the red ring instead of grey,
  // pulsing for urgency — feedback from conversation. Not a fixed fraction:
  // an explicit warning-window LENGTH per turnTime (matchConfig.turnTime),
  // e.g. 30s and 20s both warn for their last 5s, 10s only warns for its
  // last 3s (see TIMER_WARNING_SECONDS_BY_TURN_TIME) — 30s's own value here
  // reproduces the original always-5s/6-of-30s behavior exactly.
  const HEX_TIMER_RED_FRACTION = 1 - (TIMER_WARNING_SECONDS_BY_TURN_TIME[matchConfig.turnTime] ?? 5) / matchConfig.turnTime;
  const HEX_TIMER_RED_PULSE_RATE = 5;

  // Clips to the pie-slice wedge spanning fractions [f0, f1) of the clock
  // (0 = 12 o'clock, growing clockwise) and stamps `image` into it — shared
  // by the grey and red segments below, which only differ in image/range/alpha.
  function drawHexTimerWedge(image, half, f0, f1, alphaMul) {
    if (f1 <= f0) return;
    const a0 = -Math.PI / 2 + Math.PI * 2 * f0, a1 = -Math.PI / 2 + Math.PI * 2 * f1;
    ctx.save();
    if (alphaMul !== undefined) ctx.globalAlpha = alphaMul;
    ctx.beginPath();
    ctx.moveTo(CENTER_X, CY);
    ctx.lineTo(CENTER_X + half * Math.cos(a0), CY + half * Math.sin(a0));
    ctx.arc(CENTER_X, CY, half, a0, a1);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(image, CENTER_X - half, CY - half, half * 2, half * 2);
    ctx.restore();
  }
  function drawHexTimer() {
    const t = turnTimerProgress();
    if (t === null || t <= 0) return;
    if (!hexTimerRingImage.complete || !hexTimerRingImage.naturalWidth) return;
    const half = HEX_TIMER_R_OUTER + HEX_TIMER_MARGIN;
    const clampedT = Math.min(t, 1);

    drawHexTimerWedge(hexTimerRingImage, half, 0, Math.min(clampedT, HEX_TIMER_RED_FRACTION));

    if (clampedT > HEX_TIMER_RED_FRACTION && hexTimerRingRedImage.complete && hexTimerRingRedImage.naturalWidth) {
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 1000 * HEX_TIMER_RED_PULSE_RATE);
      drawHexTimerWedge(hexTimerRingRedImage, half, HEX_TIMER_RED_FRACTION, clampedT, pulse);
    }
  }
  // Curling only: same clock-wipe pie-sweep principle as drawHexTimer above,
  // just a plain stroked arc traced on the ring baked around the target
  // instead of clipping a baked hex-shaped image — a circle doesn't need
  // pre-baked art to animate a wipe over, ctx.arc() draws the wedge directly.
  const CIRCLE_TIMER_WIDTH = 10;
  function drawCircleTimerArc(f0, f1, color, alphaMul) {
    if (f1 <= f0) return;
    const a0 = -Math.PI / 2 + Math.PI * 2 * f0, a1 = -Math.PI / 2 + Math.PI * 2 * f1;
    ctx.save();
    ctx.globalAlpha = alphaMul;
    ctx.lineWidth = CIRCLE_TIMER_WIDTH;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(CENTER_X, CY, CIRCLE_TIMER_R, a0, a1);
    ctx.stroke();
    ctx.restore();
  }
  function drawCircleTimer() {
    const t = turnTimerProgress();
    if (t === null || t <= 0) return;
    const clampedT = Math.min(t, 1);
    const team = aimingTeam();
    const rgb = HALO_RGB[team || 'A'];
    drawCircleTimerArc(0, Math.min(clampedT, HEX_TIMER_RED_FRACTION), `rgba(${rgb},0.9)`, 1);
    if (clampedT > HEX_TIMER_RED_FRACTION) {
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 1000 * HEX_TIMER_RED_PULSE_RATE);
      drawCircleTimerArc(HEX_TIMER_RED_FRACTION, clampedT, 'rgba(235,60,60,0.95)', pulse);
    }
  }

  // PLAY: the red toolbar button (index.html #tbtn-play, see src/style.css
  // .tbtn-cap for the press animation) instead of a canvas-drawn cap — this
  // just gates the click to the same "can actually launch" condition the old
  // canvas button used, and replays the same press animation + click SFX.
  function isPlayButtonActive() {
    return controlsEnabled && isAimingPhase(phase);
  }
  const playBtn = document.getElementById('tbtn-play');
  const playBtnCap = document.getElementById('tbtn-play-cap');
  // Factored out so the "play" HUD rock (see ROCK_ZONES/onPointerDown below)
  // can trigger the exact same logic as the old toolbar button, not a
  // separate copy of it.
  function triggerPlay() {
    if (!isPlayButtonActive()) return;
    playBtnCap.classList.remove('pressed');
    void playBtnCap.offsetWidth; // restart the animation if pressed again mid-tween
    playBtnCap.classList.add('pressed');
    audio.play('button');
    onValidate();
  }
  playBtn.addEventListener('click', triggerPlay, { signal });

  // BALAI / "sweep": reuses the Effacer/"clear" toolbar slot (its broom art
  // already fit) rather than a new 5th button — see index.html/main.js. Click
  // toggles the aiming team's own patch on/off (freely, before PLAY — see
  // commitSweep for what actually locks it in); the cap swaps to a hollow
  // "engaged" variant while a not-yet-committed placement is active (same
  // hollow-outline technique as the power button's off state, see
  // scripts/make_sweep_active_icon.py), and an X overlay (see style.css
  // .tbtn-used-cross) shows once that team's one placement for the round has
  // actually been spent.
  const SWEEP_CAP_SRC = { idle: `${ASSET_BASE}ui/btn-sweep-cap.png`, active: `${ASSET_BASE}ui/btn-sweep-cap-active.png` };
  const sweepBtn = document.getElementById('tbtn-sweep');
  const sweepBtnCap = document.getElementById('tbtn-sweep-cap');
  const sweepBtnCross = document.getElementById('tbtn-sweep-cross');
  // #mobileController's own "locked for this point" look (see
  // .mc-gray-overlay in style.css) — same `used` flag as the cross above.
  const sweepBtnGray = document.getElementById('tbtn-sweep-gray');
  // Factored out so the "ice" HUD rock (see ROCK_ZONES/onPointerDown below)
  // can trigger the exact same logic as the old toolbar button.
  function triggerSweep() {
    const team = aimingTeam();
    if (!controlsEnabled || !team || sweep[team].used) return;
    const sw = sweep[team];
    sw.active = !sw.active;
    sw.rockClicked = true;
    if (sw.active) { sw.x = CENTER_X; sw.y = CY; }
    sweepBtnCap.classList.remove('pressed');
    void sweepBtnCap.offsetWidth; // restart the animation if pressed again mid-tween
    sweepBtnCap.classList.add('pressed');
    audio.play('button');
    if (sw.active) audio.play('sweepAppear', { volume: 0.251 }); // -12dB, right after button.m4a
  }
  sweepBtn.addEventListener('click', triggerSweep, { signal });
  // Called every rendered frame (see render()) rather than only from the
  // click handler above — the aiming team itself changes on its own as the
  // phase machine advances (aimA -> aimB, LAN sync, round reset), with
  // nothing routing back through this click handler to catch that.
  function syncSweepButton() {
    const team = aimingTeam();
    const sw = team ? sweep[team] : null;
    sweepBtnCap.src = (sw && sw.active && !sw.used) ? SWEEP_CAP_SRC.active : SWEEP_CAP_SRC.idle;
    // Outside an actual aim phase (pending/sim/goal/roundReset/straighten —
    // nobody's turn to place one right now) there's no specific team to read
    // `used` off of, but the cross shouldn't blink off for that stretch just
    // because aimingTeam() went null — keep it up through the reveal and
    // beyond if EITHER team spent their round's placement, falling back to
    // that once a real aim phase picks a specific team again.
    const used = team ? sw.used : (sweep.A.used || sweep.B.used);
    sweepBtnCross.classList.toggle('show', used);
    // Normal by default, grays the instant it's armed (one click, same feel
    // as energy's toggle) and then simply stays gray once actually played —
    // `active` alone already covers that (triggerSweep's own `used` guard
    // means it can never flip back to false after commit), `used` is only
    // ORed in for the same reason the cross needs it above: to keep reading
    // correctly through the stretch where aimingTeam() is null. No separate
    // cross needed on top on mobile (see #mobileController .tbtn-used-cross
    // in style.css) — the gray alone is the whole story there.
    const armed = team ? (sw && sw.active) : (sweep.A.active || sweep.B.active);
    sweepBtnGray.classList.toggle('hidden', !(armed || used));
  }

  // Splits the entity into two clipped halves along the line through its own
  // center, perpendicular to the contact direction: the near half is compressed
  // toward that same center line, the far half never moves along that axis.
  // Both halves also get the same perpendicular bulge (sy), so the deformation
  // reads as displaced mass (squash-and-stretch, area roughly conserved via
  // sy = 1/sx) rather than one side just deflating — applying sy to both halves
  // keeps the shared center line seamless, since only sx differs between them.
  function drawSquished(e, drawFn) {
    if (!(Math.abs(e.squish) > 0.001)) { drawFn(); return; }
    const ang = Math.atan2(e.squishNY, e.squishNX);
    const sx = 1 - e.squish * 0.85; // compression along the contact axis
    const sy = 1 / sx;              // perpendicular bulge, area-conserving
    const R = e.r * 1.6; // generous half-plane size, comfortably covers the whole sprite/shadow

    ctx.save(); // far half: bulges with the near half, but never compresses
    ctx.translate(e.x, e.y); ctx.rotate(ang);
    ctx.beginPath(); ctx.rect(-R, -R, R, R * 2); ctx.clip();
    ctx.scale(1, sy);
    ctx.rotate(-ang); ctx.translate(-e.x, -e.y);
    drawFn();
    ctx.restore();

    ctx.save(); // near half: compressed toward the shared center line, same bulge
    ctx.translate(e.x, e.y); ctx.rotate(ang);
    ctx.beginPath(); ctx.rect(0, -R, R, R * 2); ctx.clip();
    ctx.scale(sx, sy);
    ctx.rotate(-ang); ctx.translate(-e.x, -e.y);
    drawFn();
    ctx.restore();
  }
  // tight contact shadow shared by the bubbles and the ball — matched to the
  // arena's own light direction but barely spilling past the entity's own
  // footprint, like it's floating just above the grass rather than resting on it.
  // Pre-baked once per entity size (see stoneShadowSprite/ballShadowSprite below)
  // instead of re-running ctx.filter blur every frame — that per-frame blur was
  // the actual cost the dpr cap comment near the top of this file warns about;
  // only the squish deformation still has to happen live, applied to the baked
  // bitmap exactly like it used to be applied to the fill.
  // 0.7 (a full 30% cut) shrank the ellipse enough that it sat entirely under the
  // opaque stone sprite (offset + shadow radius < stone radius, see drawContactShadow's
  // cx/cy offset below) — nothing left poking out to actually see. Split the
  // difference instead: still visibly tighter than the original 1.0, but the
  // sliver that pokes past the stone's own silhouette survives.
  const SHADOW_SIZE_SCALE = 0.85;
  // Baked at extra internal resolution, independent of the screen's own dpr
  // cap (see the dpr comment near the top of startGame): on a phone with a
  // high real devicePixelRatio, the screen dpr cap undersamples the whole
  // canvas relative to its displayed CSS size, which stretched this sprite's
  // near-sharp accent ellipse (see below) enough to read as a second, harder
  // shadow glued to the soft one instead of a subtle contact line. Baking at
  // 3x and letting drawContactShadow scale it back down to logical size
  // gives the blur gradient enough source pixels to stay smooth through that
  // stretch, on every platform, for the cost of two small offscreen canvases
  // baked once at load — not a per-frame cost.
  const SHADOW_BAKE_SUPERSAMPLE = 3;
  function bakeContactShadowSprite(r, boost) {
    const s = SHADOW_BAKE_SUPERSAMPLE;
    // blur scales with the entity's own radius rather than a fixed pixel amount —
    // a flat 3px blur reads as a subtle soft edge on a 38px stone, but on the much
    // smaller 17px ball it was smearing away most of the shadow's density
    const blur = Math.max(1.2, r * 0.08) * s;
    const rx = r * boost * SHADOW_SIZE_SCALE * s, ry = r * 0.92 * boost * SHADOW_SIZE_SCALE * s;
    const pad = blur * 3; // generous margin so the blurred edge never gets cropped
    const w = Math.ceil((rx + pad) * 2), h = Math.ceil((ry + pad) * 2);
    const sprite = document.createElement('canvas');
    sprite.width = w; sprite.height = h;
    sprite.logicalWidth = w / s; sprite.logicalHeight = h / s;
    const sctx = sprite.getContext('2d');
    // Cut down from 0.5/0.55 (see conversation — read as way too strong on
    // mobile, where the dpr mismatch stretches the sprite and shows more of
    // this peak alpha than desktop's tighter falloff let through): tuned so
    // the visible sliver (see drawContactShadow's cx/cy offset) reads close
    // to the ~30% opacity desktop already looked like.
    sctx.fillStyle = `rgba(0,0,0,${Math.min(0.32, 0.3 * boost)})`;
    sctx.filter = `blur(${blur}px)`;
    sctx.beginPath();
    sctx.ellipse(w / 2, h / 2, rx, ry, 0, 0, Math.PI * 2);
    sctx.fill();
    // small accent layered on top of the soft ambient shadow above — used to
    // be near-sharp (min blur, high alpha) so it read as a crisp contact
    // line, but that's exactly what made mobile's stretch turn it into a
    // second hard, dark shadow (see conversation). Much softer and fainter
    // now: still a slightly denser core than the ambient layer alone, but no
    // longer sharp enough to read as its own separate shape at any dpr.
    const accentBlur = Math.max(0.7, r * 0.05) * s;
    sctx.fillStyle = `rgba(0,0,0,${Math.min(0.22, 0.2 * boost)})`;
    sctx.filter = `blur(${accentBlur}px)`;
    sctx.beginPath();
    sctx.ellipse(w / 2, h / 2, rx * 0.8, ry * 0.8, 0, 0, Math.PI * 2);
    sctx.fill();
    return sprite;
  }
  // slightly boosted vs the ball's own 1.0/1.05 — 1.4 was tried first and
  // was way too strong (see conversation), especially once the on-screen
  // sprite itself was corrected down via STONE_VISUAL_SCALE.
  const STONE_SHADOW_BOOST = 1.08;
  const stoneShadowSprite = bakeContactShadowSprite(STONE_R, STONE_SHADOW_BOOST);
  const ballShadowSprite = bakeContactShadowSprite(BALL_R, 1.05);
  // Clips to the ice rect, same as the old inline `ctx.rect(FX0,FY0,...)`
  // trick (tucks the shadow under the wood frame at wall contact instead of
  // spilling over it) — PLUS the two goal pockets behind the open netting
  // (GY0..GY1), out to where collideBar actually freezes a falling entity.
  // Without the pockets, a stone/ball's shadow got guillotined exactly on
  // the goal line while still visibly sinking into the net, instead of
  // following it in.
  function clipIceAndGoals() {
    ctx.beginPath();
    ctx.rect(FX0, FY0, FX1 - FX0, FY1 - FY0);
    ctx.rect(BAR_LEFT.x0, GY0, FX0 - BAR_LEFT.x0, GY1 - GY0);
    ctx.rect(FX1, GY0, BAR_RIGHT.x1 - FX1, GY1 - GY0);
    ctx.clip();
  }
  function drawContactShadow(g, sprite, boost = 1) {
    const cx = g.x + g.r * 0.1 * boost, cy = g.y + g.r * 0.16 * boost;
    // clip to the ice rect (+goal pockets) so the shadow tucks under the wood
    // frame at wall contact instead of spilling over it, but keeps following
    // a stone/ball down into the net instead of stopping dead at the goal
    // line — same trick as drawAimHalo below (the frame is baked into the
    // background image and drawn first, so anything drawn after it,
    // including this shadow, normally sits on top).
    ctx.save();
    clipIceAndGoals();
    // pivoted on the shadow's OWN (light-offset) center rather than the stone's
    // physics center, so the retraction is symmetric on the shadow's own shape
    // instead of lopsided. The sprite is drawn on top and occludes most of the
    // shadow near the stone's center, so this only becomes visible on whichever
    // side the shadow actually pokes out past the stone — matching the bubble's
    // own compression there — and stays invisible on the opposite side.
    const shadowEntity = { x: cx, y: cy, r: g.r, squish: g.squish || 0, squishNX: g.squishNX, squishNY: g.squishNY };
    const dw = sprite.logicalWidth, dh = sprite.logicalHeight;
    drawSquished(shadowEntity, () => {
      ctx.drawImage(sprite, cx - dw / 2, cy - dh / 2, dw, dh);
    });
    ctx.restore();
  }

  // soft glow beneath the bubbles, per-stone (not per-team-turn) — driven by
  // whether THIS stone has actually been dragged to program a shot (g.used),
  // not just whose turn it is:
  //   off     — default: not yet clicked/dragged this round. A stone that's
  //             never programmed stays off even once its team validates and
  //             the round reaches reveal — only stones someone actually aimed
  //             light up there.
  //   'pulse' — this stone has a programmed shot pending launch (aiming or
  //             waiting on the other side): soft on/off breathing, 2s period,
  //             own unsynced phase per stone (no shared clock)
  //   'on'    — shots are revealed/resolving (pending + sim), and this stone
  //             was one of the ones actually launched: steady, no pulse
  // Tinted with each team's own accent color (matches the score digits).
  // g.used resets to false for every stone once a round settles (see the
  // settleFrames block in the main loop), so the whole board is naturally
  // back to 'off' for the next round without any extra bookkeeping here.
  const HALO_RGB = { A: '94,203,245', B: '255,201,77' };
  const HALO_PULSE_PERIOD = 2; // seconds
  function haloMode(g) {
    if (g.falling || g.out) return 'off';
    // reveal: halos cut entirely once the sim actually starts moving things —
    // the LEDs (fully independent, see below) carry the damage/"alive" read
    // from there. 'pending' itself is handled below: the just-committed
    // team's halo keeps fading out through the laser's own retract window
    // instead of popping off the instant PLAY is pressed.
    if (phase === 'pending') {
      if (!g.used || g.team !== retractTeam) return 'off';
      if (aiTeam && g.team === aiTeam) return 'off';
      return laserRetractProgress() < 1 ? 'retract' : 'off';
    }
    // Whitelist, not a blacklist: only the phases where a validated shot's
    // halo is actually meant to show. Everything else (sim, goal,
    // roundReset, gameover, matchIntro, straighten, start...) must be off
    // even though g.used can still read true there — it isn't cleared until
    // beginRoundReset() runs, which for a scored point only happens AFTER
    // the GOAL_PAUSE_MS celebration pause (see onGoal), so without this
    // whitelist the scoring team's halos stayed lit fixed through that
    // entire pause instead of cutting the instant the reveal ended.
    if (!isAimingPhase(phase) && phase !== 'lanWait' && phase !== 'replayAim') return 'off';
    // Pass & Play: 'aimB' only ever happens in the local 2-human flow (LAN
    // uses lanAim, solo vs IA never leaves aimA) — team A's already-committed
    // halo must stay behind the hand-off mask while team B aims, same as
    // their laser/sweep patch already do, not leak which stones they used.
    if (phase === 'aimB' && g.team === 'A') return 'off';
    if (!g.used) {
      // Mobile: a tap-selected stone glows before the joystick ever arms a
      // shot, so the player can see which stone they're about to aim.
      return (mobile && selectedStone === g) ? 'pulse' : 'off';
    }
    // vs-IA: the AI's shots are precomputed silently in one shot at the start
    // of the round (see prepareAiShots) — g.used flips true for all 3 of its
    // stones instantly, with no drag the player ever sees, unlike a human's
    // own turn. Showing that halo would just leak "the AI already decided"
    // from frame one, so its stones never get one.
    if (aiTeam && g.team === aiTeam) return 'off';
    // pulses only while this exact stone is the one currently being dragged;
    // once released with a valid shot it snaps to steady 'on' right away,
    // regardless of whose turn it is or how long until the round launches.
    return (drag && drag.entity === g) ? 'pulse' : 'on';
  }
  // Shared 0..1 breathing curve for anything that pulses in sync with a stone's
  // own aiming turn (the halo below, and the stone's own LED strips) — same
  // deterministic per-stone phase offset (evenly spread by index) so the three
  // stones on a team don't breathe in sync with each other.
  function pulseStrength(g) {
    if (g._haloOffset === undefined) {
      // ids are "A0".."A2"/"B0".."B2" — the trailing digit is already a clean
      // 0/1/2 index, spread evenly across the period (a char-code hash of ids
      // this similar barely varies and left the 3 stones nearly in sync)
      const idx = parseInt(g.id.slice(1), 10) || 0;
      g._haloOffset = (idx / 3) * HALO_PULSE_PERIOD;
    }
    const t = performance.now() / 1000;
    const cycle = ((t + g._haloOffset) % HALO_PULSE_PERIOD) / HALO_PULSE_PERIOD; // 0..1
    return (1 - Math.cos(cycle * Math.PI * 2)) / 2; // smooth fade 0 -> 1 -> 0
  }
  function drawAimHalo(g, mode) {
    const rgb = HALO_RGB[g.team];
    const R = g.r * 1.4;
    // remap the pulse's 0..1 breathing to a 20%-80% range instead of fading
    // fully to black or full brightness — only the halo's own brightness, not
    // pulseStrength() itself (shared with the stone's LED strips, which should
    // keep their own full 0..1 breathing). 'retract' stays at full strength,
    // same as 'on' — haloMode() below is what cuts it to 'off' outright the
    // instant the laser finishes retracting, no fade of its own.
    const strength = mode === 'pulse' ? 0.2 + 0.6 * pulseStrength(g) : 1;
    ctx.save();
    // clip to the ice rect (+goal pockets, see clipIceAndGoals) so the halo
    // tucks under the wood frame at wall contact instead of glowing over it
    // (frame is baked into the background image and drawn first, so anything
    // drawn after it normally sits on top), but still reaches naturally out
    // to the goal bar instead of guillotining on the invisible FX0/FX1 physics
    // wall when a stone sits in the goal mouth (GY0..GY1) — plain ctx.rect
    // stopped short of the bar there, reading as a cut on an imaginary line.
    clipIceAndGoals();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(g.x, g.y, g.r * 0.4, g.x, g.y, R);
    grad.addColorStop(0, `rgba(${rgb},${(0.55 * strength).toFixed(3)})`);
    grad.addColorStop(0.6, `rgba(${rgb},${(0.24 * strength).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.beginPath(); ctx.arc(g.x, g.y, R, 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
  }
  // Goal-bar contact light — lit the instant the ball touches BAR_LEFT/
  // BAR_RIGHT (barGlowSide, set in physicsStep's bar-hit check), stays lit
  // through the whole goal pause/settle wait, cleared only in resolveGoal()
  // right as the point actually gets displayed. Team B scores through the
  // left bar, A through the right (see collideBar's call sites), so the
  // color (HALO_RGB, same palette as drawAimHalo) follows the side, not a
  // stored team id.
  // Deliberately NOT a halo-style radial bloom — an earlier version stacked
  // several of drawAimHalo's own big-radius gradients along the bar and it
  // read as a wash covering a third of the rink (see conversation). A flat
  // fill across the whole bar was tried next — either fully hid the black
  // (opaque) or tinted it evenly all the way through ('lighter') — neither
  // gave the "still black at the back, lit toward the ice" look asked for.
  // This instead gradients ACROSS the bar's own thin depth: transparent at
  // the poutre/back edge (bar still reads as black there) ramping up to the
  // lit color at 70% right at the ice-facing edge. The ice-side spill used to
  // be a tiny 60px rectangle sliver; it's now the full crease glow below
  // (drawCreaseGlow), covering the whole "surface de réparation" arc baked
  // into frame.webp instead of just the strip right against the bar.
  function drawBarGlow() {
    if (!barGlowSide) return;
    const isLeft = barGlowSide === 'left';
    const bar = isLeft ? BAR_LEFT : BAR_RIGHT;
    const rgb = HALO_RGB[isLeft ? 'B' : 'A'];
    const coreAlpha = isLeft ? 0.95 : 0.7; // gold (left) reads dimmer than blue at the same alpha, bumped to match
    const iceX = isLeft ? bar.x1 : bar.x0;     // edge nearest the field (FX0/FX1)
    const poutreX = isLeft ? bar.x0 : bar.x1;  // edge nearest the back wall/recess
    ctx.save();
    const coreGrad = ctx.createLinearGradient(poutreX, 0, iceX, 0);
    coreGrad.addColorStop(0, `rgba(${rgb},0)`);
    coreGrad.addColorStop(1, `rgba(${rgb},${coreAlpha})`);
    ctx.fillStyle = coreGrad;
    ctx.fillRect(bar.x0, bar.y0, bar.x1 - bar.x0, bar.y1 - bar.y0);
    ctx.restore();
  }
  // Stone-on-bar flash — a single quick pulse on the bar itself (same
  // poutre-to-ice linear gradient as drawBarGlow, none of the crease glow
  // below) when a stone dies against BAR_LEFT/BAR_RIGHT, set in
  // killStoneOnBar. Independent of barGlowSide's goal-scored glow, which
  // stays lit through the whole celebration pause instead of one-shotting.
  // Envelope is a plain sine bump over [0, STONE_FLASH_MS] (0 -> peak at the
  // midpoint -> 0), self-clearing once elapsed so this stays a single flash.
  function drawStoneBarFlash() {
    if (!stoneBarFlash) return;
    const t = (performance.now() - stoneBarFlash.t0) / STONE_FLASH_MS;
    if (t >= 1) { stoneBarFlash = null; return; }
    const isLeft = stoneBarFlash.side === 'left';
    const bar = isLeft ? BAR_LEFT : BAR_RIGHT;
    const rgb = HALO_RGB[isLeft ? 'B' : 'A'];
    const coreAlpha = (isLeft ? 0.95 : 0.7) * Math.sin(Math.PI * t);
    const iceX = isLeft ? bar.x1 : bar.x0;
    const poutreX = isLeft ? bar.x0 : bar.x1;
    ctx.save();
    const grad = ctx.createLinearGradient(poutreX, 0, iceX, 0);
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(1, `rgba(${rgb},${coreAlpha.toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(bar.x0, bar.y0, bar.x1 - bar.x0, bar.y1 - bar.y0);
    ctx.restore();
  }
  // Crease glow — lights the whole semicircular "surface de réparation"
  // painted in front of each goal (xcf-field-lines.png), not just a sliver
  // against the bar. Geometry isn't tracked anywhere else in this file (the
  // crease is pure baked art, unlike FX0/GY0/etc.), so it was measured
  // directly off frame.webp: a Kasa circle fit over the arc's dark pixels
  // (mean residual ~2.5px on the 3312px-wide image) gives center (1054,950)
  // r=161 on the left and (2297,950) r=160 on the right — both centers land
  // within a couple px of the bar's own ice-facing edge (BAR_LEFT.x1=1052 /
  // BAR_RIGHT.x0=2296) and CY (950), so the crease is simply a half-disc of
  // radius CREASE_R centered on (iceX, CY), bulging into the field.
  const CREASE_R = 160;
  function drawCreaseGlow() {
    if (!barGlowSide) return;
    const isLeft = barGlowSide === 'left';
    const bar = isLeft ? BAR_LEFT : BAR_RIGHT;
    const rgb = HALO_RGB[isLeft ? 'B' : 'A'];
    const iceX = isLeft ? bar.x1 : bar.x0;
    ctx.save();
    ctx.beginPath();
    // half-disc bulging toward the field: left goal sweeps up->right->down,
    // right goal sweeps down->left->up (canvas angle 0 = +x/east, π/2 = +y/south)
    if (isLeft) ctx.arc(iceX, CY, CREASE_R, -Math.PI / 2, Math.PI / 2);
    else ctx.arc(iceX, CY, CREASE_R, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
    ctx.clip();
    // Plain alpha blend, NOT 'lighter' — the ice is already near-white, so an
    // additive blend just saturates toward white instead of reading as a
    // color wash (tried first, see conversation). A normal source-over tint
    // actually shifts the ice color, which is what "illuminated in blue/
    // yellow" needs.
    const grad = ctx.createRadialGradient(iceX, CY, 0, iceX, CY, CREASE_R);
    grad.addColorStop(0, `rgba(${rgb},0.55)`);
    grad.addColorStop(0.65, `rgba(${rgb},0.32)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(iceX - CREASE_R, CY - CREASE_R, CREASE_R * 2, CREASE_R * 2);
    ctx.restore();
  }
  function isAimingTeamStone(g) {
    if (net) return phase === 'lanAim' && g.team === myTeam && !g.falling;
    return ((phase === 'aimA' && g.team === 'A') || (phase === 'aimB' && g.team === 'B')) && !g.falling;
  }
  // Damage LEDs are baked directly into the stone body art per how many are
  // still alive (see LED_STATE_SRC/tryBakeBubble above) — index i is
  // knocked out for good once g.hits reaches (i+1) * STONE_HITS_PER_LED, top
  // first then clockwise (see registerStoneHit/STONE_MAX_HITS).
  // "last life" warning pulse: at g.hits === STONE_MAX_HITS - 1 the stone has
  // exactly one hit left before it dies, and by construction only its last
  // LED is still alive (stoneLedsOut(g) is already 3/4). Full 2s on/off
  // cycle, smooth cosine fade between LAST_LED_PULSE_FLOOR and 1 (not a hard
  // blink, and not down to fully dark — a floor keeps the "this LED is
  // still alive" read intact even at the dimmest point of the cycle).
  const LAST_LED_PULSE_PERIOD_MS = 2000;
  const LAST_LED_PULSE_FLOOR = 0.3;
  function lastLedPulseStrength() {
    const cycle = (performance.now() % LAST_LED_PULSE_PERIOD_MS) / LAST_LED_PULSE_PERIOD_MS; // 0..1
    const wave = (1 - Math.cos(cycle * Math.PI * 2)) / 2; // smooth 0 -> 1 -> 0
    return LAST_LED_PULSE_FLOOR + (1 - LAST_LED_PULSE_FLOOR) * wave;
  }
  // how many of the 4 LEDs/quadrants (0..4) are knocked out so far — each
  // takes STONE_HITS_PER_LED hits, top first then clockwise.
  function stoneLedsOut(g) { return Math.floor(g.hits / STONE_HITS_PER_LED); }
  // Which pre-baked sprite(s) drawStone should show for this stone right now.
  // key alone for every state except the "last life" pulse, which crossfades
  // dimKey (the pulse floor) under key (the same bright '1' sprite the
  // non-critical single-LED state already uses) — see drawStone.
  function stoneLedState(g) {
    const alive = String(4 - stoneLedsOut(g));
    if (alive !== '1') return { key: alive };
    const critical = g.hits === STONE_MAX_HITS - 1 &&
      (isAimingPhase(phase) || phase === 'lanWait' || phase === 'pending' || phase === 'sim');
    if (!critical) return { key: '1' };
    return { key: '1', dimKey: '1dim', pulse: lastLedPulseStrength() };
  }
  // The new stone art is a full-bleed circle (fills its whole canvas edge to
  // edge) unlike the old bubble-v4 art, which had ~10% transparent padding
  // baked in around the circle — drawing the new art at the same diameter as
  // the physics radius (g.r*2) therefore reads visibly larger on screen than
  // before, crowding adjacent stones and burying the halo/shadow under it.
  // This scales the ON-SCREEN SPRITE ONLY — STONE_R and all physics/collision
  // math are untouched.
  const STONE_VISUAL_SCALE = 0.90;
  // A soft glass glint over the stone's hex window, in world space (not the
  // stone's own rotated local frame) — same reasoning as drawBallHighlight:
  // drawn after the roll rotation is restored, so it stays fixed relative to
  // the arena's light instead of spinning with the stone every roll.
  function drawStoneGlassHighlight(g, d) {
    const wcx = g.x, wcy = g.y + d * (HEX.cyFrac - 0.5);
    const whw = d * HEX.halfWFrac, whh = d * HEX.halfHFrac;
    ctx.save();
    hexPath(ctx, wcx, wcy, whw, whh);
    ctx.clip();
    // 'screen' instead of the default source-over so it visibly pops off the
    // dark glass instead of just softly tinting it — the previous version
    // was too subtle to read at a glance (see conversation).
    ctx.globalCompositeOperation = 'screen';
    const hx = wcx - whw * 0.35, hy = wcy - whh * 0.45;
    // dialed back from 0.95/0.6 peak — read as too strong/opaque once seen on
    // the bigger window, see conversation.
    const grad = ctx.createRadialGradient(hx, hy, 0, hx, hy, Math.max(whw, whh) * 0.95);
    grad.addColorStop(0, 'rgba(235,246,255,0.55)');
    grad.addColorStop(0.4, 'rgba(210,232,255,0.3)');
    grad.addColorStop(1, 'rgba(205,228,255,0)');
    ctx.beginPath();
    ctx.ellipse(hx, hy, whw * 0.7, whh * 0.48, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    // a crisp bright streak on top of the soft glow — reads unambiguously as
    // a glass reflection instead of a generic glow/light leak.
    ctx.beginPath();
    ctx.ellipse(hx, hy, whw * 0.32, whh * 0.12, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.restore();
  }
  // Two soft specular arcs (user-supplied art — design/generated/props-upscaled/
  // "light layer.png", baked to public/identicons/stone-light-layer.webp) laid
  // over the whole stone in 'soft-light' — an extra light-reflection cue on
  // top of drawStoneGlassHighlight's own hex-window glint above, not a
  // replacement for it. Same non-rotating, world-space treatment: called
  // after the roll rotation is restored, so it tracks the stone's position
  // (like the contact shadow) without spinning with it.
  function drawStoneLightLayer(g, d) {
    if (!lightLayerSprite) return;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.drawImage(lightLayerSprite, g.x - d / 2, g.y - d / 2, d, d);
    ctx.restore();
  }
  function drawStone(g) {
    const fs = (g.fallScale !== undefined) ? g.fallScale : 1;
    if (fs <= 0) return; // fully fallen: nothing left to draw
    ctx.save();
    if (fs < 1) {
      // shrinks and fades as it falls into the goal, like it's dropping into the void
      ctx.globalAlpha = fs;
      ctx.translate(g.x, g.y);
      ctx.scale(fs, fs);
      ctx.translate(-g.x, -g.y);
    }
    const halo = haloMode(g);
    if (halo !== 'off') drawAimHalo(g, halo);
    drawContactShadow(g, stoneShadowSprite, STONE_SHADOW_BOOST);
    drawSquished(g, () => {
      const sprites = bubbleSprites[g.team];
      const state = sprites && stoneLedState(g);
      const sprite = state && (sprites[state.key] || sprites['0']);
      if (sprite) {
        // pre-baked (module ring + identicon + LEDs) at load time, so this
        // draw is ~1:1 (2x oversampled) with no further resampling of fine
        // edges, and never more than 2 plain drawImage() calls regardless of
        // damage state — see stoneLedState/tryBakeBubble.
        // Scaled down from the full physics diameter — see STONE_VISUAL_SCALE.
        const d = g.r * 2 * STONE_VISUAL_SCALE;
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.rot || 0);
        if (state.dimKey && sprites[state.dimKey]) {
          // "last life" pulse: crossfade the dim floor sprite up to the same
          // bright '1' sprite the steady single-LED state already uses,
          // instead of recomputing a glow every frame.
          ctx.drawImage(sprites[state.dimKey], -d / 2, -d / 2, d, d);
          ctx.globalAlpha *= state.pulse;
          ctx.drawImage(sprite, -d / 2, -d / 2, d, d);
        } else {
          ctx.drawImage(sprite, -d / 2, -d / 2, d, d);
        }
        // dead stone: crossfade to the pre-baked desaturated sprite (see
        // tryBakeBubble/desaturateSprite — a live ctx.filter here silently
        // no-ops in some mobile in-app WebViews). deadMix (0..1) lets a
        // revived stone fade its color back in gradually instead of snapping,
        // see beginRoundReset/updateRoundReset.
        if (g.deadMix > 0.001 && sprites.dead) {
          ctx.globalAlpha = g.deadMix;
          ctx.drawImage(sprites.dead, -d / 2, -d / 2, d, d);
        }
        ctx.restore();
        drawStoneGlassHighlight(g, d);
        // drawStoneLightLayer(g, d); // removed on request, kept defined — reversible
      } else {
        drawFallbackBubble(g);
      }
    });
    ctx.restore();
  }
  // soft, cool-tinted specular highlight — gives the flat monochrome disc a
  // bit of metallic shine/depth without recoloring it. Kept subtle: a pale
  // Nimiq-blue tint rather than a full glow ring.
  function drawBallHighlight(b) {
    const hx = b.x - b.r * 0.32, hy = b.y - b.r * 0.38;
    ctx.save();
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.clip();
    const grad = ctx.createRadialGradient(hx, hy, 0, hx, hy, b.r * 0.6);
    grad.addColorStop(0, 'rgba(205,228,255,0.5)');
    grad.addColorStop(1, 'rgba(205,228,255,0)');
    ctx.beginPath();
    ctx.ellipse(hx, hy, b.r * 0.55, b.r * 0.32, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }
  function drawBall(b) {
    const fs = (b.fallScale !== undefined) ? b.fallScale : 1;
    if (fs <= 0) return; // fully fallen: nothing left to draw (same rule as drawStone)
    ctx.save();
    if (fs < 1) {
      // shrinks and fades into the goal exactly like a lost stone (see
      // drawStone) — triggered by touching the goal bar, see physicsStep.
      ctx.globalAlpha = fs;
      ctx.translate(b.x, b.y);
      ctx.scale(fs, fs);
      ctx.translate(-b.x, -b.y);
    }
    drawContactShadow(b, ballShadowSprite, 1.05);
    ctx.save();
    ctx.translate(b.x, b.y); ctx.rotate(b.rot || 0);

    if (ballSprite) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(ballSprite, -b.r, -b.r, b.r * 2, b.r * 2);
      ctx.restore();
      // drawn after restoring the roll rotation, so the highlight stays put
      // relative to the arena's light instead of spinning with the disc
      drawBallHighlight(b);
      ctx.restore(); // shrink transform
      return;
    }

    // vector fallback, only visible for the frames before the sprite loads
    ctx.beginPath(); ctx.arc(0, 0, b.r + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#12181a'; ctx.fill();

    const grad = ctx.createRadialGradient(-b.r * 0.32, -b.r * 0.38, 2, 0, 0, b.r);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#e7ebec');
    ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();

    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#12181a'; ctx.lineWidth = b.r * 0.09;
    ctx.fillStyle = '#12181a';
    const cR = b.r * 0.36;
    drawPentagon(0, 0, cR, Math.PI / 10);
    ctx.stroke();
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + i * (Math.PI * 2 / 5);
      const px = Math.cos(ang) * b.r * 0.68, py = Math.sin(ang) * b.r * 0.68;
      drawPentagon(px, py, cR * 0.58, ang + Math.PI / 10);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.ellipse(-b.r * 0.38, -b.r * 0.42, b.r * 0.26, b.r * 0.15, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();

    ctx.restore(); // rotation transform
    ctx.restore(); // shrink transform
  }
  function drawPentagon(cx, cy, r, rot) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const ang = rot - Math.PI / 2 + i * (Math.PI * 2 / 5);
      const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }

  // how much longer the aim laser reaches than the raw pull distance (the old
  // arrow's length) — gives the shot a bit more presence than its literal
  // pull distance. Still used as the reach-budget multiplier in the aim
  // cascade's setGhostBudget below, even though that cascade now simulates
  // with real friction — this factor just scales how much of that natural
  // decay gets drawn, same visual intent as before.
  const LASER_LENGTH_FACTOR = 1.98;

  // strength: 1 = fixed/full (the default — a stone's already-committed aim,
  // shown from its held pendingVx/Vy once the drag is released), or a 0..1
  // breathing value from pulseStrength(g) while that exact stone is still
  // being actively dragged — same on/off split as the stone's own halo
  // (haloMode), reusing its pulse curve so the two read as one thing.
  // Perf test (see perf audit): ctx.shadowBlur forces a real shadow-raster
  // pass on every single stroke() call, and a bounce-predicted trail can be
  // many small segments — that's a lot of expensive passes per frame while
  // aiming. LASER_FAKE_GLOW=true fakes the same soft-glow look with two
  // plain strokes instead (a wide/faint one under a sharp/opaque one, same
  // 'lighter' additive composite the halo already uses) — no shadow pass at
  // all. false restores the original ctx.shadowBlur path byte-for-byte, no
  // other change — was tied to the (now-retired) #qualityBtn toggle, see the
  // dpr comment above. Flip to false to get the real shadowBlur laser back.
  const LASER_FAKE_GLOW = true;
  // A real Gaussian blur (the shadowBlur this fakes) fades out gradually with
  // soft edges; a flat wide+opaque stroke instead reads as a harder, brighter
  // band — dialed down from 0.4/3 (which read visibly thicker/brighter than
  // the real shadowBlur laser side by side) toward that softer look.
  const LASER_GLOW_ALPHA = 0.25; // fake-glow pass opacity vs. the sharp core
  const LASER_GLOW_WIDTH_MUL = 2.2; // fake-glow pass width vs. the sharp core
  const LASER_SKIP_ALPHA = 0.03; // segments fainter than this on both ends aren't drawn at all
  function drawLaserTrail(points, team, totalLen, strength = 1) {
    if (points.length < 2 || totalLen < 1) return;
    const rgb = HALO_RGB[team];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    let cum = 0;
    for (let i = 0; i < points.length - 1; i++) {
      if (cum >= totalLen) break; // already fully faded — nothing further is visible
      const p0 = points[i], p1raw = points[i + 1];
      const segLen = Math.hypot(p1raw.x - p0.x, p1raw.y - p0.y);
      // A body simulated well past its own visual reach (see SIM_REACH_FACTOR
      // vs LASER_LENGTH_FACTOR) can end in one long final segment far longer
      // than totalLen — stretching the gradient across all of it (the old
      // behavior) spread the fade over the full geometric segment instead of
      // over totalLen, making the drawn line look much longer than intended.
      // Clamp the drawn endpoint to exactly where alpha reaches 0 instead.
      const remaining = totalLen - cum;
      const p1 = segLen > remaining ? {
        x: p0.x + (p1raw.x - p0.x) * (remaining / segLen),
        y: p0.y + (p1raw.y - p0.y) * (remaining / segLen),
      } : p1raw;
      const drawSegLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const a0 = Math.max(0, 1 - cum / totalLen) * strength;
      const a1 = Math.max(0, 1 - (cum + drawSegLen) / totalLen) * strength;
      if (LASER_FAKE_GLOW) {
        if (a0 > LASER_SKIP_ALPHA || a1 > LASER_SKIP_ALPHA) {
          const glowGrad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
          glowGrad.addColorStop(0, `rgba(255,255,255,${(0.8 * a0 * LASER_GLOW_ALPHA).toFixed(3)})`);
          glowGrad.addColorStop(1, `rgba(${rgb},${(0.65 * a1 * LASER_GLOW_ALPHA).toFixed(3)})`);
          ctx.strokeStyle = glowGrad;
          ctx.lineWidth = 2.4 * LASER_GLOW_WIDTH_MUL;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
          const coreGrad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
          coreGrad.addColorStop(0, `rgba(255,255,255,${(0.8 * a0).toFixed(3)})`);
          coreGrad.addColorStop(1, `rgba(${rgb},${(0.65 * a1).toFixed(3)})`);
          ctx.strokeStyle = coreGrad;
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      } else {
        const grad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
        grad.addColorStop(0, `rgba(255,255,255,${(0.8 * a0).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${rgb},${(0.65 * a1).toFixed(3)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.4;
        ctx.shadowColor = `rgba(${rgb},0.8)`;
        ctx.shadowBlur = 7;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      cum += segLen;
    }
    ctx.restore();
  }

  // lightsaber red: a hot white core right at the ball, bleeding out to a
  // solid, saturated red toward the tip — plain alpha blending, not 'lighter'
  // (the additive mode the bubbles' own lasers use pushes every channel
  // toward 255 against this bright icy background, which washes red out to
  // white — source-over is the only way it reads as red instead of pink-white).
  const BALL_LASER_RED = [235, 24, 24];
  function drawBallLaserTrail(points, totalLen) {
    if (points.length < 2 || totalLen < 1) return;
    ctx.save();
    ctx.lineCap = 'round';
    let cum = 0;
    for (let i = 0; i < points.length - 1; i++) {
      if (cum >= totalLen) break; // already fully faded — nothing further is visible
      const p0 = points[i], p1raw = points[i + 1];
      const segLen = Math.hypot(p1raw.x - p0.x, p1raw.y - p0.y);
      // see drawLaserTrail above — clamp the drawn endpoint to exactly where
      // alpha reaches 0 instead of stretching the gradient across a final
      // segment that runs well past totalLen.
      const remaining = totalLen - cum;
      const p1 = segLen > remaining ? {
        x: p0.x + (p1raw.x - p0.x) * (remaining / segLen),
        y: p0.y + (p1raw.y - p0.y) * (remaining / segLen),
      } : p1raw;
      const drawSegLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const a0 = Math.max(0, 1 - cum / totalLen);
      const a1 = Math.max(0, 1 - (cum + drawSegLen) / totalLen);
      if (LASER_FAKE_GLOW) {
        if (a0 > LASER_SKIP_ALPHA || a1 > LASER_SKIP_ALPHA) {
          const glowGrad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
          glowGrad.addColorStop(0, `rgba(255,255,255,${(0.95 * a0 * LASER_GLOW_ALPHA).toFixed(3)})`);
          glowGrad.addColorStop(1, `rgba(${BALL_LASER_RED.join(',')},${(0.9 * a1 * LASER_GLOW_ALPHA).toFixed(3)})`);
          ctx.strokeStyle = glowGrad;
          ctx.lineWidth = 3.2 * LASER_GLOW_WIDTH_MUL;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
          const coreGrad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
          coreGrad.addColorStop(0, `rgba(255,255,255,${(0.95 * a0).toFixed(3)})`);
          coreGrad.addColorStop(1, `rgba(${BALL_LASER_RED.join(',')},${(0.9 * a1).toFixed(3)})`);
          ctx.strokeStyle = coreGrad;
          ctx.lineWidth = 3.2;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      } else {
        const grad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
        grad.addColorStop(0, `rgba(255,255,255,${(0.95 * a0).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${BALL_LASER_RED.join(',')},${(0.9 * a1).toFixed(3)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 3.2;
        ctx.shadowColor = `rgba(${BALL_LASER_RED.join(',')},0.85)`;
        ctx.shadowBlur = 9;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      cum += segLen;
    }
    ctx.restore();
  }

  // Bounce points can jump a whole wall away for a tiny change in aim (grazing
  // angles, near a corner, crossing the goal-mouth edge), which reads as an
  // abrupt teleport when recomputed fresh every frame. Smoothing the aim
  // direction/length that FEED the aim cascade below — rather than the resulting
  // points, whose count can change between frames — makes the trail visibly
  // ease toward its new shape instead of snapping. State lives on the stone
  // itself so it persists frame to frame and across the live-drag -> committed
  // aim handoff.
  const LASER_SMOOTHING = 0.2; // was 0.1 — faster catch-up to cut the lag that gets amplified through the ball's contact-point sensitivity, feel test
  function smoothLaserAim(g, targetUx, targetUy, targetLen) {
    if (g._laserUx === undefined) {
      g._laserUx = targetUx; g._laserUy = targetUy; g._laserLen = targetLen;
    } else {
      g._laserUx += (targetUx - g._laserUx) * LASER_SMOOTHING;
      g._laserUy += (targetUy - g._laserUy) * LASER_SMOOTHING;
      g._laserLen += (targetLen - g._laserLen) * LASER_SMOOTHING;
    }
    const norm = Math.hypot(g._laserUx, g._laserUy) || 1;
    return { ux: g._laserUx / norm, uy: g._laserUy / norm, len: g._laserLen };
  }

  // ---------- Aim cascade (multi-body predictive laser) ----------
  // Composes all of the aiming team's 3 stones + the ball into one ghost
  // simulation per frame, instead of predicting each stone's laser
  // independently and only reacting to a single ball impact (the old
  // renderStoneLaser/resolveBallLaser), and instead of the constant-velocity
  // event-scheduler this itself replaced (raySegmentHitsCircle/nextWallEvent/
  // nextBlockerEvent/nextPairEvent and friends — deleted, see git history for
  // that version). That event scheduler deliberately ignored friction to keep
  // "reach" a simple budget derived from pull strength — but that meant two
  // stones with different travel times to a shared contact point compared
  // their ORIGINAL launch speeds, never accounting for how much speed either
  // would really have bled off by the time they actually meet. On a close
  // finish that could even flip who wins the collision relative to the real
  // sim, and a struck body's onward reach had no real relationship to the
  // speed it was actually given. Both were surfaced by hand-testing the old
  // system before switching to this.
  //
  // This version instead steps the same 4 bodies forward in fixed increments
  // that are physically identical to one real physicsStep() tick — same
  // FRICTION/BALL_FRICTION decay, same WALL_RESTITUTION bounce, same
  // MAX_SPEED/STOP_THRESHOLD clamps, same goal-mouth loss-fraction test, same
  // elastic impulse formula as resolveCollision (see ghostResolveCollision) —
  // just run on lightweight clones with no squish/sound/score/hit-counter
  // side effects. N ticks of this now means exactly what N real ticks of
  // physicsStep would produce if the shots were validated as-is, so the
  // ordering-sensitive cases above resolve identically to the real sim, and a
  // struck body's own onward distance is simply whatever ITS speed decays
  // over — proportional to the energy it was actually given, with no
  // separate "inherited budget" bookkeeping needed at all.
  //
  // Only 4 bodies are ever dynamic here: the 3 stones of whichever team is
  // aiming, plus the ball. The opposing team's 3 stones are static blockers —
  // a path that reaches one just stops dead there (like a wall, but with no
  // reflection), never treated as a 5th/6th/7th deflectable body (see the
  // per-scope discussion this was agreed under).
  //
  // This is a full recompute from scratch every frame — nothing here is
  // cached across frames except the smoothed starting aim (see
  // smoothLaserAim), so a change to the actively-dragged stone can freely
  // ripple into bends that were already showing on a previously-committed
  // stone's own trail.
  function getBodyAim(g) {
    if (drag && drag.entity === g) {
      let dx = drag.curX - drag.startX, dy = drag.curY - drag.startY;
      let dist = Math.hypot(dx, dy);
      if (dist > MAX_DRAG) { const s = MAX_DRAG / dist; dx *= s; dy *= s; dist = MAX_DRAG; }
      if (dist <= 6) return null;
      return { ux: dx / dist, uy: dy / dist, len: dist * LASER_LENGTH_FACTOR };
    }
    const dx = g.pendingVx, dy = g.pendingVy;
    if (!dx && !dy) return null;
    const scale = 1 / POWER_SCALE;
    const pullLen = Math.hypot(dx * scale, dy * scale);
    if (pullLen < 1) return null;
    return { ux: (dx * scale) / pullLen, uy: (dy * scale) / pullLen, len: pullLen * LASER_LENGTH_FACTOR };
  }
  // Safety cap on ticks. A full-power stone now genuinely runs to its true
  // friction stop (~615 ticks, since SIM_REACH_FACTOR no longer cuts it off
  // early) rather than the ~350 it used to take against the old, tighter
  // budget; real cascades stop long before this cap from their own
  // moving/wall/blocker conditions regardless — this just bounds the
  // pathological worst case (e.g. a body re-launched by a late collision
  // needing its own ~615-tick tail on top of however long the frame already
  // ran, plus room for the sweep boost's extended reach).
  const GHOST_MAX_TICKS = 900;
  // (Re)assigns this body's onward reach budget from whatever speed it has
  // RIGHT NOW — used both at creation (from the aimed pull strength) and
  // after every collision (from the resulting post-impulse speed), which is
  // what makes a struck body's laser length track the energy it received
  // rather than some fraction handed down from the body that hit it.
  // Safety margin for the SIMULATION's own reach — deliberately separate
  // from LASER_LENGTH_FACTOR, which still governs only the drawn/visual
  // fade length (totalLen) below, unchanged. b.budget here needs to sit
  // comfortably above the true friction-decay-to-STOP_THRESHOLD distance
  // (speed/(1-FRICTION), largest for stones) so a body's physics never
  // freezes early — a body that froze early kept acting as a phantom
  // stationary obstacle for OTHER bodies checked against it on later ticks.
  // Confirmed by hand: a fast stone whose contact point sat just past its
  // old (LASER_LENGTH_FACTOR-scaled) budget froze there instead of gliding
  // on past it like the real stone does — then a ball arriving at that same
  // spot much later (after a real prior hit) registered a spurious
  // "collision" with the frozen ghost, predicting a contact that could
  // never happen in the real sim. 4.5 clears the worst case (a max-speed
  // stone) with margin; the sweep boost's own top-up (see stepGhostBodies)
  // still stacks on top of this for a boosted body outrunning even that.
  const SIM_REACH_FACTOR = 4.5;
  const BALL_LASER_LENGTH_FACTOR = LASER_LENGTH_FACTOR; // same length as the primary for now — tune separately if needed
  // b.originTotalLen/b.originUsed track ONE stone's own reach across however
  // many legs it takes, from whenever it was last set moving from a dead
  // stop — NOT reset by every collision, only by a fresh launch. Without
  // this, a stone that grazes something early in its path (barely slowing
  // down) got a whole FRESH totalLen for the leg after, stacking on top of
  // distance it had already spent — its own total visible reach ended up
  // longer than an identical, uninterrupted shot would ever show, just for
  // having clipped something. A graze should redirect the reach a body
  // already has left, not hand it a second helping. Only stones get this —
  // the ball (kind==='ball') always gets a fresh budget from whatever speed
  // it currently has, matching "length proportional to the energy just
  // received" rather than rationing it against an earlier shot's pull.
  // Geometric length of a leg's own recorded points, optionally extended by a
  // final straight segment out to (extraX, extraY) — the body's actual
  // current position, which isn't pushed onto the leg's points yet at the
  // point this gets called (see setGhostBudget below, called before
  // startNewLeg). This is exactly the path drawLaserTrail/drawBallLaserTrail
  // will fade along once that final point IS pushed, so measuring against
  // this (rather than the incrementally-tracked b.traveled) can't drift out
  // of sync with any position correction — wall/post "kiss the rail" snaps,
  // overlap separation on a body-body hit, whatever else nudges b.x/b.y
  // outside the plain per-tick move — without needing to separately teach
  // every such correction to also bump b.traveled by the right amount.
  function legPathLen(leg, extraX, extraY) {
    const pts = leg.points;
    let d = 0;
    for (let i = 0; i < pts.length - 1; i++) d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (extraX !== undefined) {
      const last = pts[pts.length - 1];
      d += Math.hypot(extraX - last.x, extraY - last.y);
    }
    return d;
  }
  function setGhostBudget(b) {
    const speed = Math.hypot(b.vx, b.vy);
    const wasMoving = b.moving;
    // If this contact happens past the point where the leg ENDING right
    // now had already faded to invisible (measured along its own actual
    // drawn geometry, see legPathLen — not the incrementally-tracked
    // b.traveled, which can drift from it), drawing anything at all for the
    // new leg would show it floating in the dead space between where the
    // old leg's fade actually stopped and where this contact really
    // occurred — the new leg starts exactly at the contact point, not at
    // the old leg's visible tip, so any nonzero length here reads as a
    // disconnected fragment past a gap, not a continuation. There's no
    // length that avoids that once a gap exists, so any leg starting past
    // one is fully suppressed rather than merely shrunk.
    const gapped = wasMoving && legPathLen(currentLeg(b), b.x, b.y) > b.totalLen;
    b.moving = speed > 1e-4;
    if (b.moving) {
      const pullLenEquiv = speed / POWER_SCALE;
      b.budget = pullLenEquiv * SIM_REACH_FACTOR;
      const freshTotalLen = pullLenEquiv * (b.kind === 'ball' ? BALL_LASER_LENGTH_FACTOR : LASER_LENGTH_FACTOR);
      if (gapped) {
        b.totalLen = 0;
      } else if (wasMoving && b.kind !== 'ball') {
        // continuing, not a fresh launch — cap to whatever's left of THIS
        // stone's own origin reach.
        b.totalLen = Math.max(0, Math.min(freshTotalLen, b.originTotalLen - b.originUsed));
      } else {
        if (!wasMoving) {
          // fresh launch from a dead stop (this body's own aimed shot, or
          // the moment it's first struck while at rest) — new origin,
          // matching "length proportional to the energy just received".
          b.originTotalLen = freshTotalLen;
          b.originUsed = 0;
        }
        b.totalLen = freshTotalLen;
      }
      b.traveled = 0;
    }
  }
  function makeGhostBody(ref, kind, r, mass) {
    const aim = getBodyAim(ref);
    let vx = 0, vy = 0;
    if (aim) {
      const s = smoothLaserAim(ref, aim.ux, aim.uy, aim.len);
      const speed = (s.len / LASER_LENGTH_FACTOR) * POWER_SCALE;
      vx = s.ux * speed; vy = s.uy * speed;
    } else {
      ref._laserUx = ref._laserUy = ref._laserLen = undefined;
    }
    const body = {
      ref, kind, r, mass, x: ref.x, y: ref.y, vx, vy,
      moving: false, budget: 0, traveled: 0, totalLen: 0,
      originTotalLen: 0, originUsed: 0,
      // Split into "legs" — one per budget assignment — rather than one flat
      // points array: drawLaserTrail fades a segment based on cumulative
      // distance from its OWN start divided by ONE totalLen, so feeding it a
      // trail that spans a budget reset (a real collision, see
      // ghostResolveCollision) made distance-so-far vastly exceed the new
      // (much smaller) totalLen — alpha clamps to 0 for nearly the whole
      // pre-collision stretch, which read as the laser vanishing well before
      // it actually reached anything. Each leg gets its own fade instead.
      legs: [{ points: [{ x: ref.x, y: ref.y }], totalLen: 0 }],
    };
    setGhostBudget(body);
    body.legs[0].totalLen = body.totalLen;
    return body;
  }
  function currentLeg(b) { return b.legs[b.legs.length - 1]; }
  // Starts a fresh leg at the body's current position/budget — called after
  // any real velocity change (a collision) so the NEXT leg's fade tracks its
  // own distance, not distance already spent on the leg before it.
  function startNewLeg(b) {
    // close the outgoing leg at the contact point too, so it's drawn all the
    // way up to here rather than stopping wherever it last happened to be —
    // without this the leg being left behind ends with whatever point was
    // last pushed before this collision (possibly none at all, if it hadn't
    // bounced off anything yet), silently dropping its approach segment.
    currentLeg(b).points.push({ x: b.x, y: b.y });
    if (b.moving) b.legs.push({ points: [{ x: b.x, y: b.y }], totalLen: b.totalLen });
  }
  // Same elastic-impulse formula as resolveCollision (including its
  // back-solved contact normal, for the same reason: positions here are only
  // checked after each tick's move, so a fast pair can already overlap by a
  // few px by the time this runs) applied to ghost clones only — no
  // squish/sound/score/hit-counter side effects. Returns true if a real
  // impulse was applied, so the caller knows whether to record a kink point.
  function ghostResolveCollision(a, b2) {
    const dx = b2.x - a.x, dy = b2.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = a.r + b2.r;
    if (dist === 0 || dist >= minDist) return false;
    const rvx = b2.vx - a.vx, rvy = b2.vy - a.vy;
    let nx = dx / dist, ny = dy / dist;
    const A = rvx * rvx + rvy * rvy;
    if (A > 1e-6) {
      const pv = dx * rvx + dy * rvy;
      const C = dist * dist - minDist * minDist;
      const D = pv * pv - A * C;
      if (D >= 0) {
        const t = Math.max(0, Math.min(1, (pv + Math.sqrt(D)) / A));
        const cdx = dx - rvx * t, cdy = dy - rvy * t;
        const cdist = Math.hypot(cdx, cdy);
        if (cdist > 1e-6) { nx = cdx / cdist; ny = cdy / cdist; }
      }
    }
    const overlap = (minDist - dist) / 2;
    a.x -= nx * overlap; a.y -= ny * overlap;
    b2.x += nx * overlap; b2.y += ny * overlap;
    // This push-apart moves each body past whatever per-tick movement already
    // counted toward traveled this frame — without adding it here, the gap
    // check below (traveled vs. totalLen, in setGhostBudget) compares against
    // a position that's stale by exactly this much, so it can wave through a
    // leg that starts past where the outgoing leg's own points array (which
    // DOES include this correction, via startNewLeg below) actually stops
    // rendering: a real gap the check was supposed to catch.
    a.traveled += overlap; b2.traveled += overlap;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return false;
    let j = -(1 + BODY_RESTITUTION) * velAlongNormal;
    j /= (1 / a.mass + 1 / b2.mass);
    j *= BOUNCE_BOOST;
    const impX = j * nx, impY = j * ny;
    a.vx -= impX / a.mass; a.vy -= impY / a.mass;
    b2.vx += impX / b2.mass; b2.vy += impY / b2.mass;
    // If either side had already traveled past its OWN visible length
    // (a.traveled/a.totalLen — read here, before setGhostBudget resets them)
    // by the time they actually meet, this contact happens partly or wholly
    // within the simulation's "invisible" tail (SIM_REACH_FACTOR reaches
    // further than LASER_LENGTH_FACTOR ever draws). setGhostBudget carries
    // that overshoot forward as debt subtracted from the next leg's
    // totalLen, so the new leg shrinks continuously toward zero as the
    // contact point drifts deeper into the invisible tail, instead of a
    // hard on/off cutoff at the boundary.
    setGhostBudget(a); setGhostBudget(b2);
    startNewLeg(a); startNewLeg(b2);
    return true;
  }
  // Ghost-body counterpart to physicsStep's collideGoalSide (see the comment
  // there for why posts need their own corner check instead of a hard
  // center-y switch) — same math, but returns the drawn contact point instead
  // of playing squish/audio, since this runs every frame just to predict the
  // laser line, not to resolve a real impact.
  function ghostCollideGoalSide(b, wallX) {
    let closestY;
    if (b.y <= GY0) closestY = b.y;
    else if (b.y >= GY1) closestY = b.y;
    else closestY = (b.y - GY0 <= GY1 - b.y) ? GY0 : GY1;
    const dx = b.x - wallX, dy = b.y - closestY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0 || dist >= b.r) return null;
    let nx = dx / dist;
    const ny = dy / dist;
    // See physicsStep's collideGoalSide for why the flat-wall branch pins
    // the push direction instead of trusting the raw (possibly
    // already-crossed) displacement.
    if (dy === 0) nx = wallX < CENTER_X ? 1 : -1;
    const vDotN = b.vx * nx + b.vy * ny;
    const overlap = b.r - dist;
    b.x += nx * overlap; b.y += ny * overlap;
    b.traveled += overlap; // same untracked-correction gap risk as ghostResolveCollision above
    b.vx -= (1 + WALL_RESTITUTION) * vDotN * nx;
    b.vy -= (1 + WALL_RESTITUTION) * vDotN * ny;
    return { x: b.x - nx * b.r, y: b.y - ny * b.r };
  }
  // Ghost-body counterpart to collideCorner above — same clamped-segment
  // math, but returns the drawn contact point instead of playing
  // squish/audio, matching ghostCollideGoalSide's own split.
  function ghostCollideCorner(b, c) {
    const dx0 = c.p2.x - c.p.x, dy0 = c.p2.y - c.p.y;
    const len2 = dx0 * dx0 + dy0 * dy0;
    let t = len2 > 0 ? ((b.x - c.p.x) * dx0 + (b.y - c.p.y) * dy0) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = c.p.x + dx0 * t, cy = c.p.y + dy0 * t;
    const dx = b.x - cx, dy = b.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist === 0 || dist >= b.r) return null;
    const nx = dx / dist, ny = dy / dist;
    const vDotN = b.vx * nx + b.vy * ny;
    const overlap = b.r - dist;
    b.x += nx * overlap; b.y += ny * overlap;
    b.traveled += overlap;
    b.vx -= (1 + WALL_RESTITUTION) * vDotN * nx;
    b.vy -= (1 + WALL_RESTITUTION) * vDotN * ny;
    return { x: b.x - nx * b.r, y: b.y - ny * b.r };
  }
  // Combined-radius proximity to any blocker — used only as a signal to
  // defer an ally-pair resolution (see stepGhostBodies), not as the actual
  // blocker stop condition (that uses bl.r alone, see below).
  function nearAnyBlocker(b, blockers) {
    for (const bl of blockers) if (Math.hypot(bl.x - b.x, bl.y - b.y) < b.r + bl.r) return true;
    return false;
  }
  // One tick == one real physicsStep() call for these bodies: move, decay,
  // clamp, wall/goal check, blocker check, own-pair check — same order
  // physicsStep itself uses (move+friction+clamp for everyone first, then
  // walls, then pairwise), so a shot's predicted path is what N real ticks
  // would actually produce.
  function stepGhostBodies(bodies, blockers, boostZone) {
    for (const b of bodies) {
      if (!b.moving) continue;
      const moveDist = Math.hypot(b.vx, b.vy);
      b.x += b.vx; b.y += b.vy;
      b.traveled += moveDist;
      b.originUsed += moveDist; // cumulative across this body's own legs — see setGhostBudget
      let fr = b.kind === 'ball' ? BALL_FRICTION : FRICTION;
      if (boostZone && Math.hypot(b.x - boostZone.x, b.y - boostZone.y) <= boostZone.r) {
        fr = withSweepBoost(fr);
        // b.budget (the SIMULATION's own reach, see setGhostBudget) is now
        // deliberately generous and rarely the binding stop condition, so
        // topping it up here has little effect on its own — b.totalLen
        // (the DRAWN/visual fade length) is what actually needs the same
        // top-up, so the predicted reach visibly stretches through the
        // patch instead of only showing up later via a faster post-collision
        // leg. Both get bumped together so a boosted body's true stop point
        // (wherever that ends up) and what's drawn of it stay consistent.
        // No effect whenever no zone is active, or for any body whose path
        // never enters one (boostZone is only ever the aiming team's own
        // not-yet-committed patch — see runAimCascade) — doesn't touch
        // anything's tuned reach otherwise.
        const bonus = moveDist * SWEEP_FRICTION_BONUS;
        b.budget += bonus;
        b.totalLen += bonus;
        b.originTotalLen += bonus; // keep this body's own origin ceiling (see setGhostBudget) from clawing the bonus back on a later continuation leg
        // currentLeg(b).totalLen was copied from b.totalLen once, when this
        // leg started — bumping b.totalLen alone never reached the drawn
        // leg unless a later collision happened to start a fresh one (which
        // re-copies the by-then-larger value). A single-segment shot with no
        // collision at all never got that re-copy, so the sweep boost was
        // invisible on exactly the plain, uninterrupted primary laser.
        currentLeg(b).totalLen = b.totalLen;
      }
      b.vx *= fr; b.vy *= fr;
      const spd = Math.hypot(b.vx, b.vy);
      if (spd < STOP_THRESHOLD || b.traveled >= b.budget) {
        b.vx = 0; b.vy = 0; b.moving = false;
        currentLeg(b).points.push({ x: b.x, y: b.y });
        continue;
      }
      if (spd > MAX_SPEED) { const s = MAX_SPEED / spd; b.vx *= s; b.vy *= s; }
      // Goal bars: same terminal-state simplification the old loss-fraction
      // check used ("reaching the goal mouth ... has nothing to predict") —
      // touching a bar hard-stops the predicted line right there instead of
      // replicating the kill/goal animation, which has nothing to predict.
      if (collideBar(b, BAR_LEFT) || collideBar(b, BAR_RIGHT)) {
        b.vx = 0; b.vy = 0; b.moving = false;
        currentLeg(b).points.push({ x: b.x, y: b.y });
        continue;
      }

      // Corner boxes gate BOTH the flat-wall/post checks below AND the
      // corner check itself — same reasoning as physicsStep (see its own
      // comment): exactly one collision model per spot, so a fast-moving
      // predicted line can't get caught by the wrong (axis-aligned instead
      // of diagonal) normal right at a cut corner.
      const inTL = inCornerBox(b, CORNERS[0].box), inTR = inCornerBox(b, CORNERS[1].box);
      const inBL = inCornerBox(b, CORNERS[2].box), inBR = inCornerBox(b, CORNERS[3].box);

      let hitWall = null; // {axis, wall} — cosmetic snap for the drawn point, see below
      if (!inTL && !inTR && b.y - b.r < FY0) { b.y = FY0 + b.r; b.vy = -b.vy * WALL_RESTITUTION; hitWall = { axis: 'y', wall: FY0 }; }
      if (!inBL && !inBR && b.y + b.r > FY1) { b.y = FY1 - b.r; b.vy = -b.vy * WALL_RESTITUTION; hitWall = { axis: 'y', wall: FY1 }; }
      // Recess interior (post tip -> return -> back wall -> return -> post
      // tip): same closed segment chain as physicsStep's GOAL_RECESSES, not
      // the old flat-wall/notch approximation — see its own comment. In
      // practice the bar check above almost always wins first for the ball,
      // but a stone's predicted line can still reach in here.
      const inRecessL = inRecessBox(b, GOAL_RECESSES[0].box), inRecessR = inRecessBox(b, GOAL_RECESSES[1].box);
      if (!inTL && !inBL && !inRecessL && b.x - b.r < FX0) { const pt = ghostCollideGoalSide(b, FX0); if (pt) hitWall = pt; }
      if (!inTR && !inBR && !inRecessR && b.x + b.r > FX1) { const pt = ghostCollideGoalSide(b, FX1); if (pt) hitWall = pt; }
      if (inRecessL) for (const s of GOAL_RECESSES[0].segments) { const pt = ghostCollideCorner(b, s); if (pt) hitWall = pt; }
      if (inRecessR) for (const s of GOAL_RECESSES[1].segments) { const pt = ghostCollideCorner(b, s); if (pt) hitWall = pt; }
      for (const c of CORNERS) {
        if (inCornerBox(b, c.box)) { const pt = ghostCollideCorner(b, c); if (pt) hitWall = pt; }
      }
      if (hitWall) {
        // cosmetic only: the DRAWN point kisses the rail/post exactly. b.x/b.y
        // themselves stay at the r-correct contact position set above —
        // snapping them onto the rail line would shift the tracked center
        // by a whole radius, corrupting every following tick's checks.
        // hitWall.axis means a flat FY0/FY1 hit above ({axis,wall} form); a
        // post/x-wall hit already comes back as the resolved {x,y} point from
        // ghostCollideGoalSide.
        currentLeg(b).points.push(hitWall.axis ? (hitWall.axis === 'y' ? { x: b.x, y: hitWall.wall } : { x: hitWall.wall, y: b.y }) : hitWall);
      }
    }
    for (const b of bodies) {
      if (!b.moving) continue;
      for (const bl of blockers) {
        // bl.r alone, not b.r+bl.r: opposing stone is a hard stop, no
        // deflection (per the agreed scope), but the drawn line should only
        // react once it actually enters the blocker's own visible circle —
        // padding this out to the combined radius made the laser feel
        // "magnetic", stopping well before it visibly touched anything.
        if (Math.hypot(bl.x - b.x, bl.y - b.y) < bl.r) {
          b.vx = 0; b.vy = 0; b.moving = false;
          currentLeg(b).points.push({ x: b.x, y: b.y });
          break;
        }
      }
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], c = bodies[j];
        if (!a.moving && !c.moving) continue; // two bodies both already at rest can't newly touch
        // Two allies converging on the same opposing stone from different
        // sides close in on EACH OTHER (their own combined radius) slightly
        // before either is within its own combined radius of that stone —
        // the thin-line blocker check above only reacts at the visible
        // silhouette (bl.r), half that distance. Defer resolving an ally
        // collision while either side is still within striking distance of
        // an opponent (using the same combined-radius scale the ally check
        // itself uses, for a fair comparison) — it'll either stop clean on
        // the opponent a few ticks later, or, if it was never really headed
        // there, the two will still be just as close next tick and collide
        // then instead. A real but rare edge case this doesn't handle well:
        // two allies genuinely colliding right next to an unrelated,
        // uninvolved opponent stone could see their own collision delayed a
        // few ticks by this same check.
        if (nearAnyBlocker(a, blockers) || nearAnyBlocker(c, blockers)) continue;
        // ghostResolveCollision itself starts a fresh leg (at the corrected
        // post-overlap position) for each side that ends up moving — no
        // extra point-push needed here.
        ghostResolveCollision(a, c);
      }
    }
  }
  function runAimCascade(team) {
    const opponentTeam = team === 'A' ? 'B' : 'A';
    const blockers = entities[opponentTeam].filter(g => !g.out && !g.falling);
    const bodies = entities[team].filter(g => !g.out && !g.falling)
      .map(g => makeGhostBody(g, 'stone', STONE_R, STONE_MASS));
    // howTo: no ball exists (entities.ball sits inert and hidden, see
    // resetPositions), so its predicted-path ghost trail has nothing real to
    // predict for — per explicit request ("le laser secondaire de la balle
    // apparait parfois alors qu'il n'y a pas de balle"), it must never draw.
    if (vibe !== 'curling' && !howTo) bodies.push(makeGhostBody(entities.ball, 'ball', BALL_R, BALL_MASS));

    // Only the aiming team's own not-yet-committed patch can ever apply here
    // (this cascade only ever renders for the currently-aiming team's own
    // screen, never the opponent's — see render()), so there's no visibility
    // leak in letting the prediction react to it live as it's dragged around.
    const boostZone = sweep[team].active ? sweep[team] : null;
    for (let tick = 0; tick < GHOST_MAX_TICKS && bodies.some(b => b.moving); tick++) {
      stepGhostBodies(bodies, blockers, boostZone);
    }
    for (const b of bodies) {
      if (b.moving) { currentLeg(b).points.push({ x: b.x, y: b.y }); b.moving = false; }
    }
    return bodies;
  }
  // During the post-commit retract window, eats each body's own legs back
  // from the far tip toward the stone: walks legs in stone-to-tip order,
  // handing each one min(its own length, whatever budget is left), so the
  // budget always runs out on the FARTHEST leg first and the leg touching
  // the stone is the last to shrink — reading as the whole trail reeling
  // back into its stone rather than each leg fading in place independently.
  function applyLaserRetract(body) {
    const totalPathLen = body.legs.reduce((sum, leg) => sum + leg.totalLen, 0);
    let remaining = totalPathLen * (1 - laserRetractProgress());
    for (const leg of body.legs) {
      const original = leg.totalLen;
      leg.totalLen = Math.max(0, Math.min(original, remaining));
      remaining -= original;
    }
  }
  function renderAimCascade(team) {
    const bodies = runAimCascade(team);
    const retracting = phase === 'pending';
    for (const b of bodies) {
      // The ball's own trail isn't a programmed shot — it's just the
      // predicted path of a body the aiming team's stones might strike, so
      // it has nothing of its own to "retract into". Rather than animate it
      // shrinking like the stones' lasers, it simply cuts the instant PLAY
      // is pressed, same as every laser did before the retract animation.
      if (retracting && b.kind === 'ball') continue;
      // one strength per body (not recomputed per leg/segment) so a stone's
      // whole predicted trail — every bounce leg — breathes together, same
      // pulse/fixed split as its own halo (haloMode): pulses only while it's
      // the one actually being dragged, fixed once released. The ball's own
      // trail never pulses (b.ref is entities.ball, no halo concept there).
      // Floor at 50% (not 0) so the laser never goes fully dark mid-pulse —
      // just the laser's own remap, pulseStrength(g) itself stays 0..1 for
      // the halo/LEDs.
      const strength = (b.kind !== 'ball' && drag && drag.entity === b.ref) ? 0.5 + 0.5 * pulseStrength(b.ref) : 1;
      if (retracting) applyLaserRetract(b);
      for (const leg of b.legs) {
        if (leg.totalLen < 1 || leg.points.length < 2) continue;
        if (b.kind === 'ball') drawBallLaserTrail(leg.points, leg.totalLen);
        else drawLaserTrail(leg.points, team, leg.totalLen, strength);
      }
    }
  }
  // "Power" toolbar toggle, off-branch: a straight direction/energy readout
  // per stone — no ghost simulation, no bounces, no ball trail. Each stone
  // still eases via smoothLaserAim (shared with the cascade) so flipping the
  // toggle mid-drag doesn't introduce a second, differently-behaved smoothing
  // path; only the shape drawn from that smoothed aim changes.
  function renderBasicLaser(team) {
    const retracting = phase === 'pending';
    for (const g of entities[team]) {
      if (g.out || g.falling) continue;
      const aim = getBodyAim(g);
      if (!aim) { g._laserUx = g._laserUy = g._laserLen = undefined; continue; }
      const s = smoothLaserAim(g, aim.ux, aim.uy, aim.len);
      const points = [{ x: g.x, y: g.y }, { x: g.x + s.ux * s.len, y: g.y + s.uy * s.len }];
      // floor at 50%, same laser-only remap as renderAimCascade above
      const strength = (drag && drag.entity === g) ? 0.5 + 0.5 * pulseStrength(g) : 1;
      // single segment, no legs — retracting it toward the stone is just
      // shrinking totalLen, same as applyLaserRetract's per-leg case above.
      const drawLen = retracting ? s.len * (1 - laserRetractProgress()) : s.len;
      drawLaserTrail(points, team, drawLen, strength);
    }
  }

  // ---------- Atmosphere (suspended ice-dust) ----------
  // Three parallax layers of slow-drifting dust motes, drawn last each frame
  // so they read as floating in front of the whole scene at low alpha rather
  // than as a gameplay element. Positions live in the same 1200x905 logical
  // space as everything else in this file (see W/H above).
  function createAtmosphere(w, h) {
    const LAYERS = [
      { count: 40, size: [0.4, 0.9], speed: 2, alpha: 0.10 }, // far
      { count: 30, size: [0.6, 1.3], speed: 4, alpha: 0.16 }, // mid
      { count: 20, size: [0.8, 1.8], speed: 7, alpha: 0.22 }, // near
    ];
    const rand = (a, b) => a + Math.random() * (b - a);
    const TAU = Math.PI * 2;

    function makeParticle(layer) {
      return {
        x: rand(0, w),
        y: rand(0, h),
        size: rand(layer.size[0], layer.size[1]),
        baseAlpha: layer.alpha * rand(0.6, 1),
        alpha: 0,
        // slow, organic drift: each particle gets its own tiny wander phase
        angle: rand(0, TAU),
        angleDrift: rand(-0.15, 0.15),
        speed: layer.speed * rand(0.5, 1.2),
        wobblePhase: rand(0, TAU),
        wobbleSpeed: rand(0.05, 0.15),
        wobbleAmp: rand(2, 6),
        // twinkle state
        twinkle: 0,
        twinkleTarget: 0,
        nextTwinkleAt: rand(3, 12),
      };
    }

    const particles = [];
    LAYERS.forEach(layer => {
      for (let i = 0; i < layer.count; i++) particles.push(makeParticle(layer));
    });

    function update(dt) {
      for (const p of particles) {
        // gentle heading change over time — no repeating loop
        p.angle += p.angleDrift * dt * 0.2;
        const dx = Math.cos(p.angle) * p.speed * dt;
        const dy = Math.sin(p.angle) * p.speed * dt * 0.4; // mostly horizontal drift

        // subtle perpendicular wobble for organic float
        p.wobblePhase += p.wobbleSpeed * dt;
        const wob = Math.sin(p.wobblePhase) * p.wobbleAmp * dt;

        p.x += dx + wob;
        p.y += dy;

        // wrap around edges softly (respawn just outside opposite edge)
        const m = 20;
        if (p.x < -m) p.x = w + m;
        if (p.x > w + m) p.x = -m;
        if (p.y < -m) p.y = h + m;
        if (p.y > h + m) p.y = -m;

        // fade in on spawn/wrap
        p.alpha += (p.baseAlpha - p.alpha) * Math.min(1, dt * 1.5);

        // occasional delicate twinkle
        p.nextTwinkleAt -= dt;
        if (p.nextTwinkleAt <= 0 && p.twinkleTarget === 0) {
          p.twinkleTarget = rand(0.4, 0.9);
          p.nextTwinkleAt = rand(6, 16);
        }
        if (p.twinkleTarget > 0) {
          p.twinkle += (p.twinkleTarget - p.twinkle) * Math.min(1, dt * 3);
          if (Math.abs(p.twinkle - p.twinkleTarget) < 0.02) p.twinkleTarget = 0; // fade back down
        } else if (p.twinkle > 0.001) {
          p.twinkle += (0 - p.twinkle) * Math.min(1, dt * 2);
        } else {
          p.twinkle = 0;
        }
      }
    }

    function draw(g) {
      g.save();
      for (const p of particles) {
        const a = Math.min(1, p.alpha + p.twinkle);
        if (a <= 0.01) continue;
        const r = p.size * (1 + p.twinkle * 0.8);
        g.beginPath();
        g.fillStyle = `rgba(230,240,255,${a.toFixed(3)})`;
        g.arc(p.x, p.y, r, 0, TAU);
        g.fill();
        if (p.twinkle > 0.05) {
          // soft glow halo only while twinkling
          g.beginPath();
          g.fillStyle = `rgba(230,240,255,${(p.twinkle * 0.15).toFixed(3)})`;
          g.arc(p.x, p.y, r * 3, 0, TAU);
          g.fill();
        }
      }
      g.restore();
    }

    return { update, draw };
  }
  // Neutralized for perf (see perf audit): update()/draw() below are no longer
  // called each frame — kept defined, not deleted, in case this survives the
  // visual redesign. Re-enable by uncommenting the two call sites below (was
  // briefly wired to a #qualityBtn "high" toggle, since retired).
  const atmosphere = createAtmosphere(W, H);

  function render() {
    drawBackground();
    drawCreaseGlow();
    drawBarGlow();
    drawStoneBarFlash();
    // laser drawn before the bubbles/identicons so it reads as coming from
    // underneath the stone instead of overlapping its face
    const drawAimLaser = isBasicLaser() ? renderBasicLaser : renderAimCascade;
    if (phase === 'aimA') drawAimLaser('A');
    else if (phase === 'aimB') drawAimLaser('B');
    // lanWait too: local shot is locked in but stays visible as feedback
    // while waiting on the opponent, instead of vanishing the instant PLAY
    // is pressed.
    else if (phase === 'lanAim' || phase === 'lanWait') drawAimLaser(myTeam);
    // Reveal just started: keep drawing the just-committed team's laser
    // while it retracts into its stones (see playLaunchEngine/retractTeam) —
    // renderAimCascade/renderBasicLaser themselves shrink it frame by frame.
    else if (phase === 'pending' && retractTeam && laserRetractProgress() < 1) drawAimLaser(retractTeam);
    // under the stones/ball (painter's order) — see drawSweepZone's own comment
    drawSweepOverlay();
    entities.A.forEach(g => { if (!g.out) drawStone(g); });
    entities.B.forEach(g => { if (!g.out) drawStone(g); });
    if (vibe !== 'curling' && !entities.ball.out) drawBall(entities.ball);
    // atmosphere.draw(ctx); // neutralized for perf, see note at createAtmosphere()
    syncSweepButton();
    drawHandoffMask();
    drawChatMaskBg();
    // matchIntroAnimDone, not phase !== 'matchIntro': the 'matchStart' audio
    // clip driving beginAimPhase(true)'s onEnded (see beginMatchIntro) can in
    // principle finish (or fail to decode and fire 'ended' near-instantly)
    // before the slide tween itself is done, which would flip phase to
    // 'aimA' — and reveal the tutorial overlay — while the stone is still
    // visibly sliding toward center. Gating on the tween's own done-flag
    // instead avoids a one-frame-or-more spotlight/stone mismatch either way.
    if (howTo && matchIntroAnimDone) syncHowTo();
  }

  // ---------- Dev perf logging (temporary — see perf audit, delete once done) ----------
  // On-screen counter removed on request (unreadable while also playing) —
  // this keeps just the silent console-only spike log. Reports raw
  // (uncapped) frame time, not the atmosphere-safe clamped `dt` below, so
  // real stalls/spikes over 100ms show up instead of being hidden by that
  // clamp.
  const PERF_SPIKE_MS = 50; // ~20fps or worse
  function logSlowFrame(rawMs) {
    if (rawMs > PERF_SPIKE_MS) {
      console.warn(`[perf] slow frame: ${rawMs.toFixed(0)}ms  phase=${phase}  t=${(performance.now() / 1000).toFixed(1)}s`);
    }
  }

  // ---------- Main loop ----------
  // One flag, one path each way — flip to false to fully restore the previous
  // "one physicsStep() per rendered frame" behavior (see perf audit: without
  // this, a whole shot plays in slow motion whenever the render framerate
  // dips, since physicsStep()'s fixed per-call increment was previously tied
  // 1:1 to however often rAF happened to fire instead of real elapsed time).
  // Safe for LAN determinism: physicsStep() itself is unchanged, still called
  // with the exact same fixed increment every time — this only changes HOW
  // OFTEN it's called per rendered frame (via the accumulator below), not
  // what each call does or how many total calls it takes to settle, so both
  // clients still reach the identical settled state from identical shots.
  const PHYSICS_FIXED_TIMESTEP = true;
  const PHYSICS_STEP_MS = 1000 / 48.6; // was 1000/60 — ~19% slower playback for readability (two 10% passes), same distances/impacts (fixed-step trajectory unchanged, just spread over more real time), feel test
  const PHYSICS_MAX_CATCHUP_STEPS = 6; // caps a stall's catch-up burst to ~100ms of ticks per frame, same order as the dt clamp below
  let physicsAccumMs = 0;
  let settleFrames = 0;
  let lastFrameTime = null;

  // Idle-render throttle (perf/battery — see conversation): while a team is
  // just deciding their shot (aimA/aimB/lanAim, per isAimingPhase) with no
  // drag in progress, nothing on screen changes beyond slow decorative
  // pulses (halo breathing, hex-timer glow) — repainting the full mobile
  // canvas (~25 megapixels at the dpr cap) for that at 60fps is wasted GPU
  // work/heat for no visible benefit. Dropped to 30fps only in that
  // specific idle case; an active drag (the aim laser has to track the
  // finger smoothly) or any other phase (sim, goal, straighten, etc. —
  // real motion actually happening) still renders every rAF tick.
  const IDLE_RENDER_INTERVAL_MS = 1000 / 30;
  let lastRenderTime = 0;

  // Render interpolation (see perf audit conversation): the fixed-step
  // catch-up loop below can leave a leftover fraction of a tick's worth of
  // real time on the table each rendered frame (rAF doesn't line up with
  // PHYSICS_STEP_MS boundaries) — drawing the raw post-tick position every
  // time means the on-screen spacing between frames isn't perfectly even
  // even though the underlying simulation speed is correct, which reads as
  // a faint stutter. Snapshotting x/y right before each tick (not after)
  // gives render() the two bracketing states it needs to blend between.
  function snapshotPrevPositions() {
    for (const e of allEntities()) { e.prevX = e.x; e.prevY = e.y; e.prevRot = e.rot; }
  }
  // Shortest-path angle blend — a plain lerp between e.g. 6.2 and 0.1 would
  // spin the long way around instead of the short ~0.2 rad hop through 0,
  // reading as a brief wrong-direction flick every time rotation wraps.
  function lerpAngle(a, b, t) {
    const tau = Math.PI * 2;
    const diff = (((b - a) % tau) + tau * 1.5) % tau - tau / 2;
    return a + diff * t;
  }
  function runSimTick() {
    snapshotPrevPositions();
    if (phase === 'sim') {
      const result = physicsStep();
      if (result === 'goalA' || result === 'goalB' || result === 'wipeoutA' || result === 'wipeoutB') {
        phase = 'goal';
        onGoal(result.endsWith('A') ? 'A' : 'B', result.startsWith('wipeout'));
      } else if (allSettled()) {
        settleFrames++;
        if (settleFrames > 6) {
          settleFrames = 0;
          entities.A.forEach(g => { g.used = false; g.pendingVx = 0; g.pendingVy = 0; });
          entities.B.forEach(g => { g.used = false; g.pendingVx = 0; g.pendingVy = 0; });
          beginStraighten();
        }
      } else settleFrames = 0;
    } else if (phase === 'goal') {
      // Keep stepping physics through the GOAL_PAUSE_MS pause purely so any
      // stones/ball still gliding from the shot finish decelerating naturally
      // instead of freezing mid-slide the instant the goal was detected —
      // this is also what lets a dead stone's shrink-into-the-void animation
      // (see the deadPending block in physicsStep) actually run. Return value
      // (another goalA/goalB/wipeout*) is ignored on purpose.
      physicsStep();
      // Score bump + result panel wait for the pause, any dying stone's
      // disappear animation, AND every entity actually coming to rest —
      // the ball no longer freezes the instant it scores (see the ball
      // branch in physicsStep's bar-hit check), it bounces off the bar and
      // plays out its own glide same as any other shot, so allSettled() is
      // what now guarantees the panel never shows while it's still visibly
      // rolling/bouncing (see resolveGoal above).
      if (goalPauseElapsed && !deadStonesStillAnimating() && allSettled()) resolveGoal();
    }
  }

  // Real in-app teardown for returning to mode-select without a page reload
  // (see the signal/gameTimeouts/rafId plumbing set up right after the
  // canvas.dataset.nbStarted guard at the top of this closure) — replaces
  // the old location.reload() this whole file and main.js used to rely on
  // for "exit" (see CLAUDE.md-worthy history: that reload was what made
  // "Quitter" slow, flash white, and always land back on the splash screen
  // instead of mode-select; it also papered over a real bug where a second
  // startGame() call — e.g. a LAN reconnect race, see net.onOpponentJoined
  // above — stacked a second uncancelled rAF loop on top of the first).
  // Idempotent — safe to call more than once (e.g. a manual "Quitter" racing
  // a LAN disconnect) since `torn` short-circuits repeats. Returned to the
  // caller (see the bottom of startGame()) for main.js's own exit paths
  // (toolbar/logo confirm dialogs); goalMenuBtn/replayExitBtn above call it
  // directly since they already have closure access, then hand off to
  // opts.onExit for the "now show mode-select" part this closure doesn't own.
  // #chatThread and #syncToast are persistent, page-level DOM shared across
  // every match instance — unlike canvas-drawn content (redrawn fresh every
  // frame straight from this instance's own state, so it can never leak) or
  // #chatComposeEmojiPicker (already rebuilt fresh per instance, see
  // buildEmojiPicker's own comment on this same class of bug), these two
  // only ever change reactively (a chat send, a sync-mismatch event) — with
  // nothing to react to yet in a brand new match, whatever they were last
  // set to keeps right on showing. Called both by stopGame() below (leaving
  // a match entirely) and by "Play Again" (same instance, so there's no
  // fresh DOM to inherit a clean slate from either).
  function resetSharedMatchChrome() {
    chatThread.innerHTML = '';
    syncToast.classList.add('hidden'); syncToast.classList.remove('problem');
  }

  function stopGame() {
    if (torn) return;
    torn = true;
    abortController.abort();
    if (rafId !== null) cancelAnimationFrame(rafId);
    gameTimeouts.forEach(clearTimeout);
    audio.stopAmbience();
    audio.stopAllGlides();
    if (net) {
      // Suppress the "Match over" dead-end screen (net.onDisconnect above)
      // that ws.close() below would otherwise trigger — this is an
      // intentional exit, not a dropped connection.
      net.onDisconnect(() => {});
      net.close();
    }
    hideOverlay();
    // #overlay is shared, page-level DOM (see resetSharedMatchChrome's own
    // comment) — showNetDeadEnd's click-anywhere-to-exit handler must not
    // survive past this instance, or a stray click on some unrelated dialog
    // (e.g. main.js's own "Quit the match?" confirm, next time #overlay is
    // reused) would silently trigger this dead closure's stopGame()/onExit.
    overlay.onclick = null;
    if (isReplay) hideReplayBar();
    chatMask.classList.add('hidden');
    setChatUnread(false);
    resetSharedMatchChrome();
    // Visual ready-state left on #startOverlay's tiles (see halfA/halfB
    // above) would otherwise show as already-ready the next time a local
    // match is picked from mode-select.
    halfA.classList.remove('ready'); checkA.textContent = '○';
    halfB.classList.remove('ready'); checkB.textContent = '○';
    if (howTo) teardownHowTo();
    canvas.dataset.nbStarted = '';
  }

  function loop() {
    if (torn) return; // stray already-scheduled frame after stopGame() aborted the loop below
    const now = performance.now();
    // Captured before updateHandoff() runs below (which can flip
    // handoff.stage 'in'->'shown' mid-tick): the freeze check further down
    // must use this pre-update snapshot, not a fresh read after the phase
    // update, otherwise the exact frame the mask finishes fading in would
    // both flip to 'shown' AND get its own render() skipped in the same
    // tick — freezing on the last still-fading-in frame instead of the
    // fully opaque one nobody's meant to see change again.
    const wasHandoffShown = handoff !== null && handoff.stage === 'shown';
    if (import.meta.env.DEV) logSlowFrame(lastFrameTime === null ? 0 : now - lastFrameTime);
    // Capped so a backgrounded-tab reflow doesn't fling every particle across
    // the board in one giant jump when the frame comes back.
    const dt = lastFrameTime === null ? 1 / 60 : Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    // True pause: freeze the exact current frame, mid-shot included — no
    // physics/animation update runs at all while paused, only render() below
    // keeps repainting the same state. maybeAdvanceReplay()'s own
    // !replayPlaying guard only ever covered "don't auto-start the next
    // manche"; this is what actually stops an in-flight shot from continuing
    // to move once the user hits pause (see CLAUDE.md replay section).
    if (isReplay && !replayPlaying) {
      render();
      rafId = requestAnimationFrame(loop);
      return;
    }
    // atmosphere.update(dt); // neutralized for perf, see note at createAtmosphere()
    // LAN: each client enforces its own local 30s clock independently (no
    // arbiter-side timer) — see "timer nimball" design note. Solo vs IA: same
    // 30s cap on the human's own turn (aiTeam's shots are already decided in
    // prepareAiShots(), so only the human side can ever be the one stalling).
    // Pass & Play now caps too (per feedback): with the hand-off mask up
    // between turns, the team whose turn it is may not even be holding the
    // device yet when their aim phase actually starts, so the same "someone
    // might not be paying attention" case applies. A stone whose drag hasn't
    // been released yet still has pendingVx/Vy reset to 0 from onPointerDown,
    // so cancelling the in-flight drag and reusing the normal PLAY submission
    // path naturally sends "no shot" for it — and for Pass & Play that submit
    // itself starts the next hand-off mask (handoffB/handoffWatch), same as a
    // real tap on PLAY would.
    if (((net && phase === 'lanAim') || (aiTeam && phase === 'aimA') || (!net && !aiTeam && !howTo && (phase === 'aimA' || phase === 'aimB'))) && turnTimerProgress() >= 1) {
      if (drag && !mobile) document.body.style.cursor = '';
      drag = null;
      onValidate();
    }
    if (phase === 'sim' || phase === 'goal') {
      if (PHYSICS_FIXED_TIMESTEP) {
        physicsAccumMs += dt * 1000;
        let steps = 0;
        while (physicsAccumMs >= PHYSICS_STEP_MS && steps < PHYSICS_MAX_CATCHUP_STEPS && (phase === 'sim' || phase === 'goal')) {
          runSimTick();
          physicsAccumMs -= PHYSICS_STEP_MS;
          steps++;
        }
      } else {
        runSimTick();
      }
    } else if (phase === 'straighten') {
      updateStraighten();
    } else if (phase === 'roundReset') {
      updateRoundReset();
    } else if (phase === 'matchIntro') {
      updateMatchIntro();
    } else if (phase === 'mancheRollback') {
      updateMancheRollback();
    } else if (phase === 'handoffA' || phase === 'handoffB' || phase === 'handoffWatch') {
      updateHandoff();
    }
    if (isReplay) updateReplayBar();
    if (net) { maybeAutoSyncMute(); syncChatCompose(); }
    // Must run after the phase-updating block above, not before it: several
    // paths in there (runSimTick -> beginStraighten -> ... -> beginAimPhase,
    // updateRoundReset -> beginAimPhase, etc.) can flip `phase` into a fresh
    // aiming phase within this very frame. Resetting turnTimerStart here
    // (right before render(), using phase's final value for this frame)
    // means render() never sees a frame where phase is already the new aim
    // phase but turnTimerStart is still the previous team's — which used to
    // flash the previous timer's near-full ring for a frame before snapping
    // back to empty (see conversation).
    if (phase !== turnTimerPhase) {
      if (isAimingPhase(phase)) turnTimerStart = performance.now();
      turnTimerPhase = phase;
    }
    // Render interpolation: blend toward the leftover fractional tick instead
    // of showing the raw last-tick position — see snapshotPrevPositions
    // above. Only meaningful while physics is actually ticking (sim/goal);
    // every other phase already tweens its own x/y off real elapsed time
    // (updateStraighten/updateRoundReset), so alpha stays 1 (no-op) there.
    // Round 2 (see perf audit conversation): the first attempt only
    // interpolated x/y, leaving rotation to jump per-tick — smoothly-moving
    // position next to jerkily-spinning sprite read as more wrong than the
    // uniform jerkiness it was meant to fix. This one also blends rot (via
    // lerpAngle, so it takes the short way around 0/2π instead of spinning
    // the long way whenever it wraps).
    const RENDER_INTERPOLATION = true;
    const renderAlpha = (RENDER_INTERPOLATION && PHYSICS_FIXED_TIMESTEP && (phase === 'sim' || phase === 'goal'))
      ? Math.min(1, physicsAccumMs / PHYSICS_STEP_MS)
      : 1;
    if (renderAlpha < 1) {
      for (const e of allEntities()) {
        if (e.prevX === undefined) continue; // first tick ever for this entity — nothing to blend from yet
        e._trueX = e.x; e._trueY = e.y; e._trueRot = e.rot;
        e.x = e.prevX + (e.x - e.prevX) * renderAlpha;
        e.y = e.prevY + (e.y - e.prevY) * renderAlpha;
        e.rot = lerpAngle(e.prevRot, e.rot, renderAlpha);
      }
    }
    const idleThrottled = isAimingPhase(phase) && !drag && (now - lastRenderTime < IDLE_RENDER_INTERVAL_MS);
    // Pass & Play hand-off mask, fully shown: a static opaque overlay
    // waiting for a tap (see onPointerDown's handoff.stage==='shown'
    // branch) — everything underneath (full background blit, every entity,
    // every glow) was still being recomputed and repainted every frame for
    // something nobody can see, for however long it takes a human to pass
    // the device and tap. Skip render() entirely once frozen — using
    // wasHandoffShown (captured before updateHandoff() ran above) rather
    // than handoff.stage directly, so the frame that just finished fading
    // in still renders once (painting the fully opaque state) before any
    // freezing starts; only frames where it was ALREADY 'shown' get
    // skipped. The tap handler resets stageStart the instant it flips to
    // 'out', so the very next frame resumes rendering the fade-out normally.
    if (!idleThrottled && !wasHandoffShown) {
      lastRenderTime = now;
      render();
    }
    if (renderAlpha < 1) {
      for (const e of allEntities()) {
        if (e._trueX === undefined) continue;
        e.x = e._trueX; e.y = e._trueY; e.rot = e._trueRot;
      }
    }
    rafId = requestAnimationFrame(loop);
  }
  loop();

  // dev-only handle for physics-tuning scripts (position/phase readback)
  if (import.meta.env.DEV) window.__nb = { entities: () => entities, phase: () => phase, step: () => physicsStep(), render: () => render(), sweep: () => sweep, aimingTeam: () => aimingTeam(), controlsEnabled: () => controlsEnabled, runAimCascade: (team) => runAimCascade(team), handoff: () => handoff };

  // Handed back so a caller outside this closure (main.js's own "Quitter"/
  // logo-menu confirm dialogs) can tear this match down without a page
  // reload — see stopGame()'s own comment above for why that matters.
  return stopGame;
}
