// WEEK orchestration — pure orchestration on top of the existing engine
// (src/game.js), not a second game engine. game.js never learns "this is
// WEEK": it only ever sees the 5 generic hooks documented at the top of
// startGame() (singleShotTeam/onShotCommitted/externalManche/
// onMancheSettled/resumeManches) — the same primitives a future caller
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
// the canvas) — the functions below take a `startGame`/`preloadCoreAssets`-
// shaped `engine` plus rendering options and resolve a plain result object,
// they never touch the DOM themselves.
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

// "Your turn" — runs a single-team aim session (no timer, no opponent
// visible, same 'lanAim' gating LAN already uses) and resolves once that
// shot is committed. Tears the session down itself before resolving —
// callers never need their own stopGame() for this half of WEEK.
export function playSingleShot(week, engineOpts) {
  return new Promise((resolve) => {
    const stopGame = startGame({
      ...engineOpts,
      singleShotTeam: week.team,
      resumeManches: resumeManchesFor(week),
      matchConfig: week.config,
      vibe: week.game,
      onShotCommitted: (stones, sweep) => { stopGame(); resolve({ stones, sweep }); },
    });
  });
}

// "Watch the reveal" — both shots are already known (week.reveal). Plays
// them out with completely normal pacing/physics/rendering (reusing
// launchSimulation() exactly as the AI branch does) and resolves once the
// manche has fully settled, including — if it scored — the player
// dismissing the result panel. Tears the session down itself before
// resolving, same as playSingleShot above.
export function playReveal(week, engineOpts) {
  const manche = revealToManche(week);
  return new Promise((resolve) => {
    const stopGame = startGame({
      ...engineOpts,
      externalManche: manche,
      resumeManches: resumeManchesFor(week),
      matchConfig: week.config,
      vibe: week.game,
      // `manche` rides along on the resolved result (not just
      // scoreA/scoreB/matchOver) so the caller can report the exact same
      // shot data back to party/weekArbiter.js's completeRound without
      // recomputing the team-relative -> A/B mapping itself (see
      // revealToManche above) — main.js's showWeekRevealScreen does exactly
      // that.
      onMancheSettled: (result) => { stopGame(); resolve({ ...result, manche }); },
    });
  });
}
