"""Bakes public/handoff/ice-mask.webp — the white ice sheet used by the Pass &
Play "hand-off" mask (game.js's drawHandoffMask/startHandoff, shown between
aim phases so the other player can't see the board).

Sourced from the real ice pixels in public/arena/frame.webp (same "crop the
actual shipped art" technique as scripts/bake_hex_timer.py/bake_waiting_label.py),
cropped to the NOTCH_X0..NOTCH_X1 x FY0..FY1 rect — wider than the FX0..FY1
field rect on purpose, so it also covers the goal-mouth recesses (the ice
strip between each flat wall and the black bar, GY0..GY1) — pixel-aligned
with game.js's own physics-box coordinates for free, no separate scale/offset
math to keep in sync, unlike design/arena/xcf-terrain.png (the pre-lines ice
layer bake_arena.py composites from), which lives in a different, older
coordinate space (that script's own 1200x905 canvas) than the current,
since-upscaled 3312x1896 frame.webp actually shipped.

Two different treatments layered together, per feedback: a flat, light lift
toward an icy-white TARGET (LIGHT_BLEND) keeps the ice's own natural
scratches/cracks visible everywhere — but that alone left the *deliberate*
field markings (center line, hexagon, goal-crease circles — xcf-field-lines.png
in scripts/bake_arena.py's own layer stack, painted semi-transparent onto the
ice, not part of its natural texture) still clearly legible, since they're
much higher-contrast than a scratch. Those get detected via a per-pixel
luminance threshold (LINE_LO/LINE_HI — well clear of scratch-level darkness,
measured off the actual shipped art) and erased far more aggressively toward
the same TARGET, dilated (MaxFilter) + feathered (GaussianBlur) so the
erasure fully covers each stroke's own anti-aliased edge instead of leaving a
faint ghost outline — the blur is applied to this small line-only mask, not
to the ice image itself, so scratch texture elsewhere stays crisp.

The bake is a plain rectangle — game.js clips it at runtime to the real
ice boundary (traceHandoffMaskPath(): the chamfered octagon from
CHAMFER_X/CHAMFER_Y, same shape the physics CORNERS array collides against,
plus the two goal-notch rects out to NOTCH_X0/NOTCH_X1) rather than baking
that shape into this file, so the mask shape stays in sync with the physics
constants automatically if those ever change.

Usage: python3 scripts/bake_handoff_mask.py (needs numpy + Pillow)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICE_SRC = ROOT / "public" / "arena" / "frame.webp"
OUT_PATH = ROOT / "public" / "handoff" / "ice-mask.webp"

# Must match FY0/FY1 and NOTCH_X0/NOTCH_X1 in src/game.js exactly.
FY0, FY1 = 626, 1274
NOTCH_X0, NOTCH_X1 = 1050, 2298

TARGET_RGB = np.array([222, 236, 246]) / 255.0   # soft icy-white, not pure white
LIGHT_BLEND = 0.28    # flat lift applied everywhere — keeps scratch texture readable

# Luma (0..1) thresholds picked off actual measured pixels: plain ice sits
# ~0.75-0.85, field-line strokes measured ~0.40-0.45 at their core. LINE_HI
# sits well above the line's own luma (catches its soft anti-aliased edge
# too) but below typical scratch darkness, so scratches are left alone.
LINE_LO, LINE_HI = 0.45, 0.80
LINE_MASK_DILATE = 9   # MaxFilter kernel size — grows the detected zone to fully cover each stroke's AA edge
LINE_MASK_FEATHER = 5  # GaussianBlur radius on the (small, binary-ish) mask itself, not the ice pixels


def main():
    ice = Image.open(ICE_SRC).convert("RGB")
    crop = ice.crop((NOTCH_X0, FY0, NOTCH_X1, FY1))
    arr = np.asarray(crop).astype(np.float64) / 255.0
    luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114

    line_mask = np.clip((LINE_HI - luma) / (LINE_HI - LINE_LO), 0, 1)
    mask_img = Image.fromarray((line_mask * 255).astype(np.uint8))
    mask_img = mask_img.filter(ImageFilter.MaxFilter(LINE_MASK_DILATE))
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(LINE_MASK_FEATHER))
    line_alpha = (np.asarray(mask_img).astype(np.float64) / 255.0)[..., None]

    lightly_lifted = arr * (1 - LIGHT_BLEND) + TARGET_RGB * LIGHT_BLEND
    erased = np.ones_like(arr) * TARGET_RGB
    baked_arr = lightly_lifted * (1 - line_alpha) + erased * line_alpha

    baked = Image.fromarray(np.clip(baked_arr * 255, 0, 255).astype(np.uint8))
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    baked.save(OUT_PATH, "WEBP", quality=92, method=6)
    print(f"saved {OUT_PATH} {baked.size}")


if __name__ == "__main__":
    main()
