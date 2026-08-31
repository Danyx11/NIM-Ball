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

// Sync-check Telegram alert (see CLAUDE.md determinism work) — a real
// cross-client divergence should be extremely rare, so rather than requiring
// someone to babysit a console during a beta, the arbiter itself pings a
// Telegram chat the moment it happens. Reads TELEGRAM_BOT_TOKEN/
// TELEGRAM_CHAT_ID from process.env (see server/duel-server.js's/
// lan-server.js's process.loadEnvFile() — .env, gitignored); silently does
// nothing if either is unset, so this is fully optional. Same shape (a/b/
// ball/result) as game.js's quantizeMancheResult — see that file's
// diffMancheResults for the client-side console equivalent.
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
async function sendSyncMismatchAlert(mancheIndex, resultA, resultB) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
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

export function createArbiter(wssOptions) {
  let players = { A: null, B: null };
  let shots = { A: null, B: null };
  let sweeps = { A: null, B: null };
  // Sync-check (see CLAUDE.md determinism work): each launch gets a fresh
  // index so a client's mancheResult can be matched to the manche it was
  // actually computed from — a client that's mid-reconnect or briefly behind
  // can't have its stale result compared against the current one.
  // mancheResults holds each side's post-settle state/checksum for the
  // manche currently awaiting validation; null once compared (see the
  // 'mancheResult' branch below) or on disconnect.
  let mancheIndex = 0;
  let pendingMancheIndex = null;
  let mancheResults = { A: null, B: null };
  // Chat: unlimited count, but at most one message every CHAT_COOLDOWN_MS per
  // team (see CLAUDE.md / src/game.js's chat wiring) — enforced here, not
  // just client-side, since a client is trivially editable. A flat rolling
  // cooldown rather than a per-manche quota, so it's independent of the
  // game's own phase machine — no reset needed on resetRound() below.
  const CHAT_COOLDOWN_MS = 20000;
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
  function resetManche() {
    pendingMancheIndex = null;
    mancheResults = { A: null, B: null };
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
          mancheIndex++;
          const payload = { type: 'launch', shotsA: shots.A, shotsB: shots.B, sweepA: sweeps.A, sweepB: sweeps.B, mancheIndex };
          send(players.A, payload);
          send(players.B, payload);
          resetRound();
          pendingMancheIndex = mancheIndex;
          mancheResults = { A: null, B: null };
        }
      } else if (msg.type === 'mancheResult' && (team === 'A' || team === 'B')) {
        // Sync-check: each client fast-forwards its own physics headlessly
        // right at launch (see game.js) and reports the settled outcome here
        // — this arbiter only ever compares the two opaque results, it never
        // interprets/corrects them (see CLAUDE.md determinism work). A
        // result tagged with a manche we're not currently waiting on (stale
        // retry, reconnect) is silently dropped.
        if (msg.mancheIndex !== pendingMancheIndex) return;
        mancheResults[team] = msg.result;
        if (mancheResults.A !== null && mancheResults.B !== null) {
          const valid = JSON.stringify(mancheResults.A) === JSON.stringify(mancheResults.B);
          // Echoing both raw results back on a mismatch is still just relaying
          // opaque data the arbiter never interprets/acts on (see above) — it
          // only lets each client's own dev build console-log a field-by-field
          // diff of what actually diverged (see game.js's diffMancheResults),
          // instead of just knowing "the manche was invalid".
          const payload = valid
            ? { type: 'mancheValid', mancheIndex: pendingMancheIndex }
            : { type: 'mancheInvalid', mancheIndex: pendingMancheIndex, resultA: mancheResults.A, resultB: mancheResults.B };
          send(players.A, payload);
          send(players.B, payload);
          if (!valid) sendSyncMismatchAlert(pendingMancheIndex, mancheResults.A, mancheResults.B);
          resetManche();
        }
      } else if (msg.type === 'chat' && (team === 'A' || team === 'B')) {
        const now = Date.now();
        if (now - lastChatAt[team] < CHAT_COOLDOWN_MS) return; // still cooling down
        // Array.from(...) rather than a plain string slice — a plain
        // text.slice(0, 60) counts UTF-16 code units, which can split an
        // emoji's surrogate pair in half; Array.from splits on whole
        // codepoints instead (see CHAT_EMOJI in game.js).
        const text = typeof msg.text === 'string'
          ? Array.from(msg.text.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 60).join('')
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
      resetManche();
      lastChatAt[team] = 0; // a fresh reconnect shouldn't inherit a stale cooldown
      ready[team] = false; // ditto for a stale "already tapped ready" from a dropped connection
      const remaining = players[otherTeam(team)];
      if (remaining) send(remaining, { type: 'opponentLeft' });
    });
  });

  return wss;
}
