// Replay encoding: a "point" is every manche (aim+reveal exchange) leading up
// to one scored point (goal or wipeout — see CLAUDE.md vocabulary: manche <
// point < match). Points are packed to a small binary blob, base64url-encoded,
// and embedded either in a `?replay=` link/QR (one point) or as one QR tile
// per point baked onto the ticket image (see POINT_QR layout below, shared
// with ticket.js for drawing and this module for decoding an uploaded ticket).
//
// Velocities are quantized to int16 (x1000) — bounded by MAX_DRAG*POWER_SCALE
// (~9.3 in game.js), so this keeps far more precision than a drag gesture
// has to begin with. Sweep x/y/r are quantized to int16 (x10), bounded by the
// 1200x905 board. This is what makes a whole point fit comfortably in a QR:
// a few dozen bytes per point, not the few hundred a naive JSON blob would take.

import jsQR from 'jsqr';

const VERSION = 1;
const SCALE_V = 1000;
const SCALE_POS = 10;

// ---------- Ticket layout (also used by ticket.js to draw QR tiles) ----------
// public/ticket/polaroid.webp (baked from design/Polaroid ticket 4.png, a
// hand-designed template — see conversation) IS the ticket, full-bleed: the
// polaroid photo, stat icons/labels, the separator, 5 dashed QR placeholders
// (each pre-numbered) and a dashed sponsor banner slot (with the "THIS MATCH
// WAS SPONSORED BY" notch already baked in) are all static art. ticket.js
// draws every *dynamic* piece into the empty slots/areas this art reserves:
// identicons/addresses + score, the 3 stat values, the "upload to relive"
// label (ticket 4 ships this blank — ticket 3 had different wording baked
// in), the QR codes, and the sponsor banner image. Every position below is
// hand-measured against that same 1448x1086 art (same pattern as game.js's
// arena FX0/FY0/etc — see CLAUDE.md's Coordinate system section), scaled by
// SCALE. Only the numbers decodePointsFromTicketImage() actually needs (to
// normalize an uploaded ticket and crop the same fixed QR rects) are
// load-bearing for decode; the rest is purely where things get drawn.
export const MAX_POINTS_ON_TICKET = 5;

const NATIVE_W = 1448, NATIVE_H = 1086; // exactly 4:3
export const SCALE = 1.2; // drawn a bit above native res for crisper text/QR
export const TICKET_W = Math.round(NATIVE_W * SCALE);
export const TICKET_H = Math.round(NATIVE_H * SCALE);

const s = (n) => Math.round(n * SCALE);

// ---- Identicon/guest-icon + score row (between the photo and the stats
// row) — bleue/jaune/tiret are hidden XCF layers (design/ticket-guest-*.png,
// this file's own dash) marking where the guest hexagon icons and the score
// dash go; a real identicon reuses the same icon slot. ----
export const ICON_A_CX = s(581), ICON_A_CY = s(563), ICON_A_R = s(37);
export const ICON_B_CX = s(866), ICON_B_CY = s(565), ICON_B_R = s(40);
export const DASH_CX = s(724), DASH_CY = s(565), DASH_W = s(32), DASH_H = s(4);
// The icon-to-stats-row gap is too tight (~10-15px native) for a text line
// underneath the icon, so the address/handle/guest-code sits beside it
// instead — see ticket.js, which anchors it off ICON_A_CX-ICON_A_R (right-
// aligned) / ICON_B_CX+ICON_B_R (left-aligned), vertically centered on the
// icon itself.
export const ADDR_GAP = s(14);

// ---- Stats row (duration / collisions / destroyed) — icons + labels are
// baked in; only the value line below each label is drawn at runtime. ----
export const STATS_COL_CX = [s(469), s(725), s(987)];
export const STATS_VALUE_Y = s(722); // baseline

// ---- Replay QR row — 5 dashed placeholder boxes, pre-numbered in the art
// (hand-measured per-box outline: ~100x87 native, top edge at y=787). The
// white backing fill is a few px larger than that on every side (but capped
// short of the number badge baked in just below each box) so it fully
// occludes the dashed outline — see conversation: it used to leave a sliver
// of dash showing since the fill was smaller than the real box. The QR code
// itself is rendered at the largest *integer* qrcode "scale" (pixels per
// module) that still fits inside QR_CODE_SIZE, centered — tested empirically
// against the real qrcode/jsQR round-trip (see git history): fixed
// non-integer pixel widths cause seam artifacts that fail unpredictably, but
// an integer module scale never does, at any size. ----
const QR_BOX_W_N = 100, QR_BOX_H_N = 87, QR_BOX_TOP_N = 787, QR_BOX_LEFT0_N = 364, QR_BOX_STEP_N = 155.25;
const QR_FILL_PAD_SIDE_N = 3, QR_FILL_PAD_TOP_N = 3, QR_FILL_PAD_BOTTOM_N = 2; // bottom stays clear of the badge
export const QR_FILL_W = s(QR_BOX_W_N + QR_FILL_PAD_SIDE_N * 2);
export const QR_FILL_H = s(QR_BOX_H_N + QR_FILL_PAD_TOP_N + QR_FILL_PAD_BOTTOM_N);
export const QR_CODE_SIZE = s(78);
const QR_BOX_STEP = s(QR_BOX_STEP_N);

export function pointTileRect(i) {
  const tileLeftN = QR_BOX_LEFT0_N + i * QR_BOX_STEP_N;
  const boxCxN = tileLeftN + QR_BOX_W_N / 2, boxCyN = QR_BOX_TOP_N + QR_BOX_H_N / 2;
  const tileX = s(tileLeftN);
  return {
    tileX, tileY: s(QR_BOX_TOP_N), tileW: QR_BOX_STEP, tileH: QR_FILL_H,
    fillX: s(tileLeftN - QR_FILL_PAD_SIDE_N), fillY: s(QR_BOX_TOP_N - QR_FILL_PAD_TOP_N), fillW: QR_FILL_W, fillH: QR_FILL_H,
    qrX: s(boxCxN) - QR_CODE_SIZE / 2, qrY: s(boxCyN) - QR_CODE_SIZE / 2, size: QR_CODE_SIZE,
  };
}

// ---- Sponsor banner — the box itself is a plain rounded rect; the banner
// image fills it edge-to-edge, full height, at its own true ratio (no crop,
// no stretch). The "THIS MATCH WAS SPONSORED BY" tab is *not* carved out of
// the banner or avoided by it — the dashed placeholder's own tab visibly
// overlaps/intrudes into the box's top edge (see conversation: "il doit
// recouvrir une partie de la banniere... être intrusif"), so it's redrawn
// from the original template ON TOP of the banner, clipped to that same
// small trapezoid, exactly reproducing that overlap. ----
const BOX_LEFT_N = 328, BOX_RIGHT_N = 1120;
const BOX_TOP_N = 936;
// Bottom extended a bit past the dashed box's own footprint (1008) into
// blank matching background, still short of the card's real edge (solid
// content runs out around y=1032, see conversation: "pas collée au bord").
const BOX_BOTTOM_N = 1028;
const BOX_RADIUS_N = 11;

const BANNER_RATIO = 4; // banner-nimiq-space.webp is exactly 1200x300
const BANNER_H_N = BOX_BOTTOM_N - BOX_TOP_N;
const BANNER_W_N = BANNER_H_N * BANNER_RATIO;
const BANNER_CX_N = (BOX_LEFT_N + BOX_RIGHT_N) / 2; // box's own horizontal center
export const BANNER_X = s(BANNER_CX_N - BANNER_W_N / 2), BANNER_Y = s(BOX_TOP_N);
export const BANNER_W = s(BANNER_W_N), BANNER_H = s(BANNER_H_N);
export const BANNER_RADIUS = s(10); // the banner image itself is clipped to rounded corners

// A few px of margin beyond the box's own measured bounds — its dash stroke
// is centered *on* that boundary, so a wipe sized to match it exactly still
// leaves half the stroke width peeking out (see conversation).
const WIPE_PAD_N = 4;
export const BANNER_WIPE_X = s(BOX_LEFT_N - WIPE_PAD_N), BANNER_WIPE_Y = s(BOX_TOP_N - WIPE_PAD_N);
export const BANNER_WIPE_W = s(BOX_RIGHT_N - BOX_LEFT_N + WIPE_PAD_N * 2);
export const BANNER_WIPE_H = s(BOX_BOTTOM_N - BOX_TOP_N + WIPE_PAD_N * 2);
export const BANNER_WIPE_RADIUS = s(BOX_RADIUS_N + WIPE_PAD_N);

// The "sponsored by" tab: redrawn from the original template on top of the
// banner so it overlaps into the box's top edge exactly like the dashed
// placeholder's own tab does. Its two sides are one continuous S-curve each
// (a cubic bezier with a horizontal tangent at both ends — smoothly leaving
// the flat top edge, smoothly arriving on the flat shelf) rather than a
// straight diagonal with small corner fillets, which still read as
// "multi-angle" (see conversation) — this matches the soft, single-curve
// transition in the original chatgpt mockup instead. Anchor points are
// hand-measured off the art pixel by pixel: top edge sits a few px above the
// box's own top edge (936) — the text's cap-height itself pokes a couple px
// above it — down to the shelf where the text/tab dashes actually sit.
const TAB_TOP_Y_N = 930, TAB_SHELF_Y_N = 957;
const TAB_TOP_LEFT_N = 579, TAB_SHELF_LEFT_N = 599;
const TAB_SHELF_RIGHT_N = 851, TAB_TOP_RIGHT_N = 871;
export function traceBannerTabPath(ctx) {
  const topY = s(TAB_TOP_Y_N), shelfY = s(TAB_SHELF_Y_N);
  const tl = s(TAB_TOP_LEFT_N), sl = s(TAB_SHELF_LEFT_N);
  const sr = s(TAB_SHELF_RIGHT_N), tr = s(TAB_TOP_RIGHT_N);
  const kL = (sl - tl) / 2, kR = (tr - sr) / 2;
  ctx.beginPath();
  ctx.moveTo((tr + tl) / 2, topY);
  ctx.lineTo(tl, topY);
  ctx.bezierCurveTo(tl + kL, topY, sl - kL, shelfY, sl, shelfY);
  ctx.lineTo(sr, shelfY);
  ctx.bezierCurveTo(sr + kR, shelfY, tr - kR, topY, tr, topY);
  ctx.closePath();
}

// ---- "Upload to relive" label — public/ticket/polaroid.webp (design/
// Polaroid ticket 4.png) ships with this text area left blank, unlike the
// version before it, so this is drawn at runtime like everything else here. ----
export const UPLOAD_LABEL_CX = s(724), UPLOAD_LABEL_Y = s(775);

// ---------- base64url <-> bytes ----------
function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- point <-> bytes ----------
function packManche(bytes, manche) {
  const { stonesA, stonesB, sweepA, sweepB } = manche;
  let flags = 0;
  stonesA.forEach((s, i) => { if (s.used) flags |= (1 << i); });
  stonesB.forEach((s, i) => { if (s.used) flags |= (1 << (3 + i)); });
  if (sweepA) flags |= (1 << 6);
  if (sweepB) flags |= (1 << 7);
  bytes.push(flags);
  for (const s of [...stonesA, ...stonesB]) {
    pushInt16(bytes, Math.round(s.vx * SCALE_V));
    pushInt16(bytes, Math.round(s.vy * SCALE_V));
  }
  if (sweepA) pushSweep(bytes, sweepA);
  if (sweepB) pushSweep(bytes, sweepB);
}

function pushSweep(bytes, sweep) {
  pushInt16(bytes, Math.round(sweep.x * SCALE_POS));
  pushInt16(bytes, Math.round(sweep.y * SCALE_POS));
  pushInt16(bytes, Math.round(sweep.r * SCALE_POS));
}

function pushInt16(bytes, value) {
  const v = Math.max(-32768, Math.min(32767, value)) & 0xffff;
  bytes.push(v & 0xff, (v >> 8) & 0xff);
}

function readInt16(view, offset) {
  return view.getInt16(offset, true);
}

export function encodePoint(point) {
  const bytes = [];
  bytes.push(VERSION, point.index & 0xff);
  let outcome = point.scoringTeam === 'B' ? 1 : 0;
  if (point.isWipeout) outcome |= 2;
  bytes.push(outcome, point.manches.length & 0xff);
  for (const manche of point.manches) packManche(bytes, manche);
  return bytesToBase64Url(Uint8Array.from(bytes));
}

export function decodePoint(base64url) {
  const raw = base64UrlToBytes(base64url);
  const view = new DataView(raw.buffer);
  let offset = 0;
  const version = raw[offset++]; // eslint-disable-line no-unused-vars
  const index = raw[offset++];
  const outcome = raw[offset++];
  const mancheCount = raw[offset++];
  const scoringTeam = (outcome & 1) ? 'B' : 'A';
  const isWipeout = !!(outcome & 2);
  const manches = [];
  for (let m = 0; m < mancheCount; m++) {
    const flags = raw[offset++];
    const readStone = (bit) => {
      const vx = readInt16(view, offset) / SCALE_V; offset += 2;
      const vy = readInt16(view, offset) / SCALE_V; offset += 2;
      return { vx, vy, used: !!(flags & (1 << bit)) };
    };
    const stonesA = [readStone(0), readStone(1), readStone(2)];
    const stonesB = [readStone(3), readStone(4), readStone(5)];
    const readSweep = () => {
      const x = readInt16(view, offset) / SCALE_POS; offset += 2;
      const y = readInt16(view, offset) / SCALE_POS; offset += 2;
      const r = readInt16(view, offset) / SCALE_POS; offset += 2;
      return { x, y, r };
    };
    const sweepA = (flags & (1 << 6)) ? readSweep() : null;
    const sweepB = (flags & (1 << 7)) ? readSweep() : null;
    manches.push({ stonesA, stonesB, sweepA, sweepB });
  }
  return { index, scoringTeam, isWipeout, manches };
}

// ---------- URL / magic link ----------
export function buildReplayUrl(point) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}?replay=${encodePoint(point)}`;
}

export function parseReplayFromLocation() {
  const raw = new URLSearchParams(location.search).get('replay');
  if (!raw) return null;
  try {
    return decodePoint(raw);
  } catch {
    return null;
  }
}

// ---------- Decoding QR tiles from an uploaded ticket image ----------
// The ticket layout is fixed (see pointTileRect above), so rather than doing
// general multi-QR detection in one image (most lightweight QR libs, jsQR
// included, only find a single code per scan), we normalize the uploaded
// image to the ticket's own canvas size and crop+scan each known tile rect
// individually.
export async function decodePointsFromTicketImage(imgOrBlob) {
  const img = imgOrBlob instanceof HTMLImageElement ? imgOrBlob : await blobToImage(imgOrBlob);
  const canvas = document.createElement('canvas');
  canvas.width = TICKET_W;
  canvas.height = TICKET_H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, TICKET_W, TICKET_H);

  const points = [];
  for (let i = 0; i < MAX_POINTS_ON_TICKET; i++) {
    const rect = pointTileRect(i);
    const imageData = ctx.getImageData(rect.qrX, rect.qrY, rect.size, rect.size);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    if (!result) continue;
    try {
      const url = new URL(result.data);
      const raw = url.searchParams.get('replay');
      if (raw) points.push(decodePoint(raw));
    } catch {
      // not a valid replay link in this tile — skip
    }
  }
  points.sort((a, b) => a.index - b.index);
  return points;
}

// Revokes the object URL on both paths once the decode has settled — the
// bitmap is already in memory by then, so the blob URL is dead weight the
// browser would otherwise hold until the page unloaded (one leak per
// uploaded ticket). Same pattern as src/identicons.js's own rasterize().
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}
