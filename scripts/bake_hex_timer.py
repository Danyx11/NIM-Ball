"""Bakes the under-ice hex turn-timer rings (public/hex-timer/ring-full.png
and ring-full-red.png) against the real ice pixels in public/arena/frame.webp,
at the center hexagon's exact position — same "engrave a flat glyph into the
ice via GIMP Color Burn, at a chosen alpha, then flatten to one PNG"
technique as scripts/bake_score_digits.py (see that script's docstring for
why Burn and not Darken, and why this is baked once rather than composited
live) — except these keep real alpha (transparent outside the ring) rather
than being fully opaque; see the alpha-channel comment below for why.

The glyph here isn't external art (no numeral shape to source) — it's a
regular hexagonal RING, procedurally drawn: filled between HEX_TIMER_R_OUTER
and HEX_TIMER_R_INNER (an even-odd punch: fill the outer hex polygon, then
fill the inner hex polygon with alpha 0 on top), pointy-top orientation
(vertex at 12 o'clock), matching the two concentric hexagons already baked
into frame.webp's own line art at CENTER_X/CY. Radii were hand-measured off
frame.webp (ray-cast + grid-overlay crop against the actual pixels — see
conversation) — same "hand-calibrated against the art" caveat as the arena's
physics bounds: a rebake is needed if frame.webp's hex is ever moved/resized.

game.js's drawHexTimer() reveals progressively more of the grey ring via a
clock-wipe pie-slice ctx.clip() (growing clockwise from 12 o'clock) — no
per-percentage frames needed, since each bake is spatially uniform; only the
runtime clip changes. For the last 1/6 of the turn timer it switches to
ring-full-red.png instead (same burn technique, same alpha, but glyph color
= BALL_LASER_RED — the ball's own aim-laser red from game.js — for a visual
family match), pulsing its opacity for urgency.

Usage: python3 scripts/bake_hex_timer.py
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICE_SRC = ROOT / "public" / "arena" / "frame.webp"
OUT_DIR = ROOT / "public" / "hex-timer"

# Must match CENTER_X/CY and the new HEX_TIMER_* constants in src/game.js
# exactly — these positions/radii are baked into the output pixels (the real
# ice grain + line art at this spot), so any change means a rebake.
HEX_TIMER_CX = 1674
HEX_TIMER_CY = 950
# The two hexagons baked into frame.webp's line art have their stroke
# centerlines at outer~96.5px / inner~29.5px, with a ~7px-wide stroke each
# (measured: outer stroke spans r=93..100, inner stroke spans r=26..33) — the
# ring must stay inside both strokes' inner edges, not on top of them (per
# feedback: the fill was encroaching onto the line art), so it sits at
# r=90 (3px clear of the outer stroke's r=93 inner edge) down to r=36 (3px
# clear of the inner stroke's r=33 outer edge).
HEX_TIMER_R_OUTER = 90
HEX_TIMER_R_INNER = 36
HEX_TIMER_MARGIN = 6           # AA padding around the outer radius
HEX_TIMER_ALPHA = 0.30         # same burn strength as the score filigrane's
                                # UNDERICE_SCORE_ALPHA — kept identical per
                                # feedback (was 0.70, read too strong); also
                                # used for the red variant per feedback (a
                                # muted/desaturated red tested too subtle —
                                # the raw laser red burns into a soft rose,
                                # not the harsh tone its raw RGB suggests)
GLYPH_RGB = (0x62, 0x62, 0x62)      # same flat grey as the score digit glyphs
GLYPH_RGB_RED = (235, 24, 24)       # BALL_LASER_RED from game.js


def hex_points(cx, cy, r):
    # Pointy-top regular hexagon: vertex at 12 o'clock (-90deg), then every
    # 60deg clockwise — matches the two hexagons already baked into
    # frame.webp's line art (see docstring).
    return [
        (
            cx + r * math.cos(math.radians(a)),
            cy + r * math.sin(math.radians(a)),
        )
        for a in range(-90, 270, 60)
    ]


def color_burn(base, blend):
    safe_blend = np.clip(blend, 1e-6, 1)
    return np.clip(1 - (1 - base) / safe_blend, 0, 1)


def bake_ring(ice, mask, glyph_rgb, half, x0, y0, size):
    ice_crop = ice.crop((x0, y0, x0 + size, y0 + size))
    ice_n = np.array(ice_crop).astype(np.float64) / 255.0
    glyph_rgb_n = np.array(glyph_rgb, dtype=np.float64) / 255.0
    glyph_a = (np.array(mask).astype(np.float64) / 255.0)[..., None] * HEX_TIMER_ALPHA

    burned = color_burn(ice_n, glyph_rgb_n)
    final_n = ice_n * (1 - glyph_a) + burned * glyph_a

    out = np.zeros((size, size, 4), dtype=np.uint8)
    out[..., :3] = np.clip(final_n * 255, 0, 255).astype(np.uint8)
    # Real alpha (mask itself), NOT opaque like the score digits: those stamp
    # a whole square that's meant to fully replace that patch of ice, but
    # this ring's hole/outside is only *nominally* identical to the source
    # ice (same crop, so same pixels in theory) — in practice the runtime
    # clip's own antialiased edge sits right on the inner hex's top vertex
    # (see conversation: the pie-slice's straight 12-o'clock edge runs
    # through it), and repainting "identical" pixels through that softened
    # boundary was enough to visibly notch the vertex tip. True transparency
    # outside the ring means those pixels are never touched at all, so no
    # seam is possible regardless of clip antialiasing.
    out[..., 3] = np.array(mask)
    return Image.fromarray(out, "RGBA")


def main():
    ice = Image.open(ICE_SRC).convert("RGB")

    half = HEX_TIMER_R_OUTER + HEX_TIMER_MARGIN
    x0, y0 = HEX_TIMER_CX - half, HEX_TIMER_CY - half
    size = half * 2

    # Ring alpha mask: outer hex filled, inner hex punched out. Shared by
    # both bakes below — same ring shape, different glyph color.
    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.polygon(hex_points(half, half, HEX_TIMER_R_OUTER), fill=255)
    mdraw.polygon(hex_points(half, half, HEX_TIMER_R_INNER), fill=0)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for glyph_rgb, filename in ((GLYPH_RGB, "ring-full.png"), (GLYPH_RGB_RED, "ring-full-red.png")):
        baked = bake_ring(ice, mask, glyph_rgb, half, x0, y0, size)
        out_path = OUT_DIR / filename
        baked.save(out_path)
        print(f"{filename}: {size}x{size} at ({x0},{y0}) -> {out_path}")


if __name__ == "__main__":
    main()
