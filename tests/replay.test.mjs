// Covers src/replay.js's binary point format — the thing a ticket's QR codes
// actually carry.
//
// This is here because v1 silently assumed the Classic preset: it wrote however
// many stones a match really had, but always read back exactly six. A Custom
// match with 1 or 2 stones per team therefore produced QR tiles that were
// printed on the ticket and simply could not be decoded — the ?replay= link
// resolved to null and an uploaded ticket reported "no points found". Nothing
// crashed, nothing logged; the feature just didn't work, for one whole class of
// match. A round-trip test is the only thing that catches that shape of bug.
//
// Run with `npm test` (node --test, built in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePoint, decodePoint, MAX_POINTS_ON_TICKET } from '../src/replay.js';

const stones = (n, base) => Array.from({ length: n }, (_, i) => ({
  vx: base + i / 10, vy: -(base + i / 10), used: i % 2 === 0,
}));
const point = (over = {}) => ({
  index: 4, scoringTeam: 'B', isWipeout: true, vibe: 'curling',
  matchConfig: { stonesPerTeam: 3, pointsToWin: 2, curlingCycles: 2, skin: 'summer' },
  manches: [
    { stonesA: stones(3, 1), stonesB: stones(3, 2), sweepA: { x: 1200.4, y: 900.1, r: 80 }, sweepB: null },
    { stonesA: stones(3, 3), stonesB: stones(3, 4), sweepA: null, sweepB: { x: 1500, y: 700, r: 60 } },
  ],
  ...over,
});

test('v2 round-trips every reachable rules combination', () => {
  // 1-3 stones is STONES_OPTIONS; 1-3 cycles is CURLING_CYCLES_OPTIONS; two
  // skins. This is the full matrix a Custom match can actually produce.
  for (const n of [1, 2, 3]) {
    for (const skin of ['summer', 'winter']) {
      for (const cycles of [1, 2, 3]) {
        for (const pts of [1, 2, 3]) {
          const p = point({
            matchConfig: { stonesPerTeam: n, pointsToWin: pts, curlingCycles: cycles, skin },
            manches: [
              { stonesA: stones(n, 1), stonesB: stones(n, 2), sweepA: { x: 1200.4, y: 900.1, r: 80 }, sweepB: null },
              { stonesA: stones(n, 3), stonesB: stones(n, 4), sweepA: null, sweepB: { x: 1500, y: 700, r: 60 } },
            ],
          });
          const out = decodePoint(encodePoint(p));
          const label = `${n} stones / ${skin} / ${cycles} cycles / ${pts} pts`;
          assert.deepEqual(out.matchConfig, p.matchConfig, `config lost for ${label}`);
          assert.equal(out.manches.length, 2, label);
          for (let m = 0; m < 2; m++) {
            for (const side of ['stonesA', 'stonesB']) {
              assert.equal(out.manches[m][side].length, n, `${side} count wrong for ${label}`);
              out.manches[m][side].forEach((s, i) => {
                const want = p.manches[m][side][i];
                // Velocities are int16-quantised at x1000 — exact at these values.
                assert.ok(Math.abs(s.vx - want.vx) < 1e-6, `vx drift for ${label}`);
                assert.ok(Math.abs(s.vy - want.vy) < 1e-6, `vy drift for ${label}`);
                assert.equal(s.used, want.used, `used flag lost for ${label}`);
              });
            }
            assert.deepEqual(out.manches[m].sweepA, p.manches[m].sweepA, `sweepA lost for ${label}`);
            assert.deepEqual(out.manches[m].sweepB, p.manches[m].sweepB, `sweepB lost for ${label}`);
          }
        }
      }
    }
  }
});

test('v2 preserves the point outcome fields', () => {
  for (const scoringTeam of ['A', 'B']) {
    for (const isWipeout of [true, false]) {
      for (const vibe of ['hockey', 'curling']) {
        const out = decodePoint(encodePoint(point({ scoringTeam, isWipeout, vibe, index: 7 })));
        assert.equal(out.scoringTeam, scoringTeam);
        assert.equal(out.isWipeout, isWipeout);
        assert.equal(out.vibe, vibe);
        assert.equal(out.index, 7);
      }
    }
  }
});

test('a v1 blob still decodes — already-shared links and printed tickets', () => {
  // Built byte for byte the way the pre-v2 encoder did: header
  // [version=1, index, outcome, mancheCount], then per manche [flags] plus six
  // stones x (vx, vy) little-endian int16. No config byte at all — reading one
  // would eat the first manche's flags, which is the bug the version branch
  // exists to avoid.
  const bytes = [1, 7, 0b110, 1, 0b00001001];
  for (let i = 0; i < 12; i++) { const v = (i + 1) * 100; bytes.push(v & 0xff, (v >> 8) & 0xff); }
  const b64 = Buffer.from(Uint8Array.from(bytes)).toString('base64url');

  const d = decodePoint(b64);
  assert.equal(d.index, 7);
  assert.equal(d.scoringTeam, 'A');          // outcome bit 0 clear
  assert.equal(d.isWipeout, true);           // bit 1 set
  assert.equal(d.vibe, 'curling');           // bit 2 set
  // v1 only ever existed for 3-stone Classic, so that is what it must imply.
  assert.deepEqual(d.matchConfig, { stonesPerTeam: 3, pointsToWin: 2, curlingCycles: 2, skin: 'summer' });
  const m = d.manches[0];
  assert.equal(m.stonesA.length, 3);
  assert.equal(m.stonesB.length, 3);
  assert.deepEqual(m.stonesA.map((s) => s.vx), [0.1, 0.3, 0.5]);
  assert.deepEqual(m.stonesB.map((s) => s.vy), [0.8, 1, 1.2]);
  assert.equal(m.stonesA[0].used, true);     // flags bit 0
  assert.equal(m.stonesA[1].used, false);
  assert.equal(m.stonesB[0].used, true);     // flags bit 3
  assert.equal(m.sweepA, null);
  assert.equal(m.sweepB, null);
});

test('V1_IMPLIED_CONFIG is frozen history, not a mirror of today\'s preset', () => {
  // If this ever starts tracking DEFAULT_MATCH_CONFIG, changing the Classic
  // preset would retroactively rewrite what every already-printed ticket means.
  const bytes = [1, 0, 0, 1, 0];
  for (let i = 0; i < 12; i++) bytes.push(0, 0);
  const d = decodePoint(Buffer.from(Uint8Array.from(bytes)).toString('base64url'));
  assert.equal(d.matchConfig.stonesPerTeam, 3);
  assert.equal(d.matchConfig.pointsToWin, 2);
  assert.equal(d.matchConfig.curlingCycles, 2);
  assert.equal(d.matchConfig.skin, 'summer');
});

test('a point stays small enough for a single QR code', () => {
  // The whole design rests on a point fitting in one QR tile. A 6-manche point
  // is already a long one in practice.
  const long = point({
    manches: Array.from({ length: 6 }, (_, i) => ({
      stonesA: stones(3, i + 1), stonesB: stones(3, i + 2),
      sweepA: { x: 1200, y: 900, r: 80 }, sweepB: { x: 1500, y: 700, r: 60 },
    })),
  });
  const encoded = encodePoint(long);
  assert.ok(encoded.length < 400, `6-manche point encodes to ${encoded.length} chars, too long for a QR tile`);
  assert.equal(decodePoint(encoded).manches.length, 6);
});

test('a missing matchConfig falls back instead of throwing', () => {
  // recorder.js always supplies one now, but an older in-memory point (or a
  // caller that forgets) must not produce a corrupt blob.
  const out = decodePoint(encodePoint(point({ matchConfig: undefined })));
  assert.equal(out.matchConfig.stonesPerTeam, 3);
  assert.equal(out.manches[0].stonesA.length, 3);
});

test('MAX_POINTS_ON_TICKET matches the ticket art', () => {
  assert.equal(MAX_POINTS_ON_TICKET, 5);
});
