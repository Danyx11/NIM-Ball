import { defineConfig } from 'vite';

// host: true exposes the dev server on the LAN so Nimiq Pay on a phone
// can load it (see README for the "load a local mini app" workflow).
export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
});
