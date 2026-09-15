// League Beta — pure Rating/LP/streak math, kept isolated from any Durable
// Object plumbing (party/leagueSeason.js) or storage concerns so it's easy
// to read, unit-sanity-check (see scripts/league-rating-check.mjs) and
// review on its own. Nothing here touches `this`, `ctx.storage`, or any
// Worker-only API — it would run identically under plain `node`.
//
// ---- Season ----
// One fixed-name Durable Object per season (see party/leagueSeason.js) —
// CURRENT_SEASON_ID doubles as that DO's room name, so starting a future
// season is just bumping this constant: a brand new, cleanly-isolated DO
// instance with fresh storage, while the old season's instance (and all its
// history) stays exactly where it was, untouched. No in-storage season
// namespacing needed.
export const CURRENT_SEASON_ID = 'beta-2026';
export const SEASON_START_UTC = '2026-09-16';
export const SEASON_END_UTC = '2026-09-30';

// ---- Rating (hidden, Elo-style) ----
// Starting value is intentionally 100, not the traditional chess-Elo 1000 —
// see the League Beta spec: "calibrate the whole system around this scale,
// do NOT internally multiply by 10". RATING_SCALE (40, not the classic 400)
// is what keeps expectedScore's behavior identical on this compressed
// scale — a 30-point gap here plays exactly like a 300-point gap would on
// the traditional scale.
export const STARTING_RATING = 100;
export const RATING_SCALE = 40;

// K=32 (a common classic-Elo default) is 3.2% of a 1000-point starting
// scale; naively reused here it would be 32% of a single player's entire
// starting rating in ONE match — wildly too volatile (see spec). Scaling
// K down by the same 10x the rating axis itself was compressed by lands at
// K=3.2; we pick K=5, a little above that floor, specifically because a
// small beta population plays far fewer total matches than a mature ladder
// ever would — a slightly punchier K lets ratings actually separate/settle
// within the beta's one-month window instead of crawling (see spec section
// 13, priority #4: "rating reacts strongly to unexpected results").
export const K_FACTOR = 5;
// New players calibrate faster for their first few matches (common Elo
// practice) — a higher K here only during that provisional window, per
// spec section 3's explicit "if useful" allowance. Independent of the
// 3-match LEAGUE ranking-eligibility threshold below (section 4) — that one
// gates leaderboard visibility, not K.
export const PROVISIONAL_RATING_MATCHES = 5;
export const PROVISIONAL_K_FACTOR = 8;

// ---- League ranking eligibility (visible) ----
// 0–2 completed matches -> 'provisional', 3+ -> 'ranked' (spec section 4 —
// deliberately NOT the same number as PROVISIONAL_RATING_MATCHES above).
export const RANKED_MATCH_THRESHOLD = 3;

// ---- Streak milestones (one-time per streak run) ----
export const STREAK_MILESTONES = [
  { days: 3, lp: 3 },
  { days: 7, lp: 10 },
  { days: 14, lp: 20 },
  { days: 21, lp: 30 },
  { days: 30, lp: 50 },
];

// expectedScore(100,100) = 0.5 (equal). expectedScore(130,100) ≈ 0.85
// ("moderately stronger" per spec's own example). expectedScore(160,100) ≈
// 0.97 ("much stronger" per spec's own example) — matches the spec's
// worked examples exactly with RATING_SCALE=40, so nothing here is tuned
// beyond following the given formula.
export function expectedScore(playerRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / RATING_SCALE));
}

// matchesPlayedBefore: this player's OWN completed-League-match count
// BEFORE this match — each side's own provisional window is independent
// (one player can be provisional while their opponent isn't).
export function effectiveK(matchesPlayedBefore) {
  return matchesPlayedBefore < PROVISIONAL_RATING_MATCHES ? PROVISIONAL_K_FACTOR : K_FACTOR;
}

// actualScore: 1 for a win, 0 for a loss (this is a 2-player win/lose game,
// no draws). Standard Elo update, just on the compressed scale/K above.
export function nextRating(oldRating, opponentRating, actualScore, matchesPlayedBefore) {
  return oldRating + effectiveK(matchesPlayedBefore) * (actualScore - expectedScore(oldRating, opponentRating));
}

function clampRound(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// LP reward tables (spec section 5) are 5 qualitative buckets described as
// ranges; rather than a big if/else ladder keyed to arbitrary rating-gap
// cutoffs (which the spec explicitly asks to avoid), both formulas below
// are single smooth linear functions of `expected` (this player's own
// expectedScore against the opponent they just played) chosen so that
// plugging in one representative `expected` value per bucket
// (0.9/0.7/0.5/0.3/0.1, evenly spanning "much weaker" through "much
// stronger" opponent) lands inside every one of the spec's stated ranges —
// see scripts/league-rating-check.mjs for that exact check.
//
// Win: 20 LP at expected=0.5 (baseline, "similar" opponent per spec),
// sliding down to 10 as expected -> 1 (beating a much weaker opponent is
// barely worth anything — this IS the anti-farming mechanism, spec
// section 13 priority #3) and up to 30 as expected -> 0 (beating a much
// stronger opponent is close to the max reward, priority #2).
export function winLpReward(expected) {
  return clampRound(30 - 20 * expected, 10, 30);
}

// Loss: 0 LP at expected=1 (losing when you were expected to crush your
// opponent gets no consolation at all) rising to 6 as expected -> 0 (losing
// as a heavy underdog was the expected outcome, so it stays cheap/lightly
// consoled — spec: "should not be heavily punished in LP"). LP can never go
// negative (spec section 2) — this formula never produces a negative
// number by construction (clamped to [0, 6] regardless).
export function lossLpReward(expected) {
  return clampRound((0.7 - expected) * 10, 0, 6);
}

export function lpReward(expected, won) {
  return won ? winLpReward(expected) : lossLpReward(expected);
}

// ---- Streaks (UTC calendar days, win-or-loss both count — spec section 6) ----
export function utcDateString(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function daysBetweenUtcDates(earlier, later) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400000);
}

// player: { streak, bestStreak, lastMatchDate, milestonesThisStreak } — the
// subset of a stored player record this needs. todayStr: this match's own
// UTC calendar date (utcDateString(timestampMs) of the match being
// recorded), NOT wall-clock "now" — keeps this pure/deterministic and
// correct for a backfill or an out-of-order retry of an old match.
//
// milestonesThisStreak resets to [] whenever the streak itself resets to 1
// — "one-time... not repeatedly" (spec section 6) means once per STREAK RUN,
// not once ever: a broken-then-rebuilt streak can re-earn the same
// milestones on its way back up, which this models by scoping the
// already-awarded set to the current run rather than the player's lifetime.
export function updateStreak(player, todayStr) {
  const prevDate = player.lastMatchDate || null;
  const bestStreakSoFar = player.bestStreak || 0;
  let milestonesThisStreak = Array.isArray(player.milestonesThisStreak) ? [...player.milestonesThisStreak] : [];

  if (prevDate === todayStr) {
    // A second completed League match on the same UTC day — the streak was
    // already counted for today, don't re-award or double-bump it.
    return { streak: player.streak || 0, bestStreak: bestStreakSoFar, milestonesThisStreak, bonusLp: 0 };
  }

  let streak;
  if (prevDate && daysBetweenUtcDates(prevDate, todayStr) === 1) {
    streak = (player.streak || 0) + 1;
  } else {
    // First-ever match, or a gap of 2+ days (or a negative/zero gap from an
    // out-of-order timestamp) — either way today starts a fresh run.
    streak = 1;
    milestonesThisStreak = [];
  }

  let bonusLp = 0;
  for (const m of STREAK_MILESTONES) {
    if (streak >= m.days && !milestonesThisStreak.includes(m.days)) {
      milestonesThisStreak.push(m.days);
      bonusLp += m.lp;
    }
  }
  return { streak, bestStreak: Math.max(bestStreakSoFar, streak), milestonesThisStreak, bonusLp };
}

export function rankingStatus(matches) {
  return matches >= RANKED_MATCH_THRESHOLD ? 'ranked' : 'provisional';
}

// ---- Classic-ruleset gate (scope decision: only Classic-preset matches
// count for League — Custom rules never do) ----
// Mirrors src/matchConfig.js's DEFAULT_MATCH_CONFIG exactly. Duplicated
// rather than imported: party/ is bundled as a separate Cloudflare Worker
// from the browser build, and this codebase's existing convention at that
// boundary is to duplicate the small pieces of logic that need to cross it
// rather than share a module (see party/arbiter.js's summarizeMismatch, a
// hand-ported duplicate of server/arbiter.js's own version, for the
// precedent). Keep this in sync by hand if the Classic preset ever changes.
const CLASSIC_MATCH_CONFIG = { skin: 'summer', stonesPerTeam: 3, pointsToWin: 2, turnTime: 30, curlingCycles: 2 };
export function isClassicMatchConfig(config) {
  if (!config || typeof config !== 'object') return false;
  return Object.keys(CLASSIC_MATCH_CONFIG).every((key) => config[key] === CLASSIC_MATCH_CONFIG[key]);
}

// ---- Putting it all together ----
// playerA/playerB: stored player records (or a fresh default — see
// party/leagueSeason.js's emptyPlayer) — { rating, lp, matches, wins,
// losses, streak, bestStreak, lastMatchDate, milestonesThisStreak }.
// winner: 'A' | 'B'. timestampMs: when the match actually completed.
//
// Returns the two players' fully-updated records plus enough of the
// intermediate values (ratingBefore/After, lpAwarded) for the caller to
// build a match-history entry (spec section 8) without recomputing
// anything.
export function applyMatchResult({ playerA, playerB, winner, timestampMs }) {
  const today = utcDateString(timestampMs);
  const expectedA = expectedScore(playerA.rating, playerB.rating);
  const expectedB = 1 - expectedA;
  const wonA = winner === 'A';
  const wonB = winner === 'B';

  const ratingBeforeA = playerA.rating;
  const ratingBeforeB = playerB.rating;
  const ratingAfterA = nextRating(ratingBeforeA, ratingBeforeB, wonA ? 1 : 0, playerA.matches || 0);
  const ratingAfterB = nextRating(ratingBeforeB, ratingBeforeA, wonB ? 1 : 0, playerB.matches || 0);

  const lpA = lpReward(expectedA, wonA);
  const lpB = lpReward(expectedB, wonB);
  const streakA = updateStreak(playerA, today);
  const streakB = updateStreak(playerB, today);
  const lpAwardedA = lpA + streakA.bonusLp;
  const lpAwardedB = lpB + streakB.bonusLp;

  return {
    A: {
      rating: ratingAfterA, ratingBefore: ratingBeforeA, ratingAfter: ratingAfterA,
      lp: (playerA.lp || 0) + lpAwardedA, lpAwarded: lpAwardedA,
      matches: (playerA.matches || 0) + 1, wins: (playerA.wins || 0) + (wonA ? 1 : 0), losses: (playerA.losses || 0) + (wonA ? 0 : 1),
      streak: streakA.streak, bestStreak: streakA.bestStreak, milestonesThisStreak: streakA.milestonesThisStreak,
      lastMatchDate: today,
    },
    B: {
      rating: ratingAfterB, ratingBefore: ratingBeforeB, ratingAfter: ratingAfterB,
      lp: (playerB.lp || 0) + lpAwardedB, lpAwarded: lpAwardedB,
      matches: (playerB.matches || 0) + 1, wins: (playerB.wins || 0) + (wonB ? 1 : 0), losses: (playerB.losses || 0) + (wonB ? 0 : 1),
      streak: streakB.streak, bestStreak: streakB.bestStreak, milestonesThisStreak: streakB.milestonesThisStreak,
      lastMatchDate: today,
    },
  };
}
