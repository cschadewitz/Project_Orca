// @vitest-environment happy-dom
/**
 * Plain-language rules in the app (#701): writing, editing and removing them in the policy
 * panel, and listing them on the Config surface.
 *
 * The model half asserts the bytes. A sidecar holding a judged rule is version 4, which every
 * earlier reader refuses rather than reading the rule as a plain allow, so the panel must
 * read one, write one in the daemon's key order, and fall back to the version the rest needs
 * once the last judged rule is gone. Each document it writes is checked against the daemon's
 * own `PermissionPolicyFileSchema`.
 *
 * The screen half asserts that the rules are drawn apart from the grants (they are not in the
 * first-match order), that a row says what Save would refuse while it is typed, and that the
 * same Save writes them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { JUDGED_RULE_CRITERION_MAX, PermissionPolicyFileSchema, type ConfigGetResult } from "@orca/protocol";
import { ConfigProvider } from "../src/config/config-context.js";
import { PolicyPanel } from "../src/config/policy-editor.js";
import { PermissionsView } from "../src/config/permissions-view.js";
import { agentPolicies } from "../src/config/config-model.js";
import {
  handJudgedRule,
  isJudgedRule,
  judgedRuleProblem,
  parseSidecar,
  rulesOf,
  serializeSidecar,
  withRules,
  type JudgedSidecarRule,
} from "../src/config/policy-model.js";
import { CONFIG_GET, PERMISSIONS_REVISION, PERMISSIONS_TEXT } from "./fixtures-config.js";
import { AS_OF } from "./fixtures.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

const CRITERION = "Reading source, tests and docs, but never .env files.";

/** The fixture's two grants with a judged rule between them, as the daemon writes one. */
const WITH_JUDGED = `{
  "version": 4,
  "agents": {
    "claude": {
      "rules": [
        {
          "match": {
            "kind": "edit",
            "pathPrefix": "src"
          },
          "decision": "allow",
          "addedAt": "2026-09-20T10:00:00.000Z",
          "grantedFor": "Edit src/index.ts"
        },
        {
          "match": {
            "kind": "read",
            "pathPrefix": "docs"
          },
          "judge": {
            "criterion": "Reading the docs."
          },
          "addedAt": "2026-09-20T10:30:00.000Z"
        },
        {
          "match": {
            "kind": "execute",
            "titlePattern": "^git status$"
          },
          "decision": "allow",
          "addedAt": "2026-09-20T11:00:00.000Z",
          "grantedFor": "Run git status"
        }
      ]
    }
  }
}
`;

describe("a plain-language rule in the sidecar", () => {
  it("reads a version-4 file and writes it back byte for byte", () => {
    const doc = parseSidecar(WITH_JUDGED);
    expect(doc?.version).toBe(4);
    const judged = rulesOf(doc!, "claude")[1]!;
    expect(isJudgedRule(judged)).toBe(true);
    expect(serializeSidecar(doc!)).toBe(WITH_JUDGED);
    expect(PermissionPolicyFileSchema.safeParse(JSON.parse(WITH_JUDGED)).success).toBe(true);
  });

  it("goes back to the version the rest needs once the last judged rule is removed", () => {
    const doc = parseSidecar(WITH_JUDGED)!;
    const without = withRules(
      doc,
      "claude",
      rulesOf(doc, "claude").filter((rule) => !isJudgedRule(rule)),
    );
    expect(serializeSidecar(without)).toBe(PERMISSIONS_TEXT);
  });

  it("writes version 4 as soon as one is added, in the daemon's key order", () => {
    const doc = parseSidecar(PERMISSIONS_TEXT)!;
    const rule: JudgedSidecarRule = { ...handJudgedRule("2026-09-21T12:00:00.000Z"), judge: { criterion: CRITERION } };
    const text = serializeSidecar(withRules(doc, "claude", [...rulesOf(doc, "claude"), rule]));
    const written = JSON.parse(text) as { version: number; agents: { claude: { rules: object[] } } };
    expect(written.version).toBe(4);
    expect(Object.keys(written.agents.claude.rules[2]!)).toEqual(["match", "judge", "addedAt"]);
    expect(PermissionPolicyFileSchema.safeParse(written).success).toBe(true);
  });

  it("refuses a row with both a decision and a criterion, and a judged rule below version 4", () => {
    const row = (extra: object) =>
      JSON.stringify({
        version: 4,
        agents: { claude: { rules: [{ match: { kind: "read" }, judge: { criterion: "x" }, ...extra }] } },
      });
    expect(parseSidecar(row({ decision: "allow" }))).toBeUndefined();
    expect(parseSidecar(row({ judge: { criterion: 3 } }))).toBeUndefined();
    expect(parseSidecar(row({}).replace('"version":4', '"version":3'))).toBeUndefined();
    expect(parseSidecar(row({}))).toBeDefined();
  });

  it("says what Save would refuse, as the daemon's schema does", () => {
    const rule = handJudgedRule("2026-09-21T12:00:00.000Z");
    expect(judgedRuleProblem(rule)).toMatch(/sentence/);
    const written = { ...rule, judge: { criterion: CRITERION } };
    expect(judgedRuleProblem(written)).toBeUndefined();
    expect(judgedRuleProblem({ ...written, match: { kind: "edit" } })).toMatch(/read or search/);
    expect(judgedRuleProblem({ ...written, match: { kind: "read", pathPrefix: "../elsewhere" } })).toMatch(
      /relative to the workspace/,
    );
    expect(judgedRuleProblem({ ...written, match: { kind: "read", path: "/etc/passwd" } })).toMatch(
      /relative to the workspace/,
    );
    expect(judgedRuleProblem({ ...written, judge: { criterion: "x".repeat(JUDGED_RULE_CRITERION_MAX + 1) } })).toMatch(
      /at most/,
    );
  });
});

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

function sidecar(initial: string): { readonly text: string } {
  let revision = PERMISSIONS_REVISION;
  let text = initial;
  let writes = 0;
  const view = () => ({ ...CONFIG_GET.permissions, revision, text, parsed: JSON.parse(text) as unknown });
  fake.script({
    "config.get": () => ({ ok: true, result: { ...CONFIG_GET, permissions: view() } }),
    "config.set": (params) => {
      if (params.expectedRevision !== revision)
        return { ok: false, error: { code: "CONFIG_STALE", message: "changed" } };
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
  };
}

function renderPanel(): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
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

const region = (name: string): Promise<HTMLElement> => screen.findByRole("region", { name });
const rows = async (name: string): Promise<HTMLElement[]> => within(await region(name)).queryAllByRole("listitem");
const settled = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("the policy panel's plain-language rules", () => {
  beforeEach(() => {
    fake = installBridge();
    teardown.push(fake.install());
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("draws a judged rule apart from the grants, which keep their evaluation numbers", async () => {
    sidecar(WITH_JUDGED);
    renderPanel();
    const grants = await rows("Written grants");
    expect(grants).toHaveLength(2);
    // The configured rule is 1; the grants follow it, with the judged rule not counted.
    expect(grants.map((row) => row.querySelector(".orca-config__order")?.textContent)).toEqual(["2", "3"]);
    const judged = await rows("Plain-language rules");
    expect(judged).toHaveLength(1);
    expect(judged[0]!.textContent).toContain("sidecar:1");
    expect(judged[0]!.textContent).toContain("judge read under docs");
    expect(within(judged[0]!).getByLabelText<HTMLTextAreaElement>(/^Rule/).value).toBe("Reading the docs.");
  });

  it("adds one, says what is missing until it is written, and saves it as version 4", async () => {
    const disk = sidecar(PERMISSIONS_TEXT);
    renderPanel();
    await region("Plain-language rules");
    fireEvent.click(screen.getByRole("button", { name: "Add a plain-language rule" }));
    const [row] = await rows("Plain-language rules");
    expect(row!.textContent).toContain("Write the rule in a sentence before saving.");
    fireEvent.change(within(row!).getByLabelText(/^Rule/), { target: { value: CRITERION } });
    expect(row!.textContent).not.toContain("Write the rule in a sentence");

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(JSON.parse(disk.text).version).toBe(4));
    const doc = PermissionPolicyFileSchema.parse(JSON.parse(disk.text));
    expect(doc.agents["claude"]!.rules[2]).toEqual({
      match: { kind: "read", scope: "workspace" },
      judge: { criterion: CRITERION },
      addedAt: "2026-09-21T12:00:00.000Z",
    });
    // The grants were carried whole.
    expect(doc.agents["claude"]!.rules.slice(0, 2)).toEqual(JSON.parse(PERMISSIONS_TEXT).agents.claude.rules);
  });

  it("removes one into the draft, and Save writes the file back at the version the rest needs", async () => {
    const disk = sidecar(WITH_JUDGED);
    renderPanel();
    const [row] = await rows("Plain-language rules");
    const remove = within(row!).getByRole("button", { name: "Remove plain-language rule 1" });
    remove.focus();
    fireEvent.click(remove);
    await settled();
    expect(await rows("Plain-language rules")).toHaveLength(0);
    // Focus went to that section's Add, not to the page.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a plain-language rule" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(disk.text).toBe(PERMISSIONS_TEXT));
  });
});

describe("the Config surface's list", () => {
  afterEach(cleanup);

  it("lists the plain-language rules after the typed ones, unnumbered, with the id a decision names", () => {
    const effective: ConfigGetResult["effective"] = {
      agents: {
        claude: {
          ...CONFIG_GET.effective.agents["claude"]!,
          judged: [
            {
              ruleId: "config:2",
              source: "config",
              match: { kind: "search", scope: "workspace" },
              criterion: "Searching the repository.",
            },
            {
              ruleId: "sidecar:1",
              source: "permissions",
              match: { kind: "read", pathPrefix: "docs" },
              criterion: "Reading the docs.",
              addedAt: "2026-09-20T10:30:00.000Z",
              expiresAt: "2026-10-20T10:30:00.000Z",
            },
          ],
        },
      },
    };
    const policies = agentPolicies(effective);
    expect(policies[0]!.judged.map((row) => [row.ruleId, row.source, row.gate])).toEqual([
      ["config:2", "config", "search in the workspace"],
      ["sidecar:1", "sidecar", "read under docs"],
    ]);
    render(<PermissionsView policies={policies} live={false} path="orca.permissions.json" exists />);
    const list = screen.getByLabelText("Plain-language rules");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1]!.textContent).toContain("Reading the docs.");
    expect(items[1]!.textContent).toContain("expires");
    // The typed rules' numbering is untouched by them.
    expect(agentPolicies(CONFIG_GET.effective)[0]!.judged).toEqual([]);
  });
});
