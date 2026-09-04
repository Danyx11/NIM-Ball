// Cloudflare Worker entry point (see wrangler.jsonc's "main") — routes
// incoming requests to the right Durable Object instance by room name.
// Exporting each class here is required — wrangler.jsonc's durable_objects
// bindings point at this module. Three classes now:
//   Arbiter      — LIVE (see party/arbiter.js), room name = the 4-char match
//                  code, routed at /parties/arbiter/<code> (src/net.js).
//   WeekArbiter  — WEEK (see party/weekArbiter.js), same code-as-room-name
//                  idea but a separate class/route (/parties/week-arbiter/
//                  <code>) — deliberately not a mode inside Arbiter, see that
//                  file's own header comment for why.
//   PlayerIndex  — per-wallet-address registry WeekArbiter calls into (2-
//                  active-matches cap, "My Matches"), room name = the wallet
//                  address, routed at /parties/player-index/<address>.
import { routePartykitRequest } from 'partyserver';
export { Arbiter } from './arbiter.js';
export { WeekArbiter } from './weekArbiter.js';
export { PlayerIndex } from './playerIndex.js';

export default {
  async fetch(request, env) {
    return (await routePartykitRequest(request, env)) || new Response('Not found', { status: 404 });
  },
};
