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

  function send(ws, msg) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
  function otherTeam(team) {
    return team === 'A' ? 'B' : 'A';
  }
  function resetRound() {
    shots = { A: null, B: null };
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
        if (shots.A && shots.B) {
          const payload = { type: 'launch', shotsA: shots.A, shotsB: shots.B };
          send(players.A, payload);
          send(players.B, payload);
          resetRound();
        }
      }
    });

    ws.on('close', () => {
      if (players[team] === ws) players[team] = null;
      resetRound();
      const remaining = players[otherTeam(team)];
      if (remaining) send(remaining, { type: 'opponentLeft' });
    });
  });

  return wss;
}
