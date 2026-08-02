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
import { buildReplayUrl, pointTileRect, MAX_POINTS_ON_TICKET, POINTS_SECTION_H, TICKET_W, TICKET_H } from './replay.js';

const ASSET_BASE = import.meta.env.BASE_URL;
const HERO_SRC = `${ASSET_BASE}ticket/hero.webp`;

// Mirrors the :root custom properties in style.css — copied as literal hex
// here since this is drawn on a plain Canvas2D context, not styled via CSS.
const COLORS = {
  bgDeep: '#0b1f2a',
  ink: '#eef6f4',
  inkDim: '#9fb8bc',
  teamA: '#3fa9f5',
  teamB: '#ffc94d',
  accent: '#ffd166',
  panel: '#143844',
};

const W = TICKET_W, H = TICKET_H;

let heroImgPromise = null;
export function preloadTicketAssets() {
  if (!heroImgPromise) heroImgPromise = loadImage(HERO_SRC);
  return heroImgPromise;
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
  const [heroImg, identiconA, identiconB] = await Promise.all([
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

  // ---------- Header: wordmark + "MATCH RESULT" ----------
  drawCenteredText(ctx, 'NIM-CURL', W / 2, 90, `800 46px 'Mulish', Arial, sans-serif`, COLORS.accent);
  drawCenteredText(ctx, 'MATCH RESULT', W / 2, 134, `700 24px 'Mulish', Arial, sans-serif`, COLORS.inkDim);

  // ---------- Players row ----------
  const avatarR = 78;
  const rowY = 280;
  const colAx = W * 0.27, colBx = W * 0.73;
  for (const [team, cx, img, addr, color] of [
    ['A', colAx, identiconA, teamA.address, COLORS.teamA],
    ['B', colBx, identiconB, teamB.address, COLORS.teamB],
  ]) {
    if (team === winner) {
      ctx.beginPath();
      ctx.arc(cx, rowY, avatarR + 8, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.stroke();
      drawCenteredText(ctx, '\u{1F3C6}', cx, rowY - avatarR - 22, `40px 'Mulish', Arial, sans-serif`, color);
    }
    drawCircularImage(ctx, img, cx, rowY, avatarR);
    drawCenteredText(ctx, shortenAddress(addr), cx, rowY + avatarR + 46, `600 26px 'Mulish', Arial, sans-serif`, COLORS.inkDim);
  }

  // ---------- Score ----------
  const scoreY = 545;
  ctx.font = `800 128px 'Mulish', Arial, sans-serif`;
  const scoreAText = String(scoreA), scoreBText = String(scoreB), sep = '  -  ';
  const wA = ctx.measureText(scoreAText).width;
  const wSep = ctx.measureText(sep).width;
  const wB = ctx.measureText(scoreBText).width;
  const totalW = wA + wSep + wB;
  let cursor = W / 2 - totalW / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.teamA;
  ctx.fillText(scoreAText, cursor, scoreY); cursor += wA;
  ctx.fillStyle = COLORS.inkDim;
  ctx.fillText(sep, cursor, scoreY); cursor += wSep;
  ctx.fillStyle = COLORS.teamB;
  ctx.fillText(scoreBText, cursor, scoreY);

  // ---------- Hero band (center-crop, no distortion) ----------
  const heroY = 610, heroH = 620;
  const heroTargetRatio = W / heroH;
  const srcRatio = heroImg.width / heroImg.height;
  let sx, sy, sw, sh;
  if (srcRatio > heroTargetRatio) {
    sh = heroImg.height; sw = sh * heroTargetRatio; sx = (heroImg.width - sw) / 2; sy = 0;
  } else {
    sw = heroImg.width; sh = sw / heroTargetRatio; sx = 0; sy = (heroImg.height - sh) / 2;
  }
  ctx.save();
  const heroRadius = 24;
  ctx.beginPath();
  ctx.roundRect(0, heroY, W, heroH, heroRadius);
  ctx.clip();
  ctx.drawImage(heroImg, sx, sy, sw, sh, 0, heroY, W, heroH);
  ctx.restore();

  // ---------- Stats panel ----------
  const statsY = heroY + heroH + 30;
  const statsH = 280;
  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.roundRect(60, statsY, W - 120, statsH, 20);
  ctx.fill();

  const tileColX = [W * 0.28, W * 0.72];
  const tileRowY = [statsY + 60, statsY + 150, statsY + 240];
  const tilePositions = [
    [tileColX[0], tileRowY[0]], [tileColX[1], tileRowY[0]],
    [tileColX[0], tileRowY[1]], [tileColX[1], tileRowY[1]],
    [W / 2, tileRowY[2]],
  ];
  const tiles = [
    ['⏱', 'MATCH DURATION', formatDuration(stats.durationMs)],
    ['\u{1F945}', 'GOALS SCORED', String(stats.goals)],
    ['\u{1F4A5}', 'TOTAL COLLISIONS', String(stats.collisions)],
    ['\u{1F3AF}', 'BEST SHOT SPEED', `${Math.round(stats.bestShotPercent)}%`],
    ['\u{1FAA8}', 'STONES DESTROYED', String(stats.stonesDestroyed)],
  ];
  tiles.forEach(([icon, label, value], i) => drawStatTile(ctx, tilePositions[i][0], tilePositions[i][1], icon, label, value));

  // ---------- Points section: up to MAX_POINTS_ON_TICKET clickable replay QR
  // tiles (see CLAUDE.md replay vocabulary: manche < point < match, and
  // src/replay.js for the layout constants + encoding). Reserves the same
  // vertical space whether or not there are points to draw (see TICKET_H's
  // own comment) so an uploaded ticket always crops at the same fixed rects.
  const pointsY = statsY + statsH + 30;
  if (points.length > 0) {
    drawCenteredText(ctx, 'REPLAY — LES POINTS', W / 2, pointsY + 26, `700 24px 'Mulish', Arial, sans-serif`, COLORS.inkDim);
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
      drawCenteredText(ctx, `Point ${point.index + 1}`, rect.tileX + rect.tileW / 2, rect.qrY + rect.size + 30, `700 20px 'Mulish', Arial, sans-serif`, COLORS.ink);
    }
  }

  // ---------- Partner zone (fixed height, reserved for future sponsor) ----------
  const partnerY = pointsY + POINTS_SECTION_H + 30;
  const partnerH = 70;
  ctx.strokeStyle = 'rgba(159,184,188,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(160, partnerY); ctx.lineTo(W - 160, partnerY); ctx.stroke();
  drawCenteredText(ctx, 'Powered by Nimiq', W / 2, partnerY + partnerH / 2 + 8, `700 26px 'Mulish', Arial, sans-serif`, COLORS.inkDim);
  ctx.beginPath(); ctx.moveTo(160, partnerY + partnerH); ctx.lineTo(W - 160, partnerY + partnerH); ctx.stroke();

  // ---------- Footer: logo + "Play Nim-Curl" + QR (no bare URL) ----------
  const footerY = partnerY + partnerH + 30;
  drawCenteredText(ctx, 'NIM-CURL', W / 2, footerY + 24, `800 26px 'Mulish', Arial, sans-serif`, COLORS.accent);
  drawCenteredText(ctx, 'Play Nim-Curl', W / 2, footerY + 56, `600 20px 'Mulish', Arial, sans-serif`, COLORS.inkDim);

  const qrSize = 150;
  const qrCanvas = await QRCode.toCanvas(location.href, {
    width: qrSize,
    margin: 1,
    color: { dark: COLORS.bgDeep, light: '#ffffff' },
  });
  const qrX = W / 2 - qrSize / 2, qrY = footerY + 78;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 14);
  ctx.fill();
  ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);

  return canvas;
}
