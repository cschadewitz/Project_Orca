/** Renderer integration against the actual YAML lowerer and generation boundary, without host jobs. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseOrcaConfig } from "@orca/core";
import { InMemoryWorkflowVersionStore } from "@orca/store";
import type { ConfigSetParams, ConfigApplyParams } from "@orca/protocol";
import { ConfigurationGenerations, type GenerationSnapshot } from "../../engine/src/configuration-generation.js";
import { ConfigModel } from "../src/config-model.js";
import type { OrcaBridge, BridgeResult } from "../../app/src/bridge.js";
import { ConfigurationStudio } from "../../app/renderer/src/config/configuration-studio.js";
import {
  configurationPolicyChanged,
  safeConfigurationErrors,
  richShape,
} from "../../app/renderer/src/config/configuration-adapter.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function boundary<T>(command: () => Promise<T>): Promise<BridgeResult<T>> {
  try {
    return { ok: true, result: await command() };
  } catch (error) {
    return { ok: false, error: { code: (error as { code?: string }).code ?? "TRANSPORT", message: "Refused" } };
  }
}
async function fixture(text = "# retained source comment\nroles: {}\n") {
  const dir = await mkdtemp(join(tmpdir(), "orca-studio-"));
  dirs.push(dir);
  const records = new Map<string, GenerationSnapshot>();
  const generations = new ConfigurationGenerations({
    store: {
      getGeneration: async (id) => records.get(id),
      putGeneration: async (id, value) => {
        records.set(id, value);
      },
    },
    workflows: new InMemoryWorkflowVersionStore(),
    loadAssets: async () => ({ workflows: [], templates: [] }),
    admission: { validateStartRun: async () => {}, startRun: async () => "unused" },
  });
  await generations.initialize(parseOrcaConfig({}), "");
  if (text) await writeFile(join(dir, "orca.config.yaml"), text);
  const model = new ConfigModel({ configDir: dir, generations });
  let epoch = 1;
  const target = { workspaceId: "workspace", instanceId: "daemon", epoch };
  const sets: ConfigSetParams[] = [],
    applies: ConfigApplyParams[] = [];
  let changed = 0;
  // Only these bridge ports are used by the orchestration class; no renderer/main test double logic.
  const bridge = {
    daemonConnection: {
      read: () => ({ identity: { workspaceId: target.workspaceId, instanceId: target.instanceId }, epoch }),
    },
    connection: { read: () => ({ state: "live", methods: ["config.get", "config.set", "config.apply"] }) },
    config: {
      get: () => boundary(() => model.get()),
      set: (params: ConfigSetParams) => {
        sets.push(params);
        return boundary(() => model.set(params));
      },
      apply: (params: ConfigApplyParams) => {
        applies.push(params);
        return boundary(() => model.apply(params));
      },
    },
  } as unknown as OrcaBridge;
  const data = await model.get();
  const studio = new ConfigurationStudio(data, target, bridge, () => changed++);
  return {
    dir,
    model,
    bridge,
    data,
    studio,
    sets,
    applies,
    changed: () => changed,
    changeTarget: () => {
      epoch++;
      studio.freezeTarget();
    },
  };
}

describe("the wired structured editor and daemon boundary", () => {
  it("reviews exact comment-preserving bytes, saves pending source, and applies only explicitly", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    await f.studio.validate();
    expect(f.studio.state.phase).toBe("reviewed");
    const candidate = f.studio.privateCandidate!;
    expect(candidate).toContain("# retained source comment");
    expect(f.studio.review?.changes).toEqual([{ path: ["humanInput"], kind: "added", valueDisplay: "withheld" }]);
    expect((await f.model.get()).config.text).toBe(f.data.config.text);
    expect(f.applies).toHaveLength(0);
    await f.studio.save();
    expect(f.studio.state.phase).toBe("saved");
    expect(await readFile(join(f.dir, "orca.config.yaml"), "utf8")).toBe(candidate);
    expect(f.sets.at(-1)).toMatchObject({ text: candidate, expectedRevision: f.data.config.revision });
    expect(f.sets.at(-1)?.edits).toBeUndefined();
    expect(f.studio.source.generation?.state).toBe("pending");
    await f.studio.apply();
    expect(f.studio.state.phase).toBe("active");
    expect(f.applies).toEqual([
      { expectedRevision: f.studio.source.config.revision, expectedGeneration: f.data.generation!.activeGeneration },
    ]);
    expect(f.studio.source.generation?.state).toBe("active");
    expect(f.changed()).toBe(2);
  });
  it("creates host, agent and role containers from a missing file and reports the required restart", async () => {
    const f = await fixture("");
    f.studio.edit([
      { kind: "set", path: ["hosts"], value: [] },
      { kind: "insert", path: ["hosts"], index: 0, value: { id: "local", type: "local" } },
      { kind: "set", path: ["agents"], value: [] },
      {
        kind: "insert",
        path: ["agents"],
        index: 0,
        value: { id: "worker", host: "local", command: "test-command", roles: ["developer"] },
      },
      { kind: "set", path: ["roles"], value: {} },
      { kind: "set", path: ["roles", "developer"], value: "worker" },
    ]);
    await f.studio.validate();
    expect(f.studio.state.phase).toBe("reviewed");
    expect(f.studio.privateCandidate).toContain("test-command");
    expect(f.studio.privateCandidate).not.toContain("storeDir:");
    await f.studio.save();
    expect(f.studio.state.phase).toBe("saved");
    expect(f.applies).toHaveLength(0);
    await f.studio.apply();
    expect(f.studio.state.applyOutcome).toBe("restart-required");
    expect(f.studio.state.phase).toBe("saved");
    expect(f.studio.source.generation?.restartRequired).toContain("agents");
  });
  it("does not expose an unsupported root removal as an executable form action", async () => {
    const f = await fixture();
    expect(f.studio.editAccess([{ kind: "remove", path: [] }]).allowed).toBe(false);
    f.studio.edit([{ kind: "remove", path: [] }]);
    expect(f.studio.dirty).toBe(false);
    expect(f.sets).toHaveLength(0);
  });
  it("retains edits made after an explicit discard-and-read began", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    const original = f.bridge.config.get;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.bridge.config.get = async () => {
      await wait;
      return original();
    };
    const reading = f.studio.readCurrent(true);
    expect(f.studio.busy).toBe(true);
    f.studio.edit([{ kind: "set", path: ["program"], value: {} }]);
    release();
    await reading;
    expect(f.studio.state.edits).toHaveLength(2);
    expect(f.studio.frozen).toBe(true);
    expect(f.studio.busy).toBe(false);
  });
  it("does not replay retained indices on a changed source, even after a reread", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    await writeFile(join(f.dir, "orca.config.yaml"), "# external\nroles: {}\n");
    await f.studio.validate();
    expect(f.studio.frozen).toBe(true);
    const retained = f.studio.state.edits;
    const base = f.studio.source.config.revision;
    await f.studio.readCurrent();
    expect(f.studio.state.edits).toEqual(retained);
    expect(f.studio.source.config.revision).toBe(base);
    await f.studio.save();
    expect(f.sets.filter((p) => !p.validateOnly)).toHaveLength(0);
    await f.studio.readCurrent(true);
    expect(f.studio.frozen).toBe(false);
    expect(f.studio.dirty).toBe(false);
    expect(f.studio.source.config.text).toContain("# external");
  });
  it("retains a newer edit when an earlier reviewed save lands", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    await f.studio.validate();
    const original = f.bridge.config.set;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.bridge.config.set = async (params) => {
      await wait;
      return original(params);
    };
    const pending = f.studio.save();
    f.studio.edit([{ kind: "set", path: ["program"], value: {} }]);
    release();
    await pending;
    expect(f.studio.state.phase).toBe("blocked");
    expect(f.studio.frozen).toBe(true);
    expect(f.studio.state.edits).toHaveLength(2);
    expect(f.studio.value).toMatchObject({ program: {} });
    expect((await f.model.get()).config.parsed).not.toHaveProperty("program");
    expect(f.applies).toHaveLength(0);
  });
  it("stops a second RPC and retains the original target when target changes during lowering", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    const original = f.bridge.config.set;
    f.bridge.config.set = async (params) => {
      const result = await original(params);
      f.changeTarget();
      return result;
    };
    await f.studio.validate();
    expect(f.sets).toHaveLength(1);
    expect(f.studio.state.phase).toBe("blocked");
    expect(f.studio.dirty).toBe(true);
    await f.studio.save();
    expect(f.sets).toHaveLength(1);
  });
  it("allows the existing target boundary to replace a clean editor without a discard prompt", async () => {
    const f = await fixture();
    f.changeTarget();
    expect(f.studio.frozen).toBe(true);
    expect(f.studio.reason("validate")).toContain("previous daemon target");
    expect(f.studio.retained).toBe(false);
  });
  it("rejects a false activation receipt before changing shared generation status", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    await f.studio.validate();
    await f.studio.save();
    const pending = structuredClone(f.studio.source.generation!);
    f.bridge.config.apply = async () => ({
      ok: true,
      result: {
        outcome: "applied",
        status: { ...pending, state: "active", activeRevision: "wrong-revision" },
        validation: { errors: [] },
      },
    });
    await f.studio.apply();
    expect(f.studio.state.phase).toBe("blocked");
    expect(f.studio.frozen).toBe(true);
    expect(f.studio.source.generation).toEqual(pending);
  });
  it("keeps restart-required apply honest and requires a fresh read before another attempt", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["storeDir"], value: "another-store" }]);
    await f.studio.validate();
    await f.studio.save();
    await f.studio.apply();
    expect(f.studio.state.phase).toBe("saved");
    expect(f.studio.state.applyOutcome).toBe("restart-required");
    expect(f.studio.source.generation?.state).toBe("restart-required");
    expect(f.studio.source.generation?.activeGeneration).toBe(f.data.generation?.activeGeneration);
    await f.studio.apply();
    expect(f.applies).toHaveLength(1);
  });
  it("rejects a non-active receipt for an unrelated saved revision", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["storeDir"], value: "another-store" }]);
    await f.studio.validate();
    await f.studio.save();
    const saved = structuredClone(f.studio.source.generation!);
    f.bridge.config.apply = async () => ({
      ok: true,
      result: {
        outcome: "restart-required",
        status: { ...saved, savedRevision: "unrelated" },
        validation: { errors: [] },
      },
    });
    await f.studio.apply();
    expect(f.studio.state.phase).toBe("blocked");
    expect(f.studio.source.generation).toEqual(saved);
  });
  it("freezes an unacknowledged write even when the reviewed bytes reached disk", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    await f.studio.validate();
    const original = f.bridge.config.set;
    f.bridge.config.set = async (params) => {
      await original(params);
      throw new Error("Lost response");
    };
    await f.studio.save();
    expect(f.studio.state.phase).toBe("blocked");
    expect(f.studio.frozen).toBe(true);
    expect(f.studio.dirty).toBe(true);
    expect((await f.model.get()).config.parsed).toMatchObject({ humanInput: { mode: "pause" } });
    await f.studio.validate();
    await f.studio.save();
    expect(f.sets.filter((p) => !p.validateOnly)).toHaveLength(1);
    await f.studio.readCurrent();
    expect(f.studio.dirty).toBe(true);
    await f.studio.readCurrent(true);
    expect(f.studio.dirty).toBe(false);
    expect(f.studio.source.generation?.state).toBe("pending");
    expect(f.applies).toHaveLength(0);
  });
  it("freezes a CONFIG_STALE refusal from the second, exact-byte validation", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    const original = f.bridge.config.set;
    let count = 0;
    f.bridge.config.set = async (params) =>
      ++count === 1 ? original(params) : { ok: false, error: { code: "CONFIG_STALE", message: "Changed" } };
    await f.studio.validate();
    expect(f.studio.frozen).toBe(true);
    expect(f.studio.state.phase).toBe("blocked");
    expect(f.studio.review).toBeUndefined();
    f.studio.edit([{ kind: "set", path: ["program"], value: {} }]);
    expect(f.studio.state.edits).toHaveLength(1);
    await f.studio.save();
    expect(f.sets.filter((p) => !p.validateOnly)).toHaveLength(0);
  });
  it("invalidates raw review on newer text and does not remain busy after target replacement", async () => {
    const f = await fixture();
    f.studio.switchMode("raw");
    f.studio.editRaw("# raw first\nroles: {}\n");
    await f.studio.validate();
    expect(f.studio.review).toBeDefined();
    f.studio.editRaw("# raw newer\nroles: {}\n");
    expect(f.studio.review).toBeUndefined();
    await f.studio.save(true);
    expect(f.sets.filter((p) => !p.validateOnly)).toHaveLength(0);
    const original = f.bridge.config.set;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.bridge.config.set = async (params) => {
      await wait;
      return original(params);
    };
    const validating = f.studio.validate();
    f.changeTarget();
    expect(f.studio.busy).toBe(false);
    release();
    await validating;
    expect(f.studio.state.phase).toBe("blocked");
    expect(f.studio.raw).toContain("raw newer");
  });
  it("denies Apply when an observed active generation changes after Save", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    await f.studio.validate();
    await f.studio.save();
    const current = await f.model.get();
    f.studio.observe(
      { ...current, generation: { ...current.generation!, activeGeneration: "external-generation" } },
      f.studio.target,
    );
    expect(f.studio.reason("apply")).toContain("generation changed");
    await f.studio.apply();
    expect(f.applies).toHaveLength(0);
  });
  it("keeps raw replacement explicit and requires the exact permission-policy confirmation", async () => {
    const f = await fixture();
    f.studio.edit([{ kind: "set", path: ["humanInput"], value: { mode: "pause" } }]);
    expect(f.studio.switchMode("raw")).toBe(false);
    expect(f.studio.dirty).toBe(true);
    expect(f.studio.switchMode("raw", true)).toBe(true);
    const raw =
      "# private policy\nagents:\n  - id: local\n    command: test-command\n    permissions:\n      default: deny\n      rules: []\n";
    f.studio.editRaw(raw);
    await f.studio.validate();
    expect(f.studio.state.phase).toBe("reviewed");
    expect(f.studio.policyChange()).toBe(true);
    await f.studio.save();
    expect(f.sets.filter((p) => !p.validateOnly)).toHaveLength(0);
    await f.studio.save(true);
    expect(f.studio.state.phase).toBe("saved");
    expect((await f.model.get()).config.text).toBe(raw);
  });
  it("moves transient row identity with rows and nested collections, independently of domain IDs", async () => {
    const f = await fixture(
      "agents:\n  - id: a\n    command: test-command\n    roles: [one]\n  - id: b\n    command: test-command\n    roles: [two]\n",
    );
    const a = f.studio.rowKey(["agents"], 0),
      b = f.studio.rowKey(["agents"], 1);
    const nested = f.studio.rowKey(["agents", 0, "roles"], 0);
    f.studio.edit([
      { kind: "set", path: ["agents", 0, "id"], value: "changed" },
      { kind: "move", path: ["agents"], from: 0, to: 1 },
    ]);
    expect(f.studio.rowKey(["agents"], 0)).toBe(b);
    expect(f.studio.rowKey(["agents"], 1)).toBe(a);
    expect(f.studio.rowKey(["agents", 1, "roles"], 0)).toBe(nested);
  });
  it("keeps authority refusals and missing metadata unavailable while preserving raw access", async () => {
    const f = await fixture();
    f.bridge.connection.read = () => ({ state: "live", since: "now", methods: ["config.get"] });
    f.studio.edit([{ kind: "set", path: ["roles"], value: {} }]);
    expect(f.studio.dirty).toBe(false);
    expect(f.studio.reason("validate")).toContain("config.set");
    const g = await fixture();
    const { formSchema: _omitted, ...legacy } = g.data;
    const studio = new ConfigurationStudio(legacy, g.studio.target, g.bridge, () => {});
    expect(studio.shape).toBeUndefined();
    expect(studio.reason("validate")).toContain("metadata");
    expect(studio.switchMode("raw")).toBe(true);
    studio.editRaw("# raw remains explicit\nroles: {}\n");
    await studio.validate();
    await studio.save();
    expect(studio.state.phase).toBe("saved");
    expect(g.applies).toHaveLength(0);
  });
  it("does not drop validation failures hidden by metadata, and recognizes ancestor policy removal", async () => {
    const f = await fixture("agents:\n  - id: a\n    command: test-command\n    env: {TOKEN: private}\n");
    const errors = safeConfigurationErrors(
      richShape(f.data),
      [f.data.config.parsed],
      [
        { path: "agents.0.env.TOKEN", message: "private invalid value" },
        { path: "agents.0.command", message: "private invalid value" },
        { path: "unknown.private", message: "private invalid value" },
      ],
    );
    expect(errors.map((e) => e.path)).toEqual([[], ["agents", 0, "command"], []]);
    expect(JSON.stringify(errors)).not.toContain("private");
    expect(errors).toHaveLength(3);
    expect(configurationPolicyChanged({ agents: [{ id: "a", permissions: { default: "deny", rules: [] } }] }, {})).toBe(
      true,
    );
    expect(configurationPolicyChanged({}, { agents: [{ id: "a", command: "x" }] })).toBe(false);
  });
});
