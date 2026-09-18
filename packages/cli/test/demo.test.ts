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

function ctx(cwd: string, positionals: string[], flags: CommandContext["flags"] = {}, configPath?: string): CommandContext & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return { cwd, configPath, flags: { quiet: true, ...flags }, positionals, out: (l) => lines.push(l), err: (l) => errs.push(l), lines, errs };
}

/** The temp workspace the demo announces on stderr when run without --dir. */
function announcedDir(c: { errs: string[] }): string {
  const line = c.errs.find((l) => l.startsWith("demo workspace: "));
  expect(line).toBeDefined();
  return line!.slice("demo workspace: ".length);
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("orca demo", () => {
  it("writes an orca.config.yaml that later commands can run workflows with", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-demo-test-"));
    dirs.push(dir);

    expect(await commands.demo!.run(ctx(dir, [], { dir }))).toBe(0);

    const configPath = join(dir, "orca.config.yaml");
    const config = parseOrcaConfig(parseYaml(await readFile(configPath, "utf8")));
    expect(config.agents.map((a) => a.id)).toEqual(["scripted"]);
    expect(config.storeDir).toBe(join(dir, ".orca"));

    // Same invocation as the README quick start: needs the config (without one no
    // agent fills the ai-sdlc roles and bootstrap throws WORKFLOW_INVALID).
    const run = ctx(dir, ["ai-sdlc"], { var: ['workItem={"slug":"x","title":"X"}'] }, configPath);
    expect(await commands.run!.run(run)).toBe(0);
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
