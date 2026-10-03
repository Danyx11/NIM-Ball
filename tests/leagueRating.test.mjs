// Covers party/leagueRating.js — the League's whole reward model. It is pure by
// design (no `this`, no storage, no Worker API), which is exactly what makes it
// worth testing: every rule a player can feel — what a win pays, what a loss
// pays, what a forfeit costs, when the daily taper bites, when a streak bonus
// fires — is decided here and nowhere else.
//
// Run with `npm test` (node --test, built in — no test framework dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STARTING_RATING, PARTICIPATION_FULL_MATCHES_PER_DAY, PARTICIPATION_ZERO_MATCHES_PER_DAY,
  expectedScore, winLpReward, lossLpReward, participationMultiplier, participationLp,
  updateStreak, applyMatchResult, isClassicMatchConfig, rankingStatus,
} from '../party/leagueRating.js';

const T = Date.parse('2026-10-03T12:00:00Z');
const DAY = '2026-10-03';
const player = (o = {}) => ({
  address: 'X', rating: STARTING_RATING, lp: 0, matches: 0, wins: 0, losses: 0,
  streak: 0, bestStreak: 0, lastMatchDate: null, milestonesThisStreak: [],
  matchesToday: 0, matchesTodayDate: null, ...o,
});

test('expectedScore is symmetric and 0.5 for equal ratings', () => {
  assert.equal(expectedScore(100, 100), 0.5);
  assert.ok(Math.abs(expectedScore(130, 100) - 0.85) < 0.01);
  assert.ok(expectedScore(160, 100) > 0.96);
  // The two sides of a match must always sum to 1, or LP would be invented.
  for (const [a, b] of [[100, 100], [130, 90], [60, 175]]) {
    assert.ok(Math.abs(expectedScore(a, b) + expectedScore(b, a) - 1) < 1e-12);
  }
});

test('a win always pays more than a loss, at every matchup', () => {
  for (let e = 0; e <= 1.0001; e += 0.05) {
    assert.ok(winLpReward(e) > lossLpReward(e), `win must beat loss at expected=${e.toFixed(2)}`);
  }
});

test('win LP rewards the underdog and barely pays for beating a weak opponent', () => {
  assert.equal(winLpReward(0.5), 20);          // even matchup, the baseline
  assert.equal(winLpReward(0), 30);            // beat someone far stronger
  assert.equal(winLpReward(1), 10);            // beat someone far weaker: minimum
  // Monotonic: the better you were expected to do, the less a win is worth.
  let prev = Infinity;
  for (let e = 0; e <= 1.0001; e += 0.1) { assert.ok(winLpReward(e) <= prev); prev = winLpReward(e); }
});

test('participation LP is capped at 3 and never negative', () => {
  assert.equal(lossLpReward(0.5), 1);          // even matchup
  assert.equal(lossLpReward(0), 3);            // heavy underdog: the ceiling
  assert.equal(lossLpReward(0.7), 0);          // favourite who lost: nothing
  assert.equal(lossLpReward(1), 0);
  for (let e = 0; e <= 1.0001; e += 0.05) {
    const lp = lossLpReward(e);
    assert.ok(lp >= 0 && lp <= 3, `loss LP out of [0,3] at expected=${e.toFixed(2)}: ${lp}`);
  }
});

test('the per-day taper is full x3, then half, then zero', () => {
  assert.equal(participationMultiplier(0), 1);  // 1st match of the day
  assert.equal(participationMultiplier(1), 1);
  assert.equal(participationMultiplier(2), 1);  // 3rd
  assert.equal(participationMultiplier(3), 0.5); // 4th
  assert.equal(participationMultiplier(4), 0);  // 5th
  assert.equal(participationMultiplier(99), 0);
  // Guard the named thresholds themselves, not just today's numbers.
  assert.equal(participationMultiplier(PARTICIPATION_FULL_MATCHES_PER_DAY - 1), 1);
  assert.equal(participationMultiplier(PARTICIPATION_ZERO_MATCHES_PER_DAY - 1), 0);
});

test('a forfeit pays the loser nothing, whatever the matchup or the day', () => {
  for (const e of [0, 0.3, 0.5, 0.9]) {
    for (const played of [0, 1, 5]) {
      assert.equal(participationLp(e, played, true), 0);
    }
  }
});

test('applyMatchResult: the winner is paid identically whether or not it was a forfeit', () => {
  const real = applyMatchResult({ playerA: player({ address: 'W' }), playerB: player({ address: 'L' }), winner: 'A', timestampMs: T });
  const ff = applyMatchResult({ playerA: player({ address: 'W' }), playerB: player({ address: 'L' }), winner: 'A', timestampMs: T, forfeit: true });
  assert.equal(real.A.lpAwarded, ff.A.lpAwarded);
  assert.ok(ff.A.lpAwarded > 0);
  // ...but the forfeiting side banks nothing, while still taking the loss and
  // the rating hit: a match they chose not to finish is still a match they lost.
  assert.ok(real.B.lpAwarded > 0);
  assert.equal(ff.B.lpAwarded, 0);
  assert.equal(ff.B.losses, 1);
  assert.equal(ff.B.matches, 1);
  assert.ok(ff.B.ratingAfter < ff.B.ratingBefore);
});

test('applyMatchResult: LP never decreases and the two sides never both win', () => {
  const r = applyMatchResult({ playerA: player({ address: 'A', lp: 40 }), playerB: player({ address: 'B', lp: 7 }), winner: 'B', timestampMs: T });
  assert.ok(r.A.lp >= 40 && r.B.lp >= 7);
  assert.equal(r.A.wins + r.B.wins, 1);
  assert.equal(r.A.losses + r.B.losses, 1);
  // Rating is zero-sum around the expected score: one side's gain is the
  // other's loss, so the pool can't inflate.
  const drift = (r.A.ratingAfter - r.A.ratingBefore) + (r.B.ratingAfter - r.B.ratingBefore);
  assert.ok(Math.abs(drift) < 1e-9, `rating is not zero-sum: ${drift}`);
});

test('applyMatchResult: a day of losses stops paying from the 5th match', () => {
  let loser = player({ address: 'L', lastMatchDate: DAY });
  const paid = [];
  for (let n = 0; n < 6; n++) {
    const r = applyMatchResult({ playerA: player({ address: 'W' }), playerB: loser, winner: 'A', timestampMs: T });
    paid.push(r.B.lpAwarded);
    loser = { ...loser, ...r.B };
  }
  assert.equal(paid[4], 0, '5th loss of the day must pay nothing');
  assert.equal(paid[5], 0, '6th too');
  assert.ok(paid[0] > 0, 'the first loss of the day must still pay');
  assert.equal(loser.matchesToday, 6);
  assert.equal(loser.matchesTodayDate, DAY);
});

test('the taper resets the next day, and never applies to a win', () => {
  const next = applyMatchResult({
    playerA: player({ address: 'W' }),
    playerB: player({ address: 'L', matchesToday: 9, matchesTodayDate: DAY, lastMatchDate: DAY }),
    winner: 'A', timestampMs: Date.parse('2026-10-04T12:00:00Z'),
  });
  assert.ok(next.B.lpAwarded > 0, 'a new day must pay participation again');
  assert.equal(next.B.matchesToday, 1);

  const tenth = applyMatchResult({
    playerA: player({ address: 'W', matchesToday: 9, matchesTodayDate: DAY }),
    playerB: player({ address: 'L' }), winner: 'A', timestampMs: T,
  });
  assert.equal(tenth.A.lpAwarded, winLpReward(0.5), '10th win of the day still pays full');
});

test('a record from before matchesToday existed reads as "nothing played today"', () => {
  const legacy = { address: 'L', rating: 100, lp: 5, matches: 3, wins: 1, losses: 2, streak: 1, bestStreak: 1, lastMatchDate: DAY, milestonesThisStreak: [] };
  const r = applyMatchResult({ playerA: player({ address: 'W' }), playerB: legacy, winner: 'A', timestampMs: T });
  assert.ok(r.B.lpAwarded > 0, 'no migration needed: undefined counters must not zero the reward');
  assert.equal(r.B.matchesToday, 1);
});

test('streaks: consecutive days build, a gap resets, same day does not double-count', () => {
  const base = { streak: 2, bestStreak: 5, lastMatchDate: '2026-10-02', milestonesThisStreak: [] };
  assert.equal(updateStreak(base, '2026-10-03').streak, 3);
  assert.equal(updateStreak(base, '2026-10-05').streak, 1, 'a 2-day gap restarts at 1');
  const same = updateStreak({ ...base, lastMatchDate: DAY }, DAY);
  assert.equal(same.streak, 2, 'a second match the same day must not bump the streak');
  assert.equal(same.bonusLp, 0);
  // bestStreak only ever grows.
  assert.equal(updateStreak(base, '2026-10-03').bestStreak, 5);
});

test('streak milestones pay once per run, and can be re-earned after a break', () => {
  const at2 = { streak: 2, bestStreak: 2, lastMatchDate: '2026-10-02', milestonesThisStreak: [] };
  const hit3 = updateStreak(at2, DAY);
  assert.equal(hit3.bonusLp, 3, 'day 3 pays its milestone');
  assert.ok(hit3.milestonesThisStreak.includes(3));
  // Same milestone must not pay again inside the same run.
  const day4 = updateStreak({ ...hit3, lastMatchDate: DAY }, '2026-10-04');
  assert.equal(day4.bonusLp, 0);
  // After a break the set is cleared, so the run can earn it again.
  const afterBreak = updateStreak({ ...day4, lastMatchDate: '2026-10-04' }, '2026-10-20');
  assert.deepEqual(afterBreak.milestonesThisStreak, []);
});

test('isClassicMatchConfig accepts only the exact preset', () => {
  const classic = { skin: 'summer', stonesPerTeam: 3, pointsToWin: 2, turnTime: 30, curlingCycles: 2 };
  assert.equal(isClassicMatchConfig(classic), true);
  assert.equal(isClassicMatchConfig({ ...classic, stonesPerTeam: 2 }), false);
  assert.equal(isClassicMatchConfig({ ...classic, skin: 'winter' }), false);
  assert.equal(isClassicMatchConfig(null), false);
  assert.equal(isClassicMatchConfig(undefined), false);
  assert.equal(isClassicMatchConfig('classic'), false);
  // Extra keys are tolerated; missing ones are not.
  assert.equal(isClassicMatchConfig({ ...classic, extra: 1 }), true);
  const { turnTime: _turnTime, ...incomplete } = classic;
  assert.equal(isClassicMatchConfig(incomplete), false);
});

test('rankingStatus flips to ranked at the threshold', () => {
  assert.equal(rankingStatus(0), 'provisional');
  assert.equal(rankingStatus(2), 'provisional');
  assert.equal(rankingStatus(3), 'ranked');
  assert.equal(rankingStatus(50), 'ranked');
});
