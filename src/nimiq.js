// Integration point for the Nimiq Mini App SDK (@nimiq/mini-app-sdk).
// The game must stay playable in a plain browser during development, so
// nothing here blocks startGame() — it only exposes optional Nimiq Pay
// features (wallet identity, device id, language) for features to opt into.
import { init, requestDeviceIdentifier } from '@nimiq/mini-app-sdk';
import HubApi from '@nimiq/hub-api';

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

// ---- Desktop wallet identity (Nimiq Hub, @nimiq/hub-api) ----
// Separate integration path from the Mini App SDK above: HubApi's own
// DEFAULT_ENDPOINT only auto-resolves when this page is served from
// nimiq.com/nimiq-testnet.com itself, so on any other origin (ours) it
// silently falls back to a local Hub dev server (localhost:8080) — the
// endpoint below has to be passed explicitly. Testnet for now, while
// this is still exploratory (see chooseAddressTest in main.js).
const HUB_TESTNET_ENDPOINT = 'https://hub.nimiq-testnet.com';
let hubApi = null;
function getHubApi() {
  if (!hubApi) hubApi = new HubApi(HUB_TESTNET_ENDPOINT);
  return hubApi;
}

// The chosen address is only re-requested from the Hub when the player
// explicitly clicks connect again — persisted here so it survives the
// location.reload() that "Quitter"/"Retour au menu" do to get back to a
// clean mode-select screen (see main.js/game.js), instead of forgetting the
// connection on every trip back to the menu.
const HUB_ADDRESS_KEY = 'nimball-hub-address';

export function getStoredAddress() {
  return localStorage.getItem(HUB_ADDRESS_KEY);
}

// Opens the Hub's account-picker popup and resolves with the chosen
// address. Works in any desktop browser (no Nimiq Pay required).
export function chooseAddress() {
  return getHubApi().chooseAddress({ appName: 'Nim-Curl' }).then((result) => {
    localStorage.setItem(HUB_ADDRESS_KEY, result.address);
    return result;
  });
}
