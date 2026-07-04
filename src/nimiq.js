// Integration point for the Nimiq Mini App SDK (@nimiq/mini-app-sdk).
// The game must stay playable in a plain browser during development, so
// nothing here blocks startGame() — it only exposes optional Nimiq Pay
// features (wallet identity, device id, language) for features to opt into.
import { init, requestDeviceIdentifier } from '@nimiq/mini-app-sdk';

let nimiqPromise = null;

// Resolves once Nimiq Pay injects its provider, or rejects/timeouts when
// the app is opened outside Nimiq Pay (e.g. a regular desktop browser).
export function connectNimiq({ timeout = 10_000 } = {}) {
  if (!nimiqPromise) nimiqPromise = init({ timeout });
  return nimiqPromise;
}

// ISO 639-1 language selected in Nimiq Pay, with a browser-locale fallback
// for when the mini app runs outside Nimiq Pay.
export function getLanguage() {
  return window.nimiqPay?.language || navigator.language.split('-')[0] || 'fr';
}

// Stable per-device id, useful for save slots / leaderboards. Prompts the
// user with `reason` on first call per origin; silent afterwards.
export function getDeviceId(reason) {
  return requestDeviceIdentifier({ reason });
}
