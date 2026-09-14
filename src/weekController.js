// WEEK orchestration — pure orchestration on top of the existing engine
// (src/game.js), not a second game engine. game.js never learns "this is
// WEEK": it only ever sees the generic hooks documented at the top of
// startGame() (singleShotTeam/onShotCommitted/externalManche/
// onMancheSettled/resumeManches/weekPointStart/weekEntryReady/
// weekStartScoreA/weekStartScoreB) — the same primitives a future caller
// other than WEEK could reuse. See the WEEK design conversation for the
// full architecture rationale and the two things verified before relying on
// them: fastForwardManche() has no isReplay-only coupling (it's a pure
// entities/sweep/physicsStep() function), and onMancheSettled only fires
// once the player has dismissed the result panel (verified via
// maybeAdvanceRound()'s own goalPanelDismissed gate — the same single-
// viewer mechanism solo/AI/replay already rely on, not something new here).
//
// This file owns match lifecycle, persistence round-trips (party/
// weekArbiter.js via src/net.js), and *deciding when* to run an aim or a
// reveal session — not their DOM/HTML. Rendering (the message/skip screen,
// the waiting screen, etc.) stays in src/main.js, consistent with how every
// other screen in this app is built (main.js owns 100% of the DOM outside
// the canvas) — the functions below take the caller's engine options, import
// startGame() directly, and resolve a plain result object; apart from the
// canvas freeze-frame each one grabs on the way out (see boardSnapshot), they
// never touch the DOM themselves.
import { startGame } from './game.js';

// Both teams' shots, in the engine's absolute A/B shape — week.reveal is
// keyed 'mine'/'opponent' (team-relative, see party/weekArbiter.js's
// snapshotFor), translated here based on which team this connection is.
function revealToManche(week) {
  const { mine, opponent } = week.reveal;
  return week.team === 'A'
    ? { stonesA: mine.stones, sweepA: mine.sweep, stonesB: opponent.stones, sweepB: opponent.sweep }
    : { stonesA: opponent.stones, sweepA: opponent.sweep, stonesB: mine.stones, sweepB: mine.sweep };
}

// party/weekArbiter.js's pointManches is already {stonesA, sweepA, stonesB,
// sweepB} per entry — the exact shape fastForwardManche()/externalManche
// both expect, no translation needed (unlike revealToManche above, this
// isn't team-relative).
function resumeManchesFor(week) { return week.pointManches || null; }

// The same question, asked for a REVEAL rather than for an aim turn — and
// the answers genuinely differ. An aim reconstructs the board up to *now*
// (resumeManchesFor above). A reveal has to reconstruct it up to *its own
// start*, which is not the same board the moment this player is a straggler
// catching up on a manche their opponent already reported: pointManches has
// by then either grown to include that very manche (a no-goal settle —
// replaying it and then playing the reveal applied it twice, the measured
// bug) or been emptied by a scored point (so the reveal played from the bare
// rack instead of wherever the point had actually got to).
//
// party/weekArbiter.js answers it directly now, on the reveal itself, for
// both of its sources — so the normal path is just reveal.priorManches.
// The fallback below only runs for a match persisted before that field
// existed, and cannot be as good: it repairs the no-goal case exactly (the
// offending manche is provably the last entry) but has nothing to rebuild
// the scored case from, since the server had already discarded it. Those
// matches keep today's behaviour there.
//
// mySubmitted && opponentSubmitted IS the server's own `bothIn` — see
// snapshotFor, where both are literally !!pendingShots[...] — so which
// source a reveal came from is known, not inferred.
function revealResumeManchesFor(week) {
  const prior = week.reveal?.priorManches;
  if (prior) return prior.length ? prior : null;
  const played = week.pointManches || [];
  if (week.mySubmitted && week.opponentSubmitted) return played.length ? played : null;
  const trimmed = played.slice(0, -1);
  return trimmed.length ? trimmed : null;
}

// A freeze-frame of the canvas at the exact instant a shot commits or a
// manche settles. Still taken even though the engine now survives both of
// those moments: main.js's "Your shot is ready" screen is shown over a
// torn-down session on the one path that genuinely has nothing left to do
// (see playSingleShot's own onShotCommitted comment).
function boardSnapshot() { return document.getElementById('stage').toDataURL(); }

// The handle main.js drives a live WEEK engine through, built once per
// session over the engine's own session object (game.js's return value for
// a singleShotTeam session). Deliberately a different, smaller shape than
// the engine's: main.js has no business resuming an aim phase without also
// waiting on the shot it produces, nor injecting a reveal without waiting on
// its outcome, so each of those is a single awaitable call here.
//
// The two resolver slots are what bridge the engine's fire-and-forget
// callbacks to those awaits — set on the way in, consumed (and cleared) by
// the matching callback below. `week` rather than a raw manche on
// watchReveal so the team-relative -> absolute A/B translation stays in this
// file, where revealToManche already lives.
function makeSession(engine, slots) {
  return {
    stop: engine.stop,
    // Starts the next aim turn on this live engine and resolves with that
    // turn's committed shot — playSingleShot's own aim half, minus the
    // startGame()/stopGame() that used to bracket it. No board
    // reconstruction, no re-seeded score, no second intro: the board is
    // simply still there (see game.js's resumeAim).
    aimNextShot() {
      return new Promise((res) => { slots.shot = res; engine.resumeAim(); });
    },
    // Plays an opponent's just-arrived reveal on this same live engine and
    // resolves once it has fully settled (including, if it scored, the
    // player dismissing the +1 panel) — see game.js's startReveal.
    watchReveal(week) {
      const manche = revealToManche(week);
      return new Promise((res) => {
        slots.settled = (result) => res({ ...result, manche });
        engine.startReveal(manche);
      });
    },
  };
}

// The two engine callbacks every WEEK session wires up, both routed through
// the same resolver slots makeSession fills. Shared verbatim by both entry
// points below so an aim turn resolves identically whichever of them started
// the session.
function sessionCallbacks(slots) {
  return {
    onShotCommitted: (stones, sweep) => {
      const snap = boardSnapshot();
      const done = slots.shot; slots.shot = null;
      done?.({ stones, sweep, boardSnapshot: snap });
    },
    onMancheSettled: (result) => {
      const snap = boardSnapshot();
      const done = slots.settled; slots.settled = null;
      done?.({ ...result, boardSnapshot: snap });
    },
  };
}

// "Your turn" — runs a single-team aim session (no timer, no opponent
// visible, same 'lanAim' gating LAN already uses) and resolves once that
// shot is committed.
//
// Stage 4 of the WEEK persistent-session migration: this no longer tears
// its own session down on the way out either (playReveal below stopped at
// Stage 2). The caller decides what happens next, because only it knows —
// the server's reply to that shot says whether the opponent's own shot was
// already waiting. If it was, the reveal plays out on THIS engine
// (session.watchReveal); if not, there is genuinely nothing left for a live
// engine to do (WEEK never pushes, so the "waiting" screen cannot progress
// on its own — see main.js) and the caller stops it.
// onSessionStart(session) (optional): handed this session's handle the
// instant the engine exists — synchronously, before this promise ever
// resolves. The engine is alive (rAF loop running, canvas.dataset.nbStarted
// set) for the player's whole aim turn, including any time spent looking at
// main.js's own "Play" card before tapping it — a window this promise does
// NOT resolve during. Without this hook, nothing outside this closure has a
// way to tear that down if the player quits mid-turn instead of committing
// a shot (main.js's activeStopGame stayed null for WEEK the whole time,
// which is the exact softlock this hook exists to close — see CLAUDE.md's
// WEEK section / the architecture recon). main.js assigns activeStopGame
// from session.stop, the same variable every other mode's own startGame()
// call already feeds directly.
export function playSingleShot(week, engineOpts, onSessionStart) {
  return new Promise((resolve) => {
    const slots = { shot: resolve, settled: null };
    const engine = startGame({
      ...engineOpts,
      ...sessionCallbacks(slots),
      singleShotTeam: week.team,
      resumeManches: resumeManchesFor(week),
      // The match-start ceremony (beginMatchIntro's huddle slide-in + the
      // 'matchStart' sting), exactly as a normal match has it: once, at the
      // very start, never again. It used to fire on every NEW point (via
      // party/weekArbiter.js's enteredPoint, which resets when a point is
      // scored) — but beginMatchIntro only repositions stones, it does not
      // revive them the way beginRoundReset does, so replaying it mid-match
      // would slide dead or fallen stones to the rack still greyed out (or
      // invisible, since drawStone skips `out` ones). A point boundary
      // already has its own animation: the stones sliding home behind the
      // +1 panel. `round === 0 && !mySubmitted` is "this match has never
      // had a manche resolved AND I have not taken my first turn yet" —
      // true for A on creation and for B on joining, false for both forever
      // after, derived from fields snapshotFor already sends.
      weekPointStart: week.round === 0 && !week.mySubmitted,
      // Seeds this session's own local score with the match's real running
      // total (see startGame's own comment on why a fresh session would
      // otherwise always start counting from 0).
      weekStartScoreA: week.scoreA, weekStartScoreB: week.scoreB,
      matchConfig: week.config,
      vibe: week.game,
    });
    onSessionStart?.(makeSession(engine, slots));
  });
}

// "Watch the reveal", cold entry — both shots are already known
// (week.reveal). Plays them out with completely normal pacing/physics/
// rendering (reusing launchSimulation() exactly as the AI branch does) and
// resolves once the manche has fully settled, including — if it scored —
// the player dismissing the result panel.
//
// Only for a reveal this player arrives at from OUTSIDE a live session (a
// fresh entry, a reconnect, My Matches): once a session is already running,
// an opponent's shot that turns up in the reply to this player's own is
// played on that engine instead, via session.watchReveal (Stage 4) — no
// teardown, no rebuild, no board reconstruction in between.
//
// Like playSingleShot above, this does not tear its own session down: the
// engine stays alive, parked on the settled board (game.js's 'mancheHold'
// phase), and the caller decides from the server's reply whether it carries
// on into the next aim turn or ends here.
// onSessionStart(session): see playSingleShot's own comment — same reason,
// same contract. A reveal session is just as alive (and just as quittable
// mid-flight, e.g. from the "Watch the reveal" card before it's tapped, or
// while the manche is still playing out) as an aim session is.
export function playReveal(week, engineOpts, onSessionStart) {
  const manche = revealToManche(week);
  return new Promise((resolve) => {
    // `manche` rides along on the resolved result (not just scoreA/scoreB/
    // scoredTeam/matchOver) so the caller can report the exact same shot
    // data back to party/weekArbiter.js's completeRound without recomputing
    // the team-relative -> A/B mapping itself (see revealToManche above).
    const slots = { shot: null, settled: (result) => resolve({ ...result, manche }) };
    const engine = startGame({
      ...engineOpts,
      ...sessionCallbacks(slots),
      externalManche: manche,
      // This session outlives the reveal, so it has to be a full WEEK
      // session from the start rather than a reveal-only one.
      // singleShotTeam is what makes beginAimPhase() route the turn that
      // follows into 'lanAim' — without it, that same call lands in the
      // Pass & Play hand-off mask instead (see its own
      // `!net && !aiTeam && !singleShotTeam` branch) — and what makes
      // onValidate() accept that turn's PLAY at all. Completely inert while
      // the reveal itself plays out: aimingTeam()/sweepViewTeam() both gate
      // on phase, which is never an aiming one before resumeAim() runs.
      singleShotTeam: week.team,
      // revealResumeManchesFor, NOT resumeManchesFor: a reveal rebuilds the
      // board up to its own start, not up to now — see that function.
      resumeManches: revealResumeManchesFor(week),
      // No weekPointStart here — a reveal never shows the match-intro
      // huddle/sting, regardless of team, score, or whether this happens to
      // be this player's first look at the point (see startGame's own
      // comment: entering a point and watching a reveal are different
      // things — only the former gets the ceremony).
      weekStartScoreA: week.scoreA, weekStartScoreB: week.scoreB,
      matchConfig: week.config,
      vibe: week.game,
    });
    onSessionStart?.(makeSession(engine, slots));
  });
}
