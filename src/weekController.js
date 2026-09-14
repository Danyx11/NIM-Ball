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
// onSessionStart(stopGame) (optional): handed the engine's own teardown
// function the instant it exists — synchronously, before this promise ever
// resolves. The engine is alive (rAF loop running, canvas.dataset.nbStarted
// set) for the player's whole aim turn, including any time spent looking at
// main.js's own "Play" card before tapping it — a window this promise does
// NOT resolve during. Without this hook, nothing outside this closure has a
// way to tear that down if the player quits mid-turn instead of committing
// a shot (main.js's activeStopGame stayed null for WEEK the whole time,
// which is the exact softlock this hook exists to close — see CLAUDE.md's
// WEEK section / the architecture recon). main.js assigns activeStopGame
// from this callback, the same variable every other mode's own startGame()
// call already feeds directly.
export function playSingleShot(week, engineOpts, onSessionStart) {
  return new Promise((resolve) => {
    // A singleShotTeam session hands back a session object rather than the
    // bare teardown function every other mode gets (see game.js's own return
    // statement). This half of WEEK only ever needs the teardown, so it takes
    // just that — and, like playReveal below, never lets the object itself
    // travel any further: main.js only ever sees a plain callable.
    const { stop: stopGame } = startGame({
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
    onSessionStart?.(stopGame);
  });
}

// "Watch the reveal" — both shots are already known (week.reveal). Plays
// them out with completely normal pacing/physics/rendering (reusing
// launchSimulation() exactly as the AI branch does) and resolves once the
// manche has fully settled, including — if it scored — the player
// dismissing the result panel.
//
// Stage 2 of the WEEK persistent-session migration: unlike playSingleShot
// above, this no longer tears its own session down on the way out. The
// engine stays alive, parked on the settled board, and the resolved result
// carries a `session` handle the caller uses to decide what happens to it:
// either carry it straight into the next aim turn (session.aimNextShot) or
// end it (session.stopGame, for a completed match or an error). This is the
// one boundary Stage 2 covers — the "I submitted, now I wait" pause is
// still a full teardown/rebuild (that's Stage 4).
// onSessionStart(stopGame): see playSingleShot's own comment — same reason,
// same contract. A reveal session is just as alive (and just as quittable
// mid-flight, e.g. from the "Watch the reveal" card before it's tapped, or
// while the manche is still playing out) as an aim session is.
export function playReveal(week, engineOpts, onSessionStart) {
  const manche = revealToManche(week);
  return new Promise((resolve) => {
    // Set only while session.aimNextShot() below is waiting on the next
    // turn's commit — see onShotCommitted.
    let resolveShot = null;
    // The engine's own session object (Stage 3, see game.js's return
    // statement): `stop` is the same bare teardown every other mode gets,
    // `resumeAim` is what carries this session past the settled reveal into
    // the next aim turn. Both stay inside this file — the handle handed up
    // to main.js below is this file's own, built from them.
    const { stop: stopGame, resumeAim } = startGame({
      ...engineOpts,
      externalManche: manche,
      // Stage 2: this session outlives the reveal, so it has to be a full
      // WEEK session from the start rather than a reveal-only one.
      // singleShotTeam is what makes beginAimPhase() route the turn that
      // follows into 'lanAim' — without it, that same call lands in the
      // Pass & Play hand-off mask instead (see its own
      // `!net && !aiTeam && !singleShotTeam` branch) — and what makes
      // onValidate() accept that turn's PLAY at all. Completely inert while
      // the reveal itself plays out: aimingTeam()/sweepViewTeam() both gate
      // on phase, which is never an aiming one before resumeAim() runs.
      singleShotTeam: week.team,
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
      // revealToManche above) — main.js's playWeekReveal does exactly that.
      // The next turn's own commit, played on this same session — resolves
      // session.aimNextShot() below with exactly the shape playSingleShot
      // resolves with, so the caller's post-commit path is shared verbatim.
      onShotCommitted: (stones, sweep) => {
        const boardSnapshot = document.getElementById('stage').toDataURL();
        const done = resolveShot;
        resolveShot = null;
        done?.({ stones, sweep, boardSnapshot });
      },
      onMancheSettled: (result) => {
        // boardSnapshot: same freeze-frame idea as playSingleShot's own —
        // main.js shows it as the background behind its lightweight spinner
        // while completeRound round-trips, instead of a full black cut.
        const boardSnapshot = document.getElementById('stage').toDataURL();
        // No stopGame() here anymore — see this function's own header
        // comment. The engine is parked on the settled board (game.js's
        // 'mancheHold' phase) until the caller picks one of the two below.
        resolve({
          ...result,
          manche,
          boardSnapshot,
          // This file's own handle, built from the engine's session object
          // (destructured above) — deliberately a different, smaller shape:
          // main.js has no business resuming an aim phase without also
          // waiting on the shot it produces, so those two are one call here.
          session: {
            stop: stopGame,
            // Starts the next aim turn on this live engine and resolves with
            // that turn's committed shot: playSingleShot's own aim half,
            // minus the startGame()/stopGame() that used to bracket it. No
            // board reconstruction, no re-seeded score, no second intro —
            // the board is simply still there (see game.js's resumeAim).
            aimNextShot() {
              return new Promise((res) => { resolveShot = res; resumeAim(); });
            },
          },
        });
      },
    });
    onSessionStart?.(stopGame);
  });
}
