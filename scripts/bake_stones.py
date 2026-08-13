"""Build script: crops a validated stone render (design/generated/stones
final/) to a circular alpha-masked sprite and writes both a pristine source
copy (design/identicons/) and the webp actually loaded by the game
(public/identicons/).

Usage: python3 scripts/bake_stones.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "design" / "generated" / "props-upscaled"
DESIGN_OUT = ROOT / "design" / "identicons"
PUBLIC_OUT = ROOT / "public" / "identicons"

# "edit 1" variants: user's own manual touch-up pass on the upscaled stone
# renders (GIMP), same circular alpha-cropped convention as before.
STONES = {
    "stone-navy": {"src": "stone-navy-UPSCALED-transparent edit 1.png", "center": (516, 584), "r": 511},
    "stone-gold": {"src": "stone-gold-UPSCALED-transparent edit 1.png", "center": (516, 537), "r": 516},
}


def crop_circle(im: Image.Image, cx: int, cy: int, r: int) -> Image.Image:
    box = (cx - r, cy - r, cx + r, cy + r)
    cropped = im.crop(box).convert("RGBA")
    mask = Image.new("L", cropped.size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, cropped.width, cropped.height], fill=255)
    # intersect with the source's own alpha (these renders already carry a
    # real alpha channel, unlike the original navy/gold pair) rather than
    # blindly overwriting it, so a slightly-off circle fit can't reveal
    # content past the art's own edge.
    orig_alpha = np.array(cropped.split()[3])
    new_alpha = np.minimum(orig_alpha, np.array(mask))
    cropped.putalpha(Image.fromarray(new_alpha, "L"))
    return cropped


def main():
    DESIGN_OUT.mkdir(parents=True, exist_ok=True)
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    for name, cfg in STONES.items():
        im = Image.open(SRC_DIR / cfg["src"])
        cx, cy = cfg["center"]
        out = crop_circle(im, cx, cy, cfg["r"])
        design_path = DESIGN_OUT / f"{name}-source.png"
        public_path = PUBLIC_OUT / f"{name}.webp"
        out.save(design_path)
        out.save(public_path, "WEBP", quality=92)
        print(f"{name}: {out.size} -> {design_path}, {public_path}")


if __name__ == "__main__":
    main()
