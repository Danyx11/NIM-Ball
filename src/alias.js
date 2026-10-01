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
