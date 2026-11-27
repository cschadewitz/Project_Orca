/**
 * The package around a verified Codex entrypoint, and any bubblewrap on Codex's PATH, checked
 * before ORCA starts it (#1286), on small fixture files: no Codex.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_VERIFIED_IMAGES,
  CODEX_VERIFIED_PACKAGE_FILES,
  checkCodexPackage,
  checkSystemBwrap,
} from "../src/index.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orca-1286-")));
  return () => rm(root, { recursive: true, force: true });
});

describe("the pinned package files", () => {
  it("are pinned for every verified entrypoint, and never name the entrypoint itself", () => {
    for (const [version, images] of Object.entries(CODEX_VERIFIED_IMAGES))
      for (const target of Object.keys(images)) {
        const files = CODEX_VERIFIED_PACKAGE_FILES[version]?.[target];
        expect(files, `${version} ${target}`).toBeDefined();
        expect(Object.keys(files!)).toEqual(
          expect.arrayContaining([
            "codex-package.json",
            "codex-resources/bwrap",
            "bin/codex-code-mode-host",
            "codex-path/rg",
          ]),
        );
        expect(files!["bin/codex"]).toBeUndefined();
        for (const digest of Object.values(files!)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
  });
});

describe("checkCodexPackage", () => {
  const FILES = { "codex-package.json": "{}", "codex-resources/bwrap": "bwrap", "codex-path/rg": "rg" };
  const PINS = { "1.0.0": { "linux-x64": Object.fromEntries(Object.entries(FILES).map(([f, t]) => [f, sha(t)])) } };
  const entrypoint = () => join(root, "bin", "codex");
  const build = async (files: Record<string, string> = FILES) => {
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(entrypoint(), "codex");
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
  };
  const check = (opts: { timeoutMs?: number } = {}) =>
    checkCodexPackage(entrypoint(), "1.0.0", "linux-x64", { pins: PINS, ...opts });

  it("accepts a package whose files all have their pinned digests", async () => {
    await build();
    await expect(check()).resolves.toBeUndefined();
  });

  it("refuses a file that differs from its pin", async () => {
    await build({ ...FILES, "codex-resources/bwrap": "another bwrap" });
    await expect(check()).resolves.toBe(
      "the package's codex-resources/bwrap is not the file ORCA verified for Codex 1.0.0",
    );
  });

  it("refuses a missing file", async () => {
    const { "codex-path/rg": _, ...rest } = FILES;
    await build(rest);
    await expect(check()).resolves.toMatch(/^the package's codex-path\/rg cannot be read/);
  });

  it("refuses a pinned file reached through a link, even to identical bytes", async () => {
    const { "codex-resources/bwrap": _, ...rest } = FILES;
    await build(rest);
    await writeFile(join(root, "elsewhere"), "bwrap");
    await mkdir(join(root, "codex-resources"));
    await symlink(join(root, "elsewhere"), join(root, "codex-resources", "bwrap"));
    await expect(check()).resolves.toBe("the package's codex-resources/bwrap is not a plain file");
  });

  it("refuses a pinned file under a linked directory", async () => {
    const { "codex-path/rg": _, ...rest } = FILES;
    await build(rest);
    await mkdir(join(root, "other"));
    await writeFile(join(root, "other", "rg"), "rg");
    await symlink(join(root, "other"), join(root, "codex-path"));
    await expect(check()).resolves.toBe("the package's codex-path is not a plain directory");
  });

  it("refuses an entrypoint that is not a package's bin/codex", async () => {
    await expect(checkCodexPackage(join(root, "codex"), "1.0.0", "linux-x64", { pins: PINS })).resolves.toBe(
      "its command is not the bin/codex of a Codex package",
    );
  });

  it("refuses a version or target with no pinned files", async () => {
    await build();
    await expect(checkCodexPackage(entrypoint(), "1.0.0", "linux-arm64", { pins: PINS })).resolves.toBe(
      "ORCA has no pinned package files for Codex 1.0.0 on linux-arm64",
    );
  });

  it("gives up once its time for the whole package has passed", async () => {
    await build();
    await expect(check({ timeoutMs: 0 })).resolves.toBe("ORCA's check of the package did not finish within 0 ms");
  });
});

describe("checkSystemBwrap", () => {
  it("accepts a PATH with no bubblewrap on it, and skips entries that are not directories", async () => {
    await writeFile(join(root, "file"), "");
    await expect(checkSystemBwrap(`${join(root, "none")}:${join(root, "file")}`, root)).resolves.toBeUndefined();
    await expect(checkSystemBwrap(undefined, root)).resolves.toBeUndefined();
  });

  it("refuses a bubblewrap the user's own processes could replace", async () => {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "bwrap"), "", { mode: 0o755 });
    await expect(checkSystemBwrap(`/nowhere:${join(root, "bin")}`, root)).resolves.toMatch(
      new RegExp(`^Codex would run the bubblewrap at ${join(root, "bin", "bwrap")} on its PATH instead of its own`),
    );
  });

  it("refuses a link to a root-owned file from a directory that is not root's alone", async () => {
    await mkdir(join(root, "bin"));
    await symlink("/bin/sh", join(root, "bin", "bwrap"));
    await expect(checkSystemBwrap(join(root, "bin"), root)).resolves.toMatch(/is not root's alone/);
  });

  it("reads an empty PATH entry as the working directory", async () => {
    await writeFile(join(root, "bwrap"), "", { mode: 0o755 });
    await expect(checkSystemBwrap("/nowhere::", root)).resolves.toMatch(
      new RegExp(`bubblewrap at ${join(root, "bwrap")} on its PATH`),
    );
  });

  it("refuses a bubblewrap it cannot check", async () => {
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "locked", "bwrap"), "");
    await chmod(join(root, "locked"), 0o000);
    try {
      // Root reads through a mode-0 directory: then the file is found, and refused as the user's.
      await expect(checkSystemBwrap(join(root, "locked"), root)).resolves.toMatch(
        process.getuid?.() === 0 ? /is not root's alone/ : /^ORCA could not check the bubblewrap at/,
      );
    } finally {
      await chmod(join(root, "locked"), 0o755);
    }
  });

  const system = ["/usr/bin/bwrap", "/bin/bwrap"].find((p) => {
    if (!existsSync(p)) return false;
    for (let at = realpathSync(p); ; at = dirname(at)) {
      const s = lstatSync(at);
      if (s.uid !== 0 || (s.mode & 0o022) !== 0) return false;
      if (dirname(at) === at) return true;
    }
  });
  it.skipIf(!system)("accepts an installed system bubblewrap, owned by root and writable by no one else", async () => {
    await expect(checkSystemBwrap(dirname(system!), root)).resolves.toBeUndefined();
  });
});
