"""Bakes the under-ice score digits (design/score-digits/{0,1,2,3}.png, flat
626262 glyphs from scripts/crop_score_digits.py) against the real ice pixels
in public/arena/frame.webp, at the exact spot game.js draws them
(UNDERICE_SCORE_CX_A/B, UNDERICE_SCORE_CY, UNDERICE_SCORE_H) — one PNG per
(team, digit) pair, since team A/B sit on slightly different ice grain.

GIMP's "Assombrir" layer mode, as the user has it configured, is Color Burn
— not Darken/min, which is what canvas's own globalCompositeOperation =
'darken' implements (tried first, see conversation: came out flat grey).
Burn's per-channel formula is a division, clamp(1 - (1-base)/blend), not a
min — that division is what lets a neutral #626262 grey source still spread
into a genuinely saturated result: the ice's R channel sits further from
white than its B channel, so Burn compresses R much harder than B, pulling
the result toward blue. Darken can only ever pick the flat darker of the
two colors, so it can never differentiate channels like that.

Computed directly in sRGB (0..1 normalized), not linear light — GIMP's
legacy 8-bit Burn formula (255 - ((255-base)*256)/(blend+1)) and the
continuous modern one above converge within ~1 unit on our actual ice
pixels, so the extra linear-light round-trip that mattered for the earlier
Darken attempt isn't needed here.

Baked as a fully opaque patch (ice + digit already merged) rather than a
translucent overlay — game.js just stamps this square directly over that
patch of ice with a plain drawImage(), no composite trickery, no runtime
cost (see conversation: a live per-frame Burn recompute is only needed for
dynamic content like a future identicon watermark, not for these 4 known,
static digit values).

Usage: python3 scripts/bake_score_digits.py
"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GLYPH_DIR = ROOT / "design" / "score-digits"
ICE_SRC = ROOT / "public" / "arena" / "frame.webp"
OUT_DIR = ROOT / "public" / "score-digits"

# Must match UNDERICE_SCORE_* in src/game.js exactly — these positions are
# baked into the output pixels (the real ice grain at that spot), so a
# reposition means a re-bake, same tradeoff as the arena's own baked art.
UNDERICE_SCORE_CY = 1158
UNDERICE_SCORE_H = 200
UNDERICE_SCORE_CX = {"A": 1544, "B": 1804}
UNDERICE_SCORE_ALPHA = 0.30


def color_burn(base, blend):
    # base, blend normalized 0..1 — GIMP's "Assombrir" (Color Burn), not the
    # simpler Darken/min. Guard against blend=0 (fully transparent glyph
    # pixels can carry an arbitrary/zero RGB there) to avoid a division by
    # zero — those pixels get diluted to ~0 alpha by glyph_a right after
    # anyway, so the exact guarded value doesn't matter visually.
    safe_blend = np.clip(blend, 1e-6, 1)
    return np.clip(1 - (1 - base) / safe_blend, 0, 1)


def bake_one(ice, glyph_path, cx):
    glyph = Image.open(glyph_path).convert("RGBA")
    h = UNDERICE_SCORE_H
    w = round(glyph.width * (h / glyph.height))
    glyph_r = glyph.resize((w, h), Image.LANCZOS)

    x0 = round(cx - w / 2)
    y0 = round(UNDERICE_SCORE_CY - h / 2)
    ice_crop = ice.crop((x0, y0, x0 + w, y0 + h)).convert("RGB")

    ice_n = np.array(ice_crop).astype(np.float64) / 255.0
    glyph_arr = np.array(glyph_r).astype(np.float64)
    glyph_rgb_n = glyph_arr[..., :3] / 255.0
    glyph_a = (glyph_arr[..., 3:4] / 255.0) * UNDERICE_SCORE_ALPHA

    burned = color_burn(ice_n, glyph_rgb_n)
    final_n = ice_n * (1 - glyph_a) + burned * glyph_a

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., :3] = np.clip(final_n * 255, 0, 255).astype(np.uint8)
    out[..., 3] = 255  # fully opaque — stamped directly over the ice, see docstring
    return Image.fromarray(out, "RGBA"), (w, h)


def main():
    ice = Image.open(ICE_SRC).convert("RGB")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for team, cx in UNDERICE_SCORE_CX.items():
        for digit in range(4):
            src = GLYPH_DIR / f"{digit}.png"
            baked, size = bake_one(ice, src, cx)
            out_path = OUT_DIR / f"{team}-{digit}.png"
            baked.save(out_path)
            print(f"{team} {digit}: {size} -> {out_path}")


if __name__ == "__main__":
    main()
