// Lightweight WAV sound-effect manager built on the Web Audio API. Clips are
// decoded once into AudioBuffers and played through short-lived BufferSource
// nodes, so overlapping hits (several collisions landing in the same frame)
// each get their own voice instead of cutting each other off the way a single
// shared <audio> element would.
// Exported (SFX_SRC, AMBIENCE_SRC/VOLUME, REVERB_SEND) so tools like
// audio-lab/ can read the real, live mixing values instead of duplicating
// them — mutating REVERB_SEND from such a tool only affects that page's own
// module instance, never this file's real in-game singleton below.
const ASSET_BASE = import.meta.env.BASE_URL;
export const SFX_SRC = {
  hitWall: `${ASSET_BASE}sfx/golf layer/golf wall.wav`,   // stone/ball bouncing off a rail
  hitStone: `${ASSET_BASE}sfx/golf layer/golf stone.wav`,   // stone-stone collision
  hitStoneBall: `${ASSET_BASE}sfx/golf layer/golf ball.wav`,   // stone-ball collision
  shot: `${ASSET_BASE}sfx/shot.wav`,          // drag released, a stone launches
  stoneSelect: `${ASSET_BASE}sfx/stone select.wav`, // a stone is grabbed to start a drag
  dragTick: `${ASSET_BASE}sfx/drag tick.wav`, // retriggered while dragging, see onPointerMove in game.js
  goal: `${ASSET_BASE}sfx/goal.wav`,          // ball crosses into the goal mouth
  wipeout: `${ASSET_BASE}sfx/wipeout.wav`,    // a whole team has fallen in
  button: `${ASSET_BASE}sfx/button.wav`,      // PLAY cap pressed
  exitPanel: `${ASSET_BASE}sfx/exit-panel.wav`, // "Oui" on a live-match quit confirm (not replay)
  win: `${ASSET_BASE}sfx/win.wav`,            // match point reached
  matchStart: `${ASSET_BASE}sfx/Match start.wav`, // played once, right as a live match begins
  whistle: `${ASSET_BASE}sfx/whistle 2.wav`,  // played right before each turn timer starts (not the match's very first one, see beginAimPhase in game.js)
  launchEngine: `${ASSET_BASE}sfx/launch engine.wav`, // small machinery cue, first sound in the reveal — before the glide whoosh and the stones' departure
  stoneDead: `${ASSET_BASE}sfx/stone dead.wav`, // a knocked-out stone's shrink-into-the-void animation starts
  stoneFall: `${ASSET_BASE}sfx/stone fall 3.wav`, // a stone (not the ball) drops into the goal mouth
  pointOk: `${ASSET_BASE}sfx/Point ok.wav`,   // the +1 point-result panel appearing (mid-match, non-deciding point)
  ticket2: `${ASSET_BASE}sfx/ticket 2.wav`,   // the match-winning ticket screen appearing
  sweepAppear: `${ASSET_BASE}sfx/ice sphere 3.wav`, // balai patch placed, played right after the toolbar's button.wav, see sweepBtn in game.js
  chatIn: `${ASSET_BASE}sfx/message IN.wav`,   // a real chat message arrives from the opponent (not our own echo, not the mute toggle) — see net.onChat in game.js
  chatOut: `${ASSET_BASE}sfx/message OUT.wav`, // local player's own chat message send, played optimistically at submit time
};
export const AMBIENCE_SRC = `${ASSET_BASE}sfx/ambience-forest.m4a`;
export const AMBIENCE_VOLUME = 0.622; // was 1.107, -5dB
export const AMBIENCE_FADE_MS = 1000; // playAmbience()'s fade-in length
export const AMBIENCE_LOOP_CROSSFADE_S = 2; // overlap between consecutive loop-point copies, see scheduleAmbienceVoice()
const SCHEDULE_LOOKAHEAD_S = 1; // schedule the next scheduled copy/leg (ambience or laser) this long before it's due

export const LASER_SRC = `${ASSET_BASE}sfx/laser sample.wav`;
export const LASER_LOOP_POINT_S = 0.5; // ping-pong body starts here; the 0..this attack only ever plays once, right as a stone is grabbed
export const LASER_END_TRIM_S = 0.3; // clip's last 300ms is never played — trimmed off both the attack and the loop's far turnaround
export const LASER_VOLUME_MIN_DB = -37; // was -40, +3dB — discrete, right at grab (drag distance 0)
export const LASER_VOLUME_MAX_DB = -32; // was -35, +3dB — small lift at max pull distance, see setLaserIntensity()
// Lowpass cutoff sweeps between these two, breathing in sync with the aimed
// stone's own halo pulse (see startLaser()'s phaseOffsetS param) — same
// period as game.js's HALO_PULSE_PERIOD, kept as a plain number here since
// audio.js doesn't otherwise depend on game.js constants.
export const LASER_LP_MIN_HZ = 80;
export const LASER_LP_MAX_HZ = 400;
export const LASER_LP_PERIOD_S = 2; // must match HALO_PULSE_PERIOD in game.js
export const LASER_LP_GAIN_DIP_DB = -5; // extra gain riding the same sweep: 0dB at the cutoff's peak, this much at its trough

// Per-sound reverb send amount (0 = dry). Only the stone impacts get a touch
// of the forest reverb bus for now; other one-shot SFX stay dry.
export const REVERB_SEND = { hitWall: 0, hitStone: 0, hitStoneBall: 0 };

export const GLIDE_SAMPLE_SRC = `${ASSET_BASE}sfx/whoosh layer.wav`;

// "Glide" launch whoosh, a short cue at the moment stones are released: a
// recorded one-shot sample (GLIDE_SAMPLE_SRC), not a synthesized loop — v3
// swapped out the earlier filtered-pink-noise bed for a real "whoosh layer"
// recording, still run through the same swept lowpass (see below) so it can
// still brighten/dull and fade with launch power the same way the
// synthesized version did.
// v2 design, still true for the sample: only the *filter* tracks real-time
// speed (opens/closes every physics frame); the *volume* is a one-shot
// attack/release envelope fired once at launch and left to run its course —
// this accompanies the start of the movement, then lets the entity glide on
// in silence rather than staying audible for the whole slide. A weak
// tap's release is deliberately short so it fades out well before the
// sample's own ~1.5s length, rather than always playing the full recording
// regardless of how hard the shot was. No retrigger mid-glide (e.g. off a
// wall bounce), by design: once a voice exists for an id, later setGlide()
// calls only update its filter/pan, never its gain — see setGlide(). v3:
// single voice total, not per entity — when a round's stones all launch on
// the same physics frame, game.js picks only the fastest/hardest one as the
// "leader" and calls setGlide() for that id alone, so the one cue that plays
// always tracks the round's biggest shot instead of whichever entity
// happened to iterate first.
const GLIDE_MAX_VOLUME = 0.15; // was 0.044, too faint after the fixed highpass was cutting into the sample too
// v3: single voice only — game.js now picks one "leader" entity per launch
// (the round's fastest/hardest-hit stone) and only ever calls setGlide() for
// that id, so this cap is really just a safety net, not the arbiter of which
// entity wins a voice.
const GLIDE_MAX_VOICES = 1;
const GLIDE_PARAM_TAU = 0.05;   // smoothing time-constant for pan updates only now, avoids zipper noise (gain and filter are both scheduled envelopes, see setGlide())
const GLIDE_STOP_FADE_S = 0.12; // fade-out length before a voice is actually torn down
const GLIDE_ATTACK_S = 0.15;      // rise into the whoosh, halved from 0.3 — that read as too slow/dull, less speed-sensation
// GLIDE_SAMPLE_SRC's own recording is ~1.5s long — these bound how much of it
// actually gets heard before setGlide()'s gain envelope fades it to silence.
const GLIDE_RELEASE_MIN_S = 0.35; // release length at low launch power: fades out early, well short of the sample's own length, rather than always playing the whole recording regardless of shot strength
const GLIDE_RELEASE_MAX_S = 1.2;  // ...stretching up to this at full power — close to the sample's full ~1.5s (minus GLIDE_ATTACK_S), see setGlide()
// v3: lowpass-only now — the fixed 1kHz highpass that used to sit ahead of
// this was cutting too much of the sample's body, reading as very faint even
// at GLIDE_MAX_VOLUME's peak. Just the lowpass sweeping with launch power.
const GLIDE_LP_MIN_HZ = 600;  // lowpass cutoff at rest, and the start of the attack ramp
const GLIDE_LP_MAX_HZ = 4000;  // peak cutoff for a full-power shot, reached at the end of the attack
const GLIDE_LP_CLOSE_FLOOR_HZ = 2500; // the brief end-of-glide close (see setGlide()) only comes down to here, not all the way to GLIDE_LP_MIN_HZ — keeps the tail from reading too dull
const GLIDE_FILTER_CLOSE_S = 0.6; // how long that close takes — was 0.35, read as too sudden

// Voice-limiting for a chaotic pileup (several stones colliding the same
// physics tick): plays sharing a `group` (game.js passes 'impact' for both
// hitWall/hitStone) collapse near-simultaneous hits into one sound instead of
// a stutter of overlapping copies, and never stack more than a handful of
// voices at once even when hits land more than the dedupe window apart.
const IMPACT_DEDUPE_MS = 100;
const IMPACT_MAX_VOICES = 4;

// Builds a short synthetic impulse response for the reverb send: soft,
// diffuse "light forest" tail rather than a big hall. Filtered noise (a
// one-pole lowpass smoothing pass over white noise, done sample-by-sample
// since there's no offline-render step for a cheap runtime IR) keeps it dark
// and soft instead of a harsh/glassy hiss; independent per-channel noise
// gives it stereo width. Short duration + steep decay curve keeps it light
// rather than washing out the dry impact hit.
function createForestImpulse(ctx, duration = 1.1, decay = 3.4) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let smoothed = 0;
    for (let i = 0; i < length; i++) {
      const envelope = Math.pow(1 - i / length, decay);
      smoothed = smoothed * 0.72 + (Math.random() * 2 - 1) * 0.28;
      data[i] = smoothed * envelope;
    }
  }
  return impulse;
}

function createAudio() {
  let ctx = null;
  let muted = false;
  const buffers = {};
  let ambienceBuffer = null;
  let ambiencePlaying = false;
  let ambienceMasterGain = null; // overall on/off + fade-in + mute, shared by every crossfaded voice below
  let ambienceVoices = [];       // currently playing/overlapping loop-point copies, see scheduleAmbienceVoice()
  let ambienceNextStart = 0;     // AudioContext time the next copy should start at
  let ambienceTimer = null;      // setTimeout handle that schedules that next copy ahead of time
  let reverbNode = null;
  let masterNode = null;   // everything (dry SFX, reverb bus, ambience) funnels through this before destination
  let analyser = null;     // parallel tap on masterNode, read by getMasterPeakDb() — never in the audible path itself
  let analyserBuf = null;  // sized to analyser.fftSize once it exists — see getMasterPeakDb()
  const groupState = {}; // { [group]: { lastPlay: number, activeVoices: number } }
  const playListeners = []; // see onPlay() — debug hook for the sound-trigger log (main.js #soundLog)

  let laserFullBuffer = null;         // whole clip as decoded, only ever read up to laserIntroDuration (see below)
  let laserIntroDuration = 0;         // laserFullBuffer's usable length in seconds, i.e. its real duration minus LASER_END_TRIM_S
  let laserLoopBuffer = null;         // LASER_LOOP_POINT_S..laserIntroDuration, forward
  let laserLoopBufferReversed = null; // same slice, sample-reversed — see startLaser() for why this makes a click-free ping-pong loop
  let laserGain = null;    // base level node for the currently-sounding laser, live-adjusted by setLaserIntensity()
  let laserPulseGain = null; // extra tremolo riding the same LFO as the filter (LASER_LP_GAIN_DIP_DB at the sweep's trough)
  let laserFilter = null; // lowpass sitting after laserGain, cutoff driven by laserLfo below
  let laserLfo = null;    // single sine oscillator shared by laserFilter's sweep and laserPulseGain's tremolo, phase-locked to the grabbed stone's halo pulse
  let laserLfoGain = null;      // scales laserLfo's -1..1 output into the ± sweep added on top of laserFilter.frequency's base value
  let laserLfoGainForPulse = null; // same laserLfo, scaled instead for laserPulseGain.gain's much smaller ± range
  let laserTargetDb = LASER_VOLUME_MIN_DB; // last intensity level requested, re-applied on unmute
  let laserSrc = null;    // whichever BufferSourceNode is currently sounding (intro or one ping-pong leg)
  let laserTimer = null;  // schedules the next ping-pong leg ahead of time, mirrors ambience's lookahead pattern
  let laserToken = 0;     // bumped on every startLaser()/stopLaser() so a leg scheduled for a previous drag can never fire over a new one

  let glideSampleBuffer = null; // the "whoosh layer.wav" recording, decoded once in load() — see startGlideVoice()
  const glideVoices = {};       // { [entityId]: { src, lowpass1, lowpass2, gain, panner, stopping } }, see setGlide()

  function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    // browsers start contexts 'suspended' until a user gesture resumes them
    if (ctx.state === 'suspended') ctx.resume();
    if (!masterNode) {
      masterNode = ctx.createGain();
      masterNode.connect(ctx.destination);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyserBuf = new Float32Array(analyser.fftSize);
      masterNode.connect(analyser); // tap only — analyser's own output stays unconnected
    }
    if (!reverbNode) {
      reverbNode = ctx.createConvolver();
      reverbNode.buffer = createForestImpulse(ctx);
      reverbNode.connect(masterNode);
    }
    return ctx;
  }

  // Instantaneous peak level of the real combined output (every sound
  // currently playing, post-mix), in dBFS — 0 is the hard digital ceiling,
  // see the VU meter's color zones (main.js) for the -6/-3dB margins.
  // Returns -Infinity (silence, or before any sound has ever played) rather
  // than throwing, so a polling loop can call this unconditionally.
  function getMasterPeakDb() {
    if (!analyser) return -Infinity;
    analyser.getFloatTimeDomainData(analyserBuf);
    let peak = 0;
    for (let i = 0; i < analyserBuf.length; i++) {
      const abs = Math.abs(analyserBuf[i]);
      if (abs > peak) peak = abs;
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
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
    try {
      const res = await fetch(LASER_SRC);
      const data = await res.arrayBuffer();
      laserFullBuffer = await c.decodeAudioData(data);
      // Pre-split once at load time (not per-drag): a forward copy of the
      // loop-able tail and its sample-reversed twin, so startLaser() never
      // does this slicing/reversing work mid-gameplay. Both the intro and the
      // loop stop LASER_END_TRIM_S short of the clip's real end (see
      // startLaser()'s use of laserIntroDuration) — same trimmed endpoint for
      // both, so the intro's last played sample still matches the loop's
      // first reversed sample exactly.
      const rate = laserFullBuffer.sampleRate;
      const startSample = Math.floor(LASER_LOOP_POINT_S * rate);
      const endSample = laserFullBuffer.length - Math.floor(LASER_END_TRIM_S * rate);
      const length = endSample - startSample;
      laserIntroDuration = endSample / rate;
      laserLoopBuffer = c.createBuffer(laserFullBuffer.numberOfChannels, length, rate);
      laserLoopBufferReversed = c.createBuffer(laserFullBuffer.numberOfChannels, length, rate);
      for (let ch = 0; ch < laserFullBuffer.numberOfChannels; ch++) {
        const full = laserFullBuffer.getChannelData(ch);
        const fwd = laserLoopBuffer.getChannelData(ch);
        const rev = laserLoopBufferReversed.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          const sample = full[startSample + i];
          fwd[i] = sample;
          rev[length - 1 - i] = sample;
        }
      }
    } catch (err) {
      console.warn(`[audio] couldn't load laser from ${LASER_SRC}`, err);
    }
    try {
      const res = await fetch(GLIDE_SAMPLE_SRC);
      const data = await res.arrayBuffer();
      glideSampleBuffer = await c.decodeAudioData(data);
    } catch (err) {
      console.warn(`[audio] couldn't load glide sample from ${GLIDE_SAMPLE_SRC}`, err);
    }
  }

  // volume: 0-1 gain; rate: playback rate, nudge it per call (e.g. 0.95-1.05)
  // for cheap per-hit variance so repeated collisions don't sound identical.
  // pan: -1 (full left) to 1 (full right), 0 = center/default — callers doing
  // positional panning (e.g. impact x-position) are expected to already keep
  // this well inside ±1 themselves, this just forwards it to a StereoPannerNode.
  // group: opt into voice-limiting — shared by name, so e.g. 'impact' throttles
  // hitWall and hitStone together. Defaults to the IMPACT_DEDUPE_MS/
  // IMPACT_MAX_VOICES pileup behavior; groupDedupeMs/groupMaxVoices override
  // those per call for a group with different needs.
  // onEnded: fired once the clip actually finishes playing — called
  // immediately instead if muted/missing so a caller gating on it (e.g. the
  // match-start intro in game.js) never stalls waiting for an event that'll
  // never come.
  function play(name, { volume = 1, rate = 1, pan = 0, group, groupDedupeMs = IMPACT_DEDUPE_MS, groupMaxVoices = IMPACT_MAX_VOICES, onEnded } = {}) {
    if (muted || !ctx || !buffers[name]) { onEnded?.(); return; }
    let g;
    if (group) {
      g = groupState[group] || (groupState[group] = { lastPlay: -Infinity, activeVoices: 0 });
      const now = performance.now();
      if (now - g.lastPlay < groupDedupeMs) { onEnded?.(); return; } // collapse near-simultaneous hits into one sound
      if (g.activeVoices >= groupMaxVoices) { onEnded?.(); return; } // cap concurrent voices in a pileup
      g.lastPlay = now;
      g.activeVoices++;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0, volume));
    // reverb send taps the signal here, pre-pan — the wet tail stays centered/
    // diffuse rather than following the dry hit's position, which reads more
    // like ambient room reflections than a second panned copy of the hit.
    const send = REVERB_SEND[name];
    if (send && reverbNode) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = send;
      gain.connect(sendGain).connect(reverbNode);
    }
    if (pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(gain).connect(panner).connect(masterNode);
    } else {
      src.connect(gain).connect(masterNode);
    }
    src.onended = () => { if (g) g.activeVoices--; onEnded?.(); };
    src.start();
    playListeners.forEach((cb) => cb(name));
  }

  // Debug hook: fires with the sample's own key (SFX_SRC name) every time
  // play() above actually starts one — not the continuous laser/glide beds,
  // which never go through play() at all. Lets a UI (main.js's #soundLog)
  // show which named sample just triggered, since with this many now firing
  // from different code paths it's easy to hear one and not know which it was.
  function onPlay(cb) { playListeners.push(cb); }

  function setMuted(v) {
    muted = v;
    if (ambienceMasterGain) ambienceMasterGain.gain.value = muted ? 0 : AMBIENCE_VOLUME;
    if (laserGain) laserGain.gain.value = muted ? 0 : dbToGain(laserTargetDb);
  }
  function isMuted() { return muted; }

  // call from the first pointerdown/click in the page — resume() above only
  // actually unlocks audio when invoked from within a user-gesture handler
  function unlock() { ensureContext(); }

  function dbToGain(db) { return Math.pow(10, db / 20); }

  // Schedules one leg of the post-attack ping-pong loop (either the forward
  // slice or its reversed twin) starting at `startAt`, then arms the next leg
  // ahead of time exactly like scheduleAmbienceVoice()'s lookahead. Forward
  // and reversed share the exact same samples at both the loop-point and the
  // buffer's end (one is just the other read backwards), so alternating them
  // plays like a wave bouncing between two mirrors: no crossfade/fade
  // envelope needed, the waveform is already sample-continuous across every
  // turn. `token` guards against a leg queued for a drag that's since ended
  // (stopLaser()/a fresh startLaser() bump laserToken) firing anyway.
  function scheduleLaserLeg(forward, startAt, token) {
    const buffer = forward ? laserLoopBuffer : laserLoopBufferReversed;
    const dur = buffer.duration;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(laserGain);
    src.start(startAt);
    laserSrc = src;
    const nextStart = startAt + dur;
    const msUntilSchedule = (nextStart - ctx.currentTime - SCHEDULE_LOOKAHEAD_S) * 1000;
    laserTimer = setTimeout(() => {
      if (token === laserToken) scheduleLaserLeg(!forward, nextStart, token);
    }, Math.max(0, msUntilSchedule));
  }

  // Starts the aim-laser cue from the top: the full clip once (attack
  // included), then the LASER_LOOP_POINT_S-in ping-pong body for as long as
  // the drag lasts — call stopLaser() to cut it off (see setLaserIntensity()
  // for the live volume-by-pull-distance behavior). Safe to call again
  // mid-drag or after a stop: always tears down and restarts clean from the
  // attack, since each grab is its own cue.
  //
  // phaseOffsetS: the grabbed stone's own halo phase offset (game.js:
  // (idx/3) * HALO_PULSE_PERIOD), so the lowpass sweep below starts already
  // in sync with that specific stone's halo instead of restarting from 0.
  //
  // The sweep itself is a real OscillatorNode driving laserFilter.frequency
  // directly (Web Audio adds a connected node's output onto an AudioParam's
  // own value) rather than something recomputed and pushed every frame from
  // JS — sample-accurate and effectively free once started. Getting it to
  // start already mid-cycle (matching wherever the halo currently is, not
  // phase 0) uses the fact that an oscillator's phase is computed from its
  // scheduled start() time even if that time is in the past: solving
  // sin(2π·f·(t-t0)) = cos(θ_now) for t0 gives
  // t0 = now - elapsedInCycle - period/4 (the period/4 accounts for sin vs.
  // the halo's cosine-based curve). laserFilter's own frequency.value carries
  // the sweep's DC/center component; laserLfoGain scales the oscillator's
  // -1..1 swing to the ± half-range added on top of it.
  function startLaser(phaseOffsetS = 0) {
    if (!ctx || !laserFullBuffer || !laserLoopBuffer) return;
    stopLaser();
    const token = laserToken;
    laserTargetDb = LASER_VOLUME_MIN_DB;
    laserGain = ctx.createGain();
    laserGain.gain.value = muted ? 0 : dbToGain(laserTargetDb);
    laserFilter = ctx.createBiquadFilter();
    laserFilter.type = 'lowpass';
    laserFilter.frequency.value = (LASER_LP_MIN_HZ + LASER_LP_MAX_HZ) / 2;
    laserLfoGain = ctx.createGain();
    // Positive sign (was negative): the raw oscillator tracks the halo's
    // pulseStrength() curve one half-cycle out of phase (its cos(θ) is 1 right
    // when the halo's (1-cos θ)/2 is 0), so flipping this sign is what lines
    // the filter's peak up with the halo's bright point instead of its dim one.
    laserLfoGain.gain.value = (LASER_LP_MAX_HZ - LASER_LP_MIN_HZ) / 2;
    // Tremolo riding the exact same sweep: 0dB at the cutoff's peak (LASER_LP_MAX_HZ),
    // LASER_LP_GAIN_DIP_DB at its trough — same derivation as the filter's DC
    // base/± term above, just in linear-gain space instead of Hz.
    laserPulseGain = ctx.createGain();
    const dipGain = dbToGain(LASER_LP_GAIN_DIP_DB);
    laserPulseGain.gain.value = (1 + dipGain) / 2;
    laserLfoGainForPulse = ctx.createGain();
    laserLfoGainForPulse.gain.value = (1 - dipGain) / 2;
    laserLfo = ctx.createOscillator();
    laserLfo.type = 'sine';
    laserLfo.frequency.value = 1 / LASER_LP_PERIOD_S;
    laserLfo.connect(laserLfoGain).connect(laserFilter.frequency);
    laserLfo.connect(laserLfoGainForPulse).connect(laserPulseGain.gain);
    const elapsedInCycle = (performance.now() / 1000 + phaseOffsetS) % LASER_LP_PERIOD_S;
    laserLfo.start(ctx.currentTime - elapsedInCycle - LASER_LP_PERIOD_S / 4);
    laserGain.connect(laserPulseGain).connect(laserFilter).connect(masterNode);
    const startAt = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = laserFullBuffer;
    src.connect(laserGain);
    src.start(startAt, 0, laserIntroDuration); // stop LASER_END_TRIM_S short of the real end, same as the loop body
    laserSrc = src;
    const introEnd = startAt + laserIntroDuration;
    const msUntilSchedule = (introEnd - ctx.currentTime - SCHEDULE_LOOKAHEAD_S) * 1000;
    laserTimer = setTimeout(() => {
      // reversed leg first: it starts at the buffer's end, exactly where the attack just left off
      if (token === laserToken) scheduleLaserLeg(false, introEnd, token);
    }, Math.max(0, msUntilSchedule));
  }

  // t: 0 (just grabbed) .. 1 (pulled to max drag) — nudges the loop's volume
  // up a touch the further the shot is pulled, so a bigger shot reads as a
  // little more charged. Ramped rather than snapped since onPointerMove calls
  // this on every few pixels of drag and a hard jump would zipper.
  function setLaserIntensity(t) {
    if (!laserGain) return;
    const clamped = Math.max(0, Math.min(1, t));
    laserTargetDb = LASER_VOLUME_MIN_DB + (LASER_VOLUME_MAX_DB - LASER_VOLUME_MIN_DB) * clamped;
    laserGain.gain.linearRampToValueAtTime(muted ? 0 : dbToGain(laserTargetDb), ctx.currentTime + 0.05);
  }

  function stopLaser() {
    laserToken++;
    clearTimeout(laserTimer);
    laserTimer = null;
    if (laserSrc) { try { laserSrc.stop(); } catch { /* already ended */ } laserSrc = null; }
    if (laserGain) { laserGain.disconnect(); laserGain = null; }
    if (laserPulseGain) { laserPulseGain.disconnect(); laserPulseGain = null; }
    if (laserLfo) { try { laserLfo.stop(); } catch { /* already ended */ } laserLfo.disconnect(); laserLfo = null; }
    if (laserLfoGain) { laserLfoGain.disconnect(); laserLfoGain = null; }
    if (laserLfoGainForPulse) { laserLfoGainForPulse.disconnect(); laserLfoGainForPulse = null; }
    if (laserFilter) { laserFilter.disconnect(); laserFilter = null; }
  }

  function startGlideVoice(id) {
    const src = ctx.createBufferSource();
    src.buffer = glideSampleBuffer; // recorded whoosh, not looped — one-shot per launch; setGlide()'s release envelope decides how much of it actually gets heard
    // Two cascaded lowpass biquads = 24dB/oct — a single BiquadFilterNode only
    // gives 12dB/oct, so the "24dB" slope from the design discussion needs two
    // identical nodes in series, both swept together in setGlide().
    const lowpass1 = ctx.createBiquadFilter();
    lowpass1.type = 'lowpass';
    lowpass1.frequency.value = GLIDE_LP_MIN_HZ;
    const lowpass2 = ctx.createBiquadFilter();
    lowpass2.type = 'lowpass';
    lowpass2.frequency.value = GLIDE_LP_MIN_HZ;
    const gain = ctx.createGain();
    gain.gain.value = 0; // ramped by the attack/release envelope setGlide() schedules on creation
    const panner = ctx.createStereoPanner();
    src.connect(lowpass1).connect(lowpass2).connect(gain).connect(panner).connect(masterNode);
    src.start();
    const voice = { src, lowpass1, lowpass2, gain, panner, stopping: false };
    glideVoices[id] = voice;
    // Not looped, so it can reach the end of the recording on its own — the
    // common case is setGlide()'s gain envelope fading it out first and
    // stopGlideVoice() overwriting this handler with its own cleanup, but a
    // strong shot's release can run close to the sample's full length, so
    // this covers playback finishing before that envelope ever calls stop().
    // Marks `finished` instead of deleting the entry outright: an entity that
    // keeps sliding (physics friction) well past the ~1.5s sample often keeps
    // calling setGlide() with norm > 0 long after the recording ends — if the
    // entry were gone, that call would see no voice and start a brand new
    // one, restarting the sample from the top and sounding like a loop. The
    // real teardown (delete) only happens in stopGlideVoice(), fired once
    // physics actually reports the entity has stopped (norm <= 0).
    src.onended = () => {
      if (glideVoices[id] !== voice) return;
      voice.src.disconnect();
      voice.lowpass1.disconnect(); voice.lowpass2.disconnect();
      voice.gain.disconnect(); voice.panner.disconnect();
      voice.finished = true;
    };
    return voice;
  }

  // id: any stable per-entity key (game.js uses each stone's own id, 'ball'
  // for the puck). norm: 0-1, current speed normalized against the entity's
  // own max speed — audio.js doesn't know game physics constants, so this is
  // the caller's job, same convention as play()'s volume/rate. norm <= 0
  // fades this id's voice out. pan: same -1..1 convention as play().
  // Voices beyond GLIDE_MAX_VOICES are silently dropped (already-playing
  // ones are never stolen) — a rare big pileup just doesn't get every stone's
  // glide voiced, not a bug to fix, this is meant to stay a light bed.
  //
  // Volume AND filter cutoff are both one-shot envelopes, scheduled once
  // below at voice creation from that first norm (the shot's launch power) —
  // neither ever tracks the entity's real-time speed again. game.js keeps
  // calling this every physics frame for as long as the entity keeps moving,
  // but every call after creation only updates pan; gain and filter automation
  // was already scheduled up front and just plays out on its own clock. That
  // matters because friction decays speed smoothly frame to frame — there's
  // no distinct "still cruising" vs "slowing down" moment to react to in real
  // time, so live-tracking norm made the filter (and, before, the volume)
  // visibly creep shut the entire time, even through what reads to a player
  // as a steady glide. Fixed schedule instead: the filter snaps open fast
  // (same attack as the gain), *holds* at that peak for most of the sound's
  // life, then closes briefly right at the very end — timed to land exactly
  // as the gain envelope reaches silence, so the close is never heard
  // happening mid-glide. It doesn't fully re-close either:
  // GLIDE_LP_CLOSE_FLOOR_HZ keeps it well short of GLIDE_LP_MIN_HZ, so the
  // tail stays fairly bright rather than going dull.
  // Only a real full stop (norm <= 0, which tears the voice down below)
  // followed by a fresh launch starts a new envelope — no retrigger off a
  // mid-glide wall bounce.
  function setGlide(id, norm, pan = 0) {
    if (muted || !ctx) { stopGlideVoice(id, true); return; }
    const n = Math.max(0, Math.min(1, norm || 0));
    if (n <= 0) { stopGlideVoice(id); return; }
    let voice = glideVoices[id];
    if (voice && voice.finished) return; // sample already played through this launch — stay silent rather than retriggering just because the entity is still sliding
    if (!voice) {
      // A voice for a *different* id can be stuck here as `finished` forever:
      // game.js only ever calls setGlide() for the round's current leader
      // (glideLeaderId), so once a round hands the leader role to a new
      // entity, the previous leader's voice stops receiving calls entirely —
      // including the norm<=0 one stopGlideVoice() needs to actually delete
      // it. It still finishes and goes silent on its own (see
      // startGlideVoice()'s onended), but the stale entry lingers in
      // glideVoices and, with GLIDE_MAX_VOICES this low, permanently blocks
      // every later round's leader from ever getting a voice. Sweep finished
      // entries out here, right before the cap check, so that can't happen.
      Object.keys(glideVoices).forEach((k) => { if (glideVoices[k].finished) delete glideVoices[k]; });
      if (!glideSampleBuffer || Object.keys(glideVoices).length >= GLIDE_MAX_VOICES) return;
      voice = startGlideVoice(id);
      const now = ctx.currentTime;
      const peak = n * GLIDE_MAX_VOLUME;
      const releaseS = GLIDE_RELEASE_MIN_S + n * (GLIDE_RELEASE_MAX_S - GLIDE_RELEASE_MIN_S);
      voice.gain.gain.setValueAtTime(0, now);
      voice.gain.gain.linearRampToValueAtTime(peak, now + GLIDE_ATTACK_S);
      voice.gain.gain.linearRampToValueAtTime(0, now + GLIDE_ATTACK_S + releaseS);
      // n² rather than linear: a weak tap barely brightens, the peppy/fast
      // read is reserved for a hard shot.
      const peakHz = GLIDE_LP_MIN_HZ + n * n * (GLIDE_LP_MAX_HZ - GLIDE_LP_MIN_HZ);
      const closeS = Math.min(GLIDE_FILTER_CLOSE_S, releaseS); // never longer than the release itself, for a very short/weak glide
      [voice.lowpass1, voice.lowpass2].forEach((lp) => {
        lp.frequency.setValueAtTime(GLIDE_LP_MIN_HZ, now);
        lp.frequency.linearRampToValueAtTime(peakHz, now + GLIDE_ATTACK_S);
        lp.frequency.setValueAtTime(peakHz, now + GLIDE_ATTACK_S + releaseS - closeS); // anchors the hold's end so the ramp below starts from here
        lp.frequency.linearRampToValueAtTime(GLIDE_LP_CLOSE_FLOOR_HZ, now + GLIDE_ATTACK_S + releaseS);
      });
    }
    const now = ctx.currentTime;
    voice.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, GLIDE_PARAM_TAU);
  }

  function stopGlideVoice(id, immediate = false) {
    const voice = glideVoices[id];
    if (!voice || voice.stopping) return;
    voice.stopping = true;
    // `finished` (see startGlideVoice()'s onended) means the ~1.5s recording
    // already played out and fired its onended once, naturally — very common,
    // since a real glide (several seconds of friction decay) routinely
    // outlasts the sample. A BufferSourceNode's onended only ever fires once
    // per node, at that one real stop transition; reassigning `.onended`
    // below and calling `.stop()` again on an already-ended node is a no-op
    // that will NEVER fire the new handler, so the `delete glideVoices[id]`
    // it was meant to do would simply never happen — leaving this id stuck
    // "finished" forever and permanently silencing every later round that
    // picks it as the glide leader again. Delete immediately in that case
    // instead of scheduling a fade that can't complete (nodes are already
    // disconnected by that first onended, so there's nothing left to fade).
    if (immediate || !ctx || voice.finished) {
      try { voice.src.stop(); } catch { /* already ended */ }
      if (!voice.finished) {
        voice.src.disconnect();
        voice.lowpass1.disconnect(); voice.lowpass2.disconnect();
        voice.gain.disconnect(); voice.panner.disconnect();
      }
      delete glideVoices[id];
      return;
    }
    const now = ctx.currentTime;
    voice.gain.gain.setTargetAtTime(0, now, GLIDE_PARAM_TAU);
    voice.src.stop(now + GLIDE_STOP_FADE_S);
    voice.src.onended = () => {
      voice.src.disconnect();
      voice.lowpass1.disconnect(); voice.lowpass2.disconnect();
      voice.gain.disconnect(); voice.panner.disconnect();
      delete glideVoices[id];
    };
  }

  // Safety net for spots where physics stops advancing outright (match over,
  // LAN disconnect dead-end) — the normal case never needs this, a voice
  // already fades itself out as physicsStep drives that entity's speed to 0.
  function stopAllGlides() {
    Object.keys(glideVoices).forEach((id) => stopGlideVoice(id, true));
  }

  // The raw clip's tail doesn't tile seamlessly into its head (audible seam
  // on every repeat), so instead of a single AudioBufferSourceNode with
  // loop=true, each pass through the clip is its own full-length copy
  // scheduled AMBIENCE_LOOP_CROSSFADE_S before the previous one ends, with a
  // fade-in/out envelope over that overlap — consecutive copies blend into
  // each other instead of cutting. All copies feed the same
  // ambienceMasterGain, so mute/fade-in/volume still control the whole loop
  // as one thing.
  function scheduleAmbienceVoice() {
    const dur = ambienceBuffer.duration;
    const fade = Math.min(AMBIENCE_LOOP_CROSSFADE_S, dur / 2);
    const startAt = ambienceNextStart;
    const src = ctx.createBufferSource();
    src.buffer = ambienceBuffer;
    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, startAt);
    voiceGain.gain.linearRampToValueAtTime(1, startAt + fade);
    voiceGain.gain.setValueAtTime(1, startAt + dur - fade);
    voiceGain.gain.linearRampToValueAtTime(0, startAt + dur);
    src.connect(voiceGain).connect(ambienceMasterGain);
    src.start(startAt);
    src.stop(startAt + dur + 0.05);
    ambienceVoices.push(src);
    src.onended = () => { ambienceVoices = ambienceVoices.filter((v) => v !== src); };
    ambienceNextStart = startAt + dur - fade;
    // Scheduled AudioParam/start() calls are sample-accurate regardless of
    // when this setTimeout actually fires — it only needs to land sometime
    // before ambienceNextStart, with enough slack (SCHEDULE_LOOKAHEAD_S)
    // that a busy main thread can't cause a gap.
    const msUntilSchedule = (ambienceNextStart - ctx.currentTime - SCHEDULE_LOOKAHEAD_S) * 1000;
    ambienceTimer = setTimeout(() => { if (ambiencePlaying) scheduleAmbienceVoice(); }, Math.max(0, msUntilSchedule));
  }

  // starts the crossfaded ambience loop; safe to call multiple times, a
  // second call is a no-op while it's already playing. The overall loop
  // still fades in over AMBIENCE_FADE_MS rather than snapping straight to
  // volume — it tends to restart right as a round begins/resumes, and an
  // instant loop kicking in reads as a jarring pop against everything else
  // easing in.
  function playAmbience() {
    if (ambiencePlaying || !ctx || !ambienceBuffer) return;
    ambiencePlaying = true;
    ambienceMasterGain = ctx.createGain();
    const target = muted ? 0 : AMBIENCE_VOLUME;
    ambienceMasterGain.gain.setValueAtTime(0, ctx.currentTime);
    ambienceMasterGain.gain.linearRampToValueAtTime(target, ctx.currentTime + AMBIENCE_FADE_MS / 1000);
    ambienceMasterGain.connect(masterNode);
    ambienceNextStart = ctx.currentTime;
    scheduleAmbienceVoice();
  }

  function stopAmbience() {
    // cleared unconditionally (even if ambience was already stopped) so a
    // stale idle-pause flag can never linger into a later, unrelated stop —
    // see the idle-timeout watchdog below, which is the only place this gets
    // set back to true.
    pausedForIdle = false;
    if (!ambiencePlaying) return;
    ambiencePlaying = false;
    clearTimeout(ambienceTimer);
    ambienceTimer = null;
    ambienceVoices.forEach((src) => src.stop());
    ambienceVoices = [];
    ambienceMasterGain.disconnect();
    ambienceMasterGain = null;
  }

  // Safety net against a backgrounded/forgotten tab looping the ambience
  // forever with nobody around to hear it call stopAmbience() — independent
  // of whatever game.js phase logic thinks should be happening. Pauses the
  // instant the tab is hidden (switched away from, minimized, closed-but-
  // still-alive in some outer devtools/automation context) and only resumes
  // if it was actually us who paused it, so a match that was legitimately
  // silent (goal panel, menu, gameover) before backgrounding stays silent
  // after returning too.
  let pausedForHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (ambiencePlaying) { stopAmbience(); pausedForHidden = true; }
    } else if (pausedForHidden) {
      pausedForHidden = false;
      playAmbience();
    }
  });

  // Second, independent safety net: a tab that stays VISIBLE (so the check
  // above never fires) but is never actually interacted with — an orphaned
  // dev/test browser tab left running behind other windows, forgotten after
  // whoever opened it moved on — would otherwise loop the ambience forever
  // with nobody around to stop it. Any real pointer/keyboard input resets
  // the clock; once AMBIENCE_IDLE_TIMEOUT_MS passes with none, ambience is
  // silenced automatically, and comes right back the instant real input
  // resumes (same "only auto-resume if we're the one who paused it" pattern
  // as pausedForHidden above) — so an actual player who just went quiet for a
  // while (afk, thinking about a shot) never loses anything permanently.
  const AMBIENCE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const AMBIENCE_IDLE_CHECK_MS = 30 * 1000;
  let lastInteractionAt = Date.now();
  let pausedForIdle = false;
  ['pointerdown', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, () => {
      lastInteractionAt = Date.now();
      if (pausedForIdle) { pausedForIdle = false; playAmbience(); }
    }, { passive: true });
  });
  setInterval(() => {
    if (ambiencePlaying && Date.now() - lastInteractionAt > AMBIENCE_IDLE_TIMEOUT_MS) {
      stopAmbience();
      pausedForIdle = true;
    }
  }, AMBIENCE_IDLE_CHECK_MS);

  return { load, play, setMuted, isMuted, unlock, playAmbience, stopAmbience, startLaser, setLaserIntensity, stopLaser, setGlide, stopAllGlides, getMasterPeakDb, onPlay };
}

// Single shared instance: main.js (toolbar's mute button, ambience) and
// game.js (in-match SFX) both import this same object, so muting from the
// toolbar affects a match's sounds without passing an audio handle through
// startGame(opts) — same rationale as settings.js's shared basicLaser flag.
export const audio = createAudio();
