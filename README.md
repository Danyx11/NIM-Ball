# NIM Ball

Mini app soccer game for Nimiq — teams shoot orb-shaped pieces at each other's goal, pinball-style, then a physics pass resolves the round.

## Project structure

```
index.html        Vite entry (game markup)
src/
  main.js         bootstraps the game + Nimiq Mini App SDK connection
  game.js         canvas game: physics, rendering, input, turn flow
  nimiq.js        thin wrapper around @nimiq/mini-app-sdk
  style.css       game styles
public/           only assets actually loaded by the game (kept lean — this ships)
  identicons/     team avatar images, rendered on each glob
  arena/          illustrated arena background + PLAY button sprite
  ball/           ball sprite
design/           source art not wired into the game (drafts, superseded
                  versions, raw generations) — kept for reference, never
                  imported by code, safe to ignore for gameplay work
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
