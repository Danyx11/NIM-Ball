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

**Advanced path — two processes:** useful when iterating on code and you want the arbiter decoupled from the dev server. `npm run lan-server` (starts `server/lan-server.js`) prints its own LAN address, e.g. `ws://192.168.1.23:8787`; separately run `npm run dev -- --host` as usual.

Note that there is **no "Duel LAN" tile in mode-select any more** — the whole mode is reachable only through the `?duel` magic link above. The manual address-entry screen (`showLanJoinScreen` in `main.js`) still exists but is now only reached as the retry screen when a `?duel` connection fails; that's where you'd paste the `ws://` address for this two-process flow (the field defaults to the current page's own host, which is only correct for the simple path).

Both paths share the same arbiter logic (`server/arbiter.js`, mounted at the fixed `/duel-ws` path so it doesn't collide with Vite's own HMR websocket when sharing a port — `src/net.js`'s `connectLan()` appends that path automatically, so addresses are always typed/printed without it). The arbiter is a pure relay, not a physics authority: it assigns the first connection team A and the second team B, then relays each round's chosen shot vectors and, once both sides have submitted, broadcasts both to both clients (`{type:'launch', shotsA, shotsB}`). Each client then runs the exact same deterministic `physicsStep()` locally from those shots. No matchmaking, multiple concurrent games, or reconnection handling — single in-memory 2-player session, by design (this exists for local testing, not the public competitive mode).

### Production remote backend (`party/`)

LIVE and WEEK are backed by a Cloudflare Worker (`party/index.js`, deployed via `npm run wrangler:deploy` / `deploy-wrangler.sh`, config in `wrangler.jsonc`), not the LAN Node servers above. **Nine** Durable Object classes, each added as its own `wrangler.jsonc` migration (`v1`..`v8`) alongside the previous ones, never folded into them:

| Class | File | What it is |
|---|---|---|
| `Arbiter` | `party/arbiter.js` | LIVE — a straight partyserver port of `server/arbiter.js`, room name = the 4-char match code |
| `WeekArbiter` | `party/weekArbiter.js` | WEEK — async, wallet-address-keyed, state persisted to `ctx.storage` since a match can span days |
| `PlayerIndex` | `party/playerIndex.js` | one instance per wallet address: that player's active WEEK matches (active-match cap, "My Matches") + their Telegram notification link |
| `RadarCollector` | `party/radar.js` | daily play stats -> Telegram, see "NIM-Curl Radar" below |
| `LeagueSeason` | `party/leagueSeason.js` | League Beta season store, see "League Beta" below |
| `TelegramLink` | `party/telegramLink.js` | short-lived WEEK-notification linking tokens, see "WEEK Telegram turn notifications" below |
| `Partnership` | `party/partnership.js` | sponsor-week booking + banner storage, see "Partnership" below |
| `PrizeVault` | `party/prize.js` | NIM win payouts, see "NIM prizes" below |
| `AliasRegistry` | `party/aliases.js` | paid @alias claims, see "Alias registry" below |

Two `party/` files are plain modules, not Durable Objects: `party/leagueRating.js` (the pure Elo/LP/streak math + `isClassicMatchConfig`, shared by `Arbiter`/`WeekArbiter`/`LeagueSeason`) and `party/nimiqTx.js` (hand-built Nimiq transaction building/signing — the only thing in this codebase that can *send* NIM server-side, see `PrizeVault`).

Local dev: `npm run wrangler:dev` (needs `.dev.vars`, gitignored — see `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` already there for `Arbiter`'s desync alert). `Arbiter`'s own Durable Object instance is deliberately not persisted (`onStart` always starts blank) — see its own header comment.

### NIM-Curl Radar

A 4th Durable Object, `RadarCollector` (`party/radar.js`), collects daily play stats and reports them to Telegram — a personal ops tool, not a database. One fixed-name instance (`RADAR_ROOM_NAME`) for the whole game; state is a handful of small JSON docs in `ctx.storage` (one per Europe/Paris calendar day, plus a persistent `hash → firstSeenDate` wallet map — never raw addresses, see below).

**Event flow**: `Arbiter`/`WeekArbiter` call `RadarCollector` directly over Durable Object RPC (`getServerByName`, same-Worker binding call — this *is* the authentication for server→Radar events, there's no public endpoint that accepts match data). Hooked into transitions that are already naturally one-shot for gameplay reasons: LIVE's "both players connected" (`recordMatchStarted`) and a new client-sent `matchOver` message from `showVictory()` (`recordMatchCompleted`, guarded by an instance flag since `Arbiter` isn't persisted and both clients call it); WEEK's "B joins" (`recordMatchStarted`), `completeRound` reaching the win condition (`recordMatchCompleted`), and every `shot` (`recordPlayerActive` — lets a multi-day WEEK match count a player as active on each day they actually play without re-counting the match). LIVE's connect URL now carries an optional `?address=` (added by `src/net.js`'s `connectMatch`, sourced from `main.js`'s `hubAddress`) so LIVE gets the same wallet-or-guest identity WEEK already had.

**Scope — `mode` is exactly `'live' | 'week'`**: those are the only two real game *modes* (synchronous vs. asynchronous multiplayer), and the only two Radar knows about. Everything else is out of scope by construction:
- Alone / AI / Pass & Play are LOCAL experiences (no `net`, ever — see "Turn/phase state machine" above) and never reach the server, so there is nothing for Radar to hook into for them.
- **"Classic" is not a mode** — it's a ruleset/config preset (`src/matchConfig.js`'s `DEFAULT_MATCH_CONFIG`) that LIVE, WEEK, and Pass & Play can all be played with. It has no bearing on Radar's `mode` field and is never tracked as if it were a third mode.
- Guests count toward `matches` and a wallet-vs-guest connections line, never toward unique/new/returning players — there's no reliable, privacy-respecting stable id for a guest across matches.

**Report fields**: total matches (LIVE + WEEK), a completed count, unique players across LIVE + WEEK combined, new vs. returning wallets, matches/player, a wallet-vs-guest connections split, peak activity hour, per-mode breakdown (LIVE matches/active-players and WEEK matches/active-players — "active players" = unique wallets with activity in that mode that day), and a running "active now" gauge per mode. That gauge (`RadarCollector#activeCounts`, persisted, not a per-day figure) increments on `recordMatchStarted` and decrements on `recordMatchCompleted` — it's a best-effort upper bound, not an exact live count: neither WEEK's expiry/abandon paths (`party/weekArbiter.js`'s `onAlarm`/`'abandon'` handler) nor a LIVE room going quiet when a player just closes the tab currently notify Radar, so a match that's abandoned rather than finished stays counted as "active" indefinitely. Wiring those paths in too is a possible follow-up, not done in v1.

An **ALL-TIME** section reports since-the-beginning totals, never reset by the daily rollover: unique wallets ever seen (`Object.keys(this.wallets).length` — the same persistent map that drives new-vs-returning, so this needs no separate counter), cumulative guest match-slots (`this.cumulative.guestSlots`), and cumulative matches (`this.cumulative.matches`). Deliberately never summed together — a guest-slot count isn't a player count (guests have no identity to dedupe by), so adding it to the wallet figure would misrepresent it as one. Both cumulative counters live in the same dedup-guarded branch of `recordMatchStarted` as the per-day ones, so a duplicate/retried event can't inflate them either.

**Privacy**: wallet addresses are SHA-256 hashed with `RADAR_WALLET_SALT` before ever being stored — Radar only ever holds `hash → firstSeenDate`, never an address, and never posts one to Telegram. "New wallet" means "an address Radar has never seen before", not "a wallet created that day" — don't conflate the two.

**Trust model — addresses are not cryptographically verified.** `hubAddress` (`src/main.js`) is just whatever `src/nimiq.js`'s `chooseAddress()`/Nimiq Pay's `listAccounts()` returned and cached in `localStorage` — a plain string, never signed. It travels unmodified through `connectMatch(code, hubAddress)` (`src/net.js`) as a `?address=` query param and `party/arbiter.js`'s `onConnect` reads it straight off the URL with zero proof of wallet ownership (WEEK's `party/weekArbiter.js` has the exact same property — it already documents itself as trusting every client-sent field). Practical consequence: anyone who can open two connections to a LIVE room (or two WEEK addresses) can hand-craft any address string and inflate "new wallet"/"unique player" counts — Radar's identity signal is only as trustworthy as the client that reports it. This is an accepted v1 trade-off (no anti-cheat), not a bug; real verification would need wallet-signature auth wired into the connect handshake itself, which is out of scope here. **That same unverified address is no longer Radar-only**: League LP and the 10 NIM prizes both route off it, so read "NIM prizes" below before assuming anything here is stats-only.

**Telegram**: `/radar` and `/radar yesterday` arrive via a webhook (`POST /radar/telegram-webhook` on the same Worker), verified against `TELEGRAM_WEBHOOK_SECRET` (Telegram's `X-Telegram-Bot-Api-Secret-Token` header) plus a `TELEGRAM_CHAT_ID` match. The automatic daily report is driven by a Cloudflare Cron Trigger (`wrangler.jsonc`'s `triggers.crons`, every 15 min) calling `RadarCollector#maybeSendDailyReport`, which re-checks the current Europe/Paris date on every tick (DST-safe) and sends at most once per day, for whichever day just ended.

**Setup**: after deploying, set the four secrets Radar needs (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` may already be set for the desync alert):
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RADAR_WALLET_SALT          # any long random string, e.g. `openssl rand -hex 24`
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET    # any long random string, must match the setWebhook call below
```
Then register the webhook once (replace the two placeholders):
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://nim-ball.nim-ball.workers.dev/radar/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### WEEK Telegram turn notifications

A player can opt into a private Telegram DM ("🥌 Your turn / Your WEEK match is waiting for you.") the moment the server decides their WEEK turn is ready — entry point is the 🔔 next to My Matches' own header (`index.html`'s `#joinCodeOverlay`, `src/main.js`'s `renderNotifPanel`/`refreshNotifStatus`/`startTelegramConnect`). Uses a **separate** Telegram bot from the one above (that one stays a personal ops tool — Radar reports + the LIVE desync alert — and is never DM'd out to players); this bot only ever sends turn-ready DMs and never needs to be looked at.

Two Durable Object classes, both new alongside the five existing ones (`wrangler.jsonc`'s `v5` migration):
- **`PlayerIndex`** (`party/playerIndex.js`, already the per-wallet-address DO backing My Matches) gained a `telegram: { chatId, connectedAt, notifyTurnEnabled }` field — the permanent association, since this instance is already "this player's own stuff". `setTelegram`/`clearTelegram`/`setNotifyEnabled` are called by RPC (from `TelegramLink` and `WeekArbiter` respectively); `notifyTurnReady({ matchId })` is the notification entry point, a no-op unless `telegram.chatId` and `notifyTurnEnabled` are both set. Its `onRequest` grew three routes alongside the two pre-existing ones (`GET` -> matches dict, `DELETE ?code=` -> remove one match), all gated behind a `telegram` query param so the originals are untouched: `GET ?telegram=1` (status), `POST ?telegram=toggle` (the switch), `DELETE ?telegram=1` (disconnect — clears the association only, never touches the Telegram conversation itself, the Nimiq identity, or any match).
- **`TelegramLink`** (`party/telegramLink.js`) is a single fixed-name instance (same pattern as `RadarCollector`/`LeagueSeason`) holding only short-lived (10 min), single-use linking tokens — `token -> address`, deleted on first use regardless of outcome. It exists purely to solve linking's bootstrap problem: the deep-link flow deliberately never puts the wallet address in the Telegram URL (an opaque random token is the only thing exposed), so the webhook — which only ever learns a Telegram `chat.id` — needs *something* global to resolve that token back to an address before it can hand off to that address's own `PlayerIndex`.

**Linking flow**: client (already has `hubAddress`, same "no auth beyond knowing the address" trust model as every other WEEK endpoint — see `party/playerIndex.js`'s own comment) does `POST /parties/telegram-link/start?address=<addr>` → gets `{ token }` → opens `https://t.me/<bot>?start=<token>`. Telegram POSTs the update to `/notify/telegram-webhook` (`party/index.js`'s `handleNotifyWebhook`, verified against its own `TELEGRAM_NOTIFY_WEBHOOK_SECRET` — a **different** secret from Radar's `TELEGRAM_WEBHOOK_SECRET`, on a different bot); only a well-formed `/start <token>` is ever acted on, from any chat id (unlike Radar's webhook, which only accepts commands from its one fixed admin `TELEGRAM_CHAT_ID` — this one has no such allowlist by design, since the whole point is previously-unknown chats reaching it). The webhook resolves the token via `TelegramLink#completeLink`, which RPCs `PlayerIndex#setTelegram` (notifications start **ON**) and sends a short confirmation DM.

**Trigger seam** (`party/weekArbiter.js`'s `notifyTurnReady(address, matchId)`, same RPC shape as `radarNotify`/`leagueNotify`): called from exactly two places in `onMessage`, both already one-shot-guarded by the same persisted-state checks that make the surrounding mutation itself impossible to double-run (a client retry/reconnect/DO cold-start all fall into an early `return` before ever reaching these calls — see that method's own comment, same reasoning `radarNotify` already documents for Radar) — no separate idempotency flag needed:
- in `'shot'`, right after `pendingShots[team]` is set — notifies the OTHER team (their aim, or their reveal if this was the second shot).
- in `'completeRound'`'s `bothIn` branch, right after a manche actually resolves — notifies the OTHER team's now-ready reveal, whether or not this manche also ends the match (deliberately placed inside that branch, not the sibling `else if` where a team belatedly acks an already-resolved reveal — that changes nothing for the other side).

**Setup** (separate from Radar's bot/secrets above): create the notifications bot via [@BotFather](https://t.me/BotFather), then:
```bash
npx wrangler secret put TELEGRAM_NOTIFY_BOT_TOKEN
npx wrangler secret put TELEGRAM_NOTIFY_WEBHOOK_SECRET   # any long random string, must match the setWebhook call below
```
```bash
curl "https://api.telegram.org/bot<TELEGRAM_NOTIFY_BOT_TOKEN>/setWebhook?url=https://nim-ball.nim-ball.workers.dev/notify/telegram-webhook&secret_token=<TELEGRAM_NOTIFY_WEBHOOK_SECRET>"
```
Also set `src/net.js`'s `TELEGRAM_NOTIFY_BOT_USERNAME` to the real `@BotFather` username (a public identifier, not a secret — needed client-side to build the deep link) and redeploy the frontend.

### League Beta

An ongoing Rating/LP/streak ladder over LIVE and WEEK — no end date (there used to be a `SEASON_START_UTC`/`SEASON_END_UTC` pair; both were dead, never read anywhere, and have been removed rather than left as a stale "this ends on X" signal). Two files, deliberately split:

- **`party/leagueRating.js`** — pure math, no Durable Object plumbing, no `this`, no storage: runs identically under plain `node`. (Its own header points at a `scripts/league-rating-check.mjs` sanity script — that file only ever existed on the `league-beta` branch and is **not** in this tree; the comment is stale, not a missing file to go looking for.) Holds the season constant `CURRENT_SEASON_ID = 'beta-2026'` (see its own comment — never rename this to "reflect" the ranking being ongoing now; it's a Durable Object room name, and renaming it would point at a fresh, empty instance and strand every League Point already earned in the old one), a compressed Elo (`STARTING_RATING = 100`, `RATING_SCALE = 40`, `K_FACTOR = 5` — the scale is 10x smaller than classic chess Elo *on purpose*, see the constants' own comments before retuning anything), and `isClassicMatchConfig()`, which both arbiters use as their eligibility gate.
- **`party/leagueSeason.js`** — one Durable Object per season, room name = `CURRENT_SEASON_ID`, holding every player's record and the full completed-match history. A genuinely new season (a deliberate reset, not a rebrand) would be bumping that constant: a fresh instance with clean storage, no migration.

Reached two ways, same split as `PlayerIndex`: Durable Object RPC (`recordMatchCompleted`) from `Arbiter`/`WeekArbiter`, and a plain HTTP `GET` from the browser for the League panel and the home-screen ranking ticker (`src/main.js` via `src/net.js`'s `fetchLeagueStats`/`fetchLeagueLeaderboard`/`fetchLeagueWeeklyLeaderboard`).

A match only counts for League if **all** of: both players actually connected, both reported a real wallet address (guests can't be ranked — same "no stable privacy-respecting id for a guest" reasoning as Radar), and it was played on the exact Classic preset. Those guards live in the *callers* (`party/arbiter.js`'s `matchOver` branch, `party/weekArbiter.js`'s `completeRound`), never in `LeagueSeason`, which trusts its RPC input completely and only adds idempotency on `leagueMatchId` (`live:<code>` / `week:<code>`, `:<n>` suffixed per rematch). The LP a match awarded comes back through the RPC's return value and is relayed to both clients as a `leagueResult` message — that's the only channel for it, since a plain `GET` returns season totals, not one match's delta.

### Partnership

Sponsor weeks: $5/week, paid in NIM, buys a banner shown in-game for that week.

- **`party/partnership.js`** (`Partnership` DO, fixed name `v1`) is the source of truth for week availability and the only class here that gates a real paid feature — so it explicitly does *not* follow the "the RPC boundary is the auth" pattern the rest of `party/` uses. `confirmPayment()` verifies the reported transaction against the real Nimiq chain via `NIMIQ_RPC_URL` (existence, `REQUIRED_CONFIRMATIONS`, sender, recipient, value, reuse) and against the NIM price **it itself locked in at `reserve()` time** — never a client-reported amount. Banners go to R2 (`PARTNERSHIP_BANNERS`, bucket `nim-ball-partnership-banners`, which must be created by hand before the binding resolves); `sniffImageType()` reads the real file signature rather than trusting `Content-Type`, so a renamed HTML/SVG can't get served as an image.
- **`src/partnership.js`** is the browser side: `PARTNERSHIP_PAYMENT_ADDRESS` (from `VITE_PARTNERSHIP_PAYMENT_ADDRESS`, see `.env.example`) plus the banner *read* path.

`weekId` is the Monday of an ISO week as a plain `YYYY-MM-DD` UTC date — not an ISO week number. `src/partnership.js`'s `currentPartnershipWeekId()` is a hand-kept duplicate of `party/partnership.js`'s `weekIdFor()` (separate bundles); they must agree exactly or every banner lookup 404s.

**Where the banner actually shows**: `loadSponsorBanner()` (`src/partnership.js`) resolves the current week's banner once per page load, to an `<img>` or to `null`. `null` — no sponsor this week, offline, anything — means "use the built-in Nimiq art", so the unsponsored path is exactly the behavior that shipped before sponsors existed. Two consumers share that one promise: the goal panel (`src/game.js`'s `resultPanelHtml`, falling back to `GOAL_SPONSOR_BANNER_SRC`) and the match ticket (`src/ticket.js`'s `renderTicket`, falling back to `BANNER_SRC`). The image is requested with `crossOrigin='anonymous'` because the ticket draws it into a canvas it then exports — the Worker's banner route sends `Access-Control-Allow-Origin: *` for exactly this.

### NIM prizes

`PrizeVault` (`party/prize.js`, fixed name `v1`) decides whether a just-finished match earns its winner **10 NIM**, and if so signs and broadcasts the payout itself with `party/nimiqTx.js` (hand-built because nothing else here could send NIM server-side — `Partnership`'s transfers are all *verified read-only*, signed by the player's own wallet). Needs the `PRIZE_WALLET_PRIVATE_KEY` secret; `wrangler.jsonc`'s plain `PRIZE_WALLET_ADDRESS` var is only a startup sanity check that the key derives to the expected address.

`evaluate()` is the whole public surface, idempotent per `matchId` (the same `live:`/`week:` ids League uses). Limits: `DAILY_BUDGET_LUNA` (1000 NIM/day), `MAX_WALLET_PAYOUTS_PER_DAY` (3), `PAIR_COOLDOWN_MS` (7 days for the same pair of addresses), no self-play.

**Trust model — read this before touching the eligibility path.** A LIVE prize is decided from two things the client controls: the `?address=` it connected with (see the trust note in "NIM-Curl Radar" above — never verified, never signed) and the `scoreA`/`scoreB` it puts in its own `matchOver` message. `Arbiter` runs no physics, so it cannot recompute either. The one guard it *can* apply is its own state: `this.mancheIndex` only ever increments when the arbiter itself relayed a `launch` after both teams' shots arrived, so `matchOver` with `mancheIndex === 0` is refused (`reason: 'not_played'`, still sent to both clients so `showVictory()` doesn't wait out its timeout). That raises the bar from "one forged message" to "forge a manche exchange first" — **it is a speed bump, not a fix.** Real protection needs wallet-signature auth in the connect handshake plus a server-derived score. WEEK does not share this weakness: `WeekArbiter` resolves rounds itself in `completeRound`, so its winner is server-derived.

### Alias registry

NimConnect — the third-party service NimiCurl used to read/claim `@handle`s from — shut down (2026-10). `AliasRegistry` (`party/aliases.js`, fixed name `v1`) replaces it with a small registry NimiCurl owns outright: a flat **30 NIM** one-time claim, paid to the same project wallet `Partnership` already collects into (`wrangler.jsonc`'s `PARTNERSHIP_PAYMENT_ADDRESS`, reused rather than a second payment-address var). Priced well above the old claim's network-fee-only cost on purpose, so squatting a pile of aliases isn't worth it even at today's low traffic. Permanent once paid, same guarantee the old on-chain claim gave — no renaming, no release of an already-confirmed alias.

Flow mirrors `Partnership`'s reserve → pay → confirm shape exactly (see "Partnership" above), minus the USD-pegged pricing and banner upload:
- `reserve({ alias, wallet })` locks the name to that wallet as `pending` — this IS the availability check (same as `Partnership.reserve()`), so there's no separate "is this taken" probe. It also locks in `expectedAmountLuna` on the row at this exact moment (same reasoning as `Partnership.reserve()`'s own `expectedAmountLuna`) — `confirmPayment()` below checks the real tx against THIS stored value, never the live `ALIAS_PRICE_LUNA` constant, so a reservation started before a price change (e.g. the 100 → 30 NIM drop) still confirms at the amount it actually quoted.
- `confirmPayment({ alias, wallet, paymentTx })` verifies the reported transaction against the real Nimiq chain (existence, confirmations, sender, recipient, exact value, reuse) — the exact same checks `Partnership.confirmPayment()` runs, duplicated rather than shared (every Durable Object file in `party/` stays independent on purpose, see that directory's own convention).

**A real incident drove two more guards, both in `reserve()`** (see conversation: a player's NIM left their wallet but the alias was never attributed). The original `reserve()` silently deleted-and-replaced a wallet's own still-pending row on every retry — harmless if the player never actually paid, but if they HAD paid and the dialog was then reopened/retried for any reason (reload, a second attempt, impatience) before `confirmPayment()` finished, that delete orphaned the only row the payment could ever be attributed to: `confirmPayment()` would later look up a row that either didn't exist or belonged to a different attempt, and refuse with `'not your pending reservation'`, money already gone. Fixed with:
- `CLAIM_LOCK_MS` (2 minutes): a wallet with an existing pending reservation gets `{ error: 'claim_in_progress' }` instead of having that reservation silently replaced, for as long as the lock holds. Only once `CLAIM_LOCK_MS` has elapsed with no confirmation is the old row presumed genuinely abandoned (never paid) and freed for a new attempt — same as the old behavior, just not instant.
- The `expectedAmountLuna` pinning above (a second, independent way the old code could orphan a payment: a reservation confirming after a price change).

The matching client-side half of that fix lives in `src/alias.js`'s `savePendingClaim`/`loadPendingClaim`/`clearPendingClaim`: the moment `sendNimPayment()` returns a real tx hash, it's written to `localStorage` (never in `?fakeAlias` mode — a fake hash could never resolve against the real server) before `confirmPayment()` is even called, so a reload/closed tab/crash between "payment sent" and "server confirmed" doesn't strand the hash in memory. `openClaimAliasDialog()` checks for one of these on open and resumes straight into `'confirming'` instead of starting a fresh (and, pre-fix, destructive) `reserve()`. `src/main.js`'s `'confirmFailed'` step classifies `confirmPayment()`'s error into fatal (an explicit allowlist — wrong amount/sender/recipient, tx already used, tx failed on-chain, or the reservation is gone; these can never succeed on retry, so the dialog clears the local record and stops rather than risking a second real payment) vs. everything else (treated as transient/retryable — deliberately fails open this way, since net.js's fetch wrapper surfaces an arbitrary error string on a network hiccup rather than a fixed value, and misclassifying that as fatal is exactly what would re-break this fix).

**A second real incident after the above shipped** (same root cause, two more gaps): the `'confirmFailed'` "waiting for confirmations" branch only ever re-checked on a manual "Check again" click, so a player who didn't come back to click it could sit indefinitely with NIM already sent and no path forward — `src/main.js` now auto-retries that branch every 5s (`claimAutoRetryTimer`, cleared at the top of every `renderClaimStep()` call so a step change can never leave a stale retry firing), the button stays only for an immediate manual check. Separately, `PENDING_TTL_MS` was still 15 minutes — too short: a real claim's full reserve→pay→confirm round trip (confirmations + RPC lag, worse before the auto-retry fix) took longer than that, so `sweepExpired()` deleted the row before it ever confirmed, orphaning an already-paid-for claim exactly like the first incident. Raised to 60 minutes, matching `src/alias.js`'s own `MAX_AGE_MS` so the client's resume window and the server's row lifetime agree.

## Architecture

This is a 2-player physics game rendered on a single `<canvas>`, playable locally (Pass & Play, vs AI) or against a remote opponent (LIVE, WEEK — see "Production remote backend" below; Duel LAN is a dev-only extra, see "LAN mode"). Almost all gameplay logic lives in one file, `src/game.js` (~7,500 lines), structured as one big `startGame()` closure with no external state/rendering libraries — it's plain Canvas2D + `requestAnimationFrame`.

`src/main.js` (~3,400 lines) owns essentially all DOM outside the canvas: the home/splash screen, the mode-select tree, the Classic/Custom settings screens, the LIVE and WEEK lobbies and panels, the identity pill, and the How To hub. It calls `startGame()` once a mode is picked, and separately fires off the optional Nimiq Pay handshake. `src/game.js` is meant to stay canvas-and-rules; the two exceptions that still build DOM inside the closure are the replay playback bar and the goal/victory result panels.

Supporting modules: `src/net.js` (WebSocket/fetch client for Duel LAN, LIVE and WEEK), `src/weekController.js` (WEEK orchestration on top of `startGame()`'s generic hooks), `src/ai.js` (vs-AI shot picking, hockey) / `src/aiCurling.js` (vs-AI shot picking, Pure Curling), `src/matchConfig.js` (Classic preset + Custom rules), `src/recorder.js` / `src/replay.js` / `src/ticket.js` (the replay + shareable-ticket chain), `src/howto.js` (tutorial step lists), `src/audio.js` (WebAudio SFX/ambience), `src/identicons.js` (`@nimiq/identicons`), `src/nimiq.js` (`@nimiq/mini-app-sdk` + Nimiq Hub wallet identity), `src/alias.js` (alias registry read/claim, see "Alias registry"), `src/partnership.js` (sponsor week ids + the active sponsor banner, see "Partnership"), `src/background.js`, `src/colors.js`, `src/settings.js`, `src/preload.js`.

### Vibes (hockey / curling)

"Vibe" is the top level of the mode-select tree and is **not** the same axis as mode: `hockey` (NimiCurl — there's a ball, you score in a goal) and `curling` (Pure Curling — no ball, closest stone to center after `curlingCycles` manches wins the point). It is passed into `startGame({ vibe })`, relayed to the other player by both remote backends, and branches about a dozen places in `game.js` (arena art, score digits, stone HP, the timer widget, ball rendering, scoring). Both vibes can be played with either the Classic preset or Custom rules.

### Layout

The canvas is a fixed-size "board" (`#stage-wrap`) inside `#game-card`, sized off `--card-w` / `--stable-vh` in `style.css` rather than a fixed aspect ratio in CSS. `main.js` detaches `#stage-wrap` (plus `#overlay`, `#modeOverlay`, `#replayUploadOverlay`, `#replayBar`, `#syncToast`) out from under `#scene`'s transform-scaled subtree at startup — see the long comment at that detachment block for why. Desktop additionally hosts the menu screens in `#menuStage`.

`src/background.js` only wires the logo and the home/mode-select backdrops (including the per-vibe swap). The animated constellation starfield that used to sit behind the board (`#bg-stage`) and the `#bg-nature`/`#fg-ombres` parallax layers are **both gone** — the V2 arena art occludes them, so they were unwired and their images removed from `public/`. The `#fg-stage` DOM and its CSS are deliberately left in place (`display:none`) in case a future skin goes back to a small inset board; source layers live in `design/bg/`.

### Turn/phase state machine

A single `phase` variable drives everything (input handling, rendering, physics). The local baseline is `start → matchIntro → aimA → aimB → pending → sim → straighten → goal → roundReset → gameover`. Team A drags & releases its stones (3 by default, `matchConfig.stonesPerTeam`) to set pending velocities, then team B does the same, then a fixed `PRE_SIM_DELAY` beat, then `sim` runs `physicsStep()` every frame until everything settles, resolving into a goal/round-end or back to `aimA`. Goals and wipeouts (all of one team's stones fallen into the goal) both score.

The full phase set is 16 values; besides those above, `lanAim` / `lanWait` (LIVE and WEEK, see below), `handoffA` / `handoffB` / `handoffWatch` (Pass & Play), `mancheRollback` (LIVE desync recovery) and `replayAim` (replay playback).

LAN mode swaps in two more phases instead of the `aimA`/`aimB` pair: `lanAim` (both clients sit here at once — a client only ever reads/drags `entities[myTeam]`, see `currentTeamStones`/`isAimingPhase` in `game.js`) and `lanWait` (local shot already sent, waiting on `net.onLaunch`, which fires once the arbiter has both sides' shots and applies both teams' velocities before dropping into `pending → sim` exactly like the local flow). `firstAimPhase()` picks which pair a fresh round starts in, based on whether `net` was passed to `startGame()`.

Pass & Play (two humans, one screen, no `net`/`aiTeam`) interleaves three more phases so nobody sees the board before their own turn or before the shared reveal: `handoffA` (before team A aims), `handoffB` (before team B aims, inserted by `onValidate()` in place of the immediate `aimA → aimB` flip), and `handoffWatch` (before the reveal, in place of the immediate `aimB → pending` flip — the `playLaunchEngine`/`scheduleGlideLeadIn`/`launchSimulation` sequence that used to fire right there now runs from `completeHandoff()` once this last mask lifts). Each is a full-rink opaque mask (`drawHandoffMask`/`startHandoff`/`updateHandoff`/`completeHandoff`, see their comments in `game.js`) with a "BLUE TEAM PLAY"/"YELLOW TEAM PLAY"/"WATCH" label, dismissed by a tap anywhere once fully opaque (gated at the top of `onPointerDown`) — deliberately excluded from `isAimingPhase()`, same as `replayAim`, so no drag/laser/turn-timer applies while one is up.

### Physics

`physicsStep()` is a self-contained fixed-step simulator: integrates position, applies per-entity friction (stones vs. the ball have different friction/mass constants), does wall/goal-mouth collision, and pairwise circle-circle collision (`resolveCollision`) with restitution. Constants near the top of the file (`FRICTION`, `WALL_RESTITUTION`, `POWER_SCALE`, `MAX_DRAG`, etc.) were hand-calibrated against real "Globulos" reference footage — treat them as tuned values, not arbitrary defaults, and change with care/comments explaining the feel being targeted.

Squash-and-stretch deformation (`triggerSquish`/`drawSquished`) and contact shadows are driven off collision normals and are shared logic between stones and the ball — see the block comments at each function for the easing rationale before changing timing.

### Coordinate system tied to the artwork

The canvas's logical coordinate space is **3312x1896** (`W`/`H` in `game.js`), 1:1 with the V2 arena art (`public/arena/frame.webp`, also 3312x1896 — the fal.ai upscale, see `ART_V2_SCALE`). The playing field bounds (`FX0 = 1086, FY0 = 626, FX1 = 2262, FY1 = 1274`, goal mouth `GY0/GY1`) are pixel coordinates hand-measured against that image. The center line, hexagon, goal-crease lines, wood frame, goal posts, the HUD "rocks" and the wood scoreboard plaque are all baked directly into it — not drawn at runtime — so moving the physics bounds means re-checking alignment against the art, not just adjusting numbers. The same applies to the under-ice score digits, the hex/circle timer ring, and the six `ROCK_GLOW` overlay rects, all measured against that same 3312x1896 space.

Mobile loads `frame-mobile.webp`, a pre-crop of the same pixels to the `MOBILE_CROP` sub-rect the phone actually shows, so it downloads/decodes far less image for art that would be cropped away anyway. There are four desktop frames in total — `frame.webp`, `frame-winter.webp`, `frame-curling.webp`, `frame-curling-winter.webp` — one per vibe x season, each with a `-mobile` twin. Only one is ever loaded per match (`game.js` picks by `vibe` + `matchConfig.skin`).

**Regenerating the arena:** the current frames come from the V2 pipeline — the upscaled base art in `design/arena/` composited by `scripts/bake_curling_arena.py` (curling) and the equivalent V2 steps for hockey. The downstream scripts `bake_mobile_frame.py`, `bake_hex_timer.py`, `bake_score_digits.py`, `bake_handoff_mask.py`, `bake_waiting_label.py` and `bake_chat_rock.py` all read `public/arena/frame.webp` as their input, so they must be re-run after the frame changes.

> **Do not run `scripts/archive/bake_arena.py`.** That is the V1 pipeline: it writes a 1200x905 `frame.webp` and would silently replace the production 3312x1896 art, invalidating every pixel bound above and poisoning all six downstream scripts. It has been moved to `scripts/archive/` and hard-guarded (it refuses to write unless the existing frame is already 1200x905, with no override flag). It is also no longer reproducible — its source layers came from the gitignored `design-lab/`.

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
index.html        Vite entry: inline branded loading overlay + canvas + every
                  menu/match overlay's markup. Comment it freely — vite.config.js's
                  stripHtmlComments plugin removes HTML comments from the BUILT
                  html only (they were ~45% of the shipped file), never from
                  source and never in dev.
vite.config.js    base (GitHub Pages subpath vs Vercel root) + that plugin
scripts/          Python/Pillow asset-baking helpers — run by hand, never part of
                  `npm run build`. See "Coordinate system" above for the arena chain.
  bake_curling_arena.py  builds the 4 curling arena frames + curling score digits
  bake_mobile_frame.py   crops frame.webp to the mobile sub-rect
  bake_hex_timer.py      hex turn-timer ring, baked off the arena art
  bake_score_digits.py   under-ice score digits (hockey)
  bake_handoff_mask.py   Pass & Play hand-off ice mask
  bake_waiting_label.py  under-ice "waiting" label
  bake_chat_rock.py      the 6th HUD rock + unread badge
  bake_stones.py         stone body sprites
  bake_hud_field_lines.py, crop_score_digits.py, make_*_icon.py
  flux_*.py, upscale_*.py  one-off fal.ai generation/upscale helpers (need FAL_KEY)
  archive/        superseded scripts kept for reference only — NOT part of any
                  workflow. bake_arena.py (V1 1200x905 arena bake, hard-guarded so
                  it can't clobber the V2 art) and export_led_states.py.
server/           Duel LAN only (dev). Node-only, never in the browser build.
  duel-server.js    one-command LAN flow: Vite dev middleware + arbiter on one port
  lan-server.js     standalone arbiter for the two-process flow
  arbiter.js        WebSocket arbiter logic shared by both servers above
  lan-addresses.js  small os.networkInterfaces() helper
party/            Cloudflare Worker + its 9 Durable Objects — see "Production
                  remote backend" above for the full table
  index.js          Worker entry: routes + every DO class re-export
  arbiter.js        Arbiter     — LIVE relay (port of server/arbiter.js)
  weekArbiter.js    WeekArbiter — WEEK, persisted, server-resolved rounds
  playerIndex.js    PlayerIndex — per-wallet: WEEK matches + Telegram link
  radar.js          RadarCollector — daily stats -> Telegram
  leagueSeason.js   LeagueSeason  — League Beta season store
  telegramLink.js   TelegramLink  — one-shot WEEK-notification link tokens
  partnership.js    Partnership   — sponsor weeks, chain-verified payment, R2 banners
  prize.js          PrizeVault    — 10 NIM win payouts + anti-farming limits
  aliases.js        AliasRegistry — paid @alias claims, chain-verified payment
  leagueRating.js   plain module: Elo/LP/streak math + isClassicMatchConfig
  nimiqTx.js        plain module: builds/signs NIM transactions (PrizeVault only)
src/
  main.js         all DOM outside the canvas: splash, mode-select tree, Classic/Custom
                  settings, LIVE + WEEK lobbies/panels, identity pill, How To hub,
                  the ?duel / ?replay magic links, + the Nimiq Mini App SDK handshake
  game.js         canvas game: physics, rendering, input, turn flow (see Architecture)
  weekController.js  WEEK orchestration on top of startGame()'s generic hooks
  net.js          client for all three backends: Duel LAN + LIVE (WebSocket relay)
                  and WEEK (one-shot request/reply sockets + PlayerIndex fetches)
  ai.js           vs-AI shot picking (hockey only)
  aiCurling.js    vs-AI shot picking for Pure Curling (mini-sim search, see its header)
  matchConfig.js  Classic preset, Custom rules, per-mode localStorage persistence
  howto.js        How To tutorial step lists (separate mobile/desktop orders)
  recorder.js     records manche/point shot data during a live match (see Replay)
  replay.js       replay point encode/decode, ticket QR layout, ?replay= parsing
  ticket.js       renders the shareable end-of-match Polaroid "ticket" image
  audio.js        WebAudio SFX + background ambience loop manager
  identicons.js   thin wrapper around @nimiq/identicons
  nimiq.js        Nimiq Pay Mini App SDK + Nimiq Hub wallet identity / guest mode
  alias.js        alias registry lookup + claim (?fakeAlias for UI testing, see Alias registry)
  partnership.js  sponsor week ids + this week's banner (null = use Nimiq art)
  background.js   wires the logo + home/mode-select backdrops (incl. per-vibe swap)
  colors.js       the 7 colors shared by style.css's :root and ticket.js's canvas
  settings.js     shared prefs that outlive a match instance (basic-laser flag)
  preload.js      shared image-preload helper
  style.css       all game + menu styles
public/           only assets actually loaded by the game (kept lean — this ships,
                  verbatim: Vite copies public/ as-is, so .gitignore does NOT keep
                  a file out of the build)
  arena/          4 arena frames + their -mobile crops
  identicons/     stone body art per damage-LED state + the light-layer decal
  home/           splash + mode-select backdrops (default, nimicurl, curling)
  bg/             logo wordmarks (see src/background.js)
  ball/           ball sprite (hockey only)
  rocks/          HUD rock glow sprites (flou/light pairs) + chat badge
  ui/             toolbar button art (base + pressed cap) + mobile controller body
  score-digits/   under-ice score digits, hockey + curling variants
  hex-timer/      turn-timer ring art
  handoff/        Pass & Play hand-off ice mask
  waiting-label/  under-ice "waiting" label + animated dots
  rules/          How To rules illustrations, one per vibe
  ticket/         Polaroid ticket template + banner + guest hex icons
  sfx/            SFX clips (.m4a) + background ambience loop (see src/audio.js)
  icons/, favicon.png, apple-touch-icon.png, manifest.json, sw.js   PWA shell
design/           source art not wired into the game (drafts, superseded versions,
                  raw generations) — never imported by code, safe to ignore for
                  gameplay work. design/arena, design/identicons and design/bg hold
                  the specific source layers public/ was built from.
design-lab/       local-only Vite sandbox (gitignored) for testing new visual layers
                  against real assets before they're baked/ported into design/ +
                  public/ + src/ — see the lab-to-main workflow below
physics-lab/      local-only sandbox (gitignored) for prototyping physics tuning
curling-lab/      local-only sandbox (gitignored) for the curling vibe's art
audio-lab/        local-only sandbox (gitignored) for SFX work; audio-lab/rejects/
                  holds the non-shipped takes that used to sit in public/sfx/
prototypes/       earlier single-file HTML explorations kept for reference/diffing;
                  none are part of the build (see prototypes/README.md)
```

## Lab-to-main workflow

`design-lab/` and `physics-lab/` are local scratch space (gitignored, never pushed) for trying out visual/physics changes against real assets without touching the shipped game. Migrate one validated piece at a time, not a wholesale copy:

1. Prototype and validate the change in the lab.
2. Port only the specific proven piece into `src/` — physics fixes go straight into `game.js`'s constants/functions (see the physics-lab-ported comments already in `physicsStep`/`resolveCollision` for the pattern); visual layers get their winning source art copied into `design/` (so it survives even if the lab folder is cleared) and either baked into the arena frames via the V2 bake scripts (static, physics-box-aligned art — see "Coordinate system" above, and **not** the archived `bake_arena.py`) or wired up as their own asset + code path (animated/interactive pieces, like the stone sprites).
3. Verify in the browser (dev server), then commit the migration on its own, separate from unrelated changes.

## Dev-only debug hook

When running via `npm run dev`, `window.__nb` exposes `{ entities(), phase(), step() }` for inspecting/advancing physics state from the browser console (guarded by `import.meta.env.DEV`, stripped from production builds).
