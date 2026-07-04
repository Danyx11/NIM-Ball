// Ported from prototypes/orb-cup-prototype.html — same physics/render logic,
// with the identicons loaded from real files instead of inline base64.

const IDENTICON_SRC = { A: '/identicons/team-a.png', B: '/identicons/team-b.png' };

export function startGame() {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // ---------- Identicons ----------
  const identiconImages = {};
  for (const team of ['A', 'B']) {
    const img = new Image();
    img.onload = () => { identiconImages[team] = img; };
    img.src = IDENTICON_SRC[team];
  }

  // ---------- Config ----------
  const GLOB_R = 33;
  const BALL_R = 20;
  const GLOB_MASS = 2.4;
  const BALL_MASS = 0.55;
  const FRICTION = 0.975;
  const WALL_RESTITUTION = 0.7;
  const BODY_RESTITUTION = 0.88;
  const MAX_DRAG = 130;
  const POWER_SCALE = 0.07;
  const STOP_THRESHOLD = 0.045;
  const GOAL_HALF_HEIGHT = 78;
  const GOAL_DEPTH = 28;
  const ARENA_MARGIN = 24;
  const ARENA_CORNER = 16;
  const WIN_SCORE = 3;

  const startPositions = {
    A: [{ x: 160, y: 150 }, { x: 135, y: 260 }, { x: 160, y: 370 }],
    B: [{ x: 740, y: 150 }, { x: 765, y: 260 }, { x: 740, y: 370 }],
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
      used: false, squish: 0, squishNX: 1, squishNY: 0, squishGain: 2.1,
    };
  }
  function resetPositions() {
    entities.A = startPositions.A.map((p, i) => makeGlob('A', i, p));
    entities.B = startPositions.B.map((p, i) => makeGlob('B', i, p));
    entities.ball = {
      x: W / 2, y: H / 2, vx: 0, vy: 0, r: BALL_R, mass: BALL_MASS,
      squish: 0, squishNX: 1, squishNY: 0, rot: 0, squishGain: 1.1,
    };
  }
  resetPositions();
  function allEntities() { return [...entities.A, ...entities.B, entities.ball]; }

  // Fallback mosaic patterns (used only if the identicon images haven't loaded yet)
  const PATTERN_A = [[1, 0, 1, 0, 1], [0, 1, 0, 1, 0], [1, 1, 1, 1, 1], [0, 1, 0, 1, 0], [1, 0, 0, 0, 1]];
  const PATTERN_B = [[0, 1, 0, 1, 0], [1, 0, 1, 0, 1], [0, 1, 1, 1, 0], [1, 0, 1, 0, 1], [0, 0, 1, 0, 0]];
  function drawFallbackIdenticon(cx, cy, r, pattern, baseColor, darkColor) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = baseColor; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    const cell = (r * 2) / 5;
    ctx.fillStyle = darkColor;
    for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++)
      if (pattern[row][col]) ctx.fillRect(cx - r + col * cell, cy - r + row * cell, cell, cell);
    ctx.restore();
  }

  // ---------- Input ----------
  function getPointerPos(evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = W / rect.width, scaleY = H / rect.height;
    const t = evt.touches ? (evt.touches[0] || evt.changedTouches[0]) : evt;
    return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
  }
  function currentTeamGlobs() {
    if (phase === 'aimA') return entities.A;
    if (phase === 'aimB') return entities.B;
    return [];
  }
  function findGlobAt(pos) {
    for (const g of currentTeamGlobs())
      if (Math.hypot(g.x - pos.x, g.y - pos.y) <= g.r + 12) return g;
    return null;
  }
  function onPointerDown(evt) {
    if (phase !== 'aimA' && phase !== 'aimB') return;
    evt.preventDefault();
    const pos = getPointerPos(evt);
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
  const turnLabel = document.getElementById('turnLabel');
  const validateBtn = document.getElementById('validateBtn');
  const resetShotsBtn = document.getElementById('resetShotsBtn');
  const overlay = document.getElementById('overlay');
  const ovContent = document.getElementById('ovContent');
  const startOverlay = document.getElementById('startOverlay');
  const halfA = document.getElementById('halfA');
  const halfB = document.getElementById('halfB');
  const checkA = document.getElementById('checkA');
  const checkB = document.getElementById('checkB');
  const scoreAEl = document.getElementById('scoreA');
  const scoreBEl = document.getElementById('scoreB');

  function refreshTurnLabel() {
    if (phase === 'aimA') { turnLabel.textContent = "Au tour de l'équipe bleue — vise tes billes"; turnLabel.className = 'a'; }
    else if (phase === 'aimB') { turnLabel.textContent = "Au tour de l'équipe rouge — vise tes billes"; turnLabel.className = 'b'; }
    else { turnLabel.textContent = 'Résolution du tour…'; turnLabel.className = ''; }
  }
  halfA.addEventListener('click', () => { readyA = true; halfA.classList.add('ready'); checkA.textContent = '✓'; maybeStart(); });
  halfB.addEventListener('click', () => { readyB = true; halfB.classList.add('ready'); checkB.textContent = '✓'; maybeStart(); });
  function maybeStart() {
    if (readyA && readyB) {
      startOverlay.classList.add('hidden');
      validateBtn.disabled = false; resetShotsBtn.disabled = false;
      phase = 'aimA'; refreshTurnLabel();
    }
  }

  function showOverlay(html) { overlay.classList.remove('hidden'); ovContent.innerHTML = html; }
  function hideOverlay() { overlay.classList.add('hidden'); }
  function startPassScreen(nextPhase, teamLabel, teamClass) {
    phase = 'pass';
    showOverlay(`
      <span class="team-pill ${teamClass}">${teamLabel}</span>
      <h2>Passe l'appareil</h2>
      <p>Les tirs de l'autre équipe sont en place mais cachés. Passe l'écran, puis appuie pour viser tes billes.</p>
      <button class="bigbtn" id="passContinueBtn">C'est mon tour</button>
    `);
    document.getElementById('passContinueBtn').onclick = () => { hideOverlay(); phase = nextPhase; refreshTurnLabel(); };
  }
  validateBtn.addEventListener('click', () => {
    if (phase === 'aimA') startPassScreen('aimB', 'ÉQUIPE ROUGE', 'b');
    else if (phase === 'aimB') { hideOverlay(); launchSimulation(); }
  });
  resetShotsBtn.addEventListener('click', () => {
    currentTeamGlobs().forEach(g => { g.pendingVx = 0; g.pendingVy = 0; g.used = false; });
  });
  function launchSimulation() {
    entities.A.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; });
    entities.B.forEach(g => { g.vx = g.pendingVx || 0; g.vy = g.pendingVy || 0; });
    phase = 'sim';
    turnLabel.className = ''; turnLabel.textContent = 'Ça bouge…';
  }

  // ---------- Physics ----------
  function triggerSquish(e, nx, ny, strength) {
    const amt = Math.min(0.68, strength * 0.06 * (e.squishGain || 1));
    if (amt > e.squish) { e.squish = amt; e.squishNX = nx; e.squishNY = ny; }
  }
  function physicsStep() {
    const list = allEntities();
    for (const e of list) {
      e.x += e.vx; e.y += e.vy;
      e.vx *= FRICTION; e.vy *= FRICTION;
      if (Math.hypot(e.vx, e.vy) < STOP_THRESHOLD) { e.vx = 0; e.vy = 0; }
      e.squish *= 0.8; if (e.squish < 0.01) e.squish = 0;
      if (e.rot !== undefined) e.rot += (e.vx * 0.03 + e.vy * 0.01);
    }
    for (const e of list) {
      if (e.y - e.r < ARENA_MARGIN) { const spd = Math.abs(e.vy); e.y = ARENA_MARGIN + e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, 1, spd); }
      if (e.y + e.r > H - ARENA_MARGIN) { const spd = Math.abs(e.vy); e.y = H - ARENA_MARGIN - e.r; e.vy = -e.vy * WALL_RESTITUTION; triggerSquish(e, 0, 1, spd); }
      const inGoalMouthY = Math.abs(e.y - H / 2) < GOAL_HALF_HEIGHT;
      if (!inGoalMouthY) {
        if (e.x - e.r < ARENA_MARGIN) { const spd = Math.abs(e.vx); e.x = ARENA_MARGIN + e.r; e.vx = -e.vx * WALL_RESTITUTION; triggerSquish(e, 1, 0, spd); }
        if (e.x + e.r > W - ARENA_MARGIN) { const spd = Math.abs(e.vx); e.x = W - ARENA_MARGIN - e.r; e.vx = -e.vx * WALL_RESTITUTION; triggerSquish(e, 1, 0, spd); }
      } else if (e !== entities.ball) {
        const inset = GOAL_DEPTH;
        if (e.x - e.r < inset) { const spd = Math.abs(e.vx); e.x = inset + e.r; e.vx = -e.vx * WALL_RESTITUTION; triggerSquish(e, 1, 0, spd); }
        if (e.x + e.r > W - inset) { const spd = Math.abs(e.vx); e.x = W - inset - e.r; e.vx = -e.vx * WALL_RESTITUTION; triggerSquish(e, 1, 0, spd); }
      }
    }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) resolveCollision(list[i], list[j]);
    const b = entities.ball;
    if (b.x + b.r < -4) return 'goalB';
    if (b.x - b.r > W + 4) return 'goalA';
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
    const impX = j * nx, impY = j * ny;
    a.vx -= impX * invMassA; a.vy -= impY * invMassA;
    b2.vx += impX * invMassB; b2.vy += impY * invMassB;
    const impact = Math.abs(velAlongNormal);
    triggerSquish(a, -nx, -ny, impact);
    triggerSquish(b2, nx, ny, impact);
  }
  function allSettled() { return allEntities().every(e => e.vx === 0 && e.vy === 0); }

  // ---------- Round / goal flow ----------
  function onGoal(scoringTeam) {
    if (scoringTeam === 'A') scoreA++; else scoreB++;
    scoreAEl.textContent = scoreA; scoreBEl.textContent = scoreB;
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
        scoreA = 0; scoreB = 0; scoreAEl.textContent = 0; scoreBEl.textContent = 0; round = 1;
        resetPositions(); phase = 'aimA'; hideOverlay(); refreshTurnLabel();
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
    document.getElementById('nextRoundBtn').onclick = () => { resetPositions(); phase = 'aimA'; hideOverlay(); refreshTurnLabel(); };
  }

  // ---------- Textures ----------
  const grassSpeckles = [];
  const asphaltSpeckles = [];
  (function initTextures() {
    let seed = 42;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (let i = 0; i < 220; i++) grassSpeckles.push({ x: 22 + rnd() * (W - 44), y: 22 + rnd() * (H - 44), r: 1 + rnd() * 2, a: 0.02 + rnd() * 0.04 });
    for (let i = 0; i < 260; i++) asphaltSpeckles.push({ x: rnd() * W, y: rnd() * H, r: 0.6 + rnd() * 1.6, a: 0.08 + rnd() * 0.12 });
  })();

  // ---------- Render ----------
  function pitchPath() {
    const m = ARENA_MARGIN, r = ARENA_CORNER;
    const gy1 = H / 2 - GOAL_HALF_HEIGHT, gy2 = H / 2 + GOAL_HALF_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(m + r, m);
    ctx.lineTo(W - m - r, m);
    ctx.arcTo(W - m, m, W - m, m + r, r);
    ctx.lineTo(W - m, gy1);
    ctx.lineTo(W, gy1);
    ctx.lineTo(W, gy2);
    ctx.lineTo(W - m, gy2);
    ctx.lineTo(W - m, H - m - r);
    ctx.arcTo(W - m, H - m, W - m - r, H - m, r);
    ctx.lineTo(m + r, H - m);
    ctx.arcTo(m, H - m, m, H - m - r, r);
    ctx.lineTo(m, gy2);
    ctx.lineTo(0, gy2);
    ctx.lineTo(0, gy1);
    ctx.lineTo(m, gy1);
    ctx.arcTo(m, m, m + r, m, r);
    ctx.closePath();
  }

  function drawField() {
    ctx.clearRect(0, 0, W, H);

    const asphalt = ctx.createLinearGradient(0, 0, 0, H);
    asphalt.addColorStop(0, '#d3cdbd');
    asphalt.addColorStop(1, '#b7b0a0');
    ctx.fillStyle = asphalt;
    ctx.fillRect(0, 0, W, H);
    for (const s of asphaltSpeckles) {
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(60,55,45,${s.a})`; ctx.fill();
    }

    ctx.save();
    pitchPath(); ctx.clip();

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#a3ef74');
    grad.addColorStop(0.5, '#82df5a');
    grad.addColorStop(1, '#5cba3f');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = (i % 2 === 0) ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.045)';
      ctx.fillRect(i * (W / 10), 0, W / 10, H);
    }
    for (const s of grassSpeckles) {
      ctx.beginPath(); ctx.ellipse(s.x, s.y, s.r, s.r * 1.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(15,70,30,${s.a})`; ctx.fill();
    }

    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,40,10,0.10)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(W / 2, ARENA_MARGIN); ctx.lineTo(W / 2, H - ARENA_MARGIN); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 70, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fill();
    ctx.beginPath(); ctx.arc(ARENA_MARGIN, H / 2, 110, -0.5, 0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(W - ARENA_MARGIN, H / 2, 110, Math.PI - 0.5, Math.PI + 0.5); ctx.stroke();

    drawGoal('left'); drawGoal('right');
    ctx.restore();

    drawArenaFramePass(ARENA_MARGIN - 8, ARENA_CORNER + 4, 'rgba(6,20,10,0.30)', 13, 0.5);
    drawArenaFramePass(ARENA_MARGIN - 3, ARENA_CORNER + 1, 'rgba(6,20,10,0.22)', 7, 0.6);
    drawArenaFramePass(ARENA_MARGIN, ARENA_CORNER, '#12181a', 9, 1);
    drawArenaFramePass(ARENA_MARGIN, ARENA_CORNER, '#ffd166', 3, 1);
    drawArenaFramePass(ARENA_MARGIN + 5, ARENA_CORNER - 2, 'rgba(255,255,255,0.65)', 4, 0.9);
    drawArenaFramePass(ARENA_MARGIN + 11, ARENA_CORNER - 3, 'rgba(0,0,0,0.16)', 6, 0.5);
  }

  function drawArenaFramePass(m, r, color, width, alpha) {
    const gy1 = H / 2 - GOAL_HALF_HEIGHT, gy2 = H / 2 + GOAL_HALF_HEIGHT;
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(m, gy1);
    ctx.lineTo(m, m + r);
    ctx.arcTo(m, m, m + r, m, r);
    ctx.lineTo(W - m - r, m);
    ctx.arcTo(W - m, m, W - m, m + r, r);
    ctx.lineTo(W - m, gy1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(m, gy2);
    ctx.lineTo(m, H - m - r);
    ctx.arcTo(m, H - m, m + r, H - m, r);
    ctx.lineTo(W - m - r, H - m);
    ctx.arcTo(W - m, H - m, W - m, H - m - r, r);
    ctx.lineTo(W - m, gy2);
    ctx.stroke();
    ctx.restore();
  }

  function drawGoal(side) {
    const depth = GOAL_DEPTH;
    const yTop = H / 2 - GOAL_HALF_HEIGHT, yBot = H / 2 + GOAL_HALF_HEIGHT;
    const x0 = side === 'left' ? 0 : W - depth;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x0, yTop, depth, yBot - yTop);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
    for (let x = x0; x <= x0 + depth; x += 7) { ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke(); }
    for (let y = yTop; y <= yBot; y += 8) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + depth, y); ctx.stroke(); }
    ctx.fillStyle = '#f4f1ea'; ctx.strokeStyle = '#12181a'; ctx.lineWidth = 2;
    const postW = 6;
    ctx.fillRect(x0 - 1, yTop - postW, depth + 2, postW); ctx.strokeRect(x0 - 1, yTop - postW, depth + 2, postW);
    ctx.fillRect(x0 - 1, yBot, depth + 2, postW); ctx.strokeRect(x0 - 1, yBot, depth + 2, postW);
    const farX = side === 'left' ? x0 + depth - postW : x0;
    ctx.fillRect(farX, yTop - postW, postW, yBot - yTop + postW * 2);
    ctx.strokeRect(farX, yTop - postW, postW, yBot - yTop + postW * 2);
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
  const LIGHT_DX = 0.42, LIGHT_DY = 0.62;
  function drawShadow(e, rMul) {
    const mul = rMul || 1;
    const rx = e.r * 0.72 * mul, ry = e.r * 0.34 * mul;
    const sx = e.x + e.r * 0.55 * LIGHT_DX * mul;
    const sy = e.y + e.r * 0.55 * LIGHT_DY * mul + e.r * 0.18;
    ctx.save();
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, rx);
    grad.addColorStop(0, 'rgba(8,28,14,0.30)');
    grad.addColorStop(0.55, 'rgba(8,28,14,0.16)');
    grad.addColorStop(1, 'rgba(8,28,14,0)');
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  function drawGlob(g, color, colorDark, pattern, faded) {
    drawShadow(g);
    withSquish(g, () => {
      ctx.save();
      if (faded) ctx.globalAlpha = 0.55;
      const grad = ctx.createRadialGradient(g.x - g.r * 0.35, g.y - g.r * 0.4, g.r * 0.2, g.x, g.y, g.r);
      grad.addColorStop(0, lighten(color, 35));
      grad.addColorStop(1, colorDark);
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();

      const img = identiconImages[g.team];
      if (img) {
        const s = g.r * 1.5;
        ctx.save();
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r * 0.92, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, g.x - s / 2, g.y - s / 2, s, s);
        ctx.restore();
      } else {
        drawFallbackIdenticon(g.x, g.y, g.r * 0.62, pattern, lighten(color, 15), colorDark);
      }

      ctx.lineWidth = g.r * 0.14;
      ctx.strokeStyle = '#12181a';
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    });
  }
  function lighten(hex, amt) {
    const c = hex.replace('#', '');
    const num = parseInt(c, 16);
    let r = (num >> 16) + amt, g = ((num >> 8) & 0xff) + amt, b = (num & 0xff) + amt;
    r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
    return `rgb(${r},${g},${b})`;
  }
  function drawBall(b) {
    drawShadow(b, 1.15);
    withSquish(b, () => {
      ctx.save();
      ctx.translate(b.x, b.y); ctx.rotate(b.rot || 0);

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
    });
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

    function pass(shaftW, hLen, hWide) {
      const bx = toX - Math.cos(angle) * hLen, by = toY - Math.sin(angle) * hLen;
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(bx, by);
      ctx.lineWidth = shaftW;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(toX, toY);
      ctx.lineTo(bx + nx * hWide / 2, by + ny * hWide / 2);
      ctx.lineTo(bx - nx * hWide / 2, by - ny * hWide / 2);
      ctx.closePath();
      ctx.fill();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#12181a'; ctx.fillStyle = '#12181a';
    pass(width + 4, headLen + 2, headWide + 4);
    ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
    pass(width, headLen, headWide);
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
    drawField();
    entities.A.forEach(g => drawGlob(g, '#3fa9f5', '#1f6fa8', PATTERN_A, phase === 'aimB'));
    entities.B.forEach(g => drawGlob(g, '#f5566b', '#a83247', PATTERN_B, phase === 'aimA'));
    drawBall(entities.ball);
    if (phase === 'aimA') entities.A.forEach(drawAimArrow);
    if (phase === 'aimB') entities.B.forEach(drawAimArrow);
    drawDragPreview();
  }

  // ---------- Main loop ----------
  let settleFrames = 0;
  function loop() {
    if (phase === 'sim') {
      const result = physicsStep();
      if (result === 'goalA' || result === 'goalB') { phase = 'goal'; onGoal(result === 'goalA' ? 'A' : 'B'); }
      else if (allSettled()) {
        settleFrames++;
        if (settleFrames > 6) {
          settleFrames = 0; phase = 'aimA';
          entities.A.forEach(g => { g.used = false; g.pendingVx = 0; g.pendingVy = 0; });
          entities.B.forEach(g => { g.used = false; g.pendingVx = 0; g.pendingVy = 0; });
          refreshTurnLabel();
        }
      } else settleFrames = 0;
    }
    render();
    requestAnimationFrame(loop);
  }
  loop();
}
