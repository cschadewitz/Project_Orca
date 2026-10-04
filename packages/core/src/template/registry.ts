/**
 * Prompt templates are markdown files with front matter:
 *
 *   ---
 *   id: sdlc/design
 *   name: Design stage
 *   requires: [intent]        # artifact kinds the template expects in context
 *   produces: spec            # documentation only
 *   ---
 *   You are the design agent ...
 */
import { z } from "zod";
import { OrcaError } from "../errors.js";
import { parseFrontMatter } from "../util/frontmatter.js";

export const PromptTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().default("1"),
  requires: z.array(z.string()).default([]),
  produces: z.string().optional(),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

export function parsePromptTemplate(text: string, fallbackId?: string): PromptTemplate {
  const { data, body } = parseFrontMatter(text);
  const { id, name, description, version, requires, produces, ...meta } = data;
  const parsed = PromptTemplateSchema.safeParse({
    id: id ?? fallbackId,
    name,
    description,
    version,
    requires,
    produces,
    body: body.trim(),
    meta,
  });
  if (!parsed.success)
    throw new OrcaError(
      "TEMPLATE_RENDER",
      `invalid template ${typeof id === "string" ? id : (fallbackId ?? "[invalid id]")}: ${parsed.error.message}`,
    );
  return parsed.data;
}

export class TemplateRegistry {
  private readonly templates = new Map<string, PromptTemplate>();

  register(t: PromptTemplate): this {
    this.templates.set(t.id, t);
    return this;
  }
  registerSource(text: string, fallbackId?: string): PromptTemplate {
    const t = parsePromptTemplate(text, fallbackId);
    this.register(t);
    return t;
  }
  has(id: string): boolean {
    return this.templates.has(id);
  }
  /**
   * A template by id. With a `pack` (#191) it tries `<pack>/<id>` first and falls back to
   * `<id>`, so a pack overriding two templates inherits every other one from the base set.
   */
  get(id: string, options: { pack?: string } = {}): PromptTemplate {
    const t = (options.pack ? this.templates.get(`${options.pack}/${id}`) : undefined) ?? this.templates.get(id);
    if (!t)
      throw new OrcaError("TEMPLATE_NOT_FOUND", `template '${id}' not registered`, {
        known: [...this.templates.keys()],
      });
    return t;
  }
  /**
   * The base template ids a pack overrides: every `X` for which both `X` and `<pack>/X` are
   * registered. Empty for a pack that does not exist or overrides nothing.
   */
  packOverrides(pack: string): string[] {
    const prefix = `${pack}/`;
    return [...this.templates.keys()]
      .filter((id) => id.startsWith(prefix) && this.templates.has(id.slice(prefix.length)))
      .map((id) => id.slice(prefix.length))
      .sort();
  }
  /** Template packs present: first path segments that override some base template, sorted. */
  packs(): string[] {
    const heads = new Set([...this.templates.keys()].flatMap((id) => (id.includes("/") ? [id.split("/")[0]!] : [])));
    return [...heads].filter((p) => this.packOverrides(p).length > 0).sort();
  }
  find(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }
  list(): PromptTemplate[] {
    return [...this.templates.values()];
  }
  /** Adapter for renderTemplate's `partials` option. */
  partials = (name: string): string | undefined => this.templates.get(name)?.body;
}
