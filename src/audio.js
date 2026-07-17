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
const AMBIENCE_SRC = `${ASSET_BASE}sfx/ambience-forest.m4a`;
const AMBIENCE_VOLUME = 0.35;

export function createAudio() {
  let ctx = null;
  let muted = false;
  const buffers = {};
  let ambienceBuffer = null;
  let ambienceSource = null;
  let ambienceGain = null;

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
    try {
      const res = await fetch(AMBIENCE_SRC);
      const data = await res.arrayBuffer();
      ambienceBuffer = await c.decodeAudioData(data);
    } catch (err) {
      console.warn(`[audio] couldn't load ambience from ${AMBIENCE_SRC}`, err);
    }
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

  function setMuted(v) {
    muted = v;
    if (ambienceGain) ambienceGain.gain.value = muted ? 0 : AMBIENCE_VOLUME;
  }
  function isMuted() { return muted; }

  // call from the first pointerdown/click in the page — resume() above only
  // actually unlocks audio when invoked from within a user-gesture handler
  function unlock() { ensureContext(); }

  // loops the background ambience track; safe to call multiple times, a
  // second call is a no-op while a loop is already playing
  function playAmbience() {
    if (ambienceSource || !ctx || !ambienceBuffer) return;
    ambienceSource = ctx.createBufferSource();
    ambienceSource.buffer = ambienceBuffer;
    ambienceSource.loop = true;
    ambienceGain = ctx.createGain();
    ambienceGain.gain.value = muted ? 0 : AMBIENCE_VOLUME;
    ambienceSource.connect(ambienceGain).connect(ctx.destination);
    ambienceSource.start();
  }

  function stopAmbience() {
    if (!ambienceSource) return;
    ambienceSource.stop();
    ambienceSource = null;
    ambienceGain = null;
  }

  return { load, play, setMuted, isMuted, unlock, playAmbience, stopAmbience };
}
