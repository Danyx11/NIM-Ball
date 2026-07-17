#!/usr/bin/env python3
"""One-off bake of the new arena composite (ice + field lines + wood ring/tail
+ goal bars + scoreboard plaque) into a single 1200x905 image, replacing
public/arena/frame.webp.

The source layers in design/arena/xcf-*.png are flattened exports straight out
of design-lab/nimball-designlab-current.xcf (the actual validated design-lab
session file — extracted via the `gimpformats` PyPI package, since neither
Pillow nor GIMP itself is available here) rather than hand-reconstructed: an
earlier version of this script recomputed the ice/wood/tail/lines from
individual pre-blend source assets and a from-scratch alignment/shadow model,
which drifted from what was actually validated in the lab (stale corner
cropping, a stale pre-notch tail-shadow source, wrong intensity). Compositing
these 5 already-correct flattened layers is far more faithful — this script
now just places them, it doesn't recreate their content.

Each xcf-*.png keeps its original bounding box from the 2560x1600 .xcf canvas
(offsets noted below, read via layer.xOffset/yOffset at extraction time). The
transform to this project's fixed 1200x905/FX0..FY1 canvas is a single
uniform scale + origin shift, anchored on the "fallback fill" layer's rect
(628, 438, 1306, 724 in xcf-space) — the exact physics-box equivalent in that
file, whose aspect (1306/724=1.8039) matches FX0..FY1's own (887/492=1.8028)
to within 0.06%, confirming it's the same rect the physics box was designed
against. Re-run (`python3 scripts/bake_arena.py`) after re-exporting any of
the xcf-*.png layers from a newer .xcf; needs Pillow (`pip install pillow`).
"""
from PIL import Image

ASSETS = "design/arena"
OUT = "public/arena/frame.webp"

W, H = 1200, 905
FX0, FY0, FX1, FY1 = 159, 206, 1046, 698
PW, PH = FX1 - FX0, FY1 - FY0

# xcf-space physics-box-equivalent rect (the "fallback fill" layer's bounds)
XCF_BOX_X, XCF_BOX_Y, XCF_BOX_W, XCF_BOX_H = 628, 438, 1306, 724
SCALE = PW / XCF_BOX_W  # == 492/724 to within 0.06%, see module docstring

# name -> (xOffset, yOffset) in the source .xcf, as extracted from the layer
LAYERS_BOTTOM_TO_TOP = [
    ("xcf-terrain.png", (574, 410)),           # ice, already 108%-cropped + corner fallback
    ("xcf-poutres.png", (268, 244)),           # wood ring + "liant" frost tail, already blended
    ("xcf-field-lines.png", (628, 440)),
    ("xcf-tableau-score-bois.png", (1006, 244)),
    ("xcf-bordures-buts.png", (16, 64)),       # goal posts, topmost
]


def to_canvas(xcf_x, xcf_y):
    return (
        round(FX0 + (xcf_x - XCF_BOX_X) * SCALE),
        round(FY0 + (xcf_y - XCF_BOX_Y) * SCALE),
    )


canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))

for name, (ox, oy) in LAYERS_BOTTOM_TO_TOP:
    layer = Image.open(f"{ASSETS}/{name}").convert("RGBA")
    resized = layer.resize((round(layer.width * SCALE), round(layer.height * SCALE)), Image.LANCZOS)
    canvas.alpha_composite(resized, to_canvas(ox, oy))

canvas.save(OUT, "WEBP", quality=90, method=6)
print("saved", OUT, canvas.size)
