// Thin client wrapper around the LAN arbiter (server/arbiter.js, mounted at
// ARBITER_PATH by both server/lan-server.js and server/duel-server.js — see
// CLAUDE.md "LAN mode"). Only relays two things: which team we were
// assigned, and each round's shot vectors once both sides have submitted —
// no physics/state sync, the two clients simulate locally in lockstep.

// Kept in sync with server/arbiter.js's ARBITER_PATH (not imported directly —
// that file only runs under Node, this one only in the browser bundle).
const ARBITER_PATH = '/duel-ws';

// Accepts either a bare "ws://host:port" (what players type/share) or a full
// "ws://host:port/duel-ws" — always resolves to the latter.
function arbiterUrl(base) {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith(ARBITER_PATH) ? trimmed : trimmed + ARBITER_PATH;
}

export function connectLan(base) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(arbiterUrl(base));
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    let launchCb = null;
    let opponentJoinedCb = null;
    let disconnectCb = null;

    const net = {
      myTeam: null,
      sendShots(stones, sweep = null) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'shots', stones, sweep }));
      },
      onLaunch(cb) { launchCb = cb; },
      onOpponentJoined(cb) { opponentJoinedCb = cb; },
      onDisconnect(cb) { disconnectCb = cb; },
      close() { ws.close(); },
    };

    ws.addEventListener('error', () => {
      if (!settled) { settled = true; reject(new Error('Connexion au serveur impossible.')); }
    });

    ws.addEventListener('close', () => {
      if (!settled) { settled = true; reject(new Error('Connexion au serveur impossible.')); return; }
      if (disconnectCb) disconnectCb();
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'joined') {
        net.myTeam = msg.team;
        settled = true;
        resolve(net);
      } else if (msg.type === 'full') {
        if (!settled) { settled = true; reject(new Error('Partie déjà complète.')); }
        ws.close();
      } else if (msg.type === 'opponentJoined') {
        if (opponentJoinedCb) opponentJoinedCb();
      } else if (msg.type === 'opponentLeft') {
        if (disconnectCb) disconnectCb();
      } else if (msg.type === 'launch') {
        if (launchCb) launchCb({ shotsA: msg.shotsA, shotsB: msg.shotsB, sweepA: msg.sweepA, sweepB: msg.sweepB });
      }
    });
  });
}
