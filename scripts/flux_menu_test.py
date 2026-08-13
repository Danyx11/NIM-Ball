"""One-off test script: generate NimiCurl main-menu screen concepts from the
ice-rink reference photo via fal.ai (Flux Kontext Pro).

Not part of the game build — a throwaway helper for the DA asset pipeline.
Reads FAL_KEY from .env (never hardcode the key here).

Usage: python3 scripts/flux_menu_test.py
"""
import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF_IMAGE = ROOT / "design" / "flux-refs" / "menu-ref-ice-rink.webp"
OUT_DIR = ROOT / "design" / "generated"

MENU_PROMPT = """Using the provided image as the base, create a professional main menu screen simulation for the game NimiCurl.

BACKGROUND — STRICT CONSTRAINT
KEEP THE ORIGINAL IMAGE AS THE BACKGROUND. Do not alter the composition of the arena, ice rink, stones, wooden beams, forest, sky, lighting, colors, or perspective. The environment must remain immediately recognizable and retain its cinematic, premium quality.

TITLE — STRONG CONSTRAINT
The name NIMICURL must be clearly visible in the upper portion of the screen. It is the main title and should function as the game's logo.
Create an original, geometric, distinctive and memorable typographic treatment, inspired by the visual identity of Nimiq without directly copying its logo.
The design should evoke:
- Nimiq's geometric and modular visual language;
- a modern, digital and playful aesthetic;
- clean, simple geometric construction;
- a graphic identity that could genuinely become the official NimiCurl logo;
- a premium, contemporary feeling.

Do not favor rounded letterforms or soft, bubbly typography. Prefer sharper, structured, geometric forms with a more precise and technical character.
The word NIMICURL must remain perfectly readable. Avoid generic effects, fantasy fonts, sports clichés, or stereotypical futuristic typography. It should look like a genuine identity designed by a professional art director.
Explore several possible logo treatments: geometric construction, subtle letter cuts, an integrated graphic symbol, or a visual detail inspired by the Nimiq identity and the game's universe. Keep the result restrained and simple enough to work as a reusable game logo.

MENU
Add a main menu containing at least: PLAY, TRAINING, OPTIONS.
Do not impose a specific position for the menu. Explore several possible placements and compositions to determine what works most naturally with the image.
Test different visual hierarchies and different relationships between the title, menu and arena. The menu should feel integrated into the game's world rather than placed on top like a generic web interface.
PLAY should be the primary action, visually slightly more prominent. TRAINING and OPTIONS should remain secondary.
Avoid large conventional rectangular buttons. Favor an elegant, lightweight interface that belongs to the visual language of the arena.

ART DIRECTION
The image itself must remain the true visual foundation of the menu. The interface should sit naturally within the image without unnecessarily covering it.
Preserve: the cinematic forest atmosphere; the depth of the scene; the natural lighting; the ice rink as the central visual element; the contrast between the dark forest and luminous ice.
Do not add a uniform dark overlay across the entire image. If necessary, use only very subtle localized treatments to improve readability.
UI palette should primarily use: white / off-white; very subtle icy blue tones; optionally, a restrained accent color coherent with Nimiq's identity. Avoid excessive use of color.

DESIGN PRINCIPLES
The result must follow the principles of a professionally designed game title screen: clear visual hierarchy; generous negative space; excellent readability; few elements, each carefully designed; no visual clutter; no gratuitous effects; no large drop shadows; no excessive glowing outlines; no generic UI buttons; no template-like aesthetic; do not turn the artwork into an interface.

The interface should feel as though it naturally belongs to the NimiCurl universe.
Explore multiple menu compositions while maintaining one absolute constant: NIMICURL remains in the upper portion of the screen and is the primary title/logo.
The final result should feel like a highly polished, premium contemporary indie game with a distinctive visual identity connecting Nimiq, ice, stone, wood and the arena."""


def image_to_data_uri(path: Path) -> str:
    data = path.read_bytes()
    mime = "image/webp" if path.suffix == ".webp" else "image/png"
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def run_menu_test(label="menu-v1", num_images=4):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    image_data_uri = image_to_data_uri(REF_IMAGE)
    body = {
        "prompt": MENU_PROMPT,
        "image_url": image_data_uri,
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/flux-pro/kontext",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"{label} HTTP {e.code}: {e.read().decode()}")
        return
    print(f"--- {label} ---")
    save_result_images(label, result)


def save_result_images(label: str, result: dict) -> None:
    images = result.get("images") or []
    for i, img in enumerate(images):
        url = img["url"]
        dest = OUT_DIR / f"{label}-{i}.png"
        if url.startswith("data:"):
            b64_part = url.split(",", 1)[1]
            dest.write_bytes(base64.b64decode(b64_part))
        else:
            urllib.request.urlretrieve(url, dest)
        print(f"saved {dest}")


if __name__ == "__main__":
    run_menu_test()
