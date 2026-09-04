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

// ---------------------------------------------------------------------
// WEEK (party/weekArbiter.js) — a different transport shape from the LIVE/
// LAN relay above: no held-open "wait for a push" connection anywhere. Every
// call here opens a fresh WebSocket, sends one request, waits for its one
// reply, and the caller decides whether to keep the socket or close it (see
// the WEEK design conversation — always connect/fetch/act/disconnect, even
// when both players happen to be online at once). Requires a connected
// Nimiq wallet address (no guest, see main.js's WEEK wallet gate) — that
// address IS the reconnection credential, no separate claim token.
function weekHttpHost() { return PARTY_HOST.replace(/^ws/, 'http'); }
// Nimiq's own user-friendly address format is space-separated ("NQ07 XXXX
// YYYY …") — fine as a URLSearchParams value (auto-encoded) but breaks a
// plain template-literal URL path segment (fetchMyWeekMatches below) and is
// an unnecessary footgun as a Durable Object room name either way. Every
// WEEK function below normalizes to this same spaceless form before using
// an address as an identifier, so a match created from one and looked up
// from the other still land on the same PlayerIndex/WeekArbiter room.
function normalizeAddress(address) { return address.replace(/\s+/g, ''); }

// Opens the connection for a WEEK match, either creating one fresh (`intent:
// 'create'`, needs `game`/`config`) or joining/resuming an existing one
// (`intent: 'join'` — a returning A or B looks identical to a fresh join to
// the arbiter, see party/weekArbiter.js's onConnect). Resolves once the
// server's first reply ('connected') arrives, same "first message settles
// the promise" shape as connectSocket() above.
function openWeekSocket(code, address, intent, extra = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ address, intent });
    if (extra.game) params.set('game', extra.game);
    if (extra.config) params.set('config', JSON.stringify(extra.config));
    const url = `${PARTY_HOST}/parties/week-arbiter/${code}?${params.toString()}`;
    let ws;
    try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
    let settled = false;
    // WEEK's protocol is strictly one-request/one-reply, so a simple FIFO
    // queue (rather than matching replies by an id) is enough: onMessage
    // below always hands the next frame to the oldest still-waiting request.
    const pending = [];
    const socket = {
      code,
      request(msg) {
        return new Promise((res, rej) => {
          pending.push({ res, rej });
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
          else rej(new Error('Not connected.'));
        });
      },
      close() { ws.close(); },
    };
    ws.addEventListener('error', () => {
      if (!settled) { settled = true; reject(new Error('Could not connect to the server.')); }
    });
    ws.addEventListener('close', () => {
      if (!settled) { settled = true; reject(new Error('Could not connect to the server.')); }
      while (pending.length) pending.shift().rej(new Error('Connection closed.'));
    });
    ws.addEventListener('message', (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (!settled) {
        settled = true;
        if (msg.type === 'connected') { resolve({ socket, snapshot: msg }); return; }
        const errors = {
          occupied: 'This code is already in use — try again.',
          limitReached: 'You already have 2 active WEEK matches.',
          notFound: 'This match code is no longer valid.',
          expired: 'This challenge has expired.',
          full: 'This match already has two players.',
        };
        // `.reason` (the raw server code, e.g. 'notFound') lets a caller
        // branch on the exact failure instead of string-matching the human
        // message above — main.js's "Join with a code" uses this to decide
        // whether a WEEK lookup miss should fall through to trying LIVE.
        const err = new Error(errors[msg.type] || 'Could not join this match.');
        err.reason = msg.type;
        reject(err);
        return;
      }
      const waiter = pending.shift();
      if (waiter) waiter.res(msg);
    });
  });
}

function weekMatchHandle(socket, snapshot) {
  const { type: _type, ...rest } = snapshot;
  return {
    code: socket.code,
    ...rest,
    // { stones, sweep, message } in, resolves with the fresh snapshot (see
    // WeekArbiter's 'shotAccepted' reply) — including the opponent's shot
    // and message once both sides have submitted for this round.
    async sendShot(stones, sweep, message) {
      return socket.request({ type: 'shot', stones, sweep, message });
    },
    // Reports the locally-computed outcome of a revealed manche (this game
    // never runs physics server-side, see CLAUDE.md) so the persisted match
    // state (score/round) advances for whoever reconnects next. `manche`
    // ({stonesA, sweepA, stonesB, sweepB} — the shot data just revealed) is
    // appended server-side to pointManches unless this manche just scored a
    // point, see party/weekArbiter.js's own completeRound handler — needed
    // so the *next* manche of the same point (could be seconds or days
    // later) can reconstruct the board via resumeManches.
    async completeRound(scoreA, scoreB, manche) {
      return socket.request({ type: 'completeRound', scoreA, scoreB, ...manche });
    },
    // Either side can abandon at any point before the match is already over
    // (see party/weekArbiter.js's own 'abandon' handler) — frees this
    // player's PlayerIndex slot immediately, used by the trash icon on each
    // My Matches row (main.js).
    async abandon() {
      return socket.request({ type: 'abandon' });
    },
    close() { socket.close(); },
  };
}

export async function createWeekMatch(code, address, game, config) {
  const { socket, snapshot } = await openWeekSocket(code, normalizeAddress(address), 'create', { game, config });
  return weekMatchHandle(socket, snapshot);
}

export async function joinWeekMatch(code, address) {
  const { socket, snapshot } = await openWeekSocket(code, normalizeAddress(address), 'join');
  return weekMatchHandle(socket, snapshot);
}

// "My Matches" (main.js) — a plain GET against this address's PlayerIndex
// room, not a WebSocket: a one-off read, nothing to hold open (see
// party/playerIndex.js). Returns {} on any failure so the UI can render an
// empty list instead of an error for what's a non-critical convenience
// feature — the match code itself is always the real way back in.
export async function fetchMyWeekMatches(address) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/player-index/${normalizeAddress(address)}`);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
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
      // Match Réseau only, same as matchConfig just above (see its own
      // comment) — the creator's chosen vibe (hockey/curling), sent
      // alongside the rules config so a joiner can't end up simulating a
      // different vibe than the room it just connected to (see main.js's
      // showMatchChoiceScreen/joinMatch, which force their local activeVibe
      // to match this instead of trusting whatever tile the joiner happened
      // to pick before typing the code in).
      vibe: null,
      sendMatchConfig(config, vibe) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'matchConfig', config, vibe }));
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
      if (!settled) { settled = true; reject(new Error('Could not connect to the server.')); }
    });

    ws.addEventListener('close', () => {
      if (!settled) { settled = true; reject(new Error('Could not connect to the server.')); return; }
      if (disconnectCb) disconnectCb();
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'joined') {
        net.myTeam = msg.team;
        net.matchConfig = msg.matchConfig || null;
        net.vibe = msg.vibe || null;
        settled = true;
        resolve(net);
      } else if (msg.type === 'full') {
        if (!settled) { settled = true; reject(new Error('Match already full.')); }
        ws.close();
      } else if (msg.type === 'closed') {
        if (!settled) { settled = true; reject(new Error('This match code is no longer valid.')); }
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
