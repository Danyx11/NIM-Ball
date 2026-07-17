#!/usr/bin/env python3
"""One-off bake of the new arena composite (ice + field lines + wood ring/tail
+ goal bars + scoreboard plaque) into a single 1200x905 image, replacing
public/arena/frame.webp. Ports design-lab/main.js's live CSS-rect alignment
math (alignPoutresToPhysics, alignBorduresButs, alignScoreboardWood,
drawFieldLines) to a fixed physics-box rect instead of a live viewport rect,
since src/game.js's canvas is a FIXED 1200x905 logical space (see the W/H
comment at the top of startGame()) with the physics box always at
FX0=159,FY0=206,FX1=1046,FY1=698 — baking against those exact numbers keeps
every existing pixel-coordinate (PLAY button, score digit slots, laser) intact.
Not meant to be part of the build/dev pipeline — run manually when the source
design-lab art changes, like a build script for an asset.
"""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ASSETS = "design/arena"
OUT = "public/arena/frame.webp"

W, H = 1200, 905
FX0, FY0, FX1, FY1 = 159, 206, 1046, 698
PW, PH = FX1 - FX0, FY1 - FY0

def load(name):
    return Image.open(f"{ASSETS}/{name}").convert("RGBA")

canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))

# ---------- 1. Ice ----------
ice = load("glace-pure-v3.png").resize((PW, PH), Image.LANCZOS)

# ---------- 2. Field lines (halfway line, hexagons, goal creases), textured
#    with the ice's own high-pass grain, per drawFieldLines() in main.js ----------
LINE_ALPHA = 0.51
HEX_R_FRAC = 0.153
SMALL_HEX_R_FRAC = 0.05
GOAL_R_FRAC = 0.27
GOAL_ARC_FRACTION = 0.4
STROKE_FRAC = 0.015
LINE_BASE_GRAY = 20
GRAIN_BLUR_PX = 6
GRAIN_STRENGTH = 10
SS = 4  # supersample factor for anti-aliased strokes (PIL's ImageDraw has no native AA)

sw, sh = PW * SS, PH * SS
mask = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
d = ImageDraw.Draw(mask)
stroke_w = max(1, round(STROKE_FRAC * sh))
cx, cy = sw / 2, sh / 2
hexR = HEX_R_FRAC * sh
smallHexR = SMALL_HEX_R_FRAC * sh
goalR = GOAL_R_FRAC * sh
arcHalfAngle = GOAL_ARC_FRACTION * math.pi

def hex_pts(radius):
    pts = []
    for i in range(6):
        a = -math.pi / 2 + i * math.pi / 3
        pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return pts

d.line([(cx, 0), (cx, cy - hexR)], fill=(0, 0, 0, 255), width=stroke_w)
d.line([(cx, cy + hexR), (cx, sh)], fill=(0, 0, 0, 255), width=stroke_w)
d.polygon(hex_pts(hexR), outline=(0, 0, 0, 255), width=stroke_w)
d.polygon(hex_pts(smallHexR), outline=(0, 0, 0, 255), width=stroke_w)

capInset = goalR * math.cos(arcHalfAngle)
deg = math.degrees
d.arc([(-capInset - goalR, cy - goalR), (-capInset + goalR, cy + goalR)],
      start=deg(-arcHalfAngle), end=deg(arcHalfAngle), fill=(0, 0, 0, 255), width=stroke_w)
d.arc([(sw + capInset - goalR, cy - goalR), (sw + capInset + goalR, cy + goalR)],
      start=deg(math.pi - arcHalfAngle), end=deg(math.pi + arcHalfAngle), fill=(0, 0, 0, 255), width=stroke_w)

mask = mask.resize((PW, PH), Image.LANCZOS)  # downsample = anti-alias

ice_rgb = np.array(ice.convert("RGB"), dtype=np.float64)
ice_blur = np.array(ice.convert("RGB").filter(ImageFilter.GaussianBlur(GRAIN_BLUR_PX)), dtype=np.float64)
lumS = ice_rgb.mean(axis=2)
lumB = ice_blur.mean(axis=2)
grain = np.clip(LINE_BASE_GRAY + (lumS - lumB) * GRAIN_STRENGTH, 0, 255).astype(np.uint8)
paint = np.stack([grain, grain, grain], axis=2)

mask_a = np.array(mask.split()[-1], dtype=np.float64)
final_a = np.clip(mask_a * LINE_ALPHA, 0, 255).astype(np.uint8)
lines_layer = Image.fromarray(np.dstack([paint, final_a]), "RGBA")

ice_with_lines = ice.copy()
ice_with_lines.alpha_composite(lines_layer)
canvas.alpha_composite(ice_with_lines, (FX0, FY0))

# ---------- 3. Wood ring position (shared by tail shadow, ring, scoreboard) ----------
HOLE_FRAC_LEFT, HOLE_FRAC_RIGHT = 307 / 1740, 1423 / 1740
HOLE_FRAC_TOP, HOLE_FRAC_BOTTOM = 174 / 1010, 826 / 1010
poutresW = PW / (HOLE_FRAC_RIGHT - HOLE_FRAC_LEFT)
poutresH = PH / (HOLE_FRAC_BOTTOM - HOLE_FRAC_TOP)
poutresLeft = FX0 - HOLE_FRAC_LEFT * poutresW
poutresTop = FY0 - HOLE_FRAC_TOP * poutresH

# ---------- 4. Wood "liant" tail shadow, per renderTail() in main.js ----------
TAIL_THRESHOLD, TAIL_PEAK, TAIL_MAX_REACH, TAIL_TAPER = 47, 0.85, 35, 8
TAIL_ALPHA, TAIL_DECAY = 1.0, 8.0  # locked-state.md defaults

tail_rgb_img = Image.open(f"{ASSETS}/poutres-fitted.png").convert("RGB")
tail_dist_img = Image.open(f"{ASSETS}/poutres-dist.png").convert("L")
tail_rgb = np.array(tail_rgb_img, dtype=np.float64)
dist = np.array(tail_dist_img, dtype=np.float64) * (150 / 255)
reach = TAIL_THRESHOLD - dist
a = np.where(dist <= TAIL_THRESHOLD, TAIL_PEAK * np.exp(-reach / TAIL_DECAY), 0.0)
cap = np.clip((TAIL_MAX_REACH - reach) / TAIL_TAPER, 0, 1)
a = a * cap
alpha = np.clip(a * 255 * TAIL_ALPHA, 0, 255).astype(np.uint8)
tail_img = Image.fromarray(np.dstack([tail_rgb.astype(np.uint8), alpha]), "RGBA")
tail_resized = tail_img.resize((round(poutresW), round(poutresH)), Image.LANCZOS)
canvas.alpha_composite(tail_resized, (round(poutresLeft), round(poutresTop)))

# ---------- 5. Wood ring (solid) ----------
poutres = load("poutres-wood-align.png").resize((round(poutresW), round(poutresH)), Image.LANCZOS)
canvas.alpha_composite(poutres, (round(poutresLeft), round(poutresTop)))

# ---------- 6. Scoreboard plaque, mounted flush against the wood's outer top edge ----------
SCOREBOARD_WOOD_WIDTH_FRAC = 0.42
SCOREBOARD_WOOD_ASPECT = 217 / 671
RAIL_OUTER_TOP_SRC = 155
SCOREBOARD_WOOD_Y_NUDGE = 2

sb_width = PW * SCOREBOARD_WOOD_WIDTH_FRAC
sb_height = sb_width * SCOREBOARD_WOOD_ASPECT
railOuterTop = poutresTop + RAIL_OUTER_TOP_SRC * (poutresH / 1010) + SCOREBOARD_WOOD_Y_NUDGE
sb_left = FX0 + PW / 2 - sb_width / 2
sb_top = railOuterTop - sb_height

scoreboard = load("tableau-score-bois.png").resize((round(sb_width), round(sb_height)), Image.LANCZOS)
canvas.alpha_composite(scoreboard, (round(sb_left), round(sb_top)))

# ---------- 7. Goal-post bars (split left/right, topmost layer) ----------
BORDURES_SRC_W, BORDURES_SRC_H = 2860, 1509
BORDURES_BAR_L_OUTER, BORDURES_BAR_R_OUTER = 685, 2167
BORDURES_BAR_TOP, BORDURES_BAR_BOTTOM = 607, 854
GOAL_Y0_FRAC, GOAL_Y1_FRAC = 0.32927, 0.67073
GOAL_ELONGATE_FRAC = 0.15
BORDURES_SPREAD_PX, BORDURES_TRIM_PX = 2, 9
BORDURES_MID_SRC = (BORDURES_BAR_L_OUTER + BORDURES_BAR_R_OUTER) / 2
BORDURES_LEFT_TOP_TRIM_PX = 2
BORDURES_RIGHT_SHIFT_PX = -1
BORDURES_RIGHT_TOP_TRIM_PX = 1

targetLeft = FX0 - BORDURES_SPREAD_PX
targetRight = FX1 + BORDURES_SPREAD_PX
scaleX = (targetRight - targetLeft) / (BORDURES_BAR_R_OUTER - BORDURES_BAR_L_OUTER)
baseLeft = targetLeft - BORDURES_BAR_L_OUTER * scaleX
goalTop = FY0 + GOAL_Y0_FRAC * PH
goalBottom = FY0 + GOAL_Y1_FRAC * PH
goalMid = (goalTop + goalBottom) / 2
goalHalfSpan = (goalBottom - goalTop) / 2 * (1 + GOAL_ELONGATE_FRAC)
targetTop = (goalMid - goalHalfSpan) + BORDURES_TRIM_PX
targetBottom = (goalMid + goalHalfSpan) - BORDURES_TRIM_PX
scaleY = (targetBottom - targetTop) / (BORDURES_BAR_BOTTOM - BORDURES_BAR_TOP)
baseTop = targetTop - BORDURES_BAR_TOP * scaleY
baseWidth = BORDURES_SRC_W * scaleX
baseHeight = BORDURES_SRC_H * scaleY
midPx = BORDURES_MID_SRC * scaleX

bordures_big = load("bordures-buts.png").resize((round(baseWidth), round(baseHeight)), Image.LANCZOS)

left_crop = bordures_big.crop((0, BORDURES_LEFT_TOP_TRIM_PX, round(midPx), bordures_big.height))
canvas.alpha_composite(left_crop, (round(baseLeft), round(baseTop + BORDURES_LEFT_TOP_TRIM_PX)))

right_crop = bordures_big.crop((round(midPx), BORDURES_RIGHT_TOP_TRIM_PX, bordures_big.width, bordures_big.height))
canvas.alpha_composite(right_crop, (round(baseLeft + midPx), round(baseTop + BORDURES_RIGHT_SHIFT_PX + BORDURES_RIGHT_TOP_TRIM_PX)))

canvas.save(OUT, "WEBP", quality=90, method=6)
print("saved", OUT, canvas.size)
