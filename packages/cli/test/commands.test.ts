/**
 * The read-only and argument-handling half of the CLI: validate, graph, agents,
 * runs, status, events, submit, kepler - plus the errors every command raises
 * when it is called without what it needs.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commands, type CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(
  cwd: string,
  positionals: string[],
  flags: CommandContext["flags"] = {},
): CommandContext & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    cwd,
    flags: { quiet: true, ...flags },
    positionals,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    lines,
    errs,
  };
}

const TINY = `
id: tiny
name: Tiny workflow
start: s
nodes:
  s: { type: start }
  set: { type: set, vars: { greeting: "hi" } }
  done: { type: end }
edges:
  - { from: s, to: set }
  - { from: set, to: done }
`;

/** A workflow the CLI can load but `validate` must reject: it points at a workflow nobody defines. */
const BROKEN = `
id: broken
name: Broken workflow
start: s
nodes:
  s: { type: start }
  sub: { type: subworkflow, workflow: nowhere }
  done: { type: end }
edges:
  - { from: s, to: sub }
  - { from: sub, to: done }
`;

/** A plugin whose executor validates its node at load time (#308): `field` is required. */
const STRICT_PLUGIN = [
  "export default {",
  '  name: "strict",',
  "  register(api) {",
  "    api.executors.register({",
  '      type: "custom:strict",',
  '      validate: (node) => ("field" in node ? {} : { errors: [{ path: "field", message: "Required" }] }),',
  '      async execute() { return { kind: "completed", result: { artifactIds: [], data: {} } }; },',
  "    });",
  "  },",
  "};",
  "",
].join("\n");

/** One custom node the strict plugin accepts, one it rejects, and one no plugin registers. */
const CUSTOM = `
id: custom
name: Custom nodes
start: s
nodes:
  s: { type: start }
  ok: { type: "custom:strict", field: 1 }
  bad: { type: "custom:strict" }
  nobody: { type: "custom:nobody" }
  done: { type: end }
edges:
  - { from: s, to: ok }
  - { from: ok, to: bad }
  - { from: bad, to: nobody }
  - { from: nobody, to: done }
`;

/** `submit` runs the configured program workflow; this one just records the request and ends. */
const PROGRAM = `
id: program
name: Program
start: s
nodes:
  s: { type: start }
  done: { type: end }
edges:
  - { from: s, to: done }
`;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-commands-"));
  dirs.push(dir);
  await writeFile(join(dir, "tiny.yaml"), TINY, "utf8");
  await writeFile(join(dir, "broken.yaml"), BROKEN, "utf8");
  await writeFile(join(dir, "program.yaml"), PROGRAM, "utf8");
  await writeFile(
    join(dir, "orca.config.yaml"),
    [
      "version: 1",
      "workflows: [tiny.yaml, program.yaml]",
      "templates: []",
      "hosts:",
      "  - { id: local, type: local }",
      "  - { id: remote, type: ssh, host: example.invalid, user: orca, port: 2222 }",
      "agents:",
      "  - { id: coder, hostId: local, roles: [build, test], command: /bin/false, args: [--acp] }",
      "roles: { build: coder }",
      "",
    ].join("\n"),
    "utf8",
  );
});

describe("orca validate", () => {
  it("validates the workflows the config names", async () => {
    const c = ctx(dir, []);
    expect(await commands.validate!.run(c)).toBe(0);
    expect(c.lines).toContain("OK   tiny (3 nodes, 2 edges)");
  });

  it("validates the files it is given instead, and fails on a broken one", async () => {
    const c = ctx(dir, ["broken.yaml"]);
    expect(await commands.validate!.run(c)).toBe(1);
    const text = c.lines.join("\n");
    expect(text).toMatch(/^FAIL broken/m);
    expect(text).toMatch(/error .*nowhere/);
  });

  it.each([
    ["tiny.yaml", 0],
    ["broken.yaml", 1],
    ["[bt]*.yaml", 1],
  ] as const)("reports the same diagnostics for absolute and relative %s", async (file, exitCode) => {
    const relative = ctx(dir, [file]);
    const absolute = ctx(dir, [join(dir, file)]);
    expect(await commands.validate!.run(relative)).toBe(exitCode);
    expect(relative.lines.length).toBeGreaterThan(0);
    expect(await commands.validate!.run(absolute)).toBe(exitCode);
    expect(absolute.lines).toEqual(relative.lines);
    expect(absolute.errs).toEqual(relative.errs);
  });

  it("resolves explicit files and globs from cwd, and defaults from the config directory", async () => {
    const configDir = join(dir, "config");
    await mkdir(configDir);
    await writeFile(join(configDir, "tiny.yaml"), BROKEN, "utf8");
    const configPath = join(configDir, "orca.config.yaml");
    await writeFile(configPath, "version: 1\nworkflows: [t*.yaml]\ntemplates: []\n", "utf8");

    for (const file of ["tiny.yaml", "./tiny.yaml", "t*.yaml", join(dir, "tiny.yaml"), join(dir, "t*.yaml")]) {
      const c = { ...ctx(dir, [file]), configPath };
      expect(await commands.validate!.run(c)).toBe(0);
      expect(c.lines).toEqual(["OK   tiny (3 nodes, 2 edges)"]);
    }

    const defaults = { ...ctx(dir, []), configPath };
    expect(await commands.validate!.run(defaults)).toBe(1);
    expect(defaults.lines.join("\n")).toMatch(/^FAIL broken/m);
    expect(defaults.lines.join("\n")).toMatch(/error .*nowhere/);
  });

  it("prints the Mermaid graph alongside with --mermaid", async () => {
    const c = ctx(dir, ["tiny.yaml"], { mermaid: true });
    expect(await commands.validate!.run(c)).toBe(0);
    expect(c.lines.join("\n")).toContain("flowchart");
  });

  it("loads the config's plugins so a custom node's fields are checked by its executor (#308)", async () => {
    const pdir = await mkdtemp(join(tmpdir(), "orca-validate-plugin-"));
    dirs.push(pdir);
    await writeFile(join(pdir, "plugin.mjs"), STRICT_PLUGIN, "utf8");
    await writeFile(join(pdir, "custom.yaml"), CUSTOM, "utf8");
    await writeFile(
      join(pdir, "orca.config.yaml"),
      'version: 1\nworkflows: [custom.yaml]\ntemplates: []\nplugins: ["./plugin.mjs"]\n',
      "utf8",
    );
    const c = ctx(pdir, []);
    expect(await commands.validate!.run(c)).toBe(1);
    const text = c.lines.join("\n");
    expect(text).toMatch(/^FAIL custom/m);
    expect(text).toContain("error   workflow(custom).nodes.bad.field: Required");
    expect(text).toContain(
      "warning workflow(custom).nodes.nobody: no executor is registered for 'custom:nobody'; its fields were not checked",
    );
    // The node that passes its executor's check is not mentioned.
    expect(text).not.toContain("nodes.ok");
  });

  it("validates only named files while keeping plugin workflows available as references", async () => {
    const pdir = await mkdtemp(join(tmpdir(), "orca-validate-targets-"));
    dirs.push(pdir);
    await writeFile(
      join(pdir, "selected.yaml"),
      "id: selected\nname: Selected\nstart: s\nnodes:\n  s: { type: start }\n  child: { type: subworkflow, workflow: plugin-good }\n  done: { type: end }\nedges: [{ from: s, to: child }, { from: child, to: done }]\n",
      "utf8",
    );
    await writeFile(
      join(pdir, "plugin.mjs"),
      `export default { name: "extra-workflows", register(api) {
  const good = { id: "plugin-good", name: "Good", version: "1", vars: {}, inputs: {}, start: "s",
    nodes: { s: { type: "start" }, done: { type: "end" } }, edges: [{ from: "s", to: "done" }] };
  api.workflows.register(good);
  api.workflows.register({ ...good, id: "plugin-bad", name: "Bad", edges: [{ from: "s", to: "missing" }] });
} };\n`,
      "utf8",
    );
    await writeFile(
      join(pdir, "orca.config.yaml"),
      'version: 1\nworkflows: [selected.yaml]\ntemplates: []\nplugins: ["./plugin.mjs"]\n',
      "utf8",
    );

    const selected = ctx(pdir, ["selected.yaml"]);
    expect(await commands.validate!.run(selected)).toBe(0);
    expect(selected.lines).toEqual(["OK   selected (3 nodes, 2 edges)"]);

    const all = ctx(pdir, []);
    expect(await commands.validate!.run(all)).toBe(1);
    expect(all.lines.join("\n")).toContain("FAIL plugin-bad");
  });
});

describe("orca graph", () => {
  it("renders a workflow file directly", async () => {
    const c = ctx(dir, ["tiny.yaml"]);
    expect(await commands.graph!.run(c)).toBe(0);
    expect(c.lines.join("\n")).toContain("flowchart");
  });

  it("renders a workflow the config knows by id", async () => {
    const c = ctx(dir, ["tiny"]);
    expect(await commands.graph!.run(c)).toBe(0);
    expect(c.lines.join("\n")).toContain("flowchart");
  });

  it("needs a target", async () => {
    await expect(commands.graph!.run(ctx(dir, []))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("orca agents", () => {
  it("lists hosts, agents and roles, spelling out an ssh host's address", async () => {
    const c = ctx(dir, []);
    expect(await commands.agents!.run(c)).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toMatch(/^ {2}local {10}local$/m);
    expect(text).toMatch(/^ {2}remote {9}ssh orca@example\.invalid:2222$/m);
    expect(text).toMatch(/^ {2}coder {10}host=local {6}roles=\[build, test\] \/bin\/false --acp$/m);
    expect(text).toContain("roles: build→coder");
  });
});

describe("orca ping", () => {
  it("needs an agent id, and says so when the id is not configured", async () => {
    await expect(commands.ping!.run(ctx(dir, []))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(commands.ping!.run(ctx(dir, ["nobody"]))).rejects.toThrow(/nobody/);
  });
});

describe("orca run", () => {
  it("needs a workflow id, and rejects a --var that is not key=value", async () => {
    await expect(commands.run!.run(ctx(dir, []))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(commands.run!.run(ctx(dir, ["tiny"], { var: ["oops"] }))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("key=value"),
    });
  });

  it("parses --var values as JSON, falling back to the raw string", async () => {
    const c = ctx(dir, ["tiny"], { var: ["count=3", 'obj={"a":1}', "name=plain text"] });
    expect(await commands.run!.run(c)).toBe(0);
    expect(c.lines.join("\n")).toMatch(/status=completed\/success/);
  });

  it("runs in the directory --cwd names", async () => {
    const workspace = join(dir, "elsewhere");
    await mkdir(workspace, { recursive: true });
    const c = ctx(dir, ["tiny"], { cwd: workspace });
    expect(await commands.run!.run(c)).toBe(0);
    expect(c.lines.join("\n")).toContain(`workspace local:${workspace}`);
  });

  it("prints events to stderr unless --quiet", async () => {
    const c = ctx(dir, ["tiny"], { quiet: false });
    expect(await commands.run!.run(c)).toBe(0);
    expect(c.errs.join("\n")).toMatch(/created \(workflow tiny\)/);
  });
});

describe("orca runs / status / events", () => {
  it("lists the runs the store holds and shows one in detail", async () => {
    const list = ctx(dir, []);
    expect(await commands.runs!.run(list)).toBe(0);
    expect(list.lines.length).toBeGreaterThan(0);
    const runId = list.lines[0]!.split(/\s+/)[0]!;

    const status = ctx(dir, [runId]);
    expect(await commands.status!.run(status)).toBe(0);
    expect(status.lines[0]).toContain(`run ${runId}`);

    const text = ctx(dir, [runId]);
    expect(await commands.events!.run(text)).toBe(0);
    expect(text.lines.join("\n")).toMatch(/run \S+ created/);

    const json = ctx(dir, [runId], { json: true });
    expect(await commands.events!.run(json)).toBe(0);
    expect(JSON.parse(json.lines[0]!)).toMatchObject({ runId, type: "run.created" });
  });

  it("both need a run id, and report one that does not exist", async () => {
    await expect(commands.status!.run(ctx(dir, []))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(commands.events!.run(ctx(dir, []))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(commands.resume!.run(ctx(dir, []))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(commands.status!.run(ctx(dir, ["run_missing"]))).rejects.toThrow();
  });
});

describe("orca submit", () => {
  it("needs a title", async () => {
    await expect(commands.submit!.run(ctx(dir, []))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("creates a request and follows the program workflow", async () => {
    const c = ctx(dir, ["Add", "authentication"], { body: "Users log in." });
    expect(await commands.submit!.run(c)).toBe(0);
    expect(c.lines[0]).toMatch(/^request req_\S+; run run_\S+; admission admission_\S+$/);
    expect(c.lines.join("\n")).toMatch(/request req_\S+: completed/);
    expect(c.lines.join("\n")).toMatch(/workflow=program@1 +status=completed\/success/);
    // No work items came out of this program workflow, so no section for them.
    expect(c.lines.join("\n")).not.toContain("work items:");
  });

  it("reads the body from --body-file", async () => {
    const bodyFile = join(dir, "body.md");
    await writeFile(bodyFile, "From a file.\n", "utf8");
    const c = ctx(dir, ["Titled"], { "body-file": bodyFile });
    expect(await commands.submit!.run(c)).toBe(0);
    expect(c.lines[0]).toMatch(/^request req_/);
  });
});

describe("orca answer", () => {
  it("needs an answer once it has been given a request id", async () => {
    await expect(commands.answer!.run(ctx(dir, ["hi_nope"]))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("<requestId> <option>"),
    });
  });
});

describe("orca kepler", () => {
  it("reports a task directory as JSON, worktrees and all", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "orca-kepler-"));
    dirs.push(taskDir);
    await mkdir(join(taskDir, "repo"), { recursive: true });
    await writeFile(join(taskDir, "repo", ".git"), "gitdir: /elsewhere\n", "utf8");
    await writeFile(join(taskDir, "AGENTS.md"), "# Task: Fix the login bug\n\nDetails here.\n", "utf8");

    const c = ctx(dir, [taskDir]);
    expect(await commands.kepler!.run(c)).toBe(0);
    expect(JSON.parse(c.lines.join("\n"))).toMatchObject({
      taskDir,
      title: "Fix the login bug",
      worktrees: [{ name: "repo", path: join(taskDir, "repo") }],
    });
  });

  it("falls back to the current directory when no task dir is given", async () => {
    const previous = process.env.KEPLER_TASK_DIR;
    delete process.env.KEPLER_TASK_DIR;
    try {
      const c = ctx(dir, []);
      expect(await commands.kepler!.run(c)).toBe(0);
      expect(JSON.parse(c.lines.join("\n"))).toMatchObject({ taskDir: dir });
    } finally {
      if (previous !== undefined) process.env.KEPLER_TASK_DIR = previous;
    }
  });
});
