// Alias registry — NimiCurl's own lightweight replacement for the deprecated
// NimConnect @handle service (NimConnect has shut down; this file used to be
// src/nimconnect.js, a thin wrapper around @nimconnect/profile-client's
// public API — see CLAUDE.md's "Alias registry" section for the full story
// and party/aliases.js for the server half, a single fixed-room Durable
// Object this game now owns outright). src/net.js carries the plain HTTP
// calls; this file wraps them with the domain logic main.js's claim dialog
// actually drives (validation, fake mode) — the same role nimconnect.js
// played for the old NimConnect-backed version of this feature.
//
// `?fakeAlias` in the URL swaps every export below for an in-memory fake
// with roughly the same timing, no network calls and no real transaction —
// same spirit nimconnect.js's old `?fakeHandles` had, for iterating on the
// claim dialog's UI without a funded wallet or a real block confirmation to
// wait on. Typed convention in fake mode: an alias ending in "taken" is
// always already claimed by someone else.
import { fetchAliasForWallet, reserveAlias as reserveAliasReal, releaseAlias as releaseAliasReal, confirmAliasPayment as confirmAliasPaymentReal } from './net.js';

export const FAKE_MODE = new URLSearchParams(window.location.search).has('fakeAlias');

// 3-31 chars, a-z 0-9 _ only — kept in sync by hand with party/aliases.js's
// own ALIAS_RE, which is the copy that actually gates storage; this one is
// just for instant client-side feedback before a round trip.
const ALIAS_RE = /^[a-z0-9_]{3,31}$/;
export function isValidAlias(value) { return ALIAS_RE.test(value); }

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// { address, alias? } — alias is undefined when the address has never
// claimed one, same shape nimconnect.js's getDisplayIdentity() used to give.
export function resolveIdentity(address) {
  if (FAKE_MODE) return wait(300).then(() => ({ address }));
  return fetchAliasForWallet(address).then(({ alias }) => ({ address, alias: alias || undefined }));
}

// Same flat price party/aliases.js's own ALIAS_PRICE_LUNA locks in — only
// used here to make the fake-mode response shape realistic, never trusted
// for a real payment (confirmAliasPayment below always goes through the
// server either way).
const FAKE_PRICE_LUNA = 30 * 1e5;

export async function reserveAlias(alias, wallet) {
  if (FAKE_MODE) {
    await wait(500);
    if (alias.endsWith('taken')) return { ok: false, error: 'already taken' };
    return { ok: true, alias, amountLuna: FAKE_PRICE_LUNA, pendingExpiresAt: Date.now() + 15 * 60 * 1000 };
  }
  return reserveAliasReal(alias, wallet);
}

export function releaseAlias(alias, wallet) {
  if (FAKE_MODE) return Promise.resolve({ ok: true });
  return releaseAliasReal(alias, wallet);
}

export async function confirmAliasPayment(ctx) {
  if (FAKE_MODE) {
    await wait(800);
    return { ok: true, alias: ctx.alias };
  }
  return confirmAliasPaymentReal(ctx);
}

// ---------------------------------------------------------------------
// Pending-claim persistence — the actual fix for "NIM left the wallet but
// the alias never got attributed" (see conversation). Once sendNimPayment()
// resolves with a real tx hash, that hash only ever lived in main.js's
// in-memory `ctx` until now — closing the tab, refreshing, or the claim
// dialog getting dismissed for any reason between then and confirmPayment()
// succeeding meant the hash was simply gone, with no way back to it even
// though party/aliases.js's own pending reservation was (before its matching
// fix) still sitting there waiting to be confirmed. main.js saves one of
// these the moment a real payment is sent, resumes straight into the
// 'confirming' step from it on the next openClaimAliasDialog() instead of
// starting a fresh (and, pre-fix, destructive) reserve(), and clears it once
// the claim is confirmed or definitively dead. A single slot, not keyed per
// wallet — this device can only ever be mid-claim for whichever wallet is
// currently connected, same single-identity assumption the rest of this
// file already makes.
const PENDING_CLAIM_KEY = 'nimball-alias-pending-claim';

// Never persisted in FAKE_MODE — a fake tx hash can never resolve against
// the real server, so saving one here would permanently "stick" the next,
// real session into resuming a claim that will fail forever (see
// loadPendingClaim's MAX_AGE_MS below for the other half of that guard).
export function savePendingClaim({ wallet, alias, paymentTx, amountLuna }) {
  if (FAKE_MODE) return;
  try {
    localStorage.setItem(PENDING_CLAIM_KEY, JSON.stringify({ wallet, alias, paymentTx, amountLuna, savedAt: Date.now() }));
  } catch { /* private-browsing localStorage throw — worst case, no resume on reload */ }
}

// A real claim should never take anywhere near this long to confirm or to
// be declared a dead end (REQUIRED_CONFIRMATIONS is a matter of minutes at
// most) — this is just a backstop against resuming into a permanently
// stuck/forgotten record forever (an RPC outage, a tx that never confirms)
// with no way out short of clearing site data.
const MAX_AGE_MS = 60 * 60 * 1000;

// Returns null if there's nothing saved, it belongs to a different wallet
// than the one asking (e.g. the identity was switched since), or it's past
// MAX_AGE_MS — never hands back another wallet's in-flight claim or a
// hopelessly stale one.
export function loadPendingClaim(wallet) {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_CLAIM_KEY) || 'null');
    if (!saved || saved.wallet !== wallet) return null;
    if (Date.now() - saved.savedAt > MAX_AGE_MS) { clearPendingClaim(); return null; }
    return saved;
  } catch {
    return null;
  }
}

export function clearPendingClaim() {
  try { localStorage.removeItem(PENDING_CLAIM_KEY); } catch { /* nothing to clear anyway */ }
}
