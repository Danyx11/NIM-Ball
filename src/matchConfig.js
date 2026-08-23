// Centralized match rules — replaces the scattered hardcoded WIN_SCORE=3 /
// TURN_TIMER_MS=30000 / 3-stone startPositions that used to live as bare
// consts inside game.js's startGame() closure. Classic is just this default
// preset; Custom is the exact same shape with different values (see
// conversation — Pass & Play / Remote Match "Classic / Custom" flow).
//
// Deliberately NOT involved in the replay/ticket system (src/recorder.js,
// src/replay.js, src/ticket.js) — that binary format is still hardcoded to
// 3+3 stones and is explicitly out of scope for this feature (separate task).

export const DEFAULT_MATCH_CONFIG = Object.freeze({
  skin: 'summer',
  stonesPerTeam: 3,
  pointsToWin: 3,
  turnTime: 30,
});

export const SKIN_OPTIONS = ['summer', 'winter'];
export const STONES_OPTIONS = [1, 2, 3];
export const POINTS_OPTIONS = [1, 2, 3];
export const TURN_TIME_OPTIONS = [10, 20, 30];

// Which of the 3 hand-measured rack slots (see game.js's startPositions —
// index 0/2 are the two outer spots, 1 is the center one, see conversation)
// stay active for a given stone count. Never recomputed/re-spaced — always
// a subset of the same 3 fixed art-aligned positions.
export const STONE_SLOTS_BY_COUNT = {
  1: [1],
  2: [0, 2],
  3: [0, 1, 2],
};

// Turn-timer hex ring "warning" window (see game.js's HEX_TIMER_RED_FRACTION)
// — not proportional to turnTime, an explicit design choice per turnTime
// value (see conversation): 30s is the original untouched behavior (5s
// warning), 20s also warns for its last 5s, 10s warns for only its last 3s.
export const TIMER_WARNING_SECONDS_BY_TURN_TIME = { 30: 5, 20: 5, 10: 3 };

export function sanitizeMatchConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_MATCH_CONFIG };
  return {
    skin: SKIN_OPTIONS.includes(cfg.skin) ? cfg.skin : DEFAULT_MATCH_CONFIG.skin,
    stonesPerTeam: STONES_OPTIONS.includes(cfg.stonesPerTeam) ? cfg.stonesPerTeam : DEFAULT_MATCH_CONFIG.stonesPerTeam,
    pointsToWin: POINTS_OPTIONS.includes(cfg.pointsToWin) ? cfg.pointsToWin : DEFAULT_MATCH_CONFIG.pointsToWin,
    turnTime: TURN_TIME_OPTIONS.includes(cfg.turnTime) ? cfg.turnTime : DEFAULT_MATCH_CONFIG.turnTime,
  };
}

// ---------- Local persistence ----------
// Same pattern as src/settings.js's basicLaser flag (localStorage, read once
// at module load) — two independent keys so a Pass & Play Custom tweak never
// touches the Remote one (see conversation, point 10 of the brief).
const STORAGE_KEYS = {
  passplay: 'nimball-custom-passplay',
  remote: 'nimball-custom-remote',
};

export function getCustomConfig(mode) {
  const key = STORAGE_KEYS[mode];
  if (!key) return { ...DEFAULT_MATCH_CONFIG };
  try {
    const raw = localStorage.getItem(key);
    return raw ? sanitizeMatchConfig(JSON.parse(raw)) : { ...DEFAULT_MATCH_CONFIG };
  } catch {
    return { ...DEFAULT_MATCH_CONFIG };
  }
}

export function setCustomConfig(mode, config) {
  const key = STORAGE_KEYS[mode];
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(sanitizeMatchConfig(config)));
}
