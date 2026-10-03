// League Beta — pure Rating/LP/streak math, kept isolated from any Durable
// Object plumbing (party/leagueSeason.js) or storage concerns so it's easy
// to read, unit-sanity-check (see scripts/league-rating-check.mjs) and
// review on its own. Nothing here touches `this`, `ctx.storage`, or any
// Worker-only API — it would run identically under plain `node`.
//
// ---- Season ----
// One fixed-name Durable Object per season (see party/leagueSeason.js) —
// CURRENT_SEASON_ID doubles as that DO's room name, so starting a future
// season would be bumping this constant: a brand new, cleanly-isolated DO
// instance with fresh storage, while the old season's instance (and all its
// history) stays exactly where it was, untouched. No in-storage season
// namespacing needed.
// The League is an ongoing "Main" ranking now, not a time-boxed beta —
// no end date anywhere any more (there used to be a SEASON_START_UTC/
// SEASON_END_UTC pair here; both were dead — nothing ever read them, LP
// already accrued with no cutoff — so they're removed rather than left
// lying around as a stale, misleading "there's a season end date" signal).
// CURRENT_SEASON_ID deliberately still reads 'beta-2026': it's the Durable
// Object room name, so changing it would point at a brand new, empty
// instance and silently strand every League Point already earned in the
// old one. Never rename it to "reflect the rebrand" — if a truly new
// season is ever wanted later, that's the bump-this-constant path the
// comment above describes, a deliberate reset, not a drive-by rename.
export const CURRENT_SEASON_ID = 'beta-2026';

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

// Loss ("participation" LP): 0 at expected=1 (losing when you were expected
// to crush your opponent gets no consolation at all) rising to the ceiling as
// expected -> 0 (losing as a heavy underdog was the expected outcome, so it
// stays cheap/lightly consoled — spec: "should not be heavily punished in
// LP"). LP can never go negative (spec section 2) — this formula never
// produces a negative number by construction.
//
// Ceiling halved from the original 6 to 3 (and the slope with it, so the
// shape is unchanged): at 6 an even-matched loss paid 2 LP against a win's
// 20, which made simply showing up and losing a real way to climb a
// lifetime-cumulative leaderboard. Losing should still register — the board
// is deliberately kept as an activity/loyalty ranking, not a skill one — just
// not add up to much.
// Was `(0.7 - expected) * 10` clamped to [0, 6]; both the slope and the
// ceiling are halved, so every bucket pays exactly half what it used to
// (even-matched loss 2 -> 1, heavy-underdog loss 6 -> 3) with the zero point
// still at expected = 0.7.
const LOSS_LP_MAX = 3;
export function lossLpReward(expected) {
  return clampRound((0.7 - expected) * 5, 0, LOSS_LP_MAX);
}

// ---- Per-day taper on participation LP ----
// Participation LP is the one reward that needs no skill and no win, so it is
// the one a player can farm by just queueing matches all day. These cap that
// without touching wins (which already have their own anti-farming shape, see
// winLpReward) or the streak bonus (showing up on consecutive DAYS is exactly
// the assiduity the board is meant to reward — see updateStreak).
// Read as: the first 3 completed League matches of a UTC day pay full
// participation LP, the 4th pays half, and the 5th onwards pays none.
export const PARTICIPATION_FULL_MATCHES_PER_DAY = 3;
export const PARTICIPATION_ZERO_MATCHES_PER_DAY = 5;
const PARTICIPATION_TAPER_MULTIPLIER = 0.5;

// matchesAlreadyToday: this player's own count of completed League matches
// earlier on the SAME UTC day as the match being recorded (0 for their first
// of the day) — see matchesTodayBefore in applyMatchResult.
export function participationMultiplier(matchesAlreadyToday) {
  const nth = (matchesAlreadyToday || 0) + 1; // which match of the day this one is
  if (nth <= PARTICIPATION_FULL_MATCHES_PER_DAY) return 1;
  if (nth >= PARTICIPATION_ZERO_MATCHES_PER_DAY) return 0;
  return PARTICIPATION_TAPER_MULTIPLIER;
}

// The raw per-outcome reward, before the per-day taper and before any
// forfeit rule — kept as its own export because it's the piece that maps
// directly onto the spec's reward tables.
export function lpReward(expected, won) {
  return won ? winLpReward(expected) : lossLpReward(expected);
}

// What a LOSING player actually banks: the raw participation reward, tapered
// by how much they've already played today, and zeroed outright if this loss
// is a forfeit (they walked out of / timed out on the match — see
// applyMatchResult's own `forfeit` comment).
export function participationLp(expected, matchesAlreadyToday, forfeited) {
  if (forfeited) return 0;
  return Math.round(lossLpReward(expected) * participationMultiplier(matchesAlreadyToday));
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
// `forfeit`: true when the loser didn't actually lose on the board — they left
// a LIVE match mid-play, let a WEEK turn time out, or abandoned outright (see
// party/arbiter.js's awardForfeit and party/weekArbiter.js's own). The winner
// is rewarded exactly as for a real win: without that, walking out was
// strictly better than playing on, since it denied the opponent their LP
// entirely. The forfeiting side banks no participation LP at all. Everything
// else about them is treated as the loss it is — it counts as a match, counts
// as a loss, and moves their rating normally, because the rating is the honest
// skill signal and a match they chose not to finish is still a match they
// didn't win. Their streak is deliberately left alone: the streak rewards
// turning up across consecutive days, which they did.
//
// Returns the two players' fully-updated records plus enough of the
// intermediate values (ratingBefore/After, lpAwarded) for the caller to
// build a match-history entry (spec section 8) without recomputing
// anything.
export function applyMatchResult({ playerA, playerB, winner, timestampMs, forfeit = false }) {
  const today = utcDateString(timestampMs);
  const expectedA = expectedScore(playerA.rating, playerB.rating);
  const expectedB = 1 - expectedA;
  const wonA = winner === 'A';
  const wonB = winner === 'B';

  const ratingBeforeA = playerA.rating;
  const ratingBeforeB = playerB.rating;
  const ratingAfterA = nextRating(ratingBeforeA, ratingBeforeB, wonA ? 1 : 0, playerA.matches || 0);
  const ratingAfterB = nextRating(ratingBeforeB, ratingBeforeA, wonB ? 1 : 0, playerB.matches || 0);

  // How many League matches this player had already completed earlier on this
  // same UTC day, for the participation taper above. A record from before
  // these two fields existed (or one whose last match was on another day)
  // correctly reads as 0 — no migration needed.
  const playedBeforeA = playerA.matchesTodayDate === today ? (playerA.matchesToday || 0) : 0;
  const playedBeforeB = playerB.matchesTodayDate === today ? (playerB.matchesToday || 0) : 0;

  const lpA = wonA ? winLpReward(expectedA) : participationLp(expectedA, playedBeforeA, forfeit);
  const lpB = wonB ? winLpReward(expectedB) : participationLp(expectedB, playedBeforeB, forfeit);
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
      lastMatchDate: today, matchesTodayDate: today, matchesToday: playedBeforeA + 1,
    },
    B: {
      rating: ratingAfterB, ratingBefore: ratingBeforeB, ratingAfter: ratingAfterB,
      lp: (playerB.lp || 0) + lpAwardedB, lpAwarded: lpAwardedB,
      matches: (playerB.matches || 0) + 1, wins: (playerB.wins || 0) + (wonB ? 1 : 0), losses: (playerB.losses || 0) + (wonB ? 0 : 1),
      streak: streakB.streak, bestStreak: streakB.bestStreak, milestonesThisStreak: streakB.milestonesThisStreak,
      lastMatchDate: today, matchesTodayDate: today, matchesToday: playedBeforeB + 1,
    },
  };
}
