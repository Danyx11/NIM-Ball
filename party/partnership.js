// Partnership booking — a single Durable Object instance (PARTNERSHIP_ROOM_NAME,
// same fixed-name pattern as party/radar.js/party/telegramLink.js) holding
// which weeks are reserved/paid. Source of truth for week availability: the
// browser's own displayed state (src/partnership.js) must never be trusted
// for "is this week free" — see reserve() below for how two concurrent
// requests for the same week are kept from both succeeding.
//
// confirmPayment() below verifies the reported paymentTx against the real
// Nimiq chain (existence, confirmations, sender, recipient, value, reuse) —
// see that method's own comment for exactly what "verified" means here.
// This is the ONE class in this codebase that gates a real paid feature, so
// it deliberately does NOT follow the "RPC/room-key IS the trust boundary"
// pattern party/radar.js/party/playerIndex.js document for themselves.
import { Server } from 'partyserver';

export const PARTNERSHIP_ROOM_NAME = 'v1';

const DAY_MS = 24 * 60 * 60 * 1000;

// Pricing model duplicated from src/partnership.js's own constant (not
// imported — party/ is a separate Cloudflare Worker bundle from the browser
// build, same "duplicate small pure constants, keep in sync by hand" reason
// src/net.js's LEAGUE_SEASON_ID already documents for itself). The SERVER's
// own copy is the one that matters here: it's what reserve() below actually
// locks a price against, never a client-supplied number.
const PARTNERSHIP_WEEKLY_USD = 10;
const LUNA_PER_NIM = 1e5;

// Public, keyless, CORS-open (server-side fetch anyway, so CORS wouldn't
// matter, but this is the exact same endpoint src/partnership.js's
// quotePartnership() already verified working — see that file's own
// comment on why CryptoCompare, getExchangeRates' default provider, is
// unusable at all: it has no Access-Control-Allow-Origin header, which
// blocks browsers but NOT a server-to-server fetch like this one. Kept as
// a plain fetch rather than importing @nimiq/utils here — one endpoint, no
// need for that package's full provider abstraction in this bundle.
const COINGECKO_NIM_USD_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd';

// Default public Nimiq Albatross RPC node used to verify a reported payment
// transaction — see confirmPayment()'s own comment. Overridable via
// wrangler.jsonc's `vars.NIMIQ_RPC_URL` (this default has "no uptime
// guarantees" per its own operator, nimiqwatch.com — swap it for a
// dedicated/self-hosted node before relying on this for real money at
// scale, no code change needed, just the var).
const DEFAULT_NIMIQ_RPC_URL = 'https://rpc.nimiqwatch.com';

// How many blocks must confirm a transaction before it's trusted enough to
// finalize a booking. Albatross blocks land roughly every ~1s (observed:
// see conversation), so this is roughly a 20s wait — a confirmation-COUNT
// safety margin against the RPC node's own view of the chain reorganizing,
// not a claim about Albatross's macro-block finality proofs specifically.
// Tune up if a deeper margin is wanted; this is not a protocol constant.
const REQUIRED_CONFIRMATIONS = 20;

const RPC_TIMEOUT_MS = 10_000;

// Recommended 1600x200 (see src/main.js's upload copy) is a suggestion, not
// enforced here — only what actually matters for safety/storage is: real
// image bytes, one of two formats, under this size.
const MAX_BANNER_BYTES = 1 * 1024 * 1024; // 1 MB

// Never trusts the client's declared Content-Type (spec: "do not allow
// arbitrary HTML/JS content through the banner system") — sniffs the actual
// file signature instead, so a renamed .html/.svg-with-script can't pass as
// an image just because the browser said so. Returns the REAL content type
// to store/serve, or null to reject.
function sniffImageType(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// Same normalization src/net.js's normalizeAddress does client-side
// (duplicated for the same cross-bundle reason as PARTNERSHIP_WEEKLY_USD
// above) — addresses arrive from three different sources here (the
// reserving client, the RPC node's own user-friendly-formatted from/to
// fields, and wrangler.jsonc's configured recipient) that must compare
// equal regardless of which one happens to have the usual space-separated
// grouping and which doesn't.
function normalizeAddress(address) { return typeof address === 'string' ? address.replace(/\s+/g, '').toUpperCase() : address; }

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

// Throws on any failure (network, timeout, missing price) — reserve() below
// treats "couldn't get a trustworthy price" as "fail the reservation", never
// as "fall back to some other number".
// Workers' fetch() sends no User-Agent by default — verified live that
// CoinGecko's public API 403s a request with no/empty User-Agent (basic
// bot defense), so this has to be set explicitly; any non-empty value works.
const FETCH_USER_AGENT = 'NimiCurl-Partnership-Worker/1.0';

async function fetchNimUsdRate() {
  const res = await fetch(COINGECKO_NIM_USD_URL, { headers: { 'User-Agent': FETCH_USER_AGENT }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CoinGecko rate fetch failed: ${res.status}`);
  const json = await res.json();
  const rate = json?.['nimiq-2']?.usd;
  if (!rate) throw new Error('NIM/USD rate unavailable');
  return rate;
}

// Returns the RPC node's transaction record, or null if the node reports it
// simply doesn't exist (not yet broadcast/mined, or never will be) — every
// OTHER failure (network error, timeout, malformed response, any other RPC
// error) throws instead of returning null, so confirmPayment() below can't
// mistake "the node is unreachable right now" for "this transaction was
// never sent". See this file's own header comment for where the shape of
// the returned object comes from (core-rs-albatross's rpc-interface
// Transaction/ExecutedTransaction types — verified live against
// rpc.nimiqwatch.com, see conversation).
async function fetchNimiqTransaction(rpcUrl, hash) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': FETCH_USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'getTransactionByHash', params: [hash], id: 1 }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Nimiq RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) {
    if (typeof body.error.data === 'string' && body.error.data.startsWith('Transaction not found')) return null;
    throw new Error(body.error.message || 'Nimiq RPC error');
  }
  return body.result?.data || null;
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
      // paymentTx (normalized to lowercase hex, hashes have no case-sensitive
      // meaning) -> { weekIds, wallet, confirmedAt } — the reuse guard
      // confirmPayment() checks/writes inside the same serialized() call
      // that reads it, which is what makes two confirmPayment calls racing
      // on the SAME tx hash resolve to exactly one winner (see that
      // method's own comment).
      this.usedTxHashes = (await this.ctx.storage.get('usedTxHashes')) || {};
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
  async persistUsedTxHashes() { await this.ctx.storage.put('usedTxHashes', this.usedTxHashes); }

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
  //
  // Locks a price in Luna, computed from THIS SERVER's own rate lookup
  // (never a client-supplied amount) — confirmPayment() later verifies the
  // real on-chain transaction value against exactly this stored number, per
  // week reserved. A client that only wants to display a price can already
  // do so via src/partnership.js's own quotePartnership(); this is the
  // authoritative copy the money actually gets checked against.
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
      let rateUsdPerNim;
      try {
        rateUsdPerNim = await fetchNimUsdRate();
      } catch (err) {
        return { ok: false, error: `price lookup failed: ${err.message}` };
      }
      const pricePerWeekLuna = Math.round((PARTNERSHIP_WEEKLY_USD / rateUsdPerNim) * LUNA_PER_NIM);
      const now = Date.now();
      const pendingExpiresAt = now + PENDING_TTL_MS;
      for (const weekId of uniqueIds) {
        this.bookings[weekId] = {
          weekId, status: 'payment_pending', wallet, sponsorName: null, banner: null,
          paymentTx: null, amount: null, expectedAmountLuna: pricePerWeekLuna,
          createdAt: now, pendingExpiresAt,
        };
      }
      await this.persist();
      return { ok: true, weekIds: uniqueIds, pendingExpiresAt, amountLuna: pricePerWeekLuna * uniqueIds.length };
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

  // Verifies `paymentTx` against the real Nimiq chain before ever marking a
  // reservation paid — see this file's header comment for why this class,
  // unlike every other small Durable Object here, can't just trust whatever
  // the client reports. Checks, in order (any failure returns without
  // touching booking state):
  //   1. the booking(s) still exist, are payment_pending, and belong to
  //      this exact wallet (same ownership check as before this task)
  //   2. paymentTx hasn't already been used to confirm some other
  //      reservation (this file's own usedTxHashes map, race-safe because
  //      the check AND the write happen inside this same serialized() call)
  //   3. the transaction actually exists on-chain (fetchNimiqTransaction)
  //   4. it has at least REQUIRED_CONFIRMATIONS — returns a distinct
  //      { ok:false, error:'pending', confirmations, required } rather than
  //      confirming, so a caller can poll/retry instead of being told the
  //      payment failed
  //   5. it executed successfully (executionResult)
  //   6. sender == the reservation's own wallet, recipient == this Worker's
  //      configured PARTNERSHIP_PAYMENT_ADDRESS (never the client's say-so
  //      for either)
  //   7. value == the exact amount reserve() locked in for this batch
  //      (sum of each week's own expectedAmountLuna — never a client-
  //      supplied amount at all any more, see reserve()'s own comment)
  // `sponsorName` is the one field still taken from the client as-is
  // (sanitized/length-capped) — it's a display label the sponsor picks for
  // themselves, not something that gates money, same trust level as a
  // player's own claimed NimConnect handle elsewhere in this codebase.
  confirmPayment({ weekIds, wallet, paymentTx, sponsorName }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      if (!wallet || !Array.isArray(weekIds) || weekIds.length === 0) return { ok: false, error: 'invalid request' };
      if (!paymentTx || typeof paymentTx !== 'string') return { ok: false, error: 'paymentTx required' };
      const invalid = weekIds.filter((id) => {
        const booking = this.bookings[id];
        return !booking || booking.status !== 'payment_pending' || booking.wallet !== wallet;
      });
      if (invalid.length) return { ok: false, error: 'not your pending reservation', weekIds: invalid };

      const normalizedHash = paymentTx.trim().toLowerCase();
      if (this.usedTxHashes[normalizedHash]) return { ok: false, error: 'transaction already used' };

      let tx;
      try {
        tx = await fetchNimiqTransaction(this.env?.NIMIQ_RPC_URL || DEFAULT_NIMIQ_RPC_URL, normalizedHash);
      } catch (err) {
        return { ok: false, error: `verification failed: ${err.message}` };
      }
      if (!tx) return { ok: false, error: 'transaction not found' };
      const confirmations = tx.confirmations || 0;
      if (confirmations < REQUIRED_CONFIRMATIONS) {
        return { ok: false, error: 'pending', confirmations, required: REQUIRED_CONFIRMATIONS };
      }
      if (!tx.executionResult) return { ok: false, error: 'transaction execution failed' };
      if (normalizeAddress(tx.from) !== normalizeAddress(wallet)) return { ok: false, error: 'sender mismatch' };
      const expectedRecipient = this.env?.PARTNERSHIP_PAYMENT_ADDRESS;
      if (!expectedRecipient) return { ok: false, error: 'server misconfigured: no payment address' };
      if (normalizeAddress(tx.to) !== normalizeAddress(expectedRecipient)) return { ok: false, error: 'recipient mismatch' };
      const expectedTotal = weekIds.reduce((sum, id) => sum + (this.bookings[id].expectedAmountLuna || 0), 0);
      if (tx.value !== expectedTotal) return { ok: false, error: 'amount mismatch', expected: expectedTotal, actual: tx.value };

      const cleanSponsorName = typeof sponsorName === 'string' ? sponsorName.trim().slice(0, MAX_SPONSOR_NAME_LEN) : null;
      for (const weekId of weekIds) {
        this.bookings[weekId] = {
          ...this.bookings[weekId],
          status: 'paid',
          paymentTx: normalizedHash,
          amount: tx.value,
          sponsorName: cleanSponsorName || null,
          pendingExpiresAt: null,
        };
      }
      this.usedTxHashes[normalizedHash] = { weekIds, wallet, confirmedAt: Date.now() };
      await Promise.all([this.persist(), this.persistUsedTxHashes()]);
      return { ok: true, weekIds };
    });
  }

  // Only for an already-PAID week owned by this exact wallet — never a
  // pending/available one, so there's nothing to gain by uploading before
  // paying. `bytes` is the raw request body (ArrayBuffer, see onRequest);
  // this method never trusts the client's declared content type, only what
  // sniffImageType() finds in the actual bytes (see this file's header on
  // why: arbitrary HTML/JS content must never pass as an "image"). Re-
  // uploading replaces the previous banner (same R2 key, overwritten) —
  // no separate "delete" needed.
  uploadBanner({ weekId, wallet, bytes }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      const booking = this.bookings[weekId];
      if (!booking || booking.status !== 'paid' || booking.wallet !== wallet) {
        return { ok: false, error: 'not your booked week' };
      }
      if (!bytes || bytes.byteLength === 0) return { ok: false, error: 'empty file' };
      if (bytes.byteLength > MAX_BANNER_BYTES) return { ok: false, error: 'file too large (max 1 MB)' };
      const contentType = sniffImageType(bytes);
      if (!contentType) return { ok: false, error: 'must be a real PNG or WebP image' };
      if (!this.env?.PARTNERSHIP_BANNERS) return { ok: false, error: 'server misconfigured: no banner storage' };
      const key = `partnership/${weekId}.${contentType === 'image/png' ? 'png' : 'webp'}`;
      await this.env.PARTNERSHIP_BANNERS.put(key, bytes, { httpMetadata: { contentType } });
      this.bookings[weekId] = { ...booking, banner: { key, contentType, uploadedAt: Date.now() } };
      await this.persist();
      return { ok: true, weekId, contentType };
    });
  }

  // Read-only, no ownership check — a booked week's banner is meant to be
  // publicly visible in-game (spec: shown on every scored point and match
  // ticket during that week), same trust level as sponsorName already has
  // in publicWeek() above.
  async getBanner(weekId) {
    await this.ready();
    const banner = this.bookings[weekId]?.banner;
    if (!banner || !this.env?.PARTNERSHIP_BANNERS) return null;
    const object = await this.env.PARTNERSHIP_BANNERS.get(banner.key);
    if (!object) return null;
    return { body: object.body, contentType: banner.contentType };
  }

  // Plain HTTP surface for the browser (src/net.js) — no RPC callers yet
  // (unlike RadarCollector/LeagueSeason, nothing else in this Worker needs
  // to reach into Partnership state).
  //   GET  ?wallet=<address>                              -> { weeks: [...] }
  //   GET  ?banner=<weekId>                                -> raw image bytes
  //   POST ?action=reserve  {weekIds, wallet}              -> reserve()
  //   POST ?action=release  {weekIds, wallet}              -> release()
  //   POST ?action=confirm  {weekIds, wallet, paymentTx, sponsorName}        -> confirmPayment()
  //   POST ?action=uploadBanner&weekId=&wallet=  (raw image body)           -> uploadBanner()
  async onRequest(request) {
    await this.ready();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.has('banner')) {
      const banner = await this.getBanner(url.searchParams.get('banner'));
      if (!banner) return new Response('Not found', { status: 404, headers: cors });
      // Cached at the edge — a banner is re-uploaded rarely (spec: overwrite
      // replaces it) and every viewer during a scored point/ticket hits this
      // same URL, so this is worth caching unlike the JSON routes above.
      return new Response(banner.body, { headers: { ...cors, 'Content-Type': banner.contentType, 'Cache-Control': 'public, max-age=3600' } });
    }
    if (request.method === 'GET') {
      return Response.json({ weeks: this.listWeeks(url.searchParams.get('wallet')) }, { headers: cors });
    }
    if (request.method === 'POST' && url.searchParams.get('action') === 'uploadBanner') {
      const weekId = url.searchParams.get('weekId');
      const wallet = url.searchParams.get('wallet');
      const bytes = await request.arrayBuffer();
      const result = await this.uploadBanner({ weekId, wallet, bytes });
      return Response.json(result, { headers: cors });
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
