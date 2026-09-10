// NIM-Curl Radar — a single always-on Durable Object that collects tiny
// daily counters from LIVE (party/arbiter.js) and WEEK (party/weekArbiter.js)
// matches and reports them to Telegram. Deliberately NOT a database: one
// small JSON document per calendar day (Europe/Paris), stored the exact same
// way WeekArbiter already persists match state (this.ctx.storage, SQLite-
// backed DO — see wrangler.jsonc's migrations). One fixed-name instance for
// the whole game (see RADAR_ROOM_NAME below) — there's only ever one "today".
//
// Callers (Arbiter/WeekArbiter) reach this over Durable Object RPC
// (getServerByName(this.env.RadarCollector, RADAR_ROOM_NAME).recordX(...)),
// not HTTP — that's the "authentication" for server→Radar events: only code
// running inside this same Worker can ever get a reference to call these
// methods, there is no public endpoint that accepts match events. See
// party/index.js for the Telegram webhook (inbound /radar commands) and the
// scheduled() cron (outbound daily report) — the only other ways in.
//
// Scope: `mode` is exactly `'live' | 'week'` — those are the only two real
// game MODES (synchronous vs asynchronous multiplayer), and the only two
// this file knows about (see MODES below). Everything else is out of scope
// by construction, not by omission:
// - Alone / AI / Pass & Play are LOCAL experiences (see CLAUDE.md's Turn/
//   phase state machine — no `net`, ever) and never reach this file at all;
//   there is nothing to "track" for them here.
// - "Classic" is NOT a mode — it's a ruleset/config preset (see
//   src/matchConfig.js's DEFAULT_MATCH_CONFIG) that LIVE, WEEK, and Pass &
//   Play can all be played with. It has no bearing on Radar's mode field.
// - "Unique players" / "new wallets" / "returning" are wallet-address-only,
//   counted once across LIVE + WEEK combined (a player who plays both in one
//   day is still one unique player). A guest slot is counted in `matches`
//   and in the wallet-vs-guest connections line, never in those three
//   metrics — there is no reliable, privacy-respecting stable id for a guest
//   across matches, and inventing one (e.g. a localStorage id) was
//   explicitly declined in favor of keeping this simple.
import { Server } from 'partyserver';

export const RADAR_ROOM_NAME = 'radar';
const PARIS_TZ = 'Europe/Paris';

// ---- time helpers (Europe/Paris, DST-safe via Intl at call time) ----
function parisDateParts(timestampMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: PARIS_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(timestampMs).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function parisDate(timestampMs) { return parisDateParts(timestampMs).date; }
// Pure calendar-date arithmetic (not a real Paris-local timestamp) — safe
// across DST because it never touches a wall-clock hour, just the date.
function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function formatDateLabel(dateStr) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(new Date(`${dateStr}T00:00:00Z`));
}

// Address → stable, non-reversible id. Salted so the hash alone can't be
// dictionary-attacked back to a real address by anyone who ever sees Radar's
// storage — Radar only ever needs "have I seen this hash before", never the
// address itself (see file header). Falls back to an in-code default salt
// only so local dev without .dev.vars set doesn't crash; production should
// always set RADAR_WALLET_SALT (see CLAUDE.md).
async function hashAddress(address, salt) {
  const bytes = new TextEncoder().encode(`${salt || 'nimcurl-radar-dev-salt'}:${address}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MODES = ['live', 'week'];
function emptyDay(date) {
  return {
    date,
    modes: Object.fromEntries(MODES.map((m) => [m, {
      started: [], completed: [],
      walletsSeenToday: {}, // hash -> true, this mode only — "LIVE vs WEEK player activity"
    }])),
    walletsSeenToday: {},   // hash -> true (unique players today, LIVE + WEEK combined)
    newWalletsToday: {},    // hash -> true (subset of the above, first-ever-seen today)
    walletSlots: 0,         // wallet-identified match slots (2 per match, 1 per player)
    guestSlots: 0,          // guest match slots
    hourly: new Array(24).fill(0), // matches started per Paris hour, for peak activity
  };
}

function dayReportNumbers(day) {
  const liveStarted = day.modes.live.started.length;
  const weekStarted = day.modes.week.started.length;
  const liveCompleted = day.modes.live.completed.length;
  const weekCompleted = day.modes.week.completed.length;
  const matches = liveStarted + weekStarted; // "Total server-backed matches" — LIVE + WEEK, the only two modes Radar knows
  const completed = liveCompleted + weekCompleted;
  const uniquePlayers = Object.keys(day.walletsSeenToday).length; // across LIVE + WEEK
  const newWallets = Object.keys(day.newWalletsToday).length;
  const returning = Math.max(0, uniquePlayers - newWallets);
  const matchesPerPlayer = uniquePlayers ? Math.round((matches / uniquePlayers) * 100) / 100 : 0;
  let peakHour = null, peakCount = 0;
  day.hourly.forEach((c, h) => { if (c > peakCount) { peakCount = c; peakHour = h; } });
  return {
    matches, completed, uniquePlayers, newWallets, returning, matchesPerPlayer,
    liveStarted, weekStarted, walletSlots: day.walletSlots, guestSlots: day.guestSlots,
    liveActivePlayers: Object.keys(day.modes.live.walletsSeenToday).length,
    weekActivePlayers: Object.keys(day.modes.week.walletsSeenToday).length,
    peakHour, peakCount,
  };
}

// `active` ({live, week}) is RadarCollector's running "started - completed"
// gauge, not a per-day figure — see recordMatchStarted/recordMatchCompleted's
// own comments for exactly what it does and doesn't capture.
function formatReport({ title, dateLabel, n, active, trendLine }) {
  const peakLine = n.peakCount > 0 ? `\n\n📈 Peak: ${String(n.peakHour).padStart(2, '0')}:00–${String((n.peakHour + 1) % 24).padStart(2, '0')}:00` : '';
  return [
    `📡 ${title}`,
    dateLabel,
    '',
    `🎮 ${n.matches} matches (LIVE + WEEK)`,
    `🏁 ${n.completed} completed`,
    `👤 ${n.uniquePlayers} unique players`,
    `🆕 ${n.newWallets} new players`,
    '',
    'MODES',
    `• Live ${n.liveStarted} matches, ${n.liveActivePlayers} active players`,
    `• Week ${n.weekStarted} matches, ${n.weekActivePlayers} active players`,
    '',
    'PLAYERS',
    `• New ${n.newWallets}`,
    `• Returning ${n.returning}`,
    `• Matches/player ${n.matchesPerPlayer}`,
    `• Connections: ${n.walletSlots} wallet · ${n.guestSlots} guest`,
    '',
    `⏱ Active now — Live: ${active?.live ?? 0} · Week: ${active?.week ?? 0}`,
  ].join('\n') + peakLine + (trendLine || '');
}

export class RadarCollector extends Server {
  onStart() {
    this._loaded = (async () => {
      this.wallets = (await this.ctx.storage.get('wallets')) || {};     // hash -> firstSeenDate ("YYYY-MM-DD"), persists forever
      this.lastReportedDate = (await this.ctx.storage.get('lastReportedDate')) || null;
      // Running "started minus completed" gauge per mode, NOT a per-day
      // figure (see recordMatchStarted/recordMatchCompleted). Best-effort —
      // see those methods' own comments for the known drift this has.
      this.activeCounts = (await this.ctx.storage.get('activeCounts')) || { live: 0, week: 0 };
    })();
    // Plain in-memory promise chain serializing every day-document
    // read-modify-write below (recordMatchStarted/Completed/PlayerActive) —
    // two RPC calls can legitimately land close together (e.g. two players
    // starting different matches at once), and each of those methods does a
    // storage.get, mutates the doc in JS memory across a non-storage await
    // (hashAddress's crypto.subtle.digest), then storage.put — a window
    // where two interleaved calls would each load the pre-mutation doc and
    // the second write would silently clobber the first (verified with a
    // standalone concurrency test). Not relying on Durable Objects' own
    // input-gate timing for this — see serialized() below for a fix that's
    // correct regardless of exactly when that gate opens/closes.
    this._writeQueue = Promise.resolve();
  }
  async ready() { if (this._loaded) await this._loaded; }

  // Chains `fn` onto this instance's single write queue so day-document
  // mutations across concurrent calls always run one at a time, in arrival
  // order — see onStart's comment for why this exists.
  serialized(fn) {
    const run = this._writeQueue.then(fn, fn); // still run even if the previous entry rejected
    this._writeQueue = run.catch(() => {});    // one failure must never wedge the whole queue
    return run;
  }

  async persistWallets() { await this.ctx.storage.put('wallets', this.wallets); }
  async persistActiveCounts() { await this.ctx.storage.put('activeCounts', this.activeCounts); }
  async loadDay(date) { return (await this.ctx.storage.get(`day:${date}`)) || emptyDay(date); }
  async saveDay(day) { await this.ctx.storage.put(`day:${day.date}`, day); }

  salt() { return this.env?.RADAR_WALLET_SALT; }

  // Marks `hash` seen today, both in the combined LIVE+WEEK set
  // (day.walletsSeenToday) and in that mode's own set
  // (day.modes[mode].walletsSeenToday — "LIVE vs WEEK player activity"), and,
  // the first time this hash is EVER seen (across all days, via this.wallets),
  // also marks it new today. All plain object-key writes — replaying the
  // same hash twice for the same day is a no-op the second time, which is
  // what makes this safe to call from a retried/duplicated upstream event.
  async touchWallet(day, mode, hash, date) {
    day.walletsSeenToday[hash] = true;
    day.modes[mode].walletsSeenToday[hash] = true;
    if (!this.wallets[hash]) {
      this.wallets[hash] = date;
      day.newWalletsToday[hash] = true;
      await this.persistWallets();
    }
  }

  // players: [{address}, {address}] — address is null/undefined for a guest slot.
  recordMatchStarted({ matchId, mode, timestampMs, players }) {
    return this.serialized(async () => {
      await this.ready();
      if (!MODES.includes(mode)) return { ok: false };
      const { date, hour } = parisDateParts(timestampMs);
      const day = await this.loadDay(date);
      if (day.modes[mode].started.includes(matchId)) return { ok: true, duplicate: true }; // idempotent replay
      day.modes[mode].started.push(matchId);
      day.hourly[hour] += 1;
      for (const p of players || []) {
        if (p && p.address) {
          day.walletSlots += 1;
          await this.touchWallet(day, mode, await hashAddress(p.address, this.salt()), date);
        } else {
          day.guestSlots += 1;
        }
      }
      await this.saveDay(day);
      // "Active now" gauge (see formatReport's own comment) — best-effort:
      // there is no "abandoned"/"expired" event wired from WeekArbiter to
      // Radar (party/weekArbiter.js's onAlarm/'abandon' handlers), and LIVE
      // has no such concept at all (a room just goes quiet if a player
      // closes the tab) — so a match that never sends matchOver/completeRound
      // stays counted as active forever. Treat this as an upper bound, not an
      // exact live count.
      this.activeCounts[mode] += 1;
      await this.persistActiveCounts();
      return { ok: true };
    });
  }

  recordMatchCompleted({ matchId, mode, timestampMs }) {
    return this.serialized(async () => {
      await this.ready();
      if (!MODES.includes(mode)) return { ok: false };
      const date = parisDate(timestampMs);
      const day = await this.loadDay(date);
      if (day.modes[mode].completed.includes(matchId)) return { ok: true, duplicate: true };
      day.modes[mode].completed.push(matchId);
      await this.saveDay(day);
      this.activeCounts[mode] = Math.max(0, this.activeCounts[mode] - 1);
      await this.persistActiveCounts();
      return { ok: true };
    });
  }

  // WEEK-only: fired on every turn (shot), independent of match start/end —
  // this is what lets a multi-day WEEK match contribute to "unique players
  // today" (both combined and WEEK-specific, see touchWallet) on every day
  // it's actually touched, without ever re-counting the match itself as
  // started again (see CLAUDE.md's Radar / WEEK section).
  recordPlayerActive({ address, timestampMs }) {
    return this.serialized(async () => {
      await this.ready();
      if (!address) return { ok: true };
      const date = parisDate(timestampMs);
      const day = await this.loadDay(date);
      await this.touchWallet(day, 'week', await hashAddress(address, this.salt()), date);
      await this.saveDay(day);
      return { ok: true };
    });
  }

  async sendTelegram(text) {
    const token = this.env?.TELEGRAM_BOT_TOKEN, chatId = this.env?.TELEGRAM_CHAT_ID;
    if (!token || !chatId) { console.error('[radar] Telegram not configured — RadarCollector has no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID'); return; }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      // fetch() only rejects on network-level failure — an HTTP error status
      // (bad chat id, bot blocked, malformed text, etc.) resolves normally
      // and was previously swallowed silently (a real bug: the bot could
      // fail every send with zero trace anywhere). Log the body too since
      // Telegram's error `description` is what actually explains the failure.
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[radar] Telegram send failed: HTTP ${res.status} ${body}`);
      }
    } catch (err) {
      console.error('[radar] Telegram send failed:', err); // never let a Telegram outage break event recording
    }
  }

  // Called on every /radar[ yesterday] webhook hit (see party/index.js) —
  // returns nothing, sends directly to Telegram (single-owner personal bot,
  // no need to thread a reply-to-arbitrary-chat path through here).
  async handleCommand(text) {
    await this.ready();
    const cmd = (text || '').trim().toLowerCase();
    const today = parisDate(Date.now());
    if (cmd === '/radar' || cmd === '/radar today') {
      const day = await this.loadDay(today);
      await this.sendTelegram(formatReport({ title: 'NIM-CURL RADAR', dateLabel: 'Today', n: dayReportNumbers(day), active: this.activeCounts }));
      return;
    }
    if (cmd === '/radar yesterday') {
      const yDate = shiftDate(today, -1);
      const day = await this.loadDay(yDate);
      await this.sendTelegram(formatReport({ title: 'NIM-CURL RADAR', dateLabel: formatDateLabel(yDate), n: dayReportNumbers(day), active: this.activeCounts }));
    }
    // Unrecognized command: silently ignored (see party/index.js's chat-id
    // check for who can even reach this).
  }

  // Cron entry point (party/index.js's scheduled(), every 15 min). Sends the
  // report for whichever Paris calendar day most recently ended, exactly
  // once, as soon as a tick observes "today" has moved past it — so it fires
  // within ~15 min of Paris midnight, DST included (parisDateParts() re-
  // resolves the offset every call). If the Worker/cron was down over a
  // whole day boundary, this deliberately reports only the single most
  // recently completed day on the next tick, not a backlog of every missed
  // day — keeping this simple per the explicit "don't overbuild" brief.
  async maybeSendDailyReport() {
    await this.ready();
    const today = parisDate(Date.now());
    const targetDate = shiftDate(today, -1); // the day that just fully ended
    if (this.lastReportedDate === targetDate) return; // already sent
    const day = await this.loadDay(targetDate);
    const n = dayReportNumbers(day);
    const prevDay = await this.loadDay(shiftDate(targetDate, -1));
    const prevMatches = dayReportNumbers(prevDay).matches;
    let trendLine = '';
    if (prevMatches > 0) {
      const pct = Math.round(((n.matches - prevMatches) / prevMatches) * 1000) / 10;
      trendLine = `\n\nYesterday: ${prevMatches} matches\n${pct > 0 ? '+' : ''}${pct}%`;
    }
    await this.sendTelegram(formatReport({ title: 'NIM-CURL RADAR', dateLabel: formatDateLabel(targetDate), n, active: this.activeCounts, trendLine }));
    this.lastReportedDate = targetDate;
    await this.ctx.storage.put('lastReportedDate', this.lastReportedDate);
  }
}
