"""One-off test script: generate Arena-module art from the clean reference
via fal.ai (Flux Kontext Pro and/or Nano Banana / Gemini 2.5 Flash Image).

Not part of the game build — a throwaway helper for the DA asset pipeline.
Reads FAL_KEY from .env (never hardcode the key here).

Usage: python3 scripts/flux_arena_test.py
"""
import base64
import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF_IMAGE = ROOT / "design" / "flux-refs" / "arena-ref-for-flux.png"
OUT_DIR = ROOT / "design" / "generated"

MASTER_PROMPT = """A small forgotten curling arena hidden in the middle of a vast Nordic forest, handcrafted by invisible forest artisans. The place feels ancient, authentic, peaceful and mysterious, yet entirely believable. The player should feel like they accidentally discovered a secret place that has always existed.

Stylized realism between high-end concept art and modern AAA stylized games. Credible materials with slightly idealized shapes. Handcrafted, timeless, elegant. Premium without ostentation. Never cartoon. Never photorealistic.

Immense Nordic pine forest. Night atmosphere. Cold air. Soft snow. Frozen ground. Natural silence. Large negative space surrounding the arena. The arena intentionally appears small compared to the surrounding wilderness. The forest enhances the feeling of isolation without becoming visually dominant.

Strict orthographic top-down view. Small handcrafted curling/boulodrome arena. Massive wooden beams define the boundaries. Natural wood aged by weather. Subtle stone details. Ice surface clean and slightly magical. Slightly clipped arena corners. Goals integrated naturally into the arena construction. Everything appears carefully built by hand.

Natural wood. Weathered stone. Clear ice. Soft snow. Moss. Pine needles. Natural imperfections. Materials should feel tactile and inviting. Every surface should look pleasant to touch.

Soft natural moonlight. Diffuse cinematic lighting. Subtle warm reflections from the wooden structure. Cold ambient blue lighting. Very gentle golden Nimiq accents. Atmosphere always takes priority over physical realism.

Minimalist composition. Large breathing spaces. Nothing unnecessary. The player's eye naturally returns to the arena. The environment supports the gameplay instead of competing with it. Visual silence is part of the design.

Contemplative. Peaceful. Premium. Warm craftsmanship. Quiet mystery. Hidden place. Nature first. Everything in its right place.

High-quality stylized concept art. Game-ready visual language. Consistent materials. Clean silhouettes. Readable shapes. Controlled detail density. No visual clutter. Designed for real-time game production.

Avoid: photorealism, hyperrealistic PBR showcase, cartoon, Pixar, anime, cell shading, exaggerated fantasy, cyberpunk, sci-fi interfaces, steampunk, overly saturated colors, heavy texture noise, visual clutter, busy composition, excessive particle effects, artificial dramatic lighting, floating UI elements, cheap mobile game aesthetic, plastic-looking materials."""

MODULE_ARENA = "handcrafted miniature curling arena, top-down orthographic, weathered wooden beams, clipped corners, integrated goals, premium handcrafted construction"

FIVE_RULES = """Strict top-down orthographic gameplay.
Stylized realism, never photorealistic.
Nature always dominates technology.
Minimalist composition with generous negative space.
Premium handcrafted Nordic atmosphere."""

FULL_PROMPT = f"{MASTER_PROMPT}\n\n{MODULE_ARENA}\n\n{FIVE_RULES}"

MODELS = {
    "flux-kontext-pro": "fal-ai/flux-pro/kontext",
    "nano-banana": "fal-ai/gemini-25-flash-image/edit",
}


def image_to_data_uri(path: Path) -> str:
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/png;base64,{b64}"


def call_model(model_id: str, image_data_uri: str, num_images: int = 1) -> dict:
    fal_key = os.environ["FAL_KEY"]
    body = {
        "prompt": FULL_PROMPT,
        "num_images": num_images,
        "output_format": "png",
    }
    # fal-ai/flux-pro/kontext takes a single "image_url"; fal-ai/gemini-25-
    # flash-image/edit (nano-banana) takes a list under "image_urls" instead.
    if "gemini" in model_id or "nano-banana" in model_id:
        body["image_urls"] = [image_data_uri]
    else:
        body["image_url"] = image_data_uri
    req = urllib.request.Request(
        f"https://fal.run/{model_id}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Key {fal_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def save_result_images(label: str, result: dict) -> None:
    images = result.get("images") or []
    for i, img in enumerate(images):
        url = img["url"]
        dest = OUT_DIR / f"arena-{label}-{i}.png"
        if url.startswith("data:"):
            # data:image/png;base64,<...> — decode directly instead of
            # treating it as a fetchable network location.
            b64_part = url.split(",", 1)[1]
            dest.write_bytes(base64.b64decode(b64_part))
        else:
            urllib.request.urlretrieve(url, dest)
        print(f"saved {dest}")


def _redact(obj):
    """Deep-copy a fal.ai result for logging, replacing any data: URI's
    base64 payload with its length so huge blobs don't flood stdout."""
    if isinstance(obj, dict):
        return {k: _redact(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    if isinstance(obj, str) and obj.startswith("data:") and len(obj) > 200:
        return f"<data URI, {len(obj)} chars>"
    return obj


def main(models=None):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    image_data_uri = image_to_data_uri(REF_IMAGE)
    for label, model_id in (models or MODELS).items():
        print(f"--- {label} ({model_id}) ---")
        try:
            result = call_model(model_id, image_data_uri, num_images=1)
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code}: {e.read().decode()}")
            continue
        print(json.dumps(_redact(result), indent=2)[:1000])
        try:
            save_result_images(label, result)
        except Exception as e:
            print(f"save failed: {type(e).__name__}: {e}")


MOOD_REF = ROOT / "design" / "generated" / "arena-flux-kontext-pro-0.png"

MERGE_PROMPT = f"""{MASTER_PROMPT}

{MODULE_ARENA}

The first reference image defines the exact composition, top-down camera angle, arena geometry (clipped corners, goal openings, proportions) and ice/wood layout — preserve it precisely, do not reinterpret the shape or switch to a 3/4 or isometric view.

The second reference image defines the mood and lighting only — night atmosphere, soft shadows, contrast — adapt that lighting feeling onto the first image's geometry.

Lighting should stay soft, diffuse and ambient — primarily distant moonlight, not multiple close local light sources (no torches or lamps right at the ice edge), since no dynamic lighting will interact with objects on the ice at runtime; a single consistent distant light direction reads more natural than several nearby point lights.

Forest: flat taiga/boreal forest floor, no elevation or slopes, not a mountain/alpine setting.

{FIVE_RULES}"""


def run_merge_test():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    geo_ref = image_to_data_uri(REF_IMAGE)
    mood_ref = image_to_data_uri(MOOD_REF)
    body = {
        "prompt": MERGE_PROMPT,
        "image_urls": [geo_ref, mood_ref],
        "num_images": 1,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:1000])
    save_result_images("merge-mood", result)


BANANA_V1 = ROOT / "design" / "generated" / "arena-nano-banana-0.png"

CONTRAST_PROMPT = f"""{MASTER_PROMPT}

{MODULE_ARENA}

Keep this reference image's arena exactly as-is: same geometry, same bright, clear, warm-toned wood, same well-lit legible ice — do not darken or desaturate the arena itself.

Only adjust the surrounding forest: let it recede into a softer, more cinematic dusk/night shadow further back, adding a bit more atmospheric depth and mystery in the background trees, while the arena stays the brightest, most legible element in the frame — a lit clearing standing out against a darker forest, not uniform darkness across the whole scene.

Lighting should stay soft, diffuse and ambient — primarily distant moonlight, not multiple close local light sources (no torches or lamps right at the ice edge), since no dynamic lighting will interact with objects on the ice at runtime.

Forest: flat taiga/boreal forest floor, no elevation or slopes, not a mountain/alpine setting.

{FIVE_RULES}"""


def run_contrast_test(num_images=3):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref = image_to_data_uri(BANANA_V1)
    body = {
        "prompt": CONTRAST_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:1000])
    save_result_images("contrast", result)


TEMPERATURE_REF = ROOT / "public" / "bg" / "nature-pinede.webp"

IDEATION_PROMPT = f"""{MASTER_PROMPT}

{MODULE_ARENA}

Environment override: temperate Nordic summer forest floor — moss, grass, scattered pine needles and twigs, only sparse patches of snow or none at all, not deep winter. Warm, mossy, inviting ground tones matching the reference image's color and warmth (the reference shows the target color temperature/season only, not the arena's shape).

Soft beams of moonlight or diffuse light filter through the forest canopy between the trees, motivating why the small arena clearing below reads as gently lit — the arena and ice should stay clearly legible, light and readable, atmosphere should support that legibility rather than compete with it.

This pass is for mood/ideation only, exploring lighting and season direction.

{FIVE_RULES}"""


def image_to_data_uri_any(path: Path) -> str:
    from PIL import Image
    import io
    img = Image.open(path).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def run_ideation_test(num_images=3):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref = image_to_data_uri_any(TEMPERATURE_REF)
    body = {
        "prompt": IDEATION_PROMPT,
        "image_url": ref,
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
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:1000])
    save_result_images("ideation", result)


SEASON_PROMPT = f"""{MASTER_PROMPT}

{MODULE_ARENA}

Keep the first reference image's arena exactly as-is: same geometry, same bright, clear, warm-toned wood, same well-lit legible ice — do not darken or desaturate the arena itself.

Environment override: temperate Nordic summer forest, not deep winter — replace heavy snow cover with the moss, grass, scattered pine needles and warm ground tones shown in the second reference image. Only sparse patches of snow or none at all.

Add soft beams of moonlight filtering through the forest canopy between the trees in the background, motivating why the clearing is gently lit, without adding local lamps, torches or point lights near the ice itself.

The arena stays the brightest, most legible element in the frame — a lit clearing standing out against a softly shadowed forest, not uniform darkness.

{FIVE_RULES}"""


def run_season_test(num_images=3):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    arena_ref = image_to_data_uri(BANANA_V1)
    season_ref = image_to_data_uri_any(TEMPERATURE_REF)
    body = {
        "prompt": SEASON_PROMPT,
        "image_urls": [arena_ref, season_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:1000])
    save_result_images("season", result)


MODULE_STONE = "polished curling stone, premium handcrafted object, subtle magical glow, centered identicon under smooth translucent glass, clean silhouette, tactile materials"

GAMEPLAY_REF = ROOT / "design" / "flux-refs" / "live-stage-laser.png"

ENSEMBLE_PROMPT = f"""{MASTER_PROMPT}

{MODULE_ARENA}

{MODULE_STONE}

Keep the first reference image's arena exactly as-is: same geometry, same bright, clear, warm-toned wood, same well-lit legible ice.

Use the second reference image only as a layout/content guide — it shows a real (placeholder, flat, unstyled) game screenshot: three stones per team, a ball at the center, and a thin aim-trajectory line from one stone toward the center. Reproduce that same layout and content, but fully restyled in the arena's own premium handcrafted aesthetic — do not copy the flat vector look of the second image.

For the aim-trajectory line specifically: render it as a soft glow visible beneath the frozen ice surface, as if a light source were glowing from within/underneath the ice and diffusing softly through the translucent surface — not a laser beam sitting on top of the ice, not a sci-fi effect. The ice itself is described as clean and slightly magical; this glow is that magic made visible.

Add a ball at the center of the ice, styled consistently with the stones (premium handcrafted object, clean silhouette).

{FIVE_RULES}"""


def run_ensemble_test(num_images=4):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    arena_ref = image_to_data_uri(BANANA_V1)
    gameplay_ref = image_to_data_uri_any(GAMEPLAY_REF)
    body = {
        "prompt": ENSEMBLE_PROMPT,
        "image_urls": [arena_ref, gameplay_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:1000])
    save_result_images("ensemble", result)


IDENTICON_REF = ROOT / "design" / "flux-refs" / "identicon-clean.png"
STONE_STYLE_REF = ROOT / "design" / "generated" / "arena-ensemble-3.png"

DOME_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

Strict orthographic top-down view of a single curling stone icon/sprite, viewed directly from above — flat, no perspective, no foreshortening, not an angled 3/4 product shot. Isolated on a plain neutral dark background (no arena, no ice, no forest) — this is a detail study, not a scene.

Rendering note: this must match the same painterly, atmospheric, stylized concept-art quality as the rest of the set — avoid a glossy CGI/3D-product-render look (no studio-sharp specular highlights, no ray-traced glass sharpness). The glass should read as hand-painted and consistent with the arena's soft lighting, not a polished tech render.

The first reference image shows the identicon pattern/colors to use — reproduce that exact identicon's shapes and colors, fully restyled (do not copy its flat vector ring style).

The second reference image shows the target material and lighting language (premium handcrafted, warm wood/cold accents) to stay consistent with.

Wood tone: near-white, pale bleached/whitewashed wood — either frosted or painted white, not a warm brown wood this time.

The rim is a single continuous ring (not physically separated pieces), divided into four large, clearly lit LED quarter-arcs — each LED segment fills a full quarter (90 degrees) of the ring's circumference, not a small strip or dot. The four glowing quarter-arcs sit flush together forming the ring itself, thin seams between them, bright and clearly legible as four distinct quadrants — this is a life-points/damage indicator in the actual game, each quarter individually lights up or goes dark, so the four quadrants must read unambiguously.

Increase the overall realism and material fidelity — detailed, high-fidelity rendering of the wood, glass and LED glow.

Inside that ring, the bubble/dome itself is tinted in the team's color (cool navy blue) with the identicon sitting beneath the glass — make the identicon noticeably larger this time, filling most of the dome's diameter, still gently magnified by the glass.

{FIVE_RULES}"""


def run_dome_test(num_images=4):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    identicon_ref = image_to_data_uri_any(IDENTICON_REF)
    style_ref = image_to_data_uri(STONE_STYLE_REF)
    body = {
        "prompt": DOME_PROMPT,
        "image_urls": [identicon_ref, style_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:1000])
    save_result_images("dome", result)


PHOTOREAL_PROMPT = f"""{MODULE_STONE}

Strict orthographic top-down view of a single curling stone icon/sprite, viewed directly from above — flat, no perspective. Isolated on a plain neutral dark background.

Push this toward full photorealism — physically-based rendering, photographic quality, realistic material physics and light behavior, like a professional studio product photograph. Not stylized, not painterly this time — as real/believable as possible.

Keep the exact same design as the reference image: near-white bleached wood ring, four large glowing amber LED quarter-arcs each spanning 90 degrees of the ring, navy blue glass dome with the identicon beneath it, magnified by the glass.

Strict top-down orthographic gameplay.
Nature always dominates technology in the overall game, but for this shot push material realism as far as possible.
Premium handcrafted Nordic object, photographed."""


def run_photoreal_test(num_images=3):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref = image_to_data_uri(ROOT / "design" / "generated" / "arena-dome-2-KEEP-liked-by-user.png")
    body = {
        "prompt": PHOTOREAL_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:1000])
    save_result_images("photoreal", result)


NONNEGOTIABLE = """Non-negotiable requirements, all four must be satisfied:
1. ABSOLUTE TOP PRIORITY: strict orthographic top-down view, camera directly above, zero perspective, zero tilt, not a 3/4 or angled product shot — this matters more than any other stylistic choice in this prompt.
2. At the center of the stone is an EMPTY circular or hexagonal glass viewing window/screen — like a display slot waiting to show content. Leave it empty/blank (dark glass, faint reflection) — do not draw any character, symbol or pattern inside it. This window will have real content composited into it afterward.
3. The stone is colored in the team's color: deep navy indigo, hex #1F2348.
4. Four large LED arcs are visible, each spanning a full quarter (90 degrees) of the stone's circumference, forming a continuous glowing ring around the rim — a life-points/damage indicator, must read as four clearly distinct quadrants."""

SPRINT_A_PROMPT = f"""{MASTER_PROMPT}

{NONNEGOTIABLE}

Concept: no glass dome this time — a simple, solid handcrafted object, painted wood and enamel, the identicon inlaid flush into the surface rather than under glass. Matte and tactile, not glossy.

{FIVE_RULES}"""

SPRINT_B_PROMPT = f"""{MASTER_PROMPT}

{NONNEGOTIABLE}

Concept: the identicon sits under a glass dome, magnified — but render it with the exact same atmospheric, painterly quality as the arena and forest images (soft light, natural material imperfections), not a glossy CGI product-render look.

{FIVE_RULES}"""

SPRINT_C_PROMPT = f"""{MASTER_PROMPT}

{NONNEGOTIABLE}

Concept: push for full photorealism this time — physically-based rendering, real-world material physics and light behavior, photographic quality, as real and believable as possible. This is a deliberate realism test.

Strict top-down orthographic gameplay.
Premium handcrafted Nordic object, photographed."""

SPRINT_KONTEXT_PROMPT = f"""{MASTER_PROMPT}

{NONNEGOTIABLE}

Free creative interpretation of this game piece within the above constraints — surprise us with material and lighting choices, as long as every non-negotiable requirement above is respected.

{FIVE_RULES}"""


def run_sprint():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]

    def text_to_image_call(label, prompt, n=2):
        # No image reference at all now — the identicon slot stays empty, so
        # there's nothing left to condition on. Uses the plain text-to-image
        # endpoint (no /edit) rather than img2img.
        body = {"prompt": prompt, "num_images": n, "output_format": "png"}
        req = urllib.request.Request(
            "https://fal.run/fal-ai/gemini-25-flash-image",
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
        print(json.dumps(_redact(result), indent=2)[:500])
        save_result_images(label, result)

    text_to_image_call("sprintA-nowglass", SPRINT_A_PROMPT)
    text_to_image_call("sprintB-atmospheric", SPRINT_B_PROMPT)
    text_to_image_call("sprintC-photoreal", SPRINT_C_PROMPT)
    # Kontext dropped this round: it never once respected the top-down
    # constraint across two prior attempts even with explicit priority
    # wording, and its main advantage (image conditioning) no longer applies
    # now that there's no reference image left to condition on.
    text_to_image_call("sprintD-freeidea", SPRINT_KONTEXT_PROMPT)


ASSET_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

This is a production ASSET shot, not a scene — isolated on a FLAT, SOLID CHROMA-KEY GREEN background (like TV/film green screen), nothing else in frame: no ice, no forest, no ground, no shadow cast on any surface.

Lighting: soft, even, frontal — minimal directional shadow on the object itself, so the object stays legible once composited onto a brightly lit ice surface later. Avoid dramatic side-lighting.

Strict orthographic top-down view, camera directly above, zero perspective, zero tilt.

The four LED arc segments around the rim are in their OFF/unlit state — no glow, no light — but the division into four distinct segments must stay clearly visible as a structural/physical feature (grooves, seams, separate inlays). Do not remove or hide the four-part division just because it's unlit.

At the center, a HEXAGONAL (not circular) empty viewing window/slot, sized to about 55-60% of the stone's own outer diameter — noticeably smaller than in the reference image. Leave it empty/dark — do not draw any character or pattern inside it.

The glass/window's reflection must stay abstract and neutral — a soft highlight only. It must NOT reflect trees, forest, sky, or any scene content — treat it as if isolated in a studio with nothing around it to reflect.

The stone's rim is colored in the team's color: deep navy indigo, hex #1F2348.

Overall design should match the style/construction already established in the reference image (same family of design — premium handcrafted Nordic object).

Strict top-down orthographic gameplay.
Stylized realism, never photorealistic.
Nature always dominates technology.
Premium handcrafted Nordic atmosphere."""


ROUND2_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

This is a production ASSET shot, not a scene — isolated on a FLAT, SOLID CHROMA-KEY GREEN background, nothing else in frame: no ice, no forest, no ground.

Lighting: FLAT and SHADOWLESS — like a catalog product photo lit from all sides evenly, no single dominant light direction, no visible highlight glare concentrated in one spot, no cast shadow on the background. Specifically avoid a light source reading as coming from the upper-left — that direction has repeatedly shown up unintentionally in previous attempts and must be corrected. The lighting should look neutral/omnidirectional, not directional at all.

Strict orthographic top-down view, camera directly above, zero perspective, zero tilt.

The first reference image (navy stone with lit amber arcs) sets the overall material and color direction to match — same navy #1F2348 body.

The second reference image (dark stone with four carved notch openings) shows the shape of the four apertures to use: four distinct physical notch/opening cutouts around the rim, not printed dashed lines — real carved openings a light could shine through. Right now they are dark/unlit (no glow), but the four openings themselves must be clearly, physically visible as cutouts.

The third reference image shows ONLY the target shape for the center window — a HEXAGON, not a circle. Use only its shape, not its color. The hexagonal window should be noticeably LARGER this time than in prior attempts — closer to 70% of the stone's outer diameter. Leave it empty/dark inside, no character or pattern.

Strict top-down orthographic gameplay.
Stylized realism, never photorealistic.
Nature always dominates technology.
Premium handcrafted Nordic atmosphere."""


ROUND3_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

Isolated production asset shot, not a scene — flat solid chroma-key green background, nothing else in frame: no ice, no forest, no ground, no cast shadow.

Lighting: completely flat and even — NO reflection, NO specular highlight baked onto the glass at all, matte surface. The highlight will be added separately in post-production — do not draw any bright spot or glare on it.

Strict orthographic top-down view, camera directly above, zero perspective, zero tilt.

The rim is colored deep navy indigo, hex #1F2348, with four physically carved notch/opening cutouts around its edge (real carved-through apertures, not printed lines), currently unlit/dark (no glow).

At the center: the window/viewing element's own OUTER BOUNDARY is a HEXAGON — six straight flat edges meeting at points, like a honeycomb cell. This is NOT a circular dome with a hexagon pattern inside it — the glass piece itself must be hexagonal in silhouette, not round. Size: about 65-70% of the stone's overall outer diameter. Interior empty, dark, matte, no pattern or character inside.

Strict top-down orthographic gameplay.
Stylized realism, never photorealistic.
Nature always dominates technology.
Premium handcrafted Nordic atmosphere."""


EDIT_ROUND2_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

Keep this reference image's design exactly as-is — same navy #1F2348 body, same material, same four notch openings around the rim, same overall construction — change only two things:

1. The center window/viewing element's own OUTER BOUNDARY must be a true HEXAGON — six straight flat edges meeting at points. Not a circular/round dome with a hexagon pattern suggested inside it — the glass piece's actual silhouette must be hexagonal. Keep it empty inside, no character or pattern.

2. Remove all lighting/reflection from the piece entirely. Cross-polarized lighting, shadowless product photography, flat studio lighting, no specular key light, specular highlights removed — completely matte, no bright spot, no glare, no directional shadow anywhere on the object or the background.

Isolated on the same flat solid chroma-key green background, nothing else in frame.

Strict top-down orthographic gameplay.
Stylized realism, never photorealistic.
Nature always dominates technology.
Premium handcrafted Nordic atmosphere."""


def run_edit_round2_test(label, num_images=3):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref = image_to_data_uri(ROOT / "design" / "generated" / "arena-round2-0.png")
    body = {
        "prompt": EDIT_ROUND2_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
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
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images(label, result)


def run_round3_test(label, num_images=4):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    body = {
        "prompt": ROUND3_PROMPT,
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image",
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
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images(label, result)


def run_asset_test(label, style_ref_filename, num_images=2):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    style_ref = image_to_data_uri(ROOT / "design" / "generated" / style_ref_filename)
    body = {
        "prompt": ASSET_PROMPT,
        "image_urls": [style_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
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
    print(f"--- {label} (ref={style_ref_filename}) ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images(label, result)


STONE_FINAL_TEMPLATE = f"""{MASTER_PROMPT}

{MODULE_STONE}

Isolated production asset shot, not a scene — plain solid WHITE background (studio backdrop, seamless white cyclorama), nothing else in frame: no ice, no forest, no ground, no cast shadow.

Lighting: cross-polarized, shadowless product photography — completely flat and omnidirectional, no single dominant key light, no specular glare or hotspot baked onto the glass or the wood rim. Specifically avoid any light reading as coming from the upper-left — that direction has repeatedly appeared unintentionally in every previous attempt and must be corrected here. The highlight/reflection will be added separately in post-production compositing — leave the surface matte and evenly lit.

Strict orthographic top-down view, camera directly above, zero perspective, zero tilt — this matters more than any other stylistic choice in this prompt.

The rim is a single continuous ring divided into four large quarter-arc segments (each a full 90 degrees of the circumference), thin seams between them. These are LED segments but currently in their OFF/unlit state — no glow, no light emitted. Render the segments themselves in a neutral warm-white material/inlay (not colored to match the team) so their placement and the four-part division stays clearly, physically visible as a structural feature even while dark — do not hide or remove the division just because it's unlit.

The stone's body/dome is colored in the team's color, hex {{TEAM_HEX}}.

At the center: the window/viewing element's own OUTER BOUNDARY is a HEXAGON — six straight flat edges meeting at points, like a honeycomb cell, NOT a circular dome with a hexagon pattern suggested inside it. Size: about 65-70% of the stone's overall outer diameter. Leave the interior empty, dark, matte — no character, symbol or pattern inside it; this window will have the player's identicon composited into it afterward by the game itself.

{FIVE_RULES}"""

STONE_FINAL_TEAM_A = STONE_FINAL_TEMPLATE.format(TEAM_HEX="#1F2348")
STONE_FINAL_TEAM_B = STONE_FINAL_TEMPLATE.format(TEAM_HEX="#ffc94d")


def run_stone_final_test():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]

    def text_to_image_call(label, prompt, n=2):
        body = {"prompt": prompt, "num_images": n, "output_format": "png"}
        req = urllib.request.Request(
            "https://fal.run/fal-ai/gemini-25-flash-image",
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
        print(json.dumps(_redact(result), indent=2)[:500])
        save_result_images(label, result)

    text_to_image_call("stone-final-teamA-navy", STONE_FINAL_TEAM_A)
    text_to_image_call("stone-final-teamB-gold", STONE_FINAL_TEAM_B)


STONE_PAIR_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

Two curling stones shown side by side in the same frame, isolated production asset shot, not a scene — plain solid WHITE background, nothing else in frame: no ice, no forest, no ground, no cast shadow, no decorative debris around them.

The first reference image sets the target material fidelity and realism level: detailed wood grain texture, glossy handcrafted glass dome, tactile premium materials — match this level of material detail and realism, do not simplify or flatten the materials.

The second reference image sets the exact shape to reproduce for the center window: its own outer silhouette must be a true HEXAGON — six straight flat edges meeting at points — not a circular dome with a hexagon pattern suggested inside. Match this hexagon shape precisely, sized to about 65-70% of each stone's outer diameter, left empty/dark/matte inside — no character, symbol or pattern inside it.

Lighting: cross-polarized, shadowless product photography — completely flat and omnidirectional, no single dominant key light, no specular glare or hotspot, no directional shadow anywhere on either stone or the background. Do not carry over the directional highlight visible in the reference images — this lighting must be corrected/replaced, not copied. Specifically avoid any light reading as coming from the upper-left.

Strict orthographic top-down view, camera directly above, zero perspective, zero tilt, for both stones.

Each stone's rim is a single continuous ring divided into four large quarter-arc segments (each a full 90 degrees of the circumference, not thin dashed lines), thin seams between them. These are LED segments but currently in their OFF/unlit state — no glow, no light emitted. Render the segments in a neutral warm-white material/inlay (not colored to match the team) so the four-part division stays clearly, physically visible as a structural feature even while dark.

The left stone's body/dome is colored deep navy indigo, hex #1F2348. The right stone's body/dome is colored gold, hex #ffc94d. Both stones are otherwise identical in construction, scale, and framing.

{FIVE_RULES}"""


def run_stone_pair_test(num_images=4):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref1 = image_to_data_uri(ROOT / "design" / "generated" / "arena-asset-A1-1.png")
    ref2 = image_to_data_uri(ROOT / "design" / "generated" / "arena-editround2-2.png")
    body = {
        "prompt": STONE_PAIR_PROMPT,
        "image_urls": [ref1, ref2],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("stone-pair", result)


EDIT_PAIR_LED_OFF_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

Keep this reference image exactly as-is in every respect — same two stones side by side, same navy #1F2348 and gold #ffc94d colors, same wood grain material and realism level, same hexagonal window shape and gray bezel, same flat cross-polarized lighting, same white background, same framing and scale. Change ONLY the LED ring state:

The four LED segments around each stone's rim must be OFF/unlit — no glow, no amber light emitted at all. Render each of the four segments as a wide quarter-arc block (a full 90 degrees of the circumference each, not a thin dashed line or a narrow strip) in a neutral warm-white material/inlay, clearly visible as four large distinct physical segments even while unlit. Apply this identically to both the navy stone and the gold stone — both stones must match each other exactly in LED treatment.

{FIVE_RULES}"""


def run_pair_led_off_fix(source_filename, label, num_images=2):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref = image_to_data_uri(ROOT / "design" / "generated" / source_filename)
    body = {
        "prompt": EDIT_PAIR_LED_OFF_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
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
    print(f"--- {label} (ref={source_filename}) ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images(label, result)


EDIT_NAVY_QUARTERS_BLUE_PROMPT = """Keep this reference image exactly as-is in every single respect — same two stones, same gold (right) stone unchanged exactly as shown, same hexagonal windows, same material, same lighting, same white background, same framing, scale and composition.

Change ONLY one thing: on the LEFT (navy) stone, the four quarter-arc rim segments currently rendered in white must instead be colored the same deep navy indigo as the rest of that stone's body, hex #1F2348 — same color, not a contrasting white. Keep the thin seams between the four segments visible as dividing lines so the four-part structure still reads clearly, but the fill color of the segments themselves must match the stone's navy body instead of white.

Do not change anything else — the gold stone, the hexagonal windows, the lighting, the background must remain identical to the reference."""


def run_navy_quarters_blue_fix(num_images=1):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref = image_to_data_uri(ROOT / "design" / "generated" / "arena-pairfix-1-0.png")
    body = {
        "prompt": EDIT_NAVY_QUARTERS_BLUE_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("navyquarters", result)


EDIT_NOTCH_OPENINGS_PROMPT = f"""{MASTER_PROMPT}

{MODULE_STONE}

The first reference image is the base to preserve — keep both stones exactly as shown: same navy #1F2348 and gold #ffc94d colors, same wood-grain material realism, same hexagonal window and gray bezel, same flat cross-polarized shadowless lighting, same plain white background, same side-by-side framing and scale, same strict orthographic top-down view. Do not turn this into a scene — no ice, no arena, no forest, no ground: this stays an isolated asset shot of the two stones alone.

The second reference image shows the target style for the rim's four openings: real, physically carved hollow notch/groove cutouts recessed into the rim material — not flat colored blocks, not a printed/painted pattern. Apply that same carved-notch construction to the four LED positions on BOTH stones (currently the flat quarter-arc segments) — replace them with the same kind of physically recessed, shadowed groove opening shown in the second reference, unlit/dark inside (no glow), sized and spaced the same as the current quarter segments.

Keep everything else — hexagon window shape and size, body colors, lighting, background, framing — identical to the first reference image.

{FIVE_RULES}"""


def run_notch_openings_fix(num_images=3):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    base_ref = image_to_data_uri(ROOT / "design" / "generated" / "arena-pairfix-1-0.png")
    style_ref = image_to_data_uri(ROOT / "design" / "generated" / "arena-round3-0.png")
    body = {
        "prompt": EDIT_NOTCH_OPENINGS_PROMPT,
        "image_urls": [base_ref, style_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("notch", result)


ARENA_FIX_COMMON = """Keep this reference image's overall composition, camera angle, forest setting and arena proportions/geometry (rectangular ice with clipped corners) — but make these specific corrections:

1. Remove the thin stone ledge/border currently sitting between the wooden frame and the ice — the wooden beam should sit in direct contact with the ice, no stone trim in between.

2. Add a clear goal opening at the center of each SHORT end wall (left and right) — a real integrated gap/pit built into the wood structure, not a small vague mark. Critically: no goal posts, net, or any structure protruding onto the ice surface — the goal is purely an opening/recessed pit in the wall itself, nothing extends into the playing area.

3. Remove any lights, lanterns, or glowing elements embedded in the wooden beams — the frame should be plain, unlit wood."""

ARENA_FIX_SNOW_PROMPT = f"""{MASTER_PROMPT}

{MODULE_ARENA}

{ARENA_FIX_COMMON}

{FIVE_RULES}"""

ARENA_FIX_MOSS_PROMPT = f"""{MASTER_PROMPT}

{MODULE_ARENA}

{ARENA_FIX_COMMON}

4. Completely clear, even atmosphere — no mist, haze, light shafts, or god-rays filtering through the trees. Even, soft ambient daylight only, nothing softening or obscuring the scene.

{FIVE_RULES}"""


ARENA_V2_DIR = OUT_DIR / "arena V2"


def run_arena_fix_test(num_images=2):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]

    def edit_call(label, prompt, ref_path, n):
        ref = image_to_data_uri_any(ref_path)
        body = {"prompt": prompt, "image_urls": [ref], "num_images": n, "output_format": "png"}
        req = urllib.request.Request(
            "https://fal.run/fal-ai/gemini-25-flash-image/edit",
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
        print(f"--- {label} (ref={ref_path}) ---")
        print(json.dumps(_redact(result), indent=2)[:500])
        save_result_images(label, result)

    edit_call("arenafix-snow", ARENA_FIX_SNOW_PROMPT, ARENA_V2_DIR / "arena-nano-banana-0.png", num_images)
    edit_call("arenafix-moss", ARENA_FIX_MOSS_PROMPT, ARENA_V2_DIR / "arena-season-0.png", num_images)


HUD_ROCKS_COMMON = f"""{MASTER_PROMPT}

Keep this reference image's arena, forest, snow, ice, wooden frame, corner geometry and camera framing EXACTLY as they are — do not change the arena's shape, proportions, position, or the surrounding forest composition. Only modify the five specific rocks described below, each already present in the reference image at their existing positions. Resize a rock slightly if needed so its traced symbol reads clearly, but keep every rock's natural weathered grey stone material, matching the other boulders in the scene.

Turn these five existing rocks into functional icon-markers:

1. One of the three rocks in the snow band above the arena (between the arena and the tree line): a snowflake symbol traced/etched into a thin layer of snow sitting on top of the rock, like it was drawn there by hand.
2. The second of those three rocks: a play symbol — a simple triangle pointing right, like a "play" button — traced the same way in the snow on top of it.
3. The third of those three rocks: a lightning bolt symbol, traced the same way.
4. The large rock at the top-left of the scene: a simple exit symbol (an open door outline with an arrow pointing through it) traced the same way.
5. The rock sitting behind/near the left goal: a sound icon (a simple speaker shape with two small curved sound-wave lines) traced the same way.

Each traced symbol is a shallow groove revealing the darker rock beneath the snow — hand-etched, not painted or printed on top."""

HUD_ROCKS_NOGLOW_PROMPT = f"""{HUD_ROCKS_COMMON}

The traced symbols are unlit, matching the same soft ambient snow tone as the rest of the scene — no additional light or glow on them.

{FIVE_RULES}"""

HUD_ROCKS_GLOW_PROMPT = f"""{HUD_ROCKS_COMMON}

Each traced symbol glows very softly from within its groove, as if lit from beneath the snow — the same soft under-snow glow already used for the ice's own magical light elsewhere in this world, not an artificial UI light. Warm, gentle, barely-there — legible as an interactive marker without looking like a digital overlay.

{FIVE_RULES}"""


def run_hud_rocks_test(num_images=2):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref_path = ARENA_V2_DIR / "Arena V2 winter.png"

    def edit_call(label, prompt, n):
        ref = image_to_data_uri_any(ref_path)
        body = {"prompt": prompt, "image_urls": [ref], "num_images": n, "output_format": "png"}
        req = urllib.request.Request(
            "https://fal.run/fal-ai/gemini-25-flash-image/edit",
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
        print(f"--- {label} (ref={ref_path}) ---")
        print(json.dumps(_redact(result), indent=2)[:500])
        save_result_images(label, result)

    edit_call("hudrocks-noglow", HUD_ROCKS_NOGLOW_PROMPT, num_images)
    edit_call("hudrocks-glow", HUD_ROCKS_GLOW_PROMPT, num_images)


HUD_CLEANUP_PROMPT = f"""{MASTER_PROMPT}

This reference image was assembled by hand from several separate generations (a manual compositing/montage pass), so it currently has visible seams, mismatched lighting/exposure between pasted pieces, faint edge halos, and small blending artifacts where the pieces were combined.

Your job: produce ONE single, fully coherent re-render of this exact same image — same arena, same forest, same snow, same ice, same wooden frame, same camera framing and proportions — with all compositing seams and blending artifacts fully removed, lighting and exposure unified across the whole frame as if it had been rendered in one pass.

Keep every element exactly where it already is in the reference, unchanged in content:
- The five rocks stay in their current positions, same weathered grey stone material as the other boulders in the scene.
- Each rock's traced/etched symbol stays exactly as shown: snowflake, play triangle, lightning bolt, exit door-arrow, speaker icon — same symbol on the same rock, same hand-etched groove style, same glow/no-glow treatment already visible on each.
- Do not add, remove, move, resize, or redesign any rock, symbol, tree, or arena element. This is a cleanup re-render, not a redesign.

{FIVE_RULES}"""


def run_hud_cleanup_test(num_images=2):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref_path = ARENA_V2_DIR / "Arena V2 HUD test.png"
    ref = image_to_data_uri_any(ref_path)
    body = {
        "prompt": HUD_CLEANUP_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(f"--- hudcleanup (ref={ref_path}) ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("hudcleanup", result)


HUD_CLEANUP_V2_PROMPT = f"""{MASTER_PROMPT}

This reference image was assembled by hand from several separate generations (a manual compositing/montage pass). The previous automated cleanup attempt failed on three specific points — fix all three this time:

1. Compositing seams and blending artifacts are STILL visible in the reference (hard edges around pasted pieces, mismatched color/exposure patches, doubled or ghosted silhouettes, inconsistent snow texture at boundaries). This time actually re-render the ENTIRE frame as one single coherent pass from scratch, matching the reference's content but with zero seams, zero mismatched lighting, zero blending edges anywhere.

2. The five rocks must NOT glow or emit any light, and must NOT have any added rim light, halo, or highlighted illumination around their stone body. Each rock's stone material stays matte and lit only by the same soft ambient moonlight as the rest of the snowy ground — no brighter, no glowing outline. Only the hand-etched symbol groove on top of each rock may keep its own existing glow/no-glow treatment exactly as already shown; the rock itself, the stone, must not be lit up.

3. None of the five rocks may be truncated, cropped, or cut off by the frame edge or by another object. Each rock must be rendered as a complete, whole stone shape, fully visible, in its current position.

Keep everything else exactly as in the reference and unchanged in content:
- Same arena, forest, snow, ice, wooden frame, camera framing and proportions.
- The five rocks stay in their current positions, same weathered grey stone material as the other boulders in the scene.
- Each rock's traced/etched symbol stays exactly as shown: snowflake, play triangle, lightning bolt, exit door-arrow, speaker icon — same symbol on the same rock, same hand-etched groove style.
- Do not add, remove, move, resize, or redesign any rock, symbol, tree, or arena element. This is a cleanup re-render, not a redesign.

{FIVE_RULES}"""


def run_hud_cleanup_v2_test(num_images=1):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref_path = ARENA_V2_DIR / "Arena V2 HUD test.png"
    ref = image_to_data_uri_any(ref_path)
    body = {
        "prompt": HUD_CLEANUP_V2_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(f"--- hudcleanupv2 (ref={ref_path}) ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("hudcleanupv2", result)


HUD_TRANSPLANT_PROMPT = f"""{MASTER_PROMPT}

The first reference image is the clean base to preserve exactly as-is: same arena, forest, snow, ice, wooden frame, camera framing and proportions, and the five rocks already sitting at their existing positions in this image. Do not move, resize, recreate, or relight any rock, and do not alter anything else in this base image.

The second reference image is a content/layout guide ONLY, not a base to copy or preserve — it shows roughly which hand-etched symbol belongs on which rock, but it also has visible compositing seams and inconsistent lighting artifacts from being manually assembled; ignore those flaws entirely and do not reproduce them.

Your job: onto the first reference's rocks, in their existing positions, add a hand-etched symbol groove — a shallow groove traced into the snow on top of each rock, revealing the darker rock beneath — matching these exact rock/symbol pairings:

1. One of the three rocks in the snow band above the arena (between the arena and the tree line): a snowflake symbol.
2. The second of those three rocks: a play symbol — a simple triangle pointing right.
3. The third of those three rocks: a lightning bolt symbol.
4. The large rock at the top-left of the scene: an exit symbol (an open door outline with an arrow pointing through it).
5. The rock sitting behind/near the left goal: a sound icon (a simple speaker shape with two small curved sound-wave lines).

Lighting: NO glow, NO illumination, NO light emission anywhere — not on the rocks, not on the etched symbols. Every symbol groove is unlit, matching the same soft ambient snow tone as the rest of the scene, exactly like plain shadowed snow texture. Do not add any light source, halo, or glow effect to any rock or symbol.

{FIVE_RULES}"""

HUD_TRANSPLANT_V2_PROMPT = f"""{HUD_TRANSPLANT_PROMPT}

Size constraint: none of the five symbol rocks should be larger than the three rocks in the snow band between the arena and the tree line (rocks 1-3 above) — treat those three as the maximum reference scale. In particular, the large rock at the top-left (rock 4, exit symbol) and the rock near the left goal (rock 5, sound symbol) must NOT be enlarged beyond that same scale, even though they may currently read as bigger — keep every one of the five rocks modest and consistent in size with rocks 1-3."""


def run_hud_transplant_v2_test(num_images=2):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    base_ref = image_to_data_uri_any(ARENA_V2_DIR / "Arena V2 winter.png")
    content_ref = image_to_data_uri_any(ARENA_V2_DIR / "Arena V2 HUD test.png")
    body = {
        "prompt": HUD_TRANSPLANT_V2_PROMPT,
        "image_urls": [base_ref, content_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(f"--- hudtransplantv2 ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("hudtransplantv2", result)


HUD_TRANSPLANT_V3_PROMPT = f"""{HUD_TRANSPLANT_PROMPT}

Placement accuracy is critical — double-check each symbol is etched onto the CORRECT one of the five rocks, do not swap any two symbols between rocks:
- Snowflake: first of the three rocks in the snow band above the arena.
- Play triangle: second of those three rocks.
- Lightning bolt: third of those three rocks.
- Exit door-arrow: the large rock at the top-left of the scene.
- Sound/speaker icon: the rock near the left goal.
Re-verify this mapping before finishing — no two symbols may end up on the wrong rock, and no rock may end up with more than one symbol or none at all.

Size constraint: none of the five symbol rocks should be larger than the three rocks in the snow band between the arena and the tree line — treat those three as the maximum reference scale. The top-left exit rock and the left-goal sound rock must NOT be enlarged beyond that same scale, even though they may currently read as bigger.

Additionally, reposition the large rock at the top-left (exit symbol) slightly closer to the arena — reduce the empty gap between that rock and the arena's wooden frame, pulling it inward toward the play area, while keeping it recognizably the same top-left rock relative to the tree line behind it."""


def run_hud_transplant_v3_test(num_images=1):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    base_ref = image_to_data_uri_any(ARENA_V2_DIR / "Arena V2 winter.png")
    content_ref = image_to_data_uri_any(ARENA_V2_DIR / "Arena V2 HUD test.png")
    body = {
        "prompt": HUD_TRANSPLANT_V3_PROMPT,
        "image_urls": [base_ref, content_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(f"--- hudtransplantv3 ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("hudtransplantv3", result)


def run_hud_transplant_test(num_images=2):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    base_ref = image_to_data_uri_any(ARENA_V2_DIR / "Arena V2 winter.png")
    content_ref = image_to_data_uri_any(ARENA_V2_DIR / "Arena V2 HUD test.png")
    body = {
        "prompt": HUD_TRANSPLANT_PROMPT,
        "image_urls": [base_ref, content_ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(f"--- hudtransplant ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("hudtransplant", result)


HUD_SHRINK_ROCKS_PROMPT = """Keep this reference image exactly as-is in every single respect — same arena, forest, snow, ice, wooden frame, camera framing and proportions, same five rocks in their current positions, same hand-etched symbols (snowflake, play triangle, lightning bolt, exit door-arrow, speaker icon) on the same rocks, same unlit/no-glow treatment on every rock and symbol, same overall lighting and composition.

Change ONLY one thing: reduce the size of the five rocks that carry the hand-etched symbols — make each of them slightly smaller than currently shown, while keeping each one centered on its current position and keeping its etched symbol fully legible and proportionally scaled down with it. Do not change any other rock, any other element, or anything else in the scene."""


def run_hud_shrink_rocks_test(num_images=1):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fal_key = os.environ["FAL_KEY"]
    ref = image_to_data_uri(OUT_DIR / "arena-hudtransplant-1.png")
    body = {
        "prompt": HUD_SHRINK_ROCKS_PROMPT,
        "image_urls": [ref],
        "num_images": num_images,
        "output_format": "png",
    }
    req = urllib.request.Request(
        "https://fal.run/fal-ai/gemini-25-flash-image/edit",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Key {fal_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        return
    print(f"--- hudshrinkrocks ---")
    print(json.dumps(_redact(result), indent=2)[:500])
    save_result_images("hudshrinkrocks", result)


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "asset":
        run_asset_test("asset-A1", "arena-sprintA-nowglass-1.png")
        run_asset_test("asset-D1", "arena-sprintD-freeidea-1.png")
    elif len(sys.argv) > 1 and sys.argv[1] == "round2":
        run_round2_test("round2", num_images=2)
    elif len(sys.argv) > 1 and sys.argv[1] == "round3":
        run_round3_test("round3", num_images=4)
    elif len(sys.argv) > 1 and sys.argv[1] == "editround2":
        run_edit_round2_test("editround2", num_images=3)
    elif len(sys.argv) > 1 and sys.argv[1] == "sprint":
        run_sprint()
    elif len(sys.argv) > 1 and sys.argv[1] == "dome":
        run_dome_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "photoreal":
        run_photoreal_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "merge":
        run_merge_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "contrast":
        run_contrast_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "ideation":
        run_ideation_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "season":
        run_season_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "ensemble":
        run_ensemble_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "stonefinal":
        run_stone_final_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "stonepair":
        run_stone_pair_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "pairledoff":
        run_pair_led_off_fix("arena-stone-pair-1.png", "pairfix-1")
        run_pair_led_off_fix("arena-stone-pair-2.png", "pairfix-2")
    elif len(sys.argv) > 1 and sys.argv[1] == "navyquarters":
        run_navy_quarters_blue_fix()
    elif len(sys.argv) > 1 and sys.argv[1] == "notch":
        run_notch_openings_fix()
    elif len(sys.argv) > 1 and sys.argv[1] == "arenafix":
        run_arena_fix_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "hudrocks":
        run_hud_rocks_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "hudcleanup":
        run_hud_cleanup_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "hudcleanupv2":
        run_hud_cleanup_v2_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "hudtransplant":
        run_hud_transplant_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "hudshrinkrocks":
        run_hud_shrink_rocks_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "hudtransplantv2":
        run_hud_transplant_v2_test()
    elif len(sys.argv) > 1 and sys.argv[1] == "hudtransplantv3":
        run_hud_transplant_v3_test()
    else:
        main()
