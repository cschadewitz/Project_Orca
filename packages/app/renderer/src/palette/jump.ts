/**
 * "Typing a bare run id or an `orca://` URL jumps straight to it"
 * (docs/design/10-information-architecture.md). This is the recognising half: it turns a
 * query into the canonical `orca://` URL the person meant, or into nothing. Resolving that
 * URL to a surface and a selection is `../route-table.ts` (#165), which is why this hands
 * back a URL rather than a destination.
 *
 * A run id comes in two shapes, and both are recognised:
 *
 * - `run_` and 26 Crockford base32 characters — `newId("run")` in `packages/core/src/ids.ts`,
 *   which is every run a workflow spawns. The prefix may be left off, because it is the part
 *   a person retypes wrong, but the 26 characters may not, so no ordinary word is ever
 *   mistaken for an id. Canonicalised to the upper case the generator emits.
 * - `run_` and a UUID — every run admitted through `requests.submit` or a direct launch
 *   (`packages/engine/src/direct-admission.ts`, `program/request-submission.ts`). These could
 *   not be jumped to at all until this recognised them. **The prefix is required** here: a
 *   bare UUID is just as likely an intent, an admission or an operation id, and sending one
 *   of those to the Runs surface would be a guess dressed as a jump. Canonicalised to the
 *   lower case `randomUUID` emits.
 */

const CROCKFORD = "[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_ULID = new RegExp(`^(?:run_)?(${CROCKFORD})$`, "i");
const RUN_UUID = new RegExp(`^run_(${UUID})$`, "i");

export interface JumpTarget {
  /** The canonical `orca://` URL, which is what the route table resolves. */
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

  // Ids are opaque but not case-sensitive to a person retyping one; canonicalise to the
  // case the generator emits rather than passing on whatever was typed.
  const ulid = RUN_ULID.exec(text)?.[1];
  if (ulid) return openRun(`run_${ulid.toUpperCase()}`);
  const uuid = RUN_UUID.exec(text)?.[1];
  if (uuid) return openRun(`run_${uuid.toLowerCase()}`);

  if (/^orca:\/\/\S+$/i.test(text)) return { url: text, label: "Open link", detail: text };

  return undefined;
}

function openRun(runId: string): JumpTarget {
  return { url: `orca://run/${runId}`, label: "Open run", detail: runId };
}
