import { defineConfig } from 'vite';

// host: true exposes the dev server on the LAN so Nimiq Pay on a phone
// can load it (see README for the "load a local mini app" workflow).
//
// base is set for `vite build` and `vite preview` (isPreview): GitHub Pages
// serves this project from https://danyx11.github.io/NIM-Ball/ (a subpath),
// so built asset URLs need that prefix. Plain dev stays at '/' so LAN
// testing on a phone is unaffected.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/NIM-Ball/' : '/',
  server: {
    port: Number(process.env.PORT) || 5173,
    host: true,
  },
}));
