/** Linux-only screenshot control. These test-owned faces never enter a renderer build. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { Plugin, ViteDevServer } from "vite";

interface ControlFace {
  file: string;
  family: string;
  weight: string;
  sha256: string;
  fontFamily: string;
}
const directory = new URL("./control-fonts/", import.meta.url);
const faces = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")) as ControlFace[];
const prefix = "/__orca-type-control/";

/** configureServer runs before Vite's HTML fallback/404 handlers. */
export function controlFontPlugin(): Plugin {
  return { name: "orca-type-proof-control", configureServer: mountControlFonts };
}

/** Serve only manifest entries through the test's existing loopback origin (CSP: self). */
export function mountControlFonts(server: ViteDevServer): void {
  const assets = new Map(
    faces.map((face) => {
      const bytes = readFileSync(new URL(face.file, directory));
      if (createHash("sha256").update(bytes).digest("hex") !== face.sha256)
        throw new Error(`The type-proof control font changed: ${face.file}`);
      return [prefix + face.file, bytes];
    }),
  );
  server.middlewares.use((request, response, next) => {
    const bytes = assets.get(request.url ?? "");
    if (!bytes) return next();
    response.setHeader("Content-Type", "font/woff2");
    response.end(bytes);
  });
}

export function controlStyle(): string {
  const rules = faces.map((face) => {
    return `@font-face { font-family: "${face.family}"; font-weight: ${face.weight}; font-style: normal;
      font-display: block; src: url("${prefix}${face.file}") format("woff2"); }`;
  });
  return `${rules.join("\n")}
    .type-proof[data-faces="fallback"][data-control-fonts] {
      --font-sans: "Orca Proof Supplement", "Orca Proof Sans" !important;
      --font-mono: "Orca Proof Supplement", "Orca Proof Mono", "Orca Proof Sans" !important;
    }`;
}

/** Record what Chromium actually drew, rather than guessing from a CSS stack or fc-match. */
export async function renderedFonts(page: Page): Promise<
  {
    element: string;
    fonts: { familyName: string; isCustomFont: boolean; glyphCount: number }[];
  }[]
> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector:
        '.type-proof__theme[data-theme="light"] .type-proof__glyph-large, ' +
        '.type-proof__theme[data-theme="light"] .type-proof__glyph-small > span',
    });
    const report = [];
    for (const nodeId of nodeIds) {
      const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      report.push({ element: outerHTML, fonts });
    }
    return report;
  } finally {
    await cdp.detach();
  }
}

export const controlFontFamilies = [...new Set(faces.map((face) => face.fontFamily))];
