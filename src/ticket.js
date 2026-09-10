// Match-end "ticket" — a single portrait image that doubles as the in-game
// victory panel and the shareable result image (see showVictory() in
// game.js). Deliberately does NOT capture a real screenshot of the match:
// timing a live frame grab to always land on something visually striking
// (stones + laser trail in frame) can't be guaranteed, so instead this reuses
// one hand-picked "hero" crop (public/ticket/hero.webp, sourced from
// design/ticket capture.png) on every ticket — same idea as a sports card
// using staged art rather than a real in-game photo for the templated part.
import { getIdenticonCanvas } from './identicons.js';
import QRCode from 'qrcode';
import {
  buildReplayUrl, pointTileRect, MAX_POINTS_ON_TICKET,
  TICKET_W, TICKET_H, MARGIN_X, CONTENT_W, HEADER_H, CONTENT_Y,
  PLAYERS_H, HERO_Y, HERO_H, QR_ROW_Y, QR_ROW_H,
  STATS_Y, STATS_H, SPONSOR_LABEL_Y, BANNER_Y, BANNER_H, FOOTER_Y, FOOTER_H,
} from './replay.js';
import { COLORS } from './colors.js';

const ASSET_BASE = import.meta.env.BASE_URL;
const HERO_SRC = `${ASSET_BASE}ticket/hero.webp`;
const BANNER_SRC = `${ASSET_BASE}ticket/banner-nimiq-space.webp`;

const W = TICKET_W, H = TICKET_H;

let heroImgPromise = null;
let bannerImgPromise = null;
export function preloadTicketAssets() {
  if (!heroImgPromise) heroImgPromise = loadImage(HERO_SRC);
  if (!bannerImgPromise) bannerImgPromise = loadImage(BANNER_SRC);
  return Promise.all([heroImgPromise, bannerImgPromise]);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// "NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG" -> "NQ16...1LJG" — never the
// full address, per the design brief (privacy).
function shortenAddress(address) {
  const groups = address.trim().split(/\s+/);
  if (groups.length < 2) return address;
  return `${groups[0]}...${groups[groups.length - 1]}`;
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function drawCircularImage(ctx, img, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

function drawCenteredText(ctx, text, x, y, font, color) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
}

function drawStatTile(ctx, cx, cy, icon, label, value) {
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.inkDim;
  ctx.font = `700 22px 'Mulish', Arial, sans-serif`;
  ctx.fillText(`${icon}  ${label}`, cx, cy);
  ctx.fillStyle = COLORS.ink;
  ctx.font = `800 40px 'Mulish', Arial, sans-serif`;
  ctx.fillText(value, cx, cy + 48);
}

export async function renderTicket({ scoreA, scoreB, teamA, teamB, winner, stats, points = [] }) {
  await document.fonts.ready;
  const [[heroImg, bannerImg], identiconA, identiconB] = await Promise.all([
    preloadTicketAssets(),
    getIdenticonCanvas(teamA.address),
    getIdenticonCanvas(teamB.address),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Background
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, COLORS.bgDeep);
  bgGrad.addColorStop(1, '#081420');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // ---------- Header: wordmark + "MATCH RESULT", full width ----------
  drawCenteredText(ctx, 'NIM-CURL', W / 2, 36, `800 30px 'Mulish', Arial, sans-serif`, COLORS.accent);
  drawCenteredText(ctx, 'MATCH RESULT', W / 2, 58, `700 15px 'Mulish', Arial, sans-serif`, COLORS.inkDim);

  // ---------- Players + score row (single row: avatar, score, avatar) ----------
  const avatarR = 44;
  const rowY = CONTENT_Y + PLAYERS_H / 2 + 4;
  const colAx = MARGIN_X + CONTENT_W * 0.12, colBx = MARGIN_X + CONTENT_W * 0.88;
  for (const [team, cx, img, addr, color] of [
    ['A', colAx, identiconA, teamA.address, COLORS.teamA],
    ['B', colBx, identiconB, teamB.address, COLORS.teamB],
  ]) {
    if (team === winner) {
      ctx.beginPath();
      ctx.arc(cx, rowY, avatarR + 6, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      drawCenteredText(ctx, '\u{1F3C6}', cx, rowY - avatarR - 12, `24px 'Mulish', Arial, sans-serif`, color);
    }
    drawCircularImage(ctx, img, cx, rowY, avatarR);
    drawCenteredText(ctx, shortenAddress(addr), cx, rowY + avatarR + 26, `600 17px 'Mulish', Arial, sans-serif`, COLORS.inkDim);
  }

  ctx.font = `800 68px 'Mulish', Arial, sans-serif`;
  const scoreAText = String(scoreA), scoreBText = String(scoreB), sep = '  -  ';
  const wA = ctx.measureText(scoreAText).width;
  const wSep = ctx.measureText(sep).width;
  const wB = ctx.measureText(scoreBText).width;
  const scoreTotalW = wA + wSep + wB;
  let cursor = W / 2 - scoreTotalW / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.teamA;
  ctx.fillText(scoreAText, cursor, rowY + 22); cursor += wA;
  ctx.fillStyle = COLORS.inkDim;
  ctx.fillText(sep, cursor, rowY + 22); cursor += wSep;
  ctx.fillStyle = COLORS.teamB;
  ctx.fillText(scoreBText, cursor, rowY + 22);

  // ---------- Hero band (center-crop, no distortion) — deliberately compact,
  // not the dominant element (see conversation), full content width ----------
  const heroTargetRatio = CONTENT_W / HERO_H;
  const srcRatio = heroImg.width / heroImg.height;
  let sx, sy, sw, sh;
  if (srcRatio > heroTargetRatio) {
    sh = heroImg.height; sw = sh * heroTargetRatio; sx = (heroImg.width - sw) / 2; sy = 0;
  } else {
    sw = heroImg.width; sh = sw / heroTargetRatio; sx = 0; sy = (heroImg.height - sh) / 2;
  }
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(MARGIN_X, HERO_Y, CONTENT_W, HERO_H, 18);
  ctx.clip();
  ctx.drawImage(heroImg, sx, sy, sw, sh, MARGIN_X, HERO_Y, CONTENT_W, HERO_H);
  ctx.restore();

  // ---------- Replay QR row, aligned directly under the hero image (same
  // left/right bounds) — up to MAX_POINTS_ON_TICKET clickable tiles (see
  // CLAUDE.md replay vocabulary: manche < point < match, and src/replay.js
  // for the layout constants + encoding). Reserves the same fixed row
  // whether or not there are points to draw, so an uploaded ticket always
  // crops at the same fixed rects. ----------
  const shown = points.slice(0, MAX_POINTS_ON_TICKET);
  for (let i = 0; i < shown.length; i++) {
    const point = shown[i];
    const rect = pointTileRect(i);
    const url = buildReplayUrl(point);
    const qrCanvas = await QRCode.toCanvas(url, {
      width: rect.size, margin: 1, color: { dark: COLORS.bgDeep, light: '#ffffff' },
    });
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(rect.qrX - 6, rect.qrY - 6, rect.size + 12, rect.size + 12, 10);
    ctx.fill();
    ctx.drawImage(qrCanvas, rect.qrX, rect.qrY, rect.size, rect.size);
    drawCenteredText(ctx, `Point ${point.index + 1}`, rect.tileX + rect.tileW / 2, rect.qrY + rect.size + 26, `700 15px 'Mulish', Arial, sans-serif`, COLORS.ink);
  }

  // ---------- Stats row: single row of 5 tiles, content width ----------
  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.roundRect(MARGIN_X, STATS_Y, CONTENT_W, STATS_H, 16);
  ctx.fill();

  const tileFracs = [0.1, 0.3, 0.5, 0.7, 0.9];
  const statsTileY = STATS_Y + STATS_H / 2 - 8;
  const tiles = [
    ['⏱', 'DURATION', formatDuration(stats.durationMs)],
    ['\u{1F945}', 'GOALS', String(stats.goals)],
    ['\u{1F4A5}', 'COLLISIONS', String(stats.collisions)],
    ['\u{1F3AF}', 'BEST SHOT', `${Math.round(stats.bestShotPercent)}%`],
    ['\u{1FAA8}', 'DESTROYED', String(stats.stonesDestroyed)],
  ];
  tiles.forEach(([icon, label, value], i) => drawStatTile(ctx, MARGIN_X + CONTENT_W * tileFracs[i], statsTileY, icon, label, value));

  // ---------- "Sponsored by" caption (English, small caps), then the
  // sponsor banner strip, full width, bottom-cropped (no letterboxing) to
  // keep the source art's logo/text — see BANNER_H's comment in replay.js. ----------
  drawCenteredText(ctx, 'THIS MATCH WAS SPONSORED BY', W / 2, SPONSOR_LABEL_Y, `700 15px 'Mulish', Arial, sans-serif`, COLORS.inkDim);

  const bannerTargetRatio = W / BANNER_H;
  const bsh = bannerImg.width / bannerTargetRatio;
  const bsy = bannerImg.height - bsh;
  ctx.drawImage(bannerImg, 0, bsy, bannerImg.width, bsh, 0, BANNER_Y, W, BANNER_H);

  // ---------- Footer: slim horizontal bar — small game QR + "Play Nim-Curl" ----------
  const qrSize = 64; // small, fixed short URL — see the point-QR comment above for why size floors differ by payload length
  const qrCanvas = await QRCode.toCanvas(location.href, {
    width: qrSize,
    margin: 1,
    color: { dark: COLORS.bgDeep, light: '#ffffff' },
  });
  const footerCy = FOOTER_Y + FOOTER_H / 2;
  const qrX = W / 2 - 130, qrY = footerCy - qrSize / 2;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 10);
  ctx.fill();
  ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
  const textX = qrX + qrSize + 22;
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.accent;
  ctx.font = `800 20px 'Mulish', Arial, sans-serif`;
  ctx.fillText('NIM-CURL', textX, footerCy - 4);
  ctx.fillStyle = COLORS.inkDim;
  ctx.font = `600 15px 'Mulish', Arial, sans-serif`;
  ctx.fillText('Play Nim-Curl', textX, footerCy + 18);

  return canvas;
}
