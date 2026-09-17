// Telegram turn-notifications linking (see CLAUDE.md's WEEK Telegram section).
// A single global fixed-name Durable Object (same pattern as RadarCollector/
// LeagueSeason — see party/radar.js / party/leagueSeason.js) holding only
// short-lived, single-use linking tokens — token -> address, never the
// reverse. The permanent Telegram association (chat id, connected timestamp,
// notify-enabled flag) lives on the player's own party/playerIndex.js
// instance instead, since that's already this game's one Durable Object per
// wallet address (My Matches' own home) — this class exists purely to solve
// the bootstrap problem of resolving an opaque token back to an address from
// a Telegram webhook update that only ever carries a chat id, never the
// address itself (see onRequest below: the wallet address is deliberately
// never put in the Telegram deep link).
//
// Uses a SEPARATE Telegram bot from the one CLAUDE.md's Radar section already
// configures (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, a personal ops bot for
// daily reports + the LIVE desync alert) — this one DMs arbitrary players, so
// it gets its own token/webhook secret (TELEGRAM_NOTIFY_BOT_TOKEN /
// TELEGRAM_NOTIFY_WEBHOOK_SECRET, see party/index.js's handleNotifyWebhook)
// and is never allowed to touch the admin chat id or the ops bot's identity.
import { Server, getServerByName } from 'partyserver';

export const TELEGRAM_LINK_ROOM_NAME = 'start';
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty for tap-pill -> open Telegram -> tap Start

function randomToken() {
  const bytes = new Uint8Array(24); // 192 bits — well past what's guessable
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TelegramLink extends Server {
  onStart() {
    this._loaded = this.ctx.storage.get('tokens').then((t) => { this.tokens = t || {}; });
  }

  async ready() { if (this._loaded) await this._loaded; }

  // Drops anything already expired before adding a new one — the only
  // "cleanup" this store needs at NimiCurl's scale (lazy pruning on the one
  // write path that exists, no cron sweep).
  pruneExpired() {
    const now = Date.now();
    for (const [tok, entry] of Object.entries(this.tokens)) {
      if (entry.expiresAt <= now) delete this.tokens[tok];
    }
  }

  // Called from the browser (party/index.js routes this class's HTTP surface
  // via partyserver's routePartykitRequest) with the player's own wallet
  // address. Same trust model as every other WEEK endpoint — no auth beyond
  // "you know this address" (see party/playerIndex.js's onRequest and
  // party/weekArbiter.js's onConnect, both documented the same way): this
  // doesn't add a stricter bar than those, but doesn't weaken it either —
  // the token it hands back is opaque and single-use regardless of who asked
  // for it, and only ever unlocks a Telegram *linking* step, not match data.
  async createToken(address) {
    await this.ready();
    this.pruneExpired();
    const token = randomToken();
    this.tokens[token] = { address, expiresAt: Date.now() + TOKEN_TTL_MS };
    await this.ctx.storage.put('tokens', this.tokens);
    return token;
  }

  // Called once, from party/index.js's Telegram webhook handler, when the
  // player taps the deep link and Telegram delivers their `/start <token>`.
  // Single-use: the token is deleted here regardless of outcome (valid or
  // not), so a replayed webhook delivery (Telegram retries on a non-200, and
  // anyone who somehow captured the request) can never link twice off the
  // same token.
  async completeLink(token, chatId) {
    await this.ready();
    const entry = this.tokens[token];
    if (entry) {
      delete this.tokens[token];
      await this.ctx.storage.put('tokens', this.tokens);
    }
    if (!entry || entry.expiresAt <= Date.now()) return { ok: false };
    const idx = await getServerByName(this.env.PlayerIndex, entry.address);
    await idx.setTelegram(chatId);
    // Fire-and-forget, same as radarNotify/leagueNotify elsewhere — closes
    // the loop for the player (the deep link just opened a blank bot chat
    // otherwise) but a delivery hiccup here shouldn't fail the link itself.
    this.confirm(chatId).catch((err) => console.error('[telegram-link] confirm failed:', err));
    return { ok: true };
  }

  async confirm(chatId) {
    const token = this.env?.TELEGRAM_NOTIFY_BOT_TOKEN;
    if (!token) return;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: "✅ Connected to NimiCurl. You'll get a message here when it's your turn." }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[telegram-link] confirm send failed: HTTP ${res.status} ${body}`);
    }
  }

  // POST /parties/telegram-link/start?address=<wallet> -> { token }. Own CORS
  // preflight handling — same lesson already documented in
  // party/playerIndex.js's onRequest (a non-"simple" method needs OPTIONS
  // answered explicitly or the browser silently drops the real request).
  async onRequest(request) {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    const address = new URL(request.url).searchParams.get('address');
    if (!address) return Response.json({ error: 'address required' }, { status: 400, headers: cors });
    const token = await this.createToken(address);
    return Response.json({ token }, { headers: cors });
  }
}
