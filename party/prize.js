// NIM prizes for LIVE/WEEK wins — a single fixed-name Durable Object
// (PRIZE_ROOM_NAME, same pattern as party/radar.js/party/partnership.js)
// that decides whether a just-completed match earns its winner 10 NIM, and
// if so signs and broadcasts that payout itself using party/nimiqTx.js (see
// that file's own header for why this had to be hand-built: nothing in this
// codebase previously had any capability to send NIM server-side — every
// existing transfer, including party/partnership.js's, is verified
// read-only, signed by the PLAYER's own wallet).
//
// Called over Durable Object RPC from party/arbiter.js (LIVE) and
// party/weekArbiter.js (WEEK) — same "the RPC boundary IS the auth" pattern
// party/radar.js documents for itself: there is no public HTTP endpoint here
// a client could call directly to fabricate a win.
//
// evaluate() is the entire public surface. It is idempotent per matchId
// (LIVE's 'live:<code>', WEEK's 'week:<code>' — the exact same id strings
// party/leagueSeason.js already keys League matches by) — a duplicate call
// for the same matchId (LIVE's both-clients-send-matchOver behavior, a
// retried WEEK completeRound) returns the already-decided result instead of
// re-evaluating or double-paying.
import { Server } from 'partyserver';
import {
  buildAndSignBasicTransaction, getBlockNumber, sendRawTransaction,
  fromUserFriendlyAddress, MAIN_ALBATROSS_NETWORK_ID,
} from './nimiqTx.js';

export const PRIZE_ROOM_NAME = 'v1';

const DAY_MS = 24 * 60 * 60 * 1000;
const PARIS_TZ = 'Europe/Paris';

const LUNA_PER_NIM = 1e5; // same constant party/partnership.js already uses
const PRIZE_AMOUNT_NIM = 10;
const PRIZE_AMOUNT_LUNA = PRIZE_AMOUNT_NIM * LUNA_PER_NIM;
const DAILY_BUDGET_LUNA = 1000 * LUNA_PER_NIM;
const MAX_WALLET_PAYOUTS_PER_DAY = 3;
const PAIR_COOLDOWN_MS = 7 * DAY_MS;

const DEFAULT_NIMIQ_RPC_URL = 'https://rpc.nimiqwatch.com';

function normalizeAddress(address) {
  return typeof address === 'string' ? address.replace(/\s+/g, '').toUpperCase() : address;
}

function pairKeyFor(addressA, addressB) {
  return [normalizeAddress(addressA), normalizeAddress(addressB)].sort().join('|');
}

// Europe/Paris calendar date — same DST-safe Intl-at-call-time approach as
// party/radar.js's parisDateParts, duplicated rather than imported (party/
// files each keep their own copy of small pure helpers like this, see
// party/partnership.js's own comment on why).
function parisDate(timestampMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: PARIS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(timestampMs).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function emptyDay(date) {
  return { date, spentLuna: 0, paidCount: 0, walletPayoutsToday: {} };
}

export class PrizeVault extends Server {
  onStart() {
    this._loaded = (async () => {
      // matchId -> { status, reason, mode, timestampMs, winnerAddress,
      // amountNim, txId } — see evaluate()'s own comment for why this both
      // records history AND is the idempotency guard.
      this.payouts = (await this.ctx.storage.get('payouts')) || {};
      // pairKey (sorted "addrA|addrB") -> last-paid timestamp, never expires
      // by day (a 7-day cooldown has to survive a day-doc rollover) — same
      // "persist forever" shape as party/radar.js's own `wallets` map.
      this.pairCooldowns = (await this.ctx.storage.get('pairCooldowns')) || {};
      this.cumulative = (await this.ctx.storage.get('cumulative')) || { totalPaidLuna: 0, totalPaidCount: 0 };
    })();
    // Single-writer queue — see party/radar.js's onStart for the exact same
    // reasoning, doubly important here: two matches completing close
    // together must never both read the same day's pre-debit budget/wallet
    // counters and both "succeed" past a cap that only had room for one.
    this._writeQueue = Promise.resolve();
  }

  async ready() { if (this._loaded) await this._loaded; }

  serialized(fn) {
    const run = this._writeQueue.then(fn, fn);
    this._writeQueue = run.catch(() => {});
    return run;
  }

  async persistPayouts() { await this.ctx.storage.put('payouts', this.payouts); }
  async persistPairCooldowns() { await this.ctx.storage.put('pairCooldowns', this.pairCooldowns); }
  async persistCumulative() { await this.ctx.storage.put('cumulative', this.cumulative); }
  async loadDay(date) { return (await this.ctx.storage.get(`day:${date}`)) || emptyDay(date); }
  async saveDay(day) { await this.ctx.storage.put(`day:${day.date}`, day); }

  // Builds, signs and broadcasts the actual payout — see party/nimiqTx.js's
  // header for how this format was derived/verified. Throws on any failure
  // (misconfigured secret, RPC unreachable, node rejects the tx); evaluate()
  // below catches that and leaves the match's own record at 'eligible'
  // rather than 'paid' — see its own comment on why this deliberately isn't
  // auto-retried.
  async sendPrize(winnerAddress) {
    const privateKeyHex = this.env?.PRIZE_WALLET_PRIVATE_KEY;
    if (!privateKeyHex) throw new Error('server misconfigured: no PRIZE_WALLET_PRIVATE_KEY');
    const rpcUrl = this.env?.NIMIQ_RPC_URL || DEFAULT_NIMIQ_RPC_URL;
    const recipientBytes = fromUserFriendlyAddress(winnerAddress);
    const validityStartHeight = await getBlockNumber(rpcUrl);
    const { rawHex, txId, senderAddress } = buildAndSignBasicTransaction({
      privateKeyHex, recipientAddress: recipientBytes,
      valueLuna: PRIZE_AMOUNT_LUNA, feeLuna: 0,
      validityStartHeight, networkId: MAIN_ALBATROSS_NETWORK_ID,
    });
    // Cheap misconfiguration guard: if PRIZE_WALLET_ADDRESS is set, the key
    // actually loaded must derive to it — catches a wrong/rotated secret
    // before it silently starts paying out from an unexpected address.
    const expectedSender = this.env?.PRIZE_WALLET_ADDRESS;
    if (expectedSender && normalizeAddress(expectedSender) !== normalizeAddress(senderAddress)) {
      throw new Error(`server misconfigured: PRIZE_WALLET_PRIVATE_KEY derives to ${senderAddress}, expected ${expectedSender}`);
    }
    // Broadcast can time out without telling us whether the node actually
    // accepted it before dropping the connection — same "don't mistake
    // unreachable for never sent" reasoning as party/partnership.js's own
    // fetchNimiqTransaction comment. txId is already known locally (computed
    // from the signed content, not from this call's response) and gets
    // persisted by evaluate() regardless, so a stuck/ambiguous broadcast is
    // at least traceable via getTransactionByHash later, not silently lost.
    const broadcastTxId = await sendRawTransaction(rpcUrl, rawHex);
    return { txId: broadcastTxId || txId };
  }

  // payload: { matchId, mode: 'live'|'week', timestampMs,
  //   playerA: {address}, playerB: {address}, winner: 'A'|'B' }
  // Returns { status: 'paid'|'eligible'|'not_eligible'|'budget_exhausted',
  //   reason?, amountNim, txId?, winnerAddress? } — 'eligible' with no txId
  // means the eligibility/anti-farming checks all passed but the actual
  // broadcast failed (see sendPrize's own comment); it is NOT retried
  // automatically (no queue/alarm for that — see CLAUDE.md's "don't
  // overbuild" precedent elsewhere in this codebase), so a run of these
  // needs to be visible in `wrangler tail` logs for now rather than
  // silently lost. Good enough for the "functional, simple, safe, ship
  // fast" brief this feature was built under; a retry queue is a real
  // possible follow-up, not a v1 requirement.
  evaluate({ matchId, mode, timestampMs, playerA, playerB, winner }) {
    return this.serialized(async () => {
      await this.ready();
      if (!matchId || typeof matchId !== 'string') return { status: 'not_eligible', reason: 'bad_request', amountNim: 0 };
      // Idempotent replay — see this class's own header comment. Never
      // re-runs eligibility/anti-farming/budget for a matchId already
      // decided, whatever the previous outcome was.
      if (this.payouts[matchId]) return this.payouts[matchId];

      const finalize = async (result) => {
        const record = { matchId, mode, timestampMs, amountNim: PRIZE_AMOUNT_NIM, ...result };
        this.payouts[matchId] = record;
        await this.persistPayouts();
        return record;
      };

      if (mode !== 'live' && mode !== 'week') return finalize({ status: 'not_eligible', reason: 'bad_mode', amountNim: 0 });
      if (winner !== 'A' && winner !== 'B') return finalize({ status: 'not_eligible', reason: 'no_winner', amountNim: 0 });

      const addressA = playerA?.address, addressB = playerB?.address;
      if (!addressA || !addressB) return finalize({ status: 'not_eligible', reason: 'wallet_required', amountNim: 0 });

      const winnerAddress = winner === 'A' ? addressA : addressB;
      const loserAddress = winner === 'A' ? addressB : addressA;
      if (normalizeAddress(winnerAddress) === normalizeAddress(loserAddress)) {
        return finalize({ status: 'not_eligible', reason: 'same_wallet', amountNim: 0 });
      }

      // Anti-farming — checked (and, on success, committed) before the
      // actual payout attempt, atomically with it inside this same
      // serialized() call, so two matches racing for the same pair/wallet/
      // budget can't both slip through.
      const pairKey = pairKeyFor(addressA, addressB);
      const lastPairPaidAt = this.pairCooldowns[pairKey];
      if (lastPairPaidAt && timestampMs - lastPairPaidAt < PAIR_COOLDOWN_MS) {
        return finalize({ status: 'not_eligible', reason: 'pair_cooldown', winnerAddress, amountNim: 0 });
      }

      const date = parisDate(timestampMs);
      const day = await this.loadDay(date);
      const normalizedWinner = normalizeAddress(winnerAddress);
      const walletCountToday = day.walletPayoutsToday[normalizedWinner] || 0;
      if (walletCountToday >= MAX_WALLET_PAYOUTS_PER_DAY) {
        return finalize({ status: 'not_eligible', reason: 'wallet_daily_cap', winnerAddress, amountNim: 0 });
      }

      if (day.spentLuna + PRIZE_AMOUNT_LUNA > DAILY_BUDGET_LUNA) {
        // Per spec: the match itself stays perfectly valid, it simply earns
        // no prize once the daily pool is spent — never exposed as a UI
        // "mechanic", just this status.
        return finalize({ status: 'budget_exhausted', winnerAddress, amountNim: 0 });
      }

      let payment;
      try {
        payment = await this.sendPrize(winnerAddress);
      } catch (err) {
        console.error('[prize] payout failed:', err);
        // Left at 'eligible' (not committed to budget/cooldown/wallet-cap —
        // nothing was actually spent) so a manual look at the logs can
        // decide whether to hand-retry; the match plays on unaffected
        // either way (per spec: a payout failure must never touch scoring).
        return finalize({ status: 'eligible', winnerAddress, amountNim: PRIZE_AMOUNT_NIM });
      }

      day.spentLuna += PRIZE_AMOUNT_LUNA;
      day.paidCount += 1;
      day.walletPayoutsToday[normalizedWinner] = walletCountToday + 1;
      await this.saveDay(day);
      this.pairCooldowns[pairKey] = timestampMs;
      await this.persistPairCooldowns();
      this.cumulative.totalPaidLuna += PRIZE_AMOUNT_LUNA;
      this.cumulative.totalPaidCount += 1;
      await this.persistCumulative();

      return finalize({ status: 'paid', winnerAddress, amountNim: PRIZE_AMOUNT_NIM, txId: payment.txId });
    });
  }
}
