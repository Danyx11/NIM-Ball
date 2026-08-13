// Cloudflare Worker entry point (see wrangler.jsonc's "main") — routes
// incoming requests to the right Arbiter Durable Object instance by room
// name (the 4-character match code, see party/arbiter.js and src/net.js's
// connectMatch). Exporting Arbiter here is required — wrangler.jsonc's
// durable_objects binding points at this module.
import { routePartykitRequest } from 'partyserver';
export { Arbiter } from './arbiter.js';

export default {
  async fetch(request, env) {
    return (await routePartykitRequest(request, env)) || new Response('Not found', { status: 404 });
  },
};
