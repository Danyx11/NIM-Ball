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

// True only for A's own very first shot of a brand new match — no point has
// been scored yet AND this point itself has no manches yet either (a later
// point starting fresh, after the last one scored, also has an empty
// resumeManchesFor(week), which is why that alone isn't enough here — see
// game.js's own weekMatchStart comment). Deliberately gated on team === 'A'
// too: B's own first aim session hits this exact same "scoreless, no
// manches yet" state (it's still the match's first point) but per explicit
// feedback should never replay the intro either — B is joining a match
// already in progress, not opening one. Only ever passed to playSingleShot
// below, never to playReveal — a reveal is two already-known shots about to
// resolve, never "the match opening", regardless of team or score (see
// playReveal's own comment on why it omits this opt entirely; passing
// isMatchStart(week) there too, for whichever side reveals the match's
// first-ever manche, was the actual bug behind stones resetting and the
// intro replaying between a shot and its reveal).
function isMatchStart(week) {
  return week.team === 'A' && week.scoreA === 0 && week.scoreB === 0 && !(week.pointManches && week.pointManches.length);
}

// "Your turn" — runs a single-team aim session (no timer, no opponent
// visible, same 'lanAim' gating LAN already uses) and resolves once that
// shot is committed. Tears the session down itself before resolving —
// callers never need their own stopGame() for this half of WEEK.
// boardSnapshot: a plain data-URL freeze-frame of the canvas at the exact
// instant the shot commits (before stopGame() clears it) — main.js's
// post-commit "YOUR SHOT IS ON THE ICE" screen shows this as its background
// instead of keeping the whole engine alive just to display a static board,
// per the WEEK flow-simplification conversation (rink-as-background, not a
// second live session).
export function playSingleShot(week, engineOpts) {
  return new Promise((resolve) => {
    const stopGame = startGame({
      ...engineOpts,
      singleShotTeam: week.team,
      resumeManches: resumeManchesFor(week),
      weekMatchStart: isMatchStart(week),
      matchConfig: week.config,
      vibe: week.game,
      onShotCommitted: (stones, sweep) => {
        const boardSnapshot = document.getElementById('stage').toDataURL();
        stopGame();
        resolve({ stones, sweep, boardSnapshot });
      },
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
      // No weekMatchStart here — see isMatchStart's own comment: a reveal
      // never shows the match-intro huddle/sting, regardless of team or
      // score, only ever playSingleShot does.
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
