/**
 * MCP calls are matched and recorded by `server: tool` (#1021). Gemini CLI titles an MCP ask
 * `create_issue(title: x)` and keeps the server only in `_meta["gemini-cli"].mcp`, so a rule
 * written for `github: create_issue` did not apply to it, and a grant recorded from its title
 * also allowed the same tool on another server.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { derivePermissionRules, mcpToolOf, permissionTitleOf, type PermissionPolicy } from "@orca/core";
import { decidePermission, loadEffectivePermissionPolicy, recordAlwaysDecision } from "@orca/agents";

/** A Gemini-shaped MCP ask: the title has the tool and its arguments, the server is in `_meta`. */
const gemini = (
  server: unknown,
  title = "create_issue(title: x)",
  tool: unknown = "create_issue",
): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: {
    toolCallId: "t",
    kind: "other",
    title,
    _meta: { "gemini-cli": { mcp: { server_name: server, tool_name: tool } } },
  },
  options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
});
const claude = (title: string): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t", kind: "other", title },
  options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
});

const policy = (...rules: PermissionPolicy["rules"]): PermissionPolicy => ({ default: "ask", rules });

describe("the title an MCP call is matched by", () => {
  it("is server: tool when the agent names both, its own title otherwise, and nothing when it names them badly", () => {
    expect(permissionTitleOf(gemini("github").toolCall)).toBe("github: create_issue");
    expect(permissionTitleOf(claude("github: create_issue").toolCall)).toBe("github: create_issue");
    expect(mcpToolOf(claude("x").toolCall)).toBeUndefined();
    expect(permissionTitleOf(gemini("").toolCall)).toBeUndefined();
    expect(permissionTitleOf(gemini(7).toolCall)).toBeUndefined();
    expect(permissionTitleOf(gemini("git\nhub").toolCall)).toBeUndefined();
    expect(permissionTitleOf({ title: "t", _meta: { "gemini-cli": { mcp: null } } })).toBeUndefined();
  });
});

describe("rules written for an MCP tool (#1021)", () => {
  it("deny Gemini's call to that server's tool, in either title form", () => {
    expect(
      decidePermission(
        policy({ match: { kind: "other", titlePattern: "^github: create_issue$" }, decision: "deny" }),
        gemini("github"),
      ),
    ).toBe("deny");
    expect(
      decidePermission(
        policy({ match: { kind: "other", titlePattern: "^create_issue\\(title: x\\)$" }, decision: "deny" }),
        gemini("github"),
      ),
    ).toBe("deny");
    // And not another server's tool of the same name.
    expect(
      decidePermission(
        policy({ match: { kind: "other", titlePattern: "^github: create_issue$" }, decision: "deny" }),
        gemini("gitlab"),
      ),
    ).toBe("ask");
  });

  it("allow only by server: tool, so a grant on one server never reaches another", () => {
    const grant = policy({ match: { kind: "other", titlePattern: "^github: create_issue$" }, decision: "allow" });
    expect(decidePermission(grant, gemini("github"))).toBe("allow");
    expect(decidePermission(grant, gemini("gitlab"))).toBe("ask");
    expect(decidePermission(grant, claude("github: create_issue"))).toBe("allow");
    // A grant recorded from Gemini's title before this fix no longer allows anything.
    const old = policy({ match: { kind: "other", titlePattern: "^create_issue\\(title: x\\)$" }, decision: "allow" });
    expect(decidePermission(old, gemini("github"))).toBe("ask");
    // An MCP call that names its server badly is allowed by no title rule, but still denied.
    expect(
      decidePermission(policy({ match: { kind: "other", titlePattern: ".*" }, decision: "allow" }), gemini("")),
    ).toBe("ask");
    expect(
      decidePermission(
        policy({ match: { kind: "other", titlePattern: "^create_issue" }, decision: "deny" }),
        gemini(""),
      ),
    ).toBe("deny");
  });
});

describe("recording an always answer for an MCP call (#1021)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("writes server: tool, which allows that server's tool and not another's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-mcp-title-"));
    dirs.push(dir);
    const file = join(dir, "orca.permissions.json");
    const result = await recordAlwaysDecision({
      file,
      agentId: "g",
      request: gemini("github"),
      decision: "allow",
      workspaceCwd: dir,
    });
    expect(result.added).toEqual([
      { match: { kind: "other", titlePattern: "^github: create_issue$" }, decision: "allow" },
    ]);
    // The agent's own title is kept as the provenance a person reads, never as the pattern.
    expect(JSON.parse(await readFile(file, "utf8")).agents.g.rules[0]).toMatchObject({
      match: { titlePattern: "^github: create_issue$" },
      grantedFor: "create_issue(title: x)",
    });
    const loaded = await loadEffectivePermissionPolicy({ id: "g", permissions: { default: "ask", rules: [] } }, [file]);
    expect(decidePermission(loaded, gemini("github"))).toBe("allow");
    expect(decidePermission(loaded, gemini("gitlab"))).toBe("ask");
  });

  it("refuses to record one whose server is not named plainly", () => {
    const tc = gemini("").toolCall;
    expect(derivePermissionRules({ kind: tc.kind, title: permissionTitleOf(tc) }, "allow")).toMatchObject({
      ok: false,
      reason: "unscopable",
    });
  });
});
