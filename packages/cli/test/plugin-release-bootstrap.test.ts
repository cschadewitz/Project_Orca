/** Real bootstrap mounts independently pinned plugin identities and preserves recovery/refusal across instances and processes. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";
import type { InstalledPluginRelease, PluginReleaseManifest } from "../src/plugin-release.js";

const dirs: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const refusal = { code: "RUN_STATE", details: { pluginRestorationReason: "identity_unverified" } };
const source = `const implementation = "v1";
const executor = (model) => ({ type: "custom:release", execute: async () => ({
  kind: "completed", result: { artifactIds: [], data: { model, implementation } }
}) });
const plugin = {
  name: "release-fixture",
  register(api) {
    const model = process.env.ORCA_RELEASE_FIXTURE_MODEL || "default";
    api.executors.register(executor(model));
    const identity = api.restorationIdentity;
    if (!identity) { delete plugin.restoration; return; }
    const property = Object.getOwnPropertyDescriptor(api, "restorationIdentity");
    if (!Object.isFrozen(identity) || property.writable || property.configurable)
      throw new Error("unprotected mounting");
    plugin.restoration = {
      identity,
      capture() { return { model }; },
      validate(data) { return data && Object.keys(data).join() === "model" && typeof data.model === "string"; },
      restore(data, api) { api.executors.register(executor(data.model)); }
    };
  }
};
export default plugin;
`;
const workflow = `id: release-fixture
name: Release fixture
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: Go?, options: [go] }
  custom: { type: custom:release }
  done: { type: end }
edges:
  - { from: s, to: gate }
  - { from: gate, to: custom }
  - { from: custom, to: done }
`;

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installation(initial = source) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orca-installed-bootstrap-")));
  dirs.push(root);
  await writeFile(join(root, "fixture.yaml"), workflow);
  const manifest: PluginReleaseManifest = {
    contractVersion: 1,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    plugins: [
      {
        spec: "./entry.mjs",
        id: "release-fixture",
        schemaVersion: 1,
        closure: "closed-node-esm-bundle-v1",
        path: "entry.mjs",
        sha256: hash(initial),
        externalImports: [],
      },
    ],
  };
  const reference: InstalledPluginRelease = { root, manifestPath: "plugin-release.json", manifestSha256: "" };
  const repin = async () => {
    const bytes = JSON.stringify(manifest);
    await writeFile(join(root, reference.manifestPath), bytes);
    reference.manifestSha256 = hash(bytes);
  };
  const replace = async (replacement: string) => {
    await writeFile(join(root, "entry.mjs"), replacement);
    manifest.plugins[0]!.sha256 = hash(replacement);
    await repin();
  };
  await replace(initial);
  const config = parseOrcaConfig({
    plugins: ["./entry.mjs"],
    workflows: ["fixture.yaml"],
    templates: [],
    humanInput: { mode: "pause" },
  });
  const options = { config, configDir: root, logger: silentLogger, installedPluginRelease: reference };
  return { root, config, options, reference, manifest, repin, replace };
}

async function park(app: Awaited<ReturnType<typeof bootstrap>>) {
  const launch = await app.generations.captureLaunch({ purpose: "workflow", workflowId: "release-fixture" });
  const id = await launch.startRun({});
  expect((await app.orchestrator.run(id)).run.status).toBe("paused");
  return { id, generationId: launch.generationId, input: (await app.orchestrator.pendingInputs(id))[0]! };
}

async function finish(app: Awaited<ReturnType<typeof bootstrap>>, parked: Awaited<ReturnType<typeof park>>) {
  await app.orchestrator.answer(parked.input.id, "go", parked.id);
  expect((await app.orchestrator.resume(parked.id)).run.status).toBe("completed");
  const events = await app.orchestrator.stores.events.read(parked.id);
  const completed = events.find((event) => event.type === "step.completed" && event.payload.result.data.implementation);
  return completed?.type === "step.completed" ? completed.payload : undefined;
}

it("mounts frozen verified identity and restores admitted inputs while fresh admissions use current defaults", async () => {
  const data = await installation();
  vi.stubEnv("ORCA_RELEASE_FIXTURE_MODEL", "admitted");
  const first = await bootstrap(data.options);
  const parked = await park(first);
  const record = first.generations.current.snapshot.pluginRestoration![0]!;
  expect(record.identity.codeVersion).toBe(`sha256:${data.manifest.plugins[0]!.sha256}`);
  vi.stubEnv("ORCA_RELEASE_FIXTURE_MODEL", "current");
  const second = await bootstrap(data.options);
  expect((await finish(second, await park(second)))?.result.data.model).toBe("current");
  expect((await finish(second, parked))?.result.data.model).toBe("admitted");
  expect((await second.generations.restore(parked.generationId)).executors).not.toBe(second.orchestrator.executors);
  expect(second.generations.current.snapshot.pluginRestoration![0]!.data).toEqual({ model: "current" });
  const created = (await second.orchestrator.stores.events.read(parked.id)).find(
    (event) => event.type === "run.created",
  );
  expect(JSON.stringify(created)).not.toMatch(/restorationIdentity|pluginRestoration|dependencyIdentity/);
});

it("refuses bad evidence and simultaneous verifier policies before importing a plugin", async () => {
  const data = await installation('throw new Error("PLUGIN_IMPORTED");\n');
  await expect(
    bootstrap({ ...data.options, installedPluginRelease: { ...data.reference, manifestSha256: "0".repeat(64) } }),
  ).rejects.toMatchObject(refusal);
  const custom = vi.fn(() => true);
  await expect(bootstrap({ ...data.options, verifyPluginRestorationIdentity: custom })).rejects.toMatchObject(refusal);
  expect(custom).not.toHaveBeenCalled();
});

it("does not adopt stale cached code when a newly approved bundle replaces bytes at the same URL", async () => {
  const data = await installation();
  const first = await bootstrap(data.options);
  const historical = first.generations.current.snapshot.id;
  expect((await finish(first, await park(first)))?.result.data.implementation).toBe("v1");
  await data.replace(source.replace('const implementation = "v1"', 'const implementation = "v2"'));
  const second = await bootstrap(data.options);
  expect((await finish(second, await park(second)))?.result.data.implementation).toBe("v2");
  await expect(second.generations.restore(historical)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { pluginRestorationReason: "incompatible_identity" },
  });
});

it("keeps installations without an independent pin bootstrap-bound", async () => {
  const data = await installation();
  const options = { config: data.config, configDir: data.root, logger: silentLogger };
  const first = await bootstrap(options);
  const historical = first.generations.current.snapshot.id;
  expect(first.generations.current.snapshot.pluginRestoration).toBeUndefined();
  const second = await bootstrap(options);
  await expect(second.generations.restore(historical)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { pluginRestorationReason: "legacy_generation" },
  });
});

it("preserves generation-wide refusal for unsupported plan mutations despite valid release evidence", async () => {
  const data = await installation(
    source.replace("register(api) {", "register(api) { api.plan.listPlans = async () => [];"),
  );
  const first = await bootstrap(data.options);
  expect(first.generations.current.snapshot.pluginRestoration).toBeUndefined();
  const second = await bootstrap(data.options);
  await expect(second.generations.restore(first.generations.current.snapshot.id)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { pluginRestorationReason: "legacy_generation" },
  });
});

it("keeps mixed opted-in and legacy plugins non-restorable even when every bundle is attested", async () => {
  const data = await installation();
  const legacy = 'export default { name: "legacy", register() {} };\n';
  await writeFile(join(data.root, "legacy.mjs"), legacy);
  data.config.plugins.push("./legacy.mjs");
  data.manifest.plugins.push({
    spec: "./legacy.mjs",
    id: "legacy",
    schemaVersion: 1,
    closure: "closed-node-esm-bundle-v1",
    path: "legacy.mjs",
    sha256: hash(legacy),
    externalImports: [],
  });
  await data.repin();
  const first = await bootstrap(data.options);
  expect(first.generations.current.snapshot.pluginRestoration).toBeUndefined();
  const second = await bootstrap(data.options);
  await expect(second.generations.restore(first.generations.current.snapshot.id)).rejects.toMatchObject({
    code: "RUN_STATE",
    details: { pluginRestorationReason: "legacy_generation" },
  });
});

it("uses the real installed verifier across fresh Node processes without a provider or credential boundary", async () => {
  const data = await installation();
  const project = resolve(import.meta.dirname, "../../..");
  const worker = join(data.root, "worker.mjs");
  await writeFile(
    worker,
    `import { readFile, writeFile } from "node:fs/promises";
import { bootstrap } from ${JSON.stringify(pathToFileURL(resolve(project, "packages/cli/src/bootstrap.ts")).href)};
import { parseOrcaConfig, silentLogger } from ${JSON.stringify(pathToFileURL(resolve(project, "packages/core/src/index.ts")).href)};
const root = process.argv[2], mode = process.argv[3];
const installedPluginRelease = JSON.parse(await readFile(root + "/trusted-composition.json", "utf8"));
const config = parseOrcaConfig({ plugins: ["./entry.mjs"], workflows: ["fixture.yaml"], templates: [], humanInput: { mode: "pause" } });
const app = await bootstrap({ config, configDir: root, logger: silentLogger, installedPluginRelease });
if (mode === "admit") {
  const launch = await app.generations.captureLaunch({ purpose: "workflow", workflowId: "release-fixture" });
  const id = await launch.startRun({});
  const outcome = await app.orchestrator.run(id);
  const input = (await app.orchestrator.pendingInputs(id))[0];
  await writeFile(root + "/parked.json", JSON.stringify({ id, inputId: input.id }));
  process.stdout.write(JSON.stringify({ pid: process.pid, node: process.versions.node, status: outcome.run.status }));
} else {
  const parked = JSON.parse(await readFile(root + "/parked.json", "utf8"));
  await app.orchestrator.answer(parked.inputId, "go", parked.id);
  const outcome = await app.orchestrator.resume(parked.id);
  const events = await app.orchestrator.stores.events.read(parked.id);
  const effect = events.find(event => event.type === "step.completed" && event.payload.result.data.model);
  process.stdout.write(JSON.stringify({ pid: process.pid, node: process.versions.node, status: outcome.run.status, model: effect.payload.result.data.model, currentModel: app.generations.current.snapshot.pluginRestoration[0].data.model }));
}
`,
  );
  // This owned fixture file represents trusted composition injection, never a production ambient trust source.
  await writeFile(join(data.root, "trusted-composition.json"), JSON.stringify(data.reference));
  const run = async (mode: string, model: string) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", worker, data.root, mode], {
      cwd: project,
      env: { PATH: process.env.PATH ?? "", ORCA_RELEASE_FIXTURE_MODEL: model },
      timeout: 25_000,
      maxBuffer: 16_384,
    });
    return JSON.parse(stdout) as { pid: number; node: string; status: string; model?: string; currentModel?: string };
  };
  const first = await run("admit", "admitted");
  const fresh = await run("resume", "current");
  expect(first).toMatchObject({ status: "paused", node: process.versions.node });
  expect(fresh).toMatchObject({
    status: "completed",
    node: process.versions.node,
    model: "admitted",
    currentModel: "current",
  });
  expect(fresh.pid).not.toBe(first.pid);
  expect(await readFile(join(data.root, "entry.mjs"), "utf8")).toBe(source);
});
