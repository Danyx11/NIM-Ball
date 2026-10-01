// Alias registry — NimiCurl's own lightweight replacement for the deprecated
// NimConnect @handle service (NimConnect itself has shut down; see
// CLAUDE.md's "Alias registry" section for the full story). A single
// fixed-name Durable Object (ALIAS_ROOM_NAME, same pattern as
// party/partnership.js/party/radar.js) holding alias -> wallet and
// wallet -> alias maps. Permanent once paid, same guarantee the old
// on-chain NimConnect claim gave: no renaming, no releasing an alias that's
// already confirmed.
//
// confirmPayment() below verifies the reported transaction against the real
// Nimiq chain (existence, confirmations, sender, recipient, value, reuse) —
// identical shape to party/partnership.js's own confirmPayment (duplicated
// rather than shared, same "small, independent Durable Object files" habit
// every other class in this directory already follows). This is the SECOND
// class in this codebase gating a real paid feature, so like Partnership it
// deliberately does NOT follow the "the RPC/room-key IS the trust boundary"
// pattern most of party/ uses.
import { Server } from 'partyserver';

export const ALIAS_ROOM_NAME = 'v1';

const LUNA_PER_NIM = 1e5;

// Flat NIM price, not USD-pegged like Partnership's weekly rate — a round
// number is easier to reason about for a one-time name claim, and set high
// enough (vs. the old claim, which only ever cost network fees) that
// squatting a pile of aliases for fun isn't worth it even with today's
// near-zero traffic (see conversation: "ca evite qu'un bad actor s'amuse à
// tout saturer pour le fun").
const ALIAS_PRICE_LUNA = 30 * LUNA_PER_NIM;

// Reuses the exact same project wallet Partnership already collects
// payments into (wrangler.jsonc's PARTNERSHIP_PAYMENT_ADDRESS) — one
// treasury address for every paid feature in this Worker, not a NimiCurl-
// specific env var per feature.
const DEFAULT_NIMIQ_RPC_URL = 'https://rpc.nimiqwatch.com';

// Deliberately much shallower than party/partnership.js's own
// REQUIRED_CONFIRMATIONS (20) — this gates a flat 30 NIM claim, not a
// sponsor-week payment, so the cost of a successful reorg attack here is
// nowhere near worth mounting one; the UX cost of waiting ~20 real seconds
// for that same margin was not (see conversation — a slow, manual-click-only
// confirm flow is what let real payments sit unattributed in the first
// place). Still a confirmation-COUNT margin against the RPC node's own view
// of the chain reorganizing, not a protocol finality constant — just a much
// smaller one, matched to this feature's actual stakes. Albatross blocks
// land roughly every ~1s, so this is a ~3s wait, not a 20s one.
const REQUIRED_CONFIRMATIONS = 3;

const RPC_TIMEOUT_MS = 10_000;
const FETCH_USER_AGENT = 'NimiCurl-Alias-Worker/1.0';

// Same reasoning as party/partnership.js's PENDING_TTL_MS, but considerably
// longer than that one: a real claim seen in practice took >15 minutes from
// reserve() to a successful confirmPayment() (REQUIRED_CONFIRMATIONS plus
// RPC lag, compounded by the claim dialog's "Check again" originally being a
// manual click — see conversation), and sweepExpired() deleting the row out
// from under an already-paid-for claim is just as much an orphaning bug as
// reserve()'s own fix above. Matches src/alias.js's MAX_AGE_MS, so the
// client-side resume window and the server-side row lifetime agree.
const PENDING_TTL_MS = 60 * 60 * 1000;

// How long reserve() refuses to let a wallet start a SECOND claim attempt
// while its first one is still pending — see that method's own comment.
// Deliberately much shorter than PENDING_TTL_MS: this isn't about freeing
// the name back up (PENDING_TTL_MS still governs that), it's about giving a
// payment that's actually in flight enough time to pick up its
// REQUIRED_CONFIRMATIONS before the client is allowed to retry and silently
// orphan it (see conversation: a real claim's NIM left the wallet but the
// alias never got attributed, traced to exactly this race).
const CLAIM_LOCK_MS = 2 * 60 * 1000;

// 3-31 chars, a-z 0-9 _ only — same shape the old @nimconnect/profile-client
// validated client-side; src/alias.js keeps its own copy of this regex for
// instant client-side feedback, this is the copy that actually gates storage.
const ALIAS_RE = /^[a-z0-9_]{3,31}$/;

// Duplicated from party/partnership.js's own normalizeAddress — see that
// file's comment for why (addresses arrive here from three different
// sources that must compare equal regardless of Nimiq's space-grouped
// user-friendly format).
function normalizeAddress(address) { return typeof address === 'string' ? address.replace(/\s+/g, '').toUpperCase() : address; }

// Identical to party/partnership.js's own fetchNimiqTransaction — see that
// file's header comment for where the response shape comes from
// (core-rs-albatross's rpc-interface Transaction type, verified live against
// rpc.nimiqwatch.com).
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

export class AliasRegistry extends Server {
  onStart() {
    this._loaded = (async () => {
      // alias -> { alias, status: 'pending'|'confirmed', wallet, claimedAt,
      // paymentTx, createdAt, pendingExpiresAt } — same flat-JSON-doc shape
      // as every other small Durable Object here.
      this.aliases = (await this.ctx.storage.get('aliases')) || {};
      // wallet -> alias, for a pending OR confirmed claim — keeps a wallet
      // from holding two reservations at once, and doubles as the fast path
      // for every "show @alias next to this address" lookup elsewhere in the
      // game (My Matches, League leaderboard, WEEK/LIVE opponent labels).
      this.byWallet = (await this.ctx.storage.get('byWallet')) || {};
      // paymentTx (lowercased hex) -> { alias, wallet, confirmedAt} — same
      // reuse guard as party/partnership.js's usedTxHashes, same race-safety
      // (checked and written inside the same serialized() call).
      this.usedTxHashes = (await this.ctx.storage.get('usedTxHashes')) || {};
      await this.migrateWalletNormalization();
    })();
    // Same single-writer-queue pattern as party/partnership.js/radar.js —
    // this is also THE double-claim guard: reserve() only ever runs inside
    // serialized(), so two wallets racing for the same alias always resolve
    // to exactly one winner, no on-chain race possible the way NimConnect's
    // old registry had.
    this._writeQueue = Promise.resolve();
  }

  async ready() { if (this._loaded) await this._loaded; }

  serialized(fn) {
    const run = this._writeQueue.then(fn, fn);
    this._writeQueue = run.catch(() => {});
    return run;
  }

  async persist() {
    await Promise.all([this.ctx.storage.put('aliases', this.aliases), this.ctx.storage.put('byWallet', this.byWallet)]);
  }
  async persistUsedTxHashes() { await this.ctx.storage.put('usedTxHashes', this.usedTxHashes); }

  // One-time self-heal, run once per cold start (cheap even then — this
  // whole registry is tiny): rows reserved before confirmPayment() started
  // normalizing wallets (see that method's own comment) can have `row.wallet`
  // and `byWallet` keys in whatever raw, possibly space-grouped format the
  // client happened to send, which no longer matches what reserve()/
  // release()/lookupByWallet() compute today — found live as a reservation
  // that genuinely belonged to the caller still reporting 'already taken'
  // (the stale pending row was invisible to the wallet-keyed checks that
  // would otherwise have recognized and freed/reused it) while that same
  // wallet's own lookup showed no alias at all. Rebuilds `byWallet` from
  // `aliases` from scratch rather than patching it in place — `aliases` is
  // the source of truth, `byWallet` is just a derived index, so throwing it
  // away and recomputing is simpler than trying to reconcile two documents
  // that may have already drifted from each other. A wallet with more than
  // one row pointing at it (should never happen going forward, but historic
  // data predates several of the guards that now prevent it) keeps its
  // confirmed row over a pending one, and otherwise its most recent.
  async migrateWalletNormalization() {
    const rebuilt = {};
    let changed = false;
    for (const row of Object.values(this.aliases)) {
      const normalized = normalizeAddress(row.wallet);
      if (normalized !== row.wallet) { row.wallet = normalized; changed = true; }
      const current = rebuilt[normalized] ? this.aliases[rebuilt[normalized]] : null;
      if (!current || (current.status !== 'confirmed' && (row.status === 'confirmed' || row.createdAt > current.createdAt))) {
        rebuilt[normalized] = row.alias;
      }
    }
    if (changed || JSON.stringify(rebuilt) !== JSON.stringify(this.byWallet)) {
      this.byWallet = rebuilt;
      await this.persist();
    }
  }

  // Releases any pending reservation whose hold has lapsed — called at the
  // top of every read/write path below, not on a timer, same lazy-sweep
  // reasoning as party/partnership.js's own sweepExpired.
  sweepExpired() {
    const now = Date.now();
    let changed = false;
    for (const [alias, row] of Object.entries(this.aliases)) {
      if (row.status === 'pending' && row.pendingExpiresAt < now) {
        delete this.aliases[alias];
        if (this.byWallet[row.wallet] === alias) delete this.byWallet[row.wallet];
        changed = true;
      }
    }
    return changed;
  }

  // Only ever returns a CONFIRMED alias — a wallet's own still-pending
  // reservation (itself mid-payment) never shows up as "this wallet's
  // alias" to the rest of the game. normalizeAddress() here is what makes
  // this safe to call with whatever raw, possibly-spaced format the caller
  // has on hand (hubAddress, tx.from, …) — byWallet keys are always written
  // normalized below, so reads must normalize too or a real lookup silently
  // misses (found live: confirmPayment() below started keying by tx.from's
  // normalized form, which never matched a GET using hubAddress's spaced one).
  lookupByWallet(wallet) {
    const alias = this.byWallet[normalizeAddress(wallet)];
    const row = alias ? this.aliases[alias] : null;
    return row && row.status === 'confirmed' ? alias : null;
  }

  // Locks the alias to this wallet as `pending` — the availability check
  // IS the reservation attempt, same as party/partnership.js's reserve()
  // doubles as its own week-availability check. A wallet that already holds
  // a CONFIRMED alias can't start a second one. A wallet with a still-
  // PENDING one is refused outright (`error: 'claim_in_progress'`) while
  // CLAIM_LOCK_MS hasn't elapsed since that reservation was created — this
  // used to silently delete-and-replace the old pending row instead, which
  // is exactly what let a real in-flight payment get orphaned: the money
  // was already on its way to confirmation, then a retry (same wallet,
  // same or different alias) wiped the only row confirmPayment() could ever
  // attribute it to. Past the lock window the attempt is presumed genuinely
  // abandoned (never paid) and is freed to make room for a new try, same as
  // before.
  reserve({ alias, wallet }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      if (!wallet || typeof wallet !== 'string') return { ok: false, error: 'wallet required' };
      const normalizedWallet = normalizeAddress(wallet);
      const clean = typeof alias === 'string' ? alias.toLowerCase() : '';
      if (!ALIAS_RE.test(clean)) return { ok: false, error: 'invalid alias' };
      const existingAlias = this.byWallet[normalizedWallet];
      const existingRow = existingAlias ? this.aliases[existingAlias] : null;
      if (existingRow?.status === 'confirmed') return { ok: false, error: 'wallet already has an alias' };
      const now = Date.now();
      if (existingRow?.status === 'pending') {
        const lockExpiresAt = existingRow.createdAt + CLAIM_LOCK_MS;
        if (lockExpiresAt > now) {
          return { ok: false, error: 'claim_in_progress', alias: existingAlias, amountLuna: existingRow.expectedAmountLuna, lockExpiresAt };
        }
        delete this.aliases[existingAlias];
      }
      if (this.aliases[clean]) return { ok: false, error: 'already taken' };
      const pendingExpiresAt = now + PENDING_TTL_MS;
      // expectedAmountLuna is locked in HERE, at reserve() time, and is what
      // confirmPayment() below checks the real transaction against — never
      // the live ALIAS_PRICE_LUNA constant, which can change (as it just
      // did, 100 -> 30 NIM) while a reservation from before that change is
      // still mid-confirmation. Same reasoning party/partnership.js's own
      // reserve() already documents for its own expectedAmountLuna.
      // `wallet` is stored normalized — see lookupByWallet()'s own comment on
      // why every byWallet key/row.wallet value has to agree on one format.
      this.aliases[clean] = {
        alias: clean, status: 'pending', wallet: normalizedWallet, claimedAt: null, paymentTx: null,
        createdAt: now, pendingExpiresAt, expectedAmountLuna: ALIAS_PRICE_LUNA,
      };
      this.byWallet[normalizedWallet] = clean;
      await this.persist();
      return { ok: true, alias: clean, amountLuna: ALIAS_PRICE_LUNA, pendingExpiresAt };
    });
  }

  // Lets the reserving wallet free its own still-pending alias early (quit
  // the claim dialog before paying) instead of waiting out CLAIM_LOCK_MS/
  // PENDING_TTL_MS. Deliberately the ONLY way a pending reservation is ever
  // removed before CLAIM_LOCK_MS elapses — main.js only ever calls this from
  // the 'confirmPay' step's Cancel button, i.e. strictly before sendNimPayment
  // has fired, so there's never real money behind the row being released.
  release({ alias, wallet }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      const normalizedWallet = normalizeAddress(wallet);
      const row = this.aliases[alias];
      if (row && row.status === 'pending' && row.wallet === normalizedWallet) {
        delete this.aliases[alias];
        if (this.byWallet[normalizedWallet] === alias) delete this.byWallet[normalizedWallet];
        await this.persist();
      }
      return { ok: true };
    });
  }

  // Verifies `paymentTx` against the real Nimiq chain before ever marking a
  // reservation confirmed — see this file's header comment for why. Same
  // check order as party/partnership.js's confirmPayment, with one
  // deliberate difference (see the sender step below):
  //   1. the reservation still exists, is pending, and belongs to this wallet
  //   2. paymentTx hasn't already confirmed some other alias
  //   3. the transaction actually exists on-chain
  //   4. it has at least REQUIRED_CONFIRMATIONS (returns a distinct
  //      {ok:false, error:'pending', confirmations, required} so the client
  //      can poll/retry instead of being told it failed)
  //   5. it executed successfully
  //   6. the reservation's own wallet is genuinely tied to this transaction
  //      (see below), recipient == the configured payment address — never
  //      the client's say-so for either
  //   7. value == this row's own expectedAmountLuna, locked in at reserve()
  //      time — never the live ALIAS_PRICE_LUNA constant (see reserve()'s
  //      own comment for why that distinction matters)
  //
  // Step 6 is NOT a plain `tx.from === wallet` check, on purpose — verified
  // live (see conversation) that Nimiq Pay routes its payments through a
  // shared HTLC/swap settlement contract: `tx.from` for one of these is the
  // SAME contract address for every Nimiq Pay payment (fromType 2, not 0 —
  // a Basic account), not personal to any one player, while the player's own
  // wallet shows up instead in `tx.relatedAddresses`. A plain `tx.from`
  // match still works for the OTHER payment rail this game has
  // (src/nimiq.js's Hub checkout() fallback, a normal Basic-account
  // transfer, fromType 0) — relatedAddresses for one of those is just
  // [from, to], so `tx.from === wallet` is really a special case of "wallet
  // appears among this tx's related addresses" rather than something
  // separate. (An earlier version of this check attributed the alias to
  // `tx.from` instead of requiring a match — wrong in a different way: for
  // an HTLC-routed payment that attributes to the SHARED settlement
  // contract, which doesn't distinguish between players at all.)
  confirmPayment({ alias, wallet, paymentTx }) {
    return this.serialized(async () => {
      await this.ready();
      this.sweepExpired();
      if (!wallet || typeof wallet !== 'string') return { ok: false, error: 'wallet required' };
      const normalizedWallet = normalizeAddress(wallet);
      const row = this.aliases[alias];
      if (!row || row.status !== 'pending' || row.wallet !== normalizedWallet) return { ok: false, error: 'not your pending reservation' };
      if (!paymentTx || typeof paymentTx !== 'string') return { ok: false, error: 'paymentTx required' };
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
      const relatedNormalized = [tx.from, ...(tx.relatedAddresses || [])].map(normalizeAddress);
      if (!relatedNormalized.includes(normalizedWallet)) return { ok: false, error: 'sender mismatch' };
      const expectedRecipient = this.env?.PARTNERSHIP_PAYMENT_ADDRESS;
      if (!expectedRecipient) return { ok: false, error: 'server misconfigured: no payment address' };
      if (normalizeAddress(tx.to) !== normalizeAddress(expectedRecipient)) return { ok: false, error: 'recipient mismatch' };
      const expectedAmountLuna = row.expectedAmountLuna ?? ALIAS_PRICE_LUNA; // ?? only ever for a row reserved before this field existed
      if (tx.value !== expectedAmountLuna) return { ok: false, error: 'amount mismatch', expected: expectedAmountLuna, actual: tx.value };

      this.aliases[alias] = { ...row, status: 'confirmed', claimedAt: Date.now(), paymentTx: normalizedHash, pendingExpiresAt: null };
      this.usedTxHashes[normalizedHash] = { alias, wallet: normalizedWallet, confirmedAt: Date.now() };
      await Promise.all([this.persist(), this.persistUsedTxHashes()]);
      return { ok: true, alias };
    });
  }

  // Plain HTTP surface for the browser (src/net.js) — no RPC callers (unlike
  // RadarCollector/LeagueSeason, nothing else in this Worker needs a
  // player's alias).
  //   GET  ?wallet=<address>                       -> { alias: string|null }
  //   POST ?action=reserve  {alias, wallet}         -> reserve()
  //   POST ?action=release  {alias, wallet}         -> release()
  //   POST ?action=confirm  {alias, paymentTx} -> confirmPayment() (the
  //                         client still sends `wallet` too, kept for the
  //                         request shape's own clarity; confirmPayment()
  //                         itself ignores it, see that method's own comment)
  async onRequest(request) {
    await this.ready();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    const url = new URL(request.url);
    if (request.method === 'GET') {
      this.sweepExpired();
      return Response.json({ alias: this.lookupByWallet(url.searchParams.get('wallet')) }, { headers: cors });
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
