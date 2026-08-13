// Wires up the animated constellation background + logo declared in index.html
// (#bg-stage) with their public/ asset URLs. Kept out of index.html's static
// markup so paths go through BASE_URL, same as every other asset — see the
// ASSET_BASE comment in game.js for why (GitHub Pages subpath deploys).
const ASSET_BASE = import.meta.env.BASE_URL;
const FOND_SRC = {
  v4: `${ASSET_BASE}bg/fond-v4.webp`,
  v42: `${ASSET_BASE}bg/fond-v42.webp`,
  v43: `${ASSET_BASE}bg/fond-v43.webp`,
  v44: `${ASSET_BASE}bg/fond-v44.webp`,
};
const LOGO_SRC = `${ASSET_BASE}bg/nimiq-logo-transparent.webp`;
const HOME_SRC = `${ASSET_BASE}home/home-screen.webp`;
const MODE_SELECT_BG_SRC = `${ASSET_BASE}home/mode-select-bg.webp`;
// nature-pinede.webp/arbres-ombres.webp (#bg-nature/#fg-ombres) intentionally
// NOT wired up anymore: the V2 arena art bakes its own forest scene in, so
// both containers are display:none (see style.css) — loading these ~1.1MB
// combined would just be wasted network/decode time for images that never
// paint. DOM/CSS left in place (not deleted) in case a future skin goes back
// to a small inset board with visible margins, per the CSS comment.

export function initBackground() {
  for (const [key, url] of Object.entries(FOND_SRC)) {
    const el = document.getElementById(`fond-${key}`);
    if (el) el.style.backgroundImage = `url('${url}')`;
  }
  const logo = document.getElementById('bg-logo');
  if (logo) logo.src = LOGO_SRC;
  const home = document.getElementById('homeOverlay');
  if (home) home.style.backgroundImage = `url('${HOME_SRC}')`;
  const modeBg = document.getElementById('modeOverlayBg');
  if (modeBg) modeBg.style.backgroundImage = `url('${MODE_SELECT_BG_SRC}')`;
}
