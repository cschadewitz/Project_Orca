/** Rebuild the Linux screenshot control from pinned, separately licensed upstream files.
 * No runner installation or network fetch: committed outputs are the test dependency.
 * Usage: node tools/font-build/build-proof-control.js /path/to/upstream-ttfs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as fontkit from "fontkit";
import subsetFont from "subset-font";

const out = new URL("../../packages/app/test/smoke/control-fonts/", import.meta.url);
const source = process.argv[2];
if (!source) throw new Error("Supply a directory containing the pinned upstream TTFs; see control-fonts/README.md");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const semantics = JSON.parse(readFileSync(new URL("../../packages/design/semantics.json", import.meta.url)));
const glyphs = new Set();
function walk(node) {
  if (!node || typeof node !== "object") return;
  if (typeof node.glyph === "string") glyphs.add(node.glyph.codePointAt(0));
  Object.values(node).forEach(walk);
}
walk(semantics);
const text = [...range(0x20, 0xff), ...range(0x2010, 0x206f), ...range(0x2190, 0x2193), ...range(0x2500, 0x257f)];
const faces = [
  ["DejaVuSans.ttf", "57f73e11f51999432bf7ab22ce55b6f945d5eca1bf824404cfa9ec2e3718c84e", "Orca Proof Sans", "400"],
  [
    "DejaVuSans-Bold.ttf",
    "a4c5bc453ca281d90ea079e596da7ae0dfeb5777497c29ec254e76d97ff6f890",
    "Orca Proof Sans",
    "500 700",
  ],
  ["DejaVuSansMono.ttf", "54bf827eb99404e8f430c330ad30f063334f637eba0109b6a18d4f566a8e9dd8", "Orca Proof Mono", "400"],
  [
    "DejaVuSansMono-Bold.ttf",
    "0d3c03d1b667192f91223660a3163325cf83132662fe4d9f7d6e596bf7a995c2",
    "Orca Proof Mono",
    "500 700",
  ],
  [
    "NotoSansSymbols2-Regular.ttf",
    "876598db5f1e3bef2bc77c4d94c5b0d5d2c1620be4878a06f18fb5434e331688",
    "Orca Proof Supplement",
    "400",
    [0x23f8, 0x2442],
  ],
];
mkdirSync(out, { recursive: true });
const manifest = [];
for (const [name, sourceSha256, family, weight, only] of faces) {
  const bytes = readFileSync(join(source, name));
  if (sha256(bytes) !== sourceSha256) throw new Error(`Unexpected upstream bytes: ${name}`);
  const font = fontkit.create(bytes);
  if (name === "DejaVuSans.ttf") {
    // The Debian package notice omits Arev. Preserve the pinned font's full nameID 0/13
    // wording beside all four DejaVu subsets; HarfBuzz drops nameID 13 from the WOFF2s.
    const { copyright, license } = font.name.records;
    if (!copyright?.en || !license?.en?.includes("Arev Fonts Copyright"))
      throw new Error("The pinned DejaVu source is missing its complete redistribution notice");
    const notice = `${copyright.en.trimEnd()}\n\n${license.en.trimEnd()}\n`
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
    writeFileSync(new URL("LICENSE-DejaVu.txt", out), notice);
  }
  const cps = only ?? [...new Set([...text, ...glyphs])].filter((cp) => font.hasGlyphForCodePoint(cp));
  for (const cp of cps) if (!font.hasGlyphForCodePoint(cp)) throw new Error(`${name} lacks U+${cp.toString(16)}`);
  const subset = await subsetFont(bytes, String.fromCodePoint(...cps), { targetFormat: "woff2" });
  const result = fontkit.create(subset);
  for (const cp of cps) if (!result.hasGlyphForCodePoint(cp)) throw new Error(`${name} lost U+${cp.toString(16)}`);
  const file = name.replace(/\.ttf$/, ".woff2");
  writeFileSync(new URL(file, out), subset);
  manifest.push({
    file,
    family,
    weight,
    source: name,
    sourceSha256,
    sha256: sha256(subset),
    fontFamily: result.familyName,
  });
}
writeFileSync(new URL("manifest.json", out), JSON.stringify(manifest, null, 2) + "\n");
