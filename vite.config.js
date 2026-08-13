import { defineConfig } from 'vite';

// host: true exposes the dev server on the LAN so Nimiq Pay on a phone
// can load it (see README for the "load a local mini app" workflow).
//
// base is set for `vite build` and `vite preview` (isPreview): GitHub Pages
// serves this project from https://danyx11.github.io/NIM-Ball/ (a subpath),
// so built asset URLs need that prefix there. Vercel (process.env.VERCEL,
// auto-set in every Vercel build — see
// https://vercel.com/docs/environment-variables/system-environment-variables)
// serves from the domain root instead, so it needs plain '/' — hardcoding
// '/NIM-Ball/' unconditionally 404'd every asset there. Plain dev stays at
// '/' so LAN testing on a phone is unaffected.
export default defineConfig(({ command, isPreview }) => ({
  base: (command === 'build' || isPreview) && !process.env.VERCEL ? '/NIM-Ball/' : '/',
  server: {
    port: Number(process.env.PORT) || 5173,
    host: true,
  },
}));
