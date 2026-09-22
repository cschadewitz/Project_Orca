import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { expandPatterns, loadTemplates, loadWorkflows, parseOrcaConfig } from "@orca/core";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = (id: string) =>
  `id: ${id}\nname: ${id}\nstart: s\nnodes:\n  s: { type: start, next: e }\n  e: { type: end }\n`;

describe("glob loaders", () => {
  it("picks up .yml and nested workflows, not just top-level .yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-load-"));
    await mkdir(join(dir, "workflows", "nested"), { recursive: true });
    await writeFile(join(dir, "workflows", "top.yaml"), workflow("top"));
    await writeFile(join(dir, "workflows", "alt.yml"), workflow("alt"));
    await writeFile(join(dir, "workflows", "nested", "deep.yaml"), workflow("deep"));
    const reg = await loadWorkflows(parseOrcaConfig({}).workflows, dir);
    expect(
      reg
        .list()
        .map((d) => d.id)
        .sort(),
    ).toEqual(["alt", "deep", "top"]);
  });

  it("loads the shipped workflows and templates with the default patterns", async () => {
    const config = parseOrcaConfig({});
    expect(
      (await loadWorkflows(config.workflows, repoRoot))
        .list()
        .map((d) => d.id)
        .sort(),
    ).toEqual(["ai-sdlc", "plan-resume", "program"]);
    expect((await loadTemplates(config.templates, repoRoot)).list().length).toBeGreaterThan(0);
  });

  /**
   * The example is what a person copies into a real repo, so it has to parse — and what it
   * parses to has to be *only* what it says (#140). Parsing no longer injects
   * `DEFAULT_PERMISSION_POLICY`'s rules: they are a layer added at evaluation time, after the
   * sidecar, and a config that claimed them as its own would put them ahead of it.
   */
  it("parses the shipped examples/orca.config.yaml, policy and all", async () => {
    const config = parseOrcaConfig(parseYaml(await readFile(join(repoRoot, "examples", "orca.config.yaml"), "utf8")));
    const byId = (id: string) => config.agents.find((a) => a.id === id)!;
    // No `permissions:` block is no configured rules and no chosen fallthrough - `default`
    // absent, which is what opts the agent in to `DEFAULT_PERMISSION_POLICY` at evaluation.
    expect(byId("codex-remote").permissions).toEqual({ rules: [] });
    expect(byId("codex-remote").permissions.default).toBeUndefined();
    // Rules but no `default:`, so the example's own agent keeps the #140 default layer too -
    // an example that opted itself out of it by accident would teach the wrong thing.
    expect(byId("claude-local").permissions.default).toBeUndefined();
    expect(byId("claude-local").permissions.rules).toEqual([
      { match: { kind: "execute", titlePattern: "rm -rf|git push --force" }, decision: "deny" },
      { match: { pathPrefix: "/etc" }, decision: "deny" },
    ]);
  });

  it("keeps literal (non-glob) patterns and resolves absolute ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-load-"));
    await writeFile(join(dir, "one.yaml"), workflow("one"));
    expect(await expandPatterns(["one.yaml"], dir)).toEqual([join(dir, "one.yaml")]);
    expect(await expandPatterns([join(dir, "*.yaml")], "/nowhere")).toEqual([join(dir, "one.yaml")]);
  });
});
