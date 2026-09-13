# Nim-Curl

A 2-player physics game for Nimiq, played on a single `<canvas>`. Two teams flick weighted stones across an illustrated ice arena; a deterministic physics pass then resolves the exchange.

Two **vibes** share the same engine:

- **NimiCurl** (hockey) — there's a ball, and you score by pushing it into the opponent's goal.
- **Pure Curling** — no ball; whoever's stone sits closest to the centre when the point ends takes it.

Either vibe can be played with the **Classic** preset or with **Custom** rules (stones per team, points to win, turn time, summer/winter skin).

## Modes

| Mode | Players | Networked |
| --- | --- | --- |
| vs AI | 1 | no |
| Pass & Play | 2, one device | no |
| LIVE | 2, remote, synchronous | yes |
| WEEK | 2, remote, asynchronous (a match can span days) | yes |
| Replay | — | no |
| Duel LAN | 2, same Wi-Fi | dev only |

LIVE and WEEK run against a Cloudflare Worker (`party/`). Neither ever simulates physics server-side: the arbiter only relays each side's chosen shot vectors, and both clients run the identical deterministic simulation locally.

## Running locally

Requires Node.js 22+.

```bash
npm install
npm run dev -- --host
```

Open the printed `localhost` URL to play. The Nimiq connection step in `main.js` fails silently outside Nimiq Pay (logged to the console) — the game itself doesn't require it, and you can play as a guest.

## Testing inside Nimiq Pay

1. Run `npm run dev -- --host` and note the **Network** URL (e.g. `http://192.168.1.42:5173`).
2. Make sure your phone and dev machine share the same Wi-Fi.
3. In Nimiq Pay: **Mini Apps** → enter that URL in the Custom URL field.

See the [Nimiq Mini Apps docs](https://nimiq.dev/mini-apps/overview) for the full provider API exposed via `src/nimiq.js`.

## Two players on the same Wi-Fi (dev)

```bash
npm run duel
```

Prints a single link like `http://192.168.1.28:5173/?duel`. Open it yourself and send it to the other player — the `?duel` magic link skips mode-select entirely and connects both sides to the arbiter. This exists for local testing; the real remote modes are LIVE and WEEK.

## Building

```bash
npm run build     # outputs to dist/
npm run preview   # serve that build locally
```

Note that Vite copies `public/` into `dist/` **verbatim**. `.gitignore` keeps a file out of git, not out of the build — so nothing but shipped assets belongs in `public/`.

## Deploying the multiplayer backend

```bash
npm run wrangler:deploy
```

Config lives in `wrangler.jsonc`; `npm run wrangler:dev` runs it locally (needs a gitignored `.dev.vars`). See CLAUDE.md for the Durable Object layout and the Telegram secrets the stats collector needs.

## Regenerating art

`public/arena/frame.webp` and its siblings are generated from source layers in `design/arena/` by the scripts in `scripts/` (needs `pip install pillow`). The current arena is **3312x1896**; every physics bound in `game.js` is hand-measured against it.

> `scripts/archive/bake_arena.py` is the superseded V1 bake and must not be run — it would replace the arena with a 1200x905 image. It is hard-guarded to refuse, but don't reach for it. See the "Coordinate system tied to the artwork" section of CLAUDE.md for the pipeline that is current.

## Project layout

See [CLAUDE.md](./CLAUDE.md) for the full architecture notes, the turn/phase state machine, the LIVE/WEEK backend design, and the annotated directory tree.
