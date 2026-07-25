// Heuristic (non-ML) opponent for "Solo vs IA" mode — see the design brief in
// the project chat for the full spec. Pure function, no DOM/canvas/physics-
// engine access: src/game.js's prepareAiShots() hands it a snapshot of the
// board's just-settled, confirmed positions (never the human's in-progress
// drag — see the "blind resolution" rule) and gets back one shot per AI
// stone. Reusing the exact same {vx, vy} shape a human drag produces means
// the AI's shots flow through the identical launch/physics path as a human's
// (see prepareAiShots/onValidate in game.js) — no separate physics code path.

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Unit direction from `from` toward `to`, perturbed by up to +/- aimNoise
// radians — every shot (offense or defense) draws from the same noise
// budget so difficulty tuning stays in one config field.
function aimedDirection(from, to, aimNoise) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const angle = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * aimNoise;
  return { ux: Math.cos(angle), uy: Math.sin(angle) };
}

// powerFrac in [0,1] maps onto the exact same MAX_DRAG/POWER_SCALE range a
// human's own full-strength drag would produce — clamped here so the AI can
// never exceed (or go negative on) a valid human shot's magnitude.
function shotFromDirection(dir, powerFrac, bounds) {
  const speed = clamp(powerFrac, 0, 1) * bounds.MAX_DRAG * bounds.POWER_SCALE;
  return { vx: dir.ux * speed, vy: dir.uy * speed };
}

function randomPower([lo, hi]) { return lo + Math.random() * (hi - lo); }

export const DEFAULT_AI_CONFIG = {
  aimNoise: 0.15,           // radians of random perturbation applied to every shot's angle
  powerRange: [0.5, 0.9],   // fraction of max drag strength for offensive/clearance shots
  reactionDelay: [500, 1500], // ms, a single "thinking" pause added before the round launches (see game.js onValidate) — purely a feel beat, the AI never needs real wall-clock time to compute
  defenseThreshold: 0.4,    // ball-to-own-goal distance, as a fraction of field width, that triggers defensive behavior
};

// Stones close enough to the ball (in stone radii) get a direct clearance
// shot instead of a repositioning one — see pickDefensiveShot.
const CLEARANCE_RANGE = 4;
// Repositioning target sits this fraction of the way from the AI's own goal
// toward the ball — closer to the goal than to the ball, so the blocking
// stone lands between the threat and the net rather than on top of the ball.
const BLOCK_POINT_FRACTION = 0.35;

// aiStones/opponentStones: [{ id, x, y }] (settled positions only — no
// velocity, since a fresh round only ever begins once everything has fully
// stopped). ball: { x, y }. bounds: { FX0, FX1, FY0, FY1, GY0, GY1, CY,
// GOAL_HALF_HEIGHT, MAX_DRAG, POWER_SCALE, STONE_R }.
// Returns { [stoneId]: { vx, vy } } — one shot per AI stone, always.
export function computeAiShots({ aiTeam, aiStones, opponentStones, ball, bounds, config }) {
  const cfg = { ...DEFAULT_AI_CONFIG, ...config };
  const ownGoal = { x: aiTeam === 'A' ? bounds.FX0 : bounds.FX1, y: bounds.CY };
  const opponentGoal = { x: aiTeam === 'A' ? bounds.FX1 : bounds.FX0, y: bounds.CY };

  const fieldSpan = Math.abs(bounds.FX1 - bounds.FX0);
  const threatDist = cfg.defenseThreshold * fieldSpan;
  const ballIsThreat = dist(ball, ownGoal) <= threatDist;

  // At most one defender per round — the stone closest to the threat (the
  // ball) — everyone else stays on offense (see design brief's priority rule).
  let defenderId = null;
  if (ballIsThreat && aiStones.length > 0) {
    defenderId = aiStones.reduce((closest, g) => dist(g, ball) < dist(closest, ball) ? g : closest).id;
  }

  const shots = {};
  for (const g of aiStones) {
    shots[g.id] = g.id === defenderId
      ? pickDefensiveShot(g, ball, ownGoal, cfg, bounds)
      : pickOffensiveShot(g, opponentGoal, cfg, bounds);
  }
  return shots;
}

// Default intention: aim roughly at the opponent's goal mouth (a random
// point inside it, not always dead center) with noise on both angle and
// power — a deliberately simple "basic training AI" heuristic, not a
// billiards solver that aims through the ball.
function pickOffensiveShot(stone, opponentGoal, cfg, bounds) {
  const targetY = clamp(
    bounds.CY + (Math.random() * 2 - 1) * bounds.GOAL_HALF_HEIGHT * 0.7,
    bounds.GY0, bounds.GY1
  );
  const dir = aimedDirection(stone, { x: opponentGoal.x, y: targetY }, cfg.aimNoise);
  return shotFromDirection(dir, randomPower(cfg.powerRange), bounds);
}

// Defensive intention: either clear the ball away (already close enough to
// reach it) or reposition onto the ball-to-goal line to block it.
function pickDefensiveShot(stone, ball, ownGoal, cfg, bounds) {
  if (dist(stone, ball) <= CLEARANCE_RANGE * bounds.STONE_R) {
    const dir = aimedDirection(stone, ball, cfg.aimNoise);
    return shotFromDirection(dir, randomPower(cfg.powerRange), bounds);
  }
  const blockPoint = {
    x: ownGoal.x + (ball.x - ownGoal.x) * BLOCK_POINT_FRACTION,
    y: ownGoal.y + (ball.y - ownGoal.y) * BLOCK_POINT_FRACTION,
  };
  const dir = aimedDirection(stone, blockPoint, cfg.aimNoise);
  const travel = dist(stone, blockPoint);
  const powerFrac = clamp(travel / (Math.abs(bounds.FX1 - bounds.FX0) * 0.6), cfg.powerRange[0] * 0.4, 1);
  return shotFromDirection(dir, powerFrac, bounds);
}
