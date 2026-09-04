// Per-wallet-address registry for WEEK matches (see party/weekArbiter.js) —
// one Durable Object instance per address (routed by wallet address as the
// room name, see party/index.js), used for two things a single match's own
// Durable Object can't answer by itself: how many active WEEK matches does
// this player already have (the 2-match cap), and "My Matches" (main.js) —
// the list of this player's in-progress WEEK matches with a per-match status
// label, without opening a connection to every one of them individually.
//
// WeekArbiter calls this class's methods directly over Durable Object RPC
// (getServerByName(...).reserve(...) etc., see partyserver's getServerByName)
// rather than over its own WebSocket protocol — this class only takes plain
// GET requests from the browser (My Matches), everything else is
// server-to-server.
import { Server } from 'partyserver';

export class PlayerIndex extends Server {
  onStart() {
    this._loaded = this.ctx.storage.get('matches').then((m) => { this.matches = m || {}; });
  }

  async ready() { if (this._loaded) await this._loaded; }

  // Claims a slot for `code` against the 2-active-WEEK-matches cap. Called
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
    if (activeCount >= 2) return { ok: false };
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
  async onRequest(request) {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    return Response.json(await this.list(), { headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
