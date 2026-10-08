/** The demo workspace doubles as a working setup: the README quick start runs `run ai-sdlc` against the config it leaves behind. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseOrcaConfig } from "@orca/core";
import { commands } from "../src/commands/index.js";
import { ctx, successfulDemo } from "./demo-fixture.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// The program spawns many real scripted ACP processes. Keep the existing local
// integration bound; performance fixes must create margin rather than raise it.
describe("orca demo", { timeout: 60_000 }, () => {
  describe("the reusable demo workspace", () => {
    let dir: string;
    let configPath: string;
    // Demo setup and the README's later workflow are separate operations. Each keeps the
    // existing 60s bound, rather than charging a second workflow to the demo's deadline.
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "orca-demo-test-"));
      dirs.push(dir);
      await successfulDemo(ctx(dir, [], { dir }));
      configPath = join(dir, "orca.config.yaml");
    }, 60_000);

    it("writes the reusable config without changing the agent's permission defaults", async () => {
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
    });

    it("runs the README quick-start workflow with the generated config", async () => {
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
  });
});
