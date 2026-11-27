/**
 * One neutral call shape for the policy (#1119): a call that reaches ORCA as an ACP
 * `session/request_permission` and the same call as the Claude Agent SDK hands it over (tool
 * name and input, mapped by `claudeToolPolicyCall`) are decided by the same code.
 *
 * The ACP asks here are what Claude's ACP adapter (`@agentclientprotocol/claude-agent-acp`
 * 0.109.1, `tool-calls/reporters`) sends for each call: its titles, kinds and locations, with
 * paths inside the session's cwd shown relative to it. Where ORCA reproduces the adapter's title
 * the two routes decide alike, title rules included. Where it cannot, the SDK call is decided at
 * least as strictly: switching routes never loosens a rule (#1119 review).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PERMISSION_POLICY, type PermissionDecision, type PermissionPolicy } from "@orca/core";
import {
  asPolicyCall,
  callFacts,
  claudeAcpTitle,
  claudeToolPolicyCall,
  explainPermission,
  judgedLane,
  policyCallFromAcp,
  recordAlwaysDecision,
  type PermissionEvalContext,
  type PolicyCall,
} from "../src/index.js";

let root: string;
let ws: string;
let scope: PermissionEvalContext;

beforeAll(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "orca-policy-call-1119-")));
  ws = join(root, "ws");
  await mkdir(join(ws, "src"), { recursive: true });
  await mkdir(join(ws, ".orca"), { recursive: true });
  await writeFile(join(ws, "src", "a.ts"), "x\n");
  await writeFile(join(ws, "orca.permissions.json"), "{}\n");
  scope = {
    workspaceCwd: ws,
    protectedPaths: { readOnly: [join(ws, "orca.permissions.json")], noAccess: [join(ws, ".orca")] },
  };
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The ask the Claude ACP adapter sends for a tool call. */
const ask = (toolCall: Omit<acp.ToolCallUpdate, "toolCallId">): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t", ...toolCall },
  options: [
    { optionId: "a", name: "Allow", kind: "allow_once" },
    { optionId: "r", name: "Reject", kind: "reject_once" },
  ],
});

/** The same call as the SDK hands it over: the tool's name and input, in the session's cwd. */
const sdk = (toolName: string, toolInput: Record<string, unknown>): PolicyCall =>
  claudeToolPolicyCall({ toolName, toolInput, cwd: ws });

/** The adapter's ask for a file tool: an absolute location, the path shown relative inside the cwd. */
const fileAsk = (verb: string, kind: acp.ToolKind, rel: string, input: Record<string, unknown>, suffix = "") =>
  ask({ title: `${verb} ${rel}${suffix}`, kind, locations: [{ path: join(ws, rel) }], rawInput: input });

/** `exact`: ORCA reproduces the adapter's title, so both routes must decide identically. */
type Case = { name: string; exact: boolean; acp: () => acp.RequestPermissionRequest; sdk: () => PolicyCall };
const cases: Case[] = [
  {
    name: "a read inside the workspace",
    exact: true,
    acp: () => fileAsk("Read", "read", "src/a.ts", { file_path: join(ws, "src/a.ts") }),
    sdk: () => sdk("Read", { file_path: join(ws, "src/a.ts") }),
  },
  {
    name: "a read of a line range",
    exact: true,
    acp: () =>
      fileAsk("Read", "read", "src/a.ts", { file_path: join(ws, "src/a.ts"), offset: 3, limit: 5 }, " (3 - 7)"),
    sdk: () => sdk("Read", { file_path: join(ws, "src/a.ts"), offset: 3, limit: 5 }),
  },
  {
    name: "a read of a secret file inside the workspace",
    exact: true,
    acp: () => fileAsk("Read", "read", "src/secret.env", { file_path: join(ws, "src/secret.env") }),
    sdk: () => sdk("Read", { file_path: join(ws, "src/secret.env") }),
  },
  {
    name: "a read outside the workspace",
    exact: true,
    acp: () =>
      ask({
        title: "Read /etc/hosts",
        kind: "read",
        locations: [{ path: "/etc/hosts" }],
        rawInput: { file_path: "/etc/hosts" },
      }),
    sdk: () => sdk("Read", { file_path: "/etc/hosts" }),
  },
  {
    name: "an edit inside the workspace",
    exact: true,
    acp: () =>
      fileAsk("Edit", "edit", "src/a.ts", { file_path: join(ws, "src/a.ts"), old_string: "x", new_string: "y" }),
    sdk: () => sdk("Edit", { file_path: join(ws, "src/a.ts"), old_string: "x", new_string: "y" }),
  },
  {
    name: "a write to ORCA's permission sidecar",
    exact: true,
    acp: () =>
      fileAsk("Write", "edit", "orca.permissions.json", {
        file_path: join(ws, "orca.permissions.json"),
        content: "{}",
      }),
    sdk: () => sdk("Write", { file_path: join(ws, "orca.permissions.json"), content: "{}" }),
  },
  {
    name: "a read of ORCA's store",
    exact: true,
    acp: () => fileAsk("Read", "read", ".orca/key", { file_path: join(ws, ".orca/key") }),
    sdk: () => sdk("Read", { file_path: join(ws, ".orca/key") }),
  },
  {
    name: "a command",
    exact: true,
    acp: () => ask({ title: "npm test", kind: "execute", rawInput: { command: "npm test", description: "t" } }),
    sdk: () => sdk("Bash", { command: "npm test", description: "t" }),
  },
  {
    name: "a push, which a title rule asks about",
    exact: true,
    acp: () =>
      ask({
        title: "git push origin main",
        kind: "execute",
        rawInput: { command: "git push origin main", description: "t" },
      }),
    sdk: () => sdk("Bash", { command: "git push origin main", description: "t" }),
  },
  {
    name: "a compound command with a denied part",
    exact: true,
    acp: () =>
      ask({
        title: "ls && rm -rf build",
        kind: "execute",
        rawInput: { command: "ls && rm -rf build", description: "t" },
      }),
    sdk: () => sdk("Bash", { command: "ls && rm -rf build", description: "t" }),
  },
  {
    name: "a fetch",
    exact: true,
    acp: () =>
      ask({
        title: "Fetch https://example.com/x",
        kind: "fetch",
        rawInput: { url: "https://example.com/x", prompt: "p" },
      }),
    sdk: () => sdk("WebFetch", { url: "https://example.com/x", prompt: "p" }),
  },
  {
    name: "an MCP tool",
    exact: true,
    acp: () => ask({ title: "github: create_issue", kind: "other", rawInput: { title: "x" } }),
    sdk: () => sdk("mcp__github__create_issue", { title: "x" }),
  },
  {
    name: "a grep, whose title ORCA does not reproduce",
    exact: false,
    acp: () =>
      ask({
        title: 'grep -i "password"',
        kind: "search",
        locations: [],
        rawInput: { pattern: "password", "-i": true },
      }),
    sdk: () => sdk("Grep", { pattern: "password", "-i": true }),
  },
  {
    name: "a glob, whose title ORCA does not reproduce",
    exact: false,
    acp: () =>
      ask({
        title: "Find `src` `*.ts`",
        kind: "search",
        locations: [{ path: "src" }],
        rawInput: { path: "src", pattern: "*.ts" },
      }),
    sdk: () => sdk("Glob", { path: join(ws, "src"), pattern: "*.ts" }),
  },
];

/** Title rules written against what ACP asks carry, as a person would write them. */
const titleRules: PermissionPolicy["rules"] = [
  { match: { kind: "read", titlePattern: "^Read src/secret" }, decision: "deny" },
  { match: { kind: "read", titlePattern: "^Read src/a\\.ts \\(3 - 7\\)$" }, decision: "ask" },
  { match: { kind: "execute", titlePattern: "^git push" }, decision: "ask" },
  { match: { kind: "search", titlePattern: "password" }, decision: "deny" },
  { match: { kind: "search", titlePattern: "^Find" }, decision: "allow" },
  { match: { kind: "fetch", titlePattern: "^Fetch https://example\\.com/" }, decision: "allow" },
  { match: { titlePattern: "^github: create_issue$" }, decision: "deny" },
];

const policies: [string, PermissionPolicy][] = [
  ["the default policy", DEFAULT_PERMISSION_POLICY],
  [
    "typed rules",
    {
      default: "ask",
      rules: [
        { match: { kind: "execute", command: "rm *" }, decision: "deny" },
        ...titleRules,
        { match: { kind: "read", pathPrefix: "/etc/" }, decision: "allow" },
        ...DEFAULT_PERMISSION_POLICY.rules,
      ],
    },
  ],
  [
    "allow by default, with title restrictions",
    {
      default: "allow",
      rules: [
        ...titleRules.filter((r) => r.decision !== "allow"),
        { match: { kind: "edit", scope: "outside-workspace" }, decision: "deny" },
      ],
    },
  ],
];

const strictness = (d: PermissionDecision) => (d === "deny" ? 2 : d === "ask" ? 1 : 0);

describe("one decision for a call on either route (#1119)", () => {
  for (const [label, policy] of policies)
    for (const c of cases)
      it(`${c.name}, under ${label}`, () => {
        const viaAcp = explainPermission(policy, c.acp(), scope);
        const viaSdk = explainPermission(policy, c.sdk(), scope);
        if (c.exact) expect(viaSdk).toEqual(viaAcp);
        // Never looser than the ACP ask, whatever the title.
        else expect(strictness(viaSdk.decision)).toBeGreaterThanOrEqual(strictness(viaAcp.decision));
        // The mapped ACP call decides exactly as the request it came from.
        expect(explainPermission(policy, policyCallFromAcp(c.acp()), scope)).toEqual(viaAcp);
      });

  it("holds title restrictions written against the ACP ask on the SDK route", () => {
    const [, typed] = policies[1]!;
    const by = (name: string) => cases.find((c) => c.name.startsWith(name))!;
    const both = (name: string) => {
      const c = by(name);
      return [explainPermission(typed, c.acp(), scope).decision, explainPermission(typed, c.sdk(), scope).decision];
    };
    expect(both("a read of a secret file")).toEqual(["deny", "deny"]);
    expect(both("a read of a line range")).toEqual(["ask", "ask"]);
    expect(both("a push")).toEqual(["ask", "ask"]);
    expect(both("a grep")).toEqual(["deny", "deny"]);
    expect(both("an MCP tool")).toEqual(["deny", "deny"]);
    // A glob's ask is not reproduced: no allow decides it, and every search title restriction
    // holds for it (here the deny written for greps), so it is stricter, never looser.
    expect(both("a glob")).toEqual(["allow", "deny"]);
    expect(both("a fetch")).toEqual(["allow", "allow"]);
    expect(both("a read inside the workspace")).toEqual(["allow", "allow"]);
    expect(both("a command")).toEqual(["ask", "ask"]);
    expect(both("a compound command")).toEqual(["deny", "deny"]);
    expect(both("a write to ORCA's permission sidecar")).toEqual(["deny", "deny"]);
    expect(explainPermission(typed, by("a read of ORCA's store").sdk(), scope).basis).toBe("protected");
  });

  it("holds a title rule written against the hook's form of the title too", () => {
    // The hook titles a read by its absolute path; a deny written for that form holds here as well.
    const policy: PermissionPolicy = {
      default: "allow",
      rules: [
        {
          match: { kind: "read", titlePattern: `^Read ${ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/a` },
          decision: "deny",
        },
      ],
    };
    const call = sdk("Read", { file_path: join(ws, "src/a.ts") });
    expect(call.title).toBe("Read src/a.ts");
    expect(call.titleForms).toEqual([`Read ${join(ws, "src/a.ts")}`]);
    expect(explainPermission(policy, call, scope).decision).toBe("deny");
    // No allow is matched by the other form.
    const allowByHookForm: PermissionPolicy = { default: "ask", rules: [{ ...policy.rules[0]!, decision: "allow" }] };
    expect(explainPermission(allowByHookForm, call, scope).decision).toBe("ask");
  });

  describe("overlapping restrictions only get stricter (#1303 review)", () => {
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const read = () => cases.find((c) => c.name === "a read inside the workspace")!;
    const grep = () => cases.find((c) => c.name.startsWith("a grep"))!;
    const decide = (rules: PermissionPolicy["rules"], c: Case) => {
      const policy: PermissionPolicy = { default: "allow", rules };
      return [explainPermission(policy, c.acp(), scope), explainPermission(policy, c.sdk(), scope)] as const;
    };

    it("an ask met only by the hook's form does not shadow a deny the ACP title meets", () => {
      const [viaAcp, viaSdk] = decide(
        [
          { match: { kind: "read", titlePattern: `^Read ${esc(join(ws, "src"))}` }, decision: "ask" },
          { match: { kind: "read", titlePattern: "^Read src/a" }, decision: "deny" },
        ],
        read(),
      );
      expect(viaAcp).toEqual({ decision: "deny", basis: "rule", ruleIndex: 1 });
      expect(viaSdk).toEqual(viaAcp);
    });

    it("an earlier allow with no title does not end the hook-form pass ahead of its deny", () => {
      const rules: PermissionPolicy["rules"] = [
        { match: { kind: "read", scope: "workspace" }, decision: "allow" },
        { match: { kind: "read", titlePattern: `^Read ${esc(join(ws, "src"))}` }, decision: "deny" },
      ];
      const [viaAcp, viaSdk] = decide(rules, read());
      // The ACP route is unchanged: its first match, the allow, decides.
      expect(viaAcp).toEqual({ decision: "allow", basis: "rule", ruleIndex: 0 });
      expect(viaSdk).toEqual({ decision: "deny", basis: "rule", ruleIndex: 1 });
      // A hook-form ask behind both an allow and an ACP-title ask still counts, and a later deny beats it.
      const [, stacked] = decide(
        [
          rules[0]!,
          { match: { kind: "read", titlePattern: `^Read ${esc(join(ws, "src"))}` }, decision: "ask" },
          rules[1]!,
        ],
        read(),
      );
      expect(stacked).toEqual({ decision: "deny", basis: "rule", ruleIndex: 2 });
    });

    it("a deny met only by the hook's form holds over an ask the ACP title meets", () => {
      const [viaAcp, viaSdk] = decide(
        [
          { match: { kind: "read", titlePattern: "^Read src/a" }, decision: "ask" },
          { match: { kind: "read", titlePattern: `^Read ${esc(join(ws, "src"))}` }, decision: "deny" },
        ],
        read(),
      );
      expect(viaAcp.decision).toBe("ask");
      expect(viaSdk).toEqual({ decision: "deny", basis: "rule", ruleIndex: 1 });
    });

    it("on an uncertain title, an earlier ask does not shadow a later deny", () => {
      const rules: PermissionPolicy["rules"] = [
        { match: { kind: "search", titlePattern: "^Find" }, decision: "ask" },
        { match: { kind: "search", titlePattern: "password" }, decision: "deny" },
      ];
      const [viaAcp, viaSdk] = decide(rules, grep());
      expect(viaAcp).toEqual({ decision: "deny", basis: "rule", ruleIndex: 1 });
      expect(viaSdk).toEqual(viaAcp);
      // An ask the ACP title itself meets first stays first on the ACP route, as before.
      const acpFirst: PermissionPolicy["rules"] = [
        { match: { kind: "search", titlePattern: "^grep" }, decision: "ask" },
        rules[1]!,
      ];
      const [acpOnly, sdkStrict] = decide(acpFirst, grep());
      expect(acpOnly).toEqual({ decision: "ask", basis: "rule", ruleIndex: 0 });
      expect(sdkStrict).toEqual({ decision: "deny", basis: "rule", ruleIndex: 1 });
    });

    it("an earlier non-title ask does not shadow a deny on an uncertain title", () => {
      const [, viaSdk] = decide(
        [
          { match: { kind: "search" }, decision: "ask" },
          { match: { kind: "search", titlePattern: "password" }, decision: "deny" },
        ],
        grep(),
      );
      expect(viaSdk).toEqual({ decision: "deny", basis: "rule", ruleIndex: 1 });
    });

    /** Every order of these rules. */
    const orders = <T>(xs: readonly T[]): T[][] =>
      xs.length <= 1
        ? [[...xs]]
        : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]));

    it("in every order of overlapping allows, asks and denies, the SDK call is never looser", () => {
      const forRead: PermissionPolicy["rules"] = [
        { match: { kind: "read", titlePattern: "^Read src/a" }, decision: "allow" },
        { match: { kind: "read", titlePattern: "^Read src/" }, decision: "ask" },
        { match: { kind: "read", titlePattern: `^Read ${esc(join(ws, "src"))}` }, decision: "ask" },
        { match: { kind: "read", titlePattern: `^Read ${esc(ws)}` }, decision: "deny" },
        { match: { kind: "read", scope: "workspace" }, decision: "allow" },
      ];
      const forGrep: PermissionPolicy["rules"] = [
        { match: { kind: "search", titlePattern: "^grep" }, decision: "allow" },
        { match: { kind: "search", titlePattern: "^Find" }, decision: "ask" },
        { match: { kind: "search", titlePattern: "password" }, decision: "deny" },
        { match: { kind: "search" }, decision: "ask" },
        { match: { kind: "search", scope: "workspace" }, decision: "allow" },
      ];
      for (const [rules, c] of [
        [forRead, read()],
        [forGrep, grep()],
      ] as const)
        for (const order of orders(rules)) {
          const [viaAcp, viaSdk] = decide(order, c);
          expect(strictness(viaSdk.decision)).toBeGreaterThanOrEqual(strictness(viaAcp.decision));
          // Any deny that may hold for the uncertain grep wins, wherever it sits; so does the
          // read's deny met by the hook's form, whatever allow comes before it.
          expect(viaSdk.decision).toBe("deny");
        }
    });
  });

  it("reproduces the adapter's titles, and claims none it cannot", () => {
    const t = (name: string, input: Record<string, unknown>) => claudeAcpTitle(name, input, ws);
    expect(t("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(t("Bash", {})).toBe("Terminal");
    expect(t("Read", { file_path: join(ws, "src/a.ts") })).toBe("Read src/a.ts");
    expect(t("Read", { file_path: join(ws, "src/a.ts"), offset: 10 })).toBe("Read src/a.ts (from line 10)");
    expect(t("Read", { file_path: "/etc/hosts", limit: 2 })).toBe("Read /etc/hosts (1 - 2)");
    expect(t("Read", {})).toBe("Read File");
    expect(t("Write", { file_path: join(ws, "x.md"), content: "" })).toBe("Write x.md");
    expect(t("Edit", { file_path: ws })).toBe("Edit ");
    expect(t("WebFetch", { url: "https://a.example/", offset: 100 })).toBe("Fetch https://a.example/ (from char 100)");
    expect(t("WebSearch", { query: "q" })).toBe('Search "q"');
    expect(t("mcp__github__create_issue", {})).toBe("github: create_issue");
    expect(t("SomeNewTool", {})).toBe("SomeNewTool");
    // Inputs the adapter would turn into text its own way, and tools with their own reporters.
    expect(t("Read", { file_path: "/x", limit: "5" })).toBeUndefined();
    expect(t("WebFetch", { url: 42 })).toBeUndefined();
    expect(t("Write", { path: "/x" })).toBeUndefined();
    for (const name of ["Grep", "Glob", "NotebookEdit", "Agent", "Task", "TodoWrite", "MultiEdit", "Skill"])
      expect(t(name, {})).toBeUndefined();
    expect(sdk("Grep", { pattern: "x" }).approximate).toBe(true);
    expect(sdk("Bash", { command: "ls" }).approximate).toBeUndefined();
  });

  it("records no standing allow for a call whose ask ORCA could not reproduce", async () => {
    const file = join(root, "always.json");
    const recorded = await recordAlwaysDecision({
      file,
      agentId: "claude",
      request: sdk("Grep", { pattern: "x", path: join(ws, "src") }),
      decision: "allow",
      workspaceCwd: ws,
    });
    expect(recorded.refused?.reason).toBe("unverified-identity");
    expect(recorded.added).toEqual([]);
  });

  it("maps an ACP request field for field, with an MCP claim from its metadata", () => {
    const request = ask({
      title: "create_issue(title: x)",
      kind: "other",
      rawInput: { title: "x" },
      locations: [{ path: "a" }, { path: "b" }],
      _meta: { "gemini-cli": { mcp: { server_name: "github", tool_name: "create_issue" } } },
    });
    expect(asPolicyCall(request)).toEqual({
      title: "create_issue(title: x)",
      kind: "other",
      input: { title: "x" },
      locations: ["a", "b"],
      mcpClaim: { source: "gemini-cli-meta", verified: false, identity: { server: "github", tool: "create_issue" } },
    });
    // What the agent left out reads as it always did: no title, kind `other`, no locations.
    expect(asPolicyCall({ sessionId: "s", toolCall: { toolCallId: "t" }, options: [] })).toEqual({
      title: "",
      kind: "other",
      locations: [],
    });
    // A neutral call is passed through as it is.
    const call = sdk("Read", { file_path: "/etc/hosts" });
    expect(asPolicyCall(call)).toBe(call);
  });

  it("gives the same call facts and the same judged answer on either route", async () => {
    const policy: PermissionPolicy = {
      ...DEFAULT_PERMISSION_POLICY,
      judged: [{ match: { kind: "read" }, criterion: "reads under src", ruleId: "config:0", ruleRevision: "r0" }],
    };
    const c = cases.find((x) => x.name === "a read outside the workspace")!;
    const facts = (x: Parameters<typeof callFacts>[0]) => {
      const f = callFacts(x, scope);
      return { kind: f.kind, commandLike: f.commandLike, claimed: f.claimed, claimedTitle: f.claimedTitle };
    };
    expect(facts(c.sdk())).toEqual(facts(c.acp()));
    const lane = judgedLane({
      judge: () => Promise.reject(new Error("not asked: the read is outside the workspace")),
      reload: () => Promise.resolve(policy),
      localHost: true,
      redact: (t) => t,
    });
    const signal = new AbortController().signal;
    expect(await lane(policy, c.sdk(), scope, signal)).toEqual(await lane(policy, c.acp(), scope, signal));
  });
});
