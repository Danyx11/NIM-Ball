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
import { PRIZE_ROOM_NAME } from './prize.js';

const CHAT_COOLDOWN_MS = 30000;

// A Nimiq user-friendly address, spaces already stripped by src/net.js's
// connectMatch: "NQ" + 2 check digits + 32 base32 characters = 36 chars.
// Deliberately NOT a trust upgrade — this address is still just a string the
// client reported about itself, with no signature behind it (see this.addresses
// below and CLAUDE.md's trust-model note). It is a *shape* check, so that a
// value which could never be a wallet at all can't travel on into
// party/leagueSeason.js's player keys and from there into the League panel and
// the home-screen ranking ticker, which render it for every other player.
// Anything that fails this is treated exactly like a guest (null) rather than
// rejected, so a malformed param can't lock someone out of LIVE itself.
const NIMIQ_ADDRESS_RE = /^NQ[0-9A-Z]{34}$/;
function sanitizeAddress(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\s+/g, '').toUpperCase();
  return NIMIQ_ADDRESS_RE.test(clean) ? clean : null;
}

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
    // Anti-farming (A3 — see conversation): a per-browser id each connection
    // announces via its own connect URL's `?device=` (src/net.js's
    // getDeviceId) — same "relayed verbatim, never proven" trust level as
    // this.addresses above. Used only by the prize block below to refuse a
    // payout when both teams share the same id (two tabs, one browser).
    this.deviceIds = { A: null, B: null };
    this.radarStartedNotified = false;
    this.radarCompletedNotified = false;
    // League Beta (party/leagueSeason.js) — same one-shot-per-instance
    // guard as radarCompletedNotified just above, and for the same reason
    // (both clients independently detect the win locally and each send
    // their own 'matchOver', see that branch below).
    this.leagueCompletedNotified = false;
    // NIM prizes (party/prize.js) — same one-shot-per-instance guard as
    // radarCompletedNotified/leagueCompletedNotified above and for the exact
    // same reason (both clients independently detect the win and each send
    // their own 'matchOver').
    this.prizeCompletedNotified = false;
    // "Play Again" reuses this same room for another match (src/game.js's
    // goalPlayAgainBtn — a purely local reset, this arbiter never hears about
    // it), so the one-shot flags above would otherwise block every rematch
    // from League/prizes, and `live:<code>` would collide with the first
    // match's id (LeagueSeason/prize dedupe on it). The client numbers each
    // match in the room and sends it on 'matchOver' — see that branch.
    this.matchIndex = 0;
    // Which matchIndex already got its "no rewards, and why" answer — see
    // sendRewardsNone.
    this.noRewardSentFor = -1;
    // Anti-farming (A1 — see conversation): the server's OWN tally of the
    // match score, built up manche-by-manche from mancheResult's own
    // byte-for-byte A/B comparison below (never from matchOver's
    // client-reported scoreA/scoreB) — see the 'mancheResult' branch for how
    // this gets incremented and src/game.js's CLAUDE.md note on why this was
    // previously trusted from the client. Reset on every rematch alongside
    // the one-shot flags above (same matchIndex-bump block).
    this.liveScore = { A: 0, B: 0 };
    // Set true the moment any manche in the CURRENT match comes back
    // mismatched between the two clients (see 'mancheResult' below) — a
    // desynced match's own score can't be trusted for the rest of its life,
    // so this blocks the prize (not League — see that block's own comment)
    // outright rather than paying out on a match that provably diverged.
    this.hadMancheMismatch = false;
    // Anti-farming (A2 — see conversation): Date.now() per team each time
    // its 'shots' message arrives (first baseline set at connect, see
    // onConnect below), summed across the whole match into
    // reflectionMsTotal — a cheap, bot-only signal (see prize.js's own
    // MIN_REFLECTION_MS_TOTAL comment for why this never meaningfully
    // catches a fast human).
    this.lastShotAt = { A: null, B: null };
    this.reflectionMsTotal = 0;
  }

  // Tells both clients there's no League/prize result coming, and why. Sent
  // instead of silence so showVictory() stops waiting (it used to sit out
  // the full 2s/8s timeouts whenever a match wasn't rewarded — e.g. a prize
  // refused by prize.js's anti-farming rules) and so the reason is visible in
  // the browser console (src/game.js logs it).
  sendRewardsNone(reason) {
    for (const t of ['A', 'B']) {
      this.send(this.players[t], { type: 'leagueResult', lpAwarded: null, reason });
      this.send(this.players[t], { type: 'prizeResult', amountNim: null, reason });
    }
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
    // This used to be missing its `return` before getServerByName(...) —
    // meaning the function always fell through to an implicit `undefined`
    // return, unconditionally, whether or not the binding existed. The
    // matchOver handler below unconditionally chains `.then()` onto this
    // call's result, so every single completed League match threw `Cannot
    // read properties of undefined (reading 'then')` right there — the RPC
    // itself (this.serialized(...) in leagueSeason.js) still ran and
    // recorded the match fine, but the code that sends the result back to
    // the players never got reached (confirmed live with `wrangler tail`).
    // Same shape as prizeNotify below now, on purpose.
    if (!this.env?.LeagueSeason) return Promise.resolve(undefined); // e.g. local `npm run wrangler:dev` without the binding configured
    return getServerByName(this.env.LeagueSeason, CURRENT_SEASON_ID)
      .then((league) => league[method](payload))
      .catch((err) => { console.error(`[league] ${method} failed:`, err); return undefined; });
  }

  // NIM prizes (party/prize.js) — same RPC shape as leagueNotify above, and
  // same reason it isn't fire-and-forget: the result (paid or not, and how
  // much) is what the winner's own client needs to show "+10 NIM prize" —
  // see this file's 'matchOver' branch below.
  prizeNotify(method, payload) {
    if (!this.env?.PrizeVault) return Promise.resolve(undefined); // e.g. local dev without the binding configured
    return getServerByName(this.env.PrizeVault, PRIZE_ROOM_NAME)
      .then((prize) => prize[method](payload))
      .catch((err) => { console.error(`[prize] ${method} failed:`, err); return undefined; });
  }

  send(connection, msg) {
    if (!connection) return;
    // A connection can go stale without onClose ever firing (the same "a
    // client's own socket can drop on its own" case the auto-reconnect
    // feature already handles on the receiving end — see conversation: a
    // real match traced live with `wrangler tail` caught this exact race —
    // team A's connection threw here while resolving League, which aborted
    // this function before team B's own send() on the next line ever ran,
    // silently costing B their League stamp even though the RPC itself had
    // already succeeded). One player's dead connection must never stop the
    // other's message from going out.
    try { connection.send(JSON.stringify(msg)); }
    catch (err) { console.error('[arbiter] send failed (stale connection):', err); }
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
    const url = new URL(ctx.request.url);
    // Reconnect (src/net.js's connectMatch rejoinTeam, sent only when a
    // client's own socket closed locally with the server never having said
    // anything happened — see conversation: a mobile WebView can drop its
    // own WebSocket on its own, so onClose here never fires and this team's
    // slot never frees). Trusted the same way ?address= already is (never
    // proven, just relayed — see CLAUDE.md's Radar trust-model section):
    // claiming a team just evicts whatever connection is currently sitting
    // in that exact slot, never the other team's, so a stray/incorrect
    // request can only ever kick out this same player's own prior
    // connection. Normal joins (no rejoinTeam) are entirely unaffected.
    const rejoinTeam = url.searchParams.get('rejoinTeam');
    let team;
    if (rejoinTeam === 'A' || rejoinTeam === 'B') {
      team = rejoinTeam;
      if (this.players[team] && this.players[team] !== connection) {
        try { this.players[team].close(); } catch { /* already gone */ }
      }
    } else {
      team = !this.players.A ? 'A' : !this.players.B ? 'B' : null;
      if (!team) {
        this.send(connection, { type: 'full' });
        connection.close();
        return;
      }
    }
    this.players[team] = connection;
    // Connection state survives for the life of this connection (see
    // partyserver's connection.setState) — used in onMessage/onClose below
    // instead of re-deriving team from the raw ws connection identity.
    connection.setState({ team });
    // Optional, Radar-only (see this.addresses' own comment above) — src/net.js's
    // connectMatch() appends this when the local player has a connected
    // wallet, omits it entirely for a guest.
    this.addresses[team] = sanitizeAddress(url.searchParams.get('address'));
    this.deviceIds[team] = url.searchParams.get('device') || null;
    // Baseline for this team's reflection-time tally (A2 — see onStart's own
    // comment) — a reconnect (rejoinTeam) re-baselines here too, which is
    // fine: it only ever makes the measured time from here on LONGER (an
    // idle gap waiting on a dropped connection can't make a match look
    // faster), never shorter.
    this.lastShotAt[team] = Date.now();
    // Team A (creator) reads back null here (it hasn't sent its config yet
    // at this point — it already knows its own choice locally, see main.js)
    // and team B (joiner) gets whatever A already stored, assuming the
    // normal flow (Custom Settings -> SAVE -> only then share the code).
    // opponentAddress (see src/ticket.js's league stamp/opponent identicon
    // work, conversation) — whatever's already known for the other side at
    // this moment: null if they haven't connected yet (backfilled below once
    // they do) or are a guest. Same 'no proof of ownership, just relayed
    // verbatim' trust level as this.addresses itself already documents.
    this.send(connection, { type: 'joined', team, matchConfig: this.matchConfig, vibe: this.vibe, opponentAddress: this.addresses[otherTeam(team)] });
    const opponent = this.players[otherTeam(team)];
    if (opponent) {
      this.send(opponent, { type: 'opponentJoined', address: this.addresses[team] });
      this.send(connection, { type: 'opponentJoined', address: this.addresses[otherTeam(team)] });
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
      // Anti-farming (A2 — see onStart's own comment) — how long this team
      // took to go from able-to-shoot to actually submitting, summed across
      // the whole match regardless of vibe/manche outcome.
      const now = Date.now();
      if (this.lastShotAt[team] != null) this.reflectionMsTotal += now - this.lastShotAt[team];
      this.lastShotAt[team] = now;
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
        // Anti-farming (A1 — see onStart's own liveScore comment): derive
        // the score from this same cross-checked payload instead of ever
        // trusting matchOver's client-reported scoreA/scoreB. Hockey's
        // winning team is the last letter of the 'goalA'/'wipeoutB'-shaped
        // result string (src/game.js's physicsStep); curling has no such
        // string (no ball) so computeMancheResult embeds pointWinner
        // instead on whichever manche ends a curling cycle — both already
        // went through the JSON.stringify comparison above, so nothing new
        // needs verifying here, just reading the field both sides agreed on.
        if (valid) {
          const r = this.mancheResults.A; // === .B, byte-for-byte
          const scoringTeam = typeof r?.result === 'string' && r.result ? r.result.slice(-1)
            : (r?.pointWinner === 'A' || r?.pointWinner === 'B') ? r.pointWinner : null;
          if (scoringTeam === 'A' || scoringTeam === 'B') this.liveScore[scoringTeam]++;
        } else {
          this.hadMancheMismatch = true;
        }
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
      const matchIndex = Number(msg.matchIndex) || 0;
      if (matchIndex < this.matchIndex) return; // late message from an earlier match in this room
      if (matchIndex > this.matchIndex) {
        // A rematch just finished. Radar's own flag/id stay as they were (it
        // never saw a second "started", so a second "completed" would
        // unbalance its active gauge) — only League/prizes count rematches.
        this.matchIndex = matchIndex;
        this.leagueCompletedNotified = false;
        this.prizeCompletedNotified = false;
        // A1/A2 state (see onStart's own comments) is per-match, not
        // per-room — a rematch starts every one of these fresh exactly like
        // mancheIndex/shots/etc already reset elsewhere.
        this.liveScore = { A: 0, B: 0 };
        this.hadMancheMismatch = false;
        this.reflectionMsTotal = 0;
        this.lastShotAt = { A: Date.now(), B: Date.now() };
      }
      const roomMatchId = matchIndex > 0 ? `live:${this.name}:${matchIndex}` : `live:${this.name}`;
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
      const rewardGateReason = !this.radarStartedNotified ? 'not_both_connected'
        : !(this.addresses.A && this.addresses.B) ? 'wallet_required'
        : !isClassicMatchConfig(this.matchConfig) ? 'not_classic' : null;
      if (rewardGateReason && this.noRewardSentFor !== matchIndex) {
        this.noRewardSentFor = matchIndex;
        this.sendRewardsNone(rewardGateReason);
      }
      if (!this.leagueCompletedNotified && this.radarStartedNotified
        && this.addresses.A && this.addresses.B
        && isClassicMatchConfig(this.matchConfig)) {
        // Anti-farming (A1 — see onStart's own liveScore comment): derived
        // from the server's own cross-checked manche tally, never from
        // matchOver's client-reported scoreA/scoreB (a forged/stale value
        // there can no longer invent a League win either). A tie shouldn't
        // be reachable (the match only ends once one side's score crosses
        // the win threshold) but is checked for defensively rather than
        // ever crediting/blaming either side incorrectly.
        const winner = this.liveScore.A > this.liveScore.B ? 'A' : this.liveScore.B > this.liveScore.A ? 'B' : null;
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
            leagueMatchId: roomMatchId, mode: 'live', timestampMs: Date.now(),
            playerA: { address: this.addresses.A }, playerB: { address: this.addresses.B }, winner,
          }).then((result) => {
            if (!result?.ok || result.duplicate) { // no fresh lpAwarded to report — see leagueSeason.js
              for (const t of ['A', 'B']) this.send(this.players[t], { type: 'leagueResult', lpAwarded: null, reason: result?.duplicate ? 'duplicate' : 'league_error' });
              return;
            }
            this.send(this.players.A, { type: 'leagueResult', lpAwarded: result.lpAwardedA });
            this.send(this.players.B, { type: 'leagueResult', lpAwarded: result.lpAwardedB });
          });
        }
      }
      // NIM prizes (party/prize.js) — same eligibility bar as League's block
      // just above (both players actually connected, both a real wallet,
      // exact Classic ruleset — this.matchConfig is the creator's own
      // choice, relayed verbatim, same trust model as every other
      // client-sent field this arbiter already relays as-is), kept as a
      // SEPARATE condition rather than nested inside League's own `if`
      // purely so a change to one can never accidentally affect the other.
      // Server-side budget/same-wallet/cooldown checks are still enforced in
      // prize.js itself, never trusted from here — see prizeCompletedNotified's
      // own comment for why this fires at most once per instance.
      if (!this.prizeCompletedNotified && this.radarStartedNotified && this.addresses.A && this.addresses.B && isClassicMatchConfig(this.matchConfig)) {
        // Anti-farming (A1 — see onStart's own liveScore comment): winner is
        // derived from this.liveScore, the server's own tally built up
        // manche-by-manche from mutually cross-checked results — never from
        // matchOver's client-reported scoreA/scoreB. Two sockets opened on
        // the same room, a 'matchConfig' and a single fabricated 'matchOver'
        // used to be enough to collect a payout without a single shot (see
        // git history); now liveScore can only move via a manche the server
        // itself relayed AND both clients agreed settled identically, so a
        // winner can no longer exist without a real, undisputed match.
        // hadMancheMismatch (set in the 'mancheResult' branch) refuses the
        // prize outright on any match with even one desynced manche — a
        // match the server can no longer vouch for shouldn't pay out,
        // whatever caused the mismatch (forged client or a genuine physics
        // bug either way gets a Telegram alert via sendSyncMismatchAlert).
        const winner = this.liveScore.A > this.liveScore.B ? 'A' : this.liveScore.B > this.liveScore.A ? 'B' : null;
        if (winner && !this.hadMancheMismatch) {
          this.prizeCompletedNotified = true;
          this.prizeNotify('evaluate', {
            matchId: roomMatchId, mode: 'live', timestampMs: Date.now(),
            playerA: { address: this.addresses.A, deviceId: this.deviceIds.A },
            playerB: { address: this.addresses.B, deviceId: this.deviceIds.B },
            winner, reflectionMsTotal: this.reflectionMsTotal,
          }).then((result) => {
            // Both sides always get an answer (null = nothing to show:
            // not_eligible/budget_exhausted/an unpaid 'eligible'), so neither
            // ticket sits waiting on a prize that isn't coming.
            const paid = result?.status === 'paid';
            const reason = paid ? null : (result?.reason || result?.status || 'prize_error');
            for (const t of ['A', 'B']) {
              this.send(this.players[t], { type: 'prizeResult', amountNim: paid && t === winner ? result.amountNim : null, reason });
            }
          });
        } else {
          this.prizeCompletedNotified = true;
          // No real winner (no manche ever relayed through this room — a
          // forged matchOver with nothing played) or the match desynced —
          // answer anyway rather than staying silent, since showVictory()
          // waits on a prizeResult and would otherwise sit out its full
          // timeout, same reasoning as sendRewardsNone's own comment.
          const reason = this.hadMancheMismatch ? 'desync' : 'not_played';
          for (const t of ['A', 'B']) this.send(this.players[t], { type: 'prizeResult', amountNim: null, reason });
        }
      }
    }
  }

  onClose(connection, code, reason, wasClean) {
    const team = connection.state?.team;
    if (team !== 'A' && team !== 'B') return;
    // A newer connection for this same team may already have taken over the
    // slot (onConnect's rejoinTeam reconnect path, above, evicts the old one
    // by calling close() on it) — this is then just that superseded old
    // connection finishing its own teardown, not a real departure, so it
    // must not reset the round or tell the other player anyone left.
    if (this.players[team] !== connection) return;
    this.players[team] = null;
    this.resetRound();
    this.resetManche();
    this.lastChatAt[team] = 0; // a fresh reconnect shouldn't inherit a stale cooldown
    this.ready[team] = false; // ditto for a stale "already tapped ready" from a dropped connection
    const remaining = this.players[otherTeam(team)];
    this.send(remaining, { type: 'opponentLeft' });
  }
}
