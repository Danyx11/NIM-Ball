// Wires up the logo + home/mode-select backgrounds declared in index.html
// with their public/ asset URLs. Kept out of index.html's static markup so
// paths go through BASE_URL, same as every other asset — see the ASSET_BASE
// comment in game.js for why (GitHub Pages subpath deploys).
import { loadImages } from './preload.js';

const ASSET_BASE = import.meta.env.BASE_URL;
// Nimiq-Blue wordmark, not the white one (public/bg/nimiq-logo-transparent.webp,
// left in place, reversible — swap this line back to restore it): #bg-logo now
// sits directly on the sidebar's own light Nimiq Gray column background (see
// .sidebar-brand in style.css, no tile behind it anymore), where blue-on-gray
// reads instead of the white-on-dark-tile look this replaces.
const LOGO_SRC = `${ASSET_BASE}bg/nimiq-logo-blue.webp`;
const HOME_SRC = `${ASSET_BASE}home/home-screen.webp`;
const MODE_SELECT_BG_SRC = `${ASSET_BASE}home/mode-select-bg.webp`;
// nature-pinede.webp/arbres-ombres.webp (#bg-nature/#fg-ombres) intentionally
// NOT wired up anymore: the V2 arena art bakes its own forest scene in, so
// both containers are display:none (see style.css) — loading these ~1.1MB
// combined would just be wasted network/decode time for images that never
// paint. DOM/CSS left in place (not deleted) in case a future skin goes back
// to a small inset board with visible margins, per the CSS comment.
// The old animated constellation background (#bg-stage, fond-v4/v42/v43/v44)
// was removed entirely for the same reason (V2 arena art occludes it — see
// git history for the CSS/DOM/preload it used to need); its source layers
// still live under design/bg/fond-constel-v4*.png if a future skin goes back
// to a small inset board and wants it again.

export function initBackground() {
  const logo = document.getElementById('bg-logo');
  if (logo) logo.src = LOGO_SRC;
  const home = document.getElementById('homeOverlay');
  if (home) home.style.backgroundImage = `url('${HOME_SRC}')`;
  const modeBg = document.getElementById('modeOverlayBg');
  if (modeBg) modeBg.style.backgroundImage = `url('${MODE_SELECT_BG_SRC}')`;
}

// Awaited by main.js before the branded #loadingOverlay lifts, so the
// home/mode-select screens it reveals never flash without their backgrounds.
export function preloadBackgroundAssets() {
  return loadImages([LOGO_SRC, HOME_SRC, MODE_SELECT_BG_SRC]);
}
