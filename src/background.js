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
const NATURE_SRC = `${ASSET_BASE}bg/nature-pinede.webp`;
const OMBRES_SRC = `${ASSET_BASE}bg/arbres-ombres.webp`;

export function initBackground() {
  for (const [key, url] of Object.entries(FOND_SRC)) {
    const el = document.getElementById(`fond-${key}`);
    if (el) el.style.backgroundImage = `url('${url}')`;
  }
  const logo = document.getElementById('bg-logo');
  if (logo) logo.src = LOGO_SRC;
  const nature = document.getElementById('bg-nature');
  if (nature) nature.src = NATURE_SRC;
  const ombres = document.getElementById('fg-ombres');
  if (ombres) ombres.src = OMBRES_SRC;
}
