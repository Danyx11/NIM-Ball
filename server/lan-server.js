// Standalone WebSocket arbiter for Nim-Curl's "Duel LAN" mode — the advanced
// two-process flow (paired with `npm run dev -- --host`), useful when you
// want the Vite dev server and the arbiter as separate processes (e.g. while
// iterating on code). For just playing, `npm run duel` (server/duel-server.js)
// is simpler: one process, one link, no separate ws:// address to copy.
// See CLAUDE.md "LAN mode".
import { createArbiter } from './arbiter.js';
import { lanAddresses } from './lan-addresses.js';

// See server/duel-server.js's identical block — TELEGRAM_BOT_TOKEN/CHAT_ID
// live in .env, gitignored.
try { process.loadEnvFile(); } catch { /* no .env — alert stays silently off */ }

const PORT = Number(process.env.PORT) || 8787;

const wss = createArbiter({ port: PORT });

wss.on('listening', () => {
  console.log(`Nim-Curl LAN server listening on port ${PORT}`);
  const addrs = lanAddresses();
  if (addrs.length === 0) {
    console.log(`  No LAN interface found — use ws://localhost:${PORT} for same-machine testing.`);
  }
  for (const addr of addrs) {
    console.log(`  Share with player 2: ws://${addr}:${PORT}`);
  }
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT=<other> npm run lan-server to pick a different one.`);
  } else {
    console.error('LAN server error:', err);
  }
  process.exit(1);
});
