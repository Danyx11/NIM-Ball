// Async ("WEEK") counterpart to party/arbiter.js — same partyserver/Durable
// Object hosting, but a genuinely different transport model. LIVE holds one
// open socket per player for the whole match and pushes events
// (opponentJoined, launch, bothReady); WEEK never assumes either player is
// online at the same time, so every connection is a short-lived "connect,
// get the current state, maybe act, disconnect" round trip — no live push,
// even if both players happen to be online at once (see the WEEK design
// conversation: deliberately not special-cased).
//
// Deliberately a SEPARATE Durable Object class from Arbiter, not a `mode`
// branch inside it — this file can be edited freely with zero risk to the
// LIVE relay actually in production use today. The trade-off (spelled out in
// conversation) is some duplicated plumbing rather than one shared
// implementation; a possible future LIVE<->WEEK switch would need to bridge
// two DO classes rather than flip one field, but that's an explicitly
// deferred concern, not a blocker for shipping WEEK.
//
// Identity/reconnection: WEEK requires a connected Nimiq wallet on both
// sides (no guest — see src/main.js's WEEK wallet gate), specifically so the
// match code + the player's own wallet address are enough to resume a match
// on any device — no separate claim token (see conversation: a token would
// only have solved a problem guests have, and WEEK has no guests). Team
// assignment is therefore by address, not by connection order (contrast
// Arbiter's "1st/2nd connection = A/B"): whichever address creates the match
// is A, whichever address is accepted as the second player is B, and either
// can reconnect any time after that by presenting that same address again —
// `onConnect` below is the entire reconnection story, there's no separate
// "resume" message type.
//
// State is persisted to `this.ctx.storage` (SQLite-backed, see
// wrangler.jsonc) after every mutation and reloaded on every cold start —
// unlike Arbiter, which always starts blank, a WEEK match must survive this
// Durable Object being evicted between two visits that can be days apart.
import { Server, getServerByName } from 'partyserver';

const DAY_MS = 24 * 60 * 60 * 1000;
const JOIN_WINDOW_MS = DAY_MS;        // A's code stays open for B to join
const MATCH_LIFETIME_MS = 7 * DAY_MS; // fixed from the moment B joins, not sliding — see conversation

function otherTeam(team) { return team === 'A' ? 'B' : 'A'; }

export class WeekArbiter extends Server {
  onStart() {
    this._loaded = this.ctx.storage.get('match').then((m) => { this.match = m || null; });
  }

  async ready() { if (this._loaded) await this._loaded; }

  send(connection, msg) { if (connection) connection.send(JSON.stringify(msg)); }

  async persist() { await this.ctx.storage.put('match', this.match); }

  playerIndex(address) { return getServerByName(this.env.PlayerIndex, address); }

  // Compact, redacted view sent to a connecting client. The opponent's shot
  // for the in-progress round is withheld until both sides have submitted —
  // enough gating to keep "leave a message, then watch the reveal" feeling
  // like a real reveal, not a proof against a client that inspects its own
  // network traffic (this arbiter already trusts every client-sent field
  // exactly like party/arbiter.js does, see that file's own comments — same
  // posture here, this game has no stakes that would justify more).
  snapshotFor(team) {
    const m = this.match;
    const opp = otherTeam(team);
    const bothIn = !!(m.pendingShots.A && m.pendingShots.B);
    return {
      game: m.game, config: m.config, status: m.status,
      round: m.round, scoreA: m.scoreA, scoreB: m.scoreB,
      team, opponentAddress: team === 'A' ? m.playerB : m.playerA,
      createdAt: m.createdAt, joinDeadline: m.joinDeadline, joinedAt: m.joinedAt, expiresAt: m.expiresAt,
      mySubmitted: !!m.pendingShots[team],
      opponentSubmitted: !!m.pendingShots[opp],
      reveal: bothIn ? { mine: m.pendingShots[team], opponent: m.pendingShots[opp] } : null,
      // Manches already played earlier in the current, not-yet-scored point
      // (see completeRound's own comment) — src/weekController.js feeds
      // these into game.js's resumeManches so an aim or reveal session
      // starts from the board's real current state instead of a fresh rack,
      // whether that's a reconnect days later or simply the point's 2nd
      // manche a minute after the 1st.
      pointManches: m.pointManches,
    };
  }

  // 'yourTurn' / 'waiting' / 'revealReady' — differs per team (mirrors
  // snapshotFor's own reveal gating), used for this player's own "My
  // Matches" row (main.js). Terminal statuses pass through as-is.
  turnLabelFor(team) {
    const m = this.match;
    if (m.status !== 'active') return m.status;
    if (!m.pendingShots[team]) return 'yourTurn';
    if (!m.pendingShots[otherTeam(team)]) return 'waiting';
    return 'revealReady';
  }

  async pushIndexUpdate(team) {
    const m = this.match;
    const address = team === 'A' ? m.playerA : m.playerB;
    if (!address) return;
    const oppAddress = team === 'A' ? m.playerB : m.playerA;
    const idx = await this.playerIndex(address);
    await idx.upsert(this.name, {
      game: m.game, opponentAddress: oppAddress, myTeam: team,
      status: m.status, turnLabel: this.turnLabelFor(team),
    });
  }

  async removeFromIndex(address) {
    if (!address) return;
    const idx = await this.playerIndex(address);
    await idx.remove(this.name);
  }

  async onConnect(connection, ctx) {
    await this.ready();
    const url = new URL(ctx.request.url);
    const address = url.searchParams.get('address');
    const intent = url.searchParams.get('intent');
    if (!address) { this.send(connection, { type: 'error', reason: 'addressRequired' }); connection.close(); return; }

    if (intent === 'create') {
      if (this.match && (this.match.status === 'pending' || this.match.status === 'active')) {
        this.send(connection, { type: 'occupied' }); connection.close(); return;
      }
      const idx = await this.playerIndex(address);
      const reserved = await idx.reserve(this.name);
      if (!reserved.ok) { this.send(connection, { type: 'limitReached' }); connection.close(); return; }

      let config = {};
      try { config = JSON.parse(url.searchParams.get('config') || '{}'); } catch { config = {}; }
      const game = url.searchParams.get('game') || null;
      const now = Date.now();
      this.match = {
        game, config, playerA: address, playerB: null, status: 'pending',
        createdAt: now, joinDeadline: now + JOIN_WINDOW_MS, joinedAt: null, expiresAt: null,
        round: 0, scoreA: 0, scoreB: 0,
        pendingShots: { A: null, B: null },
        // Manches already played in the current, not-yet-scored point — see
        // snapshotFor's own comment and completeRound below.
        pointManches: [],
      };
      await this.persist();
      await this.ctx.storage.setAlarm(this.match.joinDeadline);
      connection.setState({ team: 'A' });
      await idx.upsert(this.name, { game, opponentAddress: null, myTeam: 'A', status: 'pending', turnLabel: 'pending' });
      this.send(connection, { type: 'connected', ...this.snapshotFor('A') });
      return;
    }

    // intent === 'join' — also covers a returning A or B (a reconnect looks
    // identical to a fresh join attempt: same address-match branches below).
    if (!this.match) { this.send(connection, { type: 'notFound' }); connection.close(); return; }
    if (this.match.status === 'expired') { this.send(connection, { type: 'expired' }); connection.close(); return; }
    if (this.match.status === 'completed') { this.send(connection, { type: 'notFound' }); connection.close(); return; }

    if (address === this.match.playerA) {
      connection.setState({ team: 'A' });
      this.send(connection, { type: 'connected', ...this.snapshotFor('A') });
      return;
    }
    if (address === this.match.playerB) {
      connection.setState({ team: 'B' });
      this.send(connection, { type: 'connected', ...this.snapshotFor('B') });
      return;
    }
    if (this.match.playerB) { this.send(connection, { type: 'full' }); connection.close(); return; }
    if (Date.now() >= this.match.joinDeadline) { this.send(connection, { type: 'expired' }); connection.close(); return; }

    const idx = await this.playerIndex(address);
    const reserved = await idx.reserve(this.name);
    if (!reserved.ok) { this.send(connection, { type: 'limitReached' }); connection.close(); return; }

    const now = Date.now();
    this.match.playerB = address;
    this.match.status = 'active';
    this.match.joinedAt = now;
    this.match.expiresAt = now + MATCH_LIFETIME_MS;
    await this.persist();
    await this.ctx.storage.setAlarm(this.match.expiresAt);
    connection.setState({ team: 'B' });
    await Promise.all([this.pushIndexUpdate('A'), this.pushIndexUpdate('B')]);
    this.send(connection, { type: 'connected', ...this.snapshotFor('B') });
  }

  async onMessage(connection, message) {
    await this.ready();
    const team = connection.state?.team;
    if ((team !== 'A' && team !== 'B') || !this.match) return;
    let msg; try { msg = JSON.parse(message); } catch { return; }

    if (msg.type === 'shot') {
      // 'pending' allowed too, not just 'active' — lets the creator (team A)
      // play their own first shot before B has even joined (see main.js's
      // hostWeekMatch/showWeekFirstShotScreen). Safe: team can only ever be
      // 'B' once status is already 'active' (onConnect sets both together,
      // see above), so a 'pending' shot can only ever come from A.
      if ((this.match.status !== 'active' && this.match.status !== 'pending') || this.match.pendingShots[team]) return;
      const text = typeof msg.message === 'string'
        ? Array.from(msg.message.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 60).join('')
        : '';
      this.match.pendingShots[team] = { stones: msg.stones, sweep: msg.sweep || null, message: text };
      await this.persist();
      await Promise.all([this.pushIndexUpdate('A'), this.pushIndexUpdate('B')]);
      this.send(connection, { type: 'shotAccepted', ...this.snapshotFor(team) });
      return;
    }

    if (msg.type === 'completeRound') {
      if (this.match.status !== 'active' || !this.match.pendingShots.A || !this.match.pendingShots.B) return;
      const scoreA = Math.max(0, Math.min(99, msg.scoreA | 0));
      const scoreB = Math.max(0, Math.min(99, msg.scoreB | 0));
      // A point just scored iff either score moved — the same manche/point
      // distinction game.js's own onGoal already makes (see CLAUDE.md's
      // "manche"/"point" vocabulary). Scored: the next manche starts a fresh
      // point, nothing to carry forward. Not scored: append this manche so a
      // later aim/reveal (same point, could be the very next turn or a
      // reconnect days later) can fast-forward the board back to here — see
      // snapshotFor's own pointManches comment.
      const pointScored = scoreA !== this.match.scoreA || scoreB !== this.match.scoreB;
      this.match.pointManches = pointScored ? [] : [...this.match.pointManches, {
        stonesA: this.match.pendingShots.A.stones, sweepA: this.match.pendingShots.A.sweep,
        stonesB: this.match.pendingShots.B.stones, sweepB: this.match.pendingShots.B.sweep,
      }];
      this.match.scoreA = scoreA;
      this.match.scoreB = scoreB;
      this.match.round += 1;
      this.match.pendingShots = { A: null, B: null };
      const target = this.match.config?.pointsToWin || 3;
      const matchOver = scoreA >= target || scoreB >= target;
      if (matchOver) {
        this.match.status = 'completed';
        await this.ctx.storage.deleteAlarm();
      }
      await this.persist();
      if (matchOver) {
        await Promise.all([this.removeFromIndex(this.match.playerA), this.removeFromIndex(this.match.playerB)]);
      } else {
        await Promise.all([this.pushIndexUpdate('A'), this.pushIndexUpdate('B')]);
      }
      this.send(connection, { type: 'roundCompleted', ...this.snapshotFor(team) });
    }
  }

  async onAlarm() {
    await this.ready();
    if (!this.match) return;
    const now = Date.now();
    if (this.match.status === 'pending' && now >= this.match.joinDeadline) {
      this.match.status = 'expired';
      await this.persist();
      await this.removeFromIndex(this.match.playerA);
    } else if (this.match.status === 'active' && now >= this.match.expiresAt) {
      this.match.status = 'expired';
      await this.persist();
      await Promise.all([this.removeFromIndex(this.match.playerA), this.removeFromIndex(this.match.playerB)]);
    }
  }
}
