// Thin wrapper around @nimconnect/profile-client (see nimconnect.nimiqminiapps.com's
// API docs) for resolving and claiming shared on-chain @handles. Read calls hit
// NimConnect's public, CORS-open API; claiming only builds the tx payload here —
// signing/sending goes through whatever wallet integration is already connected
// (see src/nimiq.js's sendClaimTransaction).
//
// `?fakeHandles` in the URL swaps every export below for an in-memory fake with
// the same shape and roughly the same timing, no network calls and no real
// transaction — for iterating on the claim dialog's UI without a funded wallet or
// a real block confirmation to wait on. Typed conventions in fake mode: the handle
// "taken" is always already-claimed by someone else at the availability check; a
// handle ending in "race" passes that check but then loses the on-chain race once
// "confirmed" (see openClaimHandleDialog() in main.js for how each outcome renders).
import { createProfileClient, buildHandleClaimPayload, isValidHandle as isValidHandleReal, compactAddress } from '@nimconnect/profile-client';

export const FAKE_MODE = new URLSearchParams(window.location.search).has('fakeHandles');

export const isValidHandle = isValidHandleReal;

const client = FAKE_MODE ? null : createProfileClient();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// { address, handle?, displayName?, bio?, links? } — handle is undefined when the
// address has never claimed one, same as the real getDisplayIdentity() below.
export function resolveIdentity(address) {
  if (FAKE_MODE) return wait(300).then(() => ({ address }));
  return client.getDisplayIdentity(address);
}

export async function checkHandleAvailable(handle) {
  if (FAKE_MODE) {
    await wait(700);
    return handle !== 'taken';
  }
  const claim = await client.resolveHandle(handle);
  return claim === null;
}

// Pure — never touches the network either way, so this is safe to call even in
// fake mode (the resulting payload is simply never sent there).
export function buildClaimPayload(handle) {
  return buildHandleClaimPayload(handle);
}

// Polls the registry until `handle` resolves, then reports whether it resolved to
// our own address (confirmed) or someone else's (we lost the race). No payment-
// grade freshness needed here — the only thing at stake is the handle itself, not
// money — so a plain resolveHandle poll is enough.
export async function waitForClaimOutcome(handle, address, { intervalMs = 3000, timeoutMs = 120_000 } = {}) {
  if (FAKE_MODE) {
    await wait(1200);
    return handle.endsWith('race') ? 'raceLost' : 'confirmed';
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const claim = await client.resolveHandle(handle);
    if (claim) return compactAddress(claim.address) === compactAddress(address) ? 'confirmed' : 'raceLost';
    await wait(intervalMs);
  }
  return 'timeout';
}
