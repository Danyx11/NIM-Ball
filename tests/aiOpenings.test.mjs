// Covers the opening-plan variety added to the hockey AI (src/ai.js).
//
// A point always starts from the identical rack and the planner is
// deterministic given a board, so the AI used to open every point the same way;
// aimNoise moved the trajectory but never the intention. Two properties are
// worth protecting here:
//   1. every plan still produces a legal, sane shot and still contests the ball
//      — variety must never become self-sabotage;
//   2. passing no plan reproduces the original behaviour, which is what makes
//      this safe to ship.
//
// Pure Curling is deliberately absent: its planner is a simulate-and-score
// search that converges on the same opening whatever menu or ordering it is
// given (measured — see the note in game.js), so it was left untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAiShots, AI_OPENING_PLANS } from '../src/ai.js';

// Mirrors the real arena's logical space (see game.js's FX0/FY0/GY0/...).
const B = {
  FX0: 1086, FX1: 2262, FY0: 626, FY1: 1274, GY0: 870, GY1: 1030,
  CY: 950, GOAL_HALF_HEIGHT: 80,
  MAX_DRAG: 260, POWER_SCALE: 0.036, STONE_R: 34, BALL_R: 22,
};
const MAX_SPEED = B.MAX_DRAG * B.POWER_SCALE;
const CENTER_X = (B.FX0 + B.FX1) / 2;

// Team B shoots from the right, its own goal is FX1; the opening rack and a
// dead-centre ball, exactly as resetPositions() leaves them.
const aiStones = [0, 1, 2].map((i) => ({ id: 'B' + i, x: 2050, y: 820 + i * 130 }));
const oppStones = [0, 1, 2].map((i) => ({ id: 'A' + i, x: 1300, y: 820 + i * 130 }));
const ball = { x: CENTER_X, y: B.CY };

const shoot = (openingPlan) => computeAiShots({
  aiTeam: 'B', aiStones, opponentStones: oppStones, ball, bounds: B, openingPlan,
});
const speed = (s) => Math.hypot(s.vx, s.vy);
const sampleSpeeds = (plan, runs = 150) => {
  const mins = [], maxs = [];
  for (let r = 0; r < runs; r++) {
    const sh = shoot(plan);
    const sp = aiStones.map((g) => speed(sh[g.id]));
    mins.push(Math.min(...sp)); maxs.push(Math.max(...sp));
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { min: avg(mins), max: avg(maxs) };
};

test('every plan gives every stone a legal shot', () => {
  for (const plan of [...AI_OPENING_PLANS, null]) {
    for (let r = 0; r < 40; r++) {
      const shots = shoot(plan);
      assert.equal(Object.keys(shots).length, aiStones.length, `plan=${plan}: a stone got no shot`);
      for (const [id, s] of Object.entries(shots)) {
        assert.ok(Number.isFinite(s.vx) && Number.isFinite(s.vy), `${plan}/${id}: non-finite`);
        assert.ok(speed(s) <= MAX_SPEED + 1e-9,
          `${plan}/${id}: ${speed(s).toFixed(3)} exceeds what a human drag can produce (${MAX_SPEED.toFixed(3)})`);
      }
    }
  }
});

test('no plan ever leaves the ball uncontested', () => {
  // The guard against "variety" turning into throwing the point away: whatever
  // the plan, at least one stone must still be aimed at the ball.
  for (const plan of AI_OPENING_PLANS) {
    for (let r = 0; r < 40; r++) {
      const shots = shoot(plan);
      const contested = aiStones.some((g) => {
        const s = shots[g.id];
        const toBall = Math.atan2(ball.y - g.y, ball.x - g.x);
        const aim = Math.atan2(s.vy, s.vx);
        const off = Math.abs(((aim - toBall + Math.PI) % (Math.PI * 2)) - Math.PI);
        return off < 0.5; // within ~29 degrees
      });
      assert.ok(contested, `plan=${plan}: nobody went for the ball`);
    }
  }
});

test("'hold' holds a stone back, and that is visible in the shot speeds", () => {
  // The safety stone aims at a point short of the ball, so it needs less power
  // than any rushing stone — the slowest shot of the set drops measurably.
  const rush = sampleSpeeds('rush'), hold = sampleSpeeds('hold');
  assert.ok(hold.min < rush.min - 0.2,
    `'hold' should produce a noticeably softer shot than 'rush' (${hold.min.toFixed(2)} vs ${rush.min.toFixed(2)})`);
});

test("'push' sends a stone long, and that is visible too", () => {
  // The forward stone aims past the ball toward the opponent's end, so the
  // hardest shot of the set rises.
  const rush = sampleSpeeds('rush'), push = sampleSpeeds('push');
  assert.ok(push.max > rush.max + 0.5,
    `'push' should produce a noticeably harder shot than 'rush' (${push.max.toFixed(2)} vs ${rush.max.toFixed(2)})`);
});

test('the three plans are distinguishable from one another', () => {
  const [rush, hold, push] = ['rush', 'hold', 'push'].map((p) => sampleSpeeds(p));
  assert.ok(hold.min < push.min - 0.2, 'hold and push must not collapse into each other');
  assert.ok(push.max > hold.max + 0.5, 'hold and push must not collapse into each other');
  assert.ok(Math.abs(rush.min - rush.max) < 0.5, "'rush' should send everyone at a similar pace");
});

test('omitting the plan reproduces the original behaviour', () => {
  // Not a byte comparison (aim noise is random) but a distribution one: the
  // default path must be statistically indistinguishable from 'rush', because
  // 'rush' IS what this function did before plans existed. This is the property
  // that makes the change safe for every caller that knows nothing about plans.
  const none = sampleSpeeds(null, 300), rush = sampleSpeeds('rush', 300);
  assert.ok(Math.abs(none.min - rush.min) < 0.15, `default min ${none.min.toFixed(3)} vs rush ${rush.min.toFixed(3)}`);
  assert.ok(Math.abs(none.max - rush.max) < 0.15, `default max ${none.max.toFixed(3)} vs rush ${rush.max.toFixed(3)}`);
});
