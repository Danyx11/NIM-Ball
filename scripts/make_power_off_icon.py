#!/usr/bin/env python3
"""Derives design/ui/btn-power-cap-off.png (and copies it to public/ui/) from
the existing btn-power-cap.png: the bolt's solid black fill is hollowed out to
a very light gray, keeping only a ~1px dark outline of its silhouette, so the
toolbar's "power" toggle can read as visually off without dimming the whole
disc (see src/main.js's syncPowerButton()). The disc/bezel pixels (near-white,
luminance > 110) are left untouched -- only pixels dark enough to be part of
the bolt's ink are touched.

Re-run after btn-power-cap.png is regenerated from design-lab: python3 scripts/make_power_off_icon.py
"""
from PIL import Image, ImageFilter
import numpy as np

SRC = 'public/ui/btn-power-cap.png'
DESIGN_OUT = 'design/ui/btn-power-cap-off.png'
PUBLIC_OUT = 'public/ui/btn-power-cap-off.png'
# Slightly darker than the disc's own near-white (~240-245) so the hollowed
# bolt still reads as a faint shape, not a perfect cutout.
FILL = (224, 224, 220)
INK_LUMA_THRESHOLD = 110
INK_MIN_ALPHA = 150

def main():
    im = Image.open(SRC).convert('RGBA')
    arr = np.array(im).astype(np.int16)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    lum = (r + g + b) / 3
    ink = (lum < INK_LUMA_THRESHOLD) & (a > INK_MIN_ALPHA)

    # Erode the ink mask by ~1px (3x3 min filter) so only a thin rim of the
    # original mask is left un-eroded -- that rim becomes the outline; the
    # eroded (interior) region gets hollowed out to FILL.
    mask_im = Image.fromarray((ink * 255).astype('uint8'))
    eroded = np.array(mask_im.filter(ImageFilter.MinFilter(3))) > 127

    out = arr.copy()
    for ch in range(3):
        out[..., ch][eroded] = FILL[ch]

    Image.fromarray(out.astype('uint8'), 'RGBA').save(DESIGN_OUT)
    Image.fromarray(out.astype('uint8'), 'RGBA').save(PUBLIC_OUT)
    print(f'wrote {DESIGN_OUT} and {PUBLIC_OUT}')

if __name__ == '__main__':
    main()
