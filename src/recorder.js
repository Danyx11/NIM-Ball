// Records a live match's shots as it's played, grouped into points (see
// CLAUDE.md vocabulary: manche < point < match) so the ticket can offer a
// replay QR per point and the Replay mode can reassemble a match from
// however many of those points a player has. Inert until the game calls
// into it — replay playback itself never touches this module.

let points = [];
let currentManches = [];

export function reset() {
  points = [];
  currentManches = [];
}

export function recordManche({ stonesA, stonesB, sweepA, sweepB }) {
  currentManches.push({
    stonesA: stonesA.map((s) => ({ vx: s.vx, vy: s.vy, used: !!s.used })),
    stonesB: stonesB.map((s) => ({ vx: s.vx, vy: s.vy, used: !!s.used })),
    sweepA: sweepA ? { x: sweepA.x, y: sweepA.y, r: sweepA.r } : null,
    sweepB: sweepB ? { x: sweepB.x, y: sweepB.y, r: sweepB.r } : null,
  });
}

export function finishPoint(scoringTeam, isWipeout) {
  points.push({ index: points.length, scoringTeam, isWipeout, manches: currentManches });
  currentManches = [];
}

export function getPoints() {
  return points;
}
