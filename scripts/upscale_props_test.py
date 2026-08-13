"""One-off test: upscale the ball + stone sprites via fal.ai's clarity-upscaler,
matching the fine-detail level the arena background just got (see
scripts/upscale_arena_test.py) so nothing reads as visually flatter by
contrast once composited together.

These are isolated-object PNGs with real alpha (soft-edged for the ball,
hard-edged for the stones) — most upscalers only handle RGB, so sending the
raw transparent PNG would flatten alpha to some arbitrary/unpredictable
background. Instead: composite onto solid chroma-key GREEN first (safe choice
here specifically because both stones and the ball have white/near-white
elements of their own — a white backing, this project's more common
convention, would be unkeyable against those), upscale, then chroma-key the
green back out to rebuild a clean alpha channel.

Reads FAL_KEY from .env. Usage: python3 scripts/upscale_props_test.py
"""
import base64
import json
import os
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "design" / "generated" / "props-upscaled"
CHROMA = (0, 255, 0)

SOURCES = [
    ("ball", ROOT / "design" / "ball" / "curl ball.png",
     "a curling/boulodrome ball game piece, concentric red/white/blue rings, isolated on a flat solid chroma-key green background, strict top-down studio product shot, crisp fine surface detail"),
    ("stone-navy", ROOT / "design" / "generated" / "stones final" / "A blue big stone noshade.png",
     "a premium handcrafted deep navy blue curling stone game piece with a hexagonal glass window, isolated on a flat solid chroma-key green background, strict top-down studio product shot, crisp fine wood and glass detail"),
    ("stone-gold", ROOT / "design" / "generated" / "stones final" / "A yellow big stone noshade.png",
     "a premium handcrafted gold curling stone game piece with a hexagonal glass window, isolated on a flat solid chroma-key green background, strict top-down studio product shot, crisp fine wood and glass detail"),
]


def composite_on_chroma(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, CHROMA + (255,))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def image_to_data_uri(im: Image.Image) -> str:
    import io
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def upscale(data_uri: str, prompt: str) -> dict:
    fal_key = os.environ["FAL_KEY"]
    body = {
        "image_url": data_uri,
        "prompt": prompt,
        "upscale_factor": 2,
        "creativity": 0.25,
        "resemblance": 0.85,
        "guidance_scale": 4,
        "num_inference_steps": 18,
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/clarity-upscaler",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def dechroma(im: Image.Image, tolerance=60) -> Image.Image:
    """Rebuilds alpha by distance from pure chroma green, with a soft falloff
    band (not a hard cutoff) so edges don't come out jagged."""
    a = np.array(im.convert("RGB")).astype(np.float32)
    dist = np.linalg.norm(a - np.array(CHROMA, dtype=np.float32), axis=2)
    alpha = np.clip((dist - tolerance) / 40.0, 0, 1) * 255
    out = np.dstack([a, alpha]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for label, src, prompt in SOURCES:
        print(f"--- {label} ({src.name}) ---")
        chroma_img = composite_on_chroma(src)
        chroma_path = OUT_DIR / f"{label}-chroma-src.png"
        chroma_img.save(chroma_path)
        try:
            result = upscale(image_to_data_uri(chroma_img), prompt)
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code}: {e.read().decode()}")
            continue
        print(json.dumps(result, indent=2)[:400])
        img_info = result.get("image") or (result.get("images") or [None])[0]
        if not img_info:
            print("no image in response, skipping")
            continue
        url = img_info["url"]
        raw_path = OUT_DIR / f"{label}-UPSCALED-raw.png"
        if url.startswith("data:"):
            raw_path.write_bytes(base64.b64decode(url.split(",", 1)[1]))
        else:
            urllib.request.urlretrieve(url, raw_path)
        print("saved raw", raw_path)
        upscaled = Image.open(raw_path)
        final = dechroma(upscaled)
        final_path = OUT_DIR / f"{label}-UPSCALED-transparent.png"
        final.save(final_path)
        print("saved transparent", final_path, final.size)


if __name__ == "__main__":
    main()
