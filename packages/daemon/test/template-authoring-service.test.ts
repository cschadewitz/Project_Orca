/** Bounded local authoring regressions; no daemon socket, credentials or agent process. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "@orca/core";
import { ConfigModel } from "../src/config-model.js";
import { TemplateAuthoringService } from "../src/template-authoring.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const target = { workspaceId: "workspace", instanceId: "instance" };
const generation = "11111111-1111-4111-8111-111111111111";
const nextGeneration = "22222222-2222-4222-8222-222222222222";
const authorize = async () => {};

async function fixture(afterApply?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "orca-template-authoring-service-"));
  dirs.push(dir);
  await mkdir(join(dir, "templates"));
  await writeFile(join(dir, "orca.config.yaml"), "templates: ['templates/**/*.md']\nworkflows: []\n");
  const source = "---\nid: sdlc/review\n---\nReviewed instruction\n";
  await writeFile(join(dir, "templates", "review.md"), source);
  const config = new ConfigModel({ configDir: dir });
  let activeGeneration = generation;
  const readConfig = async () => {
    const view = await config.get();
    return {
      ...view,
      generation: {
        savedRevision: view.config.revision,
        activeRevision: view.config.revision,
        activeGeneration,
        state: "active" as const,
        restartRequired: [],
      },
    };
  };
  const service = new TemplateAuthoringService({
    baseDir: dir,
    readConfig,
    exclusive: async (command) => command(),
    changed: async () => {},
    applyLocked: async (_params, recheck) => {
      await recheck();
      activeGeneration = nextGeneration;
      // An editor outside the ORCA writer lock can change disk immediately after activation.
      await afterApply?.(dir);
      return { outcome: "applied", status: (await readConfig()).generation, validation: { errors: [] } };
    },
  });
  return { dir, source, service };
}

describe("bounded template authoring service", () => {
  it("refuses whitespace-only declared IDs before review or Save", async () => {
    const f = await fixture();
    const text = "---\nid: '   '\n---\nRejected instruction\n";
    await writeFile(join(f.dir, "templates", "review.md"), text);
    const catalog = await f.service.read(target, authorize);
    expect(catalog.errors.map((error) => error.code)).toEqual(["missing-id"]);
    const source = catalog.assets[0]!;
    const candidate = {
      target,
      key: source.key,
      expectedSourceRevision: source.revision,
      expectedCatalogRevision: catalog.catalogRevision,
      expectedConfigGeneration: catalog.generation,
      draftSequence: 1,
      text,
    };
    const review = await f.service.validate(candidate, authorize);
    expect(review.errors.map((error) => error.code)).toEqual(["missing-id"]);
    await expect(f.service.save(candidate, review.candidateRevision, authorize)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(await readFile(join(f.dir, "templates", "review.md"), "utf8")).toBe(text);
  });

  it("attributes activation history to reviewed source rather than a later disk replacement", async () => {
    const f = await fixture(async (dir) => {
      await writeFile(join(dir, "templates", "review.md"), "---\nid: sdlc/review\n---\nLater disk instruction\n");
    });
    const catalog = await f.service.read(target, authorize);
    await f.service.publish(
      {
        target,
        expectedCatalogRevision: catalog.catalogRevision,
        expectedConfigRevision: catalog.configRevision,
        expectedConfigGeneration: catalog.generation,
      },
      authorize,
    );
    const key = catalog.assets[0]!.key;
    const history = await f.service.history(key, target, authorize);
    expect(history.entries).toEqual([
      { at: expect.any(String), revision: sha256(f.source), generation: nextGeneration },
    ]);
    const current = await f.service.read(target, authorize);
    expect(current.assets[0]!.revision).not.toBe(history.entries[0]!.revision);
    expect(await readFile(join(f.dir, ".orca-template-history.json"), "utf8")).not.toContain("instruction");
  });

  it("reports exact-ID template partial consumers alongside catalog use sites", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "templates", "review.md"), f.source + "{{> partials/context}}\n");
    await writeFile(join(f.dir, "templates", "context.md"), "---\nid: partials/context\n---\nContext\n");
    await writeFile(
      join(f.dir, "templates", "strict-context.md"),
      "---\nid: strict/partials/context\n---\nStrict context\n",
    );
    const catalog = await f.service.read(target, authorize);
    expect(catalog.errors).toEqual([]);
    expect(catalog.assets.find((asset) => asset.id === "partials/context")?.usedBy).toEqual(["template:sdlc/review"]);
    expect(catalog.assets.find((asset) => asset.id === "strict/partials/context")?.usedBy).toEqual([]);
  });

  it("does not attribute inline prompts to malformed template sources", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "orca.config.yaml"), "templates: ['templates/**/*.md']\nworkflows: [workflow.yaml]\n");
    await writeFile(join(f.dir, "templates", "review.md"), "---\nname: Missing ID\n---\nMalformed instruction\n");
    await writeFile(
      join(f.dir, "workflow.yaml"),
      "id: inline\nname: Inline\nversion: '1'\nstart: start\nnodes:\n  start: {type: start}\n  review: {type: agent, agent: synthetic, prompt: Inline instruction}\n  end: {type: end}\nedges:\n  - {from: start, to: review}\n  - {from: review, to: end}\n",
    );
    const catalog = await f.service.read(target, authorize);
    expect(catalog.errors).toHaveLength(1);
    expect(catalog.assignments.some((assignment) => assignment.templateId === undefined)).toBe(true);
    expect(catalog.assets[0]!.usedBy).toEqual([]);
  });
});
