/** Installed plugin release pins must prove the complete composition before capture or reconstruction. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { builtinExecutors } from "@orca/engine";
import {
  loadInstalledPluginRelease,
  type InstalledPluginRelease,
  type PluginReleaseManifest,
} from "../src/plugin-release.js";
import {
  capturePluginRestoration,
  restorePluginExecutors,
  type LoadedRestorationPlugin,
} from "../src/plugin-runtime.js";

const dirs: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const refusal = { code: "RUN_STATE", details: { pluginRestorationReason: "identity_unverified" } };
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(count = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orca-plugin-release-")));
  dirs.push(root);
  const plugins = Array.from({ length: count }, (_, index) => ({
    spec: `./plugin-${index}.mjs`,
    id: `fixture-${index}`,
    schemaVersion: 1,
    closure: "closed-node-esm-bundle-v1" as const,
    path: `plugin-${index}.mjs`,
    sha256: hash(`// closed synthetic bundle ${index}\n`),
    externalImports: ["node:crypto"],
  }));
  await Promise.all(
    plugins.map((plugin, index) => writeFile(join(root, plugin.path), `// closed synthetic bundle ${index}\n`)),
  );
  const manifest: PluginReleaseManifest = {
    contractVersion: 1,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    plugins,
  };
  const manifestPath = "plugin-release.json";
  const bytes = JSON.stringify(manifest);
  await writeFile(join(root, manifestPath), bytes);
  const reference: InstalledPluginRelease = { root, manifestPath, manifestSha256: hash(bytes) };
  const entries = plugins.map((plugin) => ({
    spec: plugin.spec,
    url: pathToFileURL(join(root, plugin.path)).href,
    digest: plugin.sha256,
  }));
  const repin = async (raw: unknown = manifest) => {
    const replacement = JSON.stringify(raw);
    await writeFile(join(root, manifestPath), replacement);
    reference.manifestSha256 = hash(replacement);
  };
  return { root, manifest, reference, entries, repin };
}

it("derives detached frozen identities from a trusted pin and verifies exact installed bytes", async () => {
  const data = await fixture();
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  const identity = release.identityFor(data.entries[0]!.spec)!;
  expect(identity).toMatchObject({
    id: "fixture-0",
    schemaVersion: 1,
    codeVersion: `sha256:${data.entries[0]!.digest}`,
  });
  expect(identity.dependencyIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(Object.isFrozen(identity)).toBe(true);
  expect(release.identityFor("uninstalled")).toBeUndefined();
  expect(await release.verify({ spec: data.entries[0]!.spec, entry: data.entries[0]!, identity })).toBe(true);
  data.manifest.plugins[0]!.id = "caller mutation";
  expect(release.identityFor(data.entries[0]!.spec)!.id).toBe("fixture-0");
});

it("reconstructs fresh isolated executors with the real verifier and no provider call", async () => {
  const data = await fixture();
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  const execute = vi.fn();
  const register = vi.fn();
  const loaded: LoadedRestorationPlugin = {
    spec: data.entries[0]!.spec,
    entry: data.entries[0]!,
    executors: ["custom:fixture"],
    plugin: {
      name: "fixture",
      register,
      restoration: {
        identity: release.identityFor(data.entries[0]!.spec)!,
        capture: () => ({ model: "admitted" }),
        validate: (raw) => typeof raw === "object" && raw !== null && Object.keys(raw).join() === "model",
        restore: (_record, api) => api.executors.register({ type: "custom:fixture", execute }),
      },
    },
  };
  const records = await capturePluginRestoration([loaded], false, release.verify);
  const fresh = await loadInstalledPluginRelease(data.reference, data.entries);
  const restored = await restorePluginExecutors(records, [loaded], fresh.verify);
  expect(restored.get("custom:fixture")).toBeDefined();
  expect(builtinExecutors().get("custom:fixture")).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

it("refuses self-reported release metadata and a changed manifest with the original external pin", async () => {
  const data = await fixture();
  await writeFile(
    join(data.root, data.reference.manifestPath),
    JSON.stringify({ version: "0.6.0", sha: "a".repeat(40), compatibility: { storeEpoch: 1 } }),
  );
  await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
  data.manifest.plugins[0]!.id = "changed";
  await writeFile(join(data.root, data.reference.manifestPath), JSON.stringify(data.manifest));
  await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
});

it.each(["node", "platform", "arch"] as const)(
  "refuses a different %s runtime even with a valid manifest pin",
  async (field) => {
    const data = await fixture();
    data.manifest.runtime[field] = "other";
    await data.repin();
    await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
  },
);

it.each(["closure", "external", "duplicateId", "duplicateSpec", "unknownField", "missingField", "empty", "version"])(
  "refuses unsupported or malformed %s evidence",
  async (scenario) => {
    const data = await fixture(2);
    const raw = JSON.parse(JSON.stringify(data.manifest)) as Record<string, unknown>;
    const plugins = raw.plugins as Record<string, unknown>[];
    if (scenario === "closure") plugins[0]!.closure = "source-tree-lockfile-only";
    if (scenario === "external") plugins[0]!.externalImports = ["unbundled-provider"];
    if (scenario === "duplicateId") plugins[1]!.id = plugins[0]!.id;
    if (scenario === "duplicateSpec") plugins[1]!.spec = plugins[0]!.spec;
    if (scenario === "unknownField") raw.publisherTrusted = true;
    if (scenario === "missingField") delete plugins[0]!.externalImports;
    if (scenario === "empty") raw.plugins = [];
    if (scenario === "version") raw.contractVersion = 2;
    await data.repin(raw);
    await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
  },
);

it.each(["extra", "missing", "reordered", "spec", "url", "digest"])(
  "refuses %s installed composition evidence",
  async (scenario) => {
    const data = await fixture(2);
    if (scenario === "extra") data.entries.push({ ...data.entries[0]!, spec: "legacy" });
    if (scenario === "missing") data.entries.pop();
    if (scenario === "reordered") data.entries.reverse();
    if (scenario === "spec") data.entries[0]!.spec = "different";
    if (scenario === "url") data.entries[0]!.url += "?alias";
    if (scenario === "digest") data.entries[0]!.digest = "0".repeat(64);
    await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
  },
);

it.each(["manifest", "bundle"])("rejects symlink replacement of a pinned %s", async (which) => {
  const data = await fixture();
  const path = join(data.root, which === "manifest" ? data.reference.manifestPath : data.manifest.plugins[0]!.path);
  const bytes = await readFile(path);
  const outside = join(data.root, "same-bytes");
  await writeFile(outside, bytes);
  await rm(path);
  await symlink(outside, path);
  await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
});

it.each(["../outside.mjs", "/outside.mjs", "nested/../plugin-0.mjs", "nested\\plugin-0.mjs"])(
  "refuses uncontained bundle path %s",
  async (path) => {
    const data = await fixture();
    data.manifest.plugins[0]!.path = path;
    await data.repin();
    await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
  },
);

it("refuses an aliased release root and sanitized missing/oversized evidence", async () => {
  const data = await fixture();
  const alias = join(data.root, "alias");
  await symlink(data.root, alias);
  await expect(loadInstalledPluginRelease({ ...data.reference, root: alias }, data.entries)).rejects.toMatchObject(
    refusal,
  );
  await expect(
    loadInstalledPluginRelease({ ...data.reference, manifestPath: "missing-secret-name" }, data.entries),
  ).rejects.toMatchObject({ ...refusal, message: expect.not.stringContaining("missing-secret-name") });
  await writeFile(join(data.root, data.reference.manifestPath), "x".repeat(128 * 1024 + 1));
  await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
});

it("checks every bundle again and refuses before capture or any historical factory", async () => {
  const data = await fixture(2);
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  const capture = vi.fn(() => ({ model: "admitted" }));
  const restore = vi.fn();
  const loaded = data.entries.map((entry): LoadedRestorationPlugin => ({
    spec: entry.spec,
    entry,
    executors: [],
    plugin: {
      name: entry.spec,
      register: vi.fn(),
      restoration: { identity: release.identityFor(entry.spec)!, capture, validate: () => true, restore },
    },
  }));
  const records = await capturePluginRestoration(loaded, false, release.verify);
  capture.mockClear();
  await writeFile(join(data.root, data.manifest.plugins[1]!.path), "changed dependency code\n");
  await expect(capturePluginRestoration(loaded, false, release.verify)).rejects.toMatchObject(refusal);
  await expect(restorePluginExecutors(records, loaded, release.verify)).rejects.toMatchObject(refusal);
  expect(capture).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
});

it("refuses manifest changes after initial verification even if code bytes are unchanged", async () => {
  const data = await fixture();
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  data.manifest.plugins[0]!.externalImports = ["node:fs"];
  await data.repin();
  expect(
    await release.verify({
      spec: data.entries[0]!.spec,
      entry: data.entries[0]!,
      identity: release.identityFor(data.entries[0]!.spec)!,
    }),
  ).toBe(false);
});

it("rejects mismatched identity declarations, including dependency-only changes", async () => {
  const data = await fixture();
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  for (const field of ["id", "codeVersion", "dependencyIdentity"] as const) {
    expect(
      await release.verify({
        spec: data.entries[0]!.spec,
        entry: data.entries[0]!,
        identity: { ...release.identityFor(data.entries[0]!.spec)!, [field]: "self-reported" },
      }),
    ).toBe(false);
  }
});

it("rejects directory artifacts without reading them as code", async () => {
  const data = await fixture();
  await rm(join(data.root, data.manifest.plugins[0]!.path));
  await mkdir(join(data.root, data.manifest.plugins[0]!.path));
  await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
});

it("streams multi-chunk bundle evidence and refuses oversized sparse artifacts before reading", async () => {
  const data = await fixture();
  const source = "// closed bundle\n".repeat(16_384);
  const path = join(data.root, data.manifest.plugins[0]!.path);
  await writeFile(path, source);
  data.manifest.plugins[0]!.sha256 = hash(source);
  data.entries[0]!.digest = hash(source);
  await data.repin();
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  expect(
    await release.verify({
      spec: data.entries[0]!.spec,
      entry: data.entries[0]!,
      identity: release.identityFor(data.entries[0]!.spec)!,
    }),
  ).toBe(true);
  await truncate(path, 64 * 1024 * 1024 + 1);
  await expect(loadInstalledPluginRelease(data.reference, data.entries)).rejects.toMatchObject(refusal);
});

it("never retargets an existing verifier when its caller mutates the release reference", async () => {
  const data = await fixture();
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  data.reference.manifestPath = "missing";
  data.reference.manifestSha256 = "0".repeat(64);
  data.reference.root = "/missing";
  expect(
    await release.verify({
      spec: data.entries[0]!.spec,
      entry: data.entries[0]!,
      identity: release.identityFor(data.entries[0]!.spec)!,
    }),
  ).toBe(true);
});

it("refuses symlink substitution after initial byte verification", async () => {
  const data = await fixture();
  const release = await loadInstalledPluginRelease(data.reference, data.entries);
  const path = join(data.root, data.manifest.plugins[0]!.path);
  const alias = join(data.root, "bundle-copy.mjs");
  await writeFile(alias, await readFile(path));
  await rm(path);
  await symlink(alias, path);
  expect(
    await release.verify({
      spec: data.entries[0]!.spec,
      entry: data.entries[0]!,
      identity: release.identityFor(data.entries[0]!.spec)!,
    }),
  ).toBe(false);
});
