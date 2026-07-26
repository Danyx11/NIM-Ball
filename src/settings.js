// Small shared preferences module — lives outside game.js's per-match closure
// so the toolbar (wired up once at page load, before any team is picked) and
// the running game (whose instance is created fresh each startGame() call)
// can read/flip the same flag without passing it through startGame(opts).
const BASIC_LASER_KEY = 'nimball-basic-laser';

let basicLaser = localStorage.getItem(BASIC_LASER_KEY) === '1';

export function isBasicLaser() { return basicLaser; }

export function setBasicLaser(v) {
  basicLaser = v;
  localStorage.setItem(BASIC_LASER_KEY, v ? '1' : '0');
}
