import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { OrcaConfigSchema } from "@orca/core";
import type { ConfigSetParams } from "@orca/protocol";
import { configReferenceErrors } from "../src/config-references.js";
import { ConfigModel } from "../src/config-model.js";

it("reports each actual remaining host/agent reference without rewriting consumers", () => {
  const config = OrcaConfigSchema.parse({
    hosts: [{ id: "local", type: "local" }],
    agents: [{ id: "builder", command: "example", hostId: "removed", defaultModel: "missing", models: [] }],
    roles: { reviewer: "removed-agent" },
  });
  expect(configReferenceErrors(config).map((e) => e.path)).toEqual(["agents[0].hostId", "roles.reviewer"]);
  expect(config.agents[0]?.hostId).toBe("removed");
});

it.each([{ models: undefined }, { models: [] }, { models: [{ id: "configured-only", name: "Configured model" }] }])(
  "does not treat configured model declarations as the session's authoritative inventory (%j)",
  ({ models }) => {
    const config = OrcaConfigSchema.parse({
      agents: [{ id: "builder", command: "example", defaultModel: "session-model", ...(models ? { models } : {}) }],
    });
    expect(configReferenceErrors(config)).toEqual([]);
  },
);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it.each(["text", "patch", "edits"] as const)(
  "validates and saves a session-discovered default model through %s without inventing declarations",
  async (representation) => {
    const dir = await mkdtemp(join(tmpdir(), "orca-model-reference-"));
    dirs.push(dir);
    const file = join(dir, "orca.config.yaml");
    const base = "agents:\n  - id: builder\n    command: example\n";
    await writeFile(file, base, "utf8");
    const model = new ConfigModel({ configDir: dir, configFile: file });
    const changes: Pick<ConfigSetParams, "text" | "patch" | "edits"> =
      representation === "text"
        ? { text: base + "    defaultModel: session-model\n" }
        : representation === "patch"
          ? { patch: [{ path: "agents[0].defaultModel", value: "session-model" }] }
          : { edits: [{ kind: "set", path: ["agents", 0, "defaultModel"], value: "session-model" }] };
    const params = { document: "config" as const, expectedRevision: (await model.get()).config.revision, ...changes };
    const expected = { agents: [{ id: "builder", command: "example", defaultModel: "session-model" }] };
    const preview = await model.set({ ...params, validateOnly: true });
    expect(preview.validation?.errors).toEqual([]);
    expect(preview.document.parsed).toEqual(expected);
    expect(await readFile(file, "utf8")).toBe(base);
    expect((await model.set(params)).written).toBe(true);
    expect(parse(await readFile(file, "utf8"))).toEqual(expected);
  },
);
it("valid explicit host/agent/role bindings retain omitted defaults", () => {
  const raw = {
    hosts: [{ id: "local", type: "local" }],
    agents: [{ id: "builder", command: "example" }],
    roles: { builder: "builder" },
  };
  expect(configReferenceErrors(OrcaConfigSchema.parse(raw))).toEqual([]);
  expect(raw.agents[0]).not.toHaveProperty("models");
});
