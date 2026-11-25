/** Installed builder regressions using owned files and parsed pnpm fixtures; no installers or signing. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const lib = createRequire(builderRequire.resolve("app-builder-lib"));
const { buildBlockMap } = lib("./targets/blockmap/blockmap.js");
const { AsarPackager, isPathInside } = lib("./asar/asarUtil.js");
const { getDestinationPath, enforceAllowMissingDependencies } = lib("./util/appFileCopier.js");
const { PnpmNodeModulesCollector } = lib("./node-module-collector/pnpmNodeModulesCollector.js");
const { LogMessageByKey } = lib("./node-module-collector/moduleManager.js");
const { shouldPreserveSymlinks, compute7zCompressArgs } = lib("./targets/archive.js");
const { Platform } = lib("./core.js");
const { TmpDir } = lib("builder-util");
const scratch = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "orca-builder-compat-"));
  scratch.push(dir);
  return dir;
}

it("does not treat sibling prefixes as workspace roots or mapped child destinations", async () => {
  const dir = await directory();
  const source = join(dir, "app");
  const sibling = join(dir, "app-other", "file");
  const child = join(source, "file");
  const destination = join(dir, "output");
  await mkdir(source);
  await mkdir(join(dir, "app-other"));
  await writeFile(child, "owned");
  await writeFile(sibling, "owned sibling");
  expect(isPathInside(source, sibling)).toBe(false);
  expect(isPathInside(source, child)).toBe(true);
  const packager = new AsarPackager({}, { resourcePath: dir });
  expect(await packager.checkAgainstRoots(sibling, [source])).toBe(false);
  expect(await packager.checkAgainstRoots(child, [source])).toBe(true);
  expect(getDestinationPath(child, { src: source, destination })).toBe(join(destination, "file"));
  expect(getDestinationPath(sibling, { src: source, destination })).toBe(destination);
});

it("keeps missing production dependencies fatal when explicitly strict, independently of optional misses", () => {
  const summary = {
    [LogMessageByKey.PKG_NOT_ON_DISK]: ["required@1.0.0"],
    [LogMessageByKey.PKG_OPTIONAL_NOT_INSTALLED]: ["optional@1.0.0"],
  };
  expect(() => enforceAllowMissingDependencies(false, summary)).toThrow("required@1.0.0");
  expect(() => enforceAllowMissingDependencies(undefined, summary)).not.toThrow(); // v26 remains warn-only.
  expect(() => enforceAllowMissingDependencies(["required"], summary)).not.toThrow();
});

it("retains native archive symlink policy and an NSIS-decodable compression filter", () => {
  expect(shouldPreserveSymlinks(Platform.MAC)).toBe(true);
  expect(shouldPreserveSymlinks(Platform.LINUX)).toBe(true);
  expect(shouldPreserveSymlinks(Platform.WINDOWS)).toBe(false);
  expect(compute7zCompressArgs("7z", { installTimeDecodable: true })).toContain("-mf=BCJ");
  expect(compute7zCompressArgs("7z", { installTimeDecodable: true })).not.toContain("-mf=BCJ2");
});

it("loads the Noble 1.x blake2.js backend and agrees with an independent BLAKE2b-144 known answer", async () => {
  const dir = await directory();
  const input = join(dir, "payload");
  const output = join(dir, "payload.blockmap");
  const bytes = Buffer.from("ORCA blockmap fixture"); // rename-keep: the known answer below is for these bytes
  await writeFile(input, bytes);
  const info = await buildBlockMap(input, "gzip", output);
  const map = JSON.parse(gunzipSync(await readFile(output)));
  // CPython hashlib.blake2b(b"ORCA blockmap fixture", digest_size=18), base64 encoded. rename-keep
  expect(map.files[0].checksums).toEqual(["eT9yupzwjTY9MkXzrgI56elk"]);
  expect(map.files[0].sizes).toEqual([bytes.length]);
  expect(info.sha512).toBe(createHash("sha512").update(bytes).digest("base64"));
  expect(info.size).toBe(bytes.length);
});

it("binds fine block regions to exact bytes, rejects invalid ranges, and hashes appended metadata", async () => {
  const dir = await directory();
  const payload = Buffer.concat(
    Array.from({ length: 4096 }, (_, i) => createHash("sha256").update(String(i)).digest()),
  );
  const file = join(dir, "payload");
  const output = join(dir, "map");
  const region = { offset: 1024, size: 65536, chunker: { min: 4096, avg: 8192, max: 16384 } };
  await writeFile(file, payload);
  await buildBlockMap(file, "gzip", output, { regions: [region] });
  const map = JSON.parse(gunzipSync(await readFile(output))).files[0];
  let offset = 0;
  const edges = [];
  for (const size of map.sizes) {
    if (offset >= region.offset && offset < region.offset + region.size) expect(size).toBeLessThanOrEqual(16384);
    offset += size;
    edges.push(offset);
  }
  expect(offset).toBe(payload.length);
  expect(edges).toContain(region.offset);
  expect(edges).toContain(region.offset + region.size);
  await expect(
    buildBlockMap(file, "gzip", output, { regions: [{ ...region, offset: payload.length }] }),
  ).rejects.toThrow();
  await expect(buildBlockMap(file, "gzip", output, { regions: [region, region] })).rejects.toThrow();
  const embedded = await buildBlockMap(file, "deflate");
  const final = await readFile(file);
  const length = final.readUInt32BE(final.length - 4);
  expect(JSON.parse(inflateRawSync(final.subarray(final.length - 4 - length, -4)))).toMatchObject({ version: "2" });
  expect(embedded.blockMapSize).toBe(length);
  expect(embedded.sha512).toBe(createHash("sha512").update(final).digest("base64"));
  expect(embedded.size).toBe(final.length);
});

it.each([false, true])(
  "recovers deduped child stubs using owned manifests, with app/dependency name collision=%s",
  async (collision) => {
    const dir = await directory();
    const packageName = collision ? "shared" : "owned-app";
    const packages = {
      a: { name: "a", version: "1.0.0", dependencies: { shared: "^1.0.0" } },
      b: { name: "b", version: "1.0.0", dependencies: { shared: "^1.0.0" } },
      shared: { name: "shared", version: "1.0.0", dependencies: { leaf: "^1.0.0" } },
      leaf: { name: "leaf", version: "1.0.0" },
    };
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "9.0.0",
        dependencies: { a: "1.0.0", b: "1.0.0", ...(collision ? { shared: "1.0.0" } : {}) },
      }),
    );
    for (const [name, pkg] of Object.entries(packages)) {
      const path = join(dir, "node_modules", name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "package.json"), JSON.stringify(pkg));
    }
    const dep = (name, dependencies = {}) => ({
      name,
      from: name,
      version: "1.0.0",
      path: join(dir, "node_modules", name),
      dependencies,
    });
    const tree = [
      {
        name: packageName,
        version: "9.0.0",
        path: dir,
        dependencies: {
          a: dep("a", { shared: { ...dep("shared"), dedupedDependenciesCount: 1 } }),
          b: dep("b", { shared: dep("shared", { leaf: dep("leaf") }) }),
          ...(collision ? { shared: dep("shared") } : {}),
        },
      },
    ];
    const temp = new TmpDir();
    try {
      const collector = new PnpmNodeModulesCollector(dir, temp);
      // Only the pnpm command response/version are synthetic. Parsing, manifest
      // lookup, recovery of omitted children and hoisting are installed library code.
      collector.pnpmVersion = { value: Promise.resolve(12) };
      collector.getDependenciesTree = () => collector.parseDependenciesTree(JSON.stringify(tree));
      const result = await collector.getNodeModules({ packageName });
      const names = [];
      const visit = (modules) => {
        for (const module of modules) {
          names.push(module.name);
          visit(module.dependencies ?? []);
        }
      };
      visit(result.nodeModules);
      expect(names.sort()).toEqual(["a", "b", "leaf", "shared"]);
      expect(result.logSummary[LogMessageByKey.PKG_NOT_ON_DISK]).toEqual([]);
    } finally {
      await temp.cleanup();
    }
  },
);
