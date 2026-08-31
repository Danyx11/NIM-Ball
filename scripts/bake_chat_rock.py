"""Bakes the 6th HUD rock (chat) glow sprites + the unread-message badge from
"Arena V2 chat BAL work.xcf" (root of the repo — a working file, not yet
moved into design/), following the exact same flou/light pair convention as
the 5 existing rocks in src/game.js's ROCK_GLOW (see that file's own comment
for the source: the original "Arena V2 chat.xcf").

Exported at native (1x) resolution, same as public/rocks/{id}-flou.webp /
{id}-light.webp for ice/laser/play/sound/exit — game.js's drawRockGlow()
stretches them up to the ROCK_GLOW w/h/lw/lh box (the xcf offsets x2, the
fal.ai upscale already baked into frame.webp) at draw time, so the files on
disk stay small. Verified by cross-checking this same work file's own copies
of "flou play"/"light play" and "flou sound"/"light sound" against the
already-shipped ROCK_GLOW.play/sound values: exactly x2, zero offset.

Layer name note: "bal" in this file is short for "bulle" (speech bubble),
not "ball" — logo bal / Copie de light bal / light bal are the chat rock's
baked icon / halo / core, same trio pattern as every other rock.

Usage: python3 scripts/bake_chat_rock.py (needs gimpformats + Pillow)
"""
from pathlib import Path

from gimpformats.gimpXcfDocument import GimpDocument

ROOT = Path(__file__).resolve().parent.parent
XCF_PATH = ROOT / "Arena V2 chat BAL work.xcf"
ROCKS_OUT = ROOT / "public" / "rocks"

# layer name -> output filename
LAYERS = {
    "Copie de light bal": ROCKS_OUT / "chat-flou.webp",
    "light bal": ROCKS_OUT / "chat-light.webp",
    "notif #1": ROCKS_OUT / "chat-badge.webp",
}


def main():
    doc = GimpDocument(str(XCF_PATH))
    by_name = {layer.name: layer for layer in doc.raw_layers}
    ROCKS_OUT.mkdir(parents=True, exist_ok=True)
    for name, out_path in LAYERS.items():
        layer = by_name[name]
        img = layer.image.convert("RGBA")
        img.save(out_path, "WEBP", quality=95, method=6, lossless=True)
        print(f"saved {out_path} {img.size} (from {name!r} @ {layer.xOffset},{layer.yOffset})")


if __name__ == "__main__":
    main()
