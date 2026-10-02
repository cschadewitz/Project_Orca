import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseOrcaConfig } from "@orca/core";
import { InMemoryWorkflowVersionStore } from "@orca/store";
import { ConfigurationGenerations, type GenerationSnapshot } from "../../engine/src/configuration-generation.js";
import { ConfigModel } from "../src/config-model.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-generation-"));
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
  return { dir, generations, model: new ConfigModel({ configDir: dir, generations }) };
}
describe("config generation file boundary", () => {
  it("saving is pending, validating does not activate, and apply publishes a distinct activation", async () => {
    const { model } = await fixture();
    const events: unknown[] = [];
    model.onChange((change) => events.push(change));
    const read = await model.get();
    const save = await model.set({ document: "config", expectedRevision: "", text: "# saved\nroles: {}\n" });
    expect(save.generation?.state).toBe("pending");
    const params = { expectedRevision: save.document.revision, expectedGeneration: read.generation!.activeGeneration };
    expect((await model.apply({ ...params, validateOnly: true })).outcome).toBe("validated");
    expect(events).toHaveLength(1);
    expect((await model.apply(params)).outcome).toBe("applied");
    expect(events).toMatchObject([{ kind: "saved" }, { kind: "activated" }]);
    expect((await model.get()).generation?.state).toBe("active");
    expect((await model.get()).config.text).toBe("# saved\nroles: {}\n");
  });
  it("applies an empty YAML document as schema defaults", async () => {
    const { model } = await fixture();
    const generation = (await model.get()).generation!.activeGeneration;
    const saved = await model.set({ document: "config", expectedRevision: "", text: "# only a comment\n" });
    expect(
      (await model.apply({ expectedRevision: saved.document.revision, expectedGeneration: generation })).outcome,
    ).toBe("applied");
  });
  it("serializes concurrent saves and refuses stale saved/active guards", async () => {
    const { model, generations } = await fixture();
    const id = generations.current.snapshot.id;
    const writes = await Promise.allSettled(
      ["roles: {}", "program: {}"].map((text) => model.set({ document: "config", expectedRevision: "", text })),
    );
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(model.apply({ expectedRevision: "", expectedGeneration: id })).rejects.toMatchObject({
      code: "CONFIG_STALE",
    });
    const saved = await model.get();
    await expect(
      model.apply({ expectedRevision: saved.config.revision, expectedGeneration: "old" }),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
  });
  it("external edits are observed on read and manual apply refuses invalid/restart-required candidates", async () => {
    const { model, dir, generations } = await fixture();
    const id = generations.current.snapshot.id;
    await writeFile(join(dir, "orca.config.yaml"), "storeDir: another");
    let saved = await model.get();
    expect(saved.generation?.state).toBe("restart-required");
    expect((await model.apply({ expectedRevision: saved.config.revision, expectedGeneration: id })).outcome).toBe(
      "restart-required",
    );
    await writeFile(join(dir, "orca.config.yaml"), "secret: [invalid yaml");
    saved = await model.get();
    expect(saved.generation?.state).toBe("invalid");
    expect((await model.apply({ expectedRevision: saved.config.revision, expectedGeneration: id })).outcome).toBe(
      "invalid",
    );
    expect(generations.current.snapshot.id).toBe(id);
  });
});
