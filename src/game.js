// Ported from prototypes/nimball-merged.html — merges the illustrated arena
// background, translucent bubble-style avatars, and arcade physics/goal
// capture mechanics explored across the earlier prototypes.

const IDENTICON_SRC = { A: '/identicons/team-a.png', B: '/identicons/team-b.png' };
const MODULE_SRC = { A: '/identicons/module-cyan-v3.png', B: '/identicons/module-orange-v3.png' };
const ARENA_FRAME_SRC = '/arena/frame.webp';
const PLAY_CAP_SRC = '/arena/play-cap.png';
const BALL_SRC = '/ball/ball.png';

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
  // scaled from the reference art — the pitch bounds match where the grass
  // actually sits in that artwork; the artwork itself (grass, lines, hex
  // marking, goals) is used as-is.
  const FX0 = 169, FY0 = 234, FX1 = 1032, FY1 = 714;
  const GY0 = 380, GY1 = 548;                 // goal mouth y-range
  const CY = (FY0 + FY1) / 2;
  const CENTER_X = (FX0 + FX1) / 2;           // pitch's true horizontal center — ball spawn and score readout share this axis
  const GOAL_HALF_HEIGHT = (GY1 - GY0) / 2;
  const GOAL_NET_DEPTH = 38;                  // how deep the goal box is (glob falls in past this)

  const SCALE = 1200 / 900;                   // physics scaled up vs the original 900-wide prototype
  const GLOB_R = 38;                          // between the old size (33 * SCALE ≈ 44) and the Globulos-proportioned size (26)
  const BALL_R = GLOB_R / 2 * 0.9;             // half a glob's diameter, shrunk 10% further (~17), rendered as the soccer-ball sprite
  const GLOB_MASS = 2.4;
  const BALL_MASS = 0.55;
  const FRICTION = 0.975;
  const WALL_RESTITUTION = 0.92;              // bouncier walls
  const BODY_RESTITUTION = 1.05;              // bouncier glob/ball impacts (amplified per feedback)
  const BOUNCE_BOOST = 1.18;                  // extra kick on glob-glob impacts, arcade feel
  const MAX_DRAG = 130 * SCALE;                // ~173
  const POWER_SCALE = 0.07;
  const MAX_SPEED = 10 * SCALE;                // ~13.3
  const STOP_THRESHOLD = 0.045;
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
      used: false, squish: 0, squishNX: 1, squishNY: 0, squishGain: 2.9, out: false,
      falling: false, fallScale: 1,
    };
  }
  function resetPositions() {
    entities.A = startPositions.A.map((p, i) => makeGlob('A', i, p));
    entities.B = startPositions.B.map((p, i) => makeGlob('B', i, p));
    entities.ball = {
      x: CENTER_X, y: CY, vx: 0, vy: 0, r: BALL_R, mass: BALL_MASS,
      squish: 0, squishNX: 1, squishNY: 0, rot: 0, squishGain: 1.1, stretch: 0,
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
  const BALL_STRETCH_RATE = 0.05, BALL_STRETCH_MAX = 0.28;
  function triggerSquish(e, nx, ny, strength) {
    const amt = Math.min(0.78, strength * 0.06 * (e.squishGain || 1));
    if (amt > e.squish) { e.squish = amt; e.squishNX = nx; e.squishNY = ny; }
    // ball only: a one-shot stretch impulse along its direction of travel,
    // seeded by impact strength and left to decay on its own (see physicsStep)
    // rather than tracked live off current speed — so it snaps back to round
    // shortly after a hit instead of staying deformed for the whole roll.
    if (e.stretch !== undefined) {
      const sAmt = Math.min(BALL_STRETCH_MAX, strength * BALL_STRETCH_RATE);
      if (sAmt > e.stretch) e.stretch = sAmt;
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
      e.vx *= FRICTION; e.vy *= FRICTION;
      const spd0 = Math.hypot(e.vx, e.vy);
      if (spd0 < STOP_THRESHOLD) { e.vx = 0; e.vy = 0; }
      else if (spd0 > MAX_SPEED) { const s = MAX_SPEED / spd0; e.vx *= s; e.vy *= s; }
      e.squish *= 0.8; if (e.squish < 0.01) e.squish = 0;
      if (e.stretch) { e.stretch *= 0.8; if (e.stretch < 0.01) e.stretch = 0; }
      // ball only: a slow roll-spin, well under its real rolling speed so the
      // (mostly symmetric) disc face doesn't blur/spin distractingly fast
      if (e.rot !== undefined) e.rot += (e.vx * 0.008 + e.vy * 0.003);
    }
    for (const e of list) {
      if (e.out || e.falling) continue; // fallen (or falling) into the goal: frozen until next round
      if (e.y - e.r < FY0) { const spd = Math.abs(e.vy); e.y = FY0 + e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, 1, spd); }
      if (e.y + e.r > FY1) { const spd = Math.abs(e.vy); e.y = FY1 - e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, 1, spd); }
      const inGoalMouthY = Math.abs(e.y - CY) < GOAL_HALF_HEIGHT;
      if (!inGoalMouthY) {
        if (e.x - e.r < FX0) { const spd = Math.abs(e.vx); e.x = FX0 + e.r; e.vx = -e.vx * WALL_RESTITUTION; triggerSquish(e, 1, 0, spd); }
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
    triggerSquish(a, -nx, -ny, impact);
    triggerSquish(b2, nx, ny, impact);
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
  // The physics bounds (FX0..FY1, GY0/GY1) are invisible constraints only — no vector
  // pitch is drawn on top; the grass, lines, hex marking and goals are all part of the art.
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

  function withSquish(e, drawFn) {
    ctx.save();
    ctx.translate(e.x, e.y);
    if (e.squish > 0.001) {
      const ang = Math.atan2(e.squishNY, e.squishNX);
      ctx.rotate(ang); ctx.scale(1 - e.squish * 0.8, 1 + e.squish * 0.8); ctx.rotate(-ang);
    }
    ctx.translate(-e.x, -e.y);
    drawFn();
    ctx.restore();
  }
  // Ball-only stretch: elongates along its direction of travel, sized off the
  // decaying e.stretch impulse (seeded once per hit in triggerSquish) rather
  // than live speed, so it snaps back to round shortly after contact instead
  // of staying deformed for as long as the ball keeps rolling fast.
  function withStretch(e, drawFn) {
    if (!e.stretch || e.stretch <= 0.001) { drawFn(); return; }
    ctx.save();
    ctx.translate(e.x, e.y);
    const ang = Math.atan2(e.vy, e.vx);
    ctx.rotate(ang); ctx.scale(1 + e.stretch, 1 - e.stretch * 0.7); ctx.rotate(-ang);
    ctx.translate(-e.x, -e.y);
    drawFn();
    ctx.restore();
  }
  // tight contact shadow shared by the bubbles and the ball — matched to the
  // arena's own light direction but barely spilling past the entity's own
  // footprint, like it's floating just above the grass rather than resting on it
  function drawContactShadow(g) {
    // blur scales with the entity's own radius rather than a fixed pixel amount —
    // a flat 3px blur reads as a subtle soft edge on a 38px glob, but on the much
    // smaller 17px ball it was smearing away most of the shadow's density
    const blur = Math.max(1.2, g.r * 0.08);
    ctx.beginPath();
    ctx.ellipse(g.x + g.r * 0.1, g.y + g.r * 0.16, g.r, g.r * 0.92, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.filter = `blur(${blur}px)`;
    ctx.fill();
    ctx.filter = 'none';
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
    drawContactShadow(g);
    withSquish(g, () => {
      const sprite = bubbleSprites[g.team];
      if (sprite) {
        // pre-baked (module ring + identicon) at load time, so this draw is
        // ~1:1 (2x oversampled) with no further resampling of fine edges
        const d = g.r * 2;
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(sprite, g.x - g.r, g.y - g.r, d, d);
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
    drawContactShadow(b);
    withStretch(b, () => withSquish(b, () => {
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
    }));
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

  function drawArrowShaft(fromX, fromY, toX, toY, width, alpha) {
    alpha = alpha === undefined ? 1 : alpha;
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headLen = width * 3.2, headWide = width * 2.4;
    const nx = -Math.sin(angle), ny = Math.cos(angle);
    const bx = toX - Math.cos(angle) * headLen, by = toY - Math.sin(angle) * headLen;
    const halfW = width / 2, halfHeadW = headWide / 2;

    // Single silhouette path (shaft rectangle + head triangle), stroked once and
    // filled on top — this is the only way to get a uniform-width outline on
    // every edge (including the tip), instead of layering independently sized
    // shapes and hoping their margins line up.
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(fromX + nx * halfW, fromY + ny * halfW);
    ctx.lineTo(bx + nx * halfW, by + ny * halfW);
    ctx.lineTo(bx + nx * halfHeadW, by + ny * halfHeadW);
    ctx.lineTo(toX, toY);
    ctx.lineTo(bx - nx * halfHeadW, by - ny * halfHeadW);
    ctx.lineTo(bx - nx * halfW, by - ny * halfW);
    ctx.lineTo(fromX - nx * halfW, fromY - ny * halfW);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#12181a';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  function drawAimArrow(g) {
    const dx = g.pendingVx, dy = g.pendingVy;
    if (!dx && !dy) return;
    const scale = 1 / POWER_SCALE;
    drawArrowShaft(g.x, g.y, g.x + dx * scale, g.y + dy * scale, 7, 0.95);
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
    const intensity = dist / MAX_DRAG;
    if (dist > 6) drawArrowShaft(g.x, g.y, g.x + dx, g.y + dy, 6 + 3 * intensity, 1);
  }

  function render() {
    drawBackground();
    // arrows drawn before the bubbles/identicons so they read as coming from
    // underneath the glob instead of overlapping its face
    if (phase === 'aimA') entities.A.forEach(g => { if (!g.out) drawAimArrow(g); });
    if (phase === 'aimB') entities.B.forEach(g => { if (!g.out) drawAimArrow(g); });
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
}
