// Ported from prototypes/nimball-merged.html — merges the illustrated arena
// background, translucent bubble-style avatars, and arcade physics/goal
// capture mechanics explored across the earlier prototypes.

// Prefixed with BASE_URL (not a bare leading slash) so these public/ assets
// still resolve when the app is served from a subpath, e.g. GitHub Pages at
// https://danyx11.github.io/NIM-Ball/.
import { createAudio } from './audio.js';
import { getIdenticonCanvas, getIdenticonPngDataUrl } from './identicons.js';
import { computeAiShots, DEFAULT_AI_CONFIG } from './ai.js';
import { isBasicLaser } from './settings.js';

const ASSET_BASE = import.meta.env.BASE_URL;
// Placeholder demo addresses (real per-player wallet addresses aren't wired
// up yet — see src/nimiq.js). Swap these once that flow exists; the identicon
// pipeline below doesn't care where the address string comes from.
const IDENTICON_ADDRESS = {
  A: 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG',
  B: 'NQ19 AXEU PPQ9 5610 YF48 VLTJ QR6Y 0HS1 UH89',
};
const MODULE_SRC = { A: `${ASSET_BASE}identicons/bubble-v4-navy.webp`, B: `${ASSET_BASE}identicons/bubble-v4-gold.webp` };
const ARENA_FRAME_SRC = `${ASSET_BASE}arena/frame.webp`;
const BALL_SRC = `${ASSET_BASE}ball/ball.png`;

export function startGame(opts = {}) {
  const { net = null, myTeam = null, aiTeam = null, aiConfig = {} } = opts;
  const AI_CONFIG = { ...DEFAULT_AI_CONFIG, ...aiConfig };
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
  const ctx = canvas.getContext('2d');
  // Logical coordinate system used throughout this file (physics bounds,
  // getPointerPos, all drawing) stays 1200x905 regardless of screen density —
  // matches index.html's <canvas width="1200" height="905">. Read as fixed
  // constants, not from canvas.width/height (which the dpr scaling below
  // mutates in place, so re-reading them would compound on every call).
  const W = 1200, H = 905;
  // The canvas's actual backing buffer is upsized to devicePixelRatio (capped
  // at 2 — Pixi/Phaser's standard tradeoff, since the per-frame shadow blur in
  // drawContactShadow scales with pixel count) and ctx.scale()'d once so every
  // existing drawImage/fillRect/arc call keeps working unmodified.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.3); // perf test: was 2, see perf audit
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  // ---------- Audio ----------
  // Decoding starts immediately (harmless before a user gesture); actual
  // playback stays silent until unlock() runs from a real pointer/click, per
  // browser autoplay rules. See src/audio.js for the clip list + folder.
  const audio = createAudio();
  audio.load();

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
  // Hex "floor" on the bubble art (bubble-v4-navy/gold.webp, 1024x1024) — unlike
  // the old module-ring art, this hex is a solid embossed shape baked into the
  // art itself (no punched-out alpha window), measured by scanning the source
  // PNG for where the color plateaus flat between the beveled walls (see
  // design-lab/main.js's HEX_MODULE, same measurement, ported 1:1).
  const HEX = { cxFrac: 0.502, cyFrac: 0.495, halfWFrac: 0.142, halfHFrac: 0.142 };
  function hexPath(hctx, cx, cy, halfW, halfH) {
    hctx.beginPath();
    hctx.moveTo(cx + halfW, cy);
    hctx.lineTo(cx + halfW * 0.5, cy - halfH);
    hctx.lineTo(cx - halfW * 0.5, cy - halfH);
    hctx.lineTo(cx - halfW, cy);
    hctx.lineTo(cx - halfW * 0.5, cy + halfH);
    hctx.lineTo(cx + halfW * 0.5, cy + halfH);
    hctx.closePath();
  }

  const identiconSources = {};
  const moduleImages = {};
  const bubbleSprites = {};
  const scoreBubbleSprites = {};
  // Bakes the bubble art + identicon into one sprite, at the given on-screen
  // diameter (2x-oversampled, same convention as ballSprite) — shared by the
  // in-pitch stone sprite and the small score-panel icon. Unlike the old
  // module-ring art, bubble-v4-navy/gold.webp's hex floor is solid (no punch-
  // out needed) — the identicon is drawn ON TOP, clipped to that hex, then a
  // cool-tint blend is applied so the glossy CG render sits inside the flatter,
  // desaturated ice scene instead of reading as a pasted-on sticker (ported
  // from design-lab/main.js's "intégration" slider, locked at 0.21 — see
  // design/design-lab-locked-state.md).
  const BUBBLE_BLEND = 0.21;
  function bakeBubble(mod, id, diameterPx) {
    const S = Math.round(diameterPx * 2);
    const cx = S * HEX.cxFrac, cy = S * HEX.cyFrac;
    const halfW = S * HEX.halfWFrac, halfH = S * HEX.halfHFrac;

    const sizedModule = downscaleToFit(mod, S, S);

    const fit = Math.max(halfW * 2, halfH * 2) * 1.05;
    const scale = fit / Math.max(id.width, id.height);
    const dw = Math.round(id.width * scale), dh = Math.round(id.height * scale);
    const sizedIdenticon = downscaleToFit(id, dw, dh);

    const bubble = document.createElement('canvas');
    bubble.width = S; bubble.height = S;
    const bctx = bubble.getContext('2d');
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(sizedModule, 0, 0);
    bctx.save();
    hexPath(bctx, cx, cy, halfW, halfH);
    bctx.clip();
    bctx.drawImage(sizedIdenticon, cx - dw / 2, cy - dh / 2);
    bctx.restore();

    const t = BUBBLE_BLEND;
    const tinted = document.createElement('canvas');
    tinted.width = S; tinted.height = S;
    const tctx = tinted.getContext('2d');
    tctx.filter = `saturate(${1 - 0.3 * t}) contrast(${1 - 0.12 * t}) brightness(${1 - 0.06 * t})`;
    tctx.drawImage(bubble, 0, 0);
    tctx.filter = 'none';
    tctx.globalCompositeOperation = 'soft-light';
    tctx.globalAlpha = t * 0.45;
    tctx.fillStyle = '#1e3a5f';
    tctx.fillRect(0, 0, S, S);
    // re-mask to the bubble's own silhouette — soft-light + globalAlpha would
    // otherwise tint the fully-transparent corners visible too (their alpha
    // goes from 0 to globalAlpha under normal source-over compositing).
    tctx.globalAlpha = 1;
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(bubble, 0, 0);
    return tinted;
  }
  function tryBakeBubble(team) {
    const mod = moduleImages[team], id = identiconSources[team];
    if (!mod || !id) return;
    bubbleSprites[team] = bakeBubble(mod, id, STONE_R * 2);
    scoreBubbleSprites[team] = bakeBubble(mod, id, SCORE_ICON_D);
  }
  for (const team of ['A', 'B']) {
    getIdenticonCanvas(IDENTICON_ADDRESS[team]).then((canvas) => {
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
      identiconSources[team] = source;
      tryBakeBubble(team);
    });

    const modImg = new Image();
    modImg.onload = () => { moduleImages[team] = modImg; tryBakeBubble(team); };
    modImg.src = MODULE_SRC[team];
  }

  const arenaFrameImage = new Image();
  arenaFrameImage.src = ARENA_FRAME_SRC;

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
  const FX0 = 159, FY0 = 206, FX1 = 1046, FY1 = 698;
  const GY0 = 368, GY1 = 536;                 // goal mouth y-range
  const CY = (FY0 + FY1) / 2;
  const CENTER_X = (FX0 + FX1) / 2;           // pitch's true horizontal center — ball spawn and score readout share this axis
  const GOAL_HALF_HEIGHT = (GY1 - GY0) / 2;
  const STONE_LOSS_FRACTION = 0.55;           // a stone is lost once this much of its circular area has crossed the goal's physical boundary (FX0/FX1)
  const BALL_GOAL_FRACTION = 0.6;             // the goal counts once this much of the ball's circular area has crossed the same boundary — not full clearance

  const SCALE = 1200 / 900;                   // physics scaled up vs the original 900-wide prototype
  const STONE_R = 38 * 0.9;                     // shrunk another 10% per feedback (was 38)
  const BALL_R = STONE_R / 2 * 0.9 * 0.9;       // half a stone's diameter, shrunk 10% twice more (~15.4), rendered as the puck sprite
  const STONE_MASS = 2.4;
  const BALL_MASS = 1.0;                        // was 0.55 (4.4:1) — narrowed ratio so stones bleed more speed on ball contact, feel test
  // Pace/bounce constants calibrated against frame-tracked Globulos footage
  // (foot 2 arena): launches glide about half the field width, impacts are
  // plain billiard exchanges with no added energy — puck/curling feel.
  const FRICTION = 0.9868;                     // was 0.9852 — +12% glide distance, feel test
  const BALL_FRICTION = 0.9809;                // was 0.9786 — +12% glide distance, feel test; puck still bleeds speed a bit faster than the players (also true in Globulos)
  const WALL_RESTITUTION = 0.87;               // was 0.85 — livelier wall bounce, feel test (0.90 tried, too much)
  const BODY_RESTITUTION = 1.0;
  const BOUNCE_BOOST = 1.0;                   // >1 re-adds the old arcade kick on impacts
  const MAX_DRAG = 130 * SCALE;                // ~173
  const POWER_SCALE = 0.054;
  const MAX_SPEED = 8;
  const STOP_THRESHOLD = 0.08;
  const WIN_SCORE = 3;
  // Stone "damage": each impact against an opposing-team stone counts one hit
  // toward STONE_MAX_HITS (8 — 2 hits per LED, see STONE_HITS_PER_LED below).
  // LEDs/ring quadrants go out one at a time, top first then clockwise (see
  // LED_RECTS order). On the last hit the stone dies (no longer selectable to
  // aim) and, once it finishes sliding from that final impact, plays the same
  // shrink-into-the-void animation as a goal loss (see the g.dead check in
  // physicsStep) — it keeps colliding/sliding normally right up until then.
  const STONE_MAX_HITS = 8;
  const STONE_HITS_PER_LED = 2; // hits needed to knock out each of the 4 LEDs/quadrants
  // debounce so a single prolonged/grazing contact (spanning several physics
  // frames) only ever counts as one hit — see registerStoneHit in resolveCollision
  const HIT_COOLDOWN_FRAMES = 20;
  const DEAD_SATURATION = 0.1;                 // 1 - 0.9: dead stones desaturate 90%

  const PW = FX1 - FX0, PH = FY1 - FY0;
  const startPositions = {
    A: [{ x: FX0 + 0.16 * PW, y: FY0 + 0.267 * PH }, { x: FX0 + 0.13 * PW, y: FY0 + 0.5 * PH }, { x: FX0 + 0.16 * PW, y: FY0 + 0.733 * PH }],
    B: [{ x: FX1 - 0.16 * PW, y: FY0 + 0.267 * PH }, { x: FX1 - 0.13 * PW, y: FY0 + 0.5 * PH }, { x: FX1 - 0.16 * PW, y: FY0 + 0.733 * PH }],
  };

  // "Balai" (curling-style sweep): one placeable-then-removable slippery ice
  // patch per team per round (see beginRoundReset for the `used` reset), a
  // circle (not the originally-floated hexagon — simpler math, no rotation/
  // in-polygon test). Purely cosmetic/tunable numbers, adjust freely by feel —
  // was a pitch-relative formula (fifth, then two-fifths of the shorter pitch
  // dimension), now a flat px value per feedback.
  const SWEEP_R = 130;
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
  // Clipped to the ice rect so a patch placed near an edge has its overflow
  // cropped away instead of spilling onto the wood frame art — cosmetic only,
  // physics itself never needs cropping (the in-circle test in
  // physicsStep/stepGhostBodies already only ever looks at whichever part of
  // the pitch entities can actually occupy).
  function drawSweepZone(sw) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(FX0, FY0, FX1 - FX0, FY1 - FY0);
    ctx.clip();
    ctx.globalCompositeOperation = 'soft-light';
    const d = sw.r * 2;
    ctx.drawImage(sweepSprite, sw.x - sw.r, sw.y - sw.r, d, d);
    ctx.restore();
  }
  // Own patch while still being placed/dragged (pre-commit) is visible only
  // on the owning team's own screen (sweepViewTeam) — same phases the aim
  // laser itself stays visible through, so it vanishes at the same moment.
  // Once committed, both patches are drawn during 'sim'/'goal' regardless of
  // sweepViewTeam: the shared "reveal" moment both players see together.
  function drawSweepOverlay() {
    const ownTeam = sweepViewTeam();
    if (ownTeam && sweep[ownTeam].active && !sweep[ownTeam].committed) drawSweepZone(sweep[ownTeam]);
    if (phase === 'sim' || phase === 'goal') {
      if (sweep.A.committed) drawSweepZone(sweep.A);
      if (sweep.B.committed) drawSweepZone(sweep.B);
    }
  }

  let scoreA = 0, scoreB = 0;
  let round = 1;
  let phase = 'start';
  // Visual-only 30s turn timer for the score panel LED bar — resets whenever aiming
  // starts for either team, has no effect on the phase state machine (see turnTimerProgress).
  const TURN_TIMER_MS = 30000;
  let turnTimerStart = 0;
  let turnTimerPhase = null;
  let entities = { A: [], B: [], ball: null };
  let drag = null;
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
  let sweep = {
    A: { active: false, committed: false, used: false, x: CENTER_X, y: CY, r: SWEEP_R },
    B: { active: false, committed: false, used: false, x: CENTER_X, y: CY, r: SWEEP_R },
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
  function beginAimPhase() {
    // Retire whichever patch(es) were committed into the sim that just
    // finished — the effect and its shared reveal were only ever meant for
    // that one exchange (see the comment on the `sweep` state above); `used`
    // is untouched here, it only clears on a real round reset.
    sweep.A.active = false; sweep.A.committed = false;
    sweep.B.active = false; sweep.B.committed = false;
    phase = firstAimPhase();
    if (aiTeam) prepareAiShots();
  }
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
    entities.A = startPositions.A.map((p, i) => makeStone('A', i, p));
    entities.B = startPositions.B.map((p, i) => makeStone('B', i, p));
    entities.ball = {
      x: CENTER_X, y: CY, vx: 0, vy: 0, r: BALL_R, mass: BALL_MASS, rot: 0,
      falling: false, fallScale: 1, out: false,
    };
  }
  resetPositions();
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
    const scaleX = W / rect.width, scaleY = H / rect.height;
    const t = evt.touches ? (evt.touches[0] || evt.changedTouches[0]) : evt;
    return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
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
  function onPointerDown(evt) {
    audio.unlock();
    const pos = getPointerPos(evt);
    if (!isAimingPhase(phase)) return;
    evt.preventDefault();
    const g = findStoneAt(pos);
    if (g) {
      g.pendingVx = 0; g.pendingVy = 0;
      // halo/LED "programmed" state (haloMode) starts the instant a stone is
      // picked up, not only once released — onPointerUp still reverts this to
      // false if the drag turns out too short to count as an actual shot.
      g.used = true;
      drag = { entity: g, startX: g.x, startY: g.y, curX: pos.x, curY: pos.y };
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
    if (drag) {
      evt.preventDefault();
      const pos = getPointerPos(evt);
      drag.curX = pos.x; drag.curY = pos.y;
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
    if (!drag) return;
    evt.preventDefault();
    let dx = drag.startX - drag.curX;
    let dy = drag.startY - drag.curY;
    let dist = Math.hypot(dx, dy);
    if (dist > MAX_DRAG) { const s = MAX_DRAG / dist; dx *= s; dy *= s; dist = MAX_DRAG; }
    const g = drag.entity;
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
  canvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp, { passive: false });

  // ---------- UI ----------
  const overlay = document.getElementById('overlay');
  const ovContent = document.getElementById('ovContent');
  const startOverlay = document.getElementById('startOverlay');
  const halfA = document.getElementById('halfA');
  const halfB = document.getElementById('halfB');
  const checkA = document.getElementById('checkA');
  const checkB = document.getElementById('checkB');

  let controlsEnabled = false;

  halfA.addEventListener('click', () => { audio.unlock(); readyA = true; halfA.classList.add('ready'); checkA.textContent = '✓'; maybeStart(); });
  halfB.addEventListener('click', () => { audio.unlock(); readyB = true; halfB.classList.add('ready'); checkB.textContent = '✓'; maybeStart(); });
  function maybeStart() {
    if (readyA && readyB) {
      startOverlay.classList.add('hidden');
      controlsEnabled = true;
      beginAimPhase();
      // ambience disabled for now — audio.playAmbience() to re-enable
    }
  }

  function showOverlay(html) { overlay.classList.remove('hidden'); ovContent.innerHTML = html; }
  function hideOverlay() { overlay.classList.add('hidden'); }
  // J1->J2: no "pass the device" screen, straight into the other team's aim phase.
  // J2->sim: a fixed 2s beat after the PLAY press before the shots actually launch.
  const PRE_SIM_DELAY = 1000;
  // Locks in whichever patch a team had placed for the sim about to run —
  // `committed` is what physicsStep/the reveal actually key off; `used` is
  // the round-scoped "spent" flag the toolbar button crosses out.
  function commitSweep(team) {
    const sw = sweep[team];
    if (sw.active) { sw.used = true; sw.committed = true; }
  }
  function onValidate() {
    if (net) {
      if (phase !== 'lanAim') return;
      const stones = entities[myTeam].map(g => ({ vx: g.pendingVx || 0, vy: g.pendingVy || 0, used: g.used }));
      commitSweep(myTeam);
      const sw = sweep[myTeam];
      net.sendShots(stones, sw.active ? { x: sw.x, y: sw.y, r: sw.r } : null);
      phase = 'lanWait';
      // No full-screen overlay here on purpose — the arena stays visible while
      // waiting; see drawWaitingLabel() for the small pulsing score-panel message.
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
      // Extra "thinking" pause on top of the usual pre-launch beat — purely a
      // feel beat (see reactionDelay in ai.js), not real computation time.
      const think = AI_CONFIG.reactionDelay[0] + Math.random() * (AI_CONFIG.reactionDelay[1] - AI_CONFIG.reactionDelay[0]);
      setTimeout(launchSimulation, PRE_SIM_DELAY + think);
      return;
    }
    if (phase === 'aimA') { commitSweep('A'); phase = 'aimB'; }
    else if (phase === 'aimB') { commitSweep('B'); phase = 'pending'; setTimeout(launchSimulation, PRE_SIM_DELAY); }
  }
  function launchSimulation() {
    entities.A.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; });
    entities.B.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; });
    phase = 'sim';
  }

  // Lobby (index.html) already confirms both players are connected before
  // calling startGame — no in-canvas ready-tap step needed for LAN mode.
  if (net) {
    startOverlay.classList.add('hidden');
    controlsEnabled = true;
    phase = 'lanAim';
    net.onLaunch(({ shotsA, shotsB, sweepA, sweepB }) => {
      hideOverlay();
      phase = 'pending';
      // Own patch is already active/committed locally from commitSweep() at
      // send time — this overwrites both sides fully from what the arbiter
      // actually relayed (same pattern as the `used` flag below) so both
      // clients' physics/reveal are byte-identical regardless of any local
      // state quirk, rather than trusting the local copy for our own team.
      sweep.A.active = !!sweepA; sweep.A.committed = !!sweepA;
      if (sweepA) { sweep.A.x = sweepA.x; sweep.A.y = sweepA.y; sweep.A.r = sweepA.r; sweep.A.used = true; }
      sweep.B.active = !!sweepB; sweep.B.committed = !!sweepB;
      if (sweepB) { sweep.B.x = sweepB.x; sweep.B.y = sweepB.y; sweep.B.r = sweepB.r; sweep.B.used = true; }
      setTimeout(() => {
        // used flag comes from the network too, not just local drags — on this
        // client the opponent's own stones were never dragged locally, so their
        // g.used would otherwise stay permanently false and their halo would
        // never show 'on' during the reveal (see haloMode above).
        entities.A.forEach((g, i) => { g.vx = shotsA[i]?.vx || 0; g.vy = shotsA[i]?.vy || 0; g.used = !!shotsA[i]?.used; });
        entities.B.forEach((g, i) => { g.vx = shotsB[i]?.vx || 0; g.vy = shotsB[i]?.vy || 0; g.used = !!shotsB[i]?.used; });
        phase = 'sim';
      }, PRE_SIM_DELAY);
    });
    net.onDisconnect(() => {
      showOverlay(`<h2>Connexion perdue</h2><p>L'autre joueur s'est déconnecté.</p>`);
    });
  } else if (aiTeam) {
    // Solo vs IA: no lobby/ready-tap step needed (only one human) — straight
    // into the human's aim phase, same as LAN skips the local ready screen.
    startOverlay.classList.add('hidden');
    controlsEnabled = true;
    beginAimPhase();
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
      e.rotVel -= vt * 0.05; // was 0.04 (0.063 before the sign fix) — spin-up on contact felt too strong
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
  // don't sound the same; MAX_SPEED is the natural upper bound for spd/impact
  const MIN_AUDIBLE_IMPACT = 0.06; // below this, jitter during settling would spam near-silent plays
  function playWallHit(spd) {
    if (spd < MIN_AUDIBLE_IMPACT) return;
    audio.play('hitWall', { volume: Math.min(1, spd / MAX_SPEED) * 0.8, rate: 0.95 + Math.random() * 0.1 });
  }
  function playBodyHit(impact) {
    if (impact < MIN_AUDIBLE_IMPACT) return;
    audio.play('hitStone', { volume: Math.min(1, impact / MAX_SPEED), rate: 0.95 + Math.random() * 0.1 });
  }
  // Fraction of a circle's area lying past a straight boundary, given how far the
  // circle's center has crossed that boundary (depth, signed: negative = hasn't
  // reached it yet). Exact circular-segment formula, not a center-crossing guess —
  // STONE_LOSS_FRACTION needs to trip at a specific fraction past the halfway point.
  function circleFractionPast(depth, r) {
    const u = Math.max(-1, Math.min(1, depth / r));
    return 0.5 + (u * Math.sqrt(1 - u * u) + Math.asin(u)) / Math.PI;
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
  function collideGoalSide(e, wallX) {
    let closestY;
    if (e.y <= GY0) closestY = e.y;
    else if (e.y >= GY1) closestY = e.y;
    else closestY = (e.y - GY0 <= GY1 - e.y) ? GY0 : GY1;
    const dx = e.x - wallX, dy = e.y - closestY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0 || dist >= e.r) return false;
    const nx = dx / dist, ny = dy / dist;
    const vDotN = e.vx * nx + e.vy * ny;
    const spd = Math.abs(vDotN);
    const overlap = e.r - dist;
    e.x += nx * overlap; e.y += ny * overlap;
    e.vx -= (1 + WALL_RESTITUTION) * vDotN * nx;
    e.vy -= (1 + WALL_RESTITUTION) * vDotN * ny;
    triggerSquish(e, nx, ny, spd);
    playWallHit(spd);
    return true;
  }
  // Less per-tick speed loss inside a currently-committed sweep patch (see
  // the `sweep` state comment) — scales the friction DEFICIT rather than fr
  // itself, since fr sits so close to 1 already that scaling it directly
  // would barely move the needle; this compounds into a clearly longer glide
  // over the many ticks of an actual shot.
  function withSweepBoost(fr) { return 1 - (1 - fr) * (1 - SWEEP_FRICTION_BONUS); }
  function physicsStep() {
    const list = allEntities();
    const boostZones = [sweep.A, sweep.B].filter(s => s.committed);
    let goalResult = null;
    for (const e of list) {
      if (e.falling) {
        // shrinking-into-the-void animation; frozen otherwise, no normal physics while it plays
        e.fallScale -= 0.045;
        if (e.fallScale <= 0) { e.fallScale = 0; e.falling = false; e.out = true; }
        continue;
      }
      e.x += e.vx; e.y += e.vy;
      let fr = e === entities.ball ? BALL_FRICTION : FRICTION;
      if (boostZones.some(z => Math.hypot(e.x - z.x, e.y - z.y) <= z.r)) fr = withSweepBoost(fr);
      e.vx *= fr; e.vy *= fr;
      const spd0 = Math.hypot(e.vx, e.vy);
      if (spd0 < STOP_THRESHOLD) { e.vx = 0; e.vy = 0; }
      else if (spd0 > MAX_SPEED) { const s = MAX_SPEED / spd0; e.vx *= s; e.vy *= s; }
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
      if (e.y - e.r < FY0) { const spd = Math.abs(e.vy); e.y = FY0 + e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, -1, spd); playWallHit(spd); }
      if (e.y + e.r > FY1) { const spd = Math.abs(e.vy); e.y = FY1 - e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, 1, spd); playWallHit(spd); }
      // See collideGoalSide above: posts are the corners of the two wall
      // segments flanking the open mouth, so a stone grazing one bounces off
      // the post tip cleanly instead of the mouth/wall branches fighting over
      // it frame to frame.
      let blockedByPost = false;
      if (e.x - e.r < FX0) blockedByPost = collideGoalSide(e, FX0) || blockedByPost;
      if (e.x + e.r > FX1) blockedByPost = collideGoalSide(e, FX1) || blockedByPost;
      if (!blockedByPost && Math.abs(e.y - CY) < GOAL_HALF_HEIGHT) {
        // in the goal mouth and clear of both posts: lost once enough of the circle
        // has crossed the goal's physical boundary (FX0/FX1) instead of bouncing off
        // the net. A stone just shrinks away until next round; the ball crossing its
        // own (lower) BALL_GOAL_FRACTION threshold is what actually counts the goal —
        // and gets the identical shrink-away treatment instead of vanishing outright.
        const depthPast = Math.max(FX0 - e.x, e.x - FX1);
        const lossFraction = e === entities.ball ? BALL_GOAL_FRACTION : STONE_LOSS_FRACTION;
        if (circleFractionPast(depthPast, e.r) >= lossFraction) {
          e.falling = true; e.fallScale = 1; e.vx = 0; e.vy = 0;
          if (e === entities.ball) goalResult = (FX0 - e.x > e.x - FX1) ? 'goalB' : 'goalA';
        }
      }
      // a knocked-dead stone (STONE_MAX_HITS, see registerStoneHit) plays the
      // same shrink-into-the-void animation as a goal loss, but wherever it
      // happens to finish its post-death slide instead of only at the goal
      // mouth — triggered once its velocity has actually settled to 0 (set
      // above once its speed drops under STOP_THRESHOLD), not the instant it
      // dies, so it keeps sliding/colliding like a normal stone until then.
      if (e.dead && e.vx === 0 && e.vy === 0) {
        e.falling = true; e.fallScale = 1;
      }
    }
    const activeList = list.filter(e => !e.out && !e.falling);
    for (let i = 0; i < activeList.length; i++) for (let j = i + 1; j < activeList.length; j++) resolveCollision(activeList[i], activeList[j]);
    if (goalResult) return goalResult;
    // if every one of a team's stones is out of play — fallen into the goal or
    // knocked dead (STONE_MAX_HITS) — the other team scores the point, same as
    // a real goal
    if (entities.A.every(g => g.out || g.dead)) return 'wipeoutB';
    if (entities.B.every(g => g.out || g.dead)) return 'wipeoutA';
    return null;
  }
  function resolveCollision(a, b2) {
    const dx = b2.x - a.x, dy = b2.y - a.y;
    const dist = Math.hypot(dx, dy);
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
        const cdist = Math.hypot(cdx, cdy);
        if (cdist > 1e-6) { nx = cdx / cdist; ny = cdy / cdist; }
      }
    }
    const overlap = (minDist - dist) / 2;
    a.x -= nx * overlap; a.y -= ny * overlap;
    b2.x += nx * overlap; b2.y += ny * overlap;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return;
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
    playBodyHit(impact);
    // stone-vs-opposing-stone impact: each side takes one hit (see STONE_MAX_HITS)
    if (a.team && b2.team && a.team !== b2.team) {
      registerStoneHit(a);
      registerStoneHit(b2);
    }
  }
  // Knocks out the next LED (top first, then clockwise — see LED_RECTS) and
  // kills the stone on the 4th hit. Cooldown-gated so one prolonged/grazing
  // contact spanning several physics frames only ever counts as a single hit.
  function registerStoneHit(g) {
    if (g.dead || g._hitCooldown > 0) return;
    g._hitCooldown = HIT_COOLDOWN_FRAMES;
    g.hits = Math.min(STONE_MAX_HITS, g.hits + 1);
    if (g.hits >= STONE_MAX_HITS) { g.dead = true; g.deadMix = 1; }
  }
  function allSettled() { return allEntities().every(e => e.vx === 0 && e.vy === 0 && !e.falling); }

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
    if (!STRAIGHTEN_ENABLED) { beginAimPhase(); return; }
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
    if (!anyWork) { beginAimPhase(); return; }
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
      beginAimPhase();
    }
  }

  // ---------- Round / goal flow ----------
  // Held after a goal before the board resets, so the ball's still visible
  // sitting in the net (and the goal/wipeout SFX has room to finish) instead
  // of the stones immediately snapping into their slide-back animation.
  const GOAL_PAUSE_MS = 3000;
  function onGoal(scoringTeam, isWipeout) {
    audio.play(isWipeout ? 'wipeout' : 'goal');
    // Same GOAL_PAUSE_MS pause whether the round continues or the match just
    // ended — even a winning goal/wipeout is instantly resolved as a state
    // flip, but the shot's impact is still playing out (ball still sliding
    // into the net, other stones bouncing/squishing) and phase stays 'goal'
    // through this wait so physicsStep keeps running (see loop()) and lets
    // that finish before we cut to either the next round or the result panel.
    // The score itself is bumped only once that wait is over too — scoreA/B
    // feed the scoreboard digits every frame regardless of phase, so
    // incrementing them here immediately would flash the new score on the
    // board a full GOAL_PAUSE_MS before the result panel shows it.
    setTimeout(() => {
      if (scoringTeam === 'A') scoreA++; else scoreB++;
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
    }, GOAL_PAUSE_MS);
  }

  // ---------- Result panel (goal / match win) ----------
  // Same shared #overlay component as the exit-confirm dialog and every other
  // dialog in this file — a big identicon (raw, not the on-board hex bubble,
  // so it reads clearly at this size) with the team's address underneath, a
  // colored badge next to it ("+1" mid-match, "GAGNÉ"/"PERDU" on the deciding
  // goal), and the updated score in each team's own color below that.
  const RESULT_IDENTICON_SIZE = 512; // shares getIdenticonCanvas's per-address cache with the bubble-baking pipeline
  function resultPanelHtml(team, badgeCls, badgeLabel, extraHtml) {
    return `
      <div class="goal-identicon-wrap">
        <img class="goal-identicon" id="goalIdenticonImg" alt="">
        <span class="goal-badge ${badgeCls}">${badgeLabel}</span>
      </div>
      <div class="goal-address">${IDENTICON_ADDRESS[team]}</div>
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
    if (roundResetAnimDone && goalPanelDismissed) beginAimPhase();
  }
  function showGoalPanel(scoringTeam) {
    const cls = scoringTeam === 'A' ? 'a' : 'b';
    showOverlay(resultPanelHtml(scoringTeam, cls, '+1'));
    fillResultIdenticon(scoringTeam);
    // Click-anywhere dismiss (no buttons here) — closing early doesn't rush
    // beginAimPhase(): maybeAdvanceRound() still waits on the slide animation
    // if that hasn't finished yet.
    overlay.addEventListener('click', () => {
      hideOverlay();
      goalPanelDismissed = true;
      maybeAdvanceRound();
    }, { once: true });
  }
  function showVictory() {
    phase = 'gameover';
    audio.play('win');
    const winningTeam = scoreA >= WIN_SCORE ? 'A' : 'B';
    // LAN: each client only ever sees its own result (gagné/perdu), never both
    // sides at once. Local pass-and-play has no "own team" to speak of (both
    // players share the screen) — kept dev-only, see CLAUDE.md — so it just
    // always features the winner, same as before this panel existed.
    const featuredTeam = net ? myTeam : winningTeam;
    const featuredWon = featuredTeam === winningTeam;
    const cls = featuredTeam === 'A' ? 'a' : 'b';
    const label = featuredWon ? 'GAGNÉ' : 'PERDU';
    showOverlay(resultPanelHtml(featuredTeam, cls, label, `
      <div class="goal-actions">
        <button class="bigbtn" id="goalReplayBtn">Rejouer</button>
        <button class="bigbtn" id="goalShareBtn">Partager</button>
        <button class="bigbtn" id="goalMenuBtn">Menu</button>
      </div>
    `));
    fillResultIdenticon(featuredTeam);
    document.getElementById('goalReplayBtn').onclick = () => {
      scoreA = 0; scoreB = 0; round = 1;
      sweep.A.used = false; sweep.B.used = false;
      resetPositions(); beginAimPhase(); hideOverlay();
    };
    document.getElementById('goalMenuBtn').onclick = () => location.reload();
    document.getElementById('goalShareBtn').onclick = async () => {
      // Content/mechanism kept intentionally simple for now (native share
      // sheet, clipboard fallback) — to be reworked once there's more to
      // share than just the final score.
      const resultText = `J'ai ${featuredWon ? 'gagné' : 'perdu'} sur Nim-Curl ! Score final : ${scoreA}–${scoreB}`;
      const shareBtn = document.getElementById('goalShareBtn');
      if (navigator.share) {
        try { await navigator.share({ title: 'Nim-Curl', text: resultText, url: location.href }); }
        catch { /* user cancelled the native share sheet — nothing to do */ }
      } else if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(`${resultText} ${location.href}`);
          const original = shareBtn.textContent;
          shareBtn.textContent = 'Copié !';
          setTimeout(() => { shareBtn.textContent = original; }, 1500);
        } catch { /* e.g. document lost focus right as this fired — nothing to do */ }
      }
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
    // A real round boundary (goal/wipeout) — each team's single sweep
    // placement for the round to come is available again.
    sweep.A.used = false; sweep.B.used = false;
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
    setTimeout(() => { if (phase === 'roundReset') updateRoundReset(); }, ROUND_RESET_MOVE_MS + 150);
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

  // ---------- Render: arena background is the user's original artwork, used as-is ----------
  // The physics bounds (FX0..FY1, GY0/GY1) are invisible constraints only — the center
  // line/hexagon/goal circles are baked into the art itself, re-centered on CENTER_X/CY
  // at the image level (see the comment on FX0 above) so no runtime drawing is needed.
  function drawBackground() {
    ctx.clearRect(0, 0, W, H);

    if (arenaFrameImage.complete) {
      ctx.drawImage(arenaFrameImage, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#142451'; ctx.fillRect(0, 0, W, H);
    }

    drawScorePanel();
  }

  // Score lives on the wood scoreboard plaque baked into arena/frame.webp (see
  // scripts/bake_arena.py — plaque rect: x:[416,789], y:[73,194], center
  // (602.5,133), same CENTER_X the pitch itself uses). Unlike the old V1
  // panel art, this plaque ships blank (no baked dash) — digits, dash, team
  // icons and the turn-timer bar are all drawn fresh into that empty rect.
  const SCORE_SLOT_CY = 133;
  const SCORE_DIGIT_CX_A = CENTER_X - 70, SCORE_DIGIT_CX_B = CENTER_X + 70;
  const SCORE_ICON_D = 46;
  const SCORE_ICON_CX_A = CENTER_X - 150, SCORE_ICON_CX_B = CENTER_X + 150;
  // Font per Nimiq's brand guidelines (nimiq-style design system): Mulish, self-hosted
  // via @fontsource/mulish (imported in main.js) rather than the never-actually-loaded
  // 'Baloo 2' this used to reference (it was silently falling back to Arial).
  const SCORE_FONT = `800 60px 'Mulish', Arial, sans-serif`;
  function drawScorePanel() {
    ctx.save();
    ctx.font = SCORE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(90,70,45,0.85)';
    ctx.fillText('-', CENTER_X, SCORE_SLOT_CY);
    ctx.fillStyle = '#5ecbf5';
    ctx.fillText(String(scoreA), SCORE_DIGIT_CX_A, SCORE_SLOT_CY);
    ctx.fillStyle = '#ffc94d';
    ctx.fillText(String(scoreB), SCORE_DIGIT_CX_B, SCORE_SLOT_CY);
    ctx.restore();

    if (phase === 'lanWait') drawWaitingLabel();

    drawScoreIcon('A', SCORE_ICON_CX_A);
    drawScoreIcon('B', SCORE_ICON_CX_B);
    drawTurnTimerBar();
  }

  // LAN mode, local shot already sent: used to be a full-screen overlay blocking
  // the arena while waiting on the opponent's shot — now a small pulsing label
  // tucked under the score digits so the board stays visible.
  const WAITING_LABEL_FONT = `700 15px 'Mulish', Arial, sans-serif`;
  function drawWaitingLabel() {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 2.4);
    ctx.save();
    ctx.font = WAITING_LABEL_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(255,255,255,${(0.55 + 0.35 * pulse).toFixed(3)})`;
    ctx.fillText('en attente…', CENTER_X, SCORE_SLOT_CY + 40);
    ctx.restore();
  }

  function drawScoreIcon(team, cx) {
    const sprite = scoreBubbleSprites[team];
    if (!sprite) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite, cx - SCORE_ICON_D / 2, SCORE_SLOT_CY - SCORE_ICON_D / 2, SCORE_ICON_D, SCORE_ICON_D);
    ctx.restore();
  }

  // 0..1 while a team is actively aiming, null the rest of the time (hides the bar).
  // lanWait keeps it showing too: the local shot is in but the round timer (and
  // the laser tracking it) keeps running for the still-aiming opponent.
  function turnTimerProgress() {
    if (!isAimingPhase(phase) && phase !== 'lanWait') return null;
    return Math.min(1, (performance.now() - turnTimerStart) / TURN_TIMER_MS);
  }

  // Thin LED/laser strip along the top of the score screen: fills left-to-right over 30s,
  // tinted to whichever team is currently aiming (same palette as their aim halo/digits).
  const TIMER_BAR_X0 = CENTER_X - 150, TIMER_BAR_X1 = CENTER_X + 150, TIMER_BAR_Y = 96, TIMER_BAR_H = 3;
  function drawTurnTimerBar() {
    const t = turnTimerProgress();
    if (t === null) return;
    const rgb = HALO_RGB[net ? myTeam : (phase === 'aimB' ? 'B' : 'A')];
    const barW = TIMER_BAR_X1 - TIMER_BAR_X0;
    const filled = barW * t;

    ctx.save();
    // dim track
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(TIMER_BAR_X0, TIMER_BAR_Y, barW, TIMER_BAR_H);

    if (filled > 0.5) {
      // glowing filled portion, like a laser/LED strip charging up
      ctx.shadowColor = `rgba(${rgb},0.9)`;
      ctx.shadowBlur = 6;
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fillRect(TIMER_BAR_X0, TIMER_BAR_Y, filled, TIMER_BAR_H);

      // bright leading edge, like a scanning laser head
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(TIMER_BAR_X0 + filled - 1.5, TIMER_BAR_Y - 0.5, 3, TIMER_BAR_H + 1);
    }
    ctx.restore();
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
  playBtn.addEventListener('click', () => {
    if (!isPlayButtonActive()) return;
    playBtnCap.classList.remove('pressed');
    void playBtnCap.offsetWidth; // restart the animation if pressed again mid-tween
    playBtnCap.classList.add('pressed');
    audio.play('button');
    onValidate();
  });

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
  sweepBtn.addEventListener('click', () => {
    const team = aimingTeam();
    if (!controlsEnabled || !team || sweep[team].used) return;
    const sw = sweep[team];
    sw.active = !sw.active;
    if (sw.active) { sw.x = CENTER_X; sw.y = CY; }
    sweepBtnCap.classList.remove('pressed');
    void sweepBtnCap.offsetWidth; // restart the animation if pressed again mid-tween
    sweepBtnCap.classList.add('pressed');
    audio.play('button');
  });
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
  function bakeContactShadowSprite(r, boost) {
    // blur scales with the entity's own radius rather than a fixed pixel amount —
    // a flat 3px blur reads as a subtle soft edge on a 38px stone, but on the much
    // smaller 17px ball it was smearing away most of the shadow's density
    const blur = Math.max(1.2, r * 0.08);
    const rx = r * boost * SHADOW_SIZE_SCALE, ry = r * 0.92 * boost * SHADOW_SIZE_SCALE;
    const pad = blur * 3; // generous margin so the blurred edge never gets cropped
    const w = Math.ceil((rx + pad) * 2), h = Math.ceil((ry + pad) * 2);
    const sprite = document.createElement('canvas');
    sprite.width = w; sprite.height = h;
    const sctx = sprite.getContext('2d');
    sctx.fillStyle = `rgba(0,0,0,${Math.min(0.85, 0.6 * boost)})`;
    sctx.filter = `blur(${blur}px)`;
    sctx.beginPath();
    sctx.ellipse(w / 2, h / 2, rx, ry, 0, 0, Math.PI * 2);
    sctx.fill();
    return sprite;
  }
  const stoneShadowSprite = bakeContactShadowSprite(STONE_R, 1);
  const ballShadowSprite = bakeContactShadowSprite(BALL_R, 1.05);
  function drawContactShadow(g, sprite, boost = 1) {
    const cx = g.x + g.r * 0.1 * boost, cy = g.y + g.r * 0.16 * boost;
    // clip to the ice rect so the shadow tucks under the wood frame at wall
    // contact instead of spilling over it — same trick as drawAimHalo below
    // (the frame is baked into the background image and drawn first, so
    // anything drawn after it, including this shadow, normally sits on top).
    ctx.save();
    ctx.beginPath(); ctx.rect(FX0, FY0, FX1 - FX0, FY1 - FY0); ctx.clip();
    // pivoted on the shadow's OWN (light-offset) center rather than the stone's
    // physics center, so the retraction is symmetric on the shadow's own shape
    // instead of lopsided. The sprite is drawn on top and occludes most of the
    // shadow near the stone's center, so this only becomes visible on whichever
    // side the shadow actually pokes out past the stone — matching the bubble's
    // own compression there — and stays invisible on the opposite side.
    const shadowEntity = { x: cx, y: cy, r: g.r, squish: g.squish || 0, squishNX: g.squishNX, squishNY: g.squishNY };
    drawSquished(shadowEntity, () => {
      ctx.drawImage(sprite, cx - sprite.width / 2, cy - sprite.height / 2);
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
    if (g.falling || g.out || !g.used) return 'off';
    if (phase === 'pending' || phase === 'sim') return 'on';
    if (isAimingPhase(phase) || phase === 'lanWait') return 'pulse';
    return 'off';
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
    // keep their own full 0..1 breathing)
    const strength = mode === 'pulse' ? 0.2 + 0.6 * pulseStrength(g) : 1;
    ctx.save();
    // clip to the ice rect so the halo tucks under the wood frame at wall
    // contact instead of glowing over it (frame is baked into the background
    // image and drawn first, so anything drawn after it normally sits on top)
    ctx.beginPath(); ctx.rect(FX0, FY0, FX1 - FX0, FY1 - FY0); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(g.x, g.y, g.r * 0.4, g.x, g.y, R);
    grad.addColorStop(0, `rgba(${rgb},${(0.55 * strength).toFixed(3)})`);
    grad.addColorStop(0.6, `rgba(${rgb},${(0.24 * strength).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.beginPath(); ctx.arc(g.x, g.y, R, 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
  }
  function isAimingTeamStone(g) {
    if (net) return phase === 'lanAim' && g.team === myTeam && !g.falling;
    return ((phase === 'aimA' && g.team === 'A') || (phase === 'aimB' && g.team === 'B')) && !g.falling;
  }
  // The 4 LED strips baked into bubble-v4-navy/gold.webp's white tabs, in
  // clockwise order starting at the top (N/E/S/W) — measured off the source
  // art the same way as HEX above, as fractions of the module's own square
  // canvas so they scale with whatever size the bubble is baked at. The art
  // bakes them permanently lit; drawStoneLeds below dims each one to an "off"
  // gray individually. Index i is knocked out for good once g.hits reaches
  // (i+1) * STONE_HITS_PER_LED, so the top strip is the first to go dark
  // (after 2 hits), then clockwise — see registerStoneHit/STONE_MAX_HITS.
  // Still-alive LEDs breathe
  // (smooth pulse, not a hard on/off blink — reads as "alive" rather than
  // flickering/broken) so the damage state is still visible at a glance.
  // Fully independent of the halo above (own state, not tied to
  // haloMode/pulseStrength).
  const LED_RECTS = [
    { cxFrac: 0.4985, cyFrac: 0.0962, halfWFrac: 0.010, halfHFrac: 0.0347 }, // top
    { cxFrac: 0.8813, cyFrac: 0.4917, halfWFrac: 0.0337, halfHFrac: 0.010 }, // right
    { cxFrac: 0.4985, cyFrac: 0.8838, halfWFrac: 0.010, halfHFrac: 0.0352 }, // bottom
    { cxFrac: 0.1147, cyFrac: 0.4917, halfWFrac: 0.0337, halfHFrac: 0.010 }, // left
  ];
  const LED_LIT_RGB = { A: '110,210,255', B: '255,205,90' };
  const LED_OFF_GRAY = '#7d8489';
  // The white/gray bezel ring itself, split into 4 quarters centered on each
  // LED (same order/index as LED_RECTS: top, right, bottom, left, each
  // spanning ±45° around its LED) — a much bigger "remaining life" indicator
  // than the tiny LED strips alone. Inner/outer radius measured off the same
  // source art as a fraction of the module's own diameter (same convention as
  // the LED_RECTS fractions above — frac * d, not frac * radius). The ring is
  // neutral gray/white in the baked art already, so a knocked-out quarter
  // needs no extra "off" treatment — only the still-alive quarters get tinted.
  const RING_INNER_FRAC = 0.365;
  const RING_OUTER_FRAC = 0.445;
  const RING_QUADRANT_ANGLES = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // top, right, bottom, left
  const RING_QUADRANT_HALF_SPAN = Math.PI / 4;
  const LED_PULSE_PERIOD_MS = 1400;  // full breathe cycle, shared clock so a stone's live LEDs pulse in sync
  const LED_PULSE_FLOOR = 0.35;      // never dims all the way to "off" gray, unlike a knocked-out LED
  function ledPulseStrength() {
    const cycle = (performance.now() % LED_PULSE_PERIOD_MS) / LED_PULSE_PERIOD_MS; // 0..1
    const wave = (1 - Math.cos(cycle * Math.PI * 2)) / 2; // smooth 0 -> 1 -> 0
    return LED_PULSE_FLOOR + (1 - LED_PULSE_FLOOR) * wave;
  }
  // how many of the 4 LEDs/quadrants (0..4) are knocked out so far — each
  // takes STONE_HITS_PER_LED hits, top first then clockwise.
  function stoneLedsOut(g) { return Math.floor(g.hits / STONE_HITS_PER_LED); }
  // called from inside the same translate/rotate transform as the sprite draw
  // (local (0,0) = stone's own center, d = on-screen diameter). 'overlay'
  // blend (not a flat fill) so the ring's existing embossed shading still
  // shows through the tint — same trick as BUBBLE_BLEND's identicon tinting.
  function drawStoneRingQuadrants(g, d) {
    const rgb = LED_LIT_RGB[g.team];
    const outerR = d * RING_OUTER_FRAC, innerR = d * RING_INNER_FRAC;
    const ledsOut = stoneLedsOut(g);
    RING_QUADRANT_ANGLES.forEach((centerAngle, i) => {
      if (i < ledsOut) return; // this quarter's LED is already out — ring stays neutral
      const a0 = centerAngle - RING_QUADRANT_HALF_SPAN, a1 = centerAngle + RING_QUADRANT_HALF_SPAN;
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, outerR, a0, a1, false);
      ctx.arc(0, 0, innerR, a1, a0, true);
      ctx.closePath();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fill();
      ctx.restore();
    });
  }
  // called from inside the same translate/rotate(+squish) transform as the
  // sprite draw, so local (0,0) is the stone's own center and d is the
  // sprite's on-screen diameter — matches drawImage(sprite, -g.r, -g.r, d, d).
  function drawStoneLeds(g, d) {
    const rgb = LED_LIT_RGB[g.team];
    const pulse = ledPulseStrength();
    const ledsOut = stoneLedsOut(g);
    LED_RECTS.forEach((led, i) => {
      const alive = i >= ledsOut;
      const strength = alive ? pulse : 0;
      const lx = (led.cxFrac - 0.5) * d, ly = (led.cyFrac - 0.5) * d;
      const hw = led.halfWFrac * d, hh = led.halfHFrac * d;
      if (strength < 0.98) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 1 - strength;
        ctx.fillStyle = LED_OFF_GRAY;
        ctx.beginPath(); ctx.roundRect(lx - hw, ly - hh, hw * 2, hh * 2, Math.min(hw, hh));
        ctx.fill();
        ctx.restore();
      }
      if (strength > 0.02) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = strength;
        ctx.shadowColor = `rgba(${rgb},0.9)`;
        ctx.shadowBlur = Math.max(hw, hh) * 1.4;
        ctx.fillStyle = `rgba(${rgb},0.9)`;
        ctx.beginPath(); ctx.roundRect(lx - hw, ly - hh, hw * 2, hh * 2, Math.min(hw, hh));
        ctx.fill();
        ctx.restore();
      }
    });
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
    drawContactShadow(g, stoneShadowSprite);
    drawSquished(g, () => {
      const sprite = bubbleSprites[g.team];
      if (sprite) {
        // pre-baked (module ring + identicon) at load time, so this draw is
        // ~1:1 (2x oversampled) with no further resampling of fine edges
        const d = g.r * 2;
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.rot || 0);
        // dead stone: desaturated 80%, permanently marked out of play (see
        // registerStoneHit/STONE_MAX_HITS) — still fully solid for collisions.
        // deadMix (0..1) lets a revived stone fade its color back in gradually
        // instead of snapping, see beginRoundReset/updateRoundReset.
        if (g.deadMix > 0.001) ctx.filter = `saturate(${1 - g.deadMix * (1 - DEAD_SATURATION)})`;
        ctx.drawImage(sprite, -g.r, -g.r, d, d);
        ctx.filter = 'none';
        drawStoneRingQuadrants(g, d);
        drawStoneLeds(g, d);
        ctx.restore();
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
      // drawStone) — triggered by BALL_GOAL_FRACTION instead of
      // STONE_LOSS_FRACTION, see physicsStep.
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

  function drawLaserTrail(points, team, totalLen) {
    if (points.length < 2 || totalLen < 1) return;
    const rgb = HALO_RGB[team];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    let cum = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1];
      const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const a0 = Math.max(0, 1 - cum / totalLen);
      const a1 = Math.max(0, 1 - (cum + segLen) / totalLen);
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
      const p0 = points[i], p1 = points[i + 1];
      const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const a0 = Math.max(0, 1 - cum / totalLen);
      const a1 = Math.max(0, 1 - (cum + segLen) / totalLen);
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
      let dx = drag.startX - drag.curX, dy = drag.startY - drag.curY;
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
  // Safety cap on ticks, well above the ~350 a full-power stone needs to
  // decay from MAX_SPEED to STOP_THRESHOLD under FRICTION — real cascades
  // stop long before this from their own moving/wall/blocker conditions; this
  // just bounds the pathological worst case (e.g. a body re-launched by a
  // late collision needing its own ~350-tick tail on top of however long the
  // frame already ran).
  const GHOST_MAX_TICKS = 600;
  // (Re)assigns this body's onward reach budget from whatever speed it has
  // RIGHT NOW — used both at creation (from the aimed pull strength) and
  // after every collision (from the resulting post-impulse speed), which is
  // what makes a struck body's laser length track the energy it received
  // rather than some fraction handed down from the body that hit it.
  function setGhostBudget(b) {
    const speed = Math.hypot(b.vx, b.vy);
    b.moving = speed > 1e-4;
    if (b.moving) {
      b.budget = (speed / POWER_SCALE) * LASER_LENGTH_FACTOR;
      b.traveled = 0;
      b.totalLen = b.budget;
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
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return false;
    let j = -(1 + BODY_RESTITUTION) * velAlongNormal;
    j /= (1 / a.mass + 1 / b2.mass);
    j *= BOUNCE_BOOST;
    const impX = j * nx, impY = j * ny;
    a.vx -= impX / a.mass; a.vy -= impY / a.mass;
    b2.vx += impX / b2.mass; b2.vy += impY / b2.mass;
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
    const nx = dx / dist, ny = dy / dist;
    const vDotN = b.vx * nx + b.vy * ny;
    const overlap = b.r - dist;
    b.x += nx * overlap; b.y += ny * overlap;
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
      let fr = b.kind === 'ball' ? BALL_FRICTION : FRICTION;
      if (boostZone && Math.hypot(b.x - boostZone.x, b.y - boostZone.y) <= boostZone.r) {
        fr = withSweepBoost(fr);
        // The stopping condition below is budget-capped, not purely
        // friction-decay-driven (a straight, unobstructed shot almost always
        // hits `traveled >= budget` long before its speed would naturally
        // decay under STOP_THRESHOLD) — so just slowing the decay here
        // barely moves where the laser stops. Topping up THIS leg's budget
        // by the same fraction the boost trims off the real friction
        // deficit (see withSweepBoost) makes the predicted reach visibly
        // stretch through the patch instead of only showing up later via a
        // faster post-collision leg. No effect whenever no zone is active,
        // or for any body whose path never enters one (boostZone is only
        // ever the aiming team's own not-yet-committed patch — see
        // runAimCascade) — doesn't touch anything's tuned reach otherwise.
        b.budget += moveDist * SWEEP_FRICTION_BONUS;
      }
      b.vx *= fr; b.vy *= fr;
      const spd = Math.hypot(b.vx, b.vy);
      if (spd < STOP_THRESHOLD || b.traveled >= b.budget) {
        b.vx = 0; b.vy = 0; b.moving = false;
        currentLeg(b).points.push({ x: b.x, y: b.y });
        continue;
      }
      if (spd > MAX_SPEED) { const s = MAX_SPEED / spd; b.vx *= s; b.vy *= s; }
      let hitWall = null; // {axis, wall} — cosmetic snap for the drawn point, see below
      if (b.y - b.r < FY0) { b.y = FY0 + b.r; b.vy = -b.vy * WALL_RESTITUTION; hitWall = { axis: 'y', wall: FY0 }; }
      if (b.y + b.r > FY1) { b.y = FY1 - b.r; b.vy = -b.vy * WALL_RESTITUTION; hitWall = { axis: 'y', wall: FY1 }; }
      let blockedByPost = false;
      if (b.x - b.r < FX0) { const pt = ghostCollideGoalSide(b, FX0); if (pt) { hitWall = pt; blockedByPost = true; } }
      if (b.x + b.r > FX1) { const pt = ghostCollideGoalSide(b, FX1); if (pt) { hitWall = pt; blockedByPost = true; } }
      if (!blockedByPost && Math.abs(b.y - CY) < GOAL_HALF_HEIGHT) {
        // reaching well into the goal mouth (clear of both posts) is a terminal
        // state for this prediction (mirrors physicsStep's falling-into-the-goal
        // check, same loss-fraction threshold) — simplified to a hard stop
        // rather than replicating the shrink animation, which has nothing to
        // predict.
        const depthPast = Math.max(FX0 - b.x, b.x - FX1);
        const lossFraction = b.kind === 'ball' ? BALL_GOAL_FRACTION : STONE_LOSS_FRACTION;
        if (circleFractionPast(depthPast, b.r) >= lossFraction) {
          b.vx = 0; b.vy = 0; b.moving = false;
          currentLeg(b).points.push({ x: b.x, y: b.y });
          continue;
        }
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
    bodies.push(makeGhostBody(entities.ball, 'ball', BALL_R, BALL_MASS));

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
  function renderAimCascade(team) {
    const bodies = runAimCascade(team);
    for (const b of bodies) for (const leg of b.legs) {
      if (leg.totalLen < 1 || leg.points.length < 2) continue;
      if (b.kind === 'ball') drawBallLaserTrail(leg.points, leg.totalLen);
      else drawLaserTrail(leg.points, team, leg.totalLen);
    }
  }
  // "Power" toolbar toggle, off-branch: a straight direction/energy readout
  // per stone — no ghost simulation, no bounces, no ball trail. Each stone
  // still eases via smoothLaserAim (shared with the cascade) so flipping the
  // toggle mid-drag doesn't introduce a second, differently-behaved smoothing
  // path; only the shape drawn from that smoothed aim changes.
  function renderBasicLaser(team) {
    for (const g of entities[team]) {
      if (g.out || g.falling) continue;
      const aim = getBodyAim(g);
      if (!aim) { g._laserUx = g._laserUy = g._laserLen = undefined; continue; }
      const s = smoothLaserAim(g, aim.ux, aim.uy, aim.len);
      const points = [{ x: g.x, y: g.y }, { x: g.x + s.ux * s.len, y: g.y + s.uy * s.len }];
      drawLaserTrail(points, team, s.len);
    }
  }
  function drawDragPreview() {
    if (!drag) return;
    const g = drag.entity;
    let dx = drag.startX - drag.curX, dy = drag.startY - drag.curY;
    let dist = Math.hypot(dx, dy);
    if (dist > MAX_DRAG) { const s = MAX_DRAG / dist; dx *= s; dy *= s; dist = MAX_DRAG; }
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(drag.curX, drag.curY); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
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
  // visual redesign. Re-enable by uncommenting the two call sites below.
  const atmosphere = createAtmosphere(W, H);

  function render() {
    drawBackground();
    // laser drawn before the bubbles/identicons so it reads as coming from
    // underneath the stone instead of overlapping its face
    const drawAimLaser = isBasicLaser() ? renderBasicLaser : renderAimCascade;
    if (phase === 'aimA') drawAimLaser('A');
    else if (phase === 'aimB') drawAimLaser('B');
    // lanWait too: local shot is locked in but stays visible as feedback
    // while waiting on the opponent, instead of vanishing the instant PLAY
    // is pressed.
    else if (phase === 'lanAim' || phase === 'lanWait') drawAimLaser(myTeam);
    drawDragPreview();
    // under the stones/ball (painter's order) — see drawSweepZone's own comment
    drawSweepOverlay();
    entities.A.forEach(g => { if (!g.out) drawStone(g); });
    entities.B.forEach(g => { if (!g.out) drawStone(g); });
    if (!entities.ball.out) drawBall(entities.ball);
    // atmosphere.draw(ctx); // neutralized for perf, see note at createAtmosphere()
    syncSweepButton();
    if (import.meta.env.DEV) drawPerfOverlay();
  }

  // ---------- Dev perf overlay (temporary — see perf audit, delete once done) ----------
  // Reports raw (uncapped) frame time, not the atmosphere-safe clamped `dt`
  // below, so real stalls/spikes over 100ms are visible instead of hidden by
  // that clamp. "worst frame" is the max seen within the current 1s window,
  // so a single spike doesn't get averaged away before you can read it.
  let perfWindowStart = performance.now();
  let perfFrameCount = 0;
  let perfMaxFrameMs = 0;
  let perfDisplayFps = 0;
  let perfDisplayMaxMs = 0;
  // Logged instead of just shown on-screen: reading a live counter while
  // also playing/dragging is unworkable, so spikes get written to the
  // console (with the game phase at that moment) to review after the fact.
  const PERF_SPIKE_MS = 50; // ~20fps or worse
  function updatePerfOverlay(rawMs) {
    if (rawMs > 0) {
      perfFrameCount++;
      if (rawMs > perfMaxFrameMs) perfMaxFrameMs = rawMs;
      if (rawMs > PERF_SPIKE_MS) {
        console.warn(`[perf] slow frame: ${rawMs.toFixed(0)}ms  phase=${phase}  t=${(performance.now() / 1000).toFixed(1)}s`);
      }
    }
    const elapsed = performance.now() - perfWindowStart;
    if (elapsed >= 1000) {
      perfDisplayFps = Math.round(perfFrameCount * 1000 / elapsed);
      perfDisplayMaxMs = perfMaxFrameMs;
      perfFrameCount = 0;
      perfMaxFrameMs = 0;
      perfWindowStart = performance.now();
    }
  }
  function drawPerfOverlay() {
    ctx.save();
    ctx.font = '16px monospace';
    const text = `${perfDisplayFps} fps  (worst frame: ${perfDisplayMaxMs.toFixed(0)}ms)`;
    const w = ctx.measureText(text).width + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, 8, w, 26);
    ctx.fillStyle = perfDisplayMaxMs > 33 ? '#ff5566' : '#7CFC9A';
    ctx.fillText(text, 16, 26);
    ctx.restore();
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

  function runSimTick() {
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
      // Scoring is already resolved (see onGoal) — keep stepping physics
      // through the GOAL_PAUSE_MS pause purely so any stones/ball still
      // gliding from the shot finish decelerating naturally instead of
      // freezing mid-slide the instant the goal was detected. Return value
      // (another goalA/goalB/wipeout*) is ignored on purpose.
      physicsStep();
    }
  }

  function loop() {
    const now = performance.now();
    if (import.meta.env.DEV) updatePerfOverlay(lastFrameTime === null ? 0 : now - lastFrameTime);
    // Capped so a backgrounded-tab reflow doesn't fling every particle across
    // the board in one giant jump when the frame comes back.
    const dt = lastFrameTime === null ? 1 / 60 : Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    // atmosphere.update(dt); // neutralized for perf, see note at createAtmosphere()
    if (phase !== turnTimerPhase) {
      if (isAimingPhase(phase)) turnTimerStart = performance.now();
      turnTimerPhase = phase;
    }
    // LAN: each client enforces its own local 30s clock independently (no
    // arbiter-side timer) — see "timer nimball" design note. Solo vs IA: same
    // 30s cap on the human's own turn (aiTeam's shots are already decided in
    // prepareAiShots(), so only the human side can ever be the one stalling).
    // Local pass-and-play has no cap — both players are already looking at
    // the same screen, so there's no "someone might not be paying attention"
    // case to guard against. A stone whose drag hasn't been released yet
    // still has pendingVx/Vy reset to 0 from onPointerDown, so cancelling the
    // in-flight drag and reusing the normal PLAY submission path naturally
    // sends "no shot" for it.
    if (((net && phase === 'lanAim') || (aiTeam && phase === 'aimA')) && turnTimerProgress() >= 1) {
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
    }
    render();
    requestAnimationFrame(loop);
  }
  loop();

  // dev-only handle for physics-tuning scripts (position/phase readback)
  if (import.meta.env.DEV) window.__nb = { entities: () => entities, phase: () => phase, step: () => physicsStep(), render: () => render(), sweep: () => sweep, aimingTeam: () => aimingTeam(), controlsEnabled: () => controlsEnabled, runAimCascade: (team) => runAimCascade(team) };
}
