/** Candidate producer evidence is separate from independently authorized release-pin and operator acceptance. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { bootstrap } from "../../packages/cli/src/bootstrap.ts";
import { loadInstalledPluginRelease } from "../../packages/cli/src/plugin-release.ts";
import { composePluginRelease, writePluginRelease } from "../plugin-release.js";

const dirs = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refusal = { code: "RUN_STATE", details: { pluginRestorationReason: "identity_unverified" } };
const run = promisify(execFile);
const source = `import { makeExecutor } from "fixture-dependency";
const plugin = {
  name: "owned-candidate",
  register(api) {
    const model = process.env.ORCA_PRODUCER_MODEL || "admitted";
    api.executors.register(makeExecutor(model));
    if (api.restorationIdentity) plugin.restoration = {
      identity: api.restorationIdentity,
      capture: () => ({ model }),
      validate: (data) => data && Object.keys(data).join() === "model" && typeof data.model === "string",
      restore: (data, restored) => restored.executors.register(makeExecutor(data.model))
    }; else delete plugin.restoration;
  }
};
export default plugin;
`;
const dependency = `import { basename } from "node:path";
export const makeExecutor = (model) => ({ type: "custom:owned-candidate", execute: async () => ({
  kind: "completed", result: { artifactIds: [], data: { model, implementation: basename("owned/v1") } }
}) });
`;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(initial = source) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orca-release-producer-")));
  dirs.push(root);
  const src = join(root, "source");
  const dep = join(src, "node_modules/fixture-dependency");
  await mkdir(dep, { recursive: true });
  await writeFile(join(dep, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  await writeFile(join(dep, "index.js"), dependency);
  const entry = join(src, "entry.mjs");
  await writeFile(entry, initial);
  const plan = { plugins: [{ entry, id: "owned-candidate", schemaVersion: 1 }] };
  return { root, entry, dep, plan };
}

async function install(data, name = "installation") {
  const root = join(data.root, name);
  const candidate = await writePluginRelease(data.plan, root);
  const entries = candidate.manifest.plugins.map((plugin) => ({
    spec: plugin.spec,
    url: pathToFileURL(join(root, plugin.path)).href,
    digest: plugin.sha256,
  }));
  // Test-harness authorization only: no production authority is established by the candidate hash.
  const reference = { root, manifestPath: "plugin-release.json", manifestSha256: candidate.candidateManifestSha256 };
  return { root, candidate, entries, reference };
}

it("builds deterministic complete bundles across source roots and the installed verifier accepts an independently supplied test pin", async () => {
  const one = await fixture();
  const two = await fixture();
  const a = await composePluginRelease(one.plan);
  const b = await composePluginRelease(two.plan);
  expect(a.manifestBytes).toEqual(b.manifestBytes);
  expect(a.bundles[0].bytes).toEqual(b.bundles[0].bytes);
  expect(a.manifest.plugins[0].externalImports).toEqual(["node:path"]);
  expect(a.bundles[0].bytes.toString()).not.toContain(one.root);
  const installed = await install(one);
  const verified = await loadInstalledPluginRelease(installed.reference, installed.entries);
  const identity = verified.identityFor(installed.entries[0].spec);
  expect(await verified.verify({ spec: installed.entries[0].spec, entry: installed.entries[0], identity })).toBe(true);
  // The installed artifact is usable with no source/dependency tree present.
  await rm(join(one.root, "source"), { recursive: true });
  const plugin = (await import(installed.entries[0].url)).default;
  const registered = [];
  plugin.register({ executors: { register: (value) => registered.push(value) }, restorationIdentity: identity });
  expect((await registered[0].execute()).result.data).toEqual({ model: "admitted", implementation: "v1" });
});

it("a transitive dependency change changes code/dependency identity and cannot use the old independent pin", async () => {
  const data = await fixture();
  const old = await install(data);
  const a = await loadInstalledPluginRelease(old.reference, old.entries);
  await writeFile(join(data.dep, "index.js"), dependency.replace("owned/v1", "owned/v2"));
  const changed = await install(data, "changed");
  expect(changed.candidate.candidateManifestSha256).not.toBe(old.reference.manifestSha256);
  await expect(
    loadInstalledPluginRelease({ ...changed.reference, manifestSha256: old.reference.manifestSha256 }, changed.entries),
  ).rejects.toMatchObject(refusal);
  const b = await loadInstalledPluginRelease(changed.reference, changed.entries);
  expect(b.identityFor(changed.entries[0].spec).codeVersion).not.toBe(a.identityFor(old.entries[0].spec).codeVersion);
  expect(b.identityFor(changed.entries[0].spec).dependencyIdentity).not.toBe(
    a.identityFor(old.entries[0].spec).dependencyIdentity,
  );
});

it("generated bundles pass real bootstrap recovery and remain unverified without an injected test pin", async () => {
  const data = await fixture();
  const installed = await install(data);
  await writeFile(
    join(installed.root, "workflow.yaml"),
    `id: owned\nname: Owned\nstart: start\nnodes:\n  start: { type: start }\n  gate: { type: gate, question: Go?, options: [go] }\n  custom: { type: custom:owned-candidate }\n  end: { type: end }\nedges:\n  - { from: start, to: gate }\n  - { from: gate, to: custom }\n  - { from: custom, to: end }\n`,
  );
  const config = (logLevel) =>
    parseOrcaConfig({
      plugins: installed.entries.map((item) => item.spec),
      workflows: ["workflow.yaml"],
      templates: [],
      humanInput: { mode: "pause" },
      logLevel,
    });
  const options = {
    cwd: installed.root,
    configDir: installed.root,
    config: config("info"),
    logger: silentLogger,
    installedPluginRelease: installed.reference,
  };
  vi.stubEnv("ORCA_PRODUCER_MODEL", "info");
  const first = await bootstrap(options);
  const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "owned" });
  const id = await launch.startRun({});
  expect((await first.orchestrator.run(id)).run.status).toBe("paused");
  const input = (await first.orchestrator.pendingInputs(id))[0];
  vi.stubEnv("ORCA_PRODUCER_MODEL", "warn");
  const second = await bootstrap({ ...options, config: config("warn") });
  await second.orchestrator.answer(input.id, "go", id);
  expect((await second.orchestrator.resume(id)).run.status).toBe("completed");
  const events = await second.orchestrator.stores.events.read(id);
  expect(
    events.find((event) => event.type === "step.completed" && event.payload.result.data.implementation)?.payload.result
      .data,
  ).toEqual({ model: "info", implementation: "v1" });

  const { installedPluginRelease: _pin, ...unapproved } = options;
  vi.stubEnv("ORCA_PLUGIN_RELEASE_SHA256", installed.reference.manifestSha256);
  const third = await bootstrap(unapproved);
  expect(third.generations.current.snapshot.pluginRestoration).toBeUndefined();
  await expect(third.generations.restore(launch.generationId)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { pluginRestorationReason: "unavailable_plugin" },
  });
  await writeFile(
    join(installed.root, installed.candidate.manifest.plugins[0].path),
    "throw new Error('must not import');",
  );
  await expect(bootstrap(options)).rejects.toMatchObject(refusal);
});

it.each([
  ["computed import", "export const load = (path) => import(path);"],
  ["glob import", "export const load = (name) => import(`./${name}.mjs`);"],
  ["CommonJS loader", 'const dep = require("node:path"); export default dep;'],
  ["aliased loader", "const load = require; export default load;"],
  ["eval", 'export const run = () => eval("1");'],
  ["Function constructor", 'export const run = new Function("return 1");'],
  ["module loader", 'import { createRequire } from "node:module"; export default createRequire;'],
  ["native dependency", 'import native from "./native.node"; export default native;'],
  ["network facility", 'import https from "node:https"; export default https;'],
  ["behavior file loader", 'import fs from "node:fs"; export default fs;'],
  ["builtin module bypass", 'export default process.getBuiltinModule("module");'],
  ["native binding bypass", 'export default process.binding("fs");'],
  ["runtime download", 'export const run = () => fetch("https://invalid.example/code");'],
  ["hidden loader", 'export const run = () => globalThis["eval"]("1");'],
])("refuses %s without executing the candidate or writing a partial installation", async (_label, code) => {
  const data = await fixture(`${code}\nthrow new Error("private source must not leak");`);
  await writeFile(join(data.root, "source/native.node"), "native bytes");
  const destination = join(data.root, "refused");
  await expect(writePluginRelease(data.plan, destination)).rejects.toThrow(/^Unsupported plugin release composition$/);
  await expect(readFile(join(destination, "plugin-release.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("checks dead-code dependencies before tree shaking and accepts bounded literal dynamic imports", async () => {
  const data = await fixture('export const unused = () => import("./lazy.mjs");');
  await writeFile(join(data.root, "source/lazy.mjs"), 'export const value = "included";');
  const candidate = await composePluginRelease(data.plan);
  expect(candidate.bundles[0].bytes.toString()).toContain("included");
  await writeFile(join(data.root, "source/lazy.mjs"), "export const unused = (name) => import(name);");
  await expect(composePluginRelease(data.plan)).rejects.toThrow("Unsupported plugin release composition");
});

it.each(["duplicate", "empty", "unknown", "relative", "bad-id", "schema", "external-policy"])(
  "refuses %s plans",
  async (scenario) => {
    const data = await fixture();
    const plan = data.plan;
    if (scenario === "duplicate") plan.plugins.push({ ...plan.plugins[0] });
    if (scenario === "empty") plan.plugins = [];
    if (scenario === "unknown") plan.approved = true;
    if (scenario === "relative") plan.plugins[0].entry = "entry.mjs";
    if (scenario === "bad-id") plan.plugins[0].id = "../escape";
    if (scenario === "schema") plan.plugins[0].schemaVersion = 0;
    if (scenario === "external-policy") plan.plugins[0].external = ["unbundled"];
    await expect(composePluginRelease(plan)).rejects.toThrow("Unsupported plugin release composition");
  },
);

it("CLI emits only an unapproved candidate digest and never overwrites an existing installation", async () => {
  const data = await fixture();
  const plan = join(data.root, "plan.json");
  const destination = join(data.root, "candidate");
  await writeFile(plan, JSON.stringify(data.plan));
  const { stdout } = await run(process.execPath, [
    resolve("tools/plugin-release.js"),
    "--plan",
    plan,
    "--out",
    destination,
  ]);
  const manifest = await readFile(join(destination, "plugin-release.json"));
  expect(JSON.parse(stdout)).toEqual({ candidateManifestSha256: digest(manifest), approved: false });
  await expect(writePluginRelease(data.plan, destination)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(join(destination, "plugin-release.json"))).toEqual(manifest);
});

it("audits a transitive dependency that contains a computed loader", async () => {
  const data = await fixture();
  await writeFile(join(data.dep, "index.js"), `${dependency}\nexport const load = (name) => import(name);`);
  await expect(composePluginRelease(data.plan)).rejects.toThrow("Unsupported plugin release composition");
});

it("includes JSON dependencies and canonical sorted builtin declarations", async () => {
  const data = await fixture(`import values from "./values.json";
import { basename } from "node:path";
import { inspect } from "node:util";
export default { value: basename(values.value), inspect };`);
  await writeFile(join(data.root, "source/values.json"), '{"value":"json/dependency"}');
  const candidate = await composePluginRelease(data.plan);
  expect(candidate.manifest.plugins[0].externalImports).toEqual(["node:path", "node:util"]);
  expect(candidate.bundles[0].bytes.toString()).toContain("json/dependency");
});

it("preserves complete plugin order and rejects reordered installed entries", async () => {
  const data = await fixture();
  data.plan.plugins.push({ ...data.plan.plugins[0], id: "second-plugin" });
  const installed = await install(data);
  expect(installed.candidate.manifest.plugins.map((plugin) => plugin.id)).toEqual(["owned-candidate", "second-plugin"]);
  await expect(loadInstalledPluginRelease(installed.reference, [...installed.entries].reverse())).rejects.toMatchObject(
    refusal,
  );
});

it("refuses oversized input before reading sparse bytes", async () => {
  const data = await fixture();
  await truncate(data.entry, 16 * 1024 * 1024 + 1);
  await expect(composePluginRelease(data.plan)).rejects.toThrow("Unsupported plugin release composition");
});

it("produces candidates without evaluating plugin top-level code", async () => {
  const data = await fixture('throw new Error("must never run during production"); export default {};');
  expect((await composePluginRelease(data.plan)).manifest.plugins).toHaveLength(1);
});
