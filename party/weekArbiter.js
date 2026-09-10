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
import { RADAR_ROOM_NAME } from './radar.js';

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

  // Compact, redacted view sent to a connecting client. Deliberately does
  // NOT include a message — see this.match.inbox/consumeInbox below, a
  // message is delivered once, at connect time, to its recipient only,
  // never bundled into the reveal (see conversation: a message belongs to
  // its recipient, not to the reveal both sides eventually watch together).
  //
  // reveal has two possible sources, not one — a manche goes through two
  // states before anyone's seenBy is even relevant: (1) both sides have
  // submitted (bothIn) but nobody has simulated/reported it yet — the raw
  // shot data has to come from pendingShots itself here, there is nothing
  // else yet to source it from (a client needs exactly this to go simulate
  // it and later call completeRound at all); (2) already resolved (see
  // completeRound's own comment — pendingShots already moved on to the next
  // manche) but THIS team specifically hasn't watched it — sourced from
  // lastManche instead, independently per team (per explicit requirement:
  // "each player has their own reveal progress... do not collapse this
  // into one generic state") — a team only stops being offered a given
  // reveal once THEY, personally, have reported watching it; the other
  // team having already moved on never affects this team's own copy.
  snapshotFor(team) {
    const m = this.match;
    const opp = otherTeam(team);
    const bothIn = !!(m.pendingShots.A && m.pendingShots.B);
    const lm = m.lastManche;
    let reveal = null;
    if (bothIn) {
      reveal = {
        mine: team === 'A' ? { stones: m.pendingShots.A.stones, sweep: m.pendingShots.A.sweep } : { stones: m.pendingShots.B.stones, sweep: m.pendingShots.B.sweep },
        opponent: team === 'A' ? { stones: m.pendingShots.B.stones, sweep: m.pendingShots.B.sweep } : { stones: m.pendingShots.A.stones, sweep: m.pendingShots.A.sweep },
      };
    } else if (lm && !lm.seenBy[team]) {
      reveal = {
        mine: team === 'A' ? { stones: lm.stonesA, sweep: lm.sweepA } : { stones: lm.stonesB, sweep: lm.sweepB },
        opponent: team === 'A' ? { stones: lm.stonesB, sweep: lm.sweepB } : { stones: lm.stonesA, sweep: lm.sweepA },
      };
    }
    return {
      game: m.game, config: m.config, status: m.status,
      round: m.round, scoreA: m.scoreA, scoreB: m.scoreB,
      team, opponentAddress: team === 'A' ? m.playerB : m.playerA,
      createdAt: m.createdAt, joinDeadline: m.joinDeadline, joinedAt: m.joinedAt, expiresAt: m.expiresAt,
      mySubmitted: !!m.pendingShots[team],
      opponentSubmitted: !!m.pendingShots[opp],
      reveal,
      // Manches already played earlier in the current, not-yet-scored point
      // (see completeRound's own comment) — src/weekController.js feeds
      // these into game.js's resumeManches so an aim or reveal session
      // starts from the board's real current state instead of a fresh rack,
      // whether that's a reconnect days later or simply the point's 2nd
      // manche a minute after the 1st.
      pointManches: m.pointManches,
      // Has this team already played (or watched a reveal) at least once
      // in the CURRENT point — the "first entry into a new point gets
      // PLAY + the point-start animation, a later return within the same
      // point never does" rule (see src/main.js's showWeekAimScreen/
      // playWeekReveal and game.js's weekPointStart). Derivable from
      // existing fields, no extra persisted flag needed: any manche
      // already appended to pointManches necessarily included this team's
      // shot (a manche only exists once BOTH sides have submitted), and a
      // live pendingShots[team] means they've already submitted the
      // point's current (not yet resolved) manche.
      enteredPoint: (m.pointManches && m.pointManches.length > 0) || !!m.pendingShots[team],
    };
  }

  // A message is a single slot per recipient (this.match.inbox.A/.B, see the
  // 'message' case in onMessage below) — deliberately not an unread-count/
  // multi-message inbox (per explicit request: keep this simple for now).
  // Consuming it (reading + clearing + persisting in one step) is what makes
  // "shown once, at connect time" true: called only from onConnect's three
  // "this address is actually arriving/returning to the match" branches
  // below, never from a reply to that team's own shot/message/completeRound
  // action, so a team is never shown a message as a side effect of their own
  // move — only of actually opening/reconnecting to the match.
  async consumeInbox(team) {
    // Defensive against a match persisted before this field existed (a
    // pre-existing local/dev match) — reads back as undefined, not a
    // missing-inbox error.
    if (!this.match.inbox) return null;
    const msg = this.match.inbox[team];
    if (msg) {
      this.match.inbox[team] = null;
      await this.persist();
    }
    return msg || null;
  }

  // 'yourTurn' / 'waiting' / 'revealReady' — differs per team (mirrors
  // snapshotFor's own reveal gating), used for this player's own "My
  // Matches" row (main.js: both 'yourTurn' and 'revealReady' render as
  // "Your turn" there — either way this team has something actionable to
  // come back and do; 'waiting' is the only genuinely idle state).
  // Deliberately keyed off the same lastManche/pendingShots fields
  // snapshotFor reads, not a separate computation — see that function's own
  // comment on why a second source of truth for "is my reveal ready" would
  // be wrong (this team's own unseen reveal is real even after the other
  // team has already moved on to their next shot).
  turnLabelFor(team) {
    const m = this.match;
    if (m.status !== 'active') return m.status;
    if (m.pendingShots.A && m.pendingShots.B) return 'revealReady'; // both submitted — see snapshotFor's own comment
    const lm = m.lastManche;
    if (lm && !lm.seenBy[team]) return 'revealReady';
    if (!m.pendingShots[team]) return 'yourTurn';
    return 'waiting';
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
      // pointsToWin (config.pointsToWin) + expiresAt: "My Matches" (main.js)
      // renders these directly on each row card without opening its own
      // connection to the match — same reasoning as every other field
      // already cached here. expiresAt is null until B actually joins (see
      // onConnect's own intent==='join' branch, where it's first set) —
      // still-'pending' rows show joinDeadline instead (see main.js).
      pointsToWin: m.config.pointsToWin, expiresAt: m.expiresAt, joinDeadline: m.joinDeadline,
    });
  }

  async removeFromIndex(address) {
    if (!address) return;
    const idx = await this.playerIndex(address);
    await idx.remove(this.name);
  }

  // NIM-Curl Radar (see party/radar.js) — reached over Durable Object RPC,
  // not HTTP, same as PlayerIndex above. Every call site below is already a
  // naturally one-shot transition (guarded by this.match.status checks that
  // exist for gameplay reasons, not added for this), so no extra dedup flag
  // is needed here the way party/arbiter.js needs one for its own
  // (not-persisted, reconnect-prone) instance lifecycle.
  radarNotify(method, payload) {
    if (!this.env?.RadarCollector) return;
    // See party/arbiter.js's identical radarNotify comment — getServerByName
    // returns Promise<DurableObjectStub>, not the stub itself, and must be
    // awaited before calling a method on it (a real bug found live: calling
    // [method](payload) on the un-awaited promise threw synchronously).
    getServerByName(this.env.RadarCollector, RADAR_ROOM_NAME)
      .then((radar) => radar[method](payload))
      .catch((err) => console.error(`[radar] ${method} failed:`, err));
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
        // The most recently resolved manche, kept around independently of
        // pendingShots (which already moves on to the next manche the
        // instant this one resolves) specifically so each team's OWN
        // "have I watched this yet" progress (seenBy) can outlive the other
        // team having already moved on — see snapshotFor/completeRound's
        // own comments.
        lastManche: null,
        // Manches already played in the current, not-yet-scored point — see
        // snapshotFor's own comment and completeRound below.
        pointManches: [],
        // One-slot-per-recipient message inbox — see consumeInbox above.
        inbox: { A: null, B: null },
      };
      await this.persist();
      await this.ctx.storage.setAlarm(this.match.joinDeadline);
      connection.setState({ team: 'A' });
      await idx.upsert(this.name, {
        game, opponentAddress: null, myTeam: 'A', status: 'pending', turnLabel: 'pending',
        pointsToWin: config.pointsToWin, expiresAt: null, joinDeadline: this.match.joinDeadline,
      });
      // Nothing to deliver — this match didn't exist a moment ago, so
      // inboxMessage is always null here (included anyway for a shape
      // src/net.js's `week` object can rely on being present, not just
      // sometimes-undefined).
      this.send(connection, { type: 'connected', ...this.snapshotFor('A'), inboxMessage: null });
      return;
    }

    // intent === 'join' — also covers a returning A or B (a reconnect looks
    // identical to a fresh join attempt: same address-match branches below).
    if (!this.match) { this.send(connection, { type: 'notFound' }); connection.close(); return; }
    // Abandoned reads the same as a natural expiry to a reconnecting client
    // (see msg.type === 'abandon' below) — either way the match is over and
    // the code no longer leads anywhere. In practice this case is rare:
    // abandoning already removed both players' PlayerIndex entries, so
    // nothing points back at this code anymore except someone re-typing it.
    if (this.match.status === 'expired' || this.match.status === 'abandoned') { this.send(connection, { type: 'expired' }); connection.close(); return; }
    if (this.match.status === 'completed') {
      // Known gap (see completeRound's own comment): whichever side reports
      // a manche's outcome first can flip the match straight to
      // 'completed' before the other side has watched that same reveal at
      // all. Rather than lock them out of ever seeing the match's own
      // final reveal, let them connect this one more time — same shape as
      // any other returning player — if they're a real participant with an
      // unseen lastManche; anyone else (or a team that's already seen it)
      // gets the normal terminal response.
      const team = address === this.match.playerA ? 'A' : address === this.match.playerB ? 'B' : null;
      const lm = this.match.lastManche;
      if (!team || !lm || lm.seenBy[team]) { this.send(connection, { type: 'notFound' }); connection.close(); return; }
      connection.setState({ team });
      const inboxMessage = await this.consumeInbox(team);
      this.send(connection, { type: 'connected', ...this.snapshotFor(team), inboxMessage });
      return;
    }

    if (address === this.match.playerA) {
      connection.setState({ team: 'A' });
      const inboxMessage = await this.consumeInbox('A');
      this.send(connection, { type: 'connected', ...this.snapshotFor('A'), inboxMessage });
      return;
    }
    if (address === this.match.playerB) {
      connection.setState({ team: 'B' });
      const inboxMessage = await this.consumeInbox('B');
      this.send(connection, { type: 'connected', ...this.snapshotFor('B'), inboxMessage });
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
    // "Match started" = B actually joining (status pending -> active), same
    // definition LIVE uses ("both players present" — see party/arbiter.js).
    // This branch only ever runs once per match (playerB is checked/set
    // right above, and a later reconnect never reaches this far — see this
    // function's own address-match branches earlier), so no extra dedup flag
    // is needed the way LIVE's radarStartedNotified is.
    this.radarNotify('recordMatchStarted', {
      matchId: this.name, mode: 'week', timestampMs: now,
      players: [{ address: this.match.playerA }, { address: this.match.playerB }],
    });
    await Promise.all([this.pushIndexUpdate('A'), this.pushIndexUpdate('B')]);
    // B's very first-ever connection to this match — still a legitimate
    // delivery moment: A could already have left a message for B before B
    // ever joined (see main.js's showWeekFirstShotScreen-era flow, now
    // folded into the same "play immediately on create" entry, which lets A
    // message B from the post-shot waiting screen while B has no code yet).
    const inboxMessage = await this.consumeInbox('B');
    this.send(connection, { type: 'connected', ...this.snapshotFor('B'), inboxMessage });
  }

  async onMessage(connection, message) {
    await this.ready();
    const team = connection.state?.team;
    if ((team !== 'A' && team !== 'B') || !this.match) return;
    let msg; try { msg = JSON.parse(message); } catch { return; }

    if (msg.type === 'shot') {
      // 'pending' allowed too, not just 'active' — lets the creator (team A)
      // play their own first shot before B has even joined (see main.js's
      // hostWeekMatch, folded straight into the same aim flow now). Safe:
      // team can only ever be 'B' once status is already 'active' (onConnect
      // sets both together, see above), so a 'pending' shot can only ever
      // come from A. No message bundled in anymore — see msg.type ===
      // 'message' below, a fully separate, optional, later action.
      if ((this.match.status !== 'active' && this.match.status !== 'pending') || this.match.pendingShots[team]) return;
      this.match.pendingShots[team] = { stones: msg.stones, sweep: msg.sweep || null };
      await this.persist();
      // Per-turn activity, independent of match start/end (see radarNotify's
      // own comment and CLAUDE.md's Radar/WEEK section) — this is what lets
      // a WEEK match spanning several days count each player as "active
      // today" on every day they actually play, without re-counting the
      // match itself as started again.
      this.radarNotify('recordPlayerActive', { address: team === 'A' ? this.match.playerA : this.match.playerB, timestampMs: Date.now() });
      await Promise.all([this.pushIndexUpdate('A'), this.pushIndexUpdate('B')]);
      this.send(connection, { type: 'shotAccepted', ...this.snapshotFor(team) });
      return;
    }

    // A message is addressed to the OTHER team, saved into their inbox slot
    // (see consumeInbox above) — fully decoupled from 'shot' now: reachable
    // any time after this team has already submitted its shot for the
    // current manche (the "YOUR SHOT IS ON THE ICE" screen, see main.js),
    // not gathered before sending. Overwrites whatever undelivered message
    // was already sitting there — a single slot per recipient, not a queue
    // (per explicit request: no unread/multi-message inbox for now).
    if (msg.type === 'message') {
      if (this.match.status !== 'active' && this.match.status !== 'pending') return;
      const text = typeof msg.message === 'string'
        ? Array.from(msg.message.replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 60).join('')
        : '';
      if (!text) return;
      if (!this.match.inbox) this.match.inbox = { A: null, B: null }; // pre-existing match, see consumeInbox
      this.match.inbox[otherTeam(team)] = { text };
      await this.persist();
      this.send(connection, { type: 'messageSent' });
      return;
    }

    // Two genuinely different things used to be one: "report what this
    // manche's outcome was" and "clear the shared slot so the next manche
    // can start" happened together, on whichever team's client called this
    // first — which silently dropped the OTHER team's own reveal (their
    // pendingShots got cleared under them; reconnecting later, `reveal` was
    // already null, they never got to watch what happened). Split here:
    // - bothIn (this team's own pendingShots pair is the not-yet-resolved
    //   one): first-ever report for this exact manche. Commits its outcome
    //   (score, pointManches) authoritatively server-side — scoreA/scoreB
    //   are accumulated here (+1 to whichever team the client says scored,
    //   never overwritten by a client-sent absolute total — see the WEEK
    //   score-persistence bug in conversation), snapshots it into
    //   lastManche for whichever side hasn't watched it yet, and frees
    //   pendingShots immediately so THIS team (who just watched it live)
    //   can carry straight on to their next shot without waiting on the
    //   other side at all.
    // - !bothIn but lastManche exists and this team hasn't seen it: a
    //   straggler independently catching up on an already-resolved manche
    //   (possibly one the other team has since moved several shots past) —
    //   just marks their own seenBy, touches nothing else.
    if (msg.type === 'completeRound') {
      if (this.match.status !== 'active') return;
      const bothIn = !!(this.match.pendingShots.A && this.match.pendingShots.B);
      if (bothIn) {
        const scoredTeam = msg.scoredTeam === 'A' || msg.scoredTeam === 'B' ? msg.scoredTeam : null;
        if (scoredTeam === 'A') this.match.scoreA += 1;
        else if (scoredTeam === 'B') this.match.scoreB += 1;
        const pointScored = !!scoredTeam;
        this.match.pointManches = pointScored ? [] : [...this.match.pointManches, {
          stonesA: this.match.pendingShots.A.stones, sweepA: this.match.pendingShots.A.sweep,
          stonesB: this.match.pendingShots.B.stones, sweepB: this.match.pendingShots.B.sweep,
        }];
        this.match.lastManche = {
          stonesA: this.match.pendingShots.A.stones, sweepA: this.match.pendingShots.A.sweep,
          stonesB: this.match.pendingShots.B.stones, sweepB: this.match.pendingShots.B.sweep,
          seenBy: { A: team === 'A', B: team === 'B' },
        };
        this.match.round += 1;
        this.match.pendingShots = { A: null, B: null };
      } else if (this.match.lastManche && !this.match.lastManche.seenBy[team]) {
        this.match.lastManche.seenBy[team] = true;
      } else {
        return; // nothing pending for this team to report or ack right now
      }
      const target = this.match.config?.pointsToWin || 3;
      const matchOver = this.match.scoreA >= target || this.match.scoreB >= target;
      if (matchOver && this.match.status !== 'completed') {
        this.match.status = 'completed';
        await this.ctx.storage.deleteAlarm();
        this.radarNotify('recordMatchCompleted', { matchId: this.name, mode: 'week', timestampMs: Date.now() });
      }
      await this.persist();
      if (matchOver) {
        await Promise.all([this.removeFromIndex(this.match.playerA), this.removeFromIndex(this.match.playerB)]);
      } else {
        await Promise.all([this.pushIndexUpdate('A'), this.pushIndexUpdate('B')]);
      }
      this.send(connection, { type: 'roundCompleted', ...this.snapshotFor(team) });
      return;
    }

    // Either side can abandon at any point before the match is already
    // over — frees this player's PlayerIndex slot immediately (see
    // conversation: the 2-active-matches cap was blocking testing with no
    // way to bail out of a stuck/unwanted match). A deliberate abandon, not
    // the same thing as the natural 24h/7-day expiry (see onAlarm below),
    // but terminal the same way — same alarm/index cleanup either path.
    if (msg.type === 'abandon') {
      if (this.match.status !== 'pending' && this.match.status !== 'active') return;
      this.match.status = 'abandoned';
      await this.ctx.storage.deleteAlarm();
      await this.persist();
      // Only the abandoning side's own slot frees immediately — the other
      // side (if they'd already joined) isn't silently dropped from their
      // own list, they get told (see conversation: "your opponent has left
      // this game", a grayed row in My Matches) and dismisses it themselves
      // (src/net.js's dismissWeekMatch, a direct PlayerIndex removal — no
      // reconnecting to this now-terminal room needed for that). Their slot
      // stays counted against their own cap until they do.
      const myAddress = team === 'A' ? this.match.playerA : this.match.playerB;
      await this.removeFromIndex(myAddress);
      const oppTeam = otherTeam(team);
      if (this.match[oppTeam === 'A' ? 'playerA' : 'playerB']) await this.pushIndexUpdate(oppTeam);
      this.send(connection, { type: 'abandoned' });
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
