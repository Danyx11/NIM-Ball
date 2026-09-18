// Official Nimiq identicon rendering (@nimiq/identicons) — same algorithm and
// visual output as the Nimiq Wallet, given the same address string. Imports
// the lean browser build directly (identicons.min.js, ~5kB) rather than the
// package's default `identicons.bundle.min.js` (~87kB), which only exists to
// bundle a Node DOMParser polyfill we don't need in a browser.
import Identicons from '@nimiq/identicons/dist/identicons.min.js';
// The lib's own shape/color assets (a separate .svg sprite it fetches lazily
// on first use). `?url` makes Vite fingerprint and copy this file next to the
// rest of the build output instead of leaving the package's dead-in-prod
// default path (`/node_modules/@nimiq/identicons/...`) in place.
import identiconsSvgUrl from '@nimiq/identicons/dist/identicons.min.svg?url';
import { normalizeAddress } from './net.js';

window.NIMIQ_IDENTICONS_SVG_PATH = identiconsSvgUrl;

const ASSET_BASE = import.meta.env.BASE_URL;

// The lib hashes the literal characters it's given, and the real Nimiq
// Wallet/Hub feed it the address in its canonical "user-friendly" IBAN
// format — space-separated in groups of 4, e.g. "NQ07 0000 0000 0000 0000
// 0000 0000 0000 0000" (@nimiq/core's `toUserFriendlyAddress()`, which is
// exactly what hubAddress already is straight out of Nimiq Hub). Every
// server-sourced address (League rows, WEEK opponentAddress) has instead
// been through net.js's normalizeAddress, which strips those spaces for
// storage — so it must be reshaped back into the spaced form here, or it
// hashes to a different identicon than the same wallet's real one.
function toUserFriendlyAddress(address) {
  return normalizeAddress(address).match(/.{1,4}/g).join(' ');
}

// address -> Promise<HTMLCanvasElement>, so concurrent requests for the same
// address share one render instead of racing.
const canvasCache = new Map();

// Rasterized identicon at `size`x`size`, cached per address (size is fixed at
// first request — this game only ever needs one size per address).
export function getIdenticonCanvas(address, size = 512) {
  address = toUserFriendlyAddress(address);
  if (!canvasCache.has(address)) canvasCache.set(address, rasterize(address, size));
  return canvasCache.get(address);
}

export async function getIdenticonPngDataUrl(address, size = 512) {
  const canvas = await getIdenticonCanvas(address, size);
  return canvas.toDataURL('image/png');
}

// Static "identicon" marks for identities that aren't a real wallet address
// — a guest, or the built-in AI opponent (always team B, see main.js's
// aiTeam: 'B'). Same Nimiq-gold/team-blue silhouette convention as a real
// identicon's colored background + character, just hand-drawn once instead
// of hashed per-address. Transparent (icon only, no background) so every
// consumer can composite its own shape/background: bakeBubble's hex-window
// floor color in game.js, or a plain colored square via
// getStaticMarkPngDataUrl below for the goal panel / chat avatar, which
// otherwise expect a "raw" identicon (background baked in, see
// getIdenticonPngDataUrl) to crop with their own CSS.
const STATIC_MARK_SRC = {
  guest: `${ASSET_BASE}avatars/guest-mark.webp`,
  bot: `${ASSET_BASE}avatars/bot-mark.webp`,
};
const staticMarkCache = new Map();
export function getStaticMarkImage(kind) {
  if (!staticMarkCache.has(kind)) staticMarkCache.set(kind, loadImage(STATIC_MARK_SRC[kind]));
  return staticMarkCache.get(kind);
}

// The baked mark art is plain white — solid white on the gold floor read too
// harsh/glaring (see conversation), so every consumer recolors it per the
// floor it's about to sit on instead (navy on gold, left white on blue).
// `source-in` swaps the icon's own color while keeping its alpha shape,
// same trick used elsewhere for recoloring flat art.
export async function getTintedMarkCanvas(kind, color, size = 512) {
  const img = await getStaticMarkImage(kind);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

export async function getStaticMarkPngDataUrl(kind, bgColor, iconColor, size = 512) {
  const mark = await getTintedMarkCanvas(kind, iconColor, size);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(mark, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

// A tighter "bust" version of the identicon — background AND legs/feet
// stripped — used only for compositing into a stone's glass window, where a
// bigger window has room to zoom in on the character but not on its legs.
// The lib always emits this exact fixed-position background rect as the
// second element of its SVG template (identicons.bundle.cjs.js: `<rect
// fill="${bg}" x="0" y="0" width="160" height="160"/>`), so stripping it by
// pattern is reliable, not a guess. Every identicon is composed of exactly
// four parts in a fixed order — top (hair), side (ears), face, bottom (legs/
// feet, sometimes a held prop) — one per line in that same template, always
// 15 lines total regardless of which address/assets are picked, with
// "bottom" always the 3rd-from-last line — confirmed by inspecting the
// library source and cross-checking against several generated addresses
// (see conversation), not assumed.
const BG_RECT_RE = /<rect fill="[^"]*" x="0" y="0" width="160" height="160"\/>/;
const BOTTOM_LINE_FROM_END = 3;
const stoneBustCanvasCache = new Map();
const bgColorCache = new Map();

export function getIdenticonCanvasStoneBust(address, size = 512) {
  address = toUserFriendlyAddress(address);
  const key = `${address}:${size}`;
  if (!stoneBustCanvasCache.has(key)) stoneBustCanvasCache.set(key, rasterize(address, size, { stripBackground: true, stripLegs: true }));
  return stoneBustCanvasCache.get(key);
}

// The solid fill color of that same background rect (see BG_RECT_RE above),
// stripped out of the stone-bust canvas but still needed by the stone bake
// (game.js's bakeBubble) to color the hex window's floor per-player instead
// of the fixed per-team navy/gold from the stone art.
export function getIdenticonBgColor(address) {
  address = toUserFriendlyAddress(address);
  if (!bgColorCache.has(address)) {
    bgColorCache.set(address, Identicons.svg(address).then((svgMarkup) => {
      const rect = svgMarkup.match(BG_RECT_RE);
      return rect ? rect[0].match(/fill="([^"]*)"/)[1] : null;
    }));
  }
  return bgColorCache.get(address);
}

async function rasterize(address, size, { stripBackground = false, stripLegs = false } = {}) {
  let svgMarkup = await Identicons.svg(address);
  if (stripBackground) svgMarkup = svgMarkup.replace(BG_RECT_RE, '');
  if (stripLegs) {
    const lines = svgMarkup.split('\n');
    lines.splice(lines.length - BOTTOM_LINE_FROM_END, 1);
    svgMarkup = lines.join('\n');
  }
  const blobUrl = URL.createObjectURL(new Blob([svgMarkup], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(blobUrl);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
    return canvas;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
