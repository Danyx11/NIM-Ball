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

async function rasterize(address, size) {
  const svgMarkup = await Identicons.svg(address);
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
