// Match-end "ticket" — public/ticket/polaroid.webp (baked from the
// hand-designed design/Polaroid ticket 4.png template) IS the ticket, drawn
// full-bleed; this module only fills in the dynamic pieces the art already
// reserves empty slots for (see the header comment in src/replay.js for the
// full rundown of what's baked vs. drawn here). Doubles as the in-game
// victory panel and the shareable result image (see showVictory() in
// game.js).
import { getIdenticonCanvas } from './identicons.js';
import QRCode from 'qrcode';
import {
  buildReplayUrl, pointTileRect, MAX_POINTS_ON_TICKET,
  TICKET_W, TICKET_H, SCALE,
  ICON_A_CX, ICON_A_CY, ICON_A_R, ICON_B_CX, ICON_B_CY, ICON_B_R,
  DASH_CX, DASH_CY, DASH_W, DASH_H, ADDR_GAP,
  STATS_COL_CX, STATS_VALUE_Y,
  BANNER_X, BANNER_Y, BANNER_W, BANNER_H, BANNER_RADIUS,
  BANNER_WIPE_X, BANNER_WIPE_Y, BANNER_WIPE_W, BANNER_WIPE_H, BANNER_WIPE_RADIUS,
  traceBannerTabPath,
  UPLOAD_LABEL_CX, UPLOAD_LABEL_Y,
} from './replay.js';

const ASSET_BASE = import.meta.env.BASE_URL;
const POLAROID_SRC = `${ASSET_BASE}ticket/polaroid.webp`;
const BANNER_SRC = `${ASSET_BASE}ticket/banner-nimiq-space.webp`;
const GUEST_BLUE_SRC = `${ASSET_BASE}ticket/guest-blue.webp`;
const GUEST_YELLOW_SRC = `${ASSET_BASE}ticket/guest-yellow.webp`;

const W = TICKET_W, H = TICKET_H;

const INK = '#0F1C3F';
const FONT = `'Mulish', Arial, sans-serif`;

let assetsPromise = null;
export function preloadTicketAssets() {
  if (!assetsPromise) {
    assetsPromise = Promise.all([
      loadImage(POLAROID_SRC), loadImage(BANNER_SRC), loadImage(GUEST_BLUE_SRC), loadImage(GUEST_YELLOW_SRC),
    ]);
  }
  return assetsPromise;
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

// team.label is identityLabelOverride()'s output (see main.js): undefined
// (no override — fall back to the raw address), "@handle" (a claimed
// NimConnect handle), or "Guest 4821" (this device's guest code). Only ever
// populated for whichever team this device's own identity controls — the
// opponent/AI side normally has no label, same as today.
function resolveTeamDisplay(team) {
  if (team.label?.startsWith('Guest')) return { isGuest: true, text: team.label };
  if (team.label) return { isGuest: false, text: team.label };
  return { isGuest: false, text: shortenAddress(team.address) };
}

function drawCircularImage(ctx, img, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

function drawContainedImage(ctx, img, cx, cy, maxR) {
  const scale = Math.min((maxR * 2) / img.width, (maxR * 2) / img.height);
  const w = img.width * scale, hh = img.height * scale;
  ctx.drawImage(img, cx - w / 2, cy - hh / 2, w, hh);
}

function drawCenteredText(ctx, text, x, y, font, color) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
}

// Manual letter-spacing (works everywhere, unlike the still-patchy
// CanvasRenderingContext2D.letterSpacing) — small uppercase labels only.
function drawSpacedText(ctx, text, cx, y, font, color, spacing) {
  ctx.font = font;
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let x = cx - total / 2;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  [...text].forEach((ch, i) => { ctx.fillText(ch, x, y); x += widths[i] + spacing; });
}

export async function renderTicket({ scoreA, scoreB, teamA, teamB, winner: _winner, stats, points = [] }) {
  await document.fonts.ready;
  const [[polaroidImg, bannerImg, guestBlueImg, guestYellowImg], identiconA, identiconB] = await Promise.all([
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

  ctx.drawImage(polaroidImg, 0, 0, W, H);

  // ---------- Icon + address/handle/guest-code, one side per team, either
  // side of the score dash. ----------
  const dispA = resolveTeamDisplay(teamA), dispB = resolveTeamDisplay(teamB);
  const addrFont = `600 ${Math.round(17 * SCALE)}px ${FONT}`;
  const addrBaseline = (cy) => cy + 6 * SCALE;
  if (dispA.isGuest) drawContainedImage(ctx, guestBlueImg, ICON_A_CX, ICON_A_CY, ICON_A_R);
  else drawCircularImage(ctx, identiconA, ICON_A_CX, ICON_A_CY, ICON_A_R);
  ctx.textAlign = 'right';
  ctx.font = addrFont;
  ctx.fillStyle = INK;
  ctx.fillText(dispA.text, ICON_A_CX - ICON_A_R - ADDR_GAP, addrBaseline(ICON_A_CY));

  if (dispB.isGuest) drawContainedImage(ctx, guestYellowImg, ICON_B_CX, ICON_B_CY, ICON_B_R);
  else drawCircularImage(ctx, identiconB, ICON_B_CX, ICON_B_CY, ICON_B_R);
  ctx.textAlign = 'left';
  ctx.fillText(dispB.text, ICON_B_CX + ICON_B_R + ADDR_GAP, addrBaseline(ICON_B_CY));

  // ---------- Score dash (not baked into the flattened art — a hidden XCF
  // layer marks its position only) + the two score numbers flanking it. ----------
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.roundRect(DASH_CX - DASH_W / 2, DASH_CY - DASH_H / 2, DASH_W, DASH_H, DASH_H / 2);
  ctx.fill();

  ctx.font = `800 ${Math.round(40 * SCALE)}px ${FONT}`;
  const scoreAText = String(scoreA), scoreBText = String(scoreB);
  const scoreBaseline = DASH_CY + 16 * SCALE;
  const scoreGap = 10 * SCALE;
  ctx.textAlign = 'right';
  ctx.fillStyle = INK;
  ctx.fillText(scoreAText, DASH_CX - DASH_W / 2 - scoreGap, scoreBaseline);
  ctx.textAlign = 'left';
  ctx.fillText(scoreBText, DASH_CX + DASH_W / 2 + scoreGap, scoreBaseline);

  // ---------- Stats values — labels/icons already baked in, just the
  // numbers underneath. ----------
  const values = [formatDuration(stats.durationMs), String(stats.collisions), String(stats.stonesDestroyed)];
  const valueFont = `800 ${Math.round(26 * SCALE)}px ${FONT}`;
  values.forEach((v, i) => drawCenteredText(ctx, v, STATS_COL_CX[i], STATS_VALUE_Y, valueFont, INK));

  // ---------- "Upload to relive" label — ticket 4 ships this area blank
  // (ticket 3 had different wording baked directly into the art). ----------
  drawSpacedText(
    ctx, 'UPLOAD TO NIMICURL.COM TO WATCH THE REPLAY',
    UPLOAD_LABEL_CX, UPLOAD_LABEL_Y, `800 ${Math.round(15 * SCALE)}px ${FONT}`, INK, 2 * SCALE,
  );

  // ---------- Replay QR row — 5 pre-numbered dashed boxes, up to
  // MAX_POINTS_ON_TICKET clickable tiles (see CLAUDE.md replay vocabulary:
  // manche < point < match, and src/replay.js for the layout constants +
  // encoding). ----------
  const shown = points.slice(0, MAX_POINTS_ON_TICKET);
  for (let i = 0; i < shown.length; i++) {
    const point = shown[i];
    const rect = pointTileRect(i);
    const url = buildReplayUrl(point);
    let qrCanvas = null;
    for (const scale of [4, 3, 2, 1]) {
      const candidate = await QRCode.toCanvas(url, { scale, margin: 1, color: { dark: INK, light: '#ffffff' } });
      if (candidate.width <= rect.size) { qrCanvas = candidate; break; }
    }
    const qrSize = qrCanvas.width;
    const qrX = rect.qrX + Math.round((rect.size - qrSize) / 2);
    const qrY = rect.qrY + Math.round((rect.size - qrSize) / 2);
    // The white backing fill is sized to fully occlude the dashed box outline
    // (see conversation) — a few px larger than the box on every side, not
    // just matched to the (smaller, centered) QR code itself.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rect.fillX, rect.fillY, rect.fillW, rect.fillH);
    ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
  }

  // ---------- Sponsor banner — the box is a plain rounded rect, wiped white
  // to erase every dash, then the banner image fills it edge-to-edge at its
  // own true 4:1 ratio (no crop, no stretch). The "THIS MATCH WAS SPONSORED
  // BY" tab is redrawn from the original template ON TOP of the banner,
  // clipped to its own smooth-curved shape (traceBannerTabPath() in
  // replay.js) — it visibly overlaps/intrudes into the banner's top edge,
  // exactly like the dashed placeholder's own tab does (see conversation:
  // this is the actual model, not a notch the banner avoids). ----------
  ctx.beginPath();
  ctx.roundRect(BANNER_WIPE_X, BANNER_WIPE_Y, BANNER_WIPE_W, BANNER_WIPE_H, BANNER_WIPE_RADIUS);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(BANNER_X, BANNER_Y, BANNER_W, BANNER_H, BANNER_RADIUS);
  ctx.clip();
  ctx.drawImage(bannerImg, BANNER_X, BANNER_Y, BANNER_W, BANNER_H);
  ctx.restore();

  ctx.save();
  traceBannerTabPath(ctx);
  ctx.clip();
  ctx.drawImage(polaroidImg, 0, 0, W, H);
  ctx.restore();

  return canvas;
}
