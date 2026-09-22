/** The demo workspace doubles as a working setup: the README quick start runs `run ai-sdlc` against the config it leaves behind. */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseOrcaConfig } from "@orca/core";
import { commands, type CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(
  cwd: string,
  positionals: string[],
  flags: CommandContext["flags"] = {},
  configPath?: string,
): CommandContext & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    cwd,
    configPath,
    flags: { quiet: true, ...flags },
    positionals,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    lines,
    errs,
  };
}

/** The temp workspace the demo announces on stderr when run without --dir. */
function announcedDir(c: { errs: string[] }): string {
  const line = c.errs.find((l) => l.startsWith("demo workspace: "));
  expect(line).toBeDefined();
  return line!.slice("demo workspace: ".length);
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

// The program spawns many scripted ACP processes; measured 25–27s per test locally
// and 35s on CI (#228). Keep this allowance local to the subprocess integration test.
describe("orca demo", { timeout: 60_000 }, () => {
  it("writes an orca.config.yaml that later commands can run workflows with", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-demo-test-"));
    dirs.push(dir);

    expect(await commands.demo!.run(ctx(dir, [], { dir }))).toBe(0);

    const configPath = join(dir, "orca.config.yaml");
    const raw = await readFile(configPath, "utf8");
    const config = parseOrcaConfig(parseYaml(raw));
    expect(config.agents.map((a) => a.id)).toEqual(["scripted"]);
    expect(config.storeDir).toBe(join(dir, ".orca"));

    // The demo serialises the *parsed* AgentSpec, so whatever parsing injects it claims as
    // configured. Since #140's defaults moved out of the schema and into evaluation, there is
    // nothing to inject: the file says `default: ask` and no rules, which is the truth, and
    // the default rules stay a layer that the sidecar is still matched ahead of.
    expect(raw).toMatch(/^ {4}permissions:$/m);
    expect(raw).not.toMatch(/scope: workspace/);
    expect(config.agents[0]!.permissions).toEqual({ rules: [] });
    // No `default:` in the generated file either, so the demo agent gets the #140 defaults
    // rather than opting itself out of them by spelling a fallthrough it was never asked for.
    expect(config.agents[0]!.permissions.default).toBeUndefined();
    expect(raw).not.toMatch(/^ {6}default:/m);

    // Same invocation as the README quick start: needs the config (without one no
    // agent fills the ai-sdlc roles and bootstrap throws WORKFLOW_INVALID).
    const run = ctx(
      dir,
      ["ai-sdlc"],
      { var: ['workItem={"slug":"x","title":"X","description":"Implement X"}'] },
      configPath,
    );
    const exit = await commands.run!.run(run);
    expect(exit, run.lines.join("\n")).toBe(0);
    expect(run.lines.join("\n")).toMatch(/workflow=ai-sdlc@1 +status=completed\/success/);
  });

  it("removes its temp workspace afterwards by default", async () => {
    const c = ctx(tmpdir(), []);
    expect(await commands.demo!.run(c)).toBe(0);
    const dir = announcedDir(c);
    dirs.push(dir);
    expect(dir.startsWith(join(tmpdir(), "orca-demo-"))).toBe(true);
    expect(await exists(dir)).toBe(false);
    expect(c.lines.join("\n")).toMatch(/removing demo workspace/);
    expect(c.lines.join("\n")).not.toMatch(/ready-to-use/);
  });

  it("keeps the temp workspace with --keep and says where it is", async () => {
    const c = ctx(tmpdir(), [], { keep: true });
    expect(await commands.demo!.run(c)).toBe(0);
    const dir = announcedDir(c);
    dirs.push(dir);
    expect(await exists(join(dir, "orca.config.yaml"))).toBe(true);
    expect(c.lines.join("\n")).toMatch(/ready-to-use/);
    expect(c.lines.join("\n")).not.toMatch(/removing demo workspace/);
  });
});
