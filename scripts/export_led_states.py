"""Reference export: the stone body (colori design) at each of its 5 possible
LED states (0..4 quadrants knocked out), for both teams — flat colors, no
glow (that pass is being done by hand in GIMP on these exports, see
conversation). Not wired into the game; a design reference sheet only.

Geometry/colors copied 1:1 from src/game.js's drawStoneLeds (LED_ANGLES,
LED_ARC_HALF_SPAN, LED_ARC_INNER_FRAC/OUTER_FRAC, LED_LIT_RGB, LED_OFF_GRAY) —
keep in sync if those ever change.

Usage: python3 scripts/export_led_states.py
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
STONE_SRC = {
    "A": ROOT / "public" / "identicons" / "stone-navy-colori.webp",
    "B": ROOT / "public" / "identicons" / "stone-gold-colori.webp",
}
OUT_DIR = ROOT / "design" / "generated" / "led-states"

# --- copied from src/game.js ---
LED_ANGLES = [-1.5757, -0.0400, 1.5518, -3.0736]  # top, right, bottom, left
LED_ARC_HALF_SPAN = 0.53
LED_ARC_INNER_FRAC = 0.375
LED_ARC_OUTER_FRAC = 0.407
LED_LIT_RGB = {"A": (110, 210, 255), "B": (255, 205, 90)}
LED_OFF_GRAY = (0x7D, 0x84, 0x89)
STONE_HITS_PER_LED = 2
STATES = [0, 1, 2, 3, 4]  # ledsOut


def ring_polygon(cx, cy, outer_r, inner_r, center_angle, half_span, steps=24):
    a0, a1 = center_angle - half_span, center_angle + half_span
    pts = []
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / steps
        pts.append((cx + math.cos(a) * outer_r, cy + math.sin(a) * outer_r))
    for i in range(steps + 1):
        a = a1 - (a1 - a0) * i / steps
        pts.append((cx + math.cos(a) * inner_r, cy + math.sin(a) * inner_r))
    return pts


def multiply_ring(base_rgba, mask_alpha, color):
    """Approximates ctx.globalCompositeOperation='multiply' at globalAlpha
    (1-strength): result = base*(1-a*(1-blend/255)) — i.e. a lerp between
    the base pixel and its multiplied-by-blend version, weighted by mask
    alpha (which already encodes both the ring shape AND (1-strength))."""
    base = base_rgba[..., :3].astype(np.float32)
    a = (mask_alpha.astype(np.float32) / 255.0)[..., None]
    blend = np.array(color, dtype=np.float32) / 255.0
    multiplied = base * blend
    out = base * (1 - a) + multiplied * a
    result = base_rgba.copy()
    result[..., :3] = np.clip(out, 0, 255).astype(np.uint8)
    return result


def lighter_ring(base_rgba, mask_alpha, color, opacity):
    """Approximates ctx.globalCompositeOperation='lighter' at the given
    globalAlpha: result = base + color*alpha*opacity, clamped."""
    base = base_rgba[..., :3].astype(np.float32)
    a = (mask_alpha.astype(np.float32) / 255.0)[..., None] * opacity
    add = np.array(color, dtype=np.float32) * a
    out = base + add
    result = base_rgba.copy()
    result[..., :3] = np.clip(out, 0, 255).astype(np.uint8)
    return result


def rasterize_ring_mask(size, cx, cy, outer_r, inner_r, angle):
    mask = Image.new("L", size, 0)
    md = ImageDraw.Draw(mask)
    pts = ring_polygon(cx, cy, outer_r, inner_r, angle, LED_ARC_HALF_SPAN)
    md.polygon(pts, fill=255)
    return np.array(mask)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for team, src_path in STONE_SRC.items():
        stone = Image.open(src_path).convert("RGBA")
        w, h = stone.size
        cx, cy = w / 2, h / 2
        outer_r, inner_r = w * LED_ARC_OUTER_FRAC, w * LED_ARC_INNER_FRAC
        lit_color = LED_LIT_RGB[team]

        for leds_out in STATES:
            arr = np.array(stone)
            for i, angle in enumerate(LED_ANGLES):
                alive = i >= leds_out
                strength = 1.0 if alive else 0.0
                mask = rasterize_ring_mask((w, h), cx, cy, outer_r, inner_r, angle)
                if strength < 0.98:
                    off_alpha = (mask.astype(np.float32) * (1 - strength)).astype(np.uint8)
                    arr = multiply_ring(arr, off_alpha, LED_OFF_GRAY)
                if strength > 0.02:
                    lit_alpha = (mask.astype(np.float32) * strength).astype(np.uint8)
                    arr = lighter_ring(arr, lit_alpha, lit_color, 0.9)
            out_im = Image.fromarray(arr, "RGBA")
            out_path = OUT_DIR / f"stone-{team}-leds{4 - leds_out}.png"
            out_im.save(out_path)
            print(f"{out_path.name}: {leds_out} out, {4 - leds_out} alive")


if __name__ == "__main__":
    main()
