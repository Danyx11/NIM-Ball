// Partnership payment seam — quoting ($10/week -> NIM) and the actual wallet
// transfer, kept separate from src/nimiq.js (general wallet identity/claim
// integration) the same way src/nimconnect.js sits next to it as a
// feature-specific consumer. Scope note: this file is ONLY the payment path
// (quote + pay). Booking/reservation state, banner storage and on-chain
// payment verification are separate, later pieces — see CLAUDE.md.
import { getExchangeRates, CryptoCurrency, FiatCurrency, Provider } from '@nimiq/utils';
import { sendNimPayment } from './nimiq.js';

export const PARTNERSHIP_WEEKLY_USD = 10;

// 1 NIM = 1e5 Luna — the unit every Nimiq wallet API here (mini-app-sdk's
// provider.d.ts, hub-api's checkout `value`) actually takes.
const LUNA_PER_NIM = 1e5;

// How long a frozen quote stays valid for payment. NIM/USD moves slowly
// enough minute-to-minute that this is about UX (don't let someone sit on a
// stale "42.37 NIM" screen for an hour), not price-risk precision — pick a
// different value if product wants a tighter/looser window, this isn't
// derived from anything load-bearing.
export const QUOTE_TTL_MS = 5 * 60 * 1000;

// Never hardcoded: a real NIM address, but still configured through Vite's
// build-time env (see .env.example) rather than written into source, so the
// production address is a deployment concern, not a code change. Empty in
// any environment that hasn't set it (local dev without a .env entry) —
// callers must treat that as "not configured", not silently pay a blank
// recipient.
export const PARTNERSHIP_PAYMENT_ADDRESS = import.meta.env.VITE_PARTNERSHIP_PAYMENT_ADDRESS || '';

// `?fakePartnership` (same convention as nimconnect.js's `?fakeHandles`) —
// skips both the rate fetch and the real wallet call, for iterating on the
// future Partnership UI without a funded wallet or a live price feed.
// `?fakePartnership=cancelled` / `=error` select which outcome payPartnership
// resolves to; any other value (including bare `?fakePartnership`) is the
// success path.
const fakeParam = new URLSearchParams(window.location.search).get('fakePartnership');
export const FAKE_MODE = new URLSearchParams(window.location.search).has('fakePartnership');
const FAKE_OUTCOME = fakeParam || 'submitted';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// { weeks, usdTotal, rateUsdPerNim, amountNim, amountLuna, fetchedAt, expiresAt }
// amountLuna is the integer that actually gets sent — amountNim is only for
// display, so display rounding never drifts from the payment amount.
export async function quotePartnership(weeks) {
  if (!Number.isInteger(weeks) || weeks < 1) throw new Error(`Invalid week count: ${weeks}`);
  const usdTotal = weeks * PARTNERSHIP_WEEKLY_USD;
  let rateUsdPerNim;
  if (FAKE_MODE) {
    await wait(300);
    rateUsdPerNim = 0.236; // matches the example in the spec, fake mode only
  } else {
    // Provider.CoinGecko, not the getExchangeRates default (CryptoCompare):
    // verified in-browser that min-api.cryptocompare.com has no
    // Access-Control-Allow-Origin header at all, so it can never be called
    // client-side (it hangs, retrying forever — see FiatApi's own retry
    // loop) — only from a server. CoinGecko's public API is CORS-open and
    // was confirmed working from this app's own origin.
    const rates = await getExchangeRates([CryptoCurrency.NIM], [FiatCurrency.USD], Provider.CoinGecko);
    rateUsdPerNim = rates?.[CryptoCurrency.NIM]?.[FiatCurrency.USD];
    if (!rateUsdPerNim) throw new Error('NIM/USD rate unavailable.');
  }
  const amountNim = usdTotal / rateUsdPerNim;
  const fetchedAt = Date.now();
  return {
    weeks,
    usdTotal,
    rateUsdPerNim,
    amountNim,
    amountLuna: Math.round(amountNim * LUNA_PER_NIM),
    fetchedAt,
    expiresAt: fetchedAt + QUOTE_TTL_MS,
  };
}

export function isQuoteExpired(quote) {
  return Date.now() > quote.expiresAt;
}

// Structured result only — the UI never inspects a raw provider/HubApi
// response. `quote` must come from quotePartnership() above: the amount
// actually sent is quote.amountLuna, frozen at quote time — this function
// never re-fetches the rate, so a wallet confirmation left open for a while
// still pays exactly what the screen showed.
export async function payPartnership({ quote, recipient = PARTNERSHIP_PAYMENT_ADDRESS }) {
  if (!recipient) return { status: 'error', error: 'Partnership payment address is not configured.' };
  if (isQuoteExpired(quote)) return { status: 'error', error: 'Quote expired — request a new one.' };
  if (FAKE_MODE) {
    await wait(900);
    if (FAKE_OUTCOME === 'cancelled') return { status: 'cancelled' };
    if (FAKE_OUTCOME === 'error') return { status: 'error', error: 'Simulated wallet error.' };
    return { status: 'submitted', transaction: { hash: 'fake-tx-hash' } };
  }
  try {
    const transaction = await sendNimPayment({ recipient, valueLuna: quote.amountLuna });
    return { status: 'submitted', transaction };
  } catch (err) {
    if (err.cancelled) return { status: 'cancelled' };
    return { status: 'error', error: err.message };
  }
}
