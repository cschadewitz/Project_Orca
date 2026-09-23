/**
 * #191: template packs. With the shipped `strict` pack selected, the ai-sdlc review node renders
 * from `strict/sdlc/review` and every other node from the base set - loaded through the default
 * `templates` glob, so the pack ships without any config change.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTemplates, loadWorkflows, parseOrcaConfig, renderTemplate, TemplateRegistry } from "@orca/core";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("template packs", () => {
  it("renders the review node from the pack and every other ai-sdlc node from the base set", async () => {
    const config = parseOrcaConfig({});
    const templates = await loadTemplates(config.templates, repoRoot);
    const sdlc = (await loadWorkflows(config.workflows, repoRoot)).get("ai-sdlc");
    const used = Object.values(sdlc.nodes).flatMap((n) => {
      const t = (n as { template?: unknown }).template;
      return typeof t === "string" ? [t] : [];
    });
    expect(used).toContain("sdlc/review");
    expect(used.length).toBeGreaterThan(1);

    for (const id of used) {
      const picked = templates.get(id, { pack: "strict" });
      const rendered = renderTemplate(picked.body, {}, { partials: templates.partials });
      if (id === "sdlc/review") {
        expect(picked.id).toBe("strict/sdlc/review");
        expect(rendered).toContain("strict** review pack");
      } else {
        expect(picked.id).toBe(id);
        expect(rendered).toBe(renderTemplate(templates.get(id).body, {}, { partials: templates.partials }));
        expect(rendered).not.toContain("strict** review pack");
      }
    }
    expect(templates.packOverrides("strict")).toEqual(["sdlc/review"]);
  });

  it("falls back to the base id when the pack has no such template, and without a pack", () => {
    const reg = new TemplateRegistry();
    reg.registerSource("---\nid: a\n---\nbase a");
    reg.registerSource("---\nid: b\n---\nbase b");
    reg.registerSource("---\nid: p/a\n---\npack a");
    expect(reg.get("a", { pack: "p" }).body).toBe("pack a");
    expect(reg.get("b", { pack: "p" }).body).toBe("base b");
    expect(reg.get("a").body).toBe("base a");
    expect(reg.packOverrides("p")).toEqual(["a"]);
    expect(reg.packOverrides("q")).toEqual([]);
    expect(() => reg.get("c", { pack: "p" })).toThrow(/template 'c' not registered/);
  });
});
