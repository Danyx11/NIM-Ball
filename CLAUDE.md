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

## Architecture

This is a 2-player, same-device, turn-based physics game rendered on a single `<canvas>`. Almost all logic lives in one file, `src/game.js` (~840 lines), structured as one big `startGame()` closure with no external state/rendering libraries — it's plain Canvas2D + `requestAnimationFrame`. `src/main.js` just calls `startGame()` and separately fires off the optional Nimiq Pay handshake; `src/nimiq.js` is a thin, non-blocking wrapper around `@nimiq/mini-app-sdk`.

### Turn/phase state machine

A single `phase` variable drives everything (input handling, rendering, physics): `start → aimA → aimB → pending → sim → goal → gameover`. Team A drags & releases its 3 "globs" to set pending velocities, then team B does the same, then a fixed `PRE_SIM_DELAY` beat, then `sim` runs `physicsStep()` every frame until everything settles, resolving into a goal/round-end or back to `aimA`. Goals and wipeouts (all 3 globs of one team fallen into the goal) both score.

### Physics

`physicsStep()` is a self-contained fixed-step simulator: integrates position, applies per-entity friction (globs vs. the ball have different friction/mass constants), does wall/goal-mouth collision, and pairwise circle-circle collision (`resolveCollision`) with restitution. Constants near the top of the file (`FRICTION`, `WALL_RESTITUTION`, `POWER_SCALE`, `MAX_DRAG`, etc.) were hand-calibrated against real "Globulos" reference footage — treat them as tuned values, not arbitrary defaults, and change with care/comments explaining the feel being targeted.

Squash-and-stretch deformation (`triggerSquish`/`drawSquished`) and contact shadows are driven off collision normals and are shared logic between globs and the ball — see the block comments at each function for the easing rationale before changing timing.

### Coordinate system tied to the artwork

The playing field bounds (`FX0/FY0/FX1/FY1`, goal mouth `GY0/GY1`) are pixel coordinates hand-measured against the illustrated arena background (`public/arena/frame.webp`). The center line, hexagon, and goal circles are baked directly into that image (re-centered on the same `CENTER_X`/`CY` the game computes), not drawn at runtime — so moving the physics bounds means re-checking alignment against the art, not just adjusting numbers. Same pattern for the score panel digit slots and the PLAY button's pixel bounds (`SCORE_SLOT_*`, `PLAY_CAP_*`), which are cropped/positioned against fixed pixel coordinates measured from that same source art.

### Sprite baking pipeline

Team avatars are composited once at load time, not per frame: `stripWhiteBackground()` removes the off-white matte behind each identicon by alpha distance, `downscaleToFit()` does a proper box-filtered halving-step shrink (avoiding the aliasing/fringing `drawImage`'s bilinear scaler produces on a big downscale), and `tryBakeBubble()` punches a hexagonal hole in the "module" ring art and composites the identicon behind it into one sprite per team (`bubbleSprites`). Team B's identicon is mirrored at load so it faces the ball at kickoff. All sprites are baked at 2x their on-screen draw size for crisp rotation.

## Project structure

```
index.html        Vite entry (game markup: canvas + start/ready overlays)
src/
  main.js         bootstraps the game + Nimiq Mini App SDK connection
  game.js         canvas game: physics, rendering, input, turn flow (see Architecture above)
  nimiq.js        thin wrapper around @nimiq/mini-app-sdk
  style.css       game styles
public/           only assets actually loaded by the game (kept lean — this ships)
  identicons/     team avatar images + module ring art, baked into bubble sprites at load
  arena/          illustrated arena background (frame.webp) + PLAY button cap sprite
  ball/           ball sprite
design/           source art not wired into the game (drafts, superseded versions,
                  raw generations) — never imported by code, safe to ignore for gameplay work
prototypes/       earlier single-file HTML explorations kept for reference/diffing;
                  none are part of the build (see prototypes/README.md)
```

## Dev-only debug hook

When running via `npm run dev`, `window.__nb` exposes `{ entities(), phase(), step() }` for inspecting/advancing physics state from the browser console (guarded by `import.meta.env.DEV`, stripped from production builds).
