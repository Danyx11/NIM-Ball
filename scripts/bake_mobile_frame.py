#!/usr/bin/env python3
"""Crop public/arena/frame.webp down to a mobile-only variant.

Mobile never shows the full 3312x1896 arena art — game.js's MOBILE_CROP rect
(the CSS zoom's own generous, device-shape-independent superset of what's
ever visible, see the comment above MOBILE_CROP in game.js) is already a
device-independent bound on that. game.js already sizes the canvas *backing
buffer* down to just that rect so the GPU never rasterizes the rest, but the
*source image itself* was still the full-resolution file — same download/
decode cost on a phone as on desktop, for pixels that would never actually
draw there.

A straight crop (no resample) of the exact MOBILE_CROP rect out of the
already-baked frame.webp keeps every pixel bit-identical to the desktop art,
so it needs no realignment: game.js just drawImage()s it at
(MOBILE_CROP.x0, MOBILE_CROP.y0) instead of (0, 0) — see the `mobile` branch
there.

MOBILE_CROP must match game.js's own copy exactly — if that rect ever
changes there, re-run this (`python3 scripts/bake_mobile_frame.py`; needs
Pillow, `pip install pillow`).
"""
from PIL import Image

SRC = "public/arena/frame.webp"
OUT = "public/arena/frame-mobile.webp"

# Keep in sync with MOBILE_CROP in src/game.js
X0, Y0, X1, Y1 = 793, 286, 3010, 1580

frame = Image.open(SRC).convert("RGBA")
cropped = frame.crop((X0, Y0, X1, Y1))
cropped.save(OUT, "WEBP", quality=90, method=6)
print("saved", OUT, cropped.size)
