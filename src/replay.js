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
// TICKET_H is always this fixed value, whether or not a given ticket actually
// has points to show — decodePointsFromTicketImage() below normalizes any
// uploaded image to exactly TICKET_W x TICKET_H before cropping the fixed
// tile rects, so the layout (and this height) must never vary per-ticket.
export const MAX_POINTS_ON_TICKET = 5;
export const TICKET_W = 1080;
export const POINTS_SECTION_Y = 1570; // right after the stats panel
export const POINTS_SECTION_H = 240;
export const TICKET_H = POINTS_SECTION_Y + POINTS_SECTION_H + 30 + 70 + 30 + 250; // = 2190, see ticket.js's partnerY/footerY cascade
const POINT_TILE_W = 180;
const POINT_QR_SIZE = 130;

export function pointTileRect(i) {
  const totalW = MAX_POINTS_ON_TICKET * POINT_TILE_W;
  const marginX = (TICKET_W - totalW) / 2;
  const tileX = marginX + i * POINT_TILE_W;
  const qrX = Math.round(tileX + (POINT_TILE_W - POINT_QR_SIZE) / 2);
  const qrY = POINTS_SECTION_Y + 46;
  return { tileX, tileW: POINT_TILE_W, qrX, qrY, size: POINT_QR_SIZE };
}

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

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}
