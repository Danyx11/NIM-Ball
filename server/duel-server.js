// Simple one-command "just play" LAN flow: serves the game (via Vite's dev
// middleware — no build step) and the WebSocket arbiter (see server/arbiter.js)
// on the SAME http server/port, so there's only one address to share instead
// of two. Player 1 runs `npm run duel`, gets a single link, sends it to
// player 2 (and opens it themselves too) — the game auto-connects both to
// "Duel LAN" with no address to type (see the `?duel` handling in src/main.js).
// See CLAUDE.md "LAN mode".
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { createArbiter, ARBITER_PATH } from './arbiter.js';
import { lanAddresses } from './lan-addresses.js';

const PORT = Number(process.env.PORT) || 5173;

// Created bare first, then handed to Vite as its HMR upgrade target and
// given vite.middlewares as its request handler — Vite's middlewareMode
// doesn't create/attach a real server on its own, so both the page requests
// and the HMR websocket need to be wired to this one explicitly.
const httpServer = createHttpServer();

const vite = await createViteServer({
  server: { middlewareMode: true, ws: { server: httpServer } },
  appType: 'spa',
});

httpServer.on('request', vite.middlewares);

// The arbiter is created in noServer mode and routed manually by path,
// rather than passed `{server: httpServer}` directly: two independent `ws`
// WebSocketServer instances attached to the same raw server both react to
// EVERY 'upgrade' event unconditionally (their `path` option only decides
// whether to accept — a mismatch still aborts the socket), so the arbiter's
// own instance was destroying Vite's already-established HMR handshake on
// every non-matching request. Manually checking the path first and only
// ever handing matching requests to the arbiter avoids touching Vite's own.
const arbiterWss = createArbiter({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === ARBITER_PATH) {
    arbiterWss.handleUpgrade(req, socket, head, (ws) => {
      arbiterWss.emit('connection', ws, req);
    });
  }
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT=<other> npm run duel to pick a different one.`);
  } else {
    console.error('Duel server error:', err);
  }
  process.exit(1);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  const addr = addrs[0];
  console.log('');
  console.log('  Nim-Curl — Duel LAN prêt !');
  console.log('');
  if (addr) {
    console.log('  Envoie ce lien à l\'autre joueur (et ouvre-le toi aussi) :');
    console.log('');
    console.log(`      http://${addr}:${PORT}/?duel`);
    console.log('');
    console.log('  Les deux MacBook doivent être sur le même Wi-Fi.');
  } else {
    console.log(`  Aucune interface réseau trouvée — utilise http://localhost:${PORT}/?duel pour tester sur cette machine.`);
  }
  console.log('');
});
