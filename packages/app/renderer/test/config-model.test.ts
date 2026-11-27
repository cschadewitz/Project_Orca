/**
 * The Config surface's arithmetic, with no DOM: the schema-to-sections walk, the two
 * spellings of a path, the draft diff, where an error lands, and the effective policy's
 * order.
 *
 * These are the claims that a screen test would make badly. "The sidecar's rules come after
 * the config's" is a sentence about a list, and asserting it through a rendered document
 * would be asserting it through three layers of markup that have their own reasons to
 * change.
 */
import { describe, expect, it } from "vitest";
import {
  POLICY_LAYERS,
  agentPolicies,
  buildSections,
  changeLabel,
  describeRule,
  fieldPaths,
  lineOfPath,
  normalizePath,
  patchFrom,
  placeErrors,
  rowsFrom,
  sentenceCase,
  valueAt,
  type FieldNode,
  type FormSection,
  type GroupNode,
  type RawNode,
} from "../src/config/config-model.js";
import { CONFIG_GET, CONFIG_TEXT } from "./fixtures-config.js";

const sections = (): readonly FormSection[] => buildSections(CONFIG_GET.schema, CONFIG_GET.config.parsed);
const section = (id: string): FormSection => {
  const found = sections().find((s) => s.id === id);
  if (!found) throw new Error(`no section ${id}`);
  return found;
};

describe("paths", () => {
  it("has one spelling for an index, whichever spelling arrived", () => {
    // The schema writes `agents[].id`; a daemon error may say `hosts.1.type`. A form keyed
    // one way would put the other's errors on no field at all.
    expect(normalizePath("hosts.1.type")).toBe("hosts[1].type");
    expect(normalizePath("hosts[1].type")).toBe("hosts[1].type");
    expect(normalizePath("storeDir")).toBe("storeDir");
  });

  it("reads a value out of a parsed document, and answers undefined for a key that is not there", () => {
    const parsed = CONFIG_GET.config.parsed;
    expect(valueAt(parsed, "storeDir")).toBe(".orca");
    expect(valueAt(parsed, "agents[0].id")).toBe("claude");
    expect(valueAt(parsed, "agents[1].id")).toBeUndefined();
    expect(valueAt(parsed, "humanInput.mode")).toBeUndefined();
  });

  it("labels a key in sentence case", () => {
    expect(sentenceCase("storeDir")).toBe("Store dir");
    expect(sentenceCase("humanInput")).toBe("Human input");
    expect(sentenceCase("agents")).toBe("Agents");
  });
});

describe("the form", () => {
  it("is one section per top-level key, in the schema's order, with the scalars gathered first", () => {
    expect(sections().map((s) => s.id)).toEqual(["general", "agents", "humanInput"]);
    // `version` and `storeDir` are scalars: a heading each would be a heading per row.
    expect(section("general").nodes.map((node) => node.path)).toEqual(["version", "storeDir"]);
  });

  it("repeats the element type once per element the document holds, not once per schema entry", () => {
    /* `agents[]` is written once and the document has one agent, so there is one card. A
       document with three would draw three from the same description. */
    const cards = section("agents").nodes;
    expect(cards).toHaveLength(1);
    const card = cards[0] as GroupNode;
    expect(card.node).toBe("group");
    // Headed by the agent's own id rather than by "#1": ids are what config and runs use.
    expect(card.label).toBe("claude");
    expect(card.children.map((child) => child.path)).toEqual([
      "agents[0].id",
      "agents[0].command",
      "agents[0].driver",
      "agents[0].roles",
    ]);
  });

  it("draws a control per schema type, and reads the document's value into it", () => {
    const card = section("agents").nodes[0] as GroupNode;
    const id = card.children[0] as FieldNode;
    expect(id.kind).toBe("text");
    expect(id.value).toBe("claude");
    expect(id.required).toBe(true);
    // The schema path stays on the field: it is what says *which* description drew it.
    expect(id.schemaPath).toBe("agents[].id");

    const mode = section("humanInput").nodes[0] as FieldNode;
    expect(mode.kind).toBe("enum");
    expect(mode.choices).toEqual(["pause", "cli", "auto"]);
    // The document has no `humanInput:` block at all, and the form says so by having no
    // value rather than by pretending the default is written in the file.
    expect(mode.value).toBeUndefined();
  });

  it("shows what the schema cannot describe as read-only JSON, and says why", () => {
    const card = section("agents").nodes[0] as GroupNode;
    const roles = card.children[3] as RawNode;
    expect(roles.node).toBe("raw");
    expect(roles.json).toBe(JSON.stringify(["developer"], null, 2));
    expect(roles.reason).toContain("does not describe what this array holds");
  });

  it("lists every field path it drew, so an error can be told whether it has one", () => {
    expect([...fieldPaths(sections())]).toEqual([
      "version",
      "storeDir",
      "agents[0].id",
      "agents[0].command",
      "agents[0].driver",
      "humanInput.mode",
    ]);
  });
});

describe("the draft", () => {
  const parsed = CONFIG_GET.config.parsed;

  it("is the edits that still differ from the file", () => {
    const draft = new Map<string, unknown>([
      ["agents[0].command", "claude-code-next"],
      // Typed and typed back: not a change, and not something to send.
      ["storeDir", ".orca"],
    ]);
    expect(patchFrom(draft, parsed)).toEqual([{ path: "agents[0].command", value: "claude-code-next" }]);
  });

  it("deletes a key rather than writing null when a field is cleared", () => {
    const draft = new Map<string, unknown>([["storeDir", undefined]]);
    // No `value` at all: `ConfigPatchEntry` reads an omitted value as "remove this key",
    // which is what a cleared optional field wants — the default back, not a null.
    expect(patchFrom(draft, parsed)).toEqual([{ path: "storeDir" }]);
  });

  it("counts writes, not keystrokes", () => {
    expect(changeLabel(1)).toBe("1\u00a0change");
    expect(changeLabel(3)).toBe("3\u00a0changes");
  });
});

describe("validation errors", () => {
  it("go on their field, whichever notation the daemon used", () => {
    const drawn = new Set(["hosts[1].type"]);
    const placed = placeErrors([{ path: "hosts.1.type", message: "expected local or ssh" }], drawn);
    expect(placed.byPath.get("hosts[1].type")).toBe("expected local or ssh");
    expect(placed.unplaced).toEqual([]);
  });

  it("are listed at the top when they belong to no field, rather than swallowed", () => {
    const placed = placeErrors(
      [
        { path: "", message: "the document is not a mapping" },
        { path: "plugins.custom", message: "unknown key" },
      ],
      new Set(["storeDir"]),
    );
    expect(placed.byPath.size).toBe(0);
    expect(placed.unplaced.map((error) => error.message)).toEqual(["the document is not a mapping", "unknown key"]);
  });
});

describe("the effective permission policy", () => {
  it("keeps the daemon's evaluation order and names the document each rule came from", () => {
    const [policy, ...rest] = agentPolicies(CONFIG_GET.effective);
    expect(rest).toEqual([]);
    expect(policy!.agentId).toBe("claude");
    // Configured rules first, then the sidecar's: that is `layerPermissionPolicies`' order
    // and first-match-wins is what makes it the real precedence (ADR 0009).
    expect(policy!.rows.map((row) => [row.order, row.source])).toEqual([
      [1, "config"],
      [2, "sidecar"],
      [3, "sidecar"],
      // The third layer keeps its own word: it is not a document and nothing can edit it.
      [4, "default"],
    ]);
    // Provenance rides on the sidecar rows only.
    expect(policy!.rows[0]!.addedAt).toBeUndefined();
    expect(policy!.rows[1]!.grantedFor).toBe("Edit src/index.ts");
    // The fallthrough is configuration's; the sidecar cannot carry one.
    expect(policy!.default).toBe("allow");
  });

  it("keeps ORCA's defaults out of the config's rules, and groups them as their own layer", () => {
    const [policy] = agentPolicies(CONFIG_GET.effective);
    // The floor is not the config: a rule nobody wrote must not be reported as one a
    // person wrote (#140, and the bug ADR 0009's correction names).
    expect(rowsFrom(policy!, "config").map((row) => row.order)).toEqual([1]);
    expect(rowsFrom(policy!, "sidecar").map((row) => row.order)).toEqual([2, 3]);
    expect(rowsFrom(policy!, "default").map((row) => row.order)).toEqual([4]);
    // A default rule has no file and so no provenance to carry.
    expect(rowsFrom(policy!, "default")[0]!.grantedFor).toBeUndefined();
    // The layers are declared in evaluation order, so grouping by them reorders nothing.
    expect(POLICY_LAYERS.map((layer) => layer.source)).toEqual(["config", "sidecar", "default"]);
    expect(POLICY_LAYERS.filter((layer) => layer.editable).map((layer) => layer.source)).toEqual(["sidecar"]);
  });

  it("says what a rule matches in words, and says so when it narrows nothing", () => {
    expect(describeRule({ match: { kind: "edit", pathPrefix: "src" }, decision: "allow", source: "permissions" })).toBe(
      "allow edit under src",
    );
    expect(describeRule({ match: {}, decision: "ask", source: "config" })).toBe("ask any tool call");
  });
});

describe("the raw view's highlight", () => {
  it("finds the line a key is written on", () => {
    expect(lineOfPath(CONFIG_TEXT, "storeDir")).toBe(2);
    expect(lineOfPath(CONFIG_TEXT, "agents[0].command")).toBe(7);
  });

  it("answers nothing for a key the file does not contain, rather than guessing line 1", () => {
    expect(lineOfPath(CONFIG_TEXT, "humanInput.mode")).toBeUndefined();
  });
});
