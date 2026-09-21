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
 * draft.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PermissionPolicyFileSchema } from "@orca/protocol";
import { ConfigProvider } from "../src/config/config-context.js";
import { PolicyPanel } from "../src/config/policy-editor.js";
import {
  EMPTY_SIDECAR,
  HAND_GRANT,
  handRule,
  parseSidecar,
  ruleChanges,
  rulesOf,
  serializeSidecar,
  withMatch,
  withRules,
  type SidecarDocument,
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
});

/* ------------------------------------------------------------------ screen -- */

function renderPanel(): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      {/* The draft model `App` mounts above every surface: the panel reads it rather than
          holding one of its own, so the Config surface and this are never two answers to
          "what is unsaved" (#175). */}
      <ConfigProvider>
        <PolicyPanel
          agentId="claude"
          live
          onOpen={() => {}}
          onClose={() => {}}
          now={() => "2026-09-21T12:00:00.000Z"}
        />
      </ConfigProvider>
    </Providers>,
  );
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

describe("the policy editor", () => {
  beforeEach(() => {
    fake = installBridge();
    teardown.push(fake.install());
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("shows the configured rules read-only and the written ones editable, in evaluation order", async () => {
    renderPanel();
    await panel();

    const configured = within(await screen.findByRole("region", { name: "Configured rules" })).getAllByRole(
      "listitem",
    );
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
    expect(bar.textContent).toContain("1 change");
    expect(await grants()).toHaveLength(1);
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
});
