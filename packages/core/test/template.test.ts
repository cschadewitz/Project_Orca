import { describe, expect, it } from "vitest";
import { parseDeliverablesBlock, parsePromptTemplate, renderDeliverablesBlock, renderTemplate, TemplateRegistry } from "@orca/core";

describe("template renderer", () => {
  it("interpolates expressions, conditionals and loops", () => {
    const out = renderTemplate(
      ["Hi {{ workItem.title }}", "{{#if artifacts.spec}}spec: {{ artifacts.spec.data.risk }}{{else}}no spec{{/if}}", "{{#each items as it, i}}{{ i }}:{{ it }} {{/each}}", "{{!-- comment --}}done"].join("\n"),
      { workItem: { title: "Auth" }, artifacts: { spec: { data: { risk: "low" } } }, items: ["a", "b"] },
    );
    expect(out).toBe("Hi Auth\nspec: low\n0:a 1:b \ndone");
  });
  it("renders objects as yaml and resolves partials", () => {
    const reg = new TemplateRegistry();
    reg.registerSource("---\nid: p\n---\nItems:\n{{ items }}");
    const out = renderTemplate("{{> p}}", { items: { a: 1 } }, { partials: reg.partials });
    expect(out).toBe("Items:\na: 1");
  });
  it("fails on unbalanced blocks", () => {
    expect(() => renderTemplate("{{#if x}}", {})).toThrow(/unclosed/);
  });
  it("parses template front matter", () => {
    const t = parsePromptTemplate("---\nid: sdlc/plan\nrequires: [intent]\n---\nBody {{ x }}");
    expect(t.id).toBe("sdlc/plan");
    expect(t.requires).toEqual(["intent"]);
    expect(t.body).toBe("Body {{ x }}");
  });
  it("round-trips the deliverables block", () => {
    const block = renderDeliverablesBlock([{ kind: "spec", path: "/w/spec.md", required: true, requiredFields: ["status"] }]);
    expect(block).toContain("## Deliverables");
    const parsed = parseDeliverablesBlock("prompt text\n\n" + block);
    expect(parsed).toEqual([{ kind: "spec", path: "/w/spec.md", required: true, requiredFields: ["status"] }]);
  });
});
