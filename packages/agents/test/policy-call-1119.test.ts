/**
 * One neutral call shape for the policy (#1119): a call that reaches ORCA as an ACP
 * `session/request_permission` and the same call as the Claude Agent SDK hands it over (tool
 * name and input, mapped by `claudeToolPolicyCall`) are decided by the same code, with the
 * same answer and the same attribution, under every policy here.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "@orca/core";
import {
  asPolicyCall,
  callFacts,
  claudeToolPolicyCall,
  explainPermission,
  judgedLane,
  policyCallFromAcp,
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

type Case = { name: string; acp: () => acp.RequestPermissionRequest; sdk: () => PolicyCall };
const cases: Case[] = [
  {
    name: "a read inside the workspace",
    acp: () => {
      const p = join(ws, "src", "a.ts");
      return ask({ title: `Read ${p}`, kind: "read", locations: [{ path: p }], rawInput: { file_path: p } });
    },
    sdk: () => sdk("Read", { file_path: join(ws, "src", "a.ts") }),
  },
  {
    name: "a read outside the workspace",
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
    acp: () => {
      const p = join(ws, "src", "a.ts");
      return ask({
        title: `Edit ${p}`,
        kind: "edit",
        locations: [{ path: p }],
        rawInput: { file_path: p, old_string: "x", new_string: "y" },
      });
    },
    sdk: () => sdk("Edit", { file_path: join(ws, "src", "a.ts"), old_string: "x", new_string: "y" }),
  },
  {
    name: "a write to ORCA's permission sidecar",
    acp: () => {
      const p = join(ws, "orca.permissions.json");
      return ask({
        title: `Write ${p}`,
        kind: "edit",
        locations: [{ path: p }],
        rawInput: { file_path: p, content: "{}" },
      });
    },
    sdk: () => sdk("Write", { file_path: join(ws, "orca.permissions.json"), content: "{}" }),
  },
  {
    name: "a read of ORCA's store",
    acp: () => {
      const p = join(ws, ".orca", "key");
      return ask({ title: `Read ${p}`, kind: "read", locations: [{ path: p }], rawInput: { file_path: p } });
    },
    sdk: () => sdk("Read", { file_path: join(ws, ".orca", "key") }),
  },
  {
    name: "a command",
    acp: () => ask({ title: "`npm test`", kind: "execute", rawInput: { command: "npm test", description: "t" } }),
    sdk: () => sdk("Bash", { command: "npm test", description: "t" }),
  },
  {
    name: "a compound command with a denied part",
    acp: () =>
      ask({
        title: "`ls && rm -rf build`",
        kind: "execute",
        rawInput: { command: "ls && rm -rf build", description: "t" },
      }),
    sdk: () => sdk("Bash", { command: "ls && rm -rf build", description: "t" }),
  },
  {
    name: "a fetch",
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
    acp: () => ask({ title: "github: create_issue", kind: "other", rawInput: { title: "x" } }),
    sdk: () => sdk("mcp__github__create_issue", { title: "x" }),
  },
];

const policies: [string, PermissionPolicy][] = [
  ["the default policy", DEFAULT_PERMISSION_POLICY],
  [
    "typed rules",
    {
      default: "ask",
      rules: [
        { match: { kind: "execute", command: "rm *" }, decision: "deny" },
        { match: { kind: "fetch", titlePattern: "^Fetch https://example\\.com/" }, decision: "allow" },
        { match: { titlePattern: "^github: create_issue$" }, decision: "deny" },
        { match: { kind: "read", pathPrefix: "/etc/" }, decision: "allow" },
        ...DEFAULT_PERMISSION_POLICY.rules,
      ],
    },
  ],
  [
    "allow by default",
    { default: "allow", rules: [{ match: { kind: "edit", scope: "outside-workspace" }, decision: "deny" }] },
  ],
];

describe("one decision for a call on either route (#1119)", () => {
  for (const [label, policy] of policies)
    for (const c of cases)
      it(`${c.name}, under ${label}`, () => {
        const viaAcp = explainPermission(policy, c.acp(), scope);
        const viaSdk = explainPermission(policy, c.sdk(), scope);
        expect(viaSdk).toEqual(viaAcp);
        // The mapped ACP call decides exactly as the request it came from.
        expect(explainPermission(policy, policyCallFromAcp(c.acp()), scope)).toEqual(viaAcp);
      });

  it("decides what each route's call is, not only that they agree", () => {
    const [, typed] = policies[1]!;
    const by = (name: string) => cases.find((c) => c.name === name)!;
    const decide = (name: string) => explainPermission(typed, by(name).sdk(), scope).decision;
    expect(decide("a read inside the workspace")).toBe("allow");
    expect(decide("a read outside the workspace")).toBe("allow");
    expect(decide("a write to ORCA's permission sidecar")).toBe("deny");
    expect(explainPermission(typed, by("a read of ORCA's store").sdk(), scope).basis).toBe("protected");
    expect(decide("a compound command with a denied part")).toBe("deny");
    expect(decide("a command")).toBe("ask");
    expect(decide("a fetch")).toBe("allow");
    expect(decide("an MCP tool")).toBe("deny");
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
      judged: [
        {
          match: { kind: "read" },
          criterion: "reads under src",
          ruleId: "config:0",
          ruleRevision: "r0",
        },
      ],
    };
    const c = cases[1]!;
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
