// Cloudflare Worker entry point (see wrangler.jsonc's "main") — routes
// incoming requests to the right Durable Object instance by room name.
// Exporting each class here is required — wrangler.jsonc's durable_objects
// bindings point at this module. Five classes now:
//   Arbiter        — LIVE (see party/arbiter.js), room name = the 4-char
//                    match code, routed at /parties/arbiter/<code> (src/net.js).
//   WeekArbiter    — WEEK (see party/weekArbiter.js), same code-as-room-name
//                    idea but a separate class/route (/parties/week-arbiter/
//                    <code>) — deliberately not a mode inside Arbiter, see
//                    that file's own header comment for why.
//   PlayerIndex    — per-wallet-address registry WeekArbiter calls into (2-
//                    active-matches cap, "My Matches"), room name = the
//                    wallet address, routed at /parties/player-index/<address>.
//   RadarCollector — NIM-Curl Radar (see party/radar.js), a single fixed-name
//                    instance (RADAR_ROOM_NAME) that Arbiter/WeekArbiter call
//                    into over DO RPC, not HTTP. The only HTTP surface this
//                    file adds for it is the inbound Telegram webhook below
//                    (/radar/telegram-webhook) — everything else Radar-
//                    related is either that RPC or the scheduled() cron.
//   LeagueSeason   — League Beta (see party/leagueSeason.js), one fixed-name
//                    instance per season (room name = the season id, see
//                    party/leagueRating.js's CURRENT_SEASON_ID) that
//                    Arbiter/WeekArbiter call into over DO RPC exactly like
//                    RadarCollector, plus a plain HTTP GET surface
//                    (/parties/league-season/<seasonId>) for the browser's
//                    own minimal League panel (src/net.js/src/main.js).
//   TelegramLink   — WEEK turn-notification linking (see party/telegramLink.js,
//                    CLAUDE.md's WEEK Telegram section), a single fixed-name
//                    instance holding only short-lived linking tokens. Its
//                    HTTP surface (POST /parties/telegram-link/start) is
//                    plain partyserver routing like every class above; the
//                    one thing this file adds for it is the inbound webhook
//                    for its OWN, separate Telegram bot (below) — deliberately
//                    not the same bot/webhook as Radar's.
//   Partnership    — sponsor week booking (see party/partnership.js), a
//                    single fixed-name instance (PARTNERSHIP_ROOM_NAME) with
//                    a plain HTTP GET/POST surface only
//                    (/parties/partnership/<room>) — nothing else in this
//                    Worker calls into it over RPC.
import { routePartykitRequest, getServerByName } from 'partyserver';
import { RADAR_ROOM_NAME } from './radar.js';
import { TELEGRAM_LINK_ROOM_NAME } from './telegramLink.js';
export { Arbiter } from './arbiter.js';
export { WeekArbiter } from './weekArbiter.js';
export { PlayerIndex } from './playerIndex.js';
export { RadarCollector } from './radar.js';
export { LeagueSeason } from './leagueSeason.js';
export { TelegramLink } from './telegramLink.js';
export { Partnership } from './partnership.js';

// Telegram calls this once a webhook is registered (see CLAUDE.md's Radar
// section for the `setWebhook` call that points it here with a
// `secret_token`). Verifying that header (Telegram echoes it back on every
// update) is what stops a random POST to this public URL from ever reaching
// handleCommand — without it, anyone who guessed this path could trigger a
// Telegram send. The chat-id check below is a second, independent guard: even
// a leaked webhook secret can only ever make the bot talk to the one chat
// it's already configured for.
async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response('ok'); }
  const text = update?.message?.text;
  const chatId = update?.message?.chat?.id;
  if (text && chatId != null && env.TELEGRAM_CHAT_ID && String(chatId) === String(env.TELEGRAM_CHAT_ID)) {
    // getServerByName is itself async (returns Promise<DurableObjectStub>,
    // not the stub directly — see node_modules/partyserver/dist/index.d.ts)
    // so it must be awaited BEFORE calling a method on its result; calling
    // .handleCommand() straight off the un-awaited promise throws
    // "is not a function" (a real bug found live: the webhook was crashing
    // with 500 on every command).
    const radar = await getServerByName(env.RadarCollector, RADAR_ROOM_NAME);
    await radar.handleCommand(text);
  }
  return new Response('ok');
}

// Webhook for the SEPARATE Telegram bot used only for WEEK turn
// notifications (party/telegramLink.js, party/playerIndex.js) — never the
// same bot/token/webhook secret as handleTelegramWebhook above, and this one
// never checks a fixed admin chat id: the whole point is that arbitrary,
// previously-unknown chats reach it (any player who taps the deep link).
// The ONLY thing it ever acts on is a well-formed `/start <token>` — the
// token itself is the entire authority (see party/telegramLink.js's own
// header comment); anything else (a bare "/start", random text, an unrelated
// command) is silently ignored rather than given any special handling.
async function handleNotifyWebhook(request, env) {
  if (!env.TELEGRAM_NOTIFY_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_NOTIFY_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response('ok'); }
  const text = update?.message?.text;
  const chatId = update?.message?.chat?.id;
  const match = typeof text === 'string' ? text.match(/^\/start\s+(\S+)$/) : null;
  if (match && chatId != null) {
    // getServerByName is async — see handleTelegramWebhook's identical
    // comment above for the exact bug this awaits around.
    const link = await getServerByName(env.TelegramLink, TELEGRAM_LINK_ROOM_NAME);
    await link.completeLink(match[1], String(chatId));
  }
  return new Response('ok');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/radar/telegram-webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === '/notify/telegram-webhook' && request.method === 'POST') {
      return handleNotifyWebhook(request, env);
    }
    return (await routePartykitRequest(request, env)) || new Response('Not found', { status: 404 });
  },
  // Cloudflare Cron Trigger (see wrangler.jsonc's "triggers.crons") — see
  // RadarCollector#maybeSendDailyReport for why a coarse interval here is
  // fine (it re-checks Europe/Paris wall-clock time itself every tick).
  async scheduled(event, env, ctx) {
    // See handleTelegramWebhook's comment above — getServerByName must be
    // awaited before use.
    ctx.waitUntil((async () => {
      const radar = await getServerByName(env.RadarCollector, RADAR_ROOM_NAME);
      await radar.maybeSendDailyReport();
    })());
  },
};
