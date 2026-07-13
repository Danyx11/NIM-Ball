// Lightweight WAV sound-effect manager built on the Web Audio API. Clips are
// decoded once into AudioBuffers and played through short-lived BufferSource
// nodes, so overlapping hits (several collisions landing in the same frame)
// each get their own voice instead of cutting each other off the way a single
// shared <audio> element would.
const ASSET_BASE = import.meta.env.BASE_URL;
const SFX_SRC = {
  hitWall: `${ASSET_BASE}sfx/hit-wall.wav`,   // glob/ball bouncing off a rail
  hitGlob: `${ASSET_BASE}sfx/hit-glob.wav`,   // glob-glob or glob-ball collision
  shot: `${ASSET_BASE}sfx/shot.wav`,          // drag released, a glob launches
  goal: `${ASSET_BASE}sfx/goal.wav`,          // ball crosses into the goal mouth
  wipeout: `${ASSET_BASE}sfx/wipeout.wav`,    // a whole team has fallen in
  button: `${ASSET_BASE}sfx/button.wav`,      // PLAY cap pressed
  win: `${ASSET_BASE}sfx/win.wav`,            // match point reached
};

export function createAudio() {
  let ctx = null;
  let muted = false;
  const buffers = {};

  function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    // browsers start contexts 'suspended' until a user gesture resumes them
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // fire-and-forget: safe to call before any user gesture has happened,
  // failures (missing file, decode error) just leave that clip silent
  async function load() {
    const c = ensureContext();
    await Promise.all(Object.entries(SFX_SRC).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        const data = await res.arrayBuffer();
        buffers[name] = await c.decodeAudioData(data);
      } catch (err) {
        console.warn(`[audio] couldn't load "${name}" from ${url}`, err);
      }
    }));
  }

  // volume: 0-1 gain; rate: playback rate, nudge it per call (e.g. 0.95-1.05)
  // for cheap per-hit variance so repeated collisions don't sound identical
  function play(name, { volume = 1, rate = 1 } = {}) {
    if (muted || !ctx || !buffers[name]) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0, volume));
    src.connect(gain).connect(ctx.destination);
    src.start();
  }

  function setMuted(v) { muted = v; }
  function isMuted() { return muted; }

  // call from the first pointerdown/click in the page — resume() above only
  // actually unlocks audio when invoked from within a user-gesture handler
  function unlock() { ensureContext(); }

  return { load, play, setMuted, isMuted, unlock };
}
