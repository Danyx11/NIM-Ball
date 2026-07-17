import './style.css';
// Nimiq's brand typeface (nimiq-style design system) — used for the score digits.
import '@fontsource/mulish/800.css';
import { startGame } from './game.js';
import { connectNimiq } from './nimiq.js';
import { initBackground } from './background.js';

initBackground();
startGame();

// Best-effort: only succeeds when the app is opened inside Nimiq Pay.
// Logged for now — wire this up to real features (wallet identity,
// on-chain results, etc.) as the Mini App integration grows.
connectNimiq()
  .then((nimiq) => console.log('[nimiq] provider ready', nimiq))
  .catch((err) => console.log('[nimiq] not running inside Nimiq Pay:', err.message));
