/** Verify the committed control's bytes and real cmap, independently of browser/host fonts. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { controlStyle, mountControlFonts } from "../../packages/app/test/smoke/type-proof-control.js";
const require = createRequire(new URL("../font-build/package.json", import.meta.url));
const { create } = require("fontkit");
const root = new URL("../../packages/app/test/smoke/control-fonts/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root)));
const loaded = manifest.map((face) => ({ ...face, bytes: readFileSync(new URL(face.file, root)) }));

it("serves allowlisted fixture bytes from the existing origin without a CSP exception", () => {
  let middleware;
  mountControlFonts({
    middlewares: {
      use(handler) {
        middleware = handler;
      },
    },
  });
  const styles = controlStyle();
  for (const face of loaded) {
    const url = `/__orca-type-control/${face.file}`;
    expect(styles).toContain(`url("${url}")`);
    let contentType, body;
    middleware(
      { url },
      {
        setHeader(name, value) {
          expect(name).toBe("Content-Type");
          contentType = value;
        },
        end(bytes) {
          body = bytes;
        },
      },
      () => {
        throw new Error("known fixture was not served");
      },
    );
    expect(contentType).toBe("font/woff2");
    expect(body).toEqual(face.bytes);
  }
  expect(styles).not.toMatch(/data:|https?:/);
  for (const url of ["/__orca-type-control/../tokens.json", "/__orca-type-control/missing.woff2"]) {
    let next = false;
    middleware({ url }, {}, () => {
      next = true;
    });
    expect(next).toBe(true);
  }
});
const glyphs = new Set();
function walk(node) {
  if (!node || typeof node !== "object") return;
  if (typeof node.glyph === "string") glyphs.add(node.glyph.codePointAt(0));
  Object.values(node).forEach(walk);
}
walk(JSON.parse(readFileSync(new URL("../../packages/design/semantics.json", import.meta.url))));

it("pins separately owned bytes, rather than aliasing a product subset", () => {
  const product = JSON.parse(readFileSync(new URL("../../packages/design/tokens.json", import.meta.url))).type.fonts;
  const productHashes = product.map((face) =>
    createHash("sha256")
      .update(readFileSync(new URL(`../../packages/design/css/${face.file}`, import.meta.url)))
      .digest("hex"),
  );
  for (const face of loaded) {
    expect(createHash("sha256").update(face.bytes).digest("hex")).toBe(face.sha256);
    expect(productHashes).not.toContain(face.sha256);
    expect(product.map((font) => font.family)).not.toContain(face.family);
  }
});

it("covers every declared glyph in both stacks without a host font", () => {
  for (const weight of ["400", "500 700"]) {
    const select = (family) =>
      loaded
        .filter(
          (face) =>
            (face.family === family && face.weight === weight) ||
            face.family === "Orca Proof Supplement" ||
            (face.family === "Orca Proof Sans" && face.weight === weight),
        )
        .map((face) => create(face.bytes));
    for (const family of ["Orca Proof Sans", "Orca Proof Mono"]) {
      const fonts = select(family);
      expect(fonts.length).toBeGreaterThan(0);
      for (const cp of glyphs)
        expect(
          fonts.some((font) => font.hasGlyphForCodePoint(cp)),
          `U+${cp.toString(16)} ${family}`,
        ).toBe(true);
      for (let cp = 0x20; cp <= 0x7e; cp++) expect(fonts.some((font) => font.hasGlyphForCodePoint(cp))).toBe(true);
    }
  }
});

it("uses DejaVu for nineteen glyphs and only supplements the two known gaps", () => {
  const sans = create(loaded.find((face) => face.file === "DejaVuSans.woff2").bytes);
  const supplement = create(loaded.find((face) => face.family === "Orca Proof Supplement").bytes);
  const gaps = [...glyphs].filter((cp) => !sans.hasGlyphForCodePoint(cp));
  expect(gaps.sort()).toEqual([0x23f8, 0x2442].sort());
  // HarfBuzz retains the cmap's U+FFFF -> .notdef sentinel; it is not a drawable glyph.
  expect(supplement.characterSet.filter((cp) => supplement.glyphForCodePoint(cp).id !== 0).sort()).toEqual(gaps.sort());
});
