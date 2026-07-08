// Ported from prototypes/nimball-merged.html — merges the illustrated arena
// background, translucent bubble-style avatars, and arcade physics/goal
// capture mechanics explored across the earlier prototypes.

// Prefixed with BASE_URL (not a bare leading slash) so these public/ assets
// still resolve when the app is served from a subpath, e.g. GitHub Pages at
// https://danyx11.github.io/NIM-Ball/.
const ASSET_BASE = import.meta.env.BASE_URL;
const IDENTICON_SRC = { A: `${ASSET_BASE}identicons/team-a.png`, B: `${ASSET_BASE}identicons/team-b.png` };
const MODULE_SRC = { A: `${ASSET_BASE}identicons/module-cyan-v3.png`, B: `${ASSET_BASE}identicons/module-orange-v3.png` };
const ARENA_FRAME_SRC = `${ASSET_BASE}arena/frame.webp`;
const PLAY_CAP_SRC = `${ASSET_BASE}arena/play-cap.png`;
const BALL_SRC = `${ASSET_BASE}ball/ball.png`;

export function startGame() {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // ---------- Identicons ----------
  // Strips the near-pure-white background behind the identicon's hexagon,
  // so the translucent bubble color shows through instead of a white square.
  // The background tone is sampled from the image's own corner (it's an
  // off-white grey, not pure white) and pixels fade out by their color
  // distance to it. Un-mixing the background tint out of the edge pixels'
  // color (dividing by a small alpha) blew up into a brighter white/grey
  // ring than the hard cutoff it replaced, so this only fades alpha and
  // leaves the anti-aliased color alone — at low alpha its exact color
  // barely shows once blended with the bubble underneath.
  function stripWhiteBackground(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
    const cctx = c.getContext('2d');
    cctx.drawImage(img, 0, 0, c.width, c.height);
    const data = cctx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    const bg = [d[0], d[1], d[2]];
    const lo = 6, hi = 46;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const dist = Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2]));
      if (dist <= lo) { d[i + 3] = 0; }
      else if (dist < hi) { d[i + 3] = Math.round(255 * (dist - lo) / (hi - lo)); }
    }
    cctx.putImageData(data, 0, 0);
    return c;
  }
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
  // hex slot on the module art (module-cyan-v3.png / module-orange-v3.png, 716x716,
  // real alpha), measured as a fraction of the module's own square canvas
  const HEX = { cxFrac: 0.503, cyFrac: 0.516, halfWFrac: 0.261, halfHFrac: 0.241 };
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

  const identiconStripped = {};
  const moduleImages = {};
  const bubbleSprites = {};
  // bakes the module ring (hex hole punched through it) + identicon into one
  // sprite per team, once both images are in — avoids doing this per-glob per-frame
  function tryBakeBubble(team) {
    const mod = moduleImages[team], id = identiconStripped[team];
    if (!mod || !id) return;
    // baked at 2x the on-screen diameter, same oversample convention as ballSprite
    const S = Math.round(GLOB_R * 2 * 2);
    const cx = S * HEX.cxFrac, cy = S * HEX.cyFrac;
    const halfW = S * HEX.halfWFrac, halfH = S * HEX.halfHFrac;

    const sizedModule = downscaleToFit(mod, S, S);
    const punched = document.createElement('canvas');
    punched.width = S; punched.height = S;
    const pctx = punched.getContext('2d');
    pctx.drawImage(sizedModule, 0, 0);
    pctx.globalCompositeOperation = 'destination-out';
    hexPath(pctx, cx, cy, halfW, halfH);
    pctx.fill();

    const fit = Math.max(halfW * 2, halfH * 2) * 1.05;
    const scale = fit / Math.max(id.width, id.height);
    const dw = Math.round(id.width * scale), dh = Math.round(id.height * scale);
    const sizedIdenticon = downscaleToFit(id, dw, dh);

    const bubble = document.createElement('canvas');
    bubble.width = S; bubble.height = S;
    const bctx = bubble.getContext('2d');
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
    bctx.save();
    hexPath(bctx, cx, cy, halfW, halfH);
    bctx.clip();
    bctx.drawImage(sizedIdenticon, cx - dw / 2, cy - dh / 2);
    bctx.restore();
    bctx.drawImage(punched, 0, 0);

    bubbleSprites[team] = bubble;
  }
  for (const team of ['A', 'B']) {
    const img = new Image();
    img.onload = () => {
      let stripped = stripWhiteBackground(img);
      // team B starts on the right side of the pitch, so mirror it to face the
      // ball at kickoff instead of away from it
      if (team === 'B') {
        const flipped = document.createElement('canvas');
        flipped.width = stripped.width; flipped.height = stripped.height;
        const fctx = flipped.getContext('2d');
        fctx.translate(flipped.width, 0);
        fctx.scale(-1, 1);
        fctx.drawImage(stripped, 0, 0);
        stripped = flipped;
      }
      identiconStripped[team] = stripped;
      tryBakeBubble(team);
    };
    img.src = IDENTICON_SRC[team];

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

  // PLAY cap: cut out of the arena artwork itself (same pixels, same look) so it can be
  // pressed/animated independently of the static background it was extracted from.
  // Cropped tight to just the orange capsule (alpha-masked) — the panel/frame around it
  // stays in arena/frame.webp and must never move when the cap is pressed.
  const PLAY_CAP_X0 = 761, PLAY_CAP_Y0 = 130, PLAY_CAP_X1 = 888, PLAY_CAP_Y1 = 187;
  const playCapImage = new Image();
  playCapImage.src = PLAY_CAP_SRC;

  // ---------- Config ----------
  // Field bounds match the illustrated arena (light-blue Nimiq accents),
  // scaled from the reference art — the pitch bounds match where the ice
  // actually sits in that artwork. The center line/hexagon/goal circles are
  // baked into frame.webp, re-centered on this same CENTER_X/CY at the image
  // level so the ball spawn always lands exactly on the hexagon's core.
  const FX0 = 169, FY0 = 234, FX1 = 1032, FY1 = 714;
  const GY0 = 380, GY1 = 548;                 // goal mouth y-range
  const CY = (FY0 + FY1) / 2;
  const CENTER_X = (FX0 + FX1) / 2;           // pitch's true horizontal center — ball spawn and score readout share this axis
  const GOAL_HALF_HEIGHT = (GY1 - GY0) / 2;
  const GOAL_NET_DEPTH = 38;                  // how deep the goal box is (glob falls in past this)

  const SCALE = 1200 / 900;                   // physics scaled up vs the original 900-wide prototype
  const GLOB_R = 38 * 0.9;                     // shrunk another 10% per feedback (was 38)
  const BALL_R = GLOB_R / 2 * 0.9 * 0.9;       // half a glob's diameter, shrunk 10% twice more (~15.4), rendered as the puck sprite
  const GLOB_MASS = 2.4;
  const BALL_MASS = 0.55;
  // Pace/bounce constants calibrated against frame-tracked Globulos footage
  // (foot 2 arena): launches glide about half the field width, impacts are
  // plain billiard exchanges with no added energy — puck/curling feel.
  const FRICTION = 0.9852;
  const BALL_FRICTION = 0.9786;                // the puck bleeds speed a bit faster than the players (also true in Globulos)
  const WALL_RESTITUTION = 0.85;
  const BODY_RESTITUTION = 1.0;
  const BOUNCE_BOOST = 1.0;                   // >1 re-adds the old arcade kick on impacts
  const MAX_DRAG = 130 * SCALE;                // ~173
  const POWER_SCALE = 0.054;
  const MAX_SPEED = 8;
  const STOP_THRESHOLD = 0.08;
  const WIN_SCORE = 3;

  const PW = FX1 - FX0, PH = FY1 - FY0;
  const startPositions = {
    A: [{ x: FX0 + 0.16 * PW, y: FY0 + 0.267 * PH }, { x: FX0 + 0.13 * PW, y: FY0 + 0.5 * PH }, { x: FX0 + 0.16 * PW, y: FY0 + 0.733 * PH }],
    B: [{ x: FX1 - 0.16 * PW, y: FY0 + 0.267 * PH }, { x: FX1 - 0.13 * PW, y: FY0 + 0.5 * PH }, { x: FX1 - 0.16 * PW, y: FY0 + 0.733 * PH }],
  };

  let scoreA = 0, scoreB = 0;
  let round = 1;
  let phase = 'start';
  let entities = { A: [], B: [], ball: null };
  let drag = null;
  let readyA = false, readyB = false;

  function makeGlob(team, idx, pos) {
    return {
      id: team + idx, team, x: pos.x, y: pos.y, vx: 0, vy: 0, r: GLOB_R, mass: GLOB_MASS,
      used: false, squish: 0, squishNX: 1, squishNY: 0, squishGain: 1.05, out: false,
      squishPhase: null, squishT: 0, squishPeak: 0,
      falling: false, fallScale: 1, rot: 0, rotVel: 0,
    };
  }
  function resetPositions() {
    entities.A = startPositions.A.map((p, i) => makeGlob('A', i, p));
    entities.B = startPositions.B.map((p, i) => makeGlob('B', i, p));
    entities.ball = {
      x: CENTER_X, y: CY, vx: 0, vy: 0, r: BALL_R, mass: BALL_MASS, rot: 0,
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
  function currentTeamGlobs() {
    if (phase === 'aimA') return entities.A.filter(g => !g.out && !g.falling);
    if (phase === 'aimB') return entities.B.filter(g => !g.out && !g.falling);
    return [];
  }
  function findGlobAt(pos) {
    for (const g of currentTeamGlobs())
      if (Math.hypot(g.x - pos.x, g.y - pos.y) <= g.r + 12) return g;
    return null;
  }
  function onPointerDown(evt) {
    const pos = getPointerPos(evt);
    if (isPlayButtonActive() && pointInPlayButton(pos)) {
      evt.preventDefault();
      pressPlayButton();
      return;
    }
    if (phase !== 'aimA' && phase !== 'aimB') return;
    evt.preventDefault();
    const g = findGlobAt(pos);
    if (!g) return;
    g.pendingVx = 0; g.pendingVy = 0;
    drag = { entity: g, startX: g.x, startY: g.y, curX: pos.x, curY: pos.y };
  }
  function onPointerMove(evt) {
    if (!drag) return;
    evt.preventDefault();
    const pos = getPointerPos(evt);
    drag.curX = pos.x; drag.curY = pos.y;
  }
  function onPointerUp(evt) {
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

  halfA.addEventListener('click', () => { readyA = true; halfA.classList.add('ready'); checkA.textContent = '✓'; maybeStart(); });
  halfB.addEventListener('click', () => { readyB = true; halfB.classList.add('ready'); checkB.textContent = '✓'; maybeStart(); });
  function maybeStart() {
    if (readyA && readyB) {
      startOverlay.classList.add('hidden');
      controlsEnabled = true;
      phase = 'aimA';
    }
  }

  function showOverlay(html) { overlay.classList.remove('hidden'); ovContent.innerHTML = html; }
  function hideOverlay() { overlay.classList.add('hidden'); }
  // J1->J2: no "pass the device" screen, straight into the other team's aim phase.
  // J2->sim: a fixed 2s beat after the PLAY press before the shots actually launch.
  const PRE_SIM_DELAY = 1000;
  function onValidate() {
    if (phase === 'aimA') phase = 'aimB';
    else if (phase === 'aimB') { phase = 'pending'; setTimeout(launchSimulation, PRE_SIM_DELAY); }
  }
  function launchSimulation() {
    entities.A.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; });
    entities.B.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; });
    phase = 'sim';
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
  function triggerSquish(e, nx, ny, strength) {
    // globs only: a contact spins them, torque coming from the tangential
    // slip at the point of impact (a dead-center hit has none) — decays back
    // out on its own in physicsStep, like real angular friction bleeding it off
    if (e.rotVel !== undefined) {
      const tx = -ny, ty = nx;
      const vt = e.vx * tx + e.vy * ty;
      e.rotVel += vt * 0.063;
    }
    if (e.squish === undefined) return; // ball: no contact deformation
    // capped well below the old 0.78 — a subtler, softer bump per feedback
    const amt = Math.min(0.126, strength * 0.06 * (e.squishGain || 1)); // whole effect scaled down 30% per feedback
    if (amt > e.squish) {
      e.squish = amt; e.squishNX = nx; e.squishNY = ny;
      e.squishPeak = amt; e.squishPhase = 'in'; e.squishT = 0;
    }
  }
  function physicsStep() {
    const list = allEntities();
    for (const e of list) {
      if (e.falling) {
        // shrinking-into-the-void animation; frozen otherwise, no normal physics while it plays
        e.fallScale -= 0.045;
        if (e.fallScale <= 0) { e.fallScale = 0; e.falling = false; e.out = true; }
        continue;
      }
      e.x += e.vx; e.y += e.vy;
      const fr = e === entities.ball ? BALL_FRICTION : FRICTION;
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
        // globs: rotation is mostly a contact reaction (see triggerSquish), with
        // only a faint drift from rolling itself — otherwise near-static in flight,
        // unlike the ball's continuous spin below
        e.rot += e.rotVel + (e.vx * 0.0018 + e.vy * 0.00072);
        e.rotVel *= 0.92;
      } else if (e.rot !== undefined) {
        // ball: continuous roll-spin, well under its real rolling speed so the
        // (mostly symmetric) disc face doesn't blur/spin distractingly fast
        e.rot += (e.vx * 0.008 + e.vy * 0.003);
      }
    }
    for (const e of list) {
      if (e.out || e.falling) continue; // fallen (or falling) into the goal: frozen until next round
      if (e.y - e.r < FY0) { const spd = Math.abs(e.vy); e.y = FY0 + e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, -1, spd); }
      if (e.y + e.r > FY1) { const spd = Math.abs(e.vy); e.y = FY1 - e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, 1, spd); }
      const inGoalMouthY = Math.abs(e.y - CY) < GOAL_HALF_HEIGHT;
      if (!inGoalMouthY) {
        if (e.x - e.r < FX0) { const spd = Math.abs(e.vx); e.x = FX0 + e.r; e.vx = -e.vx * WALL_RESTITUTION; triggerSquish(e, -1, 0, spd); }
        if (e.x + e.r > FX1) { const spd = Math.abs(e.vx); e.x = FX1 - e.r; e.vx = -e.vx * WALL_RESTITUTION; triggerSquish(e, 1, 0, spd); }
      } else if (e !== entities.ball) {
        // a glob may now fall fully into the goal, instead of bouncing off the net;
        // once it's gone deep enough, it starts shrinking away until the next round
        if (e.x + e.r < FX0 - GOAL_NET_DEPTH || e.x - e.r > FX1 + GOAL_NET_DEPTH) {
          e.falling = true; e.fallScale = 1; e.vx = 0; e.vy = 0;
        }
      }
    }
    const activeList = list.filter(e => !e.out && !e.falling);
    for (let i = 0; i < activeList.length; i++) for (let j = i + 1; j < activeList.length; j++) resolveCollision(activeList[i], activeList[j]);
    const b = entities.ball;
    if (b.x + b.r < FX0) return 'goalB';
    if (b.x - b.r > FX1) return 'goalA';
    // if an entire team has fallen into the goal, the other team scores the point
    if (entities.A.every(g => g.out)) return 'wipeoutB';
    if (entities.B.every(g => g.out)) return 'wipeoutA';
    return null;
  }
  function resolveCollision(a, b2) {
    const dx = b2.x - a.x, dy = b2.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = a.r + b2.r;
    if (dist === 0 || dist >= minDist) return;
    const nx = dx / dist, ny = dy / dist;
    const overlap = (minDist - dist) / 2;
    a.x -= nx * overlap; a.y -= ny * overlap;
    b2.x += nx * overlap; b2.y += ny * overlap;
    const rvx = b2.vx - a.vx, rvy = b2.vy - a.vy;
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
  }
  function allSettled() { return allEntities().every(e => e.vx === 0 && e.vy === 0 && !e.falling); }

  // ---------- Round / goal flow ----------
  function onGoal(scoringTeam) {
    if (scoringTeam === 'A') scoreA++; else scoreB++;
    if (scoreA >= WIN_SCORE || scoreB >= WIN_SCORE) {
      phase = 'gameover';
      const winner = scoreA >= WIN_SCORE ? 'BLEUE' : 'ROUGE';
      const cls = scoreA >= WIN_SCORE ? 'a' : 'b';
      showOverlay(`
        <span class="team-pill ${cls}">ÉQUIPE ${winner}</span>
        <h2>Victoire !</h2>
        <p>Score final ${scoreA} – ${scoreB}</p>
        <button class="bigbtn" id="playAgainBtn">Rejouer</button>
      `);
      document.getElementById('playAgainBtn').onclick = () => {
        scoreA = 0; scoreB = 0; round = 1;
        resetPositions(); phase = 'aimA'; hideOverlay();
      };
      return;
    }
    round++;
    const scored = scoringTeam === 'A' ? 'BLEUE' : 'ROUGE';
    const cls = scoringTeam === 'A' ? 'a' : 'b';
    showOverlay(`
      <span class="team-pill ${cls}">BUT ÉQUIPE ${scored}</span>
      <h2>Manche ${round}</h2>
      <p>Score : ${scoreA} – ${scoreB}</p>
      <button class="bigbtn" id="nextRoundBtn">Manche suivante</button>
    `);
    document.getElementById('nextRoundBtn').onclick = () => { resetPositions(); phase = 'aimA'; hideOverlay(); };
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
    drawPlayButton();
  }

  // Score lives inside the "NIM-BALL" panel — this version of the artwork ships with the
  // "-" already baked in and no digits at all, so there's nothing to patch/inpaint; we just
  // draw the two digits directly into the empty slot flanking the original dash.
  // Screen interior (measured from the art): x:[323,437], y:[157,188]; dash center: (380,173.5).
  const SCORE_SLOT_CX_A = 349, SCORE_SLOT_CX_B = 411, SCORE_SLOT_CY = 177;
  function drawScorePanel() {
    ctx.save();
    ctx.font = `800 38px 'Baloo 2', Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5ecbf5';
    ctx.fillText(String(scoreA), SCORE_SLOT_CX_A, SCORE_SLOT_CY);
    ctx.fillStyle = '#ffc94d';
    ctx.fillText(String(scoreB), SCORE_SLOT_CX_B, SCORE_SLOT_CY);
    ctx.restore();
  }

  // PLAY cap: extracted from the artwork, drawn back on top of the socket that was
  // patched into the background where it used to sit — see PLAY_CAP_X0..Y1 above.
  // Pressing it squashes/dips it toward the socket and springs it back, like a real button.
  const PLAY_PRESS_DURATION = 220;
  let playPressAt = 0;
  function playButtonBounds() {
    return { x0: PLAY_CAP_X0, y0: PLAY_CAP_Y0, x1: PLAY_CAP_X1, y1: PLAY_CAP_Y1 };
  }
  function isPlayButtonActive() {
    return controlsEnabled && (phase === 'aimA' || phase === 'aimB');
  }
  function pointInPlayButton(pos) {
    const b = playButtonBounds();
    return pos.x >= b.x0 && pos.x <= b.x1 && pos.y >= b.y0 && pos.y <= b.y1;
  }
  function pressPlayButton() {
    playPressAt = performance.now();
    onValidate();
  }
  function drawPlayButton() {
    if (!playCapImage.complete || !playCapImage.naturalWidth) return;
    const b = playButtonBounds();
    const cw = b.x1 - b.x0, ch = b.y1 - b.y0;
    const cx = b.x0 + cw / 2, cy = b.y0 + ch / 2;
    let p = 0;
    if (playPressAt) {
      const t = performance.now() - playPressAt;
      if (t >= PLAY_PRESS_DURATION) playPressAt = 0;
      else p = t / PLAY_PRESS_DURATION;
    }
    // Sharp snap down, slower ease back — a linear tent (not a sine bell) reads as a
    // crisp mechanical press instead of a soft/floaty squish.
    const squash = p < 0.2 ? p / 0.2 : Math.max(0, 1 - (p - 0.2) / 0.8);
    const scale = 1 - 0.04 * squash;
    const dy = 1.5 * squash;
    const dim = 1; // always reads full color once back to size, even while resolving/simulating

    ctx.save();
    ctx.globalAlpha = dim;
    ctx.translate(cx, cy + dy);
    ctx.scale(scale, scale);
    ctx.drawImage(playCapImage, -cw / 2, -ch / 2, cw, ch);
    if (squash > 0) {
      ctx.globalAlpha = dim * squash * 0.15;
      ctx.fillStyle = '#000000';
      ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
    }
    ctx.restore();
  }

  // Splits the entity into two clipped halves along the line through its own
  // center, perpendicular to the contact direction: the far half is redrawn
  // completely as-is (zero modification), the near half is compressed toward
  // that same center line. Because both halves pivot on the exact same line,
  // they always meet without a seam — and the far half genuinely never moves,
  // rather than just moving "less" than the near half.
  function drawSquished(e, drawFn) {
    if (!(Math.abs(e.squish) > 0.001)) { drawFn(); return; }
    const ang = Math.atan2(e.squishNY, e.squishNX);
    const sx = 1 - e.squish * 0.85; // pure compression along the contact axis, no perpendicular bulge
    const R = e.r * 1.6; // generous half-plane size, comfortably covers the whole sprite/shadow

    ctx.save(); // far half: untouched
    ctx.translate(e.x, e.y); ctx.rotate(ang);
    ctx.beginPath(); ctx.rect(-R, -R, R, R * 2); ctx.clip();
    ctx.rotate(-ang); ctx.translate(-e.x, -e.y);
    drawFn();
    ctx.restore();

    ctx.save(); // near half: compressed toward the shared center line
    ctx.translate(e.x, e.y); ctx.rotate(ang);
    ctx.beginPath(); ctx.rect(0, -R, R, R * 2); ctx.clip();
    ctx.scale(sx, 1);
    ctx.rotate(-ang); ctx.translate(-e.x, -e.y);
    drawFn();
    ctx.restore();
  }
  function withSquish(e, drawFn) { drawSquished(e, drawFn); }
  // tight contact shadow shared by the bubbles and the ball — matched to the
  // arena's own light direction but barely spilling past the entity's own
  // footprint, like it's floating just above the grass rather than resting on it
  function drawContactShadow(g, boost = 1) {
    // blur scales with the entity's own radius rather than a fixed pixel amount —
    // a flat 3px blur reads as a subtle soft edge on a 38px glob, but on the much
    // smaller 17px ball it was smearing away most of the shadow's density
    const blur = Math.max(1.2, g.r * 0.08);
    const cx = g.x + g.r * 0.1 * boost, cy = g.y + g.r * 0.16 * boost;
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.85, 0.6 * boost)})`;
    ctx.filter = `blur(${blur}px)`;
    // pivoted on the shadow's OWN (light-offset) center rather than the glob's
    // physics center, so the retraction is symmetric on the shadow's own shape
    // instead of lopsided. The sprite is drawn on top and occludes most of the
    // shadow near the glob's center, so this only becomes visible on whichever
    // side the shadow actually pokes out past the glob — matching the bubble's
    // own compression there — and stays invisible on the opposite side.
    const shadowEntity = { x: cx, y: cy, r: g.r, squish: g.squish || 0, squishNX: g.squishNX, squishNY: g.squishNY };
    drawSquished(shadowEntity, () => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, g.r * boost, g.r * 0.92 * boost, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.filter = 'none';
  }

  // soft glow beneath the bubbles of the team that's currently aiming — an
  // "on deck" cue readable at a glance, pulsing gently so it doesn't read as static
  // decoration. Tinted with each team's own accent color (matches the score digits).
  const HALO_RGB = { A: '94,203,245', B: '255,201,77' };
  function drawAimHalo(g) {
    const t = performance.now() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 + (g.team === 'A' ? 0 : Math.PI));
    const rgb = HALO_RGB[g.team];
    const R = g.r * 1.6;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(g.x, g.y, g.r * 0.4, g.x, g.y, R);
    grad.addColorStop(0, `rgba(${rgb},${(0.38 + 0.17 * pulse).toFixed(3)})`);
    grad.addColorStop(0.6, `rgba(${rgb},${(0.16 + 0.08 * pulse).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.beginPath(); ctx.arc(g.x, g.y, R, 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
  }
  function isAimingTeamGlob(g) {
    return ((phase === 'aimA' && g.team === 'A') || (phase === 'aimB' && g.team === 'B')) && !g.falling;
  }
  function drawGlob(g) {
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
    if (isAimingTeamGlob(g)) drawAimHalo(g);
    drawContactShadow(g);
    withSquish(g, () => {
      const sprite = bubbleSprites[g.team];
      if (sprite) {
        // pre-baked (module ring + identicon) at load time, so this draw is
        // ~1:1 (2x oversampled) with no further resampling of fine edges
        const d = g.r * 2;
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.rot || 0);
        ctx.drawImage(sprite, -g.r, -g.r, d, d);
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
    drawContactShadow(b, 1.05);
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

    ctx.restore();
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
  // arrow's length) — gives the shot a bit more presence without simulating
  // all the way out to where friction would actually stop the glob
  const LASER_LENGTH_FACTOR = 1.8;

  // predicts the shot's path from the glob's own position, bouncing off the arena
  // walls the same way physicsStep does (the goal mouth stays open on the x-walls,
  // same GOAL_HALF_HEIGHT test as the real collision code). Starting exactly at the
  // glob — rather than past some unclipped lead-in segment — keeps every bounce
  // point honest against FX0..FY1, including for globs sitting close to a wall.
  // Bounces are computed at the rail itself (r=0 passed in below), not the glob's
  // own center-of-mass offset, so the visible line meets the rail where the
  // bubble's edge would actually touch it, not a whole radius short of it.
  // FY1/FX1 sit ~15px short of the drawn rail in the current arena art (measured
  // against public/arena/frame.webp — FY0/FX0 already land exactly on it), so this
  // fudge is laser-only cosmetics; it doesn't touch the real physicsStep bounds.
  const LASER_FAR_EDGE_FUDGE = 13;
  const LASER_SIDE_EDGE_FUDGE = 8; // extra reach on both x-walls specifically
  function computeBounceTrail(x, y, ux, uy, totalLen, r) {
    const points = [{ x, y }];
    let remaining = totalLen, cx = x, cy = y, bounces = 0;
    while (remaining > 0.5 && bounces < 6) {
      const candidates = [];
      if (uy < 0) candidates.push({ t: (FY0 + r - cy) / uy, axis: 'y' });
      if (uy > 0) candidates.push({ t: (FY1 + LASER_FAR_EDGE_FUDGE - r - cy) / uy, axis: 'y' });
      if (ux < 0) {
        const t = (FX0 - LASER_SIDE_EDGE_FUDGE + r - cx) / ux;
        if (t > 0 && Math.abs(cy + uy * t - CY) >= GOAL_HALF_HEIGHT) candidates.push({ t, axis: 'x' });
      }
      if (ux > 0) {
        const t = (FX1 + LASER_FAR_EDGE_FUDGE + LASER_SIDE_EDGE_FUDGE - r - cx) / ux;
        if (t > 0 && Math.abs(cy + uy * t - CY) >= GOAL_HALF_HEIGHT) candidates.push({ t, axis: 'x' });
      }
      const hit = candidates.filter(c => c.t > 1e-6 && isFinite(c.t)).sort((a, b) => a.t - b.t)[0];
      if (!hit || hit.t > remaining) {
        cx += ux * remaining; cy += uy * remaining;
        points.push({ x: cx, y: cy });
        break;
      }
      cx += ux * hit.t; cy += uy * hit.t;
      points.push({ x: cx, y: cy });
      remaining -= hit.t;
      if (hit.axis === 'x') ux = -ux; else uy = -uy;
      bounces++;
    }
    return points;
  }
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

  function drawAimLaser(g) {
    const dx = g.pendingVx, dy = g.pendingVy;
    if (!dx && !dy) return;
    const scale = 1 / POWER_SCALE;
    const pullLen = Math.hypot(dx * scale, dy * scale);
    if (pullLen < 1) return;
    const ux = (dx * scale) / pullLen, uy = (dy * scale) / pullLen;
    const laserLen = pullLen * LASER_LENGTH_FACTOR;
    drawLaserTrail(computeBounceTrail(g.x, g.y, ux, uy, laserLen, 0), g.team, laserLen);
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
    if (dist > 6) {
      const laserLen = dist * LASER_LENGTH_FACTOR;
      drawLaserTrail(computeBounceTrail(g.x, g.y, dx / dist, dy / dist, laserLen, 0), g.team, laserLen);
    }
  }

  function render() {
    drawBackground();
    // laser drawn before the bubbles/identicons so it reads as coming from
    // underneath the glob instead of overlapping its face
    if (phase === 'aimA') entities.A.forEach(g => { if (!g.out) drawAimLaser(g); });
    if (phase === 'aimB') entities.B.forEach(g => { if (!g.out) drawAimLaser(g); });
    drawDragPreview();
    entities.A.forEach(g => { if (!g.out) drawGlob(g); });
    entities.B.forEach(g => { if (!g.out) drawGlob(g); });
    drawBall(entities.ball);
  }

  // ---------- Main loop ----------
  let settleFrames = 0;
  function loop() {
    if (phase === 'sim') {
      const result = physicsStep();
      if (result === 'goalA' || result === 'goalB' || result === 'wipeoutA' || result === 'wipeoutB') {
        phase = 'goal';
        onGoal(result.endsWith('A') ? 'A' : 'B');
      } else if (allSettled()) {
        settleFrames++;
        if (settleFrames > 6) {
          settleFrames = 0; phase = 'aimA';
          entities.A.forEach(g => { g.used = false; g.pendingVx = 0; g.pendingVy = 0; });
          entities.B.forEach(g => { g.used = false; g.pendingVx = 0; g.pendingVy = 0; });
        }
      } else settleFrames = 0;
    }
    render();
    requestAnimationFrame(loop);
  }
  loop();

  // dev-only handle for physics-tuning scripts (position/phase readback)
  if (import.meta.env.DEV) window.__nb = { entities: () => entities, phase: () => phase, step: () => physicsStep() };
}
