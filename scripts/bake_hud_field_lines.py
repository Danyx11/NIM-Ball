"""Adds the center line + hexagon + goal-crease field markings onto the new
"chat" arena base images (design/generated/arena V2/chat *.png), reusing the
exact parametric geometry and ice-grain texturing algorithm already validated
in design-lab/main.js's drawFieldLines()/buildIceGrainPaint() (ported from JS
canvas to PIL here since there's no headless canvas in this environment).

The ice rectangle isn't known in advance for these new images (no FX0..FY1
equivalent has been measured yet), so it's auto-detected per image via a
brightness-threshold connected-component flood fill from the image center —
the wood frame is reliably much darker than the ice, so this holds regardless
of season/lighting.

Usage: python3 scripts/bake_hud_field_lines.py
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "design" / "generated" / "arena V2"
OUT_DIR = SRC_DIR

FILES = ["chat summer UPSCALED-0.png", "chat winter UPSCALED-0.png", "chat night UPSCALED-0.png"]

# Same fractions (of the ice image's own height) as design-lab/main.js.
HEX_R_FRAC = 0.153
SMALL_HEX_R_FRAC = 0.05
# True semicircle (was 0.27/0.4 = a 144°-flattened cap) — radius chosen so the
# tips still land at the exact same goal-mouth half-height as before
# (0.27*sin(0.4*pi)), only the curvature/bulge changes, matching the fuller
# crease arc from the pre-V1.2 art.
GOAL_R_FRAC = 0.2568
GOAL_ARC_FRACTION = 0.5
STROKE_FRAC = 0.015
LINE_ALPHA = 0.51
LINE_BASE_GRAY = 20
GRAIN_BLUR_PX = 6
GRAIN_STRENGTH = 10

SS = 4  # supersample factor for anti-aliasing


def detect_ice_rect(im, thresh=150):
    a = np.array(im.convert("RGB")).astype(np.int32)
    h, w, _ = a.shape
    brightness = a.mean(axis=2)
    mask = brightness > thresh
    lbl, _ = ndimage.label(mask)
    comp_id = lbl[h // 2, w // 2]
    if comp_id == 0:
        raise RuntimeError("center pixel not classified as ice — adjust threshold")
    ys, xs = np.where(lbl == comp_id)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def hex_vertices(cx, cy, r):
    pts = []
    for i in range(6):
        angle = -np.pi / 2 + i * np.pi / 3
        pts.append((cx + r * np.cos(angle), cy + r * np.sin(angle)))
    return pts


def build_shape_mask(w, h):
    """Draws the halfway line + big/small hexagons + two goal-crease arcs at
    SS-supersampled resolution, returns a downsampled (w,h) 'L' alpha mask."""
    W, H = w * SS, h * SS
    mask = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(mask)
    stroke = max(1, round(STROKE_FRAC * h * SS))

    cx, cy = W / 2, H / 2
    hex_r = HEX_R_FRAC * H
    small_hex_r = SMALL_HEX_R_FRAC * H
    goal_r = GOAL_R_FRAC * H
    arc_half_angle = GOAL_ARC_FRACTION * np.pi

    # halfway line, stopping at the big hexagon's own top/bottom vertices
    draw.line([(cx, 0), (cx, cy - hex_r)], fill=255, width=stroke)
    draw.line([(cx, cy + hex_r), (cx, H)], fill=255, width=stroke)

    # center hexagons (pointy top/bottom), outline only
    for r in (hex_r, small_hex_r):
        pts = hex_vertices(cx, cy, r)
        draw.line(pts + [pts[0]], fill=255, width=stroke, joint="curve")

    # goal creases: circle cap whose tips land exactly on the goal line
    cap_inset = goal_r * np.cos(arc_half_angle)
    start_deg = -np.degrees(arc_half_angle)
    end_deg = np.degrees(arc_half_angle)

    left_cx = -cap_inset
    bbox = [left_cx - goal_r, cy - goal_r, left_cx + goal_r, cy + goal_r]
    draw.arc(bbox, start_deg, end_deg, fill=255, width=stroke)

    right_cx = W + cap_inset
    bbox = [right_cx - goal_r, cy - goal_r, right_cx + goal_r, cy + goal_r]
    draw.arc(bbox, 180 - end_deg, 180 - start_deg, fill=255, width=stroke)

    return mask.resize((w, h), Image.LANCZOS)


def build_ice_grain_paint(ice_rgb):
    sharp = np.array(ice_rgb).astype(np.float32)
    blurred = np.array(ice_rgb.filter(ImageFilter.GaussianBlur(GRAIN_BLUR_PX))).astype(np.float32)
    lum_s = sharp.mean(axis=2)
    lum_b = blurred.mean(axis=2)
    g = np.clip(LINE_BASE_GRAY + (lum_s - lum_b) * GRAIN_STRENGTH, 0, 255).astype(np.uint8)
    return g  # grayscale 2D array


def render_field_lines_onto(path_in: Path, path_out: Path):
    scene = Image.open(path_in).convert("RGBA")
    x0, y0, x1, y1 = detect_ice_rect(scene)
    w, h = x1 - x0, y1 - y0
    print(f"{path_in.name}: ice rect ({x0},{y0})-({x1},{y1}) size {w}x{h}")

    ice_crop = scene.crop((x0, y0, x1, y1)).convert("RGB")
    alpha_mask = np.array(build_shape_mask(w, h)).astype(np.float32)  # 0..255
    grain = build_ice_grain_paint(ice_crop)  # 0..255 gray

    overlay = np.zeros((h, w, 4), dtype=np.uint8)
    overlay[..., 0] = grain
    overlay[..., 1] = grain
    overlay[..., 2] = grain
    overlay[..., 3] = np.clip(alpha_mask * LINE_ALPHA, 0, 255).astype(np.uint8)
    overlay_img = Image.fromarray(overlay, "RGBA")

    composited_ice = Image.alpha_composite(ice_crop.convert("RGBA"), overlay_img)
    scene.paste(composited_ice, (x0, y0))
    scene.save(path_out)
    print("saved", path_out)


def main():
    for name in FILES:
        src = SRC_DIR / name
        if not src.exists():
            print(f"skip (not found): {src}")
            continue
        out = OUT_DIR / name.replace(".png", " lines.png")
        render_field_lines_onto(src, out)


if __name__ == "__main__":
    main()
