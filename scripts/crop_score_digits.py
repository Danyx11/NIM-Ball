"""Splits design/0123.png (digits 0-3, hand-exported from GIMP as the source
for the under-ice score filigrane, see conversation) into 4 individual
transparent PNGs, one per digit.

Cropped on real alpha (no flood-fill/color-key needed, the source already has
clean transparency). Each digit gets its own horizontal bounding box, but all
4 share the same vertical crop range (the union of every glyph's vertical
extent) so they stay baseline-aligned when swapped in at runtime — cropping
each digit to its own tight vertical bbox independently would let a glyph
without a descender/ascender (e.g. "1" vs "2") drift relative to the others.

Usage: python3 scripts/crop_score_digits.py
"""
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "0123.png"
OUT_DIR = ROOT / "design" / "score-digits"
PAD = 6  # px margin kept around each glyph, in source-image pixels


def main():
    im = Image.open(SRC).convert("RGBA")
    a = np.array(im)
    alpha = a[..., 3]
    mask = alpha > 10

    lbl, n = ndimage.label(mask)
    if n != 4:
        raise RuntimeError(f"expected 4 connected components (digits), found {n} — inspect manually")

    components = []
    for i in range(1, n + 1):
        ys, xs = np.where(lbl == i)
        components.append((xs.min(), xs.max(), ys.min(), ys.max()))
    components.sort(key=lambda c: c[0])  # left to right = 0,1,2,3

    shared_y0 = min(c[2] for c in components)
    shared_y1 = max(c[3] for c in components)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    h, w = a.shape[:2]
    for digit, (x0, x1, _, _) in enumerate(components):
        cx0 = max(0, x0 - PAD)
        cx1 = min(w, x1 + 1 + PAD)
        cy0 = max(0, shared_y0 - PAD)
        cy1 = min(h, shared_y1 + 1 + PAD)
        crop = im.crop((cx0, cy0, cx1, cy1))
        out_path = OUT_DIR / f"{digit}.png"
        crop.save(out_path)
        print(f"digit {digit}: bbox x[{x0},{x1}] shared_y[{shared_y0},{shared_y1}] -> {out_path} {crop.size}")


if __name__ == "__main__":
    main()
