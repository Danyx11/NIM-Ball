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
// boardSnapshot: a plain data-URL freeze-frame of the canvas at the exact
// instant the shot commits (before stopGame() clears it) — main.js's
// post-commit "Your shot is ready" screen shows this as its background
// instead of keeping the whole engine alive just to display a static board,
// per the WEEK flow-simplification conversation (rink-as-background, not a
// second live session).
export function playSingleShot(week, engineOpts) {
  return new Promise((resolve) => {
    const stopGame = startGame({
      ...engineOpts,
      singleShotTeam: week.team,
      resumeManches: resumeManchesFor(week),
      // week.enteredPoint is party/weekArbiter.js's own authoritative
      // computation (see its snapshotFor comment) — true exactly when this
      // team has never yet played a shot or watched a reveal in the CURRENT
      // point, false the instant they have, forever until the point
      // actually ends (scored). Per explicit requirement: PLAY + the
      // point-start animation are shown once per player per NEW point —
      // not just the match's very first one, and never again within the
      // same still-open point regardless of how many times this player
      // leaves and reconnects mid-point.
      weekPointStart: !week.enteredPoint,
      // Seeds this session's own local score with the match's real running
      // total (see startGame's own comment on why a fresh session would
      // otherwise always start counting from 0) — needed here too, not
      // just in playReveal below, so a session that itself scores (a
      // reveal that just happened to be chained straight into this aim
      // screen, see main.js) still has the right baseline for its own
      // local win-check/scoreboard.
      weekStartScoreA: week.scoreA, weekStartScoreB: week.scoreB,
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
      // No weekPointStart here — a reveal never shows the match-intro
      // huddle/sting, regardless of team, score, or whether this happens to
      // be this player's first look at the point (see startGame's own
      // comment: entering a point and watching a reveal are different
      // things — only the former gets the ceremony).
      weekStartScoreA: week.scoreA, weekStartScoreB: week.scoreB,
      matchConfig: week.config,
      vibe: week.game,
      // `manche` rides along on the resolved result (not just
      // scoreA/scoreB/scoredTeam/matchOver) so the caller can report the
      // exact same shot data back to party/weekArbiter.js's completeRound
      // without recomputing the team-relative -> A/B mapping itself (see
      // revealToManche above) — main.js's playWeekReveal does exactly
      // that. boardSnapshot: same freeze-frame idea as playSingleShot's own
      // (captured right before stopGame(), same reason — main.js shows this
      // as the background behind its lightweight spinner while completeRound
      // round-trips and, if the match continues, the next aim session warms
      // up, instead of a full black cut).
      onMancheSettled: (result) => {
        const boardSnapshot = document.getElementById('stage').toDataURL();
        stopGame();
        resolve({ ...result, manche, boardSnapshot });
      },
    });
  });
}
