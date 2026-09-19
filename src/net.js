// Thin client wrapper around the two arbiter backends this game can talk to:
// the local relay for Duel LAN (server/arbiter.js, plain `ws`, mounted at
// ARBITER_PATH by both server/lan-server.js and server/duel-server.js — see
// CLAUDE.md "LAN mode") and the hosted one for LIVE (party/arbiter.js, a
// Durable Object on Cloudflare via partyserver + wrangler — NOT PartyKit,
// which this migrated off; see CLAUDE.md "Production remote backend" and the
// PARTY_HOST comment below). Both speak the exact same
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

// `address` is optional and purely informational (NIM-Curl Radar, see
// party/arbiter.js/party/radar.js) — a connected wallet's address, or
// omitted entirely for a guest (see src/main.js's getIdentity()). Never
// gates matchmaking the way WEEK's own address requirement does — LIVE stays
// guest-playable either way.
export function connectMatch(code, address = null) {
  const suffix = address ? `?address=${encodeURIComponent(normalizeAddress(address))}` : '';
  return connectSocket(`${PARTY_HOST}/parties/arbiter/${code}${suffix}`);
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
// Exported (not just used internally) so callers outside this module — e.g.
// src/main.js's League panel, comparing hubAddress (raw, possibly
// space-separated) against addresses returned by party/leagueSeason.js
// (already normalized server-side, same as every other stored address here)
// — can normalize before comparing instead of duplicating this regex.
export function normalizeAddress(address) { return address.replace(/\s+/g, ''); }

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
      isOpen() { return ws.readyState === WebSocket.OPEN; },
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
          limitReached: 'You already have 5 active WEEK matches.',
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

function weekMatchHandle(socket, snapshot, address) {
  const { type: _type, ...rest } = snapshot;
  const code = socket.code;
  let live = socket;
  // Held when a reconnect's own 'connected' frame carried a message — see
  // withCarriedInbox below.
  let carriedInbox = null;

  // This file's header describes WEEK as connect/fetch/act/disconnect, but
  // one socket was in fact being kept for a whole sitting — and a WEEK turn
  // is an unbounded human pause (the player is aiming) during which nothing
  // travels over it. An idle WebSocket gets dropped by the edge, or by a
  // phone changing network, and the next action then failed outright: the
  // match existed but the shot it was carrying never arrived, surfaced to
  // the player as a bare "Not connected." (reported). So don't assume the
  // socket survived — reopen and retry once. 'join' is the right intent for
  // a reconnect: party/weekArbiter.js's onConnect treats a returning player
  // exactly like a fresh join.
  async function request(msg) {
    if (live.isOpen()) {
      try {
        return withCarriedInbox(await live.request(msg));
      } catch {
        // Dropped mid-flight (the close handler rejects everything queued) —
        // fall through and try once on a fresh socket.
      }
    }
    let reopened;
    try {
      reopened = await openWeekSocket(code, address, 'join');
    } catch (err) {
      // A reconnect can fail for a reason the player actually needs to see
      // (the match expired, or the opponent abandoned it) — those carry
      // .reason and keep their own wording. Anything else is the connection
      // problem it is, said in words a player can act on rather than
      // "Not connected."
      throw err.reason ? err : new Error('Connection lost — try again.');
    }
    live = reopened.socket;
    // onConnect consumes the inbox, so reconnecting silently would swallow a
    // message the opponent had left. Carry it onto the reply the caller is
    // about to merge (main.js's mergeWeek reads inboxMessage off it).
    if (reopened.snapshot.inboxMessage) carriedInbox = reopened.snapshot.inboxMessage;
    return withCarriedInbox(await live.request(msg));
  }
  function withCarriedInbox(reply) {
    if (carriedInbox && reply && typeof reply === 'object') {
      reply.inboxMessage = carriedInbox;
      carriedInbox = null;
    }
    return reply;
  }

  return {
    code,
    ...rest,
    // { stones, sweep } in, resolves with the fresh snapshot (see
    // WeekArbiter's 'shotAccepted' reply) — including the opponent's shot
    // once both sides have submitted for this round. No message anymore —
    // see sendMessage below, a fully separate, optional, later action (a
    // message belongs to its recipient, not to this shot — see conversation).
    async sendShot(stones, sweep) {
      return request({ type: 'shot', stones, sweep });
    },
    // Leaves a message for the opponent — reachable any time after this
    // team has already submitted its own shot for the current manche (the
    // "YOUR SHOT IS ON THE ICE" screen, see main.js), not gathered before
    // sending. Overwrites this recipient's one message slot (see
    // party/weekArbiter.js's own inbox/consumeInbox — no unread/multi-
    // message queue for now, per explicit request).
    async sendMessage(text) {
      return request({ type: 'message', message: text });
    },
    // Reports the locally-computed outcome of a revealed manche (this game
    // never runs physics server-side, see CLAUDE.md) so the persisted match
    // state (score/round/lastManche) advances. `scoredTeam` ('A'|'B'|null)
    // is a delta, not an absolute score — the server owns scoreA/scoreB and
    // accumulates it server-side (see party/weekArbiter.js's own
    // completeRound handler and its comment on the score-persistence bug
    // this replaced: a client-computed absolute total reset to whatever a
    // fresh, freshly-zeroed game.js session happened to compute locally).
    // Also doubles as "I've now personally watched the match's last
    // manche" for a team who's independently catching up on one the other
    // side already reported — see that same handler for why this needed
    // splitting from "clear pendingShots for the next manche" in the first
    // place (each side's own reveal progress must stay independent).
    // collisionsDelta/stonesDestroyedDelta (both optional, default 0): this
    // manche's own contribution to the match ticket's running stats (see
    // party/weekArbiter.js's own accumulation, and main.js's
    // showWeekMatchTicket) — only meaningful the FIRST time a given manche
    // is reported (the server only applies them on that same branch, see its
    // own comment; a later "I've now watched it too" ack from the other side
    // sends these too but they're simply ignored there).
    async completeRound(scoredTeam, collisionsDelta = 0, stonesDestroyedDelta = 0) {
      return request({ type: 'completeRound', scoredTeam, collisionsDelta, stonesDestroyedDelta });
    },
    // Either side can abandon at any point before the match is already over
    // (see party/weekArbiter.js's own 'abandon' handler) — frees this
    // player's PlayerIndex slot immediately, used by the trash icon on each
    // My Matches row (main.js). Also reachable from a *completed* match's
    // own ticket screen now, as a decline when the opponent's already
    // waiting on a rematch (see main.js's showWeekMatchTicket) — same
    // "your opponent has left" result either way.
    async abandon() {
      return request({ type: 'abandon' });
    },
    // "Play Again" from the match-complete ticket (see party/weekArbiter.js's
    // own 'rematch' handler + main.js's showWeekMatchTicket) — resolves with
    // { type: 'rematchStarted', ...snapshot } once BOTH sides have called
    // this (the same room, reset for another round), or
    // { type: 'rematchWaiting', ...snapshot } if only this side has so far.
    async rematch() {
      return request({ type: 'rematch' });
    },
    close() { live.close(); },
  };
}

export async function createWeekMatch(code, address, game, config) {
  const normalized = normalizeAddress(address);
  const { socket, snapshot } = await openWeekSocket(code, normalized, 'create', { game, config });
  return weekMatchHandle(socket, snapshot, normalized);
}

export async function joinWeekMatch(code, address) {
  const normalized = normalizeAddress(address);
  const { socket, snapshot } = await openWeekSocket(code, normalized, 'join');
  return weekMatchHandle(socket, snapshot, normalized);
}

// Existence probe for a WEEK code, with no wallet address required — used by
// "Join with a code" (main.js's joinWithCode) for a not-yet-connected player,
// who otherwise has no way to open a WEEK connection at all (onConnect in
// party/weekArbiter.js requires an address on every attempt). Lets that
// screen tell a real WEEK code apart from a LIVE code (or a code that
// matches nothing) BEFORE routing anywhere, instead of falling through to
// LIVE's guest join and silently spinning up an unrelated empty room under
// the same code string. Best-effort like fetchMyWeekMatches above — resolves
// to `false` on any network failure rather than throwing, so a hiccup here
// just falls through to the existing LIVE guest flow instead of stranding
// the player.
export async function checkWeekMatchExists(code) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/week-arbiter/${code}`);
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.exists;
  } catch {
    return false;
  }
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

// Clears one row from this address's own My Matches list — used for a match
// this player didn't abandon themselves but was told about ("your opponent
// has left this game", see party/weekArbiter.js's own abandon handler): a
// direct PlayerIndex write, not a reconnect to the match itself (already
// terminal, nothing left to coordinate there). Best-effort like
// fetchMyWeekMatches above — a failure here just means the row reappears
// next time the list loads, not a broken match.
export async function dismissWeekMatch(address, code) {
  try {
    await fetch(`${weekHttpHost()}/parties/player-index/${normalizeAddress(address)}?code=${encodeURIComponent(code)}`, { method: 'DELETE' });
  } catch {
    // best-effort, see comment above
  }
}

// ---------------------------------------------------------------------
// League Beta (party/leagueSeason.js) — a plain HTTP GET, same one-off
// "connect/fetch/act, nothing held open" shape as fetchMyWeekMatches above,
// against the one fixed-name Durable Object for the current season.
// LEAGUE_SEASON_ID mirrors party/leagueRating.js's CURRENT_SEASON_ID —
// duplicated rather than imported, same src//party bundle-boundary reason
// as normalizeAddress's own WEEK-address comment above (party/ is a
// separate Cloudflare Worker bundle, never shared code with the browser
// build). Keep the two in sync by hand if the season ever changes.
const LEAGUE_SEASON_ID = 'beta-2026';

// Best-effort like fetchMyWeekMatches — returns null on any failure so the
// League panel can render a "couldn't load" state instead of throwing.
export async function fetchLeagueStats(address) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/league-season/${LEAGUE_SEASON_ID}?address=${encodeURIComponent(normalizeAddress(address))}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchLeagueLeaderboard(limit = 20) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/league-season/${LEAGUE_SEASON_ID}?leaderboard=1&limit=${limit}`);
    if (!res.ok) return { leaderboard: [] };
    return await res.json();
  } catch {
    return { leaderboard: [] };
  }
}

// Mirrors fetchLeagueLeaderboard above but hits the weekly variant of
// party/leagueSeason.js's onRequest.
export async function fetchLeagueWeeklyLeaderboard(limit = 20) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/league-season/${LEAGUE_SEASON_ID}?leaderboard=1&weekly=1&limit=${limit}`);
    if (!res.ok) return { leaderboard: [] };
    return await res.json();
  } catch {
    return { leaderboard: [] };
  }
}

// Partnership booking (party/partnership.js) — single fixed room, same
// weekHttpHost() plain-fetch shape as League above. Booking state, not
// payment verification (see that file's own header comment) — these are
// thin wrappers, every actual rule (availability, ownership, expiry) lives
// server-side.
const PARTNERSHIP_ROOM_NAME = 'v1'; // must match party/partnership.js's own PARTNERSHIP_ROOM_NAME

// Best-effort like fetchLeagueLeaderboard — returns an empty list on any
// failure so a future week-picker panel can render a "couldn't load" state
// instead of throwing.
export async function fetchPartnershipWeeks(wallet) {
  try {
    const q = wallet ? `?wallet=${encodeURIComponent(wallet)}` : '';
    const res = await fetch(`${weekHttpHost()}/parties/partnership/${PARTNERSHIP_ROOM_NAME}${q}`);
    if (!res.ok) return { weeks: [] };
    return await res.json();
  } catch {
    return { weeks: [] };
  }
}

async function postPartnership(action, body) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/partnership/${PARTNERSHIP_ROOM_NAME}?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function reservePartnershipWeeks(weekIds, wallet) { return postPartnership('reserve', { weekIds, wallet }); }
export function releasePartnershipWeeks(weekIds, wallet) { return postPartnership('release', { weekIds, wallet }); }
// No amount is sent here any more — party/partnership.js verifies the real
// on-chain value against the price it itself locked in at reserve() time,
// never a client-reported number (see that file's own confirmPayment comment).
export function confirmPartnershipPayment({ weekIds, wallet, paymentTx, sponsorName }) {
  return postPartnership('confirm', { weekIds, wallet, paymentTx, sponsorName });
}

// Raw binary POST (not JSON like every other action above) — the file's own
// bytes are the body, weekId/wallet ride along as query params since
// there's no multipart form here to carry them as fields. `file` is a
// browser File/Blob; its declared .type is sent as Content-Type purely as a
// hint — party/partnership.js's uploadBanner() re-derives the real type
// from the bytes themselves and ignores this header for validation.
export async function uploadPartnershipBanner(weekId, wallet, file) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/partnership/${PARTNERSHIP_ROOM_NAME}?action=uploadBanner&weekId=${encodeURIComponent(weekId)}&wallet=${encodeURIComponent(wallet)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function partnershipBannerUrl(weekId) {
  return `${weekHttpHost()}/parties/partnership/${PARTNERSHIP_ROOM_NAME}?banner=${encodeURIComponent(weekId)}`;
}

// ---------------------------------------------------------------------
// WEEK turn-notification linking (party/telegramLink.js, party/playerIndex.js,
// see CLAUDE.md's WEEK Telegram section) — the Notifications panel behind My
// Matches' own 🔔. Same "plain fetch, best-effort" shape as fetchMyWeekMatches
// above; none of this is gameplay-critical, a hiccup here just leaves the
// panel showing its previous (or a safely-off) state.

// A public identifier, not a secret — the bot's own @username, needed client-
// side to build the t.me deep link. Set once, after creating the bot via
// @BotFather (see CLAUDE.md's WEEK Telegram section for the exact setup
// steps) — a separate bot from Radar's, dedicated to player-facing turn
// notifications only.
export const TELEGRAM_NOTIFY_BOT_USERNAME = 'Nimicurl_Notif_bot';

export async function fetchTelegramStatus(address) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/player-index/${normalizeAddress(address)}?telegram=1`);
    if (!res.ok) return { connected: false, notifyTurnEnabled: false };
    return await res.json();
  } catch {
    return { connected: false, notifyTurnEnabled: false };
  }
}

// Starts the linking flow: asks party/telegramLink.js for a fresh one-time
// token, to be opened as https://t.me/<bot>?start=<token> by the caller (see
// main.js) — never constructed here, this module has no DOM/window access
// assumptions elsewhere. Returns null on any failure so the caller can leave
// the "Connect Telegram" pill as-is instead of navigating nowhere.
export async function startTelegramLink(address) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/telegram-link/start?address=${encodeURIComponent(normalizeAddress(address))}`, { method: 'POST' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null;
  } catch {
    return null;
  }
}

export async function setTelegramNotifyEnabled(address, enabled) {
  try {
    const res = await fetch(`${weekHttpHost()}/parties/player-index/${normalizeAddress(address)}?telegram=toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}

// Trash icon — removes this address's Telegram association only (see
// party/playerIndex.js's clearTelegram). Best-effort: a failure here just
// means the panel still shows "Connected" next time it's opened, not a
// broken account.
export async function disconnectTelegram(address) {
  try {
    await fetch(`${weekHttpHost()}/parties/player-index/${normalizeAddress(address)}?telegram=1`, { method: 'DELETE' });
  } catch {
    // best-effort, see comment above
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
    let leagueResultCb = null;
    let prizeResultCb = null;

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
      // The opponent's own connected wallet address (or null: not connected
      // yet, or they're a guest) — see party/arbiter.js's own 'joined'/
      // 'opponentJoined' comment. Same trust level as everything else this
      // relay hands the client verbatim: not cryptographically verified (see
      // CLAUDE.md's Radar trust-model section, which already documents this
      // for hubAddress itself). Used by game.js's showVictory for the
      // ticket's opponent identicon (see conversation) — never gates
      // gameplay.
      opponentAddress: null,
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
      // NIM-Curl Radar only (see party/arbiter.js's 'matchOver' branch) — no
      // gameplay effect, nothing relayed back. Sent once by src/game.js right
      // where showVictory() fires; safe to call on Duel LAN's arbiter too
      // (server/arbiter.js has no 'matchOver' case, so it's just ignored
      // there — LAN is dev-only and intentionally not wired into Radar, see
      // CLAUDE.md).
      // matchIndex: 0 for the room's first match, +1 per "Play Again" (see
      // party/arbiter.js's own matchIndex comment).
      sendMatchOver(scoreA, scoreB, matchIndex = 0) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'matchOver', scoreA, scoreB, matchIndex }));
      },
      onLaunch(cb) { launchCb = cb; },
      onOpponentJoined(cb) { opponentJoinedCb = cb; },
      onDisconnect(cb) { disconnectCb = cb; },
      onChat(cb) { chatCb = cb; },
      onChatMute(cb) { chatMuteCb = cb; },
      onBothReady(cb) { bothReadyCb = cb; },
      onMancheValid(cb) { mancheValidCb = cb; },
      onMancheInvalid(cb) { mancheInvalidCb = cb; },
      // League Beta (party/arbiter.js's own 'matchOver' handler) — fires once,
      // shortly after sendMatchOver, with THIS client's own LP gain for the
      // match just played (see src/ticket.js's league stamp). Never fires at
      // all on Duel LAN (server/arbiter.js has no League concept, see
      // CLAUDE.md) or when this match didn't qualify for League (custom
      // rules, a guest on either side, etc.) — callers must not assume it
      // always arrives.
      onLeagueResult(cb) { leagueResultCb = cb; },
      // NIM prizes (party/arbiter.js's own 'matchOver' handler) — fires once,
      // shortly after sendMatchOver, ONLY for the winning side and ONLY once
      // the server has actually broadcast the payout (see prize.js's own
      // 'paid' status) — callers must not assume it always arrives, same as
      // onLeagueResult above.
      onPrizeResult(cb) { prizeResultCb = cb; },
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
        net.opponentAddress = msg.opponentAddress || null;
        settled = true;
        resolve(net);
      } else if (msg.type === 'full') {
        if (!settled) { settled = true; reject(new Error('Match already full.')); }
        ws.close();
      } else if (msg.type === 'closed') {
        if (!settled) { settled = true; reject(new Error('This match code is no longer valid.')); }
        ws.close();
      } else if (msg.type === 'opponentJoined') {
        net.opponentAddress = msg.address || null;
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
      } else if (msg.type === 'leagueResult') {
        if (leagueResultCb) leagueResultCb({ lpAwarded: msg.lpAwarded });
      } else if (msg.type === 'prizeResult') {
        if (prizeResultCb) prizeResultCb({ amountNim: msg.amountNim });
      }
    });
  });
}
