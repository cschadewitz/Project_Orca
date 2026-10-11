/**
 * Nothing prints a raw id: an id in a row or a header goes through `ObjectId`
 * (docs/design/RULES.md rule 8).
 *
 * A raw ULID printed in a row is 26 characters whose first ten are the same for every id
 * minted that millisecond, and a cell that truncated it at its end kept exactly the half that
 * does not differ. `ObjectId` draws the name and a token — the kind's glyph and the last six
 * characters — with the whole id one action away. The way that regresses is a surface writing
 * `{claim.owner.runId}` as a JSX child again, so that is what this looks for, in source, the
 * way `status-chip-width.test.tsx` looks for a hand-rolled chip: comments stripped first,
 * because several explain why a thing is *not* printed raw, and that is the argument rather
 * than the markup.
 *
 * Two shapes are a raw id rendered as a child:
 *
 * - `{x.runId}` (or `workItemId`, `requestId`, `stepRunId`, `eventId`), alone or as one side
 *   of `??` or `:` — a JSX expression container. Prettier writes these with no space inside
 *   the braces, and an object literal or a destructuring with one (`{ runId }`), which is how
 *   the two are told apart without a parser.
 * - `` {`Run ${x.runId}`} `` — a template literal as the whole child.
 *
 * An attribute (`key={…runId}`, `onClick={() => open(…runId)}`) is preceded by `=` and is not
 * a child; neither is a `${…}` inside a string that never reaches the screen as text.
 *
 * The second half holds the vocabulary together: every id prefix `packages/core/src/ids.ts`
 * mints is either a kind `ObjectId` knows how to draw (`objectKind` in semantics.json) or on
 * an explicit list of prefixes no screen shows, each with the reason it shows none. A new
 * prefix in core fails here until somebody decides which it is.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { OBJECT_KIND_PRESENTATION, OBJECT_KINDS } from "@orca/design";

// `node:path` rather than `new URL(relative, import.meta.url)` — the happy-dom trap
// `type-notes.ts` documents.
const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = join(here, "..", "src");
const idsSource = readFileSync(join(here, "..", "..", "..", "core", "src", "ids.ts"), "utf8");

/** Every `.tsx` under `renderer/src`, by path from there. */
function sources(): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx"))
        found.push({ name: relative(rendererSrc, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
    }
  };
  walk(rendererSrc);
  return found;
}

/** Block comments, JSX comments and line comments — but not the `//` in `orca://`. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * `runId`, `workItemId`, `requestId`, `stepRunId`, `eventId` — and any name that ends in one,
 * `parentRunId`, `producedByStepRunId`, because those hold the same ids.
 */
const ID_FIELD = "\\w*(?:[rR]unId|[wW]orkItemId|[rR]equestId|[eE]ventId)";
/** `{x.runId}`, `{a ?? x.runId}`, `{cond ? y : x.runId}` — a child expression, not `={…}` and not `{ runId }`. */
const CHILD_EXPRESSION = new RegExp(`(?<![=$\\w])\\{(?! )[^{}\\n]*\\b${ID_FIELD}!?\\}`, "g");
/** `` {`… ${x.runId} …`} `` — a template literal that is the whole child. */
const CHILD_TEMPLATE = new RegExp(`(?<![=$\\w])\\{\`[^\`]*\\$\\{[^}]*\\b${ID_FIELD}\\b[^}]*\\}[^\`]*\`\\}`, "g");

/** Every place a source renders one of the id fields as a child, as `file: match`. */
function rawIds(files: readonly { name: string; text: string }[]): string[] {
  return files.flatMap((file) => {
    const bare = stripComments(file.text);
    return [...bare.matchAll(CHILD_EXPRESSION), ...bare.matchAll(CHILD_TEMPLATE)].map(
      (match) => `${file.name}: ${match[0]}`,
    );
  });
}

describe("a raw id rendered as a JSX child", () => {
  it("is caught, in both shapes, and an attribute or an object literal is not", () => {
    /* The guard below passing means nothing unless it can fail: these are the shapes it was
       written against, a few of them lifted from what the surfaces used to say. */
    const caught = rawIds([
      {
        name: "bad.tsx",
        text: [
          "<span>{claim.owner.name ?? claim.owner.runId}</span>",
          "<span className={`orca-plan__id`}>{item.requestId}</span>",
          "<button>{item.claim!.runId}</button>",
          "<Text>Run: {entry.summary.target.runId}</Text>",
          "<Chip>{`request ${item.requestId}`}</Chip>",
          "<span>{current.producedByStepRunId}</span>",
        ].join("\n"),
      },
    ]);
    expect(caught).toHaveLength(6);

    const clean = rawIds([
      {
        name: "good.tsx",
        text: [
          "<Row key={`${claim.workItemId}:${claim.owner.runId}`} onOpen={() => open(item.runId)} />",
          "const { runId } = props;",
          "call({ runId });",
          '<ObjectId id={claim.owner.runId} kind="run" />',
          "/* {claim.owner.runId} in a comment is an argument, not markup */",
          "const label = `Cancel ${runId}`;",
        ].join("\n"),
      },
    ]);
    expect(clean).toEqual([]);
  });

  it("appears nowhere in the renderer: every id goes through ObjectId", () => {
    expect(rawIds(sources())).toEqual([]);
  });
});

/**
 * The prefixes core mints that no screen shows as an id, and why. A prefix leaves this list
 * the day a surface starts showing one — and then it needs a kind in semantics.json, a glyph
 * and a word, before it can be drawn.
 */
const NEVER_DISPLAYED: Readonly<Record<string, string>> = {
  wf: "A workflow is shown by its own id, which is a slug a person chose (`ai-sdlc`), not a minted one.",
  art: "An artifact is shown by its name and version, `spec.md@v3`.",
  sess: "An agent session is the agent's business; no screen addresses one.",
  orc: "An orchestrator instance holds a run's lease; the app shows the lease's state, not its holder.",
  tpl: "A prompt template is shown by its name.",
  host: "An agent host is shown by the name its configuration gives it.",
  plan: "A plan is shown by its title; there is one per store.",
  dep: "A dependency is shown by what it points at — a work item, a decision, an external key.",
  risk: "A risk is shown by its key.",
  dec: "A decision is shown by its key.",
  pev: "A plan journal entry is shown by its sequence number and what it recorded.",
};

/** The members of `IdPrefix`, read out of core's source: `| "req" // Request`. */
function mintedPrefixes(): string[] {
  // Comments first: one of them ("Orchestrator instance; the holder…") has a semicolon in it.
  const union = /export type IdPrefix =([\s\S]*?);/.exec(stripComments(idsSource))?.[1] ?? "";
  return [...union.matchAll(/"([a-z]+)"/g)].map((match) => match[1]!);
}

describe("the id prefixes core mints", () => {
  it("are each a kind ObjectId draws or on the list of prefixes no screen shows", () => {
    const minted = mintedPrefixes();
    expect(minted.length, "could not read IdPrefix out of packages/core/src/ids.ts").toBeGreaterThan(10);
    const drawn = new Set(OBJECT_KINDS.map((kind) => OBJECT_KIND_PRESENTATION[kind].prefix));
    const undecided = minted.filter((prefix) => !drawn.has(prefix) && NEVER_DISPLAYED[prefix] === undefined);
    expect(undecided, "a prefix with no kind and no reason to be hidden").toEqual([]);
  });

  it("are never both drawn and hidden, and the lists name nothing core does not mint", () => {
    const minted = new Set(mintedPrefixes());
    const drawn = OBJECT_KINDS.map((kind) => OBJECT_KIND_PRESENTATION[kind].prefix);
    expect(drawn.filter((prefix) => NEVER_DISPLAYED[prefix] !== undefined)).toEqual([]);
    expect(drawn.filter((prefix) => !minted.has(prefix))).toEqual([]);
    expect(Object.keys(NEVER_DISPLAYED).filter((prefix) => !minted.has(prefix))).toEqual([]);
  });
});
