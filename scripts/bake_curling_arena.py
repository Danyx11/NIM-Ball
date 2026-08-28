#!/usr/bin/env python3
"""Bakes the "pure curling" arena variants — target + its timer ring, baked
directly onto the same clean wood/ice/rock scenes public/arena/frame*.webp
were themselves built from, from before any field lines/hexagon were drawn
on top (design/arena/arena summer night upscale 3.png, arena winter
upscale.png, and the hand-cleaned arena {summer,winter} mobile.png crops).
Nothing to erase/patch this way — v2, replacing an earlier attempt that
baked onto the already-composited frame.webp and clone-stamped the hexagon/
line away first (ported from curling-lab's own now-superseded v2script); that
approach left a faint residual "asterisk" mark at the hexagon's center under
close inspection. curling-lab/bake_curling_arena.py hit the same issue and
fixed it the same way (see that script's own v3 docstring) — using the
pre-line source art outright avoids the clone-stamp step, and the residual,
entirely.

The goal-crease arcs and bars ARE still present (baked into these same
source scenes) — kept deliberately: this mode doesn't score via a goal, but
per explicit request the goal geometry stays in the arena as a real physical
hazard stones can still die against, same as the classic game.

Produces 4 files, matching the existing desktop/mobile x summer/winter set:
    public/arena/frame-curling.webp
    public/arena/frame-curling-mobile.webp
    public/arena/frame-curling-winter.webp
    public/arena/frame-curling-winter-mobile.webp
Plus 8 new "under-ice" score-digit assets (see scripts/bake_score_digits.py —
same Color Burn technique, same design/score-digits/{0,1,2,3}.png glyphs,
positioned outside the new target's own timer ring instead of flanking the
hexagon, since that old spot is now buried under the target):
    public/score-digits/curling-A-{0,1,2,3}.png
    public/score-digits/curling-B-{0,1,2,3}.png

Needs Pillow + numpy (`pip install pillow numpy`). Run from the repo root:
    python3 scripts/bake_curling_arena.py
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DESKTOP_IN = {
    "summer": ROOT / "design/arena/arena summer night upscale 3.png",
    "winter": ROOT / "design/arena/arena winter upscale.png",
}
MOBILE_IN = {
    "summer": ROOT / "design/arena/arena summer mobile.png",
    "winter": ROOT / "design/arena/arena winter mobile.png",
}
TARGET_IN = ROOT / "design/curling target.png"
SCORE_GLYPH_DIR = ROOT / "design/score-digits"
OUT_ARENA_DIR = ROOT / "public/arena"
OUT_SCORE_DIR = ROOT / "public/score-digits"

# Physics/art bounds — verbatim from src/game.js.
FX0, FY0, FX1, FY1 = 1086, 626, 2262, 1274
CENTER_X = (FX0 + FX1) / 2
CY = (FY0 + FY1) / 2
PW = FX1 - FX0

# Mobile crop — verbatim from src/game.js's MOBILE_CROP. design/arena/arena
# {summer,winter} mobile.png were made at exactly this size (confirmed).
MOBILE_X0, MOBILE_Y0, MOBILE_X1, MOBILE_Y1 = 793, 286, 3010, 1580

# Target dead center of the ice (where the hexagon sits) — same tuning
# validated in curling-lab/bake_curling_arena.py (0.25 -> 0.30 -> 0.36 ->
# 0.432 diam, 0.8 -> 0.65 -> 0.60 alpha, grain toned down specifically for
# the target vs the ring/lines, all per iterative feedback there).
TARGET_CX, TARGET_CY = CENTER_X, CY
TARGET_DIAM_FRAC = 0.432
TARGET_ALPHA = 0.60
GRAIN_BLUR_PX = 6
GRAIN_STRENGTH = 10
TARGET_GRAIN_STRENGTH = 5

# New ring around the target, hosting the circular turn timer (see
# src/game.js's CIRCLE_TIMER_MARGIN/CIRCLE_TIMER_R — must match RING_MARGIN_PX
# here). Same "grey ice-grain paint at partial alpha" technique
# scripts/bake_hud_field_lines.py used for the hexagon/line art.
LINE_ALPHA = 0.51
LINE_BASE_GRAY = 20
RING_MARGIN_PX = 26
RING_STROKE_FRAC = 0.015

# Score digits — see src/game.js's UNDERICE_SCORE_CY (unchanged) / new
# curling-only X (outside the timer ring + 60px, was flanking the hexagon).
SCORE_H = 200
SCORE_ALPHA = 0.30
SCORE_CY = 1158
CIRCLE_TIMER_R = (PW * TARGET_DIAM_FRAC) / 2 + RING_MARGIN_PX
SCORE_CX = {"A": TARGET_CX - CIRCLE_TIMER_R - 60, "B": TARGET_CX + CIRCLE_TIMER_R + 60}


def build_ice_grain_delta(ice_rgb, strength=GRAIN_STRENGTH):
    sharp = np.array(ice_rgb.convert("RGB")).astype(np.float32)
    blurred = np.array(ice_rgb.convert("RGB").filter(ImageFilter.GaussianBlur(GRAIN_BLUR_PX))).astype(np.float32)
    lum_s = sharp.mean(axis=2)
    lum_b = blurred.mean(axis=2)
    return (lum_s - lum_b) * strength


def build_ice_grain_paint(ice_rgb):
    sharp = np.array(ice_rgb.convert("RGB")).astype(np.float32)
    blurred = np.array(ice_rgb.convert("RGB").filter(ImageFilter.GaussianBlur(GRAIN_BLUR_PX))).astype(np.float32)
    lum_s = sharp.mean(axis=2)
    lum_b = blurred.mean(axis=2)
    return np.clip(LINE_BASE_GRAY + (lum_s - lum_b) * GRAIN_STRENGTH, 0, 255).astype(np.uint8)


def bake_target(scene, cx, cy):
    diam = round(PW * TARGET_DIAM_FRAC)
    x0, y0 = round(cx - diam / 2), round(cy - diam / 2)
    target = Image.open(TARGET_IN).convert("RGBA").resize((diam, diam), Image.LANCZOS)

    ice_under_target = scene.crop((x0, y0, x0 + diam, y0 + diam))
    delta = build_ice_grain_delta(ice_under_target, TARGET_GRAIN_STRENGTH)[..., None]

    t = np.array(target).astype(np.float32)
    t[..., :3] = np.clip(t[..., :3] + delta, 0, 255)

    alpha_u8 = np.array(target.split()[-1])
    dilated = np.array(Image.fromarray(alpha_u8).filter(ImageFilter.MaxFilter(9))).astype(np.float32)
    eroded = np.clip(dilated - alpha_u8.astype(np.float32), 0, 255).astype(np.uint8)
    rim = np.array(Image.fromarray(eroded).filter(ImageFilter.GaussianBlur(4))).astype(np.float32)
    rim_norm = (rim / (rim.max() + 1e-6))[..., None]
    t[..., :3] = np.clip(t[..., :3] - rim_norm[..., 0:1] * 26, 0, 255)
    t[..., 3] = t[..., 3] * TARGET_ALPHA
    target_final = Image.fromarray(t.astype(np.uint8), "RGBA")

    out = scene.convert("RGBA")
    out.alpha_composite(target_final, (x0, y0))
    return out.convert("RGB")


def bake_target_ring(scene, cx, cy):
    target_r = (PW * TARGET_DIAM_FRAC) / 2
    ring_r = target_r + RING_MARGIN_PX
    box = round(ring_r + 20)
    x0, y0 = round(cx - box), round(cy - box)
    x1, y1 = round(cx + box), round(cy + box)
    ice_crop = scene.crop((x0, y0, x1, y1)).convert("RGB")
    w, h = ice_crop.size

    SS = 4
    stroke = max(1, round(RING_STROKE_FRAC * (FY1 - FY0) * SS))
    mask = Image.new("L", (w * SS, h * SS), 0)
    draw = ImageDraw.Draw(mask)
    lcx, lcy = (cx - x0) * SS, (cy - y0) * SS
    r = ring_r * SS
    draw.ellipse([lcx - r, lcy - r, lcx + r, lcy + r], outline=255, width=stroke)
    alpha_mask = np.array(mask.resize((w, h), Image.LANCZOS)).astype(np.float32)

    grain = build_ice_grain_paint(ice_crop)
    overlay = np.zeros((h, w, 4), dtype=np.uint8)
    overlay[..., 0] = grain
    overlay[..., 1] = grain
    overlay[..., 2] = grain
    overlay[..., 3] = np.clip(alpha_mask * LINE_ALPHA, 0, 255).astype(np.uint8)
    overlay_img = Image.fromarray(overlay, "RGBA")

    composited = Image.alpha_composite(ice_crop.convert("RGBA"), overlay_img)
    out = scene.copy()
    out.paste(composited.convert("RGB"), (x0, y0))
    return out


def bake_target_and_ring(scene, cx, cy):
    return bake_target_ring(bake_target(scene, cx, cy), cx, cy)


def color_burn(base, blend):
    safe_blend = np.clip(blend, 1e-6, 1)
    return np.clip(1 - (1 - base) / safe_blend, 0, 1)


def bake_score_digit(scene, glyph_path, cx, cy):
    glyph = Image.open(glyph_path).convert("RGBA")
    h = SCORE_H
    w = round(glyph.width * (h / glyph.height))
    glyph_r = glyph.resize((w, h), Image.LANCZOS)

    x0 = round(cx - w / 2)
    y0 = round(cy - h / 2)
    ice_crop = scene.crop((x0, y0, x0 + w, y0 + h)).convert("RGB")

    ice_n = np.array(ice_crop).astype(np.float64) / 255.0
    glyph_arr = np.array(glyph_r).astype(np.float64)
    glyph_rgb_n = glyph_arr[..., :3] / 255.0
    glyph_a = (glyph_arr[..., 3:4] / 255.0) * SCORE_ALPHA

    burned = color_burn(ice_n, glyph_rgb_n)
    final_n = ice_n * (1 - glyph_a) + burned * glyph_a

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., :3] = np.clip(final_n * 255, 0, 255).astype(np.uint8)
    out[..., 3] = 255
    return Image.fromarray(out, "RGBA")


def main():
    OUT_ARENA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_SCORE_DIR.mkdir(parents=True, exist_ok=True)
    mobile_cx, mobile_cy = TARGET_CX - MOBILE_X0, TARGET_CY - MOBILE_Y0

    desktop_summer = None  # score digits baked against this one, matching
                            # scripts/bake_score_digits.py's own single-bake
                            # convention (never varied by skin/crop either)
    for season in ("summer", "winter"):
        suffix = "" if season == "summer" else "-winter"

        desktop_src = Image.open(DESKTOP_IN[season]).convert("RGB")
        desktop = bake_target_and_ring(desktop_src, TARGET_CX, TARGET_CY)
        desktop_out = OUT_ARENA_DIR / f"frame-curling{suffix}.webp"
        desktop.save(desktop_out, "WEBP", quality=92, method=6)
        print("saved", desktop_out, desktop.size)
        if season == "summer":
            desktop_summer = desktop

        mobile_src = Image.open(MOBILE_IN[season]).convert("RGB")
        assert mobile_src.size == (MOBILE_X1 - MOBILE_X0, MOBILE_Y1 - MOBILE_Y0), \
            f"{MOBILE_IN[season]} is {mobile_src.size}, expected {(MOBILE_X1 - MOBILE_X0, MOBILE_Y1 - MOBILE_Y0)}"
        mobile = bake_target_and_ring(mobile_src, mobile_cx, mobile_cy)
        mobile_out = OUT_ARENA_DIR / f"frame-curling{suffix}-mobile.webp"
        mobile.save(mobile_out, "WEBP", quality=92, method=6)
        print("saved", mobile_out, mobile.size)

    for team, cx in SCORE_CX.items():
        for digit in range(4):
            baked = bake_score_digit(desktop_summer, SCORE_GLYPH_DIR / f"{digit}.png", cx, SCORE_CY)
            out_path = OUT_SCORE_DIR / f"curling-{team}-{digit}.png"
            baked.save(out_path)
            print("saved", out_path, baked.size)


if __name__ == "__main__":
    main()
