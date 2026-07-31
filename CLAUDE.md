# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev -- --host   # dev server, --host exposes it on the LAN for phone testing
npm run build            # outputs to dist/
npm run preview          # serve the production build locally
```

Requires Node.js 22+. There is no test suite and no lint script configured.

### Testing inside Nimiq Pay

The game must run standalone in a plain desktop browser (the Nimiq connection in `src/main.js` fails silently outside Nimiq Pay, logged to console only). To test the real Mini App integration: run `npm run dev -- --host`, note the printed Network URL, and enter it under **Mini Apps → Custom URL** in Nimiq Pay on a phone on the same Wi-Fi. See the [Nimiq Mini Apps docs](https://nimiq.dev/mini-apps/overview) for the provider API surfaced through `src/nimiq.js`.

### LAN mode

Two players on separate machines on the same wifi can play a "Duel LAN" instead of same-device pass-and-play, via a tiny relay server — no external hosting, no domain, just a local IP.

**Simple path — one command, one link:** `npm run duel` (starts `server/duel-server.js`) runs the Vite dev server and the WebSocket arbiter in a single process on one port, and prints a link like `http://192.168.1.28:5173/?duel`. Send that link to player 2 and open it yourself too — the `?duel` query param (handled in `src/main.js`) skips the mode-select/address-entry screens entirely and auto-connects both sides straight to the arbiter, so nobody types an address.

**Advanced path — two processes:** useful when iterating on code and you want the arbiter decoupled from the dev server. `npm run lan-server` (starts `server/lan-server.js`) prints its own LAN address, e.g. `ws://192.168.1.23:8787`; separately run `npm run dev -- --host` as usual, both players open the dev server URL, pick "Duel LAN" in the mode-select screen, and enter that printed `ws://` address (the address field defaults to the current page's own host, which is only correct for the simple path above — edit it for this flow).

Both paths share the same arbiter logic (`server/arbiter.js`, mounted at the fixed `/duel-ws` path so it doesn't collide with Vite's own HMR websocket when sharing a port — `src/net.js`'s `connectLan()` appends that path automatically, so addresses are always typed/printed without it). The arbiter is a pure relay, not a physics authority: it assigns the first connection team A and the second team B, then relays each round's chosen shot vectors and, once both sides have submitted, broadcasts both to both clients (`{type:'launch', shotsA, shotsB}`). Each client then runs the exact same deterministic `physicsStep()` locally from those shots. No matchmaking, multiple concurrent games, or reconnection handling — single in-memory 2-player session, by design (this exists for local testing, not the public competitive mode).

## Architecture

This is a 2-player physics game rendered on a single `<canvas>`, either same-device pass-and-play or networked over LAN (see "LAN mode" above). Almost all logic lives in one file, `src/game.js` (~1200 lines), structured as one big `startGame()` closure with no external state/rendering libraries — it's plain Canvas2D + `requestAnimationFrame`. `src/main.js` bootstraps the animated background (`initBackground()`), drives the mode-select/LAN-lobby flow, calls `startGame()` (plain for local mode, or `startGame({ net, myTeam })` once a LAN opponent is connected), and separately fires off the optional Nimiq Pay handshake; `src/net.js` is the WebSocket client wrapper for LAN mode (talks to `server/lan-server.js`); `src/nimiq.js` is a thin, non-blocking wrapper around `@nimiq/mini-app-sdk`; `src/audio.js` is a WebAudio SFX/ambience manager; `src/identicons.js` wraps `@nimiq/identicons`.

The canvas itself is a fixed-size "board" (`#stage-wrap`, CSS-sized to fit within the viewport on both axes, see `min(92vw, 92vh * 1200/905, 1100px)` in `style.css`) floating over a full-viewport animated starfield background — not edge-to-edge like the original V1 layout. That background (`#bg-stage` in `index.html`, wired up by `src/background.js`) is a separate DOM/CSS layer behind the canvas, not drawn on it: 4 mirrored constellation images cross-fade on a 160s loop with CSS-keyframed twinkle/pulse-dot overlays, ported from `design-lab/design_handoff_scintillement_constellation/`. Keeping it off the Canvas2D render loop avoids repainting large images every frame for a purely decorative effect.

### Turn/phase state machine

A single `phase` variable drives everything (input handling, rendering, physics): `start → aimA → aimB → pending → sim → goal → gameover`. Team A drags & releases its 3 "stones" to set pending velocities, then team B does the same, then a fixed `PRE_SIM_DELAY` beat, then `sim` runs `physicsStep()` every frame until everything settles, resolving into a goal/round-end or back to `aimA`. Goals and wipeouts (all 3 stones of one team fallen into the goal) both score.

LAN mode swaps in two more phases instead of the `aimA`/`aimB` pair: `lanAim` (both clients sit here at once — a client only ever reads/drags `entities[myTeam]`, see `currentTeamStones`/`isAimingPhase` in `game.js`) and `lanWait` (local shot already sent, waiting on `net.onLaunch`, which fires once the arbiter has both sides' shots and applies both teams' velocities before dropping into `pending → sim` exactly like the local flow). `firstAimPhase()` picks which pair a fresh round starts in, based on whether `net` was passed to `startGame()`.

### Physics

`physicsStep()` is a self-contained fixed-step simulator: integrates position, applies per-entity friction (stones vs. the ball have different friction/mass constants), does wall/goal-mouth collision, and pairwise circle-circle collision (`resolveCollision`) with restitution. Constants near the top of the file (`FRICTION`, `WALL_RESTITUTION`, `POWER_SCALE`, `MAX_DRAG`, etc.) were hand-calibrated against real "Globulos" reference footage — treat them as tuned values, not arbitrary defaults, and change with care/comments explaining the feel being targeted.

Squash-and-stretch deformation (`triggerSquish`/`drawSquished`) and contact shadows are driven off collision normals and are shared logic between stones and the ball — see the block comments at each function for the easing rationale before changing timing.

### Coordinate system tied to the artwork

The playing field bounds (`FX0/FY0/FX1/FY1`, goal mouth `GY0/GY1`) are pixel coordinates hand-measured against the illustrated arena background (`public/arena/frame.webp`, 1200x905, 1:1 with the canvas's logical size). The center line, hexagon, goal-crease lines, wood frame, goal posts, and the wood scoreboard plaque are all baked directly into that one image — not drawn at runtime — so moving the physics bounds means re-checking alignment against the art, not just adjusting numbers. Same pattern for the score digit/icon positions and the PLAY button's pixel bounds (`SCORE_SLOT_*`, `PLAY_CAP_*`), which are positioned against fixed pixel coordinates measured relative to that same 1200x905 space.

`frame.webp` itself is generated, not hand-painted as one flat image: `scripts/bake_arena.py` composites it from `design/arena/xcf-*.png` — flattened layer exports pulled straight out of the validated `design-lab/nimball-designlab-current.xcf` session file (via the `gimpformats` PyPI package, since neither Pillow nor GIMP itself reads `.xcf`) — placed with one uniform scale + origin shift onto the fixed `FX0..FY1` physics rect. Composite the layers in GIMP first and re-export any that changed to `design/arena/xcf-*.png` (see the script's docstring for which named layers/groups to pull and their `.xcf`-space offsets), then re-run `python3 scripts/bake_arena.py` (needs Pillow, `pip install pillow`). An earlier version of this script instead hand-reconstructed the ice crop/alignment/tail-shadow math from individual pre-blend assets — it drifted from what was actually validated in the lab (stale corner cropping, a stale pre-goal-notch tail-shadow source); compositing the lab's own already-correct flattened layers avoids re-deriving that math at all.

### Sprite baking pipeline

Team avatars are composited once at load time, not per frame: `downscaleToFit()` does a proper box-filtered halving-step shrink (avoiding the aliasing/fringing `drawImage`'s bilinear scaler produces on a big downscale), and `bakeBubble()` draws the team's bubble art (`bubble-v4-navy/gold.webp` — a solid embossed ring + hex floor baked into the art, no punched-out alpha window) then draws the identicon on top, clipped to that hex (`HEX` fractions, measured off the art). A subtle cool-tint blend (desaturate/contrast/brightness filter + soft-light overlay, `BUBBLE_BLEND`) is baked in on top so the glossy identicon render sits inside the flatter, painted ice scene instead of reading as a pasted-on sticker — ported from design-lab's "intégration" slider. Team B's identicon is mirrored at load so it faces the ball at kickoff. All sprites are baked at 2x their on-screen draw size for crisp rotation.

### Replay / ticket points

Vocabulary: a **manche** is one aim+reveal exchange (both teams drag & release, then `physicsStep()` plays it out); a **point** is every manche that leads up to one scored point, whether by goal or wipeout (what the phase machine's `round` counter already tracked before this feature existed); a **match** is the whole game. This maps directly onto the existing state machine (see "Turn/phase state machine" above) — no new gameplay concept, just a name for what was already there.

Because physics is fully deterministic given the same input velocities (already relied on by LAN mode — see `net.onLaunch` above), a point is replayable from nothing more than the `{vx,vy,used}×3` shot vectors both teams committed each manche, plus any sweep placement. `src/recorder.js` captures exactly that during a live match — `recordManche()` at each `launchSimulation()`/LAN `onLaunch`, `finishPoint()` at each `onGoal()` — building up a `points[]` array with zero effect on gameplay itself (purely a side-channel tally, same spirit as the existing ticket stats in `showVictory()`).

`src/replay.js` packs a point into a small binary blob (int16-quantized velocities/sweep, well within the precision a drag gesture has anyway) and base64url-encodes it — a whole point is typically under 100 bytes, comfortably inside a single QR code even with a few manches. `src/ticket.js`'s `renderTicket()` bakes up to `MAX_POINTS_ON_TICKET` (5) of these as clickable QR tiles directly onto the ticket image, in a fixed-position layout (`pointTileRect()`) — fixed so that `decodePointsFromTicketImage()` can later normalize any uploaded ticket to the same canvas size and crop+decode each tile individually. This sidesteps needing general multi-QR-in-one-image detection (most lightweight QR readers, jsQR included, only find one code per scan): since the layout is ours and known in advance, cropping known rects and decoding each is enough. A full match (potentially dozens of points) doesn't fit reliably in one QR — the ticket intentionally shows only its most recent points (or all of them, if ≤5), not a "whole match" QR.

Two ways into a replay, both bypassing `#modeOverlay` (see `main.js`'s `?duel` magic link for the existing precedent this follows): clicking/scanning a single point's QR (`?replay=<point>` in the URL) jumps straight into replaying that one point; the "Replay" mode tile instead opens a file-drop/upload dialog for a saved ticket image, decodes however many of its point QR tiles are present, and replays them all in sequence.

Playback itself is `startGame({ replayPoints })`: `beginAimPhase()` branches to a `'replayAim'` phase (deliberately excluded from `isAimingPhase()` — no drag ever applies) that auto-fills `pendingVx/Vy` from the next recorded manche and falls through the exact same `pending`→`sim` path a human shot would, via `maybeAdvanceReplay()`. Pausing only holds back the *next* manche from auto-starting — a shot already mid-flight always finishes normally. `onGoal()` gets one small branch for replay mode: instead of the live `WIN_SCORE` check, "end of replay" is simply "we've played through the last recorded point," advancing to `showReplayEndTicket()` (same ticket visual as a live win, but "Revoir" instead of "Rejouer", no save/share action). A custom bottom playback bar (`#replayBar` — play/pause, a scrubber with a marker per point, an exit icon, plus a YouTube-style thumbnail per point) drives which point plays via `jumpToPoint()`; it's deliberately not the arcade `#toolbar`, which stays hidden throughout replay.

## Project structure

```
index.html        Vite entry (game markup: bg-stage + canvas + mode-select/start/ready overlays)
scripts/
  bake_arena.py   Python/Pillow build script: composites design/arena/ source layers
                  into public/arena/frame.webp (see Coordinate system section above)
server/
  duel-server.js    one-command LAN flow: Vite dev middleware + the arbiter on one port,
                    run via `npm run duel` (see "LAN mode" above)
  lan-server.js     standalone arbiter for the advanced two-process flow, run via
                    `npm run lan-server` — neither server file is part of the browser build
  arbiter.js        WebSocket arbiter logic shared by both servers above
  lan-addresses.js  small os.networkInterfaces() helper shared by both servers
src/
  main.js         bootstraps the animated background + game, drives mode-select/LAN-lobby
                  flow (including the `?duel` magic-link auto-connect), + Nimiq Mini App
                  SDK connection
  background.js   wires the animated constellation background + logo to their asset URLs
  game.js         canvas game: physics, rendering, input, turn flow (see Architecture above)
  net.js          WebSocket client wrapper for LAN mode, talks to server/arbiter.js
  audio.js        WebAudio SFX + background ambience loop manager
  identicons.js   thin wrapper around @nimiq/identicons
  nimiq.js        thin wrapper around @nimiq/mini-app-sdk
  ticket.js       renders the shareable end-of-match "ticket" image (see showVictory in game.js)
  recorder.js     records manche/point shot data during a live match (see Replay section above)
  replay.js       replay point encode/decode, ticket QR layout, ?replay= link/image parsing
  style.css       game styles + the ported constellation background animation
public/           only assets actually loaded by the game (kept lean — this ships)
  identicons/     team bubble avatar art, baked into bubble sprites at load
  arena/          illustrated arena background (frame.webp, generated — see scripts/bake_arena.py)
                  + PLAY button cap sprite
  bg/             animated constellation background images + logo (see src/background.js)
  ball/           ball sprite
  ticket/         static hero-band art baked into every ticket (see src/ticket.js)
  sfx/            SFX clips + background ambience loop (see src/audio.js)
design/           source art not wired into the game (drafts, superseded versions,
                  raw generations) — never imported by code, safe to ignore for gameplay work.
                  design/arena, design/identicons and design/bg hold the specific source
                  layers scripts/bake_arena.py and the public/ assets above were built from.
design-lab/       local-only Vite sandbox (gitignored) for testing new visual layers against
                  real assets before they're baked/ported into design/ + public/ + src/ — see
                  the lab-to-main workflow below
physics-lab/      local-only sandbox (gitignored) for prototyping physics tuning before
                  porting fixes into src/game.js
prototypes/       earlier single-file HTML explorations kept for reference/diffing;
                  none are part of the build (see prototypes/README.md)
```

## Lab-to-main workflow

`design-lab/` and `physics-lab/` are local scratch space (gitignored, never pushed) for trying out visual/physics changes against real assets without touching the shipped game. Migrate one validated piece at a time, not a wholesale copy:

1. Prototype and validate the change in the lab.
2. Port only the specific proven piece into `src/` — physics fixes go straight into `game.js`'s constants/functions (see the physics-lab-ported comments already in `physicsStep`/`resolveCollision` for the pattern); visual layers get their winning source art copied into `design/` (so it survives even if the lab folder is cleared) and either baked into `public/arena/frame.webp` via `scripts/bake_arena.py` (static, physics-box-aligned art) or wired up as their own asset + code path (animated/interactive pieces, like the constellation background or bubble sprites).
3. Verify in the browser (dev server), then commit the migration on its own, separate from unrelated changes.

## Dev-only debug hook

When running via `npm run dev`, `window.__nb` exposes `{ entities(), phase(), step() }` for inspecting/advancing physics state from the browser console (guarded by `import.meta.env.DEV`, stripped from production builds).
