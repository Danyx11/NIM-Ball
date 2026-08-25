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
// endpoint below has to be passed explicitly. Mainnet (was testnet during
// early exploration) — a player's real wallets live in the mainnet Hub's own
// browser storage, a completely separate origin/store from the testnet
// Hub's, so pointing here at testnet only ever offered whatever unrelated
// account happened to exist there, never the accounts a real player expects
// to pick from.
const HUB_ENDPOINT = 'https://hub.nimiq.com';
let hubApi = null;
function getHubApi() {
  if (!hubApi) hubApi = new HubApi(HUB_ENDPOINT);
  return hubApi;
}

// The chosen address is only re-requested from the Hub when the player
// explicitly clicks connect again — persisted here so it survives a real
// page refresh (there's no page reload on "Quitter"/"Retour au menu"
// anymore, see game.js's stopGame(), but a manual F5 still counts), instead
// of forgetting the connection every time.
const HUB_ADDRESS_KEY = 'nimball-hub-address';

export function getStoredAddress() {
  return localStorage.getItem(HUB_ADDRESS_KEY);
}

// Opens the Hub's account-picker popup and resolves with the chosen
// address. Works in any desktop browser (no Nimiq Pay required).
export function chooseAddress() {
  return getHubApi().chooseAddress({ appName: 'NimiCurl' }).then((result) => {
    localStorage.setItem(HUB_ADDRESS_KEY, result.address);
    return result;
  });
}

// ---- Nimiq Pay wallet identity (Mini App SDK provider) ----
// Inside Nimiq Pay the player already has an active wallet in the host app —
// no popup needed, just ask the injected provider for it. connectNimiq()
// itself rejects/times out when not running inside Nimiq Pay (see above),
// which is what lets connectIdentity() below use it as the "are we in Pay?"
// check rather than a separate UA sniff.
async function connectPayAccount() {
  const provider = await connectNimiq();
  await provider.connect();
  const accounts = await provider.listAccounts();
  if (!Array.isArray(accounts)) throw new Error(accounts?.error?.message || 'No wallet account available.');
  const [address] = accounts;
  if (!address) throw new Error('No wallet account available.');
  localStorage.setItem(HUB_ADDRESS_KEY, address);
  return address;
}

// ---- Connect gate (main.js's #connectGateOverlay: "Connect" or "Play as
// guest", shown once before mode-select) ----
// The gate's "Connect" button doesn't need to know ahead of time whether
// it's running inside Nimiq Pay or a plain desktop browser — try the Pay
// account first (fast/instant once connectNimiq() has already settled from
// its boot-time call in main.js) and fall back to the Hub popup, which works
// in any browser.
export async function connectIdentity() {
  try {
    return await connectPayAccount();
  } catch {
    const result = await chooseAddress();
    return result.address;
  }
}

const GUEST_KEY = 'nimball-guest';

// null = never decided yet (gate should show); otherwise the persisted
// choice from a previous visit (see HUB_ADDRESS_KEY/GUEST_KEY above).
export function getIdentity() {
  const address = getStoredAddress();
  if (address) return { type: 'address', address };
  if (localStorage.getItem(GUEST_KEY)) return { type: 'guest' };
  return null;
}

export function setGuest() {
  localStorage.removeItem(HUB_ADDRESS_KEY);
  localStorage.setItem(GUEST_KEY, '1');
}

// Back to "never decided" — used by the corner identity pill's disconnect
// action to reopen the gate (see main.js).
export function clearIdentity() {
  localStorage.removeItem(HUB_ADDRESS_KEY);
  localStorage.removeItem(GUEST_KEY);
}

// ---- NimConnect handle (placeholder) ----------------------------------
// No real handle registry exists yet — this is local-only scaffolding for
// the sidebar identity pill's "Claim a handle" flow (see main.js's
// openClaimHandleDialog()) so that UI/data flow already works end to end and
// only this storage layer needs swapping for the real NimConnect lookup/
// claim API once it exists, not the call sites.
const HANDLE_KEY_PREFIX = 'nimball-handle-';
export function getHandle(address) {
  return localStorage.getItem(HANDLE_KEY_PREFIX + address) || null;
}
export function setHandle(address, handle) {
  localStorage.setItem(HANDLE_KEY_PREFIX + address, handle);
}
