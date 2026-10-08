/** #394 contract boundaries and production bootstrap recovery, with synthetic executors only. */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { builtinExecutors, type PluginRestorationData, type PluginRestorationIdentityVerifier } from "@orca/engine";
import { bootstrap } from "../src/bootstrap.js";
import {
  capturePluginRestoration,
  restorePluginExecutors,
  type LoadedRestorationPlugin,
} from "../src/plugin-runtime.js";

const dirs: string[] = [];
// Scripted trusted-composition boundary; these tests do not claim installed release verification.
const verifyIdentity: PluginRestorationIdentityVerifier = () => true;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "orca-plugin-contract-"));
  dirs.push(dir);
  return dir;
}
async function plugin(data: unknown = { model: "admitted" }): Promise<LoadedRestorationPlugin> {
  const path = join(await directory(), "entry.mjs");
  const source = "// synthetic immutable implementation\n";
  await writeFile(path, source);
  return {
    spec: "./entry.mjs",
    entry: { url: pathToFileURL(path).href, digest: createHash("sha256").update(source).digest("hex") },
    executors: ["custom:fixture"],
    plugin: {
      name: "fixture",
      register: () => {},
      restoration: {
        identity: { id: "fixture", schemaVersion: 1, codeVersion: "implementation-v1", dependencyIdentity: "deps-v1" },
        capture: () => data as PluginRestorationData,
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          Object.keys(value).join() === "model" &&
          typeof Reflect.get(value, "model") === "string",
        restore: (value, api) => {
          api.executors.register({
            type: "custom:fixture",
            execute: async () => ({ kind: "completed", result: { artifactIds: [], data: { model: value.model } } }),
          });
        },
      },
    },
  };
}

it("creates isolated executors from recorded data without capture, register, or executing providers", async () => {
  const loaded = await plugin();
  const records = await capturePluginRestoration([loaded], false, verifyIdentity);
  const capture = vi.spyOn(loaded.plugin.restoration!, "capture");
  const register = vi.spyOn(loaded.plugin, "register");
  const active = builtinExecutors();
  const candidate = await restorePluginExecutors(records, [loaded], verifyIdentity);
  expect(candidate.get("custom:fixture")).toBeDefined();
  expect(active.get("custom:fixture")).toBeUndefined();
  expect(capture).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(() => candidate.register({ type: "custom:later", execute: vi.fn() })).toThrow("unsupported_registration");
});

it.each(["schemaVersion", "codeVersion", "dependencyIdentity", "id"] as const)(
  "refuses a changed %s before any factory runs",
  async (field) => {
    const loaded = await plugin();
    const records = await capturePluginRestoration([loaded], false, verifyIdentity);
    const restore = vi.spyOn(loaded.plugin.restoration!, "restore");
    const identity = loaded.plugin.restoration!.identity;
    if (field === "schemaVersion") identity.schemaVersion = 2;
    else identity[field] = "changed";
    await expect(restorePluginExecutors(records, [loaded], verifyIdentity)).rejects.toMatchObject({
      code: "RUN_STATE",
      details: { pluginRestorationReason: "incompatible_identity" },
    });
    expect(restore).not.toHaveBeenCalled();
  },
);

it("checks all identities and entry bytes before reconstruction and refuses unavailable plugins", async () => {
  const first = await plugin();
  const second = await plugin();
  second.spec = "./second.mjs";
  second.executors = ["custom:second"];
  second.plugin.restoration!.identity.id = "second";
  const records = await capturePluginRestoration([first, second], false, verifyIdentity);
  const restore = vi.spyOn(first.plugin.restoration!, "restore");
  await writeFile(new URL(second.entry!.url), "changed\n");
  await expect(restorePluginExecutors(records, [first, second], verifyIdentity)).rejects.toThrow(
    "incompatible_identity",
  );
  expect(restore).not.toHaveBeenCalled();
  await expect(restorePluginExecutors(records, [first], verifyIdentity)).rejects.toThrow("unavailable_plugin");
});

it("refuses duplicate identities, malformed versions/data, accessors, closures, and unbounded descriptors", async () => {
  const loaded = await plugin();
  await expect(capturePluginRestoration([loaded, loaded], false, verifyIdentity)).rejects.toThrow("invalid_descriptor");
  for (const data of [
    { model: "okay", apiKey: "credential-canary" },
    { model: () => "closure" },
    { model: "x".repeat(65537) },
    {
      get model() {
        throw Error("credential-canary accessor must never run");
      },
    },
  ]) {
    loaded.plugin.restoration!.capture = () => data;
    await expect(capturePluginRestoration([loaded], false, verifyIdentity)).rejects.toThrow("invalid_descriptor");
  }
  await expect(restorePluginExecutors([{ contractVersion: 2 }], [loaded])).rejects.toThrow("invalid_descriptor");
});

it("does not claim unsupported callbacks or mixed legacy composition can restore", async () => {
  const loaded = await plugin();
  expect(await capturePluginRestoration([loaded], true, verifyIdentity)).toBeUndefined();
  const legacy = await plugin();
  delete legacy.plugin.restoration;
  expect(await capturePluginRestoration([loaded, legacy], false, verifyIdentity)).toBeUndefined();
});

it("keeps unverified declarations bootstrap-bound and never treats identity equality as verification", async () => {
  const loaded = await plugin();
  expect(await capturePluginRestoration([loaded], false)).toBeUndefined();
  await expect(capturePluginRestoration([loaded], false, () => false)).rejects.toThrow("identity_unverified");
  const records = await capturePluginRestoration([loaded], false, verifyIdentity);
  const restore = vi.spyOn(loaded.plugin.restoration!, "restore");
  await expect(restorePluginExecutors(records, [loaded])).rejects.toThrow("identity_unverified");
  await expect(restorePluginExecutors(records, [loaded], () => false)).rejects.toThrow("identity_unverified");
  expect(restore).not.toHaveBeenCalled();
});

it("discards a partial candidate and sanitizes factory errors without changing active registrations", async () => {
  const loaded = await plugin();
  const records = await capturePluginRestoration([loaded], false, verifyIdentity);
  const active = builtinExecutors();
  loaded.plugin.restoration!.restore = (_, api) => {
    api.executors.register({ type: "custom:fixture", execute: vi.fn() });
    throw Error("credential-canary");
  };
  await expect(restorePluginExecutors(records, [loaded], verifyIdentity)).rejects.toThrow("reconstruction_failed");
  expect(active.get("custom:fixture")).toBeUndefined();
  loaded.plugin.restoration!.restore = () => {};
  await expect(restorePluginExecutors(records, [loaded], verifyIdentity)).rejects.toThrow("reconstruction_failed");
});

const source = `let admitted;
const executor = (model) => ({ type: "custom:fixture", execute: async () => ({
  kind: "completed", result: { artifactIds: [], data: { model } }
}) });
export default {
  name: "fixture",
  register(api) { admitted = process.env.ORCA_FIXTURE_MODEL; api.executors.register(executor(admitted)); },
  restoration: {
    identity: { id: "fixture", schemaVersion: 1, codeVersion: "fixture-v1", dependencyIdentity: "no-dependencies-v1" },
    capture() { return { model: admitted }; },
    validate(data) { return data && Object.keys(data).join() === "model" && typeof data.model === "string"; },
    restore(data, api) { api.executors.register(executor(data.model)); }
  }
};`;
const workflow = `id: fixture
name: Fixture
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: Go?, options: [go] }
  custom: { type: custom:fixture }
  done: { type: end }
edges:
  - { from: s, to: gate }
  - { from: gate, to: custom }
  - { from: custom, to: done }
`;
it("resumes through the real bootstrap with admitted inputs in a fresh instance while new admissions adopt current defaults", async () => {
  const dir = await directory();
  await writeFile(join(dir, "entry.mjs"), source);
  await writeFile(join(dir, "fixture.yaml"), workflow);
  const config = parseOrcaConfig({
    plugins: ["./entry.mjs"],
    workflows: ["fixture.yaml"],
    templates: [],
    humanInput: { mode: "pause" },
  });
  const options = { config, configDir: dir, logger: silentLogger, verifyPluginRestorationIdentity: verifyIdentity };
  vi.stubEnv("ORCA_FIXTURE_MODEL", "admitted");
  const first = await bootstrap(options);
  const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "fixture" });
  const id = await launch.startRun({});
  expect((await first.orchestrator.run(id)).run.status).toBe("paused");
  const input = (await first.orchestrator.pendingInputs(id))[0]!;
  vi.stubEnv("ORCA_FIXTURE_MODEL", "current");
  const second = await bootstrap(options);
  expect(second.generations.current.snapshot.pluginRestoration?.[0]?.data).toEqual({ model: "current" });
  const fresh = await (
    await second.generations.captureLaunch({ purpose: "workflow", workflowId: "fixture" })
  ).startRun({});
  expect((await second.orchestrator.run(fresh)).run.status).toBe("paused");
  await second.orchestrator.answer((await second.orchestrator.pendingInputs(fresh))[0]!.id, "go", fresh);
  expect((await second.orchestrator.resume(fresh)).run.status).toBe("completed");
  expect(
    (await second.orchestrator.stores.events.read(fresh)).find(
      (event) => event.type === "step.completed" && event.payload.result.data.model === "current",
    ),
  ).toBeDefined();
  await second.orchestrator.answer(input.id, "go", id);
  expect((await second.orchestrator.resume(id)).run.status).toBe("completed");
  const events = await second.orchestrator.stores.events.read(id);
  expect(
    events.find((event) => event.type === "step.completed" && event.payload.result.data.model === "admitted"),
  ).toBeDefined();
  const historical = await second.generations.restore(launch.generationId);
  expect(historical.executors).not.toBe(second.orchestrator.executors);
  expect(second.generations.current.snapshot.pluginRestoration?.[0]?.data).toEqual({ model: "current" });
  // Plugin inputs stay in protected generations; public provenance remains allowlisted.
  const created = events.find((event) => event.type === "run.created");
  expect(JSON.stringify(created)).not.toMatch(/pluginRestoration|dependencyIdentity|fixture-v1/);
});

it.each(["historical", "current"])(
  "refuses %s unsupported callbacks even when all plugins declare restoration",
  async (mode) => {
    const dir = await directory();
    const registration = `if (process.env.ORCA_FIXTURE_UNSUPPORTED === "yes") {
    api.agents.host("local").fs.readTextFile = async () => "unrecorded ambient callback";
  }`;
    await writeFile(join(dir, "entry.mjs"), source.replace("register(api) {", `register(api) { ${registration}`));
    await writeFile(join(dir, "fixture.yaml"), workflow);
    const config = parseOrcaConfig({ plugins: ["./entry.mjs"], workflows: ["fixture.yaml"], templates: [] });
    const options = { config, configDir: dir, logger: silentLogger, verifyPluginRestorationIdentity: verifyIdentity };
    vi.stubEnv("ORCA_FIXTURE_MODEL", "admitted");
    vi.stubEnv("ORCA_FIXTURE_UNSUPPORTED", mode === "historical" ? "yes" : "no");
    const first = await bootstrap(options);
    const historical = first.generations.current.snapshot.id;
    expect(Boolean(first.generations.current.snapshot.pluginRestoration)).toBe(mode !== "historical");
    vi.stubEnv("ORCA_FIXTURE_UNSUPPORTED", mode === "current" ? "yes" : "no");
    const second = await bootstrap(options);
    await expect(second.generations.restore(historical)).rejects.toMatchObject({
      code: "RUN_STATE",
      details: {
        pluginRestorationReason: mode === "historical" ? "legacy_generation" : "unsupported_registration",
      },
    });
  },
);

it("refuses a missing descriptor instead of adopting current custom executors", async () => {
  const dir = await directory();
  await writeFile(join(dir, "entry.mjs"), source);
  await writeFile(join(dir, "fixture.yaml"), workflow);
  const config = parseOrcaConfig({ plugins: ["./entry.mjs"], workflows: ["fixture.yaml"], templates: [] });
  vi.stubEnv("ORCA_FIXTURE_MODEL", "admitted");
  const first = await bootstrap({
    config,
    configDir: dir,
    logger: silentLogger,
    verifyPluginRestorationIdentity: verifyIdentity,
  });
  const snapshot = structuredClone(first.generations.current.snapshot);
  delete snapshot.pluginRestoration;
  const second = await bootstrap({
    config,
    configDir: dir,
    logger: silentLogger,
    verifyPluginRestorationIdentity: verifyIdentity,
  });
  vi.spyOn(second.orchestrator.stores.execution, "getGeneration").mockResolvedValue(snapshot);
  await expect(second.generations.restore(snapshot.id)).rejects.toThrow("legacy_generation");
});
