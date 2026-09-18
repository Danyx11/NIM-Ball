// Partnership booking — a single Durable Object instance (PARTNERSHIP_ROOM_NAME,
// same fixed-name pattern as party/radar.js/party/telegramLink.js) holding
// which weeks are reserved/paid. Source of truth for week availability: the
// browser's own displayed state (src/partnership.js) must never be trusted
// for "is this week free" — see reserve() below for how two concurrent
// requests for the same week are kept from both succeeding.
//
// Scope note (see conversation): this class only tracks reservation state.
// It does NOT verify payment on-chain yet — confirmPayment() below currently
// trusts whatever paymentTx/amountLuna the client reports, same shape as
// every other "trust the client, RPC/room-key IS the boundary" spot already
// documented in this codebase (party/radar.js, party/playerIndex.js's own
// header comments) — except this one gates a real paid feature, not just
// analytics or a display label, so it must be hardened with a real on-chain
// check before this ever goes live. That hardening is a deliberately
// separate next step, not done here.
import { Server } from 'partyserver';

export const PARTNERSHIP_ROOM_NAME = 'v1';

const DAY_MS = 24 * 60 * 60 * 1000;

// How long a `payment_pending` reservation holds its week(s) before they're
// released back to available. Long enough to actually complete a wallet
// confirmation, short enough that someone opening the booking flow and
// walking away doesn't lock a week out indefinitely. No persisted alarm/cron
// needed for this — see sweepExpired() below, checked lazily on every
// request that reads or mutates booking state instead.
const PENDING_TTL_MS = 15 * 60 * 1000;

// How far ahead weeks are ever offered/accepted — keeps reserve()/
// confirmPayment() from being handed an arbitrary/far-future weekId that
// was never actually listed.
const WEEKS_WINDOW = 16;

const MAX_SPONSOR_NAME_LEN = 60;

// Monday 00:00:00 UTC of the ISO week containing `timestampMs` — same math
// as party/leagueSeason.js's startOfIsoWeekUtc, duplicated rather than
// imported (party/ and this file both already live in the same bundle, but
// every other cross-file constant in here follows the "duplicate small pure
// helpers, don't couple unrelated Durable Object files" convention already
// established for this exact function — see leagueSeason.js's own comment).
function mondayUtcMs(timestampMs) {
  const d = new Date(timestampMs);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayOfWeek = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon->0, Tue->1, ..., Sun->6
  return utcMidnight - daysSinceMonday * DAY_MS;
}

// weekId is that Monday's own ISO date (YYYY-MM-DD), not an ISO week NUMBER
// — sidesteps ISO week numbering's year-boundary edge cases (a week number
// can belong to a different year than the date, week 53 doesn't exist every
// year, etc.) entirely, while staying just as stable/sortable/dedupable for
// what this class actually needs: a unique key per Monday-start week.
function weekIdFor(timestampMs) {
  return new Date(mondayUtcMs(timestampMs)).toISOString().slice(0, 10);
}

// The next `count` weeks starting from the CURRENT week (today's own week
// included) — never past weeks, so a stale client can't reserve/confirm
// something that already lapsed.
function upcomingWeeks(count) {
  const firstMonday = mondayUtcMs(Date.now());
  const weeks = [];
  for (let i = 0; i < count; i++) {
    const start = firstMonday + i * 7 * DAY_MS;
    weeks.push({ weekId: weekIdFor(start), weekStart: start, weekEnd: start + 7 * DAY_MS });
  }
  return weeks;
}

export class Partnership extends Server {
  onStart() {
    this._loaded = (async () => {
      // weekId -> { weekId, status, sponsorName, wallet, banner, paymentTx,
      // amount, createdAt, pendingExpiresAt } — same flat-JSON-doc shape as
      // every other small Durable Object here (party/weekArbiter.js,
      // party/playerIndex.js, party/leagueSeason.js). `banner` is always
      // null for now — banner upload/storage is a separate, later piece
      // (see conversation), this schema just already has the field so that
      // addition won't need a migration of existing rows.
      this.bookings = (await this.ctx.storage.get('bookings')) || {};
    })();
    // Same single-writer-queue pattern as party/radar.js/leagueSeason.js's
    // onStart — two reserve()/confirmPayment() calls landing close together
    // must never both read the pre-mutation state and clobber each other on
    // write. This queue is also THE double-booking guard: reserve() only
    // ever runs inside serialized(), so the second of two concurrent
    // requests for the same week always sees the first one's write before
    // it checks availability.
    this._writeQueue = Promise.resolve();
  }

  async ready() { if (this._loaded) await this._loaded; }

  serialized(fn) {
    const run = this._writeQueue.then(fn, fn);
    this._writeQueue = run.catch(() => {});
    return run;
  }

  async persist() { await this.ctx.storage.put('bookings', this.bookings); }

  // Releases any payment_pending booking whose hold has lapsed back to
  // available (simply deleting its entry — "available" is just "no entry
  // for this weekId"). Called at the top of every read/write path below, not
  // on a timer/alarm — this class has no other reason to wake up, so a lazy
  // sweep on next access is simpler than scheduling one (same reasoning
  // RadarCollector's cron-driven report has for NEEDING a real schedule:
  // that one must fire even with zero traffic, this one only ever matters
  // when something is about to read/write booking state anyway).
  sweepExpired() {
    const now = Date.now();
    let changed = false;
    for (const [weekId, booking] of Object.entries(this.bookings)) {
      if (booking.status === 'payment_pending' && booking.pendingExpiresAt && booking.pendingExpiresAt < now) {
        delete this.bookings[weekId];
        changed = true;
      }
    }
    return changed;
  }

  // Public shape — never leaks `wallet` (the reserving/paying address) to
  // every visitor, only to the wallet that owns the reservation (see
  // onRequest's own ?wallet= handling below for that comparison).
  publicWeek(week, viewerWallet) {
    const booking = this.bookings[week.weekId];
    const status = booking ? (booking.status === 'payment_pending' ? 'pending' : 'booked') : 'available';
    const isMine = !!booking && !!viewerWallet && booking.wallet === viewerWallet;
    return {
      weekId: week.weekId,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      status,
      mine: isMine,
      sponsorName: status === 'booked' ? (booking.sponsorName || null) : null,
    };
  }

  listWeeks(viewerWallet) {
    this.sweepExpired();
    return upcomingWeeks(WEEKS_WINDOW).map((w) => this.publicWeek(w, viewerWallet));
  }

  isKnownUpcomingWeekId(weekId) {
    return upcomingWeeks(WEEKS_WINDOW).some((w) => w.weekId === weekId);
  }

  // All-or-nothing: if ANY requested week isn't currently available, nothing
  // is reserved — a partial reservation would let a client silently end up
  // sponsoring a different week than the one they thought they were paying
  // for.
  reserve({ weekIds, wallet }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      if (!wallet || typeof wallet !== 'string') return { ok: false, error: 'wallet required' };
      if (!Array.isArray(weekIds) || weekIds.length === 0) return { ok: false, error: 'weekIds required' };
      const uniqueIds = [...new Set(weekIds)];
      const unknown = uniqueIds.filter((id) => !this.isKnownUpcomingWeekId(id));
      if (unknown.length) return { ok: false, error: 'unknown weekId', weekIds: unknown };
      const conflicts = uniqueIds.filter((id) => this.bookings[id]);
      if (conflicts.length) return { ok: false, error: 'already booked', weekIds: conflicts };
      const now = Date.now();
      const pendingExpiresAt = now + PENDING_TTL_MS;
      for (const weekId of uniqueIds) {
        this.bookings[weekId] = {
          weekId, status: 'payment_pending', wallet, sponsorName: null, banner: null,
          paymentTx: null, amount: null, createdAt: now, pendingExpiresAt,
        };
      }
      await this.persist();
      return { ok: true, weekIds: uniqueIds, pendingExpiresAt };
    });
  }

  // Lets the reserving wallet free its own still-pending weeks early (quit
  // out of the booking flow before paying) instead of waiting out the full
  // PENDING_TTL_MS. Only ever touches payment_pending bookings owned by this
  // exact wallet — never someone else's, and never an already-paid one.
  release({ weekIds, wallet }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      if (!wallet || !Array.isArray(weekIds)) return { ok: false, error: 'invalid request' };
      let changed = false;
      for (const weekId of weekIds) {
        const booking = this.bookings[weekId];
        if (booking && booking.status === 'payment_pending' && booking.wallet === wallet) {
          delete this.bookings[weekId];
          changed = true;
        }
      }
      if (changed) await this.persist();
      return { ok: true };
    });
  }

  // NOT on-chain-verified yet (see this file's header comment) — trusts the
  // client-reported paymentTx/amountLuna as-is. Still enforces every check
  // that doesn't require touching the chain: the booking must exist, must
  // still be this exact wallet's own pending hold, and must not have already
  // expired out from under it.
  confirmPayment({ weekIds, wallet, paymentTx, amountLuna, sponsorName }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      if (!wallet || !Array.isArray(weekIds) || weekIds.length === 0) return { ok: false, error: 'invalid request' };
      if (!paymentTx || typeof paymentTx !== 'string') return { ok: false, error: 'paymentTx required' };
      if (!Number.isFinite(amountLuna) || amountLuna <= 0) return { ok: false, error: 'invalid amountLuna' };
      const invalid = weekIds.filter((id) => {
        const booking = this.bookings[id];
        return !booking || booking.status !== 'payment_pending' || booking.wallet !== wallet;
      });
      if (invalid.length) return { ok: false, error: 'not your pending reservation', weekIds: invalid };
      const cleanSponsorName = typeof sponsorName === 'string' ? sponsorName.trim().slice(0, MAX_SPONSOR_NAME_LEN) : null;
      for (const weekId of weekIds) {
        this.bookings[weekId] = {
          ...this.bookings[weekId],
          status: 'paid',
          paymentTx,
          amount: amountLuna,
          sponsorName: cleanSponsorName || null,
          pendingExpiresAt: null,
        };
      }
      await this.persist();
      return { ok: true, weekIds };
    });
  }

  // Plain HTTP surface for the browser (src/net.js) — no RPC callers yet
  // (unlike RadarCollector/LeagueSeason, nothing else in this Worker needs
  // to reach into Partnership state).
  //   GET  ?wallet=<address>                              -> { weeks: [...] }
  //   POST ?action=reserve  {weekIds, wallet}              -> reserve()
  //   POST ?action=release  {weekIds, wallet}              -> release()
  //   POST ?action=confirm  {weekIds, wallet, paymentTx, amountLuna, sponsorName} -> confirmPayment()
  async onRequest(request) {
    await this.ready();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    const url = new URL(request.url);
    if (request.method === 'GET') {
      return Response.json({ weeks: this.listWeeks(url.searchParams.get('wallet')) }, { headers: cors });
    }
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* validated below, missing fields just fail their own check */ }
      const action = url.searchParams.get('action');
      if (action === 'reserve') return Response.json(await this.reserve(body), { headers: cors });
      if (action === 'release') return Response.json(await this.release(body), { headers: cors });
      if (action === 'confirm') return Response.json(await this.confirmPayment(body), { headers: cors });
      return Response.json({ error: 'unknown action' }, { status: 400, headers: cors });
    }
    return new Response('Method not allowed', { status: 405, headers: cors });
  }
}
