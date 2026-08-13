"""One-off test: upscale the clean summer arena base (no baked lines/bars —
those are composited separately by scripts/bake_hud_field_lines.py at
whatever resolution the base ends up at, so upscaling the plain base first
keeps that later compositing step crisp/precise instead of upscaling
already-thin line art) via fal.ai's clarity-upscaler.

Reads FAL_KEY from .env (never hardcode the key here).
Usage: python3 scripts/upscale_arena_test.py
"""
import base64
import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "design" / "generated" / "arena V2"
SOURCES = ["chat winter.png", "chat spring.png", "chat night.png"]


def image_to_data_uri(path: Path) -> str:
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/png;base64,{b64}"


def upscale_one(name: str):
    src = OUT_DIR / name
    fal_key = os.environ["FAL_KEY"]
    image_data_uri = image_to_data_uri(src)
    body = {
        "image_url": image_data_uri,
        "prompt": "premium handcrafted Nordic curling arena in a pine forest, stylized concept art, painterly, crisp fine detail, natural wood and ice textures",
        "upscale_factor": 2,
        "creativity": 0.3,
        "resemblance": 0.75,
        "guidance_scale": 4,
        "num_inference_steps": 18,
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/clarity-upscaler",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Key {fal_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    print(f"--- requesting clarity-upscaler on {name} ---")
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(result, indent=2)[:500])
    images = result.get("images") or ([result["image"]] if "image" in result else [])
    stem = name.replace(".png", "")
    for i, img in enumerate(images):
        url = img["url"]
        dest = OUT_DIR / f"{stem} UPSCALED-{i}.png"
        if url.startswith("data:"):
            b64_part = url.split(",", 1)[1]
            dest.write_bytes(base64.b64decode(b64_part))
        else:
            urllib.request.urlretrieve(url, dest)
        print("saved", dest)


def main():
    for name in SOURCES:
        upscale_one(name)


if __name__ == "__main__":
    main()
