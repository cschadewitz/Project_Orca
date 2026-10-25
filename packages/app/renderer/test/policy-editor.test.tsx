// @vitest-environment happy-dom
/**
 * The permission policy editor (#176): the arithmetic of the sidecar, and the panel over it.
 *
 * The plain-module half is first and is the half that matters most. What a screen test
 * cannot easily see is whether the *bytes* that go back are a document the daemon will take
 * — the right key order, no `default`, and every row nobody touched carrying the provenance
 * it arrived with — so those are asserted against `PermissionPolicyFileSchema` itself, which
 * is the schema `replacePermissionPolicyFile` parses a `config.set` with.
 *
 * The screen half then asserts the three things the editor promises: the configured rules
 * are shown and cannot be edited here, the written ones can, and a refused write keeps the
 * draft — then that a save writes the edited agents onto the file as it is, so a grant the
 * daemon wrote meanwhile survives it, and then where keyboard focus goes when a grant leaves
 * the list holding it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PermissionPolicyFileSchema, type ConfigSetParams } from "@orca/protocol";
import { ConfigProvider } from "../src/config/config-context.js";
import { PolicyPanel } from "../src/config/policy-editor.js";
import {
  EMPTY_SIDECAR,
  HAND_GRANT,
  composeGrants,
  grantKeys,
  grantsAfterWrite,
  handRule,
  parseSidecar,
  rebaseGrants,
  ruleChanges,
  rulesOf,
  serializeSidecar,
  sidecarRuleWarning,
  withGrantEdit,
  withMatch,
  withRules,
  type SidecarDocument,
  type SidecarRule,
} from "../src/config/policy-model.js";
import { CONFIG_GET, PERMISSIONS_REVISION, PERMISSIONS_TEXT } from "./fixtures-config.js";
import { AS_OF, HELLO_READ_ONLY } from "./fixtures.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

describe("the sidecar as a document", () => {
  const doc = (): SidecarDocument => {
    const parsed = parseSidecar(PERMISSIONS_TEXT);
    if (!parsed) throw new Error("the fixture sidecar does not parse");
    return parsed;
  };

  it.each([
    {},
    { path: "src/index.ts" },
    { kind: "read" },
    { kind: "read", scope: "outside-workspace" },
    { kind: "read", path: "src/.." },
    { kind: "read", pathPrefix: "." },
    { kind: "read", titlePattern: ".*" },
    { kind: "read", titlePattern: "^" },
    { kind: "read", titlePattern: "$" },
    { kind: "read", titlePattern: "" },
    { kind: "read", path: "./src/../" },
    { kind: "execute", scope: "workspace", path: "src/index.ts" },
    { kind: "execute", titlePattern: "^.*$" },
  ] satisfies SidecarRule["match"][])("explains an ignored wildcard allow: %j", (match) => {
    expect(sidecarRuleWarning({ match, decision: "allow" })).toContain("ignored");
    // Restrictions must remain effective, however broad their match is.
    expect(sidecarRuleWarning({ match, decision: "deny" })).toBeUndefined();
    expect(sidecarRuleWarning({ match, decision: "ask" })).toBeUndefined();
  });

  it.each([
    { kind: "read", path: "src/index.ts" },
    { kind: "edit", pathPrefix: "src" },
    { kind: "read", scope: "workspace" },
    { kind: "read", path: "/" },
    { kind: "read", path: "C:\\src\\.." },
    { kind: "read", pathPrefix: "../src/.." },
    { kind: "read", path: "\\\\server\\share" },
    { kind: "read", path: "src/..", titlePattern: "^Read file$" },
    { kind: "execute", scope: "outside-workspace", titlePattern: "^git status$" },
    { kind: "execute", titlePattern: "^git status$" },
    { kind: "read", titlePattern: "[" }, // Invalid regex is not a wildcard; schema validation is separate.
  ] satisfies SidecarRule["match"][])("does not label a non-wildcard rule ignored: %j", (match) => {
    expect(sidecarRuleWarning({ match, decision: "allow" })).toBeUndefined();
  });

  it("reads the fixture's two grants, in the order the file holds them", () => {
    const rules = rulesOf(doc(), "claude");
    expect(rules).toHaveLength(2);
    expect(rules[0]!.match.pathPrefix).toBe("src");
    expect(rules[1]!.grantedFor).toBe("Run git status");
  });

  it("reads no file as the empty document, and a broken one as nothing at all", () => {
    // An absent sidecar is an ordinary state: nobody has answered "always" here yet.
    expect(parseSidecar("")).toEqual(EMPTY_SIDECAR);
    expect(parseSidecar("{ not json")).toBeUndefined();
    // Structurally wrong is also nothing: a rules list that is not a list cannot be edited.
    expect(parseSidecar('{"agents":{"claude":{"rules":{}}}}')).toBeUndefined();
  });

  it("refuses a row it could not draw rather than blanking the panel on it", () => {
    /* Each of these parsed as JSON and then threw in `describeRule` or `serializeSidecar`,
       which is a blank panel with no explanation. They are documents this app cannot edit,
       and the documented answer to that is the "cannot be edited here" state. */
    expect(parseSidecar('{"version":1,"agents":{"claude":{"rules":[null]}}}')).toBeUndefined();
    expect(parseSidecar('{"version":1,"agents":{"claude":{"rules":["allow"]}}}')).toBeUndefined();
    // No `match`: `describeRule` reads `rule.match.kind` off it.
    expect(parseSidecar('{"version":1,"agents":{"claude":{"rules":[{"decision":"allow"}]}}}')).toBeUndefined();
    // A `match` that is not an object, and a decision outside the vocabulary.
    expect(
      parseSidecar('{"version":1,"agents":{"claude":{"rules":[{"match":[],"decision":"allow"}]}}}'),
    ).toBeUndefined();
    expect(
      parseSidecar('{"version":1,"agents":{"claude":{"rules":[{"match":{},"decision":"maybe"}]}}}'),
    ).toBeUndefined();
    // And the one that is fine: an empty match is "matches anything", not a broken row.
    expect(parseSidecar('{"version":1,"agents":{"claude":{"rules":[{"match":{},"decision":"allow"}]}}}')).toBeDefined();
  });

  it("refuses a version it has not been taught, rather than rewriting it as a 1", () => {
    // A shape this app does not know is a shape it must not re-serialise: whatever version
    // 2 added would be dropped on the way out (ADR 0009's round trip).
    expect(parseSidecar('{"version":2,"agents":{}}')).toBeUndefined();
    expect(parseSidecar('{"version":"1","agents":{}}')).toBeUndefined();
    // Absent is 1: the file the daemon writes always has one, and an older hand-written
    // one without it is the only version there has ever been.
    expect(parseSidecar('{"agents":{}}')).toEqual(EMPTY_SIDECAR);
  });

  it("carries a key it does not know through a save untouched", () => {
    /* ADR 0009's document may grow a field before this panel learns about it. Dropping one
       would make an edit to row one silent data loss in row two. */
    const text = `{
  "version": 1,
  "agents": {
    "claude": {
      "rules": [
        {
          "match": { "kind": "read", "unknownNarrowing": "x" },
          "decision": "allow",
          "expiresAt": "2027-01-01T00:00:00.000Z"
        }
      ]
    }
  }
}
`;
    const parsed = parseSidecar(text);
    expect(parsed).toBeDefined();
    const written = JSON.parse(serializeSidecar(parsed!)) as {
      agents: { claude: { rules: Record<string, unknown>[] } };
    };
    const rule = written.agents.claude.rules[0]!;
    expect(rule["expiresAt"]).toBe("2027-01-01T00:00:00.000Z");
    expect((rule["match"] as Record<string, unknown>)["unknownNarrowing"]).toBe("x");
    // The known keys keep the daemon's order and the unknown ones come after it.
    expect(Object.keys(rule)).toEqual(["match", "decision", "expiresAt"]);
    expect(Object.keys(rule["match"] as object)).toEqual(["kind", "unknownNarrowing"]);
  });

  it("writes the daemon's own key order, and never a default", () => {
    const text = serializeSidecar(doc());
    expect(text.endsWith("\n")).toBe(true);
    // `version` first, `agents` second, and no third key at the document's top level.
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["version", "agents"]);
    // Inside a rule: match, decision, then the provenance.
    const first = (JSON.parse(text) as { agents: { claude: { rules: object[] } } }).agents.claude.rules[0]!;
    expect(Object.keys(first)).toEqual(["match", "decision", "addedAt", "grantedFor"]);
    expect(text).not.toContain('"default"');
  });

  it("round-trips the fixture's bytes, so an untouched document is an empty diff", () => {
    expect(serializeSidecar(doc())).toBe(PERMISSIONS_TEXT);
  });

  it("drops an agent left with no rules rather than leaving an empty list behind", () => {
    const emptied = withRules(doc(), "claude", []);
    expect(Object.keys(emptied.agents)).toEqual([]);
    expect(serializeSidecar(emptied)).not.toContain("claude");
  });

  it("clears a match key rather than writing an empty string into it", () => {
    const match = withMatch(rulesOf(doc(), "claude")[0]!.match, "pathPrefix", "");
    expect("pathPrefix" in match).toBe(false);
    expect(withMatch(match, "path", "src/index.ts").path).toBe("src/index.ts");
  });

  it("counts a removal as one change and an untouched document as none", () => {
    const before = doc();
    expect(ruleChanges(before, before)).toBe(0);
    const removed = withRules(before, "claude", rulesOf(before, "claude").slice(1));
    expect(ruleChanges(before, removed)).toBe(1);
  });

  it("counts one edit as one change over a sidecar somebody wrote by hand", () => {
    /* The file as a person left it: the same two rules, with the keys in another order.
       That is the same document — the daemon canonicalises key order on the way in, which
       is why a client compares revisions rather than bytes — so an edit to one row is one
       change. Comparing raw JSON against a canonicalised draft made it three. */
    const byHand = parseSidecar(`{
  "agents": {
    "claude": {
      "rules": [
        {
          "decision": "allow",
          "grantedFor": "Edit src/index.ts",
          "addedAt": "2026-09-20T10:00:00.000Z",
          "match": { "pathPrefix": "src", "kind": "edit" }
        },
        {
          "decision": "allow",
          "match": { "titlePattern": "^git status$", "kind": "execute" },
          "addedAt": "2026-09-20T11:00:00.000Z",
          "grantedFor": "Run git status"
        }
      ]
    }
  },
  "version": 1
}
`);
    expect(byHand).toBeDefined();
    // Untouched is untouched, whatever order the keys were in.
    expect(ruleChanges(byHand!, byHand!)).toBe(0);
    // And it is the same document the daemon's own bytes are.
    expect(serializeSidecar(byHand!)).toBe(PERMISSIONS_TEXT);

    const rules = rulesOf(byHand!, "claude");
    const edited = withRules(byHand!, "claude", [
      { ...rules[0]!, match: withMatch(rules[0]!.match, "pathPrefix", "packages") },
      rules[1]!,
    ]);
    expect(ruleChanges(byHand!, edited)).toBe(1);
  });

  it("gives a hand-added rule the time and the reason a reader of the diff needs", () => {
    const rule = handRule("2026-09-21T12:00:00.000Z");
    expect(rule.addedAt).toBe("2026-09-21T12:00:00.000Z");
    expect(rule.grantedFor).toBe(HAND_GRANT);
    // Narrow rather than "allow anything": a new row is one Save away from being real.
    expect(rule.match.kind).toBe("read");
    expect(rule.match.scope).toBe("workspace");
  });

  it("produces a document the daemon's own schema accepts", () => {
    const next = withRules(doc(), "claude", [...rulesOf(doc(), "claude"), handRule("2026-09-21T12:00:00.000Z")]);
    const parsed = PermissionPolicyFileSchema.safeParse(JSON.parse(serializeSidecar(next)));
    expect(parsed.success).toBe(true);
  });

  it("names each rule by when it was added, so a removal leaves the others their names", () => {
    const rules = rulesOf(doc(), "claude");
    const keys = grantKeys(rules);
    expect(new Set(keys).size).toBe(2);
    // The first goes, and the second keeps its own name rather than taking the first's place.
    expect(grantKeys(rules.slice(1))).toEqual([keys[1]]);
    // An edit to a rule's decision or match is the same rule, so its row is not drawn again.
    expect(grantKeys([{ ...rules[0]!, decision: "deny" }, rules[1]!])).toEqual(keys);
  });

  it("tells apart rules that share a stamp, or have none, by their order among themselves", () => {
    // A sidecar written by hand need not stamp anything, and two grants can share a time.
    const bare = { match: { kind: "read" as const }, decision: "allow" as const };
    const stamped = handRule("2026-09-21T12:00:00.000Z");
    const keys = grantKeys([bare, stamped, bare, stamped]);
    expect(new Set(keys).size).toBe(4);
    // Taking out an unstamped rule renames none of the stamped ones.
    const after = grantKeys([stamped, bare, stamped]);
    expect(after[0]).toBe(keys[1]);
    expect(after[2]).toBe(keys[3]);
  });
});

/** A rule a run wrote in answer to "always", stamped the way `recordAlwaysDecision` stamps one. */
const ALWAYS: SidecarRule = {
  match: { kind: "execute", titlePattern: "^npm run build$" },
  decision: "allow",
  addedAt: "2026-09-22T09:00:00.000Z",
  grantedFor: "Run npm run build",
};

describe("a draft of the sidecar is grant edits, never a copy of the file", () => {
  /* The daemon writes this file too — every "allow always" is a write — so a draft holding the
     whole document would carry a stale copy of every other agent's grants and put it back. */
  const doc = (): SidecarDocument => parseSidecar(PERMISSIONS_TEXT)!;
  const base = (): readonly SidecarRule[] => rulesOf(doc(), "claude");

  it("keeps the base an agent's first edit began from, and lets go of an agent edited back to it", () => {
    const first = withGrantEdit(undefined, "claude", base(), base().slice(1));
    expect(first?.["claude"]).toEqual({ base: base(), rules: base().slice(1) });
    // A second edit keeps the first one's base, whatever the file says by then.
    const second = withGrantEdit(first, "claude", [], []);
    expect(second?.["claude"]?.base).toEqual(base());
    // Back where it began is no edit at all, and no draft.
    expect(withGrantEdit(second, "claude", [], base())).toBeUndefined();
  });

  it("composes an edit onto the file as it is now, keeping what was written for another agent meanwhile", () => {
    const drafts = withGrantEdit(undefined, "claude", base(), base().slice(1))!;
    const moved = withRules(doc(), "codex", [ALWAYS]);

    const { document, conflicts } = composeGrants(moved, drafts);
    expect(conflicts).toEqual([]);
    expect(rulesOf(document, "claude")).toEqual(base().slice(1));
    expect(rulesOf(document, "codex")).toEqual([ALWAYS]);
  });

  it("names an agent whose own grants changed on disk since its edit began, until Reload rebases it", () => {
    const drafts = withGrantEdit(undefined, "claude", base(), base().slice(1))!;
    const moved = withRules(doc(), "claude", [...base(), ALWAYS]);
    expect(composeGrants(moved, drafts).conflicts).toEqual(["claude"]);
    // The same change made on both sides is not one: there is nothing to write over.
    expect(composeGrants(withRules(doc(), "claude", base().slice(1)), drafts).conflicts).toEqual([]);

    // A person who has been told takes the file as the edit's new base, and keeps the edit.
    const rebased = rebaseGrants(drafts, moved)!;
    expect(rebased["claude"]).toEqual({ base: rulesOf(moved, "claude"), rules: base().slice(1) });
    expect(composeGrants(moved, rebased).conflicts).toEqual([]);
  });

  it("keeps only what was typed while a write was out", () => {
    const sent = withGrantEdit(undefined, "claude", base(), base().slice(1))!;
    // Untouched since it was sent: it is the file now, and nothing is left.
    expect(grantsAfterWrite(sent, sent)).toBeUndefined();
    // Edited again: the newer rules stay, over a base that is what was written.
    expect(grantsAfterWrite(withGrantEdit(sent, "claude", [], []), sent)).toEqual({
      claude: { base: base().slice(1), rules: [] },
    });
    // Edited back to where it began while the write was out: against the file, that is an edit.
    expect(grantsAfterWrite(undefined, sent)).toEqual({ claude: { base: base().slice(1), rules: base() } });
    // An agent first edited meanwhile was not written, and keeps the base it began from.
    expect(grantsAfterWrite(withGrantEdit(sent, "codex", [], [ALWAYS]), sent)).toEqual({
      codex: { base: [], rules: [ALWAYS] },
    });
  });
});

/* ------------------------------------------------------------------ screen -- */

function renderPanel(agentId = "claude"): { close: () => void; reopen: () => void } {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  /* The draft model `App` mounts above every surface: the panel reads it rather than
     holding one of its own, so the Config surface and this are never two answers to
     "what is unsaved" (#175). `open` is what closing the panel does to it — the provider
     stays mounted, which is the whole point of where the state lives. */
  const tree = (open: boolean) => (
    <Providers>
      <ConfigProvider>
        {open ? (
          <PolicyPanel
            agentId={agentId}
            live
            onOpen={() => {}}
            onClose={() => {}}
            now={() => "2026-09-21T12:00:00.000Z"}
          />
        ) : null}
      </ConfigProvider>
    </Providers>
  );
  const result = render(tree(true));
  return { close: () => result.rerender(tree(false)), reopen: () => result.rerender(tree(true)) };
}

/** The panel, once it has read the configuration. */
const panel = (): Promise<HTMLElement> => screen.findByRole("complementary", { name: "Permissions for claude" });

const grants = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole("region", { name: "Written grants" })).getAllByRole("listitem");

/** The input a field draws, found by the field's label — the path is on the label too. */
const field = (within_: HTMLElement, label: string): HTMLInputElement =>
  within(within_).getByLabelText<HTMLInputElement>(new RegExp(`^${label}`));

/** What the last `config.set` sent, parsed back into a document. */
function lastWrite(): { document: string; expectedRevision: string; text: string } {
  const call = [...fake.calls].reverse().find((c) => c.method === "config.set");
  if (!call) throw new Error("no config.set was sent");
  return call.params as { document: string; expectedRevision: string; text: string };
}

const callsTo = (method: string): number => fake.calls.filter((call) => call.method === method).length;

/** Every effect and answer a push or a write set going has landed. */
const settled = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/**
 * The sidecar as the daemon holds it, rather than the fixture's constant: a `config.set`
 * against any revision but the current one is `CONFIG_STALE`, as `replacePermissionPolicyFile`
 * answers under its lock, and a write that lands moves the revision. `write` is somebody
 * else's write — a run answering "always" is one — with the `config.changed` it pushes, or
 * without it when the push has not arrived yet.
 */
function sidecarOnDisk(): {
  readonly text: string;
  write: (edit: (doc: SidecarDocument) => SidecarDocument, options?: { push: boolean }) => void;
} {
  let revision = PERMISSIONS_REVISION;
  let text = PERMISSIONS_TEXT;
  let writes = 0;
  const view = () => ({ ...CONFIG_GET.permissions, revision, text, parsed: JSON.parse(text) as unknown });
  fake.script({
    "config.get": () => ({ ok: true, result: { ...CONFIG_GET, permissions: view() } }),
    "config.set": (params) => {
      if (params.document !== "permissions") throw new Error("only the sidecar is written here");
      if (params.expectedRevision !== revision) {
        return { ok: false, error: { code: "CONFIG_STALE", message: `${view().path} has changed since you read it` } };
      }
      if (params.validateOnly !== true) {
        text = params.text ?? text;
        revision = `written-${(writes += 1)}`;
      }
      return { ok: true, result: { document: view(), written: params.validateOnly !== true, asOf: AS_OF } };
    },
  });
  return {
    get text() {
      return text;
    },
    write(edit, options = { push: true }) {
      text = serializeSidecar(edit(parseSidecar(text)!));
      revision = `elsewhere-${(writes += 1)}`;
      if (!options.push) return;
      fake.notify({
        kind: "notification",
        method: "config.changed",
        params: { subscriptionId: "sub-1", at: AS_OF, document: "permissions", revision, path: view().path },
      });
    },
  };
}

/** The grants the file holds for one agent, as the daemon's own schema reads them. */
const onDiskFor = (text: string, agentId: string) =>
  PermissionPolicyFileSchema.parse(JSON.parse(text)).agents[agentId]?.rules ?? [];

describe("the policy editor", () => {
  beforeEach(() => {
    fake = installBridge();
    teardown.push(fake.install());
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("labels saved wildcard allows as ignored and preserves them when another rule is saved", async () => {
    const disk = sidecarOnDisk();
    const ignored: SidecarRule = { match: { kind: "execute", scope: "workspace" }, decision: "allow" };
    disk.write((doc) => withRules(doc, "claude", [...rulesOf(doc, "claude"), ignored]), { push: false });
    renderPanel();
    const rows = await grants();
    expect(rows[2]!.textContent).toContain("Ignored by ORCA: allow execute");
    expect(rows[2]!.textContent).toContain("This sidecar allow is ignored");
    const description = document.getElementById(rows[2]!.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain("Saving keeps the rule but does not make it effective");
    expect(rows[0]!.textContent).not.toContain("Ignored by ORCA");
    fireEvent.change(field(rows[0]!, "Path prefix"), { target: { value: "packages" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await settled();
    expect(onDiskFor(disk.text, "claude")[2]).toEqual(ignored);
  });

  it("updates ignored-rule feedback while typing and keeps the draft across closing", async () => {
    sidecarOnDisk();
    const view = renderPanel();
    const row = (await grants())[0]!;
    fireEvent.change(field(row, "Path prefix"), { target: { value: "" } });
    expect(row.textContent).toContain("Ignored by ORCA");
    expect(callsTo("config.set")).toBe(0);
    view.close();
    view.reopen();
    const held = (await grants())[0]!;
    expect(held.textContent).toContain("Ignored by ORCA");
    expect(field(held, "Path prefix").value).toBe("");
    fireEvent.change(field(held, "Path prefix"), { target: { value: "src/index.ts" } });
    expect(held.textContent).not.toContain("Ignored by ORCA");
  });

  it("shows the configured rules read-only and the written ones editable, in evaluation order", async () => {
    renderPanel();
    await panel();

    const configured = within(await screen.findByRole("region", { name: "Configured rules" })).getAllByRole("listitem");
    expect(configured).toHaveLength(1);
    expect(configured[0]!.textContent).toContain("allow execute matching ^npm test$");
    expect(configured[0]!.textContent).toContain("config");
    // Read-only here: no control on a configured rule, and a link to where it is edited.
    expect(within(configured[0]!).queryByRole("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit in the configuration" })).toBeTruthy();

    const written = await grants();
    expect(written).toHaveLength(2);
    // Numbered on from the configured rules: the sidecar is evaluated after them.
    expect(written[0]!.textContent).toContain("2");
    expect(written[0]!.textContent).toContain("allow edit under src");
    expect(written[0]!.textContent).toContain("granted for Edit src/index.ts");
    expect(within(written[0]!).getByRole("button", { name: "Remove grant 2" })).toBeTruthy();

    // The fallthrough is configuration's, and the editor says so.
    expect((await panel()).textContent).toContain("Anything no rule matches: allow — from the config");
  });

  it("shows ORCA's defaults as their own group, read-only and with nowhere to edit them", async () => {
    renderPanel();
    await panel();

    const defaults = await screen.findByRole("region", { name: "ORCA's defaults" });
    const rows = within(defaults).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("allow read in the workspace");
    expect(rows[0]!.textContent).toContain("default");
    // Numbered on from the sidecar: the floor is evaluated last (#140).
    expect(rows[0]!.textContent).toContain("4");
    /* No control and no link. A configured rule at least has a file to be edited in; these
       have none, so offering "edit on the Config surface" would point at nothing. */
    expect(within(defaults).queryByRole("button")).toBeNull();
    expect(within(defaults).getByText(/No file holds them/)).toBeTruthy();
    // And they are not offered as grants: the editable section is the sidecar's alone.
    expect(await grants()).toHaveLength(2);
  });

  it("says nothing about the fallthrough for an agent the effective policy does not name", async () => {
    /* The sidecar is readable and the panel opens, but ORCA has not said what this agent
       does when no rule matches — and "ask" would be the panel inventing it (rule 12). */
    renderPanel("ghost");
    const aside = await screen.findByRole("complementary", { name: "Permissions for ghost" });

    expect(aside.textContent).not.toContain("Anything no rule matches");
    expect(aside.textContent).toContain("does not name this agent");
  });

  it("says that a title pattern is used as written, because a hand-typed one is", async () => {
    /* `decidePermission` runs `new RegExp(pattern).test(title)`: unanchored, so it matches
       anywhere. The *writer* anchors the ones it derives with ^ and $, and the help that
       said only "a regular expression" let that read as a promise about this box too. */
    renderPanel();
    const written = await grants();
    const help = within(written[0]!).getByText(/regular expression tested against/);
    expect(help.textContent).toContain("not anchored for you");
    expect(help.textContent).toContain("matches anywhere in the title");
  });

  it("says that ORCA cannot count auto-approvals rather than showing a number", async () => {
    renderPanel();
    expect((await panel()).textContent).toContain("no running total is kept");
  });

  it("removes a grant and saves the whole sidecar, keeping the other row's provenance", async () => {
    renderPanel();
    const written = await grants();
    fireEvent.click(within(written[0]!).getByRole("button", { name: "Remove grant 2" }));

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastWrite().document).toBe("permissions"));

    const write = lastWrite();
    expect(write.expectedRevision).toBe(PERMISSIONS_REVISION);
    // The bytes are a document the daemon's own schema takes.
    const parsed = PermissionPolicyFileSchema.safeParse(JSON.parse(write.text));
    expect(parsed.success).toBe(true);

    const rules = parsed.data!.agents["claude"]!.rules;
    expect(rules).toHaveLength(1);
    // The one that was removed is gone, and the one that stayed is untouched — the audit
    // trail ADR 0009 keeps is not rewritten by an edit somewhere else in the file.
    expect(rules[0]!.match.titlePattern).toBe("^git status$");
    expect(rules[0]!.addedAt).toBe("2026-09-20T11:00:00.000Z");
    expect(rules[0]!.grantedFor).toBe("Run git status");
    // And no fallthrough was invented on the way out (ADR 0009's central rule).
    expect(write.text).not.toContain('"default"');
  });

  it("rests quiet: no danger tone anywhere in the panel before anything has been done", async () => {
    renderPanel();
    const aside = await panel();
    const written = await grants();

    // Status colour is the only saturation a resting screen carries (the brand book).
    expect(aside.querySelector(".orca-btn--danger")).toBeNull();
    for (const grant of written) {
      const remove = within(grant).getByRole("button", { name: /^Remove grant / });
      expect(remove.className).not.toContain("orca-btn--danger");
      expect(grant.textContent).not.toContain("✕");
    }
  });

  it("removes into the draft without asking: nothing is sent until Save, and Discard takes it back", async () => {
    renderPanel();
    const aside = await panel();
    const configSets = (): number => fake.calls.filter((call) => call.method === "config.set").length;

    fireEvent.click(within((await grants())[0]!).getByRole("button", { name: "Remove grant 2" }));

    /* No second state to arm: one press takes exactly one grant out of the draft, and the
       save bar is where the removal is committed. Nothing reached the daemon. */
    const left = await grants();
    expect(left).toHaveLength(1);
    expect(left[0]!.textContent).toContain("granted for Run git status");
    expect(within(aside).queryByRole("button", { name: /^(Keep|Confirm)/ })).toBeNull();
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(bar.textContent).toContain("1\u00a0change");
    expect(aside.textContent).toContain("They are written only by Save.");
    expect(configSets()).toBe(0);

    // Discard is the way back: both grants, provenance and all, and still nothing sent.
    fireEvent.click(within(bar).getByRole("button", { name: "Discard" }));
    const restored = await grants();
    expect(restored).toHaveLength(2);
    expect(restored[0]!.textContent).toContain("granted for Edit src/index.ts");
    expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull();
    expect(configSets()).toBe(0);
  });

  it("adds a grant by hand, stamped with the time and with what it was granted for", async () => {
    renderPanel();
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "Add a grant" }));

    expect(await grants()).toHaveLength(3);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastWrite().document).toBe("permissions"));

    const rules = PermissionPolicyFileSchema.parse(JSON.parse(lastWrite().text)).agents["claude"]!.rules;
    expect(rules).toHaveLength(3);
    expect(rules[2]!.addedAt).toBe("2026-09-21T12:00:00.000Z");
    expect(rules[2]!.grantedFor).toBe(HAND_GRANT);
  });

  it("edits a grant's match without touching its provenance", async () => {
    renderPanel();
    const written = await grants();
    fireEvent.change(field(written[0]!, "Path prefix"), { target: { value: "packages" } });

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastWrite().document).toBe("permissions"));

    const rules = PermissionPolicyFileSchema.parse(JSON.parse(lastWrite().text)).agents["claude"]!.rules;
    expect(rules[0]!.match.pathPrefix).toBe("packages");
    expect(rules[0]!.grantedFor).toBe("Edit src/index.ts");
  });

  it("keeps the draft when the file moved underneath it, and offers Reload", async () => {
    renderPanel();
    /* Somebody else wrote the sidecar — a run answering "always" is exactly this — so the
       revision in hand is no longer the file's, and the fake refuses it the way the daemon
       does. The draft is the thing that must not be lost. */
    fake.script({
      "config.get": () => ({
        ok: true,
        result: { ...CONFIG_GET, permissions: { ...CONFIG_GET.permissions, revision: "moved-on" } },
      }),
    });

    const written = await grants();
    fireEvent.click(within(written[0]!).getByRole("button", { name: "Remove grant 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    await waitFor(() => expect(bar.textContent).toContain("has changed since you read it"));
    expect(within(bar).getByRole("button", { name: "Reload" })).toBeTruthy();
    // The draft survived the refusal: one change, still held, still one grant short.
    expect(bar.textContent).toContain("1\u00a0change");
    expect(await grants()).toHaveLength(1);
  });

  it("keeps a grant the daemon wrote for another agent while the draft was open", async () => {
    const disk = sidecarOnDisk();
    renderPanel();
    fireEvent.click(within((await grants())[0]!).getByRole("button", { name: "Remove grant 2" }));
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });

    // A run answered "allow always" for another agent: the daemon wrote the file and said so.
    const reads = callsTo("config.get");
    disk.write((doc) => withRules(doc, "codex", [ALWAYS]));
    await waitFor(() => expect(callsTo("config.get")).toBeGreaterThan(reads));
    await settled();
    // Still the one change this person made: the other agent's grant is not one to undo.
    expect(bar.textContent).toContain("1 change");

    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull());
    // Sent onto the file it was composed onto, and the grant written meanwhile is still there.
    expect(lastWrite().expectedRevision).toBe("elsewhere-1");
    expect(onDiskFor(disk.text, "codex")).toEqual([ALWAYS]);
    expect(onDiskFor(disk.text, "claude").map((rule) => rule.grantedFor)).toEqual(["Run git status"]);
  });

  it("reads again and composes again when the file moved before its push arrived", async () => {
    const disk = sidecarOnDisk();
    renderPanel();
    fireEvent.click(within((await grants())[0]!).getByRole("button", { name: "Remove grant 2" }));
    // Written, and the `config.changed` saying so is still on its way.
    disk.write((doc) => withRules(doc, "codex", [ALWAYS]), { push: false });

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull());
    /* The first write was refused, because the file it was composed onto had moved; that is
       not a conflict to put in front of the person, since nobody else touched this agent. */
    const sent = fake.calls
      .filter((call) => call.method === "config.set")
      .map((call) => call.params as ConfigSetParams);
    expect(sent.map((params) => params.expectedRevision)).toEqual([PERMISSIONS_REVISION, "elsewhere-1"]);
    expect(onDiskFor(disk.text, "codex")).toEqual([ALWAYS]);
    expect(onDiskFor(disk.text, "claude").map((rule) => rule.grantedFor)).toEqual(["Run git status"]);
  });

  it("says so rather than writing over it when the same agent's grants changed on disk", async () => {
    const disk = sidecarOnDisk();
    renderPanel();
    fireEvent.click(within((await grants())[0]!).getByRole("button", { name: "Remove grant 2" }));
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });

    // This time "allow always" was answered for the agent being edited.
    const reads = callsTo("config.get");
    disk.write((doc) => withRules(doc, "claude", [...rulesOf(doc, "claude"), ALWAYS]));
    await waitFor(() => expect(callsTo("config.get")).toBeGreaterThan(reads));
    await settled();

    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bar.textContent).toContain("the grants for claude changed while you were editing them"));
    // Nothing was sent, the new grant is on disk, and the draft is the one the person left.
    expect(callsTo("config.set")).toBe(0);
    expect(onDiskFor(disk.text, "claude")).toContainEqual(ALWAYS);
    expect(await grants()).toHaveLength(1);

    /* Reload is the person having been told: the draft is kept, now made against the file as
       it is, so the Save after it writes the list they left. */
    fireEvent.click(within(bar).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(bar.textContent).not.toContain("changed while you were editing them"));
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("config.set")).toBe(1));
    expect(lastWrite().expectedRevision).toBe("elsewhere-1");
    await waitFor(() =>
      expect(onDiskFor(disk.text, "claude").map((rule) => rule.grantedFor)).toEqual(["Run git status"]),
    );
  });

  it("keeps an edit typed while a save was out, and Discard waits for the write", async () => {
    const disk = sidecarOnDisk();
    renderPanel();
    fireEvent.change(field((await grants())[0]!, "Path prefix"), { target: { value: "packages" } });
    const release = fake.hold("config.set");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("config.set")).toBe(1));

    // The write is out. It cannot be called back, so Discard says it is waiting and does nothing.
    const bar = screen.getByRole("group", { name: "Unsaved configuration changes" });
    const discard = within(bar).getByRole("button", { name: "Discard" });
    expect(discard.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(discard);
    // The newer draft becomes a wildcard while the earlier, narrowed save is in flight.
    fireEvent.change(field((await grants())[0]!, "Path prefix"), { target: { value: "" } });
    expect((await grants())[0]!.textContent).toContain("Ignored by ORCA");

    release();
    await waitFor(() => expect(onDiskFor(disk.text, "claude")[0]!.match.pathPrefix).toBe("packages"));
    await settled();
    // What was typed after Save is still the draft, one change over what was written.
    expect(field((await grants())[0]!, "Path prefix").value).toBe("");
    expect((await grants())[0]!.textContent).toContain("Ignored by ORCA");
    const after = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(after.textContent).toContain("1 change");

    fireEvent.click(within(after).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDiskFor(disk.text, "claude")[0]!.match.pathPrefix).toBeUndefined());
    expect(lastWrite().expectedRevision).toBe("written-1");
  });

  it("re-reads when a config.changed frame says the sidecar moved", async () => {
    renderPanel();
    expect(await grants()).toHaveLength(2);

    fake.script({
      "config.get": () => ({
        ok: true,
        result: {
          ...CONFIG_GET,
          permissions: { ...CONFIG_GET.permissions, revision: "after-always", text: '{"version":1,"agents":{}}' },
          effective: { agents: { claude: { default: "allow", rules: [] } } },
        },
      }),
    });
    fake.notify({
      kind: "notification",
      method: "config.changed",
      params: {
        subscriptionId: "sub-1",
        at: AS_OF,
        document: "permissions",
        revision: "after-always",
        path: "/workspace/orca.permissions.json",
      },
    });

    await waitFor(async () =>
      expect(
        within(await screen.findByRole("region", { name: "Written grants" })).queryAllByRole("listitem"),
      ).toHaveLength(0),
    );
  });

  it("offers nothing to write when the daemon has no config.set", async () => {
    /* A `--read-only` daemon leaves the control methods out of `hello.methods` *and* out of
       its capabilities, so the editor is a viewer: the rules are still read — `config.get`
       is a read — and every control that would write one is absent, not greyed. */
    fake.script({ hello: () => Promise.resolve({ ok: true, result: HELLO_READ_ONLY }) });
    fake.connect({ state: "live", since: AS_OF, capabilities: HELLO_READ_ONLY.capabilities });
    renderPanel();
    await panel();

    expect(await grants()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add a grant" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove grant 2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("degrades a read-only daemon's fields to text rather than to boxes that refuse typing", async () => {
    fake.script({ hello: () => Promise.resolve({ ok: true, result: HELLO_READ_ONLY }) });
    fake.connect({ state: "live", since: AS_OF, capabilities: HELLO_READ_ONLY.capabilities });
    renderPanel();
    await panel();

    const written = await grants();
    /* Every control on the row is a reading, not an input: the enum menus already became
       text and a `readOnly` box beside them was a control that looked writable and was not.
       There is nothing to write to — the daemon has no `config.set` — so there are no
       boxes at all. */
    expect(within(written[0]!).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(written[0]!).queryAllByRole("button")).toHaveLength(0);
    // The values are still readable, and an unset narrowing still reads as "Any".
    expect(written[0]!.textContent).toContain("src");
    expect(written[0]!.textContent).toContain("Any");
  });

  it("keeps the grant edits when the panel closes, because the draft is held above it", async () => {
    /* #175's review moved the draft model above this panel (`ConfigProvider`), and the
       as-built section says so: closing the panel puts the edits down rather than throwing
       them away, which is why there is no "discard?" warning on Close. */
    const panels = renderPanel();
    const written = await grants();
    fireEvent.change(field(written[0]!, "Path prefix"), { target: { value: "packages" } });
    await screen.findByRole("group", { name: "Unsaved configuration changes" });

    panels.close();
    expect(screen.queryByRole("complementary", { name: "Permissions for claude" })).toBeNull();

    panels.reopen();
    const reopened = await grants();
    expect(field(reopened[0]!, "Path prefix").value).toBe("packages");
    // Still one change, still unsaved, and nothing was written on the way through.
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(bar.textContent).toContain("1\u00a0change");
    expect(fake.calls.filter((call) => call.method === "config.set")).toHaveLength(0);
  });
});

describe("where focus goes when a grant leaves", () => {
  /* Remove takes its own row out of the document, and the Remove focused inside it with the
     row; without somewhere to go, focus falls to the page body, and a keyboard user's place in
     the list goes with the grant. happy-dom does not move focus on a click the way a browser
     does, so a press here is `focus()` and then `click`, which is what a person's press does
     in the app. */
  beforeEach(() => {
    fake = installBridge();
    teardown.push(fake.install());
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  const press = (button: HTMLElement): void => {
    act(() => button.focus());
    fireEvent.click(button);
  };

  /** Somebody else rewrote the sidecar to hold only `rules`, and the daemon says so. */
  function rewritten(rules: (doc: SidecarDocument) => SidecarDocument): void {
    const text = serializeSidecar(rules(parseSidecar(PERMISSIONS_TEXT)!));
    fake.script({
      "config.get": () => ({
        ok: true,
        result: { ...CONFIG_GET, permissions: { ...CONFIG_GET.permissions, revision: "rewritten", text } },
      }),
    });
    fake.notify({
      kind: "notification",
      method: "config.changed",
      params: {
        subscriptionId: "sub-1",
        at: AS_OF,
        document: "permissions",
        revision: "rewritten",
        path: "/workspace/orca.permissions.json",
      },
    });
  }

  it("moves to the next grant's Remove when the grant was in the middle", async () => {
    renderPanel();
    await panel();
    // A third grant, so that there is a middle one: the fixture's two, then one added by hand.
    fireEvent.click(screen.getByRole("button", { name: "Add a grant" }));
    const written = await grants();
    expect(written).toHaveLength(3);
    const next = within(written[2]!).getByRole("button", { name: "Remove grant 4" });

    press(within(written[1]!).getByRole("button", { name: "Remove grant 3" }));

    const left = await grants();
    expect(left).toHaveLength(2);
    /* The grant that slid into the gap: where the next Tab from the removed one would have
       gone. Its row is kept rather than drawn again, so it is the same control, numbered for
       its new place. */
    expect(document.activeElement).toBe(next);
    expect(left[1]!.contains(next)).toBe(true);
    expect(next.getAttribute("aria-label")).toBe("Remove grant 3");
    expect(left[1]!.textContent).toContain(`granted for ${HAND_GRANT}`);
  });

  it("moves to the previous grant's Remove when the grant was the last", async () => {
    renderPanel();
    const written = await grants();
    const previous = within(written[0]!).getByRole("button", { name: "Remove grant 2" });

    press(within(written[1]!).getByRole("button", { name: "Remove grant 3" }));

    expect(await grants()).toHaveLength(1);
    expect(document.activeElement).toBe(previous);
  });

  it("moves to Add a grant when the grant was the only one", async () => {
    renderPanel();
    const written = await grants();
    const second = within(written[1]!).getByRole("button", { name: "Remove grant 3" });

    // The first of two goes, and the second slides up under focus...
    press(within(written[0]!).getByRole("button", { name: "Remove grant 2" }));
    expect(document.activeElement).toBe(second);

    // ...and then the only one, which leaves no grant to land on.
    press(second);
    const section = await screen.findByRole("region", { name: "Written grants" });
    await waitFor(() => expect(within(section).queryAllByRole("listitem")).toHaveLength(0));
    expect(section.textContent).toContain("Nothing has been granted");
    expect(document.activeElement).toBe(within(section).getByRole("button", { name: "Add a grant" }));
    // The section is the last resort behind it: focusable from script, and never a Tab stop.
    expect(section.getAttribute("tabindex")).toBe("-1");
  });

  it("moves the same way when a re-read takes the grant a field in it was focused in", async () => {
    renderPanel();
    const written = await grants();
    const next = within(written[1]!).getByRole("button", { name: "Remove grant 3" });
    act(() => field(written[0]!, "Path prefix").focus());

    // A run's "always" rewrote the file without the first grant, and nothing was drafted here.
    rewritten((doc) => withRules(doc, "claude", rulesOf(doc, "claude").slice(1)));

    await waitFor(async () => expect(await grants()).toHaveLength(1));
    expect(document.activeElement).toBe(next);
  });

  it("moves to the Written grants when Discard empties the draft and the save bar leaves", async () => {
    renderPanel();
    press(within((await grants())[0]!).getByRole("button", { name: "Remove grant 2" }));
    const bar = await screen.findByRole("group", { name: "Unsaved configuration changes" });

    /* Discard brings the count to zero, and the bar goes with the Discard that was pressed.
       Focus goes to the list the draft was editing rather than to the page body. */
    press(within(bar).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull();
    const section = await screen.findByRole("region", { name: "Written grants" });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(await grants()).toHaveLength(2);
  });

  it("moves to the Written grants when a save lands and the save bar leaves", async () => {
    renderPanel();
    press(within((await grants())[0]!).getByRole("button", { name: "Remove grant 2" }));
    press(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(lastWrite().document).toBe("permissions"));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Unsaved configuration changes" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Written grants" })));
  });

  it("does not take focus back from somewhere the person moved it", async () => {
    renderPanel();
    const written = await grants();
    act(() => within(written[0]!).getByRole("button", { name: "Remove grant 2" }).focus());
    const elsewhere = screen.getByRole("button", { name: "Close" });
    act(() => elsewhere.focus());

    rewritten((doc) => withRules(doc, "claude", []));

    const section = await screen.findByRole("region", { name: "Written grants" });
    await waitFor(() => expect(within(section).queryAllByRole("listitem")).toHaveLength(0));
    expect(document.activeElement).toBe(elsewhere);
  });
});
