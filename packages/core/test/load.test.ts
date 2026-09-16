import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandPatterns, loadTemplates, loadWorkflows, parseOrcaConfig } from "@orca/core";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..", "..");
const workflow = (id: string) => `id: ${id}\nname: ${id}\nstart: s\nnodes:\n  s: { type: start, next: e }\n  e: { type: end }\n`;

describe("glob loaders", () => {
  it("picks up .yml and nested workflows, not just top-level .yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-load-"));
    await mkdir(join(dir, "workflows", "nested"), { recursive: true });
    await writeFile(join(dir, "workflows", "top.yaml"), workflow("top"));
    await writeFile(join(dir, "workflows", "alt.yml"), workflow("alt"));
    await writeFile(join(dir, "workflows", "nested", "deep.yaml"), workflow("deep"));
    const reg = await loadWorkflows(parseOrcaConfig({}).workflows, dir);
    expect(reg.list().map((d) => d.id).sort()).toEqual(["alt", "deep", "top"]);
  });

  it("loads the shipped workflows and templates with the default patterns", async () => {
    const config = parseOrcaConfig({});
    expect((await loadWorkflows(config.workflows, repoRoot)).list().map((d) => d.id).sort()).toEqual(["ai-sdlc", "plan-resume", "program"]);
    expect((await loadTemplates(config.templates, repoRoot)).list().length).toBeGreaterThan(0);
  });

  it("keeps literal (non-glob) patterns and resolves absolute ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-load-"));
    await writeFile(join(dir, "one.yaml"), workflow("one"));
    expect(await expandPatterns(["one.yaml"], dir)).toEqual([join(dir, "one.yaml")]);
    expect(await expandPatterns([join(dir, "*.yaml")], "/nowhere")).toEqual([join(dir, "one.yaml")]);
  });
});
