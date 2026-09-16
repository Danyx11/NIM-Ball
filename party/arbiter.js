// partyserver port of server/arbiter.js (see CLAUDE.md "LAN mode" /
// "Network match" for the original design this mirrors). Same relay-only
// arbiter logic — no physics runs here, each client still simulates locally
// from the synced shot vectors (see src/net.js / src/game.js) — just one
// Durable Object instance per room instead of one process-wide singleton.
// The room name (this.name, from the URL — see party/index.js) is the
// 4-character match code: whoever creates the code connects to that room
// name first (team A), whoever joins with the code connects second (team
// B), same "first two connections" assignment as the LAN arbiter.
//
// Previously ran on the legacy `partykit` CLI/platform, ported here to
// partyserver + wrangler (self-hosted on a Cloudflare account) because the
// shared *.partykit.dev domain hit Cloudflare's global custom-domain-per-
// zone cap — see git history. The API differs slightly from PartyKit's
// (constructor → onStart, this.room.broadcast → this.broadcast, onMessage's
// (connection, message) argument order) but the matchmaking logic itself is
// unchanged.
import { Server, getServerByName } from 'partyserver';
import { RADAR_ROOM_NAME } from './radar.js';
import { CURRENT_SEASON_ID, isClassicMatchConfig } from './leagueRating.js';

const CHAT_COOLDOWN_MS = 30000;

function otherTeam(team) {
  return team === 'A' ? 'B' : 'A';
}

// Sync-check Telegram alert — see server/arbiter.js's identical helper for
// the full rationale, duplicated here rather than shared (this file is
// already a hand-ported duplicate of that one, see the file header). Env
// vars come from this.env (Cloudflare Worker bindings — see wrangler secrets
// for production, .dev.vars for `npm run wrangler:dev`), not process.env.
function summarizeMismatch(resultA, resultB) {
  const lines = [];
  for (const [key, team] of [['a', 'A'], ['b', 'B']]) {
    (resultA?.[key] || []).forEach((exp, i) => {
      const act = resultB?.[key]?.[i];
      if (!act) return;
      const [ex, ey, ehits, edead, eout] = exp;
      const [ax, ay, ahits, adead, aout] = act;
      if (ex !== ax || ey !== ay) lines.push(`${team}${i} position: ${ex},${ey} vs ${ax},${ay}`);
      if (ehits !== ahits) lines.push(`${team}${i} hits: ${ehits} vs ${ahits}`);
      if (edead !== adead) lines.push(`${team}${i} dead: ${edead} vs ${adead}`);
      if (eout !== aout) lines.push(`${team}${i} out: ${eout} vs ${aout}`);
    });
  }
  const [ebx, eby, ebout] = resultA?.ball || [];
  const [abx, aby, about] = resultB?.ball || [];
  if (ebx !== abx || eby !== aby) lines.push(`ball position: ${ebx},${eby} vs ${abx},${aby}`);
  if (ebout !== about) lines.push(`ball out: ${ebout} vs ${about}`);
  if (resultA?.result !== resultB?.result) lines.push(`result: ${resultA?.result} vs ${resultB?.result}`);
  return lines.length ? lines.join('\n') : '(no field-level diff found — check payload shape)';
}

export class Arbiter extends Server {
  // Called once when the Durable Object instance is first started (see
  // partyserver's Server#onStart) — the equivalent of PartyKit's
  // constructor(room) for our purposes, since partyserver's own constructor
  // takes Cloudflare's (ctx, env) and isn't meant to be overridden for
  // plain per-room state like this.
  onStart() {
    this.players = { A: null, B: null };
    // Room creator's chosen rules (see src/net.js's sendMatchConfig / main.js
    // hostMatch) — set once by whoever connects first (team A), handed to
    // team B in its own 'joined' message below the moment it connects. Stays
    // a plain opaque blob as far as the arbiter is concerned, same as every
    // other relayed payload here — matchConfig shape/defaults live in
    // src/matchConfig.js, not duplicated here.
    this.matchConfig = null;
    // Room creator's chosen vibe (hockey/curling — see src/net.js's
    // sendMatchConfig / main.js hostMatch), relayed the exact same way as
    // matchConfig just above and for the same reason: game.js's physics
    // (ball or no ball, stone HP, scoring) branches on vibe, so a joiner
    // that picked a different vibe tile locally before typing in the code
    // would simulate a different game entirely — same opaque blob treatment
    // as matchConfig, set once by team A and handed to team B on join.
    this.vibe = null;
    // Set by the creator explicitly leaving the "share this code" screen
    // before anyone joined (see main.js's matchNetworkBackBtn / net.js's
    // cancelRoom) — the code itself is just this room's name, so there's no
    // way to actually invalidate it; instead the room refuses any further
    // connection once closed, which reads the same as "the code no longer
    // works" from a player's perspective.
    this.closed = false;
    this.shots = { A: null, B: null };
    this.sweeps = { A: null, B: null };
    // Same per-team rolling cooldown as server/arbiter.js — independent of
    // any match phase, no reset needed on resetRound() below.
    this.lastChatAt = { A: 0, B: 0 };
    // Same match-start handshake as server/arbiter.js's `ready` — both sides
    // must be ready before either actually starts.
    this.ready = { A: false, B: false };
    // Sync-check (see server/arbiter.js for the full rationale) — same
    // per-manche index + pending-results tracking, ported 1:1.
    this.mancheIndex = 0;
    this.pendingMancheIndex = null;
    this.mancheResults = { A: null, B: null };
    // NIM-Curl Radar (see party/radar.js) — wallet address (or null for a
    // guest, see src/nimiq.js's getIdentity) each connection announced via
    // its own connect URL's `?address=`, purely informational for Radar's
    // stats, never used for matchmaking/trust here. startedNotified/
    // completedNotified guard against notifying Radar twice: this Durable
    // Object instance is not persisted (see this file's own header comment —
    // "always starts blank"), so a plain instance field is enough for the
    // life of one match; Radar itself also dedupes by match code as a second
    // safety net (see recordMatchStarted/recordMatchCompleted).
    this.addresses = { A: null, B: null };
    this.radarStartedNotified = false;
    this.radarCompletedNotified = false;
    // League Beta (party/leagueSeason.js) — same one-shot-per-instance
    // guard as radarCompletedNotified just above, and for the same reason
    // (both clients independently detect the win locally and each send
    // their own 'matchOver', see that branch below).
    this.leagueCompletedNotified = false;
  }

  radarNotify(method, payload) {
    if (!this.env?.RadarCollector) return; // e.g. local `npm run wrangler:dev` without the binding configured
    // getServerByName is itself async (Promise<DurableObjectStub>, not the
    // stub directly — see node_modules/partyserver/dist/index.d.ts), so it
    // must be awaited before calling a method on its result. Calling
    // [method](payload) straight off the un-awaited promise throws
    // synchronously ("is not a function") — a real bug found live: it was
    // crashing onConnect/onMessage themselves, not just failing to notify
    // Radar. .then/.catch here keeps this call fire-and-forget (no `await`
    // needed at any call site) while fixing the ordering.
    getServerByName(this.env.RadarCollector, RADAR_ROOM_NAME)
      .then((radar) => radar[method](payload))
      .catch((err) => console.error(`[radar] ${method} failed:`, err));
  }

  // League Beta — same getServerByName/RPC shape as radarNotify above, just
  // pointed at the season's own Durable Object (see party/leagueSeason.js's
  // header comment on why this RPC boundary is itself the auth).
  leagueNotify(method, payload) {
    if (!this.env?.LeagueSeason) return; // e.g. local `npm run wrangler:dev` without the binding configured
    getServerByName(this.env.LeagueSeason, CURRENT_SEASON_ID)
      .then((league) => league[method](payload))
      .catch((err) => console.error(`[league] ${method} failed:`, err));
  }

  send(connection, msg) {
    if (connection) connection.send(JSON.stringify(msg));
  }

  resetRound() {
    this.shots = { A: null, B: null };
    this.sweeps = { A: null, B: null };
  }

  resetManche() {
    this.pendingMancheIndex = null;
    this.mancheResults = { A: null, B: null };
  }

  async sendSyncMismatchAlert(mancheIndex, resultA, resultB) {
    const token = this.env?.TELEGRAM_BOT_TOKEN, chatId = this.env?.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const text = `⚠️ Nim-Ball — désynchro détectée\nmanche #${mancheIndex}\n${summarizeMismatch(resultA, resultB)}`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (err) {
      console.error('[sync] Telegram alert failed:', err); // never let this break the actual relay
    }
  }

  onConnect(connection, ctx) {
    if (this.closed) {
      this.send(connection, { type: 'closed' });
      connection.close();
      return;
    }
    const team = !this.players.A ? 'A' : !this.players.B ? 'B' : null;
    if (!team) {
      this.send(connection, { type: 'full' });
      connection.close();
      return;
    }
    this.players[team] = connection;
    // Connection state survives for the life of this connection (see
    // partyserver's connection.setState) — used in onMessage/onClose below
    // instead of re-deriving team from the raw ws connection identity.
    connection.setState({ team });
    // Optional, Radar-only (see this.addresses' own comment above) — src/net.js's
    // connectMatch() appends this when the local player has a connected
    // wallet, omits it entirely for a guest.
    this.addresses[team] = new URL(ctx.request.url).searchParams.get('address') || null;
    // Team A (creator) reads back null here (it hasn't sent its config yet
    // at this point — it already knows its own choice locally, see main.js)
    // and team B (joiner) gets whatever A already stored, assuming the
    // normal flow (Custom Settings -> SAVE -> only then share the code).
    this.send(connection, { type: 'joined', team, matchConfig: this.matchConfig, vibe: this.vibe });
    const opponent = this.players[otherTeam(team)];
    if (opponent) {
      this.send(opponent, { type: 'opponentJoined' });
      this.send(connection, { type: 'opponentJoined' });
      // "Match started" = both players actually present, not just a code
      // generated (see CLAUDE.md's Radar section — an unshared/unjoined code
      // isn't a real match). Fires once per DO instance (see the field's own
      // comment) even though both connections reaching here on a reconnect
      // race would otherwise call this twice.
      if (!this.radarStartedNotified) {
        this.radarStartedNotified = true;
        this.radarNotify('recordMatchStarted', {
          matchId: this.name, mode: 'live', timestampMs: Date.now(),
          players: [{ address: this.addresses.A }, { address: this.addresses.B }],
        });
      }
    }
  }

  onMessage(connection, message) {
    const team = connection.state?.team;
    if (team !== 'A' && team !== 'B') return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.type === 'cancelRoom') {
      // No server-side check that only the creator can do this — same trust
      // model as matchConfig above (a modified client could send it anyway);
      // in the normal flow only the creator's own back button ever does.
      this.closed = true;
    } else if (msg.type === 'matchConfig') {
      // Only the creator (team A) is ever in a position to send this in the
      // normal flow (see main.js's hostMatch) — no server-side enforcement
      // beyond that, same trust model as every other client-sent field this
      // arbiter already relays as-is (shots, chat text, etc).
      this.matchConfig = msg.config;
      this.vibe = msg.vibe || null;
    } else if (msg.type === 'shots') {
      this.shots[team] = msg.stones;
      this.sweeps[team] = msg.sweep || null;
      if (this.shots.A && this.shots.B) {
        this.mancheIndex++;
        const payload = { type: 'launch', shotsA: this.shots.A, shotsB: this.shots.B, sweepA: this.sweeps.A, sweepB: this.sweeps.B, mancheIndex: this.mancheIndex };
        this.send(this.players.A, payload);
        this.send(this.players.B, payload);
        this.resetRound();
        this.pendingMancheIndex = this.mancheIndex;
        this.mancheResults = { A: null, B: null };
      }
    } else if (msg.type === 'mancheResult') {
      // See server/arbiter.js's 'mancheResult' branch — same logic, ported.
      if (msg.mancheIndex !== this.pendingMancheIndex) return;
      this.mancheResults[team] = msg.result;
      if (this.mancheResults.A !== null && this.mancheResults.B !== null) {
        const valid = JSON.stringify(this.mancheResults.A) === JSON.stringify(this.mancheResults.B);
        // See server/arbiter.js — echoing both raw results back on mismatch
        // for client-side dev diagnostics (diffMancheResults), still just
        // relaying opaque data either way.
        const payload = valid
          ? { type: 'mancheValid', mancheIndex: this.pendingMancheIndex }
          : { type: 'mancheInvalid', mancheIndex: this.pendingMancheIndex, resultA: this.mancheResults.A, resultB: this.mancheResults.B };
        this.send(this.players.A, payload);
        this.send(this.players.B, payload);
        if (!valid) this.sendSyncMismatchAlert(this.pendingMancheIndex, this.mancheResults.A, this.mancheResults.B);
        this.resetManche();
      }
    } else if (msg.type === 'chat') {
      const now = Date.now();
      if (now - this.lastChatAt[team] < CHAT_COOLDOWN_MS) return; // still cooling down
      // Array.from(...) rather than a plain string slice — see
      // server/arbiter.js's comment: splits on whole codepoints so an emoji's
      // surrogate pair never gets cut in half.
      const text = typeof msg.text === 'string'
        ? Array.from(msg.text.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 30).join('')
        : '';
      if (!text) return;
      this.lastChatAt[team] = now;
      const payload = { type: 'chat', team, text };
      this.send(this.players.A, payload);
      this.send(this.players.B, payload);
    } else if (msg.type === 'chatMute') {
      // Deliberately NOT cooldown-tracked like chat above — a status toggle,
      // always relayed immediately (see server/arbiter.js).
      const payload = { type: 'chatMute', team, muted: !!msg.muted };
      this.send(this.players.A, payload);
      this.send(this.players.B, payload);
    } else if (msg.type === 'ready') {
      this.ready[team] = true;
      if (this.ready.A && this.ready.B) {
        const payload = { type: 'bothReady' };
        this.send(this.players.A, payload);
        this.send(this.players.B, payload);
      }
    } else if (msg.type === 'matchOver') {
      // Sent once by src/game.js's showVictory() path (src/net.js's
      // sendMatchOver) — both clients independently detect the win locally
      // and will each send this, so radarCompletedNotified (not the message
      // itself) is what makes this one-shot, same pattern as
      // radarStartedNotified above. Nothing to relay to the other player —
      // Radar-only, no gameplay effect.
      if (!this.radarCompletedNotified) {
        this.radarCompletedNotified = true;
        this.radarNotify('recordMatchCompleted', { matchId: this.name, mode: 'live', timestampMs: Date.now() });
      }
      // League Beta (party/leagueSeason.js) — a LIVE match only counts for
      // League if ALL of these hold (product scope decision):
      // (a) both players actually connected — this.radarStartedNotified is
      //     flipped exactly once that happened (see onConnect above), the
      //     same "both present" bar Radar itself already uses, not just a
      //     code that got generated and never joined;
      // (b) both sides reported a real wallet address — LIVE stays
      //     guest-playable, but League has no stable identity to track/rank
      //     a guest against (same "no reliable, privacy-respecting stable
      //     id for a guest" reasoning as Radar's own unique-player counting,
      //     see CLAUDE.md);
      // (c) the match was played with the exact Classic ruleset preset —
      //     Custom-rules matches never count (scope decision). this.matchConfig
      //     is the creator's own choice, relayed verbatim (see onConnect/
      //     onMessage's 'matchConfig' branch) — never validated beyond
      //     isClassicMatchConfig's own equality check, same trust model as
      //     every other client-sent field this arbiter already relays as-is.
      if (!this.leagueCompletedNotified && this.radarStartedNotified
        && this.addresses.A && this.addresses.B
        && isClassicMatchConfig(this.matchConfig)) {
        const scoreA = Number(msg.scoreA) || 0;
        const scoreB = Number(msg.scoreB) || 0;
        // A tie shouldn't be reachable (the match only ends once one side's
        // score crosses the win threshold) but is checked for defensively
        // rather than ever crediting/blaming either side incorrectly.
        const winner = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : null;
        if (winner) {
          this.leagueCompletedNotified = true;
          // Unlike radarNotify's other fire-and-forget calls, this one's
          // result actually matters to the client — the ticket's league
          // stamp (see src/ticket.js) needs to know how much LP THIS match
          // just earned, and there's no other channel for that (a plain GET
          // against LeagueSeason only ever returns the season TOTAL, not one
          // match's own delta). leagueNotify already returns the RPC's own
          // result (see its own comment), so .then() off it here rather than
          // fire-and-forget. Sent to BOTH players at once, regardless of
          // which one's own 'matchOver' happened to be the one that arrived
          // first and actually triggered the RPC (both send it independently
          // — see this branch's own leagueCompletedNotified guard).
          this.leagueNotify('recordMatchCompleted', {
            // 'live:' prefix keeps this globally distinct from WEEK's own
            // 'week:'-prefixed ids (see party/weekArbiter.js) even though
            // match codes are drawn from the same 4-character space —
            // LeagueSeason's idempotency check keys off this exact string.
            leagueMatchId: `live:${this.name}`, mode: 'live', timestampMs: Date.now(),
            playerA: { address: this.addresses.A }, playerB: { address: this.addresses.B }, winner,
          }).then((result) => {
            if (!result?.ok || result.duplicate) return; // no fresh lpAwarded to report — see leagueSeason.js
            this.send(this.players.A, { type: 'leagueResult', lpAwarded: result.lpAwardedA });
            this.send(this.players.B, { type: 'leagueResult', lpAwarded: result.lpAwardedB });
          });
        }
      }
    }
  }

  onClose(connection, code, reason, wasClean) {
    const team = connection.state?.team;
    if (team !== 'A' && team !== 'B') return;
    if (this.players[team] === connection) this.players[team] = null;
    this.resetRound();
    this.resetManche();
    this.lastChatAt[team] = 0; // a fresh reconnect shouldn't inherit a stale cooldown
    this.ready[team] = false; // ditto for a stale "already tapped ready" from a dropped connection
    const remaining = this.players[otherTeam(team)];
    this.send(remaining, { type: 'opponentLeft' });
  }
}
