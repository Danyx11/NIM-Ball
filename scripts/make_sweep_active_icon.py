#!/usr/bin/env python3
"""Derives design/ui/btn-sweep-cap-active.png (and copies it to public/ui/) from
btn-sweep-cap.png, the same way make_power_off_icon.py derives the power
button's "off" state: the broom's solid black fill is hollowed out to a very
light gray, keeping only a ~1px dark outline of its silhouette, so the
"balai"/sweep toolbar toggle can read as engaged (a shot's worth of ice
patch is currently placed and can still be moved/removed before PLAY)
without dimming the whole disc — see src/game.js's syncSweepButton(). The
disc/bezel pixels (near-white, luminance > 110) are left untouched — only
pixels dark enough to be part of the broom's ink are touched.

Re-run after btn-sweep-cap.png is regenerated from design-lab:
python3 scripts/make_sweep_active_icon.py
"""
from PIL import Image, ImageFilter
import numpy as np

SRC = 'public/ui/btn-sweep-cap.png'
DESIGN_OUT = 'design/ui/btn-sweep-cap-active.png'
PUBLIC_OUT = 'public/ui/btn-sweep-cap-active.png'
FILL = (224, 224, 220)
INK_LUMA_THRESHOLD = 110
INK_MIN_ALPHA = 150

def main():
    im = Image.open(SRC).convert('RGBA')
    arr = np.array(im).astype(np.int16)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    lum = (r + g + b) / 3
    ink = (lum < INK_LUMA_THRESHOLD) & (a > INK_MIN_ALPHA)

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
