// Single source of truth for the handful of colors needed both in CSS
// (style.css's :root, for every DOM-styled element) and on a plain Canvas2D
// context (ticket.js, which can't reference CSS custom properties directly
// — see conversation: this used to be a hand-copied literal object there,
// re-updated by hand every time the palette changed, e.g. the --accent
// Nimiq Gold swap).
//
// main.js injects these onto :root at startup (before the loading overlay
// ever lifts, so there's no visible flash) via document.documentElement.
// style.setProperty() — style.css keeps its own literal values as a static
// fallback (also what a person reading the CSS alone sees), but this module
// is what actually wins once the page runs.
//
// Deliberately just these 7 — the rest of style.css's :root (--bg-mid,
// --error, the --scrim-*, --teamA-dark/--teamB-dark, etc.) was never
// duplicated in ticket.js, so there's no drift risk to close there; adding
// them here would just be extra indirection for no benefit.
export const COLORS = {
  bgDeep: '#0b1f2a',
  ink: '#eef6f4',
  inkDim: '#9fb8bc',
  teamA: '#3fa9f5',
  teamB: '#ffc94d',
  accent: '#e9b213', // Nimiq Gold — --nimiq-gold in the official nimiq-style kit
  panel: '#143844',
};

// Maps each COLORS key to the CSS custom property it backs in style.css's
// :root — used by main.js to inject them; kept here (not duplicated in
// main.js) so the mapping itself has one home too.
export const CSS_VAR_NAMES = {
  bgDeep: '--bg-deep',
  ink: '--ink',
  inkDim: '--ink-dim',
  teamA: '--teamA',
  teamB: '--teamB',
  accent: '--accent',
  panel: '--panel',
};
