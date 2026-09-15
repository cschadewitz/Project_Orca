/**
 * Markdown front matter helpers.
 *
 * Artifacts in the AI-SDLC (intent.md, spec.md, plan.md, ...) are markdown files
 * whose YAML front matter carries the machine-readable part: status, verdicts,
 * decomposition items, links to parent artifacts. ORCA reads that front matter
 * to drive decisions and loops without having to parse prose.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface FrontMatterDocument {
  data: Record<string, unknown>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontMatter(text: string): FrontMatterDocument {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text };
  const raw = parseYaml(m[1] ?? "") as unknown;
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { data, body: m[2] ?? "" };
}

export function serializeFrontMatter(doc: FrontMatterDocument): string {
  const fm = Object.keys(doc.data).length ? `---\n${stringifyYaml(doc.data).trimEnd()}\n---\n` : "";
  return fm + doc.body;
}

/** Try JSON first (for `.json` artifacts), then front matter. */
export function extractStructuredData(text: string, mediaType?: string): Record<string, unknown> {
  if (mediaType === "application/json" || text.trimStart().startsWith("{")) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through to front matter */
    }
  }
  return parseFrontMatter(text).data;
}
