/**
 * An MCP tool a call's metadata claims is advisory (#1021). Gemini CLI titles an MCP ask
 * `create_issue(title: x)` and keeps the server only in `_meta["gemini-cli"].mcp`, so a rule
 * written for `github: create_issue` did not apply to it, and a grant recorded from its title
 * also allowed the same tool on another server. The agent writes that metadata and ORCA has
 * nothing to check it against, so it can bring a deny or an ask into play and never an allow:
 * such a call is answered once each time, unless something denies it.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { derivePermissionRules, mcpToolClaimOf, type PermissionPolicy } from "@orca/core";
import { decidePermission, explainPermission, loadEffectivePermissionPolicy, recordAlwaysDecision } from "@orca/agents";

/** A Gemini-shaped MCP ask: the title has the tool and its arguments, the server is in `_meta`. */
const gemini = (
  server: unknown,
  title = "create_issue(title: x)",
  tool: unknown = "create_issue",
  kind: acp.ToolKind = "other",
): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: {
    toolCallId: "t",
    kind,
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

describe("the MCP tool a call claims", () => {
  it("is a structured, unverified claim, with no identity when it is not named plainly", () => {
    expect(mcpToolClaimOf(gemini("github").toolCall)).toEqual({
      source: "gemini-cli-meta",
      verified: false,
      identity: { server: "github", tool: "create_issue" },
    });
    expect(mcpToolClaimOf(claude("github: create_issue").toolCall)).toBeUndefined();
    for (const bad of ["", 7, "git\nhub", " github", "git: hub"])
      expect(mcpToolClaimOf(gemini(bad).toolCall)).toEqual({ source: "gemini-cli-meta", verified: false });
    expect(mcpToolClaimOf({ _meta: { "gemini-cli": { mcp: null } } })).toEqual({
      source: "gemini-cli-meta",
      verified: false,
    });
  });
});

describe("deny and ask rules written for an MCP tool (#1021)", () => {
  it("apply to Gemini's call to that server's tool, in either title form, and not another server's", () => {
    const byServer = { match: { kind: "other" as const, titlePattern: "^github: create_issue$" } };
    expect(decidePermission(policy({ ...byServer, decision: "deny" }), gemini("github"))).toBe("deny");
    expect(
      decidePermission(
        policy({ match: { kind: "other", titlePattern: "^create_issue\\(title: x\\)$" }, decision: "deny" }),
        gemini("github"),
      ),
    ).toBe("deny");
    expect(decidePermission(policy({ ...byServer, decision: "deny" }), gemini("gitlab"))).toBe("ask");
    expect(
      explainPermission({ default: "allow", rules: [{ ...byServer, decision: "ask" }] }, gemini("github")),
    ).toEqual({ decision: "ask", basis: "rule", ruleIndex: 0 });
    // A claim that names its server badly is still denied by the agent's own title.
    expect(
      decidePermission(
        policy({ match: { kind: "other", titlePattern: "^create_issue" }, decision: "deny" }),
        gemini(""),
      ),
    ).toBe("deny");
  });

  it("keep matching a call with no claim exactly as before", () => {
    const rule = { match: { kind: "other" as const, titlePattern: "^github: create_issue$" } };
    expect(decidePermission(policy({ ...rule, decision: "deny" }), claude("github: create_issue"))).toBe("deny");
    expect(decidePermission(policy({ ...rule, decision: "allow" }), claude("github: create_issue"))).toBe("allow");
  });
});

describe("no allow decides a call that claims an MCP tool (#1021)", () => {
  it("by the claimed server: tool, by the agent's title, or by a rule with no title at all", () => {
    for (const allow of [
      { kind: "other" as const, titlePattern: "^github: create_issue$" },
      { kind: "other" as const, titlePattern: "^create_issue\\(title: x\\)$" },
      { kind: "other" as const },
      {},
    ]) {
      expect(
        decidePermission(policy({ match: allow, decision: "allow" }), gemini("github")),
        JSON.stringify(allow),
      ).toBe("ask");
      expect(decidePermission(policy({ match: allow, decision: "allow" }), gemini("gitlab"))).toBe("ask");
    }
    // Whatever kind the agent gives it, and whatever the fallthrough says.
    expect(decidePermission({ default: "allow", rules: [] }, gemini("github", "read it", "read", "read"))).toBe("ask");
    expect(explainPermission({ default: "allow", rules: [] }, gemini("github"))).toEqual({
      decision: "ask",
      basis: "unverified-identity",
    });
    expect(decidePermission({ default: "deny", rules: [] }, gemini("github"))).toBe("deny");
  });
});

describe("standing rules for a call that claims an MCP tool (#1021)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const tempFile = async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-mcp-claim-"));
    dirs.push(dir);
    return { dir, file: join(dir, "orca.permissions.json") };
  };

  it("are never derived as an allow, by title, path or any other scope", () => {
    for (const mcpClaim of [mcpToolClaimOf(gemini("github").toolCall), mcpToolClaimOf(gemini("").toolCall)])
      expect(
        derivePermissionRules({ kind: "read", title: "x", paths: ["/w/a.txt"], workspaceCwd: "/w", mcpClaim }, "allow"),
      ).toMatchObject({ ok: false, reason: "unverified-identity" });
  });

  it("are not saved as an allow, derived or handed in already chosen", async () => {
    const { dir, file } = await tempFile();
    const derived = await recordAlwaysDecision({
      file,
      agentId: "g",
      request: gemini("github"),
      decision: "allow",
      workspaceCwd: dir,
    });
    expect(derived.refused?.reason).toBe("unverified-identity");
    const chosen = await recordAlwaysDecision({
      file,
      agentId: "g",
      request: gemini("github"),
      decision: "allow",
      workspaceCwd: dir,
      rules: [{ match: { kind: "other", titlePattern: "^github: create_issue$" }, decision: "allow" }],
    });
    expect(chosen.refused?.reason).toBe("unverified-identity");
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("save a deny by the claimed server: tool, which denies that server's tool and not another's", async () => {
    const { dir, file } = await tempFile();
    const result = await recordAlwaysDecision({
      file,
      agentId: "g",
      request: gemini("github"),
      decision: "deny",
      workspaceCwd: dir,
    });
    expect(result.added).toEqual([
      { match: { kind: "other", titlePattern: "^github: create_issue$" }, decision: "deny" },
    ]);
    // The agent's own title is kept as the provenance a person reads, never as the pattern.
    expect(JSON.parse(await readFile(file, "utf8")).agents.g.rules[0]).toMatchObject({
      grantedFor: "create_issue(title: x)",
    });
    const loaded = await loadEffectivePermissionPolicy({ id: "g", permissions: { default: "ask", rules: [] } }, [file]);
    expect(decidePermission(loaded, gemini("github"))).toBe("deny");
    expect(decidePermission(loaded, gemini("gitlab"))).toBe("ask");
  });
});

describe("matching by the claim never weakens a restriction (#1021 review)", () => {
  const askByServer = {
    match: { kind: "other" as const, titlePattern: "^github: create_issue$" },
    decision: "ask" as const,
  };
  const denyByTitle = {
    match: { kind: "other" as const, titlePattern: "^create_issue\\(" },
    decision: "deny" as const,
  };

  it("keeps a deny the agent's title meets when an earlier ask meets only the claim", () => {
    expect(explainPermission(policy(askByServer, denyByTitle), gemini("github"))).toEqual({
      decision: "deny",
      basis: "rule",
      ruleIndex: 1,
    });
    // The claim still adds the ask where nothing denies.
    expect(explainPermission({ default: "allow", rules: [askByServer] }, gemini("github"))).toMatchObject({
      decision: "ask",
      basis: "rule",
    });
  });

  it("keeps a deny the claim meets when an earlier ask meets only the agent's title", () => {
    const askByTitle = { ...denyByTitle, decision: "ask" as const };
    const denyByServer = { ...askByServer, decision: "deny" as const };
    expect(decidePermission(policy(askByTitle, denyByServer), gemini("github"))).toBe("deny");
  });

  it("decides a call with no claim exactly by its title, in the same compositions", () => {
    const sameTitle = claude("create_issue(title: x)");
    expect(explainPermission(policy(askByServer, denyByTitle), sameTitle)).toEqual({
      decision: "deny",
      basis: "rule",
      ruleIndex: 1,
    });
    expect(
      decidePermission(policy({ ...denyByTitle, decision: "allow" }, askByServer), claude("create_issue(title: x)")),
    ).toBe("allow");
    expect(decidePermission(policy(askByServer, denyByTitle), claude("github: create_issue"))).toBe("ask");
  });

  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("keeps a saved deny a deny when a configured ask meets the claim first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-mcp-compose-"));
    dirs.push(dir);
    const file = join(dir, "orca.permissions.json");
    // A deny saved from a call with no claim, so it names the agent's title.
    await recordAlwaysDecision({
      file,
      agentId: "g",
      request: claude("create_issue(title: x)"),
      decision: "deny",
      workspaceCwd: dir,
    });
    const loaded = await loadEffectivePermissionPolicy(
      { id: "g", permissions: { default: "allow", rules: [askByServer] } },
      [file],
    );
    expect(decidePermission(loaded, gemini("github"))).toBe("deny");
    expect(decidePermission(loaded, gemini("gitlab"))).toBe("deny");
    expect(decidePermission(loaded, claude("create_issue(title: x)"))).toBe("deny");
    expect(decidePermission(loaded, gemini("github", "create_issue (github MCP Server)"))).toBe("ask");
  });

  it("keeps a saved deny for the claimed tool a deny under a configured ask by title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-mcp-compose-"));
    dirs.push(dir);
    const file = join(dir, "orca.permissions.json");
    await recordAlwaysDecision({ file, agentId: "g", request: gemini("github"), decision: "deny", workspaceCwd: dir });
    const loaded = await loadEffectivePermissionPolicy(
      { id: "g", permissions: { default: "allow", rules: [{ ...denyByTitle, decision: "ask" }] } },
      [file],
    );
    expect(decidePermission(loaded, gemini("github"))).toBe("deny");
    expect(decidePermission(loaded, gemini("gitlab"))).toBe("ask");
  });
});
