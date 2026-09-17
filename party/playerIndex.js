// Per-wallet-address registry for WEEK matches (see party/weekArbiter.js) —
// one Durable Object instance per address (routed by wallet address as the
// room name, see party/index.js), used for two things a single match's own
// Durable Object can't answer by itself: how many active WEEK matches does
// this player already have (the active-match cap, MAX_ACTIVE_MATCHES below),
// and "My Matches" (main.js) —
// the list of this player's in-progress WEEK matches with a per-match status
// label, without opening a connection to every one of them individually.
//
// WeekArbiter calls this class's methods directly over Durable Object RPC
// (getServerByName(...).reserve(...) etc., see partyserver's getServerByName)
// rather than over its own WebSocket protocol — this class only takes plain
// GET requests from the browser (My Matches), everything else is
// server-to-server.
import { Server } from 'partyserver';

// How many WEEK matches one wallet can have running at once. Kept in sync
// with src/main.js's MY_MATCHES_SLOTS, which draws exactly this many rows.
const MAX_ACTIVE_MATCHES = 5;

export class PlayerIndex extends Server {
  onStart() {
    this._loaded = Promise.all([
      this.ctx.storage.get('matches'),
      // Telegram turn-notifications (see CLAUDE.md's WEEK Telegram section,
      // party/telegramLink.js) — null until this address links via that
      // flow. Lives here, not on TelegramLink, because this instance is
      // already this game's one Durable Object per wallet address (My
      // Matches' own home) — no reason for a second place to hold "this
      // player's own stuff".
      this.ctx.storage.get('telegram'),
    ]).then(([m, t]) => { this.matches = m || {}; this.telegram = t || null; });
  }

  async ready() { if (this._loaded) await this._loaded; }

  // Called once by party/telegramLink.js's completeLink, after a linking
  // token for this address has been validated. Notifications start ON
  // (per explicit product decision — connecting IS opting in, no separate
  // "now also flip the switch" step needed for the common case); the player
  // can still turn it off afterwards without disconnecting.
  //
  // /telegram-link/start (party/telegramLink.js) has no auth beyond knowing
  // this address — same trust model as every other WEEK endpoint (see this
  // file's own onRequest comment), which means someone who merely knows an
  // address can link THEIR OWN Telegram to it. This can't be closed here
  // without real wallet-signature auth (out of scope, same accepted limit
  // Radar already documents for the identical trust model). What it can do:
  // if a chat was already connected, warn THAT chat before overwriting it,
  // so replacing an already-working connection is never silent to whoever
  // set it up — it doesn't stop a first-time hijack of a never-connected
  // address (there's no prior owner to warn), only makes a takeover of an
  // existing one visible.
  async setTelegram(chatId) {
    await this.ready();
    const previousChatId = this.telegram?.chatId;
    this.telegram = { chatId, connectedAt: Date.now(), notifyTurnEnabled: true };
    await this.ctx.storage.put('telegram', this.telegram);
    if (previousChatId && previousChatId !== chatId) {
      this.sendTelegram(previousChatId, "⚠️ Your NimiCurl Telegram connection was replaced by a new one. If this wasn't you, reconnect from My Matches.", 'replaced-connection warning');
    }
    return { ok: true };
  }

  // Trash icon in the Notifications panel — removes the association only.
  // Never touches the Telegram bot conversation itself (nothing to revoke on
  // Telegram's side for a plain sendMessage-only bot) and never touches
  // matches/the Nimiq identity this instance is keyed by.
  async clearTelegram() {
    await this.ready();
    this.telegram = null;
    await this.ctx.storage.put('telegram', null);
    return { ok: true };
  }

  // Guards against enabling notifications with nothing to deliver them
  // through — the panel is expected to route this case into the connect
  // flow instead (see main.js), but the server enforces it too rather than
  // trusting the client alone.
  async setNotifyEnabled(enabled) {
    await this.ready();
    if (!this.telegram) return { ok: false, reason: 'notConnected' };
    this.telegram.notifyTurnEnabled = !!enabled;
    await this.ctx.storage.put('telegram', this.telegram);
    return { ok: true };
  }

  // Called from party/weekArbiter.js (see its own notifyTurnReady) exactly
  // when this address's turnLabel just became actionable — see that file's
  // own comment for why the guards already on its state transitions are
  // what make this idempotent (no separate dedup flag needed here, same
  // reasoning as radarNotify's own comment in weekArbiter.js). No-op,
  // silently, if Telegram isn't connected or the player has the switch off —
  // exactly the "does this player have Telegram connected? are
  // notifications enabled? if yes, send; if not, do nothing" the brief asks
  // for.
  async notifyTurnReady({ matchId } = {}) {
    await this.ready();
    if (!this.telegram?.chatId || !this.telegram?.notifyTurnEnabled) return;
    await this.sendTelegram(this.telegram.chatId, '🥌 Your turn\nYour WEEK match is waiting for you.', `match ${matchId}`);
  }

  // Takes an explicit chatId (not read off this.telegram) so it can also
  // reach a chat this instance is no longer associated with — see
  // setTelegram's own "warn the previous chat before overwriting it" call.
  async sendTelegram(chatId, text, context = 'send') {
    const token = this.env?.TELEGRAM_NOTIFY_BOT_TOKEN;
    if (!token || !chatId) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[playerIndex] Telegram ${context} failed: HTTP ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`[playerIndex] Telegram ${context} failed:`, err); // never let a Telegram outage break WEEK itself
    }
  }

  // Claims a slot for `code` against MAX_ACTIVE_MATCHES. Called
  // once, right when this address becomes a real participant in a match
  // (creating it, or being accepted as the joiner) — never on a later
  // reconnect to a match it's already part of (idempotent: an already-known
  // code just succeeds without re-counting). A Durable Object instance only
  // ever processes one call at a time, so this can't race against a second
  // reserve() for the same address/instance.
  async reserve(code) {
    await this.ready();
    if (this.matches[code]) return { ok: true };
    const activeCount = Object.values(this.matches).filter((m) => m.status === 'pending' || m.status === 'active').length;
    if (activeCount >= MAX_ACTIVE_MATCHES) return { ok: false };
    this.matches[code] = { status: 'pending', updatedAt: Date.now() };
    await this.ctx.storage.put('matches', this.matches);
    return { ok: true };
  }

  // Refreshes the cached display info for a match already reserved above —
  // called after every meaningful state change (join, shot, reveal/score
  // update, expiry) so "My Matches" never has to open a connection to the
  // match itself just to render a status label.
  async upsert(code, meta) {
    await this.ready();
    this.matches[code] = { ...(this.matches[code] || {}), ...meta, updatedAt: Date.now() };
    await this.ctx.storage.put('matches', this.matches);
  }

  // Frees the slot — match completed or expired, no longer counts toward
  // the cap and drops out of "My Matches".
  async remove(code) {
    await this.ready();
    if (!(code in this.matches)) return;
    delete this.matches[code];
    await this.ctx.storage.put('matches', this.matches);
  }

  async list() {
    await this.ready();
    return this.matches;
  }

  // Plain HTTP GET (no WebSocket) — "My Matches" is a one-off read, not a
  // connection worth holding open (see the WEEK design conversation: no live
  // push anywhere in this feature, always connect/fetch/disconnect). Cross-
  // origin from the game's own domain (this Worker is deployed separately,
  // see wrangler.jsonc), so it needs its own CORS header — the WebSocket
  // calls elsewhere in WEEK don't hit this (a WS handshake isn't subject to
  // the same-origin fetch restriction), but a plain fetch() is. Read-only,
  // non-sensitive data (match/status labels only, no secrets) — a wildcard
  // origin is fine here, same trust level as everything else this arbiter
  // already hands back to any client that knows a room's address.
  // DELETE ?code=XXXX — self-service dismiss (see src/net.js's
  // dismissWeekMatch): a player clearing an "opponent abandoned" row from
  // their own My Matches list. Deliberately a direct write here rather than
  // reconnecting to the (already terminal) WeekArbiter room to ask it to do
  // this on their behalf — there's nothing left there to coordinate, this
  // player's own index is the only thing being changed. Same trust model as
  // everywhere else in WEEK (see onRequest's own GET comment) — no auth
  // beyond "you know this address", since this room only ever holds cached
  // display labels, never anything authoritative about the match itself.
  //
  // The Telegram panel (main.js) reuses this same address-keyed room rather
  // than a separate route, distinguished by a `telegram` query param so the
  // two original routes above (plain GET -> matches dict, DELETE ?code= ->
  // remove one match) stay byte-for-byte unchanged for existing callers:
  //   GET    ?telegram=1                -> { connected, notifyTurnEnabled }
  //   POST   ?telegram=toggle  {enabled} -> { ok, reason? }
  //   DELETE ?telegram=1                -> { ok } (disconnect)
  async onRequest(request) {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    // DELETE/POST (unlike the plain GET this class started with) aren't
    // CORS-"simple" methods — the browser sends a preflight OPTIONS request
    // first and silently aborts the real one if this doesn't answer it, no
    // error surfaced to fetch() at all (see conversation: dismiss looked
    // like a no-op — curl "worked" because it never sends/checks a
    // preflight, only a real browser does).
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, DELETE, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    const url = new URL(request.url);
    const isTelegram = url.searchParams.has('telegram');
    if (isTelegram && request.method === 'GET') {
      await this.ready();
      return Response.json({ connected: !!this.telegram, notifyTurnEnabled: !!this.telegram?.notifyTurnEnabled }, { headers: cors });
    }
    if (isTelegram && request.method === 'POST' && url.searchParams.get('telegram') === 'toggle') {
      let body = {};
      try { body = await request.json(); } catch { /* enabled stays undefined -> falsy below */ }
      const result = await this.setNotifyEnabled(!!body.enabled);
      return Response.json(result, { headers: cors });
    }
    if (isTelegram && request.method === 'DELETE') {
      const result = await this.clearTelegram();
      return Response.json(result, { headers: cors });
    }
    if (request.method === 'GET') return Response.json(await this.list(), { headers: cors });
    if (request.method === 'DELETE') {
      const code = url.searchParams.get('code');
      if (code) await this.remove(code);
      return Response.json({ ok: true }, { headers: cors });
    }
    return new Response('Method not allowed', { status: 405, headers: cors });
  }
}
