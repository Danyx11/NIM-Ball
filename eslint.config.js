// Deliberately a SMALL rule set, not a style guide.
//
// This project has a consistent hand-maintained style already and does not need
// a linter to argue about formatting. What it needs is a machine that notices
// the silent wiring mistakes a human reviewer stops seeing — dead code left
// behind by removed features, undeclared identifiers, functions whose exits
// disagree with each other.
//
// What this does NOT catch, stated plainly so nobody trusts it further than it
// goes: party/weekArbiter.js's leagueNotify was missing its `return`, so every
// `await this.leagueNotify(...)` resolved to undefined and no WEEK match ever
// reported the LP it had awarded. `consistent-return` does not see that — with
// the bug, BOTH exits returned nothing, which is perfectly consistent. The
// defect was "this function should return a promise", a statement about the
// expected TYPE, and ESLint without type information cannot make it. Catching
// that class needs either typed JSDoc/TypeScript or an integration test that
// plays a match through and asserts the LP comes back (which is how it was
// actually found). `consistent-return` stays because it did surface two real
// disagreements in this codebase — just not that one.
//
// Anything that would flag working, deliberate code is left off on purpose: a
// gate nobody can keep green gets disabled, and then it protects nothing.
export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    linterOptions: {
      // An unused eslint-disable is itself a small lie about the code.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Catches a function whose exits disagree — some returning a value, some
      // not. See the header for what it does NOT catch.
      'consistent-return': 'error',
      // `== null` is used deliberately and correctly in ~19 places to mean
      // "null or undefined"; everything else must be strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': ['error', {
        args: 'none',               // handler signatures document their arguments
        varsIgnorePattern: '^_',
        caughtErrors: 'none',       // `catch { }` with an unused binding is fine
      }],
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-args': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-constant-binary-expression': 'error',
      // An await that silently does nothing usually means a function forgot to
      // return its promise — the same family as the leagueNotify bug.
      'require-await': 'off',
      'no-async-promise-executor': 'error',
      // Deliberately OFF: `new Promise(r => setTimeout(r, ms))` is used
      // throughout and is correct — the rule only objects to the arrow
      // implicitly returning the timer id. Flagging it would train everyone to
      // ignore the linter, which costs more than the rule is worth.
      'no-promise-executor-return': 'off',
    },
  },
  // ---- Browser bundle ----
  {
    files: ['src/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', history: 'readonly',
        fetch: 'readonly', Image: 'readonly', Audio: 'readonly', Blob: 'readonly', File: 'readonly',
        FileReader: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', WebSocket: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        console: 'readonly', AudioContext: 'readonly', webkitAudioContext: 'readonly',
        HTMLImageElement: 'readonly', HTMLCanvasElement: 'readonly', Element: 'readonly',
        ImageData: 'readonly', createImageBitmap: 'readonly', OffscreenCanvas: 'readonly',
        caches: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', crypto: 'readonly', atob: 'readonly', btoa: 'readonly',
        structuredClone: 'readonly', DOMParser: 'readonly', XMLSerializer: 'readonly', Event: 'readonly',
        Path2D: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
        requestIdleCallback: 'readonly', IntersectionObserver: 'readonly', CustomEvent: 'readonly',
      },
    },
  },
  // ---- Cloudflare Worker (party/) ----
  {
    files: ['party/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly', Response: 'readonly', Request: 'readonly', Headers: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', WebSocket: 'readonly', WebSocketPair: 'readonly',
        crypto: 'readonly', caches: 'readonly', console: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', atob: 'readonly', btoa: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        AbortSignal: 'readonly', AbortController: 'readonly', structuredClone: 'readonly',
        addEventListener: 'readonly', Blob: 'readonly', ReadableStream: 'readonly',
      },
    },
  },
  // ---- Service worker (public/sw.js) — ships to players, so it is linted
  // like any other source file, just with its own globals. ----
  {
    files: ['public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly', caches: 'readonly', fetch: 'readonly', console: 'readonly',
        URL: 'readonly', Response: 'readonly', Request: 'readonly', clients: 'readonly',
        addEventListener: 'readonly', skipWaiting: 'readonly',
      },
    },
  },
  // ---- Node (dev servers, build/check scripts, tests) ----
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'vite.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', WebSocket: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', crypto: 'readonly',
        AbortSignal: 'readonly', AbortController: 'readonly', performance: 'readonly',
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.claude/**', 'design-lab/**', 'physics-lab/**', 'curling-lab/**', 'audio-lab/**', 'prototypes/**', 'scripts/archive/**'],
  },
];
