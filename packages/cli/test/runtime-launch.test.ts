/** CLI launch types and preflight identities survive every supported direct root launch boundary. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "@orca/core";
import { workflowRevision } from "@orca/engine";
import { bootstrap } from "../src/bootstrap.js";
import { commands, type CommandContext } from "../src/commands/index.js";
import { parseVars, workflowGuards } from "../src/commands/launch-options.js";
import { main } from "../src/main.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function ctx(cwd: string, positionals: string[], flags: CommandContext["flags"] = {}): CommandContext {
  return { cwd, positionals, flags: { quiet: true, ...flags }, out() {}, err() {} };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-runtime-launch-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "orca.config.yaml"),
    "workflows: [typed.yaml]\ntemplates: []\nprogram: { workflow: typed, itemWorkflow: typed }\n",
  );
  const definition = {
    id: "typed",
    name: "Typed",
    version: "1",
    start: "s",
    inputSchema: { fields: { count: { type: "integer", required: true }, name: { type: "string" } } },
    nodes: { s: { type: "start" }, done: { type: "end" } },
    edges: [{ from: "s", to: "done" }],
  };
  await writeFile(join(dir, "typed.yaml"), JSON.stringify(definition));
  const app = await bootstrap({ cwd: dir, logger: silentLogger });
  return { dir, app, definition, revision: workflowRevision(app.workflows.get("typed")) };
}

describe("launch flags", () => {
  it("preserves the historical --var JSON fallback, including explicit JSON strings", () => {
    expect(
      parseVars(["count=3", "enabled=true", 'text="3"', "word=plain", 'object={"x":1}', "nil=null", "empty="]),
    ).toEqual({ count: 3, enabled: true, text: "3", word: "plain", object: { x: 1 }, nil: null, empty: "" });
  });

  it("strict JSON flags retain types and explicitly override legacy flags", () => {
    expect(parseVars(["count=old"], ["count=2", "list=[1,false]", 'name="12"'])).toEqual({
      count: 2,
      list: [1, false],
      name: "12",
    });
    expect(() => parseVars([], ["password=do-not-print"])).toThrow("--var-json requires a valid JSON value");
    expect(() => parseVars([], ["password=do-not-print"])).not.toThrow("do-not-print");
    expect(() => parseVars(["=x"])).toThrow("non-empty key=value");
    expect(() => parseVars(["missing"])).toThrow("key=value");
  });

  it("treats prototype-like names as ordinary own values", () => {
    const vars = parseVars(['__proto__={"polluted":true}', "constructor=plain"]);
    expect(Object.getPrototypeOf(vars)).toBe(Object.prototype);
    expect(Object.hasOwn(vars, "__proto__")).toBe(true);
    expect(vars.constructor).toBe("plain");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("retains both guards and rejects empty ones", () => {
    expect(workflowGuards(ctx("", [], { "workflow-version": "1", "expected-workflow-revision": "digest" }))).toEqual({
      workflowVersion: "1",
      expectedWorkflowRevision: "digest",
    });
    expect(() => workflowGuards(ctx("", [], { "workflow-version": "" }))).toThrow("must not be empty");
    expect(() => workflowGuards(ctx("", [], { "expected-workflow-revision": "" }))).toThrow("must not be empty");
  });
});

describe("direct CLI admission", () => {
  it("parses typed flags from argv and starts exactly the preflight identity", async () => {
    const { dir, app, revision } = await fixture();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await main([
        "run",
        "typed",
        "--cwd",
        dir,
        "--quiet",
        "--var-json",
        "count=3",
        "--var-json",
        'name="3"',
        "--workflow-version",
        "1",
        "--expected-workflow-revision",
        revision,
      ]),
    ).toBe(0);
    const [id] = await app.orchestrator.listRuns();
    const state = await app.orchestrator.getState(id!);
    expect(state.run).toMatchObject({ workflowVersion: "1", vars: { count: 3, name: "3" } });
  });

  it("refuses stale revisions and unknown versions before a run exists", async () => {
    const { dir, app } = await fixture();
    await expect(
      commands.run!.run(ctx(dir, ["typed"], { "var-json": ["count=3"], "expected-workflow-revision": "stale" })),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
    await expect(
      commands.run!.run(ctx(dir, ["typed"], { "var-json": ["count=3"], "workflow-version": "missing" })),
    ).rejects.toMatchObject({ code: "WORKFLOW_VERSION_NOT_FOUND" });
    expect(await app.orchestrator.listRuns()).toEqual([]);
  });

  it("selects the persisted historical version rather than a newer on-disk definition", async () => {
    const { dir, app, definition, revision } = await fixture();
    expect(await commands.run!.run(ctx(dir, ["typed"], { "var-json": ["count=3"] }))).toBe(0);
    await writeFile(
      join(dir, "typed.yaml"),
      JSON.stringify({ ...definition, version: "2", vars: { newVersion: true } }),
    );
    expect(
      await commands.run!.run(
        ctx(dir, ["typed"], {
          "var-json": ["count=4"],
          "workflow-version": "1",
          "expected-workflow-revision": revision,
        }),
      ),
    ).toBe(0);
    const states = await Promise.all((await app.orchestrator.listRuns()).map((id) => app.orchestrator.getState(id)));
    const pinned = states.find((state) => state.run.vars.count === 4)!;
    expect(pinned.run.workflowVersion).toBe("1");
    expect(pinned.run.vars.newVersion).toBeUndefined();
  });

  it("forwards guards through submit to the root program workflow", async () => {
    const { dir, app, revision } = await fixture();
    await expect(
      commands.submit!.run(ctx(dir, ["A request"], { "var-json": ["count=3"], "expected-workflow-revision": "stale" })),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
    expect(await app.orchestrator.listRuns()).toEqual([]);
    expect(await app.orchestrator.stores.requests.list()).toEqual([]);
    await expect(
      commands.submit!.run(ctx(dir, ["Invalid input"], { "var-json": ['count="wrong"'] })),
    ).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(await app.orchestrator.stores.requests.list()).toEqual([]);
    expect(
      await commands.submit!.run(
        ctx(dir, ["A request"], {
          "var-json": ["count=3"],
          "workflow-version": "1",
          "expected-workflow-revision": revision,
        }),
      ),
    ).toBe(0);
    const [id] = await app.orchestrator.listRuns();
    expect((await app.orchestrator.getState(id!)).run).toMatchObject({
      workflowId: "typed",
      workflowVersion: "1",
      vars: { count: 3 },
    });
  });
});
