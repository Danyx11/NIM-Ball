// League Beta — a single Durable Object per season (see
// party/leagueRating.js's CURRENT_SEASON_ID, which doubles as this class's
// room name/instance) holding every player's Rating/LP/streak record and
// the full completed-match history for that season. Fine as one instance
// for a beta's small population (per explicit product decision — do not
// prematurely shard); a future season is simply a fresh instance under a
// new room name, so its storage starts completely clean with zero migration
// of this file needed.
//
// Reached two ways, same split as party/playerIndex.js:
// - Durable Object RPC (getServerByName(env.LeagueSeason, CURRENT_SEASON_ID)
//   .recordMatchCompleted(...)) from party/arbiter.js (LIVE) and
//   party/weekArbiter.js (WEEK) — same pattern as their existing
//   RadarCollector calls (see party/radar.js's own header comment: this RPC
//   boundary IS the authentication, there's no public endpoint that accepts
//   match results). Every eligibility guard (both players actually
//   connected, both have a real wallet address, Classic ruleset only) is
//   the CALLER's job, decided from that arbiter's own authoritative match
//   state — this class trusts whatever it's handed over RPC completely
//   (same trust boundary as PlayerIndex/RadarCollector already have), and
//   only adds the idempotency check below on top.
// - Plain HTTP GET (browser, via src/net.js) for the League panel
//   (src/main.js) — this player's own stats, the season leaderboard, or a
//   weekly leaderboard (see addition below the original implementation).
import { Server } from 'partyserver';
import { applyMatchResult, STARTING_RATING, rankingStatus } from './leagueRating.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Monday 00:00:00 UTC of the ISO week containing `timestampMs` — ties in
// with the streak system's own UTC-day convention elsewhere in this file
// (party/leagueRating.js's utcDateString/updateStreak).
function startOfIsoWeekUtc(timestampMs) {
  const d = new Date(timestampMs);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayOfWeek = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon->0, Tue->1, ..., Sun->6
  return utcMidnight - daysSinceMonday * DAY_MS;
}

export class LeagueSeason extends Server {
  onStart() {
    this._loaded = (async () => {
      // Two flat JSON docs, same "load whole blob into memory, persist whole
      // blob back" shape party/weekArbiter.js and party/playerIndex.js
      // already use — appropriate at this beta's scale (see file header).
      this.players = (await this.ctx.storage.get('players')) || {};
      // matchId -> match-history record (spec section 8) — the map itself
      // (not just an array) is what makes recordMatchCompleted's idempotency
      // check an O(1) lookup instead of a scan.
      this.matches = (await this.ctx.storage.get('matches')) || {};
    })();
    // Same single-writer-queue pattern as party/radar.js's onStart — two
    // recordMatchCompleted RPCs landing close together (LIVE and WEEK are
    // separate arbiter classes, both able to call in at once) would
    // otherwise each read the pre-mutation `players` doc, mutate their own
    // copy in JS memory, and the second write would silently clobber the
    // first. See RadarCollector's own onStart comment for the verified
    // concurrency bug this pattern fixes.
    this._writeQueue = Promise.resolve();
  }

  async ready() { if (this._loaded) await this._loaded; }

  serialized(fn) {
    const run = this._writeQueue.then(fn, fn); // still run even if the previous entry rejected
    this._writeQueue = run.catch(() => {});    // one failure must never wedge the whole queue
    return run;
  }

  async persistPlayers() { await this.ctx.storage.put('players', this.players); }
  async persistMatches() { await this.ctx.storage.put('matches', this.matches); }

  emptyPlayer(address) {
    return {
      address, rating: STARTING_RATING, lp: 0, matches: 0, wins: 0, losses: 0,
      streak: 0, bestStreak: 0, lastMatchDate: null, milestonesThisStreak: [],
    };
  }

  // players: [{address}, {address}], both required and non-empty — callers
  // already filtered out guest/one-sided/non-Classic matches before ever
  // reaching this method (see party/arbiter.js's and
  // party/weekArbiter.js's own League hook comments for exactly what each
  // one checks). `leagueMatchId` must be stable across retries of the SAME
  // underlying match completion (arbiter.js uses `live:<room code>`,
  // weekArbiter.js uses `week:<room code>` — see those call sites) so a
  // duplicate/retried RPC can only ever apply once.
  recordMatchCompleted({ leagueMatchId, mode, timestampMs, playerA, playerB, winner }) {
    return this.serialized(async () => {
      await this.ready();
      if (!leagueMatchId || !playerA?.address || !playerB?.address || (winner !== 'A' && winner !== 'B')) {
        return { ok: false, reason: 'invalid payload' };
      }
      if (this.matches[leagueMatchId]) return { ok: true, duplicate: true }; // idempotent replay
      const before = {
        A: this.players[playerA.address] || this.emptyPlayer(playerA.address),
        B: this.players[playerB.address] || this.emptyPlayer(playerB.address),
      };
      const result = applyMatchResult({ playerA: before.A, playerB: before.B, winner, timestampMs: timestampMs || Date.now() });
      this.players[playerA.address] = { ...before.A, ...result.A, address: playerA.address };
      this.players[playerB.address] = { ...before.B, ...result.B, address: playerB.address };
      this.matches[leagueMatchId] = {
        matchId: leagueMatchId, seasonId: this.name, mode: mode || null,
        playerA: playerA.address, playerB: playerB.address, winner,
        ratingBeforeA: result.A.ratingBefore, ratingAfterA: result.A.ratingAfter,
        ratingBeforeB: result.B.ratingBefore, ratingAfterB: result.B.ratingAfter,
        lpAwardedA: result.A.lpAwarded, lpAwardedB: result.B.lpAwarded,
        timestamp: timestampMs || Date.now(),
      };
      await Promise.all([this.persistPlayers(), this.persistMatches()]);
      // lpAwardedA/lpAwardedB: the CALLER's job to relay each side's own
      // figure back to that side's client (see party/arbiter.js's own
      // 'matchOver' handler) — this class has no notion of which side is
      // "the reader", it just hands both back.
      return { ok: true, lpAwardedA: result.A.lpAwarded, lpAwardedB: result.B.lpAwarded };
    });
  }

  // Deliberately omits `rating` — the hidden internal skill signal never
  // surfaces to players (spec section 12: don't use the term "Elo" in the
  // UI, and Rating itself "can remain completely hidden during the beta").
  publicPlayer(p) {
    return {
      lp: p.lp, matches: p.matches, wins: p.wins, losses: p.losses,
      streak: p.streak, bestStreak: p.bestStreak,
      status: rankingStatus(p.matches),
    };
  }

  // Every player with at least one completed match, sorted by League
  // Points — no minimum-matches gate any more (spec section 4's 3-match
  // "ranked" threshold used to filter this list; dropped by explicit
  // request so players show up from their very first match). Because
  // this.players already holds every player's stats regardless of that
  // threshold, lifting the filter also surfaces everything already played,
  // no data migration needed. Fine to recompute from scratch on every call
  // at this beta's scale (a handful to a few hundred players, not
  // thousands) — no separate maintained sort order needed.
  leaderboard(limit) {
    return Object.values(this.players)
      .filter((p) => p.matches >= 1)
      .sort((x, y) => y.lp - x.lp)
      .slice(0, limit)
      .map((p, i) => ({ rank: i + 1, address: p.address, lp: p.lp, matches: p.matches, wins: p.wins, losses: p.losses, streak: p.streak }));
  }

  // "This week" leaderboard, ranked by LP EARNED during the current UTC
  // calendar week (Monday 00:00:00 UTC through now), computed from match
  // history rather than lifetime `lp`. Every player who played this week
  // shows up, same as the main board now that it has no minimum-matches
  // gate either. Sums lpAwardedA/lpAwardedB per address across every match in
  // this.matches whose timestamp falls in the window, sorts descending, and
  // returns the same row shape as leaderboard() (rank, address, lp <- weekly
  // sum, matches/wins/losses <- this week's counts, streak <- the player's
  // current live streak from this.players, for display consistency with
  // the main board).
  weeklyLeaderboard(limit) {
    const windowStart = startOfIsoWeekUtc(Date.now());
    const totals = {};
    for (const m of Object.values(this.matches)) {
      if (!m || typeof m.timestamp !== 'number' || m.timestamp < windowStart) continue;
      for (const side of ['A', 'B']) {
        const address = side === 'A' ? m.playerA : m.playerB;
        if (!address) continue;
        const lpAwarded = (side === 'A' ? m.lpAwardedA : m.lpAwardedB) || 0;
        if (!totals[address]) totals[address] = { address, lp: 0, matches: 0, wins: 0, losses: 0 };
        totals[address].lp += lpAwarded;
        totals[address].matches += 1;
        if (m.winner === side) totals[address].wins += 1; else totals[address].losses += 1;
      }
    }
    return Object.values(totals)
      .sort((x, y) => y.lp - x.lp)
      .slice(0, limit)
      .map((t, i) => ({
        rank: i + 1, address: t.address, lp: t.lp, matches: t.matches, wins: t.wins, losses: t.losses,
        streak: this.players[t.address]?.streak || 0,
      }));
  }

  // Plain HTTP GET, same CORS-preflight shape as party/playerIndex.js's own
  // onRequest (this Worker is deployed separately from the game's own
  // origin, so a plain fetch() needs the header; a wildcard origin is fine
  // here — every field returned is already non-sensitive, player-facing
  // data, same trust level as My Matches). Query shapes:
  // ?address=<wallet>              -> { player, rank } for this one player
  // ?leaderboard=1&limit=N         -> { leaderboard: [...] } top N by season LP
  // ?leaderboard=1&weekly=1&limit=N -> { leaderboard: [...] } top N by THIS WEEK's LP
  async onRequest(request) {
    await this.ready();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    const url = new URL(request.url);
    if (url.searchParams.has('leaderboard')) {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const leaderboard = url.searchParams.has('weekly') ? this.weeklyLeaderboard(limit) : this.leaderboard(limit);
      return Response.json({ seasonId: this.name, leaderboard }, { headers: cors });
    }
    const address = url.searchParams.get('address');
    if (!address) return Response.json({ error: 'address or leaderboard required' }, { status: 400, headers: cors });
    const stored = this.players[address];
    const player = this.publicPlayer(stored || this.emptyPlayer(address));
    // Anyone on the leaderboard (1+ completed match) has a rank; a player
    // with no matches yet isn't on it, so their rank stays null.
    const row = this.leaderboard(1e6).find((r) => r.address === address);
    const rank = row ? row.rank : null;
    return Response.json({ seasonId: this.name, player, rank }, { headers: cors });
  }
}
