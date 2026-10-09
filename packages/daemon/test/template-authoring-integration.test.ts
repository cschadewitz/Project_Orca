/** Production authoring contracts over a disposable authenticated daemon and the actual renderer adapter. */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadTemplates, loadWorkflows, parseOrcaConfig, sha256 } from "@orca/core";
import { InMemoryWorkflowVersionStore } from "@orca/store";
import { TemplateCatalogSchema, TemplateAssignmentResultSchema, type TemplateSourceCandidate } from "@orca/protocol";
import { ConfigurationGenerations, type GenerationSnapshot } from "../../engine/src/configuration-generation.js";
import { launchProvenance } from "../../engine/src/configuration-provenance.js";
import { ConfigModel } from "../src/config-model.js";
import { ControlModel, ReadModel, startDaemon } from "@orca/daemon";
import { CredentialStore, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";
import { emptyFixture } from "./fixture.js";
import { DaemonClient } from "../../app/src/client/daemon-client.js";
import { callTemplate } from "../../app/src/client/template-client.js";
import { TemplateAdapter } from "../../app/renderer/src/template-authoring/adapter.js";
import { TemplateAuthoringController } from "../../app/renderer/src/template-authoring/controller.js";
import type { OrcaBridge } from "../../app/src/bridge.js";
import type { TemplateBridge } from "../../app/src/template-bridge.js";
const dirs: string[] = [],
  stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
const authorize = async () => {};
const flow = `# Workflow comment\nid: review-work\nname: Review work\nversion: '1'\nstart: start\nnodes:\n  start: {type: start}\n  review: {type: agent, agent: {role: reviewer}, template: sdlc/review}\n  end: {type: end}\nedges:\n  - {from: start, to: review}\n  - {from: review, to: end}\n`;
async function fixture(transport = false, readOnly = false) {
  const dir = await mkdtemp(join(tmpdir(), "orca-template-integration-"));
  dirs.push(dir);
  await mkdir(join(dir, "templates", "partials"), { recursive: true });
  await mkdir(join(dir, "workflows"));
  await cp(resolve("templates/sdlc/review.md"), join(dir, "templates", "review.md"));
  await cp(
    resolve("templates/partials/work-item-context.md"),
    join(dir, "templates", "partials", "work-item-context.md"),
  );
  await writeFile(join(dir, "workflows", "review.yaml"), flow);
  const configText =
    "# Config comment\nagents: [{id: worker, command: synthetic, roles: [reviewer], env: {API_TOKEN: configured-secret-canary}}]\nroles: {reviewer: worker}\n";
  await writeFile(join(dir, "orca.config.yaml"), configText);
  const config = parseOrcaConfig({
    agents: [
      { id: "worker", command: "synthetic", roles: ["reviewer"], env: { API_TOKEN: "configured-secret-canary" } },
    ],
    roles: { reviewer: "worker" },
  });
  const records = new Map<string, GenerationSnapshot>();
  const generations = new ConfigurationGenerations({
    store: {
      getGeneration: async (id) => records.get(id),
      putGeneration: async (id, value) => {
        records.set(id, value);
      },
    },
    workflows: new InMemoryWorkflowVersionStore(),
    loadAssets: async (config) => ({
      templates: (await loadTemplates(config.templates, dir)).list(),
      workflows: (await loadWorkflows(config.workflows, dir)).list(),
    }),
    admission: { validateStartRun: async () => {}, startRun: async () => "synthetic-run" },
  });
  await generations.initialize(config, sha256(configText));
  const model = new ConfigModel({ configDir: dir, generations });
  const catalog = await model.templates.read(target, authorize);
  const source = catalog.assets.find((asset) => asset.id === "sdlc/review")!;
  const sourceText = source.source.state === "available" ? source.source.text : "";
  const candidate = (text = sourceText + "\nExtra review instruction.\n"): TemplateSourceCandidate => ({
    target,
    key: source.key,
    expectedSourceRevision: source.revision,
    expectedCatalogRevision: catalog.catalogRevision,
    expectedConfigGeneration: catalog.generation,
    draftSequence: 1,
    text,
  });
  if (!transport) return { dir, model, generations, catalog, source, sourceText, candidate };
  const { orchestrator } = emptyFixture();
  const reads = new ReadModel({ orchestrator });
  const credentials = new CredentialStore();
  const owner = await credentials.issue({ principal: "owner", preset: "owner" });
  const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
  const daemon = await startDaemon({
    identity: target,
    config: model,
    reads,
    ...(readOnly ? {} : { control: new ControlModel({ orchestrator, reads }) }),
    orcaVersion: "test",
    capabilities: [],
    auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver: orchestratorResolver(orchestrator) },
  });
  stops.push(() => daemon.close());
  let token = owner.token;
  const client = new DaemonClient(daemon.url, fetch, { auth: { read: () => token, refresh: () => false } });
  const hello = await client.hello("template-integration");
  let epoch = 1;
  let methods = hello.methods;
  const bridge = {
    daemonConnection: { read: () => ({ identity: target, epoch }) },
    connection: { read: () => ({ state: "live", methods }) },
  } as unknown as OrcaBridge;
  const rpc = {
    call: async (method: string, params: unknown) => {
      try {
        return { ok: true, result: await callTemplate(client, method as never, params) };
      } catch (error) {
        return {
          ok: false,
          error: { code: (error as { error?: { code: string } }).error?.code ?? "TRANSPORT", message: "Refused" },
        };
      }
    },
  } as TemplateBridge;
  const adapter = new TemplateAdapter({ ...target, epoch }, bridge, rpc);
  return {
    dir,
    model,
    generations,
    catalog,
    source,
    sourceText,
    candidate,
    adapter,
    client,
    credentials,
    owner,
    viewer,
    bridge,
    rpc,
    setToken: (next: string) => {
      token = next;
    },
    setEpoch: () => {
      epoch++;
    },
    revokeMethods: () => {
      methods = ["hello"];
    },
  };
}

describe("production template authoring", () => {
  it("edits shipped review, derives a strict pack, previews fixtures, saves then explicitly Applies and assigns", async () => {
    const f = await fixture(true);
    const adapter = f.adapter!;
    const base = await adapter.read();
    const controller = new TemplateAuthoringController(base, adapter);
    const pinned = f.generations.current;
    controller.edit(f.source.key, f.sourceText + "\nReview {{workItem.title}}.\n");
    await controller.validate();
    expect(controller.getSnapshot().review?.errors).toEqual([]);
    await controller.publish();
    expect(controller.getSnapshot().edits).toEqual([]);
    expect(f.generations.current).toBe(pinned);
    await controller.createVariant(f.source.key, "strict");
    const variant = controller.getSnapshot().edits[0]!;
    expect(variant.text).toContain('id: "strict/sdlc/review"');
    controller.edit(variant.key, variant.text + "\nStrict instruction.\n");
    const fixtures = {
      values: { workItem: { title: "Synthetic request", acceptanceCriteria: [] } },
      artifacts: {
        spec: "Synthetic spec",
        implementation: "Synthetic implementation",
        "test-report": "Synthetic test report",
      },
    };
    await controller.preview("sdlc/review", "strict", fixtures);
    expect(controller.getSnapshot().preview).toMatchObject({ resolvedId: "strict/sdlc/review", fallback: false });
    expect(controller.getSnapshot().preview?.text).toContain("Synthetic spec");
    await controller.preview("sdlc/review", "missing", fixtures);
    expect(controller.getSnapshot().preview?.fallback).toBe(true);
    await controller.validate();
    await controller.publish();
    expect(controller.getSnapshot().blocked).toBeUndefined();
    await adapter.reviewPublication();
    expect(f.generations.current).toBe(pinned);
    await adapter.applyPublication();
    expect(f.generations.current).not.toBe(pinned);
    expect(pinned.templates.get("sdlc/review").body).not.toContain("Synthetic request");
    expect(pinned.templates.has("strict/sdlc/review")).toBe(false);
    const catalog = TemplateCatalogSchema.parse(await f.client!.call("templates.get", {}, TemplateCatalogSchema));
    const assignment = catalog.assignments[0]!;
    const command = {
      target,
      expectedCatalogRevision: catalog.catalogRevision,
      expectedConfigGeneration: catalog.generation,
      key: assignment.key,
      expectedSourceRevision: assignment.revision,
      templateId: "strict/sdlc/review",
      version: "2",
    };
    const reviewed = await f.client!.call(
      "templates.assign",
      { ...command, validateOnly: true },
      TemplateAssignmentResultSchema,
    );
    expect(reviewed.written).toBe(false);
    await f.client!.call(
      "templates.assign",
      { ...command, candidateRevision: reviewed.candidateRevision },
      TemplateAssignmentResultSchema,
    );
    expect(await readFile(join(f.dir, "workflows", "review.yaml"), "utf8")).toContain("# Workflow comment");
    await adapter.read();
    await adapter.reviewPublication();
    await adapter.applyPublication();
    const provenance = launchProvenance(
      f.generations.current,
      f.generations.current.workflows.get("review-work"),
      {},
      {},
    );
    expect(provenance.selections[0]!.template).toMatchObject({
      value: "strict/sdlc/review",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      partials: [{ id: "partials/work-item-context", revision: expect.any(String) }],
    });
    expect(JSON.stringify(provenance)).not.toContain("configured-secret-canary");
  });
  it("round-trips comments, unknown metadata and CRLF variant source without writing until Save", async () => {
    const f = await fixture();
    const text =
      "---\r\nid: sdlc/review # retain comment\r\nrequires: [spec]\r\ncustom: {nested: preserved}\r\n---\r\nBody unchanged\r\n";
    await writeFile(join(f.dir, "templates", "review.md"), text);
    const catalog = await f.model.templates.read(target, authorize);
    const source = catalog.assets.find((item) => item.id === "sdlc/review")!;
    const variant = await f.model.templates.variant(
      {
        target,
        key: source.key,
        expectedSourceRevision: source.revision,
        expectedCatalogRevision: catalog.catalogRevision,
        expectedConfigGeneration: catalog.generation,
        pack: "strict",
      },
      authorize,
    );
    expect(variant.text).toBe(text.replace("id: sdlc/review", 'id: "strict/sdlc/review"'));
    const current = await f.model.templates.read(target, authorize);
    expect(current.catalogRevision).toBe(catalog.catalogRevision);
    const candidate = {
      ...f.candidate(variant.text),
      key: variant.key,
      expectedSourceRevision: sha256(""),
      expectedCatalogRevision: catalog.catalogRevision,
    };
    const review = await f.model.templates.validate(candidate, authorize);
    await f.model.templates.save(candidate, review.candidateRevision, authorize);
    expect(await readFile(join(f.dir, "templates", "strict.review.md"), "utf8")).toBe(variant.text);
  });
  it.each(["missing-id", "duplicate-id", "missing-partial", "cyclic-partial", "broken-expression", "extra-context"])(
    "refuses %s and never saves rejected source",
    async (kind) => {
      const f = await fixture();
      const text =
        kind === "missing-id"
          ? "---\nname: Missing\n---\nBody"
          : kind === "duplicate-id"
            ? "---\nid: partials/work-item-context\n---\nBody"
            : kind === "missing-partial"
              ? f.sourceText + "{{> nonexistent}}"
              : kind === "cyclic-partial"
                ? f.sourceText + "{{> sdlc/review}}"
                : kind === "broken-expression"
                  ? f.sourceText + "{{ workItem..bad }}"
                  : f.sourceText
                      .replace("sdlc/review", "strict/sdlc/review")
                      .replace("[spec, implementation, test-report]", "[extra]");
      if (kind === "extra-context") await writeFile(join(f.dir, "templates", "base.md"), f.sourceText);
      const catalog = await f.model.templates.read(target, authorize);
      const candidate = { ...f.candidate(text), expectedCatalogRevision: catalog.catalogRevision };
      const review = await f.model.templates.validate(candidate, authorize);
      expect(review.errors.length).toBeGreaterThan(0);
      await expect(f.model.templates.save(candidate, review.candidateRevision, authorize)).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      expect(await readFile(join(f.dir, "templates", "review.md"), "utf8")).toBe(f.sourceText);
      expect(JSON.stringify(review)).not.toContain("Body");
    },
  );
  it("rejects stale catalog, changed candidate identity, source races and changed generation", async () => {
    const f = await fixture();
    const candidate = f.candidate();
    const review = await f.model.templates.validate(candidate, authorize);
    await expect(f.model.templates.save(candidate, "changed-review", authorize)).rejects.toMatchObject({
      code: "CONFIG_STALE",
    });
    await writeFile(join(f.dir, "templates", "review.md"), f.sourceText + "\nOther writer\n");
    await expect(f.model.templates.save(candidate, review.candidateRevision, authorize)).rejects.toMatchObject({
      code: "CONFIG_STALE",
    });
    expect(await readFile(join(f.dir, "templates", "review.md"), "utf8")).toContain("Other writer");
    await expect(
      f.model.templates.validate({ ...candidate, expectedConfigGeneration: "old-generation" }, authorize),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
  });
  it("serializes competing source saves with one winner and digest-only history", async () => {
    const f = await fixture();
    const candidate = f.candidate();
    const review = await f.model.templates.validate(candidate, authorize);
    const results = await Promise.allSettled([
      f.model.templates.save(candidate, review.candidateRevision, authorize),
      f.model.templates.save(candidate, review.candidateRevision, authorize),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const history = await f.model.templates.history(candidate.key, target, authorize);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.revision).toBe(sha256(candidate.text));
    expect(await readFile(join(f.dir, ".orca-template-history.json"), "utf8")).not.toContain(
      "Extra review instruction",
    );
  });
  it("rechecks current authority before committing and after preview", async () => {
    const f = await fixture();
    const candidate = f.candidate();
    const review = await f.model.templates.validate(candidate, authorize);
    let reads = 0;
    const revoked = async () => {
      if (++reads >= 2) throw Object.assign(new Error("Refused"), { code: "AUTH_FORBIDDEN" });
    };
    await expect(f.model.templates.save(candidate, review.candidateRevision, revoked)).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
    expect(await readFile(join(f.dir, "templates", "review.md"), "utf8")).toBe(f.sourceText);
    reads = 0;
    await expect(
      f.model.templates.preview(
        {
          target,
          expectedCatalogRevision: f.catalog.catalogRevision,
          expectedConfigGeneration: f.catalog.generation,
          id: "sdlc/review",
          fixtures: { values: {}, artifacts: {} },
        },
        revoked,
      ),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
  it("refuses arbitrary source keys, symlink traversal and variant filename collisions", async () => {
    const f = await fixture();
    await expect(
      f.model.templates.validate({ ...f.candidate(), key: "../../outside.md" }, authorize),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
    const collision = "---\nid: unrelated\n---\nRetain existing file\n";
    await writeFile(join(f.dir, "templates", "strict.review.md"), collision);
    const current = await f.model.templates.read(target, authorize);
    await expect(
      f.model.templates.variant(
        {
          target,
          key: f.source.key,
          expectedSourceRevision: f.source.revision,
          expectedCatalogRevision: current.catalogRevision,
          expectedConfigGeneration: current.generation,
          pack: "strict",
        },
        authorize,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("filename") });
    expect(await readFile(join(f.dir, "templates", "strict.review.md"), "utf8")).toBe(collision);
    await symlink(join(f.dir, "templates", "review.md"), join(f.dir, "templates", "link.md"));
    await expect(f.model.templates.read(target, authorize)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("preview never resolves environment or agents and redacts identifiable credentials", async () => {
    const f = await fixture();
    const candidate = f.candidate(
      f.sourceText + "\n{{ env.ORCA_TEMPLATE_TEST }} configured-secret-canary sk-abcdefghijklmnopqrstuvwxyz012345\n",
    );
    const result = await f.model.templates.preview(
      {
        candidate,
        target,
        expectedCatalogRevision: f.catalog.catalogRevision,
        expectedConfigGeneration: f.catalog.generation,
        id: "sdlc/review",
        fixtures: { values: {}, artifacts: {} },
      },
      authorize,
    );
    expect(result.text).not.toMatch(/configured-secret-canary|sk-abcdefghijklmnopqrstuvwxyz/);
    expect(result.text).toContain("[REDACTED]");
  });
  it("authenticated discovery withholds methods from viewers and read-only mode omits mutations", async () => {
    const f = await fixture(true, true);
    const hello = await f.client!.hello("test");
    expect(hello.methods).toContain("templates.get");
    expect(hello.methods).toContain("templates.preview");
    expect(hello.methods).not.toContain("templates.save");
    f.setToken!(f.viewer!.token);
    const viewer = await f.client!.hello("viewer");
    expect(viewer.methods).not.toContain("templates.get");
    await expect(
      f.client!.call("templates.get", { rejectedSecret: "secret-canary" }, TemplateCatalogSchema),
    ).rejects.toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
  });
  it("app adapter rejects target movement and retains unacknowledged source", async () => {
    const f = await fixture(true);
    const adapter = f.adapter!;
    const base = await adapter.read();
    const controller = new TemplateAuthoringController(base, adapter);
    controller.edit(f.source.key, f.sourceText + "\nDraft\n");
    await controller.validate();
    f.setEpoch!();
    await controller.publish();
    expect(controller.getSnapshot().blocked).toContain("lost");
    expect(controller.getSnapshot().edits).toHaveLength(1);
    expect(await readFile(join(f.dir, "templates", "review.md"), "utf8")).toBe(f.sourceText);
  });
  it("does not discard a draft on a false source Save acknowledgement", async () => {
    const f = await fixture(true);
    const rpc = {
      call: async (method: string, params: unknown) =>
        method === "templates.save"
          ? {
              ok: true,
              result: {
                status: "saved",
                candidateRevision: (params as { candidateRevision: string }).candidateRevision,
                snapshot: f.catalog,
              },
            }
          : f.rpc!.call(method as never, params as never),
    } as TemplateBridge;
    const adapter = new TemplateAdapter({ ...target, epoch: 1 }, f.bridge!, rpc);
    const controller = new TemplateAuthoringController(await adapter.read(), adapter);
    controller.edit(f.source.key, f.sourceText + "\nRetained after false receipt\n");
    await controller.validate();
    await controller.publish();
    expect(controller.getSnapshot().edits).toHaveLength(1);
    expect(controller.getSnapshot().blocked).toContain("lost");
    expect(await readFile(join(f.dir, "templates", "review.md"), "utf8")).toBe(f.sourceText);
  });
  it("keeps the newest catalog when read responses arrive out of order", async () => {
    const f = await fixture(true);
    let first: ((result: { ok: true; result: typeof f.catalog }) => void) | undefined;
    let calls = 0;
    const rpc = {
      call: () =>
        ++calls === 1
          ? new Promise<{ ok: true; result: typeof f.catalog }>((resolve) => {
              first = resolve;
            })
          : Promise.resolve({ ok: true, result: { ...f.catalog, catalogRevision: "newer-catalog" } }),
    } as TemplateBridge;
    const adapter = new TemplateAdapter({ ...target, epoch: 1 }, f.bridge!, rpc);
    const older = adapter.read().catch((error: unknown) => error);
    await adapter.read();
    first!({ ok: true, result: f.catalog });
    expect(await older).toBeInstanceOf(Error);
    expect(adapter.current?.catalogRevision).toBe("newer-catalog");
  });
  it.each(["output", "operations"])("bounds fixture %s and returns source-free errors", async (kind) => {
    const f = await fixture();
    const body =
      kind === "output"
        ? "{{#each items as item}}{{text}}{{/each}}"
        : "{{#each items as item}}{{#each items as inner}}{{/each}}{{/each}}";
    const candidate = f.candidate(`---\nid: sdlc/review\n---\n${body}`);
    const result = await f.model.templates
      .preview(
        {
          candidate,
          target,
          expectedCatalogRevision: f.catalog.catalogRevision,
          expectedConfigGeneration: f.catalog.generation,
          id: "sdlc/review",
          fixtures: {
            values: {
              items: Array(kind === "output" ? 20 : 400).fill(1),
              text: "configured-secret-canary".repeat(1000),
            },
            artifacts: {},
          },
        },
        authorize,
      )
      .catch((error: unknown) => error);
    expect(result).toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("Fixture preview refused"),
    });
    expect(String(result)).not.toContain("configured-secret-canary");
  });
  it("captures decision-agent instruction digests without substituting an agent role", async () => {
    const f = await fixture();
    const decision = flow.replace(
      "{type: agent, agent: {role: reviewer}, template: sdlc/review}",
      "{type: decision, source: {kind: agent, agent: {role: reviewer}, template: sdlc/review}, options: [ship]}",
    );
    await writeFile(join(f.dir, "workflows", "review.yaml"), decision);
    const current = await f.model.templates.read(target, authorize);
    expect(current.assignments[0]).toMatchObject({ templateId: "sdlc/review", nodeId: "review" });
    await f.model.templates.publish(
      {
        target,
        expectedCatalogRevision: current.catalogRevision,
        expectedConfigRevision: current.configRevision,
        expectedConfigGeneration: current.generation,
      },
      authorize,
    );
    const provenance = launchProvenance(
      f.generations.current,
      f.generations.current.workflows.get("review-work"),
      {},
      {},
    );
    expect(provenance.selections[0]).toMatchObject({
      role: "reviewer",
      agent: { value: "worker" },
      template: { value: "sdlc/review", revision: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });
});
