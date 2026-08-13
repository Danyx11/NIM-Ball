// PartyKit port of server/arbiter.js (see CLAUDE.md "LAN mode" for the
// original design this mirrors). Same relay-only arbiter logic — no physics
// runs here, each client still simulates locally from the synced shot
// vectors (see src/net.js / src/game.js) — just one instance per PartyKit
// room instead of one process-wide singleton. The room id (this.room.id) is
// the 4-character match code: whoever creates the code connects to that
// room id first (team A), whoever joins with the code connects second
// (team B), same "first two connections" assignment as the LAN arbiter.
const CHAT_COOLDOWN_MS = 30000;

function otherTeam(team) {
  return team === 'A' ? 'B' : 'A';
}

export default class Arbiter {
  constructor(room) {
    this.room = room;
    this.players = { A: null, B: null };
    this.shots = { A: null, B: null };
    this.sweeps = { A: null, B: null };
    // Same per-team rolling cooldown as server/arbiter.js — independent of
    // any match phase, no reset needed on resetRound() below.
    this.lastChatAt = { A: 0, B: 0 };
    // Same match-start handshake as server/arbiter.js's `ready` — both sides
    // must be ready before either actually starts.
    this.ready = { A: false, B: false };
  }

  send(connection, msg) {
    if (connection) connection.send(JSON.stringify(msg));
  }

  resetRound() {
    this.shots = { A: null, B: null };
    this.sweeps = { A: null, B: null };
  }

  onConnect(connection) {
    const team = !this.players.A ? 'A' : !this.players.B ? 'B' : null;
    if (!team) {
      this.send(connection, { type: 'full' });
      connection.close();
      return;
    }
    this.players[team] = connection;
    // Connection state survives for the life of this connection (see
    // PartyKit's connection.setState) — used in onMessage/onClose below
    // instead of re-deriving team from the raw ws connection identity.
    connection.setState({ team });
    this.send(connection, { type: 'joined', team });
    const opponent = this.players[otherTeam(team)];
    if (opponent) {
      this.send(opponent, { type: 'opponentJoined' });
      this.send(connection, { type: 'opponentJoined' });
    }
  }

  onMessage(raw, sender) {
    const team = sender.state?.team;
    if (team !== 'A' && team !== 'B') return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'shots') {
      this.shots[team] = msg.stones;
      this.sweeps[team] = msg.sweep || null;
      if (this.shots.A && this.shots.B) {
        const payload = { type: 'launch', shotsA: this.shots.A, shotsB: this.shots.B, sweepA: this.sweeps.A, sweepB: this.sweeps.B };
        this.send(this.players.A, payload);
        this.send(this.players.B, payload);
        this.resetRound();
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

  onClose(connection) {
    const team = connection.state?.team;
    if (team !== 'A' && team !== 'B') return;
    if (this.players[team] === connection) this.players[team] = null;
    this.resetRound();
    this.lastChatAt[team] = 0; // a fresh reconnect shouldn't inherit a stale cooldown
    this.ready[team] = false; // ditto for a stale "already tapped ready" from a dropped connection
    const remaining = this.players[otherTeam(team)];
    this.send(remaining, { type: 'opponentLeft' });
  }
}
