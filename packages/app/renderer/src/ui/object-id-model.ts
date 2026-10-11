/**
 * How an ORCA id is read for a person: which kind of object it names, and the handful of
 * its characters that tell it apart from its neighbours. The arithmetic half of
 * `ObjectId` (`object-id.tsx`), kept plain so it has a plain test.
 *
 * **The tail, not the head.** A minted id is `<prefix>_<ULID>` (`packages/core/src/ids.ts`),
 * and a ULID's first ten characters are its millisecond timestamp — so ids minted together,
 * which is every id one decomposition or one run writes, are identical at the start:
 * `wi_01M4M899VKJZRZSBHNDY5M579G` and `wi_01M4M899VK0SNP2F9P560F9G7S`. A cell that truncated
 * at the end kept exactly the half that does not differ. The random tail is what does, so
 * that is what a row shows.
 *
 * **Six characters, for every format.** Thirty bits of a Crockford tail and twenty-four of a
 * UUID's hex, which is a repeat among two hundred ids of one kind well under one time in a
 * thousand. The rest of that chance is `uniqueTails`'s: a list that does hold two ids with
 * one tail lengthens just those two until they differ, suffix-preserving, so the longer tail
 * still ends in the six a person may already have read.
 *
 * **The whole id is one action away**, never gone: the token carries it in `title`, the
 * object header's crumb menu copies it, the detail panes print it (`variant="full"`), and the
 * palette matches any part of it.
 */
import { OBJECT_KIND_PRESENTATION, OBJECT_KINDS, type ObjectKind } from "@orca/design";

/** The tail a row shows: six characters of every id format (see the file header). */
export const TAIL_LENGTH = 6;

/**
 * How the part after the prefix was minted, as far as the string can say.
 *
 * - `ulid` — `newId`: 26 Crockford characters, the first ten a timestamp.
 * - `keyed` — `keyedId`: 26 Crockford characters hashed from a key (a risk's, a decision's,
 *   a dependency's), with no time in them. Told from a ULID by its first ten characters not
 *   reading as a time this century; one in a few hundred would, and nothing is drawn
 *   differently for it, so the guess costs nothing when it is wrong.
 * - `uuid` — a run admitted through `requests.submit` or a direct launch: `run_<uuid>`.
 * - `opaque` — anything else: a slug, a test fixture's `run-42`, an id from a newer daemon.
 *   Its tail is taken the same way, and it is never an error.
 */
export type IdFormat = "ulid" | "uuid" | "keyed" | "opaque";

export interface ParsedId {
  /** The id, verbatim. */
  id: string;
  /** `run`, `wi`, … — what is before the first `_`, when that is a lower-case word. */
  prefix: string | undefined;
  /** The object kind the prefix names, when it names one (`OBJECT_KIND_PRESENTATION`). */
  kind: ObjectKind | undefined;
  /** What follows the prefix — the whole id when there is none. */
  body: string;
  format: IdFormat;
  /** The last `n` characters of the body, or the whole body when it is no longer than that. */
  tail(n?: number): string;
}

const PREFIX = /^([a-z]+)_(.+)$/;
const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 2000-01-01 and 2100-01-01: the window a ULID minted by ORCA lands in. */
const MINTED_FROM = Date.UTC(2000, 0, 1);
const MINTED_UNTIL = Date.UTC(2100, 0, 1);

const KIND_BY_PREFIX: ReadonlyMap<string, ObjectKind> = new Map(
  OBJECT_KINDS.map((kind) => [OBJECT_KIND_PRESENTATION[kind].prefix, kind]),
);

/** The kind an id's own prefix names, or undefined. */
export function kindOfPrefix(prefix: string | undefined): ObjectKind | undefined {
  return prefix === undefined ? undefined : KIND_BY_PREFIX.get(prefix);
}

function decodeTime(body: string): number {
  let ms = 0;
  for (const char of body.slice(0, 10).toUpperCase()) ms = ms * 32 + ENCODING.indexOf(char);
  return ms;
}

function formatOf(body: string): IdFormat {
  if (UUID.test(body)) return "uuid";
  if (!CROCKFORD.test(body)) return "opaque";
  const at = decodeTime(body);
  return at >= MINTED_FROM && at < MINTED_UNTIL ? "ulid" : "keyed";
}

export function parseId(id: string): ParsedId {
  const match = PREFIX.exec(id);
  const prefix = match?.[1];
  const body = match?.[2] ?? id;
  return {
    id,
    prefix,
    kind: kindOfPrefix(prefix),
    body,
    format: formatOf(body),
    tail: (n = TAIL_LENGTH) => (body.length <= n ? body : body.slice(-n)),
  };
}

/**
 * The tail each id in a list is drawn with: six characters, unless another id *in the same
 * list* ends in the same six, in which case both grow — one character at a time, from the
 * front, so the longer tail still ends in the shorter — until they differ or one of them runs
 * out of characters.
 *
 * Over the whole list's data, not the rows on screen: a virtualised list draws a window, and
 * two rows that collide only when both are in view would change length as a person scrolled.
 * Duplicates of one id are one id. A collision this has to resolve should almost never
 * happen (see the file header); it is here so that when it does, two rows never look alike.
 */
export function uniqueTails(ids: Iterable<string>, n: number = TAIL_LENGTH): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const id of ids) if (!bodies.has(id)) bodies.set(id, parseId(id).body);

  const length = new Map<string, number>();
  for (const id of bodies.keys()) length.set(id, n);

  const tailOf = (id: string): string => {
    const body = bodies.get(id)!;
    const k = length.get(id)!;
    return body.length <= k ? body : body.slice(-k);
  };

  /* Each pass groups the ids still in play by their current tail and lengthens every id
     in a group of two or more. A group stops growing once none of its ids has a character
     left to add — two ids with one body and two prefixes (`run_X`, `req_X`) end there, and
     their kind glyphs tell them apart. */
  let open = [...bodies.keys()];
  while (open.length > 1) {
    const groups = new Map<string, string[]>();
    for (const id of open) {
      const tail = tailOf(id);
      groups.set(tail, [...(groups.get(tail) ?? []), id]);
    }
    const next: string[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const growable = group.filter((id) => length.get(id)! < bodies.get(id)!.length);
      if (growable.length === 0) continue;
      for (const id of growable) length.set(id, length.get(id)! + 1);
      next.push(...group);
    }
    open = next;
  }

  const tails = new Map<string, string>();
  for (const id of bodies.keys()) tails.set(id, tailOf(id));
  return tails;
}

/** The kind an id is drawn as: the caller's, else its prefix's. */
export function kindOf(id: string, kind?: ObjectKind): ObjectKind | undefined {
  return kind ?? parseId(id).kind;
}

/**
 * The token as plain text — `☰ 7X8PXX` — for the places a token has to be one string: a
 * palette label and its confirmation, a menu item's hint. `labelMachine` and `hintMachine`
 * hand that string back to `IdToken`, which draws the glyph as decoration again
 * (`parseIdText`). Without a kind there is no glyph, and the tail stands alone.
 */
export function idText(id: string, options: { kind?: ObjectKind; tail?: string } = {}): string {
  const kind = kindOf(id, options.kind);
  const tail = options.tail ?? parseId(id).tail();
  return kind === undefined ? tail : `${OBJECT_KIND_PRESENTATION[kind].glyph} ${tail}`;
}

/**
 * The token as a person hears it — "run 7X8PXX" — for an accessible name and for a sentence
 * said through the app's live region. The glyph is never spoken: it would be read as
 * "trigram for heaven".
 */
export function idWords(id: string, options: { kind?: ObjectKind; tail?: string } = {}): string {
  const kind = kindOf(id, options.kind);
  const tail = options.tail ?? parseId(id).tail();
  return kind === undefined ? tail : `${OBJECT_KIND_PRESENTATION[kind].word} ${tail}`;
}

const KIND_BY_GLYPH: ReadonlyMap<string, ObjectKind> = new Map(
  OBJECT_KINDS.map((kind) => [OBJECT_KIND_PRESENTATION[kind].glyph, kind]),
);

/**
 * `idText`'s string read back into its kind and tail, or undefined when it is not one — a
 * decision key, a path, a version. A token is exactly one kind glyph, one space and a tail
 * with no space in it.
 */
export function parseIdText(text: string): { kind: ObjectKind; tail: string } | undefined {
  const [glyph, ...rest] = [...text];
  if (glyph === undefined || rest[0] !== " ") return undefined;
  const kind = KIND_BY_GLYPH.get(glyph);
  const tail = rest.slice(1).join("");
  if (kind === undefined || tail === "" || /\s/.test(tail)) return undefined;
  return { kind, tail };
}
