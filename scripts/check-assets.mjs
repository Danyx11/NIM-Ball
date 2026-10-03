#!/usr/bin/env node
// Verifies that every asset the code points at actually exists in public/.
//
// This exists because three SFX entries (shot.wav, wipeout.wav, win.wav) sat in
// src/audio.js for months pointing at files that had never existed. Nothing
// broke loudly: audio.js's play() returns silently on a missing buffer, so the
// only symptom was three console warnings nobody was reading, and a wipeout that
// quietly had no sound. A missing asset in this codebase is almost never a crash
// — it is silence, or a sprite that never appears — which is exactly the class of
// bug a human stops noticing and a script never does.
//
// Deliberately dependency-free (plain node, no parser): this has to keep working
// without anyone maintaining it.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
const checked = { static: 0, dynamic: 0 };

// `${ASSET_BASE}…` / `${BASE}…` inside a template literal, up to the closing
// backtick. A reference containing a nested ${…} is dynamic (built per team, per
// LED state, …) — the exact filename can't be known without running the code, so
// those are verified at directory level instead of being skipped entirely.
const JS_REF = /\$\{(?:ASSET_BASE|BASE)\}([^`]*)`/g;

for (const file of walk(join(ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length + 1);
  for (const m of src.matchAll(JS_REF)) {
    const ref = m[1];
    if (!ref || ref.startsWith('http')) continue;
    if (ref.includes('${')) {
      // Dynamic: check the directory it lives in exists and isn't empty, which
      // still catches a whole folder being renamed or dropped.
      const dir = ref.split('/').slice(0, -1).join('/');
      if (!dir) continue;
      checked.dynamic++;
      const abs = join(PUBLIC, dir);
      if (!existsSync(abs) || readdirSync(abs).length === 0) {
        problems.push(`${rel}: dynamic reference into public/${dir}/ — directory missing or empty`);
      }
      continue;
    }
    checked.static++;
    if (!existsSync(join(PUBLIC, ref))) problems.push(`${rel}: public/${ref} does not exist`);
  }
}

// index.html uses Vite's own %BASE_URL% placeholder rather than a JS template.
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/%BASE_URL%([A-Za-z0-9 ._/+-]+\.[A-Za-z0-9]{2,5})/g)) {
  checked.static++;
  if (!existsSync(join(PUBLIC, m[1]))) problems.push(`index.html: public/${m[1]} does not exist`);
}

// style.css url(...) — relative ones resolve against public/ the same way.
const css = readFileSync(join(ROOT, 'src', 'style.css'), 'utf8');
for (const m of css.matchAll(/url\(\s*['"]?([^)'"]+?)['"]?\s*\)/g)) {
  const ref = m[1];
  if (ref.startsWith('data:') || ref.startsWith('http') || ref.includes('${')) continue;
  checked.static++;
  const clean = ref.replace(/^\//, '');
  if (!existsSync(join(PUBLIC, clean)) && !existsSync(join(ROOT, clean))) {
    problems.push(`src/style.css: ${ref} does not exist`);
  }
}

// The PWA manifest's icons are referenced relative to the manifest itself.
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8'));
for (const icon of manifest.icons || []) {
  checked.static++;
  if (!existsSync(join(PUBLIC, icon.src))) problems.push(`manifest.json: public/${icon.src} does not exist`);
}

console.log(`checked ${checked.static} static asset references and ${checked.dynamic} dynamic ones`);
if (problems.length) {
  console.error(`\n${problems.length} missing asset${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('all referenced assets exist');
