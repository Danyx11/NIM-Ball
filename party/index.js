// Cloudflare Worker entry point (see wrangler.jsonc's "main") — routes
// incoming requests to the right Durable Object instance by room name.
// Exporting each class here is required — wrangler.jsonc's durable_objects
// bindings point at this module. Four classes now:
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
import { routePartykitRequest, getServerByName } from 'partyserver';
import { RADAR_ROOM_NAME } from './radar.js';
export { Arbiter } from './arbiter.js';
export { WeekArbiter } from './weekArbiter.js';
export { PlayerIndex } from './playerIndex.js';
export { RadarCollector } from './radar.js';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/radar/telegram-webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
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
