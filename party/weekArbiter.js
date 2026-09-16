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
import { CURRENT_SEASON_ID, isClassicMatchConfig } from './leagueRating.js';

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
        // The board THIS reveal starts from, bound to the reveal rather than
        // sent alongside it, so the client has one unconditional rule
        // whichever of the two sources it came from (see the client's own
        // revealResumeManchesFor). Here the manche is still unresolved, so
        // pointManches describes exactly the board before it — no snapshot
        // needed.
        priorManches: m.pointManches,
        // Not yet resolved, so the live score is already the pre-manche one.
        priorScoreA: m.scoreA, priorScoreB: m.scoreB,
      };
    } else if (lm && !lm.seenBy[team]) {
      reveal = {
        mine: team === 'A' ? { stones: lm.stonesA, sweep: lm.sweepA } : { stones: lm.stonesB, sweep: lm.sweepB },
        opponent: team === 'A' ? { stones: lm.stonesB, sweep: lm.sweepB } : { stones: lm.stonesA, sweep: lm.sweepA },
        // Already resolved, so pointManches has moved on — this is the
        // snapshot completeRound took before it did (see lastManche's own
        // priorManches comment). null for a match persisted before this
        // field existed; the client falls back for those.
        priorManches: lm.priorManches ?? null,
        // null for a match persisted before these existed — the client falls
        // back to the live score there, as it always did.
        priorScoreA: lm.priorScoreA ?? null, priorScoreB: lm.priorScoreB ?? null,
      };
    }
    return {
      game: m.game, config: m.config, status: m.status,
      round: m.round, scoreA: m.scoreA, scoreB: m.scoreB,
      team, opponentAddress: team === 'A' ? m.playerB : m.playerA,
      createdAt: m.createdAt, joinDeadline: m.joinDeadline, joinedAt: m.joinedAt, expiresAt: m.expiresAt,
      completedAt: m.completedAt, stats: m.stats || { collisions: 0, stonesDestroyed: 0 },
      // League Beta (see completeRound's own comment) — null until/unless
      // this match actually qualified and the RPC resolved; once set it's
      // persisted, so it keeps showing up here on any later reconnect too.
      leagueLp: m.leagueResult ? m.leagueResult[team] : null,
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
    // A completed match still owes its deciding reveal to whichever side has
    // not watched it (onConnect keeps a grace connection open for exactly
    // that) — so it stays actionable in My Matches rather than reading as
    // "Finished", and its row is only dropped once they have seen it.
    if (m.status === 'completed' && m.lastManche && !m.lastManche.seenBy[team]) return 'revealReady';
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

  // League Beta (party/leagueSeason.js) — same RPC shape as radarNotify
  // above, pointed at the season's own Durable Object instead.
  leagueNotify(method, payload) {
    if (!this.env?.LeagueSeason) return;
    getServerByName(this.env.LeagueSeason, CURRENT_SEASON_ID)
      .then((league) => league[method](payload))
      .catch((err) => console.error(`[league] ${method} failed:`, err));
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
        createdAt: now, joinDeadline: now + JOIN_WINDOW_MS, joinedAt: null, expiresAt: null, completedAt: null,
        round: 0, scoreA: 0, scoreB: 0,
        pendingShots: { A: null, B: null },
        // Match-ticket running stats (see main.js's showWeekMatchTicket) —
        // accumulated across the whole match, potentially several sessions
        // over several days, unlike LIVE/local's own totalCollisions/
        // stonesDestroyed which live entirely inside one game.js instance
        // (see completeRound's own comment on why this has to be
        // server-side at all for WEEK).
        stats: { collisions: 0, stonesDestroyed: 0 },
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
      // 'completed' allowed through for one specific case: the side that
      // never saw the deciding manche, acking it. Without this their seenBy
      // could never be set, so they would sit in My Matches forever (see the
      // matchOver branch below) and be re-offered the same reveal on every
      // visit.
      const pendingFinalAck = this.match.status === 'completed'
        && this.match.lastManche && !this.match.lastManche.seenBy[team];
      if (this.match.status !== 'active' && !pendingFinalAck) return;
      const bothIn = !!(this.match.pendingShots.A && this.match.pendingShots.B);
      if (bothIn) {
        const scoredTeam = msg.scoredTeam === 'A' || msg.scoredTeam === 'B' ? msg.scoredTeam : null;
        if (scoredTeam === 'A') this.match.scoreA += 1;
        else if (scoredTeam === 'B') this.match.scoreB += 1;
        const pointScored = !!scoredTeam;
        // Match-ticket running stats (see main.js's showWeekMatchTicket) —
        // this manche's own delta, reported by whichever client actually
        // just computed it (see net.js's own completeRound comment: the
        // OTHER side's later "I've watched it too" ack falls into the
        // pendingFinalAck/lastManche branch below, never this one, so its
        // own copy of these same deltas is never double-applied here).
        this.match.stats.collisions += Math.max(0, Number(msg.collisionsDelta) || 0);
        this.match.stats.stonesDestroyed += Math.max(0, Number(msg.stonesDestroyedDelta) || 0);
        // The board this manche was played FROM — captured before the line
        // below reassigns pointManches, and carried on lastManche so a
        // straggler can reconstruct it (see lastManche's own priorManches
        // comment). Safe as a plain reference, no clone: that line
        // reassigns pointManches to a brand new array rather than mutating
        // this one in place, so what's captured here can never change under
        // us afterwards.
        const priorManches = this.match.pointManches;
        // Same idea as priorManches, for the other half of the state a
        // reveal starts from. Captured before the increments above land.
        const priorScoreA = this.match.scoreA - (scoredTeam === 'A' ? 1 : 0);
        const priorScoreB = this.match.scoreB - (scoredTeam === 'B' ? 1 : 0);
        this.match.pointManches = pointScored ? [] : [...this.match.pointManches, {
          stonesA: this.match.pendingShots.A.stones, sweepA: this.match.pendingShots.A.sweep,
          stonesB: this.match.pendingShots.B.stones, sweepB: this.match.pendingShots.B.sweep,
        }];
        this.match.lastManche = {
          stonesA: this.match.pendingShots.A.stones, sweepA: this.match.pendingShots.A.sweep,
          stonesB: this.match.pendingShots.B.stones, sweepB: this.match.pendingShots.B.sweep,
          seenBy: { A: team === 'A', B: team === 'B' },
          // The manches of this point that were already resolved BEFORE this
          // one — i.e. the board this manche started from. pointManches on
          // its own cannot answer that for a straggler: by the time they
          // connect it has either grown to INCLUDE this manche (a no-goal
          // settle, so replaying it would apply this manche twice) or been
          // emptied (a scoring settle, so replaying it would start from the
          // bare rack instead of wherever the point had actually got to).
          // Both were real, measured bugs. Same shape as pointManches, so
          // src/weekController.js feeds it straight to game.js's
          // resumeManches with no translation.
          //
          // Written once, here, where lastManche itself is built, and never
          // mutated afterwards (unlike seenBy just above) — its lifetime is
          // exactly its manche's lifetime as lastManche. Deliberately not
          // cleared once both teams have watched: nothing reads it again by
          // then, and clearing it would cost the write-once property for
          // nothing.
          priorManches,
          // The score as it stood BEFORE this manche. A straggler's snapshot
          // already counts it (the first reporter's completeRound bumped it),
          // so seeding their engine with the live score and then letting them
          // watch the manche score again showed the opponent a goal ahead for
          // the rest of the sitting (reported).
          priorScoreA, priorScoreB,
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
        // Match-ticket duration (see main.js's showWeekMatchTicket) —
        // completedAt - joinedAt, the real calendar span the match was open
        // for (there's no reliable notion of "active play time" across
        // several days/sessions the way a single continuous LIVE/local
        // session's own matchStartTime has — see conversation). Written once
        // here rather than computed as `Date.now() - joinedAt` on every read
        // so a later revisit reports the exact same duration, not a growing one.
        this.match.completedAt = Date.now();
        await this.ctx.storage.deleteAlarm();
        this.radarNotify('recordMatchCompleted', { matchId: this.name, mode: 'week', timestampMs: Date.now() });
        // League Beta (party/leagueSeason.js) — WEEK already structurally
        // guarantees "both players actually connected" right here: scoreA/
        // scoreB can only ever move inside the `bothIn` branch above, which
        // itself requires both pendingShots.A AND pendingShots.B to have
        // been submitted at least once — i.e. B must have actually joined
        // and played (see this.match.playerB, set only once B joins in
        // onConnect's 'join' branch below). WEEK also requires a connected
        // wallet on BOTH sides unconditionally (no guest mode at all — see
        // this file's own header comment), so unlike LIVE there's no
        // separate address check needed. Classic-ruleset-only per scope
        // decision — this.match.config is whatever the creator's client
        // sent verbatim at intent==='create' time (see onConnect above),
        // same trust model as every other client-sent field this file
        // already treats as opaque.
        if (this.match.playerA && this.match.playerB && isClassicMatchConfig(this.match.config)) {
          const winner = this.match.scoreA >= target ? 'A' : 'B';
          // Awaited (not fire-and-forget like radarNotify above) — WEEK has
          // no live push the way LIVE's arbiter does (see this file's own
          // header comment), so the ticket's league stamp (main.js's
          // showWeekMatchTicket) has no channel to learn the result on EXCEPT
          // this same completeRound response, via snapshotFor's leagueLp
          // below. Persisted either way so a later straggler reconnecting to
          // watch this same deciding manche also gets it (see snapshotFor).
          const result = await this.leagueNotify('recordMatchCompleted', {
            // 'week:' prefix keeps this globally distinct from LIVE's own
            // 'live:'-prefixed ids (see party/arbiter.js) even though match
            // codes are drawn from the same 4-character space.
            leagueMatchId: `week:${this.name}`, mode: 'week', timestampMs: Date.now(),
            playerA: { address: this.match.playerA }, playerB: { address: this.match.playerB }, winner,
          });
          if (result?.ok && !result.duplicate) {
            this.match.leagueResult = { A: result.lpAwardedA, B: result.lpAwardedB };
          }
        }
      }
      await this.persist();
      if (matchOver) {
        // Not both at once any more: removing the row of a player who still
        // has the final reveal to watch takes away their only route back to
        // it (reported — the match vanished before the last team could see
        // how it ended). They keep a row, labelled actionable by
        // turnLabelFor, until their own ack above lands.
        const lm = this.match.lastManche;
        await Promise.all(['A', 'B'].map((t) => {
          const address = t === 'A' ? this.match.playerA : this.match.playerB;
          if (!address) return null;
          return lm && !lm.seenBy[t] ? this.pushIndexUpdate(t) : this.removeFromIndex(address);
        }));
      } else {
        await Promise.all([this.pushIndexUpdate('A'), this.pushIndexUpdate('B')]);
      }
      this.send(connection, { type: 'roundCompleted', ...this.snapshotFor(team) });
      return;
    }

    // Either side can abandon at any point before the match is already
    // over — frees this player's PlayerIndex slot immediately (see
    // conversation: the active-matches cap was blocking testing with no
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

  // Plain HTTP GET (no WebSocket) — lets a client find out whether a 4-char
  // code belongs to a real WEEK match BEFORE it has any wallet address to
  // open a WS connection with. onConnect above requires `address` on every
  // connect attempt and rejects with 'addressRequired' before ever checking
  // this.match — so a disconnected/guest client had no way to distinguish
  // "this is a real WEEK code, go connect a wallet" from "no such code
  // anywhere" without this. Fixes the bug where a guest typing a friend's
  // real WEEK code was silently dropped into a brand-new, unrelated LIVE
  // room instead (see src/main.js's joinWithCode/showWeekConnectToJoinPanel
  // and CLAUDE.md's Arbiter.onConnect comment for why LIVE can't tell a
  // reused code apart from a fresh one on its own).
  // Existence only, deliberately no player-identifying data in the
  // response — same "yes, this code exists" sensitivity level as LIVE's own
  // guest-anyone-can-connect behavior, just answered without opening a
  // socket. `exists` reflects whether a match was EVER created under this
  // code, regardless of its current status (pending/active/expired/
  // abandoned/completed) — a connected client still gets the real
  // notFound/expired/full/etc. distinction from the normal WS join path
  // (see openWeekSocket in src/net.js); this endpoint only needs to answer
  // "is this a WEEK code at all". Same CORS/response shape as
  // party/playerIndex.js's and party/leagueSeason.js's own onRequest.
  async onRequest(request) {
    await this.ready();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    return Response.json({ exists: !!this.match }, { headers: cors });
  }
}
