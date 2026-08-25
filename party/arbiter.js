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
import { Server } from 'partyserver';

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

  onConnect(connection) {
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
    // Team A (creator) reads back null here (it hasn't sent its config yet
    // at this point — it already knows its own choice locally, see main.js)
    // and team B (joiner) gets whatever A already stored, assuming the
    // normal flow (Custom Settings -> SAVE -> only then share the code).
    this.send(connection, { type: 'joined', team, matchConfig: this.matchConfig });
    const opponent = this.players[otherTeam(team)];
    if (opponent) {
      this.send(opponent, { type: 'opponentJoined' });
      this.send(connection, { type: 'opponentJoined' });
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
