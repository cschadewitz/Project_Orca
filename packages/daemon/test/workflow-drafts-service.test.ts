/**
 * Workflow drafts (#180) over real files: ownership, revision fencing, comment-preserving
 * semantic edits, the validation the editor's panel shows, undo, and reviewed publication.
 * No daemon socket, credentials or agent process - the service, a config directory and a
 * stand-in for generation activation.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigModel } from "../src/config-model.js";
import { nextWorkflowVersion, WorkflowDraftService, type DraftCaller } from "../src/workflow-drafts.js";
import { parse } from "yaml";
import { DraftOperationSchema, type ConfigApplyResult, type DraftOperation } from "@orca/protocol";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const TINY = `# A tiny workflow for the draft tests.
id: tiny
name: Tiny
version: "1"
start: start
nodes:
  start: { type: start }

  # The one step.
  work:
    type: set
    vars: { done: true }

  done: { type: end }
edges:
  - { from: start, to: work }
  - { from: work, to: done }
`;

const caller = (principalId: string): DraftCaller => ({ principalId, read: async () => {}, write: async () => {} });
const casey = caller("casey");
const robin = caller("robin");

async function fixture(options: { activation?: "applied" | "invalid"; generation?: false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orca-workflow-drafts-"));
  dirs.push(dir);
  await mkdir(join(dir, "workflows"));
  await writeFile(join(dir, "orca.config.yaml"), "workflows: ['workflows/*.yaml']\ntemplates: []\n");
  const file = join(dir, "workflows", "tiny.yaml");
  await writeFile(file, TINY);
  const config = new ConfigModel({ configDir: dir });
  const readConfig = async () => {
    const view = await config.get();
    return {
      ...view,
      generation: {
        savedRevision: view.config.revision,
        activeRevision: view.config.revision,
        activeGeneration: "11111111-1111-4111-8111-111111111111",
        state: "active" as const,
        restartRequired: [],
      },
    };
  };
  const applied: string[] = [];
  const service = new WorkflowDraftService({
    baseDir: dir,
    readConfig,
    exclusive: async (command) => command(),
    validationContext: () => (options.generation === false ? undefined : {}),
    applyLocked: async (_params, recheck): Promise<ConfigApplyResult> => {
      await recheck();
      applied.push(await readFile(file, "utf8"));
      const status = (await readConfig()).generation;
      return options.activation === "invalid"
        ? { outcome: "invalid", status, validation: { errors: [{ path: "workflows.tiny", message: "refused" }] } }
        : { outcome: "applied", status, validation: { errors: [] } };
    },
  });
  return { dir, file, service, applied };
}

describe("opening a draft", () => {
  it("copies the workflow into .drafts and leaves the workflow alone", async () => {
    const f = await fixture();
    const draft = await f.service.open("tiny", casey);
    expect(draft).toMatchObject({ workflowId: "tiny", revision: 0, owner: { principalId: "casey", you: true } });
    expect(draft.text).toBe(TINY);
    expect(draft.dirty).toBe(false);
    expect(draft.publishBlocked).toBe("Nothing has changed yet.");
    expect(await readFile(f.file, "utf8")).toBe(TINY);
    expect((await readdir(join(f.dir, "workflows", ".drafts"))).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("returns the same draft on a second open, and somebody else's read-only", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    await f.service.apply({ workflowId: "tiny", expectedRevision: 0, ops: [{ op: "setStart", id: "start" }] }, casey);
    const again = await f.service.open("tiny", casey);
    expect(again.owner.you).toBe(true);

    const theirs = await f.service.open("tiny", robin);
    expect(theirs.owner).toEqual({ principalId: "casey", you: false });
    expect(theirs.canUndo).toBe(false);
    expect(theirs.publishBlocked).toMatch(/Only the person who opened/);
    await expect(
      f.service.apply({ workflowId: "tiny", expectedRevision: theirs.revision, ops: [{ op: "tidy" }] }, robin),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("reports a workflow it cannot find, and get says when there is no draft", async () => {
    const f = await fixture();
    await expect(f.service.open("missing", casey)).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
    expect(await f.service.get("tiny", casey)).toMatchObject({ draft: null, editable: true, layout: { graphs: {} } });
  });
});

describe("editing", () => {
  it("refuses an edit made against an older revision", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    await f.service.apply(
      { workflowId: "tiny", expectedRevision: 0, ops: [{ op: "addNode", id: "extra", node: { type: "end" } }] },
      casey,
    );
    await expect(
      f.service.apply({ workflowId: "tiny", expectedRevision: 0, ops: [{ op: "removeNode", id: "extra" }] }, casey),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
  });

  it("renames through edges and start, keeping every comment", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const view = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [
          { op: "renameNode", id: "work", to: "build" },
          { op: "renameNode", id: "start", to: "begin" },
        ],
      },
      casey,
    );
    expect(view.text).toBe(
      TINY.replace("  work:", "  build:")
        .replace("to: work }", "to: build }")
        .replace("from: work,", "from: build,")
        .replace("start: start", "start: begin")
        .replace("  start: { type: start }", "  begin: { type: start }")
        .replace("from: start,", "from: begin,"),
    );
    expect(view.issues).toEqual([]);
  });

  it("drops a node onto an edge as two edges in the file's own style", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const view = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [{ op: "insertNode", id: "check", edge: 1, node: { type: "set", vars: { checked: true } } }],
      },
      casey,
    );
    expect(view.text).toContain("  - { from: work, to: check }\n  - { from: check, to: done }\n");
    expect(view.text).toMatch(/\n\n {2}check:\n {4}type: set\n/);
    expect(view.issues).toEqual([]);
  });

  it("leaves a removed node's edges dangling for validation to name, unless asked to detach them", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const kept = await f.service.apply(
      { workflowId: "tiny", expectedRevision: 0, ops: [{ op: "removeNode", id: "work" }] },
      casey,
    );
    const errors = kept.issues.filter((issue) => issue.severity === "error");
    expect(errors.map((issue) => issue.edge)).toEqual(expect.arrayContaining([0, 1]));
    expect(kept.publishBlocked).toMatch(/validation errors? to fix/);

    const undone = await f.service.undo({ workflowId: "tiny", expectedRevision: kept.revision }, casey);
    expect(undone.text).toBe(TINY);
    const detached = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: undone.revision,
        ops: [
          { op: "removeNode", id: "work", detach: true },
          { op: "addEdge", from: "start", to: "done" },
        ],
      },
      casey,
    );
    expect(detached.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(detached.text).not.toMatch(/\bwork\b/);
  });

  it("flags an unconnected node as an error and a type change's leftover fields as a warning", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const view = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [
          { op: "addNode", id: "orphan", node: { type: "end" } },
          { op: "changeType", id: "work", type: "end" },
        ],
      },
      casey,
    );
    expect(view.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          node: "orphan",
          message: "node 'orphan' is unreachable from start",
        }),
        expect.objectContaining({ severity: "warning", node: "work", path: "nodes.work.vars" }),
      ]),
    );
  });

  it("never calls a draft clean when there is no active configuration to check it against (#182)", async () => {
    const f = await fixture({ generation: false });
    await f.service.open("tiny", casey);
    const view = await f.service.apply(
      { workflowId: "tiny", expectedRevision: 0, ops: [{ op: "setWorkflow", name: "Renamed" }] },
      casey,
    );
    expect(view.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        graph: [],
        message: expect.stringMatching(/no active configuration/),
      }),
    ]);
    expect(view.issues[0]).not.toHaveProperty("node");
    expect(view.publishBlocked).toBe("1 validation error to fix before publishing.");
  });

  it("sets and removes the workflow's capability scope, keeping the rest of the file (#335)", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const scoped = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [{ op: "setWorkflow", capabilities: { skills: { disable: ["review"] } } }],
      },
      casey,
    );
    expect(parse(scoped.text)).toMatchObject({ capabilities: { skills: { disable: ["review"] } } });
    expect(scoped.text).toContain("# The one step.");
    const cleared = await f.service.apply(
      { workflowId: "tiny", expectedRevision: scoped.revision, ops: [{ op: "setWorkflow", capabilities: null }] },
      casey,
    );
    expect(cleared.text).toBe(TINY);
    const emptied = await f.service.apply(
      { workflowId: "tiny", expectedRevision: cleared.revision, ops: [{ op: "setWorkflow", capabilities: {} }] },
      casey,
    );
    expect(parse(emptied.text)).not.toHaveProperty("capabilities");
    // An explicit empty replace clears what the workflow inherits, so it is written as is.
    const clearing = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: emptied.revision,
        ops: [{ op: "setWorkflow", capabilities: { mcpServers: { replace: [] } } }],
      },
      casey,
    );
    expect(parse(clearing.text)).toMatchObject({ capabilities: { mcpServers: { replace: [] } } });
    // Shape is checked at the wire: an unknown selection verb is refused, not written.
    expect(
      DraftOperationSchema.safeParse({ op: "setWorkflow", capabilities: { skills: { available: ["x"] } } }).success,
    ).toBe(false);
  });

  it("edits a capability scope node by node, keeping comments and anchors beside the change (#335)", async () => {
    const f = await fixture();
    const scoped = TINY.replace(
      'version: "1"\n',
      `version: "1"
capabilities:
  # Shared with the step below.
  mcpServers: &servers
    enable: [github] # the tracker
  skills:
    disable:
      - review # too slow here
`,
    ).replace(
      "    vars: { done: true }\n",
      `    vars: { done: true }
    capabilities:
      mcpServers: *servers
      skills:
        # Only these.
        replace: [lint]
`,
    );
    await writeFile(f.file, scoped);
    await f.service.open("tiny", casey);
    // Workflow scope: an unrelated skills edit keeps every comment and the anchor.
    const workflow = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [
          {
            op: "setWorkflow",
            capabilities: { mcpServers: { enable: ["github"] }, skills: { disable: ["review", "deploy"] } },
          },
        ],
      },
      casey,
    );
    for (const kept of ["# Shared with the step below.", "&servers", "# the tracker", "# too slow here", "*servers"])
      expect(workflow.text).toContain(kept);
    expect(parse(workflow.text)).toMatchObject({ capabilities: { skills: { disable: ["review", "deploy"] } } });
    // Node scope: the alias stays an alias and the comment beside the change survives.
    const node = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: workflow.revision,
        ops: [
          {
            op: "updateNode",
            id: "work",
            set: { capabilities: { mcpServers: { enable: ["github"] }, skills: { replace: ["lint", "format"] } } },
          },
        ],
      },
      casey,
    );
    expect(node.text).toContain("mcpServers: *servers");
    expect(node.text).toContain("# Only these.");
    expect(node.text).toContain("&servers");
    expect(parse(node.text).nodes.work.capabilities.skills).toEqual({ replace: ["lint", "format"] });
    // Changing the shared value from either side is refused with a way forward, not written.
    await expect(
      f.service.apply(
        {
          workflowId: "tiny",
          expectedRevision: node.revision,
          ops: [{ op: "updateNode", id: "work", set: { capabilities: { mcpServers: { enable: ["jira"] } } } }],
        },
        casey,
      ),
    ).rejects.toThrow(/anchor or alias.*Edit the workflow's YAML/);
    await expect(
      f.service.apply(
        {
          workflowId: "tiny",
          expectedRevision: node.revision,
          ops: [{ op: "setWorkflow", capabilities: { skills: { disable: ["review"] } } }],
        },
        casey,
      ),
    ).rejects.toThrow(/anchor or alias/);
    await expect(
      f.service.apply(
        { workflowId: "tiny", expectedRevision: node.revision, ops: [{ op: "setWorkflow", capabilities: null }] },
        casey,
      ),
    ).rejects.toThrow(/anchor or alias/);
  });

  it("refuses a capability edit whose step is shared with another step through an anchor (#335)", async () => {
    const f = await fixture();
    const shared = TINY.replace(
      "  work:\n    type: set\n    vars: { done: true }\n",
      `  work: &step
    type: set
    vars: { done: true }
    capabilities:
      skills: { disable: [review] }
  twin: *step
`,
    ).replace("  - { from: work, to: done }\n", "  - { from: work, to: twin }\n  - { from: twin, to: done }\n");
    await writeFile(f.file, shared);
    const opened = await f.service.open("tiny", casey);
    expect(opened.text).toBe(shared);
    for (const op of [
      { op: "updateNode", id: "work", set: { capabilities: { skills: { disable: ["review", "deploy"] } } } },
      { op: "updateNode", id: "work", unset: ["capabilities"] },
    ] satisfies DraftOperation[])
      await expect(f.service.apply({ workflowId: "tiny", expectedRevision: 0, ops: [op] }, casey)).rejects.toThrow(
        /anchor or alias shared with another part.*Edit the workflow's YAML/,
      );
    // The twin's scope is untouched, and an edit that changes nothing is still accepted.
    const same = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [{ op: "updateNode", id: "work", set: { capabilities: { skills: { disable: ["review"] } } } }],
      },
      casey,
    );
    expect(parse(same.text)).toEqual(parse(shared));
    expect(same.text).toContain("work: &step");
    expect(same.text).toContain("twin: *step");
    expect(parse(same.text).nodes.twin.capabilities).toEqual({ skills: { disable: ["review"] } });
  });

  it("keeps a drag in the layout and out of the workflow text", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const placed = await f.service.apply(
      { workflowId: "tiny", expectedRevision: 0, ops: [{ op: "place", id: "work", x: 310.4, y: 96 }] },
      casey,
    );
    expect(placed.text).toBe(TINY);
    expect(placed.layout).toEqual({ graphs: { "": { work: { x: 310, y: 96 } } } });
    expect(placed.dirty).toBe(true);
    const tidied = await f.service.apply(
      { workflowId: "tiny", expectedRevision: placed.revision, ops: [{ op: "tidy" }] },
      casey,
    );
    expect(tidied.layout).toEqual({ graphs: {} });
    expect(tidied.dirty).toBe(false);
  });

  it("undoes and redoes whole batches, and survives the service being recreated", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const edited = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [
          { op: "setWorkflow", name: "Tiny, renamed" },
          { op: "updateNode", id: "work", set: { name: "Do the work" } },
        ],
      },
      casey,
    );
    const undone = await f.service.undo({ workflowId: "tiny", expectedRevision: edited.revision }, casey);
    expect(undone.text).toBe(TINY);
    expect(undone.canRedo).toBe(true);
    const reopened = await (await fixtureLike(f)).get("tiny", casey);
    const redone = await f.service.redo({ workflowId: "tiny", expectedRevision: reopened.draft!.revision }, casey);
    expect(redone.text).toBe(edited.text);
  });
});

describe("publishing", () => {
  it("writes the reviewed bytes with the next version, files the layout, and drops the draft", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const edited = await f.service.apply(
      {
        workflowId: "tiny",
        expectedRevision: 0,
        ops: [
          { op: "renameNode", id: "work", to: "build" },
          { op: "place", id: "build", x: 200, y: 40 },
        ],
      },
      casey,
    );
    const review = await f.service.review({ workflowId: "tiny", expectedRevision: edited.revision }, casey);
    expect(review).toMatchObject({ baseVersion: "1", nextVersion: "2", baseText: TINY });
    // A publish is byte-identical to the same change made by hand (#180's "done when").
    const byHand = TINY.replace('version: "1"', 'version: "2"')
      .replace("  work:", "  build:")
      .replace("to: work }", "to: build }")
      .replace("from: work,", "from: build,");
    expect(review.text).toBe(byHand);

    const published = await f.service.publish(
      { workflowId: "tiny", expectedRevision: edited.revision, reviewToken: review.reviewToken },
      casey,
    );
    expect(published).toMatchObject({ workflowId: "tiny", version: "2", apply: { outcome: "applied" } });
    expect(await readFile(f.file, "utf8")).toBe(byHand);
    expect(f.applied).toEqual([byHand]);
    expect(JSON.parse(await readFile(join(f.dir, "workflows", ".layout", "tiny.json"), "utf8"))).toEqual({
      v: 1,
      workflowId: "tiny",
      graphs: { "": { build: { x: 200, y: 40 } } },
    });
    const after = await f.service.get("tiny", casey);
    expect(after.draft).toBeNull();
    expect(after.layout).toEqual({ graphs: { "": { build: { x: 200, y: 40 } } } });
  });

  it("refuses a publish whose review is out of date, or whose workflow changed underneath it", async () => {
    const f = await fixture();
    await f.service.open("tiny", casey);
    const edited = await f.service.apply(
      { workflowId: "tiny", expectedRevision: 0, ops: [{ op: "updateNode", id: "work", set: { name: "Work" } }] },
      casey,
    );
    const review = await f.service.review({ workflowId: "tiny", expectedRevision: edited.revision }, casey);
    await expect(
      f.service.publish({ workflowId: "tiny", expectedRevision: edited.revision, reviewToken: "not-it" }, casey),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });

    await writeFile(f.file, TINY.replace("# The one step.", "# Edited by hand."));
    await expect(
      f.service.publish(
        { workflowId: "tiny", expectedRevision: edited.revision, reviewToken: review.reviewToken },
        casey,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
    expect((await f.service.get("tiny", casey)).draft?.base.current).toBe(false);
  });

  it("restores the workflow when activation refuses it", async () => {
    const f = await fixture({ activation: "invalid" });
    await f.service.open("tiny", casey);
    const edited = await f.service.apply(
      { workflowId: "tiny", expectedRevision: 0, ops: [{ op: "updateNode", id: "work", set: { name: "Work" } }] },
      casey,
    );
    const review = await f.service.review({ workflowId: "tiny", expectedRevision: edited.revision }, casey);
    await expect(
      f.service.publish(
        { workflowId: "tiny", expectedRevision: edited.revision, reviewToken: review.reviewToken },
        casey,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(f.file, "utf8")).toBe(TINY);
    expect((await f.service.get("tiny", casey)).draft?.revision).toBe(edited.revision);
  });

  it("discards only on the owner's say, at the revision they saw", async () => {
    const f = await fixture();
    const draft = await f.service.open("tiny", casey);
    await expect(f.service.discard({ workflowId: "tiny", expectedRevision: 0 }, robin)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await f.service.discard({ workflowId: "tiny", expectedRevision: draft.revision }, casey);
    expect((await f.service.get("tiny", casey)).draft).toBeNull();
    expect(await readFile(f.file, "utf8")).toBe(TINY);
  });
});

describe("nextWorkflowVersion", () => {
  it("counts the trailing number up, or starts one", () => {
    expect(nextWorkflowVersion("1")).toBe("2");
    expect(nextWorkflowVersion("1.9")).toBe("1.10");
    expect(nextWorkflowVersion("v3")).toBe("v4");
    expect(nextWorkflowVersion("beta")).toBe("beta.1");
  });
});

/** A second service over the same directory: what a daemon restart sees. */
async function fixtureLike(f: { dir: string }): Promise<WorkflowDraftService> {
  const config = new ConfigModel({ configDir: f.dir });
  return new WorkflowDraftService({
    baseDir: f.dir,
    readConfig: async () => {
      const view = await config.get();
      return {
        ...view,
        generation: {
          savedRevision: view.config.revision,
          activeRevision: view.config.revision,
          activeGeneration: "11111111-1111-4111-8111-111111111111",
          state: "active" as const,
          restartRequired: [],
        },
      };
    },
    exclusive: async (command) => command(),
    validationContext: () => ({}),
    applyLocked: async () => {
      throw new Error("not in this test");
    },
  });
}

describe("the method table", () => {
  it("answers reads on a read-only daemon and every draft write only when it is writable", async () => {
    const { methodsFor } = await import("../src/methods.js");
    const base = {
      orcaVersion: "0.0.0",
      capabilities: [],
      identity: { workspaceId: "w", instanceId: "i" },
      config: { canApply: true } as never,
    };
    const readOnly = Object.keys(methodsFor(base)).filter((name) => name.startsWith("workflowDrafts."));
    expect(readOnly).toEqual(["workflowDrafts.get"]);
    const writable = Object.keys(methodsFor({ ...base, control: {} as never })).filter((name) =>
      name.startsWith("workflowDrafts."),
    );
    expect(writable.sort()).toEqual(
      [
        "workflowDrafts.apply",
        "workflowDrafts.discard",
        "workflowDrafts.dryRun",
        "workflowDrafts.get",
        "workflowDrafts.open",
        "workflowDrafts.publish",
        "workflowDrafts.redo",
        "workflowDrafts.review",
        "workflowDrafts.undo",
      ].sort(),
    );
  });
});
