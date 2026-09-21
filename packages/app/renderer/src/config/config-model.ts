/**
 * The Config surface's arithmetic: a flat schema description and a parsed document in, the
 * form's sections and fields out — plus the draft-to-patch diff and where a validation
 * error belongs.
 *
 * It is a plain module with a plain test, for the reason `card-model.ts` and
 * `announcements.ts` are: what is most likely to be wrong on this screen is not the markup
 * but the mapping between three different spellings of the same place — a schema path
 * (`agents[].id`, written once for the element type), a document path (`agents[0].id`, one
 * per element), and whatever notation the daemon used when it reported an error against it.
 *
 * Four decisions worth knowing before changing anything here:
 *
 * - **The schema describes the type, the document supplies the repetition.** `agents[]` is
 *   written once; the form repeats its fields for each element the document holds, and a
 *   document with no `agents:` key draws the section with no cards rather than one empty
 *   one. Nothing is invented for a key that is not there (RULES.md rule 12).
 * - **A draft is the edited paths and nothing else.** Not a copy of the document: a copy
 *   would have to decide what every untouched key is, which is exactly the decision that
 *   materialises schema defaults into a file nobody asked to rewrite. `patchFrom` drops an
 *   edit that is back to the document's own value, so typing a character and deleting it
 *   leaves "0 changes".
 * - **An edit to `undefined` deletes the key.** That is `ConfigPatchEntry`'s contract — a
 *   cleared optional field wants the key gone so the default comes back, and writing `null`
 *   would be a value the schema has to reject.
 * - **A node the schema cannot describe is shown, read-only, as its JSON.** `unknown` is an
 *   honest answer from the daemon's schema walker, and a form that guessed a control for it
 *   would be a form that wrote a value it could not type-check. The raw view is where those
 *   are edited.
 */
import type {
  ConfigFieldDescription,
  ConfigPatchEntry,
  ConfigSchemaDescription,
  ConfigValidationError,
  EffectiveAgentPolicy,
  EffectivePermissionRule,
} from "@orca/protocol";

/* ---------------------------------------------------------------- paths -- */

/**
 * One dotted path in the one notation this surface keys everything by: array indices in
 * brackets. Both spellings arrive — the schema writes `agents[]`, a daemon error may say
 * `hosts.1.type` and `config.set` accepts either — and an error keyed one way would sit on
 * no field at all if the fields were keyed the other.
 */
export function normalizePath(path: string): string {
  return path.split(".").reduce<string>((acc, segment) => {
    if (acc === "") return segment;
    return /^\d+$/.test(segment) ? `${acc}[${segment}]` : `${acc}.${segment}`;
  }, "");
}

/** The segments of a path: names as strings, indices as numbers. */
export function segmentsOf(path: string): readonly (string | number)[] {
  const segments: (string | number)[] = [];
  for (const part of path.split(".")) {
    const [name, ...indices] = part.split("[");
    if (name !== undefined && name !== "") segments.push(name);
    for (const index of indices) {
      const digits = index.replace("]", "");
      // `[]` is the schema's "one element of this array" and addresses nothing in a
      // document, so it contributes no segment.
      if (digits !== "") segments.push(Number(digits));
    }
  }
  return segments;
}

/** The value a path addresses in a parsed document, or undefined when nothing is there. */
export function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of segmentsOf(path)) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** The last named segment — what a field is labelled by. */
export function lastSegment(path: string): string {
  const segments = segmentsOf(path);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (typeof segment === "string") return segment;
  }
  return path;
}

/**
 * A key as a label: sentence case, the spec's everywhere-rule (RULES.md rule 13).
 * `storeDir` reads "Store dir", `humanInput` reads "Human input". The key itself is still
 * on the field in mono, so nothing is lost by making the label a phrase.
 */
export function sentenceCase(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/* ----------------------------------------------------------------- form -- */

/** The controls the form draws. `unknown` is not one of them — it is a `RawNode`. */
export type FieldKind = "text" | "number" | "toggle" | "enum";

export interface FieldNode {
  node: "field";
  kind: FieldKind;
  /** The document path, with indices: `agents[0].id`. This is what a patch names. */
  path: string;
  /** The schema path, with the element type written once: `agents[].id`. */
  schemaPath: string;
  label: string;
  required: boolean;
  help?: string;
  choices?: readonly string[];
  /** The document's value. Absent means the key is not in the file. */
  value?: unknown;
  /** The schema's default, shown as the placeholder rather than written into the file. */
  default?: unknown;
}

/** An array element or a nested object: a heading and the fields under it. */
export interface GroupNode {
  node: "group";
  path: string;
  label: string;
  /** True for an array element, which is drawn as a `Card` rather than as a sub-heading. */
  card: boolean;
  children: readonly FormNode[];
}

/** Something the schema does not describe, shown as its JSON and edited in the raw view. */
export interface RawNode {
  node: "raw";
  path: string;
  label: string;
  json: string;
  /** Why it is read-only here, in words, because a disabled thing with no reason reads as broken. */
  reason: string;
}

export type FormNode = FieldNode | GroupNode | RawNode;

export interface FormSection {
  /** The top-level key, or `general` for the scalars that have no section of their own. */
  id: string;
  title: string;
  nodes: readonly FormNode[];
}

/** The section the top-level scalars land in; a heading each would be seven headings of one row. */
export const GENERAL_SECTION = "general";

const SCALAR_KINDS: Partial<Record<ConfigFieldDescription["type"], FieldKind>> = {
  string: "text",
  number: "number",
  boolean: "toggle",
  enum: "enum",
};

/** The schema entries directly under `prefix` — one level, not the whole subtree. */
function childrenOf(schema: ConfigSchemaDescription, prefix: string): readonly ConfigFieldDescription[] {
  const head = prefix === "" ? "" : `${prefix}.`;
  return schema.filter((description) => {
    if (!description.path.startsWith(head)) return false;
    const rest = description.path.slice(head.length);
    return rest !== "" && !rest.includes(".") && !rest.includes("[");
  });
}

const jsonOf = (value: unknown): string => JSON.stringify(value ?? null, null, 2);

const raw = (path: string, label: string, value: unknown, reason: string): RawNode => ({
  node: "raw",
  path,
  label,
  json: jsonOf(value),
  reason,
});

/**
 * One schema node as the form draws it, against the value the document has there.
 *
 * `documentPath` and `description.path` diverge exactly at an array: the description is of
 * the element type and is written once, the document path carries the index.
 */
function buildNode(
  schema: ConfigSchemaDescription,
  description: ConfigFieldDescription,
  documentPath: string,
  value: unknown,
  label: string,
): FormNode {
  const scalar = SCALAR_KINDS[description.type];
  if (scalar) {
    return {
      node: "field",
      kind: scalar,
      path: documentPath,
      schemaPath: description.path,
      label,
      required: description.required,
      ...(description.help === undefined ? {} : { help: description.help }),
      ...(description.enum === undefined ? {} : { choices: description.enum }),
      ...(value === undefined ? {} : { value }),
      ...(description.default === undefined ? {} : { default: description.default }),
    };
  }

  if (description.type === "object") {
    const children = childrenOf(schema, description.path);
    if (children.length === 0) {
      return raw(documentPath, label, value, "the schema does not describe the keys of this object");
    }
    return {
      node: "group",
      path: documentPath,
      label,
      card: false,
      children: children.map((child) =>
        buildNode(
          schema,
          child,
          `${documentPath}.${lastSegment(child.path)}`,
          valueAt(value, lastSegment(child.path)),
          sentenceCase(lastSegment(child.path)),
        ),
      ),
    };
  }

  if (description.type === "array") {
    const element = schema.find((d) => d.path === `${description.path}[]`);
    if (!element || element.type === "unknown") {
      return raw(documentPath, label, value, "the schema does not describe what this array holds");
    }
    const elements = Array.isArray(value) ? value : [];
    return {
      node: "group",
      path: documentPath,
      label,
      card: false,
      children: elements.map((item, index) =>
        buildNode(schema, element, `${documentPath}[${index}]`, item, elementLabel(item, index)),
      ),
    };
  }

  if (description.type === "record") {
    const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
    return {
      node: "group",
      path: documentPath,
      label,
      card: false,
      children: keys.map((key) => {
        const entry = (value as Record<string, unknown>)[key];
        return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
          ? ({
              node: "field",
              kind: typeof entry === "number" ? "number" : typeof entry === "boolean" ? "toggle" : "text",
              path: `${documentPath}.${key}`,
              schemaPath: `${description.path}.<key>`,
              label: key,
              required: false,
              value: entry,
            } satisfies FieldNode)
          : raw(`${documentPath}.${key}`, key, entry, "the schema does not describe this entry");
      }),
    };
  }

  return raw(documentPath, label, value, "the schema cannot describe this key");
}

/** An array element's heading: its own id or name when it has one, its position when it does not. */
function elementLabel(item: unknown, index: number): string {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    for (const key of ["id", "name"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate !== "") return candidate;
    }
  }
  return `#${index + 1}`;
}

/**
 * The form: one section per top-level key of the schema, in the schema's order, with the
 * top-level scalars gathered into a `General` section in front of them.
 *
 * The order is the schema's and not a list written here, so a config that grows a key gets
 * a section without this file being edited — and a key this app has never heard of is
 * drawn rather than dropped.
 */
export function buildSections(schema: ConfigSchemaDescription, parsed: unknown): readonly FormSection[] {
  const general: FormNode[] = [];
  const sections: FormSection[] = [];

  for (const description of childrenOf(schema, "")) {
    const key = description.path;
    const node = buildNode(schema, description, key, valueAt(parsed, key), sentenceCase(key));
    if (node.node === "field") {
      general.push(node);
      continue;
    }
    sections.push({
      id: key,
      title: sentenceCase(key),
      // A group's own heading would repeat the section's, so the section takes its children.
      nodes: node.node === "group" ? node.children : [node],
    });
  }

  return general.length === 0
    ? sections
    : [{ id: GENERAL_SECTION, title: "General", nodes: general }, ...sections];
}

/**
 * Every path the form has a *field* at, so an error can be told whether it has one.
 *
 * A read-only JSON well is deliberately not one: it has no place to put an error message
 * and no control to mark invalid, so an error against it belongs in the list above the form
 * where it can be read, rather than attached to something that would not show it.
 */
export function fieldPaths(sections: readonly FormSection[]): ReadonlySet<string> {
  const paths = new Set<string>();
  const walk = (nodes: readonly FormNode[]): void => {
    for (const node of nodes) {
      if (node.node === "group") walk(node.children);
      else if (node.node === "field") paths.add(node.path);
    }
  };
  walk(sections.flatMap((section) => [...section.nodes]));
  return paths;
}

/* ---------------------------------------------------------------- draft -- */

/** The edited paths of one document. A missing key means "not edited"; `undefined` means "delete". */
export type Draft = ReadonlyMap<string, unknown>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The patch a draft is, against the document it was made on: the edits that still differ,
 * in the order they were made.
 *
 * An edit back to the document's own value is not a change, which is what makes "N changes"
 * a count of what would be written rather than of what was typed.
 */
export function patchFrom(draft: Draft, parsed: unknown): ConfigPatchEntry[] {
  const entries: ConfigPatchEntry[] = [];
  for (const [path, value] of draft) {
    if (same(value, valueAt(parsed, path))) continue;
    entries.push(value === undefined ? { path } : { path, value });
  }
  return entries;
}

/** "N changes", or "1 change". Sentence case, and a count that is a fact. */
export function changeLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

/* ----------------------------------------------------------- validation -- */

export interface PlacedErrors {
  /** By normalised document path — the form looks its field up here. */
  byPath: ReadonlyMap<string, string>;
  /** Errors naming a path no field draws. Listed at the top rather than swallowed. */
  unplaced: readonly ConfigValidationError[];
}

/**
 * Where the daemon's errors go. An error against a path the form does not draw — a key the
 * schema walker could not describe, a document-level failure with an empty path — is not
 * dropped: it is listed above the form, because an invalid file with no visible reason is
 * the worst state this screen can be in.
 */
export function placeErrors(
  errors: readonly ConfigValidationError[],
  drawn: ReadonlySet<string>,
): PlacedErrors {
  const byPath = new Map<string, string>();
  const unplaced: ConfigValidationError[] = [];
  for (const error of errors) {
    const path = normalizePath(error.path);
    if (path !== "" && drawn.has(path)) byPath.set(path, error.message);
    else unplaced.push(error);
  }
  return { byPath, unplaced };
}

/* ---------------------------------------------------------- permissions -- */

/** One row of an agent's effective policy, in evaluation order, with where it came from. */
export interface PermissionRow {
  /** Its position in the evaluated order, 1-based: first match wins, so the number means something. */
  order: number;
  /** `config` or `sidecar` — the word on the chip. The sidecar is not the YAML. */
  source: "config" | "sidecar";
  /** The rule as a sentence: "allow edit under src". */
  text: string;
  decision: EffectivePermissionRule["decision"];
  addedAt?: string;
  grantedFor?: string;
}

export interface AgentPolicyView {
  agentId: string;
  /** The fallthrough, which is configuration's alone — the sidecar carries none (ADR 0009). */
  default: EffectiveAgentPolicy["default"];
  rows: readonly PermissionRow[];
}

/**
 * What a rule matches, in words. The match is a set of optional narrowings and the honest
 * rendering of "no narrowings at all" is to say so rather than to draw an empty sentence.
 */
export function describeRule(rule: EffectivePermissionRule): string {
  const match = rule.match;
  const parts: string[] = [match.kind ?? "any tool call"];
  if (match.path !== undefined) parts.push(`at ${match.path}`);
  if (match.pathPrefix !== undefined) parts.push(`under ${match.pathPrefix}`);
  if (match.scope !== undefined) parts.push(`in the ${match.scope}`);
  if (match.titlePattern !== undefined) parts.push(`matching ${match.titlePattern}`);
  return `${rule.decision} ${parts.join(" ")}`;
}

/**
 * The effective policy per agent, in the daemon's evaluation order.
 *
 * The order is not re-derived here and must not be: `layerPermissionPolicies` produced it
 * and `decidePermission` matches first-wins down it, so a second opinion in a renderer
 * would be a second answer to "why was this allowed" (`config.ts` in `@orca/protocol`).
 * What this does is number the rows and name the document each came from.
 */
export function agentPolicies(effective: {
  agents: Readonly<Record<string, EffectiveAgentPolicy>>;
}): readonly AgentPolicyView[] {
  return Object.entries(effective.agents).map(([agentId, policy]) => ({
    agentId,
    default: policy.default,
    rows: policy.rules.map((rule, index) => ({
      order: index + 1,
      // The wire says which *document*; the surface says "sidecar" because that is what the
      // file is called everywhere else in ORCA (ADR 0009).
      source: rule.source === "permissions" ? "sidecar" : "config",
      text: describeRule(rule),
      decision: rule.decision,
      ...(rule.addedAt === undefined ? {} : { addedAt: rule.addedAt }),
      ...(rule.grantedFor === undefined ? {} : { grantedFor: rule.grantedFor }),
    })),
  }));
}

/* ------------------------------------------------------------- raw view -- */

/**
 * Which line of a document a path is on, 1-based, or undefined when it cannot be found.
 *
 * It is a scan for the key, not a YAML parse: the app may not import a YAML library it
 * does not already have, and the raw view's highlight is a navigation aid rather than a
 * claim about the document's structure. A path whose last key appears nowhere highlights
 * nothing, which is why this answers undefined rather than guessing line 1.
 */
export function lineOfPath(text: string, path: string): number | undefined {
  const key = lastSegment(path);
  const lines = text.split("\n");
  // JSON writes `"key":`, YAML writes `key:` — and a dash may lead the line in both.
  const pattern = new RegExp(`^\\s*(-\\s*)?"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*:`);
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? undefined : index + 1;
}
