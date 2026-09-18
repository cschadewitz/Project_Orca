/**
 * `orca plan ...` - every subcommand rendered against one real plan on disk
 * (items with dependencies, a risk and a decision), in both the human and the
 * `--json` form, plus the mutations (`depend`, `waive`, `satisfy`, `decide`,
 * `risk`) and the errors a wrong invocation produces.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";
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

const plan = (dir: string, positionals: string[], flags: CommandContext["flags"] = {}) => {
  const c = ctx(dir, positionals, flags);
  return { c, run: () => commands.plan!.run(c) };
};

const TINY = `
id: tiny
name: Tiny
start: s
nodes:
  s: { type: start }
  done: { type: end }
edges:
  - { from: s, to: done }
`;

const human = { kind: "human" as const, actor: "test" };

let dir: string;
let ids: { schema: string; api: string; docs: string; decision: string; external: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-plan-cli-"));
  dirs.push(dir);
  await writeFile(join(dir, "tiny.yaml"), TINY, "utf8");
  await writeFile(
    join(dir, "orca.config.yaml"),
    "version: 1\nworkflows: [tiny.yaml]\ntemplates: []\nplanning: { plan: roadmap, planName: Roadmap }\n",
    "utf8",
  );

  // Seed the plan through the same service the CLI reads, writing to the store the CLI opens.
  const app = await bootstrap({ cwd: dir, logger: silentLogger });
  const p = await app.plan.ensurePlan({ requestId: "req_1" }, human);
  await app.plan.registerWorkItems(
    p.id,
    {
      requestId: "req_1",
      items: [
        { slug: "schema", title: "Database schema", risks: ["migration"] },
        { slug: "api", title: "Login API", priority: "high", dependsOn: ["schema@spec", "decision:session-store"] },
        { slug: "docs", title: "Docs", dependsOn: ["external:legal-review", { on: "api", type: "informs" }] },
      ],
      risks: [
        {
          key: "migration",
          title: "Migration locks the users table",
          category: "operational",
          likelihood: 2,
          impact: 4,
          mitigation: "Run it online",
          mitigatedBy: ["api"],
        },
      ],
      decisions: [
        {
          key: "session-store",
          title: "Where do sessions live?",
          question: "Signed cookies or a server-side store?",
          criteria: [{ key: "simplicity", name: "Simplicity", weight: 3 }],
          options: [
            { key: "cookie", name: "Signed cookie", scores: { simplicity: 9 } },
            { key: "redis", name: "Redis", scores: { simplicity: 4 } },
          ],
          blocks: ["api"],
        },
      ],
    },
    { kind: "decomposition" },
  );
  const snap = await app.plan.snapshot(p.id);
  const bySlug = Object.fromEntries(snap.items.map((i) => [i.slug, i.id]));
  ids = {
    schema: bySlug.schema!,
    api: bySlug.api!,
    docs: bySlug.docs!,
    decision: snap.decisions[0]!.id,
    external: snap.dependencies.find((d) => d.target.kind === "external")!.id,
  };
});

describe("orca plan list", () => {
  it("is the default subcommand and summarises each plan", async () => {
    const { c, run } = plan(dir, []);
    expect(await run()).toBe(0);
    expect(c.lines[0]).toMatch(
      /^roadmap\s+active\s+3 item\(s\), 1 request\(s\), strategy=critical-path, appetite=high {2}plan_/,
    );
  });

  it("renders JSON with --json", async () => {
    const { c, run } = plan(dir, ["list"], { json: true });
    expect(await run()).toBe(0);
    expect(JSON.parse(c.lines.join("\n"))).toEqual([expect.objectContaining({ key: "roadmap" })]);
  });

  it("says so when there are no plans at all", async () => {
    const empty = await mkdtemp(join(tmpdir(), "orca-plan-empty-"));
    dirs.push(empty);
    await writeFile(join(empty, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    const { c, run } = plan(empty, ["list"]);
    expect(await run()).toBe(0);
    expect(c.lines).toEqual(["no plans yet (submit a request to create one)"]);
    // And a named plan in an empty store names the mistake rather than crashing.
    await expect(commands.plan!.run(ctx(empty, ["show", "roadmap"]))).rejects.toMatchObject({
      code: "PLAN_NOT_FOUND",
      message: expect.stringContaining("no plans yet"),
    });
  });
});

describe("orca plan show", () => {
  it("lists items with their dependencies, risks and decisions", async () => {
    const { c, run } = plan(dir, ["show"]);
    expect(await run()).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toMatch(
      /^plan roadmap \(plan_\S+\) {2}Roadmap {2}status=active {2}strategy=critical-path {2}concurrency=2/m,
    );
    expect(text).toContain("requests: req_1");
    expect(text).toMatch(/depends on: decision:session-store \[open\], schema@spec \[open\]/);
    expect(text).toMatch(/depends on: external:legal-review \[open\], informs:api \[open\]/);
    expect(text).toMatch(/^ {2}open\s+medium\s+migration\s+L2 x I4 {2}affects: schema$/m);
    expect(text).toMatch(/^ {2}open\s+session-store\s+Where do sessions live\? {2}blocks: api$/m);
  });

  it("takes the plan key as a positional or as --plan, and --json dumps the snapshot", async () => {
    expect(await plan(dir, ["show", "roadmap"]).run()).toBe(0);
    expect(await plan(dir, ["show"], { plan: "roadmap" }).run()).toBe(0);

    const { c, run } = plan(dir, ["show"], { json: true });
    expect(await run()).toBe(0);
    expect(JSON.parse(c.lines.join("\n"))).toMatchObject({ items: expect.any(Array), dependencies: expect.any(Array) });
  });

  it("names the plans it does know when the key is wrong", async () => {
    await expect(plan(dir, ["show", "nope"]).run()).rejects.toMatchObject({
      code: "PLAN_NOT_FOUND",
      message: expect.stringContaining("known plans: roadmap"),
    });
  });
});

describe("orca plan schedule", () => {
  it("shows what is ready, what waits and why, the waves and the critical path", async () => {
    const { c, run } = plan(dir, ["schedule"]);
    expect(await run()).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toMatch(/^schedule for roadmap \(strategy \S+; open risks 1, highest \S+\)$/m);
    expect(text).toMatch(/^ {2}1\. schema/m);
    expect(text).toContain("waiting:");
    expect(text).toContain("open decisions:");
    expect(text).toMatch(/^ {2}session-store\s+blocks: api$/m);
    expect(text).toContain("waves:");
  });

  it("renders JSON with --json", async () => {
    const { c, run } = plan(dir, ["schedule"], { json: true });
    expect(await run()).toBe(0);
    expect(JSON.parse(c.lines.join("\n"))).toMatchObject({ ready: [{ slug: "schema" }] });
  });
});

describe("orca plan explain / graph / risks / decisions / journal", () => {
  it("explains one item's place in the schedule", async () => {
    const { c, run } = plan(dir, ["explain", "api"]);
    expect(await run()).toBe(0);
    expect(c.lines.join("\n")).toContain("api");
    await expect(plan(dir, ["explain"]).run()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("work item slug"),
    });
  });

  it("renders the dependency graph as Mermaid", async () => {
    const { c, run } = plan(dir, ["graph"]);
    expect(await run()).toBe(0);
    expect(c.lines.join("\n")).toContain("flowchart");
  });

  it("lists risks worst-first, with the matrix that scored them", async () => {
    const { c, run } = plan(dir, ["risks"]);
    expect(await run()).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toMatch(/^risk matrix: /m);
    expect(text).toMatch(/^open\s+medium\s+migration\s+L2 x I4 = 8 {2}Migration locks the users table$/m);
    expect(text).toMatch(/category=operational {2}affects: schema {2}mitigated by: api/);
    expect(text).toContain("mitigation: Run it online");

    const json = plan(dir, ["risks"], { json: true });
    expect(await json.run()).toBe(0);
    expect(JSON.parse(json.c.lines.join("\n"))).toEqual([expect.objectContaining({ key: "migration" })]);
  });

  it("lists decisions with their question, what they block and the matrix", async () => {
    const { c, run } = plan(dir, ["decisions"]);
    expect(await run()).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toMatch(/^open\s+session-store\s+Where do sessions live\?$/m);
    expect(text).toContain("Signed cookies or a server-side store?");
    expect(text).toContain("blocks: api");

    const json = plan(dir, ["decisions"], { json: true });
    expect(await json.run()).toBe(0);
    expect(JSON.parse(json.c.lines.join("\n"))).toEqual([expect.objectContaining({ key: "session-store" })]);
  });

  it("prints the journal, with slugs resolved, and raw events with --json", async () => {
    const { c, run } = plan(dir, ["journal"]);
    expect(await run()).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toMatch(/plan\.created/);
    expect(text).toMatch(/work-item\.added\s+\S+\s+schema/);
    expect(text).toMatch(/dependency\.added\s+\S+\s+\S/);
    expect(text).toMatch(/risk\.raised\s+\S+\s+migration/);
    expect(text).toMatch(/decision\.opened\s+\S+\s+session-store/);

    const json = plan(dir, ["journal"], { json: true });
    expect(await json.run()).toBe(0);
    expect(JSON.parse(json.c.lines[0]!)).toMatchObject({ type: "plan.created" });
  });

  it("says so when a plan has no risks and no decisions", async () => {
    const bare = await mkdtemp(join(tmpdir(), "orca-plan-bare-"));
    dirs.push(bare);
    await writeFile(join(bare, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    const app = await bootstrap({ cwd: bare, logger: silentLogger });
    await app.plan.ensurePlan({}, human);

    const risks = plan(bare, ["risks"]);
    expect(await risks.run()).toBe(0);
    expect(risks.c.lines).toContain("no risks recorded");

    const decisions = plan(bare, ["decisions"]);
    expect(await decisions.run()).toBe(0);
    expect(decisions.c.lines).toEqual(["no decisions recorded"]);
  });
});

describe("orca plan depend / waive / satisfy", () => {
  it("adds a dependency from the command line", async () => {
    const { c, run } = plan(dir, ["depend", "docs", "schema"]);
    expect(await run()).toBe(0);
    expect(c.lines[0]).toMatch(
      new RegExp(
        `^added dep_\\S+: docs -> {"kind":"work-item","workItemId":"${ids.schema}"} \\(blocks, by start\\) status=open$`,
      ),
    );
  });

  it("needs both a slug and a reference", async () => {
    await expect(plan(dir, ["depend", "docs"]).run()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("<slug> <dependency-ref>"),
    });
  });

  it("waives and satisfies a dependency by id, recording the rationale", async () => {
    const waived = plan(dir, ["waive", ids.external], { rationale: "legal signed off out of band" });
    expect(await waived.run()).toBe(0);
    expect(waived.c.lines).toEqual([`${ids.external} is now waived`]);

    // Satisfy the same one back, this time without a rationale (the CLI supplies one).
    const satisfied = plan(dir, ["satisfy", ids.external]);
    expect(await satisfied.run()).toBe(0);
    expect(satisfied.c.lines).toEqual([`${ids.external} is now satisfied`]);

    await expect(plan(dir, ["waive"]).run()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("plan waive needs a dependency id"),
    });
    await expect(plan(dir, ["satisfy"]).run()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("plan satisfy needs a dependency id"),
    });
  });
});

describe("orca plan decide / risk", () => {
  it("records a human decision and reports what the matrix would have picked", async () => {
    const { c, run } = plan(dir, ["decide", "session-store", "redis"], { rationale: "we need revocation" });
    expect(await run()).toBe(0);
    expect(c.lines[0]).toMatch(/^decision session-store = redis \(matrix recommended cookie, \S+\)$/);

    // The decision now shows up as decided, with its rationale.
    const shown = plan(dir, ["decisions"]);
    expect(await shown.run()).toBe(0);
    expect(shown.c.lines.join("\n")).toContain("= redis (human)");
    expect(shown.c.lines.join("\n")).toContain("rationale: we need revocation");
  });

  it("needs a decision key and an option", async () => {
    await expect(plan(dir, ["decide", "session-store"]).run()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("<decisionKey> <optionKey>"),
    });
  });

  it("moves a risk to a new status", async () => {
    const { c, run } = plan(dir, ["risk", "migration"], { status: "accepted" });
    expect(await run()).toBe(0);
    expect(c.lines).toEqual(["risk migration is now accepted"]);
  });

  it("needs both a risk key and --status", async () => {
    await expect(plan(dir, ["risk", "migration"]).run()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("--status"),
    });
    await expect(plan(dir, ["risk"], { status: "closed" }).run()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("orca plan dispatch", () => {
  it("runs the dispatch workflow and reports its exit code like `orca run` does", async () => {
    // `--workflow` stands in for `plan-resume`, which needs agents this config has none of.
    const { c, run } = plan(dir, ["dispatch"], { workflow: "tiny" });
    expect(await run()).toBe(0);
    expect(c.lines.join("\n")).toMatch(/workflow=tiny@1 +status=completed\/success/);
  });
});

describe("an unknown plan subcommand", () => {
  it("lists the ones that exist", async () => {
    await expect(plan(dir, ["frobnicate"]).run()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("unknown plan subcommand 'frobnicate'"),
    });
  });
});
