"""Bakes the under-ice "waiting" label (public/waiting-label/word.png,
dot-0.png, dot-1.png, dot-2.png) against the real ice pixels in
public/arena/frame.webp — same "engrave a flat grey glyph into the ice via
Color Burn, at a chosen alpha, keeping real alpha for live compositing"
technique as scripts/bake_hex_timer.py (see that script's docstring for why
Burn and not Darken).

Shown in LAN mode while the local player waits on their opponent's shot (see
game.js's `phase === 'lanWait'`). The word is procedurally rendered text (Gill
Sans Bold, the only source — no hand-exported art, like the hex ring's
procedural polygon), and the three trailing dots are baked as separate
patches at their own exact ice position each (word and dots sit on slightly
different ice grain, same reasoning as the score digits' per-team bake)
so game.js can fade each one in/out independently for the classic
"waiting..." stepped-dot animation, without ever live-recompositing the burn.

Usage: python3 scripts/bake_waiting_label.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICE_SRC = ROOT / "public" / "arena" / "frame.webp"
OUT_DIR = ROOT / "public" / "waiting-label"

FONT_PATH = "/System/Library/Fonts/Supplemental/GillSans.ttc"
FONT_INDEX = 1  # Bold face within the .ttc
TEXT = "waiting"

# Must match UNDERICE_WAITING_* in src/game.js exactly — these positions are
# baked into the output pixels (the real ice grain at that spot), so a
# reposition means a re-bake, same tradeoff as the score digits / hex ring.
CENTER_X = 1674
CY = 740  # midpoint between the top beam's bottom edge (~626) and the hex's top vertex (~854), per feedback
FONT_SIZE = 46
DOT_R = 5
WORD_DOT_GAP = 14   # gap between the word's right edge and the first dot
DOT_SPACING = 20    # center-to-center distance between consecutive dots

GLYPH_RGB = (0x62, 0x62, 0x62)      # same flat grey as the score digit / hex ring glyphs
ALPHA = 0.30                         # same burn strength as the score filigrane / hex ring


def color_burn(base, blend):
    safe_blend = np.clip(blend, 1e-6, 1)
    return np.clip(1 - (1 - base) / safe_blend, 0, 1)


def bake_patch(ice, mask_img, x0, y0):
    w, h = mask_img.size
    ice_crop = ice.crop((x0, y0, x0 + w, y0 + h)).convert("RGB")
    ice_n = np.array(ice_crop).astype(np.float64) / 255.0
    glyph_rgb_n = np.array(GLYPH_RGB, dtype=np.float64) / 255.0
    mask_n = np.array(mask_img).astype(np.float64) / 255.0
    glyph_a = mask_n[..., None] * ALPHA

    burned = color_burn(ice_n, glyph_rgb_n)
    final_n = ice_n * (1 - glyph_a) + burned * glyph_a

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., :3] = np.clip(final_n * 255, 0, 255).astype(np.uint8)
    # Real alpha, not opaque like the score digits — game.js fades each dot
    # in/out live via drawImage + globalAlpha (same pattern as the hex ring's
    # red-pulse), so transparency outside the glyph must be genuine.
    out[..., 3] = np.array(mask_img)
    return Image.fromarray(out, "RGBA")


def main():
    ice = Image.open(ICE_SRC).convert("RGB")
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE, index=FONT_INDEX)

    l, t, r, b = font.getbbox(TEXT)
    word_w, word_h = r - l, b - t
    pad = 6
    word_mask = Image.new("L", (word_w + pad * 2, word_h + pad * 2), 0)
    ImageDraw.Draw(word_mask).text((pad - l, pad - t), TEXT, font=font, fill=255)

    dot_pad = 4
    dot_size = DOT_R * 2 + dot_pad * 2
    dot_mask = Image.new("L", (dot_size, dot_size), 0)
    ImageDraw.Draw(dot_mask).ellipse(
        (dot_pad, dot_pad, dot_pad + DOT_R * 2, dot_pad + DOT_R * 2), fill=255
    )

    # Layout: word left-aligned, then 3 dots — whole group centered at
    # CENTER_X. Must match the mirrored layout math in src/game.js exactly.
    dots_span = DOT_SPACING * 2 + DOT_R * 2
    total_w = word_mask.width + WORD_DOT_GAP + dots_span
    group_left = CENTER_X - total_w / 2

    word_x0 = round(group_left)
    word_y0 = round(CY - word_mask.height / 2)

    dot0_left = group_left + word_mask.width + WORD_DOT_GAP
    dot_cxs = [dot0_left + DOT_R + i * DOT_SPACING for i in range(3)]

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    word_baked = bake_patch(ice, word_mask, word_x0, word_y0)
    word_baked.save(OUT_DIR / "word.png")
    print(f"word: {word_mask.size} at ({word_x0},{word_y0}) -> word.png")

    for i, cx in enumerate(dot_cxs):
        x0 = round(cx - dot_mask.width / 2)
        y0 = round(CY - dot_mask.height / 2)
        baked = bake_patch(ice, dot_mask, x0, y0)
        out_path = OUT_DIR / f"dot-{i}.png"
        baked.save(out_path)
        print(f"dot-{i}: {dot_mask.size} at ({x0},{y0}) -> {out_path}")


if __name__ == "__main__":
    main()
