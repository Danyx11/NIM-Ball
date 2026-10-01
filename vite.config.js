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
// index.html is heavily commented on purpose — roughly 45% of the file is
// developer commentary explaining the markup. Vite does not strip HTML
// comments, so every one of those bytes was being served to every player on
// every load (~48 KB of the 110 KB file). This removes them from the BUILT
// html only; the source file is never touched and `npm run dev` still serves
// the comments, so viewing source while developing is unchanged.
//
// enforce: 'post' so this runs AFTER Vite's own index.html handling — the
// html this sees already has %BASE_URL% substituted and asset URLs rewritten,
// so stripping comments can't interfere with either.
//
// The regex alternation matches a whole <script>/<style> block BEFORE it can
// match a comment, so anything that looks like an HTML comment inside inline
// JS or CSS is consumed as part of that block and returned untouched.
// Conditional comments (<!--[if ...]> / <![endif]-->) are preserved — there
// are none in this file today, but silently eating one later would be a
// genuinely confusing bug to track down.
function stripHtmlComments() {
  const KEEP = /^<!--\s*(\[if|<!\[endif)/i;
  return {
    name: 'nim-ball:strip-html-comments',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<(script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (match, tag) =>
          (tag ? match : (KEEP.test(match) ? match : '')))
        // Comments sat on their own indented lines; without this the file
        // keeps thousands of now-blank ones. Safe here: index.html has no
        // <pre>/<textarea>, and the script/style blocks above were already
        // returned verbatim by the pass that just ran.
        .replace(/^[ \t]*\n/gm, '');
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  base: (command === 'build' || isPreview) && !process.env.VERCEL ? '/NIM-Ball/' : '/',
  plugins: [stripHtmlComments()],
  server: {
    port: Number(process.env.PORT) || 5173,
    host: true,
  },
}));
