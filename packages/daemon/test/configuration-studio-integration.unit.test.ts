/** Renderer integration against the actual YAML lowerer and generation boundary, without host jobs. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
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
