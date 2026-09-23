/**
 * #190: the selection flags on `orca run` / `orca submit` - `--agent`, `--model`,
 * `--item-workflow`, `--template-pack` - each one, repeated, recorded in the run's overrides,
 * and the three refusals (unknown role, agent, model) that list the known set. `orca agents`
 * lists declared models and says "not probed" without a daemon.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger, type RunOverrides } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";
import { commands, type CommandContext } from "../src/commands/index.js";
import { main } from "../src/main.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(
  cwd: string,
  positionals: string[],
  flags: CommandContext["flags"] = {},
): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return { cwd, flags: { quiet: true, ...flags }, positionals, out: (l) => lines.push(l), err: () => {}, lines };
}

/** Agent nodes that are never reached: the run completes without spawning anything, yet they decide who is in play. */
const TWO = `
id: two
name: Two agents
start: s
nodes:
  s: { type: start }
  build: { type: agent, agent: { role: builder }, prompt: "build" }
  review: { type: agent, agent: { role: reviewer }, prompt: "review" }
  done: { type: end }
edges:
  - { from: s, to: done }
  - { from: build, to: review }
  - { from: review, to: done }
`;

const ONE = `
id: one
name: One agent
start: s
nodes:
  s: { type: start }
  build: { type: agent, agent: { role: builder }, prompt: "build" }
  done: { type: end }
edges:
  - { from: s, to: done }
  - { from: build, to: done }
`;

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
  dir = await mkdtemp(join(tmpdir(), "orca-selection-"));
  dirs.push(dir);
  await writeFile(join(dir, "two.yaml"), TWO, "utf8");
  await writeFile(join(dir, "one.yaml"), ONE, "utf8");
  await writeFile(join(dir, "program.yaml"), PROGRAM, "utf8");
  await writeFile(
    join(dir, "orca.config.yaml"),
    [
      "version: 1",
      "workflows: [two.yaml, one.yaml, program.yaml]",
      "templates: []",
      "program: { workflow: program, itemWorkflow: one }",
      "hosts:",
      "  - { id: local, type: local }",
      "agents:",
      "  - id: claude",
      "    command: /bin/false",
      "    roles: [builder, reviewer]",
      "    models: [{ id: opus, name: Opus }, { id: sonnet, name: Sonnet }]",
      "    defaultModel: opus",
      "  - { id: codex, command: /bin/false, roles: [builder] }",
      "roles: { builder: claude, reviewer: claude }",
      "",
    ].join("\n"),
    "utf8",
  );
});

/** The overrides the most recent run recorded. */
async function lastOverrides(): Promise<RunOverrides | undefined> {
  const app = await bootstrap({ cwd: dir, logger: silentLogger });
  const states = await Promise.all((await app.orchestrator.listRuns()).map((id) => app.orchestrator.getState(id)));
  states.sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt) || a.run.id.localeCompare(b.run.id));
  return states.at(-1)!.run.overrides;
}

describe("orca run selection flags", () => {
  it("--agent role=agentId, repeated, records each role", async () => {
    expect(await commands.run!.run(ctx(dir, ["two"], { agent: ["builder=codex", "reviewer=claude"] }))).toBe(0);
    expect(await lastOverrides()).toEqual({ roles: { builder: "codex", reviewer: "claude" } });
  });

  it("--model agentId=modelId, repeated, records each agent's model", async () => {
    expect(
      await commands.run!.run(ctx(dir, ["two"], { agent: ["builder=codex"], model: ["claude=sonnet", "codex=o3"] })),
    ).toBe(0);
    expect(await lastOverrides()).toEqual({ roles: { builder: "codex" }, model: { claude: "sonnet", codex: "o3" } });
  });

  it("--model modelId alone applies to the one agent in play", async () => {
    expect(await commands.run!.run(ctx(dir, ["one"], { model: ["sonnet"] }))).toBe(0);
    expect(await lastOverrides()).toEqual({ model: { claude: "sonnet" } });
  });

  it("--model modelId alone is refused when more than one agent is in play, naming them", async () => {
    await expect(
      commands.run!.run(ctx(dir, ["two"], { agent: ["builder=codex"], model: ["sonnet"] })),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("codex, claude") });
  });

  it("--template-pack is recorded", async () => {
    expect(await commands.run!.run(ctx(dir, ["one"], { "template-pack": "terse" }))).toBe(0);
    expect(await lastOverrides()).toEqual({ templatePack: "terse" });
  });

  it("an unknown role fails with the known roles", async () => {
    await expect(commands.run!.run(ctx(dir, ["two"], { agent: ["tester=codex"] }))).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: "no agent fills role 'tester'",
      details: { known: ["builder", "reviewer"] },
    });
  });

  it("an unknown agent fails with the known agents", async () => {
    await expect(commands.run!.run(ctx(dir, ["two"], { agent: ["builder=gemini"] }))).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: "agent 'gemini' not configured",
      details: { known: ["claude", "codex"] },
    });
  });

  it("an unknown model fails with the agent's declared models", async () => {
    await expect(commands.run!.run(ctx(dir, ["one"], { model: ["claude=haiku"] }))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "model 'haiku' not configured for agent 'claude'",
      details: { known: ["opus", "sonnet"] },
    });
  });

  it("the flags parse from argv, repeatable", async () => {
    const code = await main([
      "run",
      "two",
      "--cwd",
      dir,
      "--quiet",
      "--agent",
      "builder=codex",
      "--agent",
      "reviewer=claude",
      "--model",
      "claude=opus",
    ]);
    expect(code).toBe(0);
    expect(await lastOverrides()).toEqual({
      roles: { builder: "codex", reviewer: "claude" },
      model: { claude: "opus" },
    });
  });
});

describe("orca submit --item-workflow", () => {
  it("records the item workflow in the program run's overrides", async () => {
    expect(await commands.submit!.run(ctx(dir, ["A request"], { "item-workflow": "two" }))).toBe(0);
    expect(await lastOverrides()).toEqual({ itemWorkflow: "two" });
  });

  it("an unknown item workflow fails with the known workflows", async () => {
    await expect(commands.submit!.run(ctx(dir, ["A request"], { "item-workflow": "nope" }))).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
      message: "workflow 'nope' not registered",
    });
  });
});

describe("orca agents", () => {
  it("lists declared models with the default marked, and says discovered models were not probed", async () => {
    // A port nothing listens on, so a daemon on the default one cannot change the answer.
    const c = ctx(dir, [], { port: "1" });
    expect(await commands.agents!.run(c)).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toContain("models declared: opus (default), sonnet");
    expect(text).toContain("models declared: none");
    expect(text).toContain("models discovered: not probed");
  });
});
