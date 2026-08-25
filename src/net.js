// Thin client wrapper around the two arbiter backends this game can talk to:
// the local relay for Duel LAN (server/arbiter.js, plain `ws`, mounted at
// ARBITER_PATH by both server/lan-server.js and server/duel-server.js — see
// CLAUDE.md "LAN mode") and the hosted one for Match Réseau (party/arbiter.js
// on PartyKit — see CLAUDE.md "Network match"). Both speak the exact same
// message protocol (party/arbiter.js is a straight port of
// server/arbiter.js) — which team we were assigned, and each round's shot
// vectors once both sides have submitted, no physics/state sync, the two
// clients simulate locally in lockstep — so a single connectSocket() below
// wires up either; only the URL differs.

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
  return connectSocket(arbiterUrl(base));
}

// Match Réseau: same arbiter logic (party/arbiter.js), self-hosted on
// Cloudflare via partyserver/wrangler (see CLAUDE.md "Network match" — this
// replaced the legacy `partykit` CLI/platform, which couldn't deploy a
// free-plan-compatible Durable Object) and addressed by room name instead of
// a LAN address — the 4-character code shown/typed on the host/join screen
// (see main.js) IS that room name (same "first connection = A, second = B"
// assignment as connectLan, just routed by code instead of connection order
// on a shared LAN address). "arbiter" in the URL is partyserver's routing
// namespace, derived from the Arbiter class/Durable Object binding name (see
// party/index.js, wrangler.jsonc). In dev, this points at a locally running
// `npm run wrangler:dev` (localhost:1999) instead of the deployed project —
// same "advanced two-process" pattern already used for LAN dev (npm run
// lan-server + npm run dev -- --host).
const PARTY_HOST = import.meta.env.DEV ? 'ws://localhost:1999' : 'wss://nim-ball.nim-ball.workers.dev';

export function connectMatch(code) {
  return connectSocket(`${PARTY_HOST}/parties/arbiter/${code}`);
}

function connectSocket(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    let launchCb = null;
    let opponentJoinedCb = null;
    let disconnectCb = null;
    let chatCb = null;
    let chatMuteCb = null;
    let bothReadyCb = null;
    let mancheValidCb = null;
    let mancheInvalidCb = null;

    const net = {
      myTeam: null,
      // Match Réseau only (see main.js's hostMatch/showReadyScreen — Duel LAN
      // never sends this, its own matchConfig stays null/undefined and
      // startGame() falls back to Classic, see src/matchConfig.js): the room
      // creator's chosen rules, sent once right after connecting and stored
      // server-side (party/arbiter.js) so a joiner receives it back in its
      // own 'joined' message below instead of choosing its own.
      matchConfig: null,
      sendMatchConfig(config) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'matchConfig', config }));
      },
      // Creator only, sent right before close() when leaving the "share this
      // code" screen with nobody having joined yet (see main.js's
      // matchNetworkBackBtn) — the room refuses any further connection after
      // this, which is the closest thing to "invalidating" a code that's
      // really just this room's own name (see party/arbiter.js's `closed`).
      cancelRoom() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancelRoom' }));
      },
      sendShots(stones, sweep = null) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'shots', stones, sweep }));
      },
      // Sync-check (see CLAUDE.md determinism work / game.js's
      // computeMancheResult): the settled outcome each client's own headless
      // fast-forward reaches right at launch, tagged with the same
      // mancheIndex the arbiter stamped that launch with — see onLaunch below.
      sendMancheResult(mancheIndex, result) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mancheResult', mancheIndex, result }));
      },
      // Sent when the local player taps the LAN lobby's "Prêt" button (see
      // main.js's showReadyScreen) — the arbiter only tells either side to
      // actually start (onBothReady below) once BOTH have sent this. Without
      // that handshake, whichever player clicked first could start their own
      // match (and start chatting) while the other was still sitting on the
      // lobby screen with no startGame()/onChat() wired up yet to receive
      // anything — messages sent into that gap were silently dropped.
      sendReady() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ready' }));
      },
      // Unlimited count, but the arbiter enforces at most one every
      // CHAT_COOLDOWN_MS per team (see server/arbiter.js) — text is
      // truncated again server-side too; this is just UX, not the real
      // enforcement (a modified client could send anything here). Always a
      // real typed message — the mute toggle has its own sendChatMute below,
      // on a separate channel that doesn't share this cooldown at all.
      sendChat(text) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'chat', text }));
      },
      // Unlimited/instant, unlike sendChat above — this is a status toggle,
      // not chat content, so it shouldn't compete with the chat cooldown
      // (see game.js's maybeAutoSyncMute).
      sendChatMute(muted) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'chatMute', muted }));
      },
      onLaunch(cb) { launchCb = cb; },
      onOpponentJoined(cb) { opponentJoinedCb = cb; },
      onDisconnect(cb) { disconnectCb = cb; },
      onChat(cb) { chatCb = cb; },
      onChatMute(cb) { chatMuteCb = cb; },
      onBothReady(cb) { bothReadyCb = cb; },
      onMancheValid(cb) { mancheValidCb = cb; },
      onMancheInvalid(cb) { mancheInvalidCb = cb; },
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
        net.matchConfig = msg.matchConfig || null;
        settled = true;
        resolve(net);
      } else if (msg.type === 'full') {
        if (!settled) { settled = true; reject(new Error('Partie déjà complète.')); }
        ws.close();
      } else if (msg.type === 'closed') {
        if (!settled) { settled = true; reject(new Error('Ce code de partie n’est plus valide.')); }
        ws.close();
      } else if (msg.type === 'opponentJoined') {
        if (opponentJoinedCb) opponentJoinedCb();
      } else if (msg.type === 'opponentLeft') {
        if (disconnectCb) disconnectCb();
      } else if (msg.type === 'launch') {
        if (launchCb) launchCb({ shotsA: msg.shotsA, shotsB: msg.shotsB, sweepA: msg.sweepA, sweepB: msg.sweepB, mancheIndex: msg.mancheIndex });
      } else if (msg.type === 'chat') {
        if (chatCb) chatCb({ team: msg.team, text: msg.text });
      } else if (msg.type === 'chatMute') {
        if (chatMuteCb) chatMuteCb({ team: msg.team, muted: !!msg.muted });
      } else if (msg.type === 'bothReady') {
        if (bothReadyCb) bothReadyCb();
      } else if (msg.type === 'mancheValid') {
        if (mancheValidCb) mancheValidCb({ mancheIndex: msg.mancheIndex });
      } else if (msg.type === 'mancheInvalid') {
        if (mancheInvalidCb) mancheInvalidCb({ mancheIndex: msg.mancheIndex, resultA: msg.resultA, resultB: msg.resultB });
      }
    });
  });
}
