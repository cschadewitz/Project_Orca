/** release-assets.py: the update metadata the client reads (files[]) must describe the verified installer. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const VERSION = "0.7.1-rc.1";
const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const sha512 = (data) => createHash("sha512").update(data).digest("base64");

/** A builder-shaped artifact set; `edit(arch, fields)` may change what each yml says. */
function fixture(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "orca-release-assets-"));
  dirs.push(root);
  for (const arch of ["x64", "arm64"]) {
    const dir = join(root, arch);
    mkdirSync(dir);
    const name = `ORCA-${VERSION}-win-${arch}.exe`;
    const body = Buffer.from(`signed installer ${arch}`);
    writeFileSync(join(dir, name), body);
    writeFileSync(join(dir, `${name}.blockmap`), "map");
    const f = {
      version: VERSION,
      url: name,
      entrySha: sha512(body),
      size: String(body.length),
      path: name,
      sha: sha512(body),
    };
    f.extraEntries = "";
    f.extraTop = "";
    edit(arch, f);
    writeFileSync(
      join(dir, `prerelease-${arch}.yml`),
      `version: ${f.version}\nfiles:\n  - url: ${f.url}\n    sha512: ${f.entrySha}\n    size: ${f.size}\n` +
        `    blockMapSize: 3\n${f.extraEntries}path: ${f.path}\nsha512: ${f.sha}\n` +
        `releaseDate: '2026-11-21T00:00:00.000Z'\n${f.extraTop}`,
    );
  }
  return root;
}

const verify = (root) =>
  spawnSync("python3", ["-B", "tools/deploy/release-assets.py", root, VERSION], { encoding: "utf8" });

describe("release-assets.py update metadata", () => {
  it("accepts builder-shaped metadata whose files[] and legacy fields describe the installer", () => {
    const result = verify(fixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["a files[] url naming another installer", (f) => (f.url = `ORCA-${VERSION}-win-arm64.exe`)],
    ["a files[] url with a directory", (f) => (f.url = `../ORCA-${VERSION}-win-x64.exe`)],
    ["a files[] sha512 for other bytes", (f) => ((f.entrySha = sha512("other")), (f.sha = f.entrySha))],
    ["a files[] size that does not match", (f) => (f.size = "1")],
    ["a non-numeric size", (f) => (f.size = "ten")],
    ["legacy path disagreeing with files[]", (f) => (f.path = "ORCA-old-win-x64.exe")],
    ["legacy sha512 disagreeing with files[]", (f) => (f.sha = sha512("legacy"))],
    [
      "two installer entries",
      (f) => (f.extraEntries = `  - url: ${f.url}\n    sha512: ${f.entrySha}\n    size: ${f.size}\n`),
    ],
    ["an unknown entry key", (f) => (f.extraEntries = "    signature: x\n")],
    ["an unknown top-level key", (f) => (f.extraTop = "stagingPercentage: 10\n")],
    ["a duplicated top-level key", (f) => (f.extraTop = `sha512: ${f.sha}\n`)],
    ["a mismatched version", (f) => (f.version = "0.7.1-rc.2")],
  ])("refuses %s", (_label, change) => {
    const result = verify(fixture((arch, f) => arch === "x64" && change(f)));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RuntimeError/);
  });

  it("refuses metadata with no files[] at all, and a missing blockmap", () => {
    const legacyOnly = fixture();
    const name = `ORCA-${VERSION}-win-x64.exe`;
    writeFileSync(join(legacyOnly, "x64", "prerelease-x64.yml"), `version: ${VERSION}\npath: ${name}\nsha512: x\n`);
    expect(verify(legacyOnly).stderr).toMatch(/exactly one installer/);
    const noMap = fixture();
    rmSync(join(noMap, "arm64", `ORCA-${VERSION}-win-arm64.exe.blockmap`));
    expect(verify(noMap).stderr).toMatch(/Incomplete or corrupt/);
  });
});
