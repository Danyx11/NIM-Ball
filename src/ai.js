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

// A fixed angular noise applied equally at any range turns into a much
// bigger sideways miss on a long cross-field shot than on a short one (miss
// distance grows with target distance) — long shots whiffed the ball
// entirely far more often than close ones, for no reason a player would
// find fair. Capping the noise angle so its worst-case sideways miss stays
// within this many pixels keeps that miss distance roughly consistent
// regardless of range, only really reducing noise on the longer shots.
const MAX_AIM_DEVIATION_PX = 40;

// Unit direction from `from` toward `to`, perturbed by up to +/- aimNoise
// radians (see MAX_AIM_DEVIATION_PX above for how that's capped by
// distance) — every shot (offense or defense) draws from the same noise
// budget so difficulty tuning stays in one config field.
function aimedDirection(from, to, aimNoise) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const travelDist = Math.hypot(dx, dy) || 1;
  const effectiveNoise = Math.min(aimNoise, MAX_AIM_DEVIATION_PX / travelDist);
  const angle = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * effectiveNoise;
  return { ux: Math.cos(angle), uy: Math.sin(angle) };
}

// powerFrac in [0,1] maps onto the exact same MAX_DRAG/POWER_SCALE range a
// human's own full-strength drag would produce — clamped here so the AI can
// never exceed (or go negative on) a valid human shot's magnitude.
function shotFromDirection(dir, powerFrac, bounds) {
  const speed = clamp(powerFrac, 0, 1) * bounds.MAX_DRAG * bounds.POWER_SCALE;
  return { vx: dir.ux * speed, vy: dir.uy * speed };
}

// Scales power to the distance a shot actually needs to travel, instead of a
// flat random pull within powerRange regardless of target distance — a close
// target no longer risks an overpowered ricochet, a far one no longer risks
// dying short of it. powerRange still sets the band (a lower/tighter band is
// a real difficulty knob); distance only decides where within that band a
// given shot lands.
function powerForDistance(travelDist, cfg, bounds) {
  const fieldSpan = Math.abs(bounds.FX1 - bounds.FX0);
  const distFrac = clamp(travelDist / (fieldSpan * 0.6), 0, 1); // 0.6*field ~= a solid, not-quite-full-power shot
  const [lo, hi] = cfg.powerRange;
  return clamp(lo + distFrac * (hi - lo), lo * 0.4, 1);
}

export const DEFAULT_AI_CONFIG = {
  aimNoise: 0.15,           // radians of random perturbation applied to every shot's angle
  powerRange: [0.5, 0.9],   // fraction of max drag strength a shot's power is scaled within (see powerForDistance)
  reactionDelay: [500, 1500], // ms, a single "thinking" pause added before the round launches (see game.js onValidate) — purely a feel beat, the AI never needs real wall-clock time to compute
  defenseThreshold: 0.4,    // distance to the AI's own goal (ball or an opponent stone), as a fraction of field width, that triggers defensive behavior
  criticalSaveThreshold: 0.15, // tighter distance-to-own-goal fraction at which the threat is close enough to concede outright — the defensive shot aims at the real target even inside the crease safety zone (see keepOutOfOwnGoalZone), since missing the target to dodge it is worse than the self-risk
};

// A threat is "already covered" once one of the AI's own stones sits on its
// direct line to the goal — no real collision margin needed here (this is a
// coarse "does this already look safe" check, not an aim calculation).
const THREAT_CLEAR_RADIUS_FACTOR = 2;

// Stones close enough to the ball (in stone radii) get a direct clearance
// shot instead of a repositioning one — see pickDefensiveShot.
const CLEARANCE_RANGE = 4;
// Repositioning target sits this fraction of the way from the AI's own goal
// toward the ball — closer to the goal than to the ball, so the blocking
// stone lands between the threat and the net rather than on top of the ball.
const BLOCK_POINT_FRACTION = 0.35;

// "Ghost ball" billiards aim: to send `ball` toward `target`, a striking body
// must arrive at the point on the ball's surface facing away from that
// target — i.e. the ball's own center, pushed back along the target->ball
// line by the sum of both radii. Aiming a stone at THIS point (rather than at
// the ball's center, and especially rather than at the goal itself) is what
// actually lines a shot up to send the ball where intended.
function ghostBallContactPoint(ball, target, combinedRadius) {
  const dx = ball.x - target.x, dy = ball.y - target.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: ball.x + (dx / d) * combinedRadius, y: ball.y + (dy / d) * combinedRadius };
}

// Smallest t in (0, maxDist] where the straight path from `from` to `to`
// first comes within `radius` of `blocker` — null if it never does before
// reaching `to`. Same idea as game.js's own predictive-laser cascade, kept
// self-contained here since ai.js has no access to game.js's internals.
function raySegmentHitsCircle(from, to, blocker, radius, maxDist) {
  const ux = (to.x - from.x) / maxDist, uy = (to.y - from.y) / maxDist;
  const fx = from.x - blocker.x, fy = from.y - blocker.y;
  const b = fx * ux + fy * uy;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return 0; // starting point itself is already inside — treat as blocked
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return (t >= 0 && t <= maxDist) ? t : null;
}
// True once one of `ownStones` already sits on the straight line between
// `entity` and `ownGoal` — a ball or opponent stone camped near the goal
// isn't actually dangerous yet if it's already screened off.
function isThreatCovered(entity, ownGoal, ownStones, clearRadius) {
  const total = dist(entity, ownGoal) || 1;
  return ownStones.some(bl => raySegmentHitsCircle(entity, ownGoal, bl, clearRadius, total) !== null);
}

// A strip in front of the AI's own goal mouth that no aim target should ever
// land inside — a shot doesn't stop exactly at its target, it glides on
// friction, so a target sitting right against (or past) the AI's own goal
// line can send the stone straight through its own crease for nothing, the
// way a too-close "block point" did in practice. Only matters within the
// goal's own y-range (GOAL_HALF_HEIGHT) — outside that band the wall is
// there, not open net, so no danger to push away from.
const OWN_GOAL_SAFE_MARGIN = 1.5; // in stone radii, measured from the goal line
function keepOutOfOwnGoalZone(point, ownGoal, pushDir, bounds) {
  if (Math.abs(point.y - bounds.CY) >= bounds.GOAL_HALF_HEIGHT) return point;
  const safeX = ownGoal.x + pushDir * bounds.STONE_R * OWN_GOAL_SAFE_MARGIN;
  const tooClose = pushDir > 0 ? point.x < safeX : point.x > safeX;
  return tooClose ? { x: safeX, y: point.y } : point;
}

// True only if aiming from `stone` at `target` actually moves toward the
// AI's own goal along the goal-line axis — a shot that already heads away
// from (or parallel to) its own net poses no real risk of gliding into it,
// however close `target` itself happens to sit, so there's no reason to
// deflect it off its otherwise-good line (see pickOffensiveShot).
function headsTowardOwnGoal(stone, target, pushDir) {
  return (target.x - stone.x) * pushDir < 0;
}

// aiStones/opponentStones: [{ id, x, y }] (settled positions only — no
// velocity, since a fresh round only ever begins once everything has fully
// stopped). ball: { x, y }. bounds: { FX0, FX1, FY0, FY1, GY0, GY1, CY,
// GOAL_HALF_HEIGHT, MAX_DRAG, POWER_SCALE, STONE_R, BALL_R }.
// Returns { [stoneId]: { vx, vy } } — one shot per AI stone, always.
export function computeAiShots({ aiTeam, aiStones, opponentStones, ball, bounds, config }) {
  const cfg = { ...DEFAULT_AI_CONFIG, ...config };
  const ownGoal = { x: aiTeam === 'A' ? bounds.FX0 : bounds.FX1, y: bounds.CY };
  const opponentGoal = { x: aiTeam === 'A' ? bounds.FX1 : bounds.FX0, y: bounds.CY };
  // Direction to push a point away from the own goal line, along X, to keep
  // it out of the crease (see keepOutOfOwnGoalZone).
  const ownGoalPushDir = aiTeam === 'A' ? 1 : -1;

  const fieldSpan = Math.abs(bounds.FX1 - bounds.FX0);
  const threatDist = cfg.defenseThreshold * fieldSpan;
  const criticalDist = cfg.criticalSaveThreshold * fieldSpan;
  const clearRadius = bounds.STONE_R * THREAT_CLEAR_RADIUS_FACTOR;

  // The ball itself is the obvious threat, but an opponent stone camped near
  // the goal is one too (it can bank the ball in on a later shot) — pick the
  // single most urgent one: close enough to the goal AND not already covered
  // by one of our own stones sitting between it and the net (see
  // isThreatCovered) — no point pulling a stone off attack to mark something
  // that's already safe.
  let threat = null;
  for (const candidate of [ball, ...opponentStones]) {
    if (dist(candidate, ownGoal) > threatDist) continue;
    if (isThreatCovered(candidate, ownGoal, aiStones, clearRadius)) continue;
    if (!threat || dist(candidate, ownGoal) < dist(threat, ownGoal)) threat = candidate;
  }

  // At most one defender per round — the stone closest to the threat —
  // everyone else stays on offense (see design brief's priority rule).
  let defenderId = null;
  if (threat && aiStones.length > 0) {
    defenderId = aiStones.reduce((closest, g) => dist(g, threat) < dist(closest, threat) ? g : closest).id;
  }
  // Close enough to the net that this turn is genuinely make-or-break — the
  // defensive shot aims at the real target even inside the crease safety
  // zone (see pickDefensiveShot), since missing to dodge it risks conceding
  // outright, which is worse than the stone itself drifting close to the net.
  const isCriticalSave = !!threat && dist(threat, ownGoal) <= criticalDist;

  const shots = {};
  if (defenderId) {
    const defender = aiStones.find(g => g.id === defenderId);
    shots[defenderId] = pickDefensiveShot(defender, threat, ownGoal, ownGoalPushDir, isCriticalSave, cfg, bounds);
  }
  // Remaining stones stay on offense — sorted top-to-bottom (own y position)
  // and given a distinct slot each so their goal-mouth targets spread out
  // instead of clustering wherever independent randomness happens to land
  // them (see pickOffensiveShot's banding).
  const attackers = aiStones.filter(g => g.id !== defenderId).sort((a, b) => a.y - b.y);
  attackers.forEach((g, i) => {
    // Both this stone's own teammates and every opponent stone can sit in
    // the way of a cross-field shot — see pickOffensiveShot.
    const blockers = [...aiStones.filter(s => s.id !== g.id), ...opponentStones];
    const slot = { index: i, count: attackers.length };
    shots[g.id] = pickOffensiveShot(g, ball, opponentGoal, ownGoal, ownGoalPushDir, blockers, slot, cfg, bounds);
  });
  return shots;
}

// A blocker counts as "in the way" once the shot's path comes within two
// stone radii of it (a real collision), plus a small margin.
const BLOCK_CHECK_MARGIN = 1.1;
// How many blockers to steer around in sequence — a stone that clears the
// first one can occasionally clip a second lined up behind it.
const STEER_PASSES = 3;

// Rotates `to` around `from` just enough to clear `blocker` by `clearRadius`
// (plus a small margin past the tangent), keeping the same distance from
// `from` — picks whichever side (left/right of the blocker) needs the
// smaller turn. This is what actually lets a stone route around an obstacle
// regardless of how close or far it is; a fixed set of alternate aim points
// (tried first, then dropped) barely deflected the line near the stone for
// a nearby blocker, since a wide swing far away at the goal only translates
// to a tiny sideways shift close to the shooter.
function steerAround(from, to, blocker, clearRadius) {
  const toBlockerDist = dist(from, blocker);
  if (toBlockerDist <= clearRadius) return to; // blocker is basically on top of the stone — nothing sensible to steer around
  const totalDist = dist(from, to);
  const clearAngle = Math.asin(clamp(clearRadius / toBlockerDist, -1, 1)) + 0.06;
  const baseAngle = Math.atan2(to.y - from.y, to.x - from.x);
  const blockerAngle = Math.atan2(blocker.y - from.y, blocker.x - from.x);
  const side = Math.sin(baseAngle - blockerAngle) >= 0 ? 1 : -1;
  const newAngle = blockerAngle + side * clearAngle;
  return { x: from.x + Math.cos(newAngle) * totalDist, y: from.y + Math.sin(newAngle) * totalDist };
}

// Default intention: aim through the ball (ghost-ball contact point, see
// above) toward a point inside the opponent's goal mouth — then, if
// anything sits on that line, steer around it rather than firing straight
// into a blocker for no reason. A final keepOutOfOwnGoalZone pass guards
// against the rare case where dodging a blocker (or the ball just sitting
// deep in the AI's own end) swings the contact point back toward its own
// crease — but only when the shot actually still heads that way (see
// headsTowardOwnGoal): a shot already heading toward the opponent's goal is
// a legitimate scoring look and shouldn't get deflected off it just because
// the ball happened to be near the AI's own net.
//
// `slot` ({index, count}, see computeAiShots) splits the goal mouth into
// `count` even bands and aims this stone within its own band `index` — every
// stone still picking a fully independent random point in the whole mouth
// meant 2-3 attacking stones often bunched their shots on the same spot
// (or the same gap) purely by chance instead of spreading like a real team.
function pickOffensiveShot(stone, ball, opponentGoal, ownGoal, pushDir, blockers, slot, cfg, bounds) {
  const combinedRadius = bounds.STONE_R + bounds.BALL_R;
  const blockRadius = bounds.STONE_R * 2 * BLOCK_CHECK_MARGIN;
  const bandHeight = (bounds.GY1 - bounds.GY0) / slot.count;
  const bandCenter = bounds.GY0 + bandHeight * (slot.index + 0.5);
  const targetY = clamp(
    bandCenter + (Math.random() * 2 - 1) * bandHeight * 0.4,
    bounds.GY0, bounds.GY1
  );
  let contactPoint = ghostBallContactPoint(ball, { x: opponentGoal.x, y: targetY }, combinedRadius);

  for (let pass = 0; pass < STEER_PASSES; pass++) {
    const blocking = blockers.find(bl => raySegmentHitsCircle(stone, contactPoint, bl, blockRadius, dist(stone, contactPoint)) !== null);
    if (!blocking) break;
    contactPoint = steerAround(stone, contactPoint, blocking, blockRadius);
  }
  if (headsTowardOwnGoal(stone, contactPoint, pushDir)) {
    contactPoint = keepOutOfOwnGoalZone(contactPoint, ownGoal, pushDir, bounds);
  }

  const dir = aimedDirection(stone, contactPoint, cfg.aimNoise);
  return shotFromDirection(dir, powerForDistance(dist(stone, contactPoint), cfg, bounds), bounds);
}

// Defensive intention: either clear the threat away (already close enough to
// reach it — the threat may be the ball or an opponent stone, see
// computeAiShots) or reposition onto the threat-to-goal line to block it.
// Both aim at one fixed point each (the threat itself, or the block point) —
// unlike the offensive shot there's no alternate target to route around a
// blocker with, so no line-of-sight check here — but both still run through
// keepOutOfOwnGoalZone, since the threat itself (by definition close to the
// goal) or a block point 35% of the way toward it can otherwise sit right in
// the crease, and the shot's own glide can carry the stone past it into the
// net for nothing. Exception: isCritical (see computeAiShots) skips the zone
// entirely and aims at the real target — at that range, missing the target
// to dodge the crease is itself the bigger risk.
function pickDefensiveShot(stone, threat, ownGoal, pushDir, isCritical, cfg, bounds) {
  if (dist(stone, threat) <= CLEARANCE_RANGE * bounds.STONE_R) {
    const aimPoint = isCritical ? threat : keepOutOfOwnGoalZone(threat, ownGoal, pushDir, bounds);
    const dir = aimedDirection(stone, aimPoint, cfg.aimNoise);
    return shotFromDirection(dir, powerForDistance(dist(stone, aimPoint), cfg, bounds), bounds);
  }
  const rawBlockPoint = {
    x: ownGoal.x + (threat.x - ownGoal.x) * BLOCK_POINT_FRACTION,
    y: ownGoal.y + (threat.y - ownGoal.y) * BLOCK_POINT_FRACTION,
  };
  const blockPoint = isCritical ? rawBlockPoint : keepOutOfOwnGoalZone(rawBlockPoint, ownGoal, pushDir, bounds);
  const dir = aimedDirection(stone, blockPoint, cfg.aimNoise);
  return shotFromDirection(dir, powerForDistance(dist(stone, blockPoint), cfg, bounds), bounds);
}
