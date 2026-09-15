/**
 * The deliverables block.
 *
 * Every rendered prompt ends with a machine-readable list of the artifacts the
 * step must produce. Agents (and humans) can read it; ORCA's watcher uses the
 * same list to know which files to wait for. The scripted test agent parses it
 * to know what to write.
 *
 *   <!-- orca:deliverables
 *   - kind: spec
 *     path: /abs/workspace/.orca/work/auth-api/spec.md
 *     required: true
 *   -->
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const DeliverableSchema = z.object({
  kind: z.string(),
  name: z.string().optional(),
  path: z.string(),
  required: z.boolean().default(true),
  mediaType: z.string().optional(),
  /** Human-facing constraints copied from ArtifactValidation. */
  requiredFields: z.array(z.string()).optional(),
  fieldValues: z.record(z.string(), z.array(z.string())).optional(),
});
export type Deliverable = z.infer<typeof DeliverableSchema>;

const OPEN = "<!-- orca:deliverables";
const CLOSE = "-->";

export function renderDeliverablesBlock(items: Deliverable[]): string {
  if (items.length === 0) return "";
  const human = items
    .map((d) => {
      const bits = [`**${d.kind}** at \`${d.path}\`${d.required ? "" : " (optional)"}`];
      if (d.requiredFields?.length) bits.push(`front matter must include: ${d.requiredFields.join(", ")}`);
      if (d.fieldValues) for (const [k, vs] of Object.entries(d.fieldValues)) bits.push(`\`${k}\` must be one of: ${vs.join(" | ")}`);
      return `- ${bits.join("; ")}`;
    })
    .join("\n");
  return `## Deliverables\n\nWhen you are done, make sure these files exist with the described content. ORCA reads them to continue the workflow.\n\n${human}\n\n${OPEN}\n${stringifyYaml(items).trimEnd()}\n${CLOSE}\n`;
}

export function parseDeliverablesBlock(text: string): Deliverable[] {
  const start = text.lastIndexOf(OPEN);
  if (start < 0) return [];
  const end = text.indexOf(CLOSE, start);
  if (end < 0) return [];
  const yaml = text.slice(start + OPEN.length, end);
  const raw = parseYaml(yaml) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => DeliverableSchema.parse(r));
}
