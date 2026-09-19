/**
 * "Typing a bare run id or an `orca://` URL jumps straight to it"
 * (docs/design/10-information-architecture.md). This is the recognising half: it turns a
 * query into the canonical `orca://` URL the person meant, or into nothing. Resolving that
 * URL to a surface and a selection is the route table in #165, which is why this hands
 * back a URL rather than a destination.
 *
 * A run id is `run_` and 26 Crockford base32 characters (`packages/core/src/ids.ts`).
 * The prefix may be left off — it is the part a person retypes wrong — but the 26
 * characters may not, so no ordinary word is ever mistaken for an id.
 */

const CROCKFORD = "[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}";
const RUN_ID = new RegExp(`^(?:run_)?(${CROCKFORD})$`, "i");

export interface JumpTarget {
  /** The canonical `orca://` URL, which is what #165 resolves. */
  url: string;
  /** What the palette row says, sentence case, subject first. */
  label: string;
  /** The id or path, rendered mono: ORCA produced it (docs/design/RULES.md rule 8). */
  detail: string;
}

/** The `orca://` URL a query means, or undefined when it means no single object. */
export function parseJump(query: string): JumpTarget | undefined {
  const text = query.trim();
  if (!text) return undefined;

  const runId = RUN_ID.exec(text)?.[1];
  // Ids are opaque but not case-sensitive to a person retyping one; canonicalise to the
  // upper case the generator emits rather than passing on whatever was typed.
  if (runId)
    return { url: `orca://run/run_${runId.toUpperCase()}`, label: "Open run", detail: `run_${runId.toUpperCase()}` };

  if (/^orca:\/\/\S+$/i.test(text)) return { url: text, label: "Open link", detail: text };

  return undefined;
}
