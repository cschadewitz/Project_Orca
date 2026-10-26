/**
 * #710 OpenCode 1.19.4 source-function tests. Each case runs a digest-checked upstream excerpt
 * with synthetic dependencies (opencode-acp-710-source.ts). This is source review made
 * executable — not a fixture simulation of ORCA, not an installed-provider observation, and
 * not an execution-guard result for any provider/tool/version/host tuple.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOpenCodeSource, packet, type OpenCodeSource } from "./opencode-acp-710-source.js";

let oc: OpenCodeSource;
const isolated = JSON.parse(readFileSync(new URL("opencode.isolated.json", packet), "utf8")) as {
  permission: Record<string, string>;
};
const TRUNCATION = "/fixture/xdg/data/opencode/tool-output/*";
const WHITELIST = [TRUNCATION, "/fixture/tmp/opencode/*"];

beforeAll(async () => {
  oc = await loadOpenCodeSource();
});

describe("provenance", () => {
  it("pins one released OpenCode 1 revision and never claims an installed or launched provider", () => {
    expect(oc.pins.status).toBe("offline-only-not-capability-negotiation");
    expect(oc.pins.provider).toMatchObject({
      release: "v1.19.4",
      revision: "148842ef7cb1bc34192b3fff57d0f9721ab9c801",
      installed: "unknown",
      launched: "never",
      authenticated: "never",
      acp: { command: ["opencode", "acp"], sdkVersion: "0.21.0", initializeProtocolVersion: 1 },
    });
    for (const excerpt of oc.pins.excerpts) {
      expect(excerpt.revision, excerpt.id).toBe(oc.pins.provider.revision);
      expect(excerpt.sourceBlobSha, excerpt.id).toMatch(/^[a-f0-9]{40}$/);
      expect(excerpt.url, excerpt.id).toContain(`/blob/${excerpt.revision}/${excerpt.upstreamPath}#L`);
    }
    expect(new Set(oc.pins.excerpts.map((e) => e.id)).size).toBe(oc.pins.excerpts.length);
    const darwinArm64 = oc.pins.provider.npm.packages.find((p) => p.name === "opencode-darwin-arm64");
    expect(darwinArm64).toMatchObject({ version: "1.19.4", os: "darwin", cpu: "arm64" });
    expect(darwinArm64?.integrity).toMatch(/^sha512-/);
  });

  it("matches the initialize capabilities the fixture peer mirrors", () => {
    const init = oc.text("acp-initialize");
    for (const fragment of ["protocolVersion: 1", "loadSession: true", "authMethods: [authMethod]", 'name: "OpenCode"'])
      expect(init).toContain(fragment);
  });
});

describe("ACP permission bridge (acp/permission.ts)", () => {
  it("offers exactly once / always / reject on every request", () => {
    expect(oc.permissionOptions).toEqual([
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ]);
  });

  it.each([
    [{ outcome: "selected", optionId: "once" }, "once"],
    [{ outcome: "selected", optionId: "always" }, "always"],
    [{ outcome: "selected", optionId: "reject" }, "reject"],
    [{ outcome: "selected", optionId: "allow-once" }, "reject"],
    [{ outcome: "selected", optionId: "reject_always" }, "reject"],
    [{ outcome: "cancelled" }, "reject"],
  ] as const)("maps the client outcome %j to native %s", (outcome, native) => {
    expect(oc.selectedReply({ outcome })).toBe(native);
  });

  const event = (sessionID: string, permission = "bash") => ({
    properties: { id: "per_1", sessionID, permission, metadata: { command: "true" }, tool: { callID: "call_1" } },
  });
  const sessions = { tryGet: (id: string) => (id === "ses_parent" ? { id, cwd: "/fixture/ws" } : undefined) };

  it("drops an ask from a session it does not track — a Task subagent child — without asking or replying", async () => {
    let asked = 0;
    const bridge = new oc.Bridge({
      session: sessions,
      connection: {
        requestPermission: () => {
          asked++;
          return Promise.resolve({ outcome: { outcome: "selected", optionId: "once" } });
        },
      },
    });
    await bridge.process(event("ses_child"));
    // No ACP ask and no native reply: the native call waits on a reply that never comes.
    expect(asked).toBe(0);
    expect(bridge.replies).toEqual([]);
  });

  it("rejects when the client has no requestPermission, errors, or cancels", async () => {
    for (const requestPermission of [
      undefined,
      () => Promise.reject(new Error("client error")),
      () => Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
    ]) {
      const bridge = new oc.Bridge({ session: sessions, connection: requestPermission ? { requestPermission } : {} });
      await bridge.process(event("ses_parent"));
      expect(bridge.replies).toEqual([{ requestID: "per_1", reply: "reject", directory: "/fixture/ws" }]);
    }
  });

  it("passes the offered options and forwards always as a native always", async () => {
    const seen: unknown[] = [];
    const bridge = new oc.Bridge({
      session: sessions,
      connection: {
        requestPermission: (request) => {
          seen.push(request.options);
          return Promise.resolve({ outcome: { outcome: "selected", optionId: "always" } });
        },
      },
    });
    await bridge.process(event("ses_parent"));
    expect(seen).toEqual([oc.permissionOptions]);
    expect(bridge.replies).toEqual([{ requestID: "per_1", reply: "always", directory: "/fixture/ws" }]);
  });

  it("mirrors an approved edit to the client before the native reply", async () => {
    const bridge = new oc.Bridge({
      session: sessions,
      connection: {
        requestPermission: () => Promise.resolve({ outcome: { outcome: "selected", optionId: "once" } }),
        writeTextFile: () => undefined,
      },
    });
    await bridge.process(event("ses_parent", "edit"));
    expect(bridge.writes).toEqual([{ sessionId: "ses_parent" }]);
    expect(bridge.replies.map((r) => r.reply)).toEqual(["once"]);
  });
});

describe("native kinds as ORCA sees them (acp/tool.ts)", () => {
  it.each([
    ["bash", "execute"],
    ["edit", "edit"],
    ["write", "edit"],
    ["apply_patch", "edit"],
    ["read", "read"],
    ["glob", "search"],
    ["grep", "search"],
    ["webfetch", "fetch"],
    // A subagent launch arrives as "think" — which ORCA's #140 defaults allow unasked.
    ["task", "think"],
    ["external_directory", "other"],
    ["websearch", "other"],
    ["list", "other"],
    ["todowrite", "other"],
    ["skill", "other"],
    ["lsp", "other"],
    ["doom_loop", "other"],
    ["fixture_mcp_tool", "other"],
  ])("%s -> %s", (tool, kind) => {
    expect(oc.toToolKind(tool)).toBe(kind);
  });
});

describe("native permission rules (permission/index.ts, agent/agent.ts)", () => {
  const action = (rules: Parameters<OpenCodeSource["evaluate"]>[2][], permission: string, pattern = "*") =>
    oc.evaluate(permission, pattern, ...rules).action;

  it("allows shell, edits, fetches, subagents and MCP tools without asking by default", () => {
    const defaults = oc.defaultsFor(WHITELIST);
    for (const permission of ["bash", "edit", "webfetch", "websearch", "task", "fixture_mcp_tool", "glob", "list"])
      expect(action([defaults], permission), permission).toBe("allow");
    expect(action([defaults], "doom_loop")).toBe("ask");
    expect(action([defaults], "read", "/fixture/ws/src/a.ts")).toBe("allow");
    expect(action([defaults], "read", "/fixture/ws/.env")).toBe("ask");
    expect(action([defaults], "external_directory", "/elsewhere/x")).toBe("ask");
    expect(action([defaults], "external_directory", "/fixture/tmp/opencode/x")).toBe("allow");
  });

  it("is last match wins, so a wildcard written after a key overrides it", () => {
    expect(action([oc.fromConfig({ bash: "ask", "*": "allow" })], "bash")).toBe("allow");
    expect(action([oc.fromConfig({ "*": "allow", bash: "ask" })], "bash")).toBe("ask");
  });

  it("the isolated configuration routes every named and unnamed tool to ask or deny", () => {
    expect(Object.keys(isolated.permission)[0]).toBe("*");
    expect(Object.values(isolated.permission)).not.toContain("allow");
    const effective = oc.merge(oc.defaultsFor(WHITELIST), oc.fromConfig(isolated.permission));
    for (const [permission, configured] of Object.entries(isolated.permission))
      if (permission !== "*") expect(action([effective], permission), permission).toBe(configured);
    for (const unnamed of ["fixture_mcp_tool", "codesearch", "apply_patch_custom"])
      expect(action([effective], unnamed), unnamed).toBe("ask");
    expect(action([effective], "read", "/fixture/ws/.env")).toBe("ask");
    expect(action([effective], "external_directory", "/fixture/tmp/opencode/x")).toBe("deny");
  });

  it("re-allows the truncation directory after every configured rule unless that exact glob is denied", () => {
    // agent.ts appends this rule last (excerpt agent-user-override); modelled with the same functions.
    const effective = oc.merge(
      oc.defaultsFor(WHITELIST),
      oc.fromConfig(isolated.permission),
      oc.fromConfig({ external_directory: { [TRUNCATION]: "allow" } }),
    );
    expect(action([effective], "external_directory", "/fixture/xdg/data/opencode/tool-output/x")).toBe("allow");
    expect(oc.text("agent-user-override")).toContain("Ensure Truncate.GLOB is allowed unless explicitly configured");
  });

  it("lets a per-agent override beat the top-level configuration", () => {
    const user = oc.fromConfig(isolated.permission);
    const agent = oc.fromConfig({ bash: "allow" });
    expect(action([oc.merge(oc.defaultsFor(WHITELIST), user, agent)], "bash")).toBe("allow");
    expect(oc.text("agent-user-override")).toContain("Permission.fromConfig(value.permission ?? {})");
  });

  it("lets one remembered edit approval cover every edit, even a pattern the configuration denies", () => {
    const configured = oc.fromConfig({ "*": "ask", edit: { "*": "ask", "secret/*": "deny" } });
    expect(action([configured], "edit", "secret/a.txt")).toBe("deny");
    // permission-reply appends `always` patterns to `approved`; edit asks with always ["*"].
    expect(oc.text("edit-ask")).toContain('always: ["*"]');
    expect(oc.text("permission-reply")).toContain("approved.push({");
    const approved = [{ permission: "edit", pattern: "*", action: "allow" as const }];
    // permission-ask evaluates `ruleset` and then `approved`; the last match is the approval.
    expect(oc.text("permission-ask")).toContain("evaluate(request.permission, pattern, ruleset, approved)");
    expect(action([configured, approved], "edit", "secret/a.txt")).toBe("allow");
    expect(action([configured, approved], "edit", "src/other.ts")).toBe("allow");
  });

  it("does not carry a parent's asks into a subagent, only its denies and directory rules", () => {
    const parent = oc.fromConfig({ "*": "ask", bash: "ask", webfetch: "deny", external_directory: "ask" });
    const child = oc.deriveSubagentSessionPermission({
      parentSessionPermission: parent,
      subagent: { permission: oc.fromConfig({ bash: "allow" }) },
    });
    expect(child).toEqual([
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "ask" },
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    expect(oc.text("task-ask")).toContain("bypassAgentCheck");
  });

  it("runs shell children with stdin ignored and carries only the command into the ask", () => {
    expect(oc.text("shell-spawn").match(/stdin: "ignore"/g)).toHaveLength(2);
    const ask = oc.text("shell-ask");
    expect(ask).toContain("permission: ShellID.ToolID");
    expect(ask).toMatch(/metadata: \{\s+command: input\.command,\s+\}/);
  });

  it("applies OPENCODE_PERMISSION after managed configuration and macOS MDM", () => {
    const layers = oc.text("config-managed-permission");
    expect(layers.indexOf("managedConfigDir")).toBeLessThan(layers.indexOf("readManagedPreferences"));
    expect(layers.indexOf("readManagedPreferences")).toBeLessThan(layers.indexOf("Flag.OPENCODE_PERMISSION"));
    expect(oc.text("config-env-layers")).toContain("if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG)");
    // `.opencode` under the real home is searched whatever the project flag says.
    expect(oc.text("config-directories")).toContain("start: Global.Path.home");
  });
});
