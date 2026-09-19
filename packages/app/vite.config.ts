/**
 * The renderer's build. Vite owns `renderer/` only: main and preload stay on `tsc -b`
 * with the rest of the workspace (see docs/DEVELOPMENT.md, "The renderer build").
 *
 * Two things here are not the Vite defaults and both are deliberate:
 * - `base: "./"` so the built `index.html` references its assets relatively, because the
 *   main process loads it with `loadFile()` off disk rather than from a server.
 * - the CSP meta tag is rewritten per mode. Production keeps `default-src 'self'` with no
 *   `unsafe-inline`; the dev server needs inline (React Refresh's preamble, Vite's injected
 *   style tags) and a websocket back to itself for HMR. See `cspPlugin` below.
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const pkg = (name: string) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

/** What `renderer/index.html` ships with, and what a packaged app must keep. */
const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";

/**
 * The dev server's relaxation of it. `unsafe-inline` here buys HMR and React Refresh and
 * never reaches a build; `connect-src` covers the HMR websocket and Vite's module requests.
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
].join("; ");

/**
 * Two fixups on `index.html`, both about where the renderer is loaded from.
 *
 * Dev: swap in the relaxed CSP. The production policy stays in the HTML as written, so
 * reading the file tells you what a packaged app enforces without knowing this exists.
 *
 * Build: drop the `crossorigin` attribute Vite puts on the emitted script and stylesheet.
 * It is correct over HTTP and fatal over `file://`, which is how the main process loads a
 * packaged renderer — the CORS check on a `file:` origin fails and the app comes up blank.
 */
function htmlPlugin(): Plugin {
  return {
    name: "orca-renderer-html",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.server) return html.replace(PRODUCTION_CSP, DEV_CSP);
        return html.replace(/\s+crossorigin(?==|\s|>)/g, "");
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL("./renderer", import.meta.url)),
  base: "./",
  plugins: [react(), htmlPlugin()],
  resolve: {
    // The same trick vitest.config.ts uses: resolve the two packages the app is allowed
    // to see (ADR 0008) to their sources, so `dev` needs no prior `tsc -b` of them.
    // `@orca/core` is here only because `@orca/protocol` type-imports it.
    //
    // Anchored patterns, not bare prefixes: a prefix alias would also rewrite
    // `@orca/design/css/tokens.css` into `…/src/index.ts/css/tokens.css`. The subpaths
    // are meant to go through the package's own `exports` map instead.
    alias: [
      { find: /^@orca\/protocol$/, replacement: pkg("protocol") },
      { find: /^@orca\/design$/, replacement: pkg("design") },
      { find: /^@orca\/core$/, replacement: pkg("core") },
    ],
  },
  server: { port: 5273, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    // outDir is outside the Vite root, so this is opt-in. Only ever removes dist/renderer;
    // dist/main and dist/preload are tsc's and are written by a different command.
    emptyOutDir: true,
    sourcemap: true,
    // No `data:` URIs. Vite inlines assets under 4 kB by default, which silently caught the
    // two Noto symbol subsets (2.7 kB and 3.7 kB) — the faces the status glyphs come from —
    // and `default-src 'self'` then blocks them, so every glyph renders as tofu. Emitting
    // every asset as a file keeps the CSP tight, and there is nothing to save by inlining:
    // the renderer loads from disk, not over a network.
    assetsInlineLimit: 0,
  },
});
