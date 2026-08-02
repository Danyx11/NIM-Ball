// Shared WebSocket arbiter for Nim-Curl's "Duel LAN" mode (see CLAUDE.md).
// Used both by the standalone server/lan-server.js (own dedicated port) and
// server/duel-server.js (attached to the same http server as the Vite dev
// middleware, mounted at a distinct path so it doesn't collide with Vite's
// own HMR websocket on the same port).
//
// Holds exactly one 2-player session: relays each side's chosen shots for
// the current round and, once both are in, broadcasts them to both clients.
// No physics runs here — each client simulates locally from the same
// synced shot vectors (see src/net.js / src/game.js). No matchmaking, no
// multiple parallel games, no reconnection handling — out of scope for the
// local-wifi-testing use case this exists for.
import { WebSocketServer } from 'ws';

export const ARBITER_PATH = '/duel-ws';

export function createArbiter(wssOptions) {
  let players = { A: null, B: null };
  let shots = { A: null, B: null };
  let sweeps = { A: null, B: null };
  // Chat: unlimited count, but at most one message every CHAT_COOLDOWN_MS per
  // team (see CLAUDE.md / src/game.js's chat wiring) — enforced here, not
  // just client-side, since a client is trivially editable. A flat rolling
  // cooldown rather than a per-manche quota, so it's independent of the
  // game's own phase machine — no reset needed on resetRound() below.
  const CHAT_COOLDOWN_MS = 30000;
  let lastChatAt = { A: 0, B: 0 };
  // Match-start handshake (see src/main.js's showReadyScreen /
  // src/net.js's sendReady): both sides must tap "Prêt" before EITHER
  // actually starts, so a fast player can't begin chatting into a match the
  // other side hasn't wired up yet (their onChat() isn't registered until
  // startGame() runs) — those messages used to just vanish.
  let ready = { A: false, B: false };

  function send(ws, msg) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
  function otherTeam(team) {
    return team === 'A' ? 'B' : 'A';
  }
  function resetRound() {
    shots = { A: null, B: null };
    sweeps = { A: null, B: null };
  }

  const wss = new WebSocketServer({ ...wssOptions, path: ARBITER_PATH });

  wss.on('connection', (ws) => {
    const team = !players.A ? 'A' : !players.B ? 'B' : null;
    if (!team) {
      send(ws, { type: 'full' });
      ws.close();
      return;
    }
    players[team] = ws;
    send(ws, { type: 'joined', team });
    const opponent = players[otherTeam(team)];
    if (opponent) {
      send(opponent, { type: 'opponentJoined' });
      send(ws, { type: 'opponentJoined' });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'shots' && (team === 'A' || team === 'B')) {
        shots[team] = msg.stones;
        sweeps[team] = msg.sweep || null;
        if (shots.A && shots.B) {
          const payload = { type: 'launch', shotsA: shots.A, shotsB: shots.B, sweepA: sweeps.A, sweepB: sweeps.B };
          send(players.A, payload);
          send(players.B, payload);
          resetRound();
        }
      } else if (msg.type === 'chat' && (team === 'A' || team === 'B')) {
        const now = Date.now();
        if (now - lastChatAt[team] < CHAT_COOLDOWN_MS) return; // still cooling down
        // Array.from(...) rather than a plain string slice — a plain
        // text.slice(0, 30) counts UTF-16 code units, which can split an
        // emoji's surrogate pair in half; Array.from splits on whole
        // codepoints instead (see CHAT_EMOJI in game.js).
        const text = typeof msg.text === 'string'
          ? Array.from(msg.text.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 30).join('')
          : '';
        if (!text) return;
        lastChatAt[team] = now;
        const payload = { type: 'chat', team, text };
        send(players.A, payload);
        send(players.B, payload);
      } else if (msg.type === 'chatMute' && (team === 'A' || team === 'B')) {
        // Deliberately NOT cooldown-tracked like chat above — this is a
        // status toggle (see src/game.js's tbtn-chat), not chat content.
        // Always relayed immediately, as often as it changes.
        const payload = { type: 'chatMute', team, muted: !!msg.muted };
        send(players.A, payload);
        send(players.B, payload);
      } else if (msg.type === 'ready' && (team === 'A' || team === 'B')) {
        ready[team] = true;
        if (ready.A && ready.B) {
          const payload = { type: 'bothReady' };
          send(players.A, payload);
          send(players.B, payload);
        }
      }
    });

    ws.on('close', () => {
      if (players[team] === ws) players[team] = null;
      resetRound();
      lastChatAt[team] = 0; // a fresh reconnect shouldn't inherit a stale cooldown
      ready[team] = false; // ditto for a stale "already tapped ready" from a dropped connection
      const remaining = players[otherTeam(team)];
      if (remaining) send(remaining, { type: 'opponentLeft' });
    });
  });

  return wss;
}
