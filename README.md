# NIM Ball

Mini app soccer game for Nimiq — teams shoot orb-shaped pieces at each other's goal, pinball-style, then a physics pass resolves the round.

## Project structure

```
index.html        Vite entry (game markup)
scripts/
  bake_arena.py   Python/Pillow script that builds public/arena/frame.webp from
                  design/arena/ source layers
src/
  main.js         bootstraps the animated background + game + Nimiq Mini App SDK connection
  background.js   wires the animated constellation background + logo to their assets
  game.js         canvas game: physics, rendering, input, turn flow
  audio.js        WebAudio SFX + background ambience loop manager
  identicons.js   thin wrapper around @nimiq/identicons
  nimiq.js        thin wrapper around @nimiq/mini-app-sdk
  style.css       game styles + the animated background
public/           only assets actually loaded by the game (kept lean — this ships)
  identicons/     team bubble avatar art, rendered on each glob
  arena/          illustrated arena background (generated, see scripts/bake_arena.py)
                  + PLAY button sprite
  bg/             animated constellation background + logo
  ball/           ball sprite
  sfx/            sound effects + background ambience
design/           source art not wired into the game (drafts, superseded
                  versions, raw generations) — kept for reference, never
                  imported by code, safe to ignore for gameplay work
design-lab/       local-only sandbox (gitignored) for testing visual layers before
                  they're baked/ported into design/ + public/ + src/
physics-lab/      local-only sandbox (gitignored) for prototyping physics tuning
prototypes/       earlier single-file HTML explorations, kept for reference
```

## Running locally

Requires Node.js 22+.

```bash
npm install
npm run dev -- --host
```

Open the printed `localhost` URL in a browser to play. The Nimiq connection step in `main.js` fails silently outside Nimiq Pay (logged to the console) — the game itself doesn't require it.

## Testing inside Nimiq Pay

1. Run `npm run dev -- --host` and note the **Network** URL (e.g. `http://192.168.1.42:5173`).
2. Make sure your phone and dev machine share the same Wi-Fi.
3. In Nimiq Pay: **Mini Apps** → enter that URL in the Custom URL field.

See the [Nimiq Mini Apps docs](https://nimiq.dev/mini-apps/overview) for the full provider API (accounts, signing, payments, staking) exposed via `src/nimiq.js`.

## Building

```bash
npm run build
```

Outputs to `dist/`.

## Regenerating the arena background

`public/arena/frame.webp` is generated from source layers in `design/arena/`, not hand-painted as one flat image:

```bash
pip install pillow
python3 scripts/bake_arena.py
```

Only needed after re-exporting the `design/arena/xcf-*.png` layers (see the script's docstring) — not part of the regular npm build.
