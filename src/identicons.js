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

window.NIMIQ_IDENTICONS_SVG_PATH = identiconsSvgUrl;

// address -> Promise<HTMLCanvasElement>, so concurrent requests for the same
// address share one render instead of racing.
const canvasCache = new Map();

// Raw SVG markup for an address, viewBox 0 0 160 160 (@nimiq/identicons is a
// fixed-size vector identicon, not a raster one).
export function getIdenticonSvg(address) {
  return Identicons.svg(address);
}

// Rasterized identicon at `size`x`size`, cached per address (size is fixed at
// first request — this game only ever needs one size per address).
export function getIdenticonCanvas(address, size = 512) {
  if (!canvasCache.has(address)) canvasCache.set(address, rasterize(address, size));
  return canvasCache.get(address);
}

export async function getIdenticonPngDataUrl(address, size = 512) {
  const canvas = await getIdenticonCanvas(address, size);
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

export function getIdenticonCanvasStoneBust(address, size = 512) {
  const key = `${address}:${size}`;
  if (!stoneBustCanvasCache.has(key)) stoneBustCanvasCache.set(key, rasterize(address, size, { stripBackground: true, stripLegs: true }));
  return stoneBustCanvasCache.get(key);
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
