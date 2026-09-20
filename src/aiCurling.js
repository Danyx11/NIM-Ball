// Heuristic (non-ML) opponent for "Solo vs IA" in the Pure Curling vibe —
// the curling counterpart of src/ai.js (which stays hockey-only and is not
// touched by any of this). Same contract as the hockey one: a pure function,
// no DOM/canvas/engine access; src/game.js's prepareAiShots() hands it a
// snapshot of the just-SETTLED board (never the human's in-progress drag —
// both teams shoot simultaneously and blind) and gets back one {vx, vy} per
// AI stone, the exact shape a human drag produces, so the shots flow through
// the same launch/physics path as a human's.
//
// How it decides (a tiny search, not a script of if/else rules):
//   1. A private mini-simulator (below) replays game.js's physicsStep() for
//      stones only — same friction/stop-threshold/wall/elastic-collision
//      model, same "opposing-team contact costs both stones a hit, dead at
//      STONE_MAX_HITS" rule. All the tuned constants are passed in by
//      game.js (never duplicated here), so re-tuning the engine can't
//      silently desync the AI.
//   2. For each AI stone it generates candidate shots — hold, draws to a
//      handful of spots around the button, and takeouts (several cut angles
//      x several speeds) aimed at each opponent stone — simulates each one
//      TOGETHER with the AI's other planned shots (they all fly at once, so
//      a stone can't plan through its own teammate's path), and scores the
//      resulting board: closest-to-center lead (the real point rule) weighted
//      up on the LAST manche of a point, general closeness, and stone HP.
//   3. The best few candidates are re-scored under a handful of noisy
//      perturbations (robust choice: a takeout that only works if
//      perfect loses to one that survives a small miss). Two passes so every
//      stone ends up planned around every other stone's final plan.
//   4. Only the chosen shot gets the real noise (aimNoise/powerNoise) — the
//      single difficulty knob, same spirit as hockey's DEFAULT_AI_CONFIG.
// The opponent is modeled as standing still (blind, simultaneous shots): the
// AI never sees what the human is about to do this manche.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export const DEFAULT_CURLING_AI_CONFIG = {
  aimNoise: 0.04,      // radians, uniform +/- on every shot's angle (capped by distance, see MAX_AIM_DEVIATION_PX)
  powerNoise: 0.08,    // fraction, uniform +/- on every shot's speed — matters more than angle for draws (stopping distance is ~linear in speed)
  takeoutBias: 1.0,    // weight on damaging/removing opponent stones vs. only improving its own position
  robustSamples: 5,    // noisy re-simulations per finalist candidate (see step 3 above)
};

// Same idea as ai.js's constant of the same name: a fixed angular noise turns
// into a much bigger sideways miss on a long shot than a short one, so cap the
// noise angle such that its worst-case sideways miss stays about this many px.
const MAX_AIM_DEVIATION_PX = 32;

const MAX_SIM_TICKS = 700;      // generous cap, real shots settle in well under this
const FINALISTS = 6;
const PASSES = 2;

// ---------- Mini-simulator (stones only, mirrors game.js physicsStep) ----------

// Distance a stone launched at `v0` glides before stopping, per the engine's
// own per-frame loop: move by v, then v *= FRICTION, stopping for good once
// speed drops under STOP_THRESHOLD (that last move still happens).
export function stoppingDistance(v0, P) {
  let v = v0, d = 0;
  for (let i = 0; i < MAX_SIM_TICKS; i++) {
    d += v;
    v *= P.FRICTION;
    if (v < P.STOP_THRESHOLD) break;
  }
  return d;
}
// Inverse of stoppingDistance() (monotonic), by bisection — the accurate
// speed->stopping-distance mapping a "draw to X" shot needs.
export function speedForDistance(dist, P) {
  let lo = 0, hi = P.MAX_SPEED;
  if (stoppingDistance(hi, P) <= dist) return hi;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (stoppingDistance(mid, P) < dist) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Port of game.js resolveCollision for two equal-mass stones (curling never
// has a ball), incl. the reconstructed first-contact normal on grazing hits.
function collide(a, b, P) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const minD = P.STONE_R * 2;
  if (d === 0 || d >= minD) return;
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  let nx = dx / d, ny = dy / d;
  const A = rvx * rvx + rvy * rvy;
  if (A > 1e-6) {
    const pv = dx * rvx + dy * rvy;
    const C = d * d - minD * minD;
    const D = pv * pv - A * C;
    if (D >= 0) {
      const t = clamp((pv + Math.sqrt(D)) / A, 0, 1);
      const cdx = dx - rvx * t, cdy = dy - rvy * t;
      const cd = Math.sqrt(cdx * cdx + cdy * cdy);
      if (cd > 1e-6) { nx = cdx / cd; ny = cdy / cd; }
    }
  }
  const overlap = (minD - d) / 2;
  a.x -= nx * overlap; a.y -= ny * overlap;
  b.x += nx * overlap; b.y += ny * overlap;
  const van = rvx * nx + rvy * ny;
  if (van > 0) return;
  const j = -(1 + P.BODY_RESTITUTION) * van / 2; // equal masses
  a.vx -= j * nx; a.vy -= j * ny;
  b.vx += j * nx; b.vy += j * ny;
  if (a.team !== b.team) { hit(a, P); hit(b, P); }
}
function hit(g, P) {
  if (g.dead || g.cool > 0) return;
  g.cool = P.HIT_COOLDOWN_FRAMES;
  g.hits = Math.min(P.STONE_MAX_HITS, g.hits + 1);
  if (g.hits >= P.STONE_MAX_HITS) g.dead = true;
}

// Runs `list` (stone objects with x,y,vx,vy,team,hits,dead,cool) to rest.
// Walls are the flat playfield rectangle (bank shots are never generated, so
// the real octagon corners / goal recesses only matter for stray stones).
function simulate(list, P) {
  const x0 = P.FX0 + P.STONE_R, x1 = P.FX1 - P.STONE_R, y0 = P.FY0 + P.STONE_R, y1 = P.FY1 - P.STONE_R;
  for (let t = 0; t < MAX_SIM_TICKS; t++) {
    let moving = false;
    for (const e of list) {
      e.x += e.vx; e.y += e.vy;
      e.vx *= P.FRICTION; e.vy *= P.FRICTION;
      const s = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      if (s < P.STOP_THRESHOLD) { e.vx = 0; e.vy = 0; }
      else if (s > P.MAX_SPEED) { const k = P.MAX_SPEED / s; e.vx *= k; e.vy *= k; }
      if (e.cool > 0) e.cool--;
      if (e.x < x0) { e.x = x0; e.vx = -e.vx * P.WALL_RESTITUTION; }
      else if (e.x > x1) { e.x = x1; e.vx = -e.vx * P.WALL_RESTITUTION; }
      if (e.y < y0) { e.y = y0; e.vy = -e.vy * P.WALL_RESTITUTION; }
      else if (e.y > y1) { e.y = y1; e.vy = -e.vy * P.WALL_RESTITUTION; }
    }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) collide(list[i], list[j], P);
    for (const e of list) {
      const s = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
      if (s > P.MAX_SPEED) { const k = P.MAX_SPEED / s; e.vx *= k; e.vy *= k; }
      if (s > 0) moving = true;
    }
    if (!moving) break;
  }
}

// ---------- Board evaluation ----------

// Higher = better for `aiTeam`. Mirrors resolveCurlingPoint (closest alive
// stone to the button wins the point), softened into a gradient so the search
// has something to climb before the final manche, plus HP awareness.
function evaluateBoard(list, aiTeam, ctx) {
  const { P, lastManche, cfg } = ctx;
  const R = P.STONE_R;
  let dAi = Infinity, dOpp = Infinity, score = 0;
  let aiAlive = 0, oppAlive = 0;
  for (const e of list) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - P.CENTER_X, e.y - P.CY);
    const close = 30 / (1 + (d / (2.5 * R)) * (d / (2.5 * R)));
    if (e.team === aiTeam) {
      aiAlive++; if (d < dAi) dAi = d;
      score += close - e.hits * 4 - (e.hits >= P.STONE_MAX_HITS - 1 ? 8 : 0);
    } else {
      oppAlive++; if (d < dOpp) dOpp = d;
      score -= close - e.hits * 2 * cfg.takeoutBias;
    }
  }
  if (!aiAlive) return score - 1e4;   // wipeout: the opponent scores on the spot
  if (!oppAlive) return score + 1e4;  // same for us (still graded by closeness, never a flat tie)
  const gap = Math.min(1, Math.abs(dOpp - dAi) / (4 * R));
  const leadW = lastManche ? 90 : 45;
  score += (dAi < dOpp ? 1 : -1) * (1 + gap) * leadW;
  return score;
}

// ---------- Candidate shots ----------

function unit(dx, dy) { const l = Math.hypot(dx, dy) || 1; return { ux: dx / l, uy: dy / l }; }

function generateCandidates(stone, opponents, P) {
  const cands = [{ vx: 0, vy: 0, kind: 'hold' }];
  const R = P.STONE_R;
  const push = (dir, speed, kind) => cands.push({ vx: dir.ux * speed, vy: dir.uy * speed, kind });
  // Draws: land the stone on the button and a couple of rings around it, so
  // a crowded button still leaves a good open spot to aim at.
  const targets = [{ x: P.CENTER_X, y: P.CY }];
  for (const ring of [2.1 * R, 4.2 * R]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      targets.push({ x: P.CENTER_X + Math.cos(a) * ring, y: P.CY + Math.sin(a) * ring });
    }
  }
  for (const t of targets) {
    const d = Math.hypot(t.x - stone.x, t.y - stone.y);
    if (d < 1) continue;
    push(unit(t.x - stone.x, t.y - stone.y), speedForDistance(d, P), 'draw');
  }
  // Takeouts: aim at each opponent stone with a few cut angles (lateral
  // offset of the aim line) and speeds — thin cuts send the target off at a
  // sharp angle, full-face hits transfer everything.
  for (const o of opponents) {
    const dx = o.x - stone.x, dy = o.y - stone.y;
    if (Math.hypot(dx, dy) < 2 * R) continue;
    const base = unit(dx, dy);
    for (const lat of [-1.4, -0.7, 0, 0.7, 1.4]) {
      const dir = unit(dx - base.uy * lat * R, dy + base.ux * lat * R);
      for (const f of [0.3, 0.45, 0.6, 0.8, 1]) push(dir, f * P.MAX_SPEED, 'takeout');
    }
  }
  return cands;
}

function perturb(shot, cfg, P) {
  const speed = Math.hypot(shot.vx, shot.vy);
  if (speed === 0) return shot;
  const travel = Math.max(1, stoppingDistance(speed, P));
  const noise = Math.min(cfg.aimNoise, MAX_AIM_DEVIATION_PX / travel);
  const ang = Math.atan2(shot.vy, shot.vx) + (Math.random() * 2 - 1) * noise;
  const sp = Math.min(P.MAX_SPEED, speed * (1 + (Math.random() * 2 - 1) * cfg.powerNoise));
  return { vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, kind: shot.kind };
}

// ---------- Entry point ----------

// aiStones/opponentStones: [{ id, x, y, hits }] (alive only, settled).
// bounds: FX0/FX1/FY0/FY1, CENTER_X, CY, STONE_R, MAX_DRAG, POWER_SCALE plus
// the engine constants the simulator mirrors (FRICTION, STOP_THRESHOLD,
// MAX_SPEED, WALL_RESTITUTION, BODY_RESTITUTION, STONE_MAX_HITS,
// HIT_COOLDOWN_FRAMES). manchesLeft: manches remaining in this point,
// including the one being decided (1 = last, the one that settles the point).
export function computeCurlingAiShots({ aiTeam, aiStones, opponentStones, bounds, config, manchesLeft = 1 }) {
  const cfg = { ...DEFAULT_CURLING_AI_CONFIG, ...config };
  const P = bounds;
  const ctx = { P, cfg, lastManche: manchesLeft <= 1 };
  const oppTeam = aiTeam === 'A' ? 'B' : 'A';
  const maxSpeed = P.MAX_DRAG * P.POWER_SCALE;

  const plan = {};
  for (const s of aiStones) plan[s.id] = { vx: 0, vy: 0, kind: 'hold' };

  // Stones are simulated in team-A-first order like the engine's own list.
  const build = (overrideId, override) => {
    const mk = (s, team, v) => ({ x: s.x, y: s.y, vx: v ? v.vx : 0, vy: v ? v.vy : 0, team, hits: s.hits || 0, dead: false, cool: 0 });
    const ai = aiStones.map(s => mk(s, aiTeam, s.id === overrideId ? override : plan[s.id]));
    const opp = opponentStones.map(s => mk(s, oppTeam, null));
    return aiTeam === 'A' ? [...ai, ...opp] : [...opp, ...ai];
  };
  const evalShot = (id, shot) => {
    const list = build(id, shot);
    simulate(list, P);
    return evaluateBoard(list, aiTeam, ctx);
  };

  // Decide the stones closest to the button first: one already sitting well
  // simply holds, and the others then plan around it.
  const order = [...aiStones].sort((a, b) =>
    Math.hypot(a.x - P.CENTER_X, a.y - P.CY) - Math.hypot(b.x - P.CENTER_X, b.y - P.CY));

  for (let pass = 0; pass < PASSES; pass++) {
    for (const stone of order) {
      const cands = generateCandidates(stone, opponentStones, P);
      const scored = cands.map(c => ({ c, v: evalShot(stone.id, c) - Math.hypot(c.vx, c.vy) * 0.05 }));
      scored.sort((a, b) => b.v - a.v);
      let best = scored[0].c, bestV = -Infinity;
      for (const { c, v } of scored.slice(0, FINALISTS)) {
        if (c.kind === 'hold') { if (v > bestV) { bestV = v; best = c; } continue; }
        let sum = v;
        for (let k = 0; k < cfg.robustSamples; k++) sum += evalShot(stone.id, perturb(c, cfg, P)) - Math.hypot(c.vx, c.vy) * 0.05;
        const mean = sum / (cfg.robustSamples + 1);
        if (mean > bestV) { bestV = mean; best = c; }
      }
      plan[stone.id] = best;
    }
  }

  const shots = {};
  for (const s of aiStones) {
    const shot = perturb(plan[s.id], cfg, P);
    const sp = Math.hypot(shot.vx, shot.vy);
    const k = sp > maxSpeed ? maxSpeed / sp : 1;
    shots[s.id] = { vx: shot.vx * k, vy: shot.vy * k };
  }
  return shots;
}
