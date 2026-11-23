/**
 * What decided a permission (#702): `explainPermission` names the rule, the fallthrough, the
 * protected-path guard or the command restriction, and the loader records where each rule of
 * the evaluated policy came from, so an `agent.permission` event can say which rule it was.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "@orca/core";
import {
  explainPermission,
  loadEffectivePermissionPolicy,
  permissionRuleRecord,
  readPermissionPolicyFileRevision,
  resolvePermission,
} from "@orca/agents";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-rule-record-"));
  dirs.push(dir);
  return dir;
}

const call = (toolCall: acp.ToolCallUpdate): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall,
  options: [
    { optionId: "a", name: "Allow", kind: "allow_once" },
    { optionId: "r", name: "Reject", kind: "reject_once" },
  ],
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("explainPermission", () => {
  const policy: PermissionPolicy = {
    default: "ask",
    rules: [
      { match: { kind: "read" }, decision: "allow" },
      { match: { kind: "edit", path: "a.ts" }, decision: "deny" },
    ],
  };

  it("names the matching rule by its index, and the fallthrough when none matched", () => {
    expect(explainPermission(policy, call({ toolCallId: "t", kind: "read", title: "r" }))).toEqual({
      decision: "allow",
      basis: "rule",
      ruleIndex: 0,
    });
    expect(
      explainPermission(policy, call({ toolCallId: "t", kind: "edit", title: "e", locations: [{ path: "/w/a.ts" }] }), {
        workspaceCwd: "/w",
      }),
    ).toEqual({ decision: "deny", basis: "rule", ruleIndex: 1 });
    expect(explainPermission(policy, call({ toolCallId: "t", kind: "fetch", title: "f" }))).toEqual({
      decision: "ask",
      basis: "default",
    });
  });

  it("says when ORCA's own files were the reason, ahead of every rule", () => {
    const allowAll: PermissionPolicy = { default: "allow", rules: [] };
    const explained = explainPermission(
      allowAll,
      call({ toolCallId: "t", kind: "edit", title: "e", locations: [{ path: "/cfg/orca.config.yaml" }] }),
      { protectedPaths: { readOnly: ["/cfg/orca.config.yaml"], noAccess: [] } },
    );
    expect(explained).toEqual({ decision: "deny", basis: "protected" });
  });

  it("cites the denying command rule, an ask rule, or the restriction itself", () => {
    const commands: PermissionPolicy = {
      default: "allow",
      rules: [
        { match: { kind: "read" }, decision: "allow" },
        { match: { kind: "execute", command: "git push" }, decision: "ask" },
        { match: { kind: "execute", command: "rm" }, decision: "deny" },
      ],
    };
    const run = (command: string) =>
      explainPermission(commands, call({ toolCallId: "t", kind: "execute", title: command, rawInput: { command } }));
    expect(run("ls && rm -rf x")).toEqual({ decision: "deny", basis: "rule", ruleIndex: 2 });
    expect(run("git push origin")).toEqual({ decision: "ask", basis: "rule", ruleIndex: 1 });
    expect(run("ls")).toEqual({ decision: "ask", basis: "command-restricted" });
  });

  it("cites an explicit ask rule over an earlier part that only fell through to an ask default", () => {
    const commands: PermissionPolicy = {
      default: "ask",
      rules: [{ match: { kind: "execute", command: "git push" }, decision: "ask" }],
    };
    const run = (command: string) =>
      explainPermission(commands, call({ toolCallId: "t", kind: "execute", title: command, rawInput: { command } }));
    // `ls` reaches the default ask first; `git push` is the rule that asks. Same outcome either way.
    expect(run("ls && git push origin")).toEqual({ decision: "ask", basis: "rule", ruleIndex: 0 });
    expect(run("git push origin && ls")).toEqual({ decision: "ask", basis: "rule", ruleIndex: 0 });
    expect(run("ls && pwd")).toEqual({ decision: "ask", basis: "default" });
  });

  it("attaches the rule's origin only when the origins line up with the rules", () => {
    const withOrigins: PermissionPolicy = {
      ...policy,
      origins: [
        { layer: "config", index: 0 },
        { layer: "sidecar", index: 3, file: 0, revision: "abc" },
      ],
    };
    const deny = call({ toolCallId: "t", kind: "edit", title: "e", locations: [{ path: "/w/a.ts" }] });
    const explained = explainPermission(withOrigins, deny, { workspaceCwd: "/w" });
    expect(explained.origin).toEqual({ layer: "sidecar", index: 3, file: 0, revision: "abc" });
    expect(permissionRuleRecord(explained)).toEqual({
      basis: "rule",
      layer: "sidecar",
      index: 3,
      file: 0,
      revision: "abc",
    });
    const misaligned = { ...withOrigins, origins: withOrigins.origins!.slice(0, 1) };
    expect(explainPermission(misaligned, deny, { workspaceCwd: "/w" }).origin).toBeUndefined();
  });

  it("travels with resolvePermission's answer", async () => {
    const answered = await resolvePermission(policy, { request: call({ toolCallId: "t", kind: "read", title: "r" }) });
    expect(answered.decision).toBe("allow");
    expect(answered.rule).toEqual({ basis: "rule" });
  });
});

describe("loadEffectivePermissionPolicy records each rule's origin", () => {
  const agent = {
    id: "a1",
    permissions: { rules: [{ match: { kind: "fetch" as const }, decision: "ask" as const }] },
  };

  it("config by index, sidecar by its own index and revision, defaults last", async () => {
    const dir = await temp();
    const file = join(dir, "orca.permissions.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        agents: {
          a1: {
            rules: [
              // Expired and wildcard rules are skipped, but the indexes still name file entries.
              { match: { kind: "edit", path: "old.ts" }, decision: "allow", expiresAt: "2000-01-01T00:00:00.000Z" },
              { match: {}, decision: "allow" },
              { match: { kind: "edit", path: "b.ts" }, decision: "deny" },
            ],
          },
        },
      }),
      "utf8",
    );
    const revision = sha(await readFile(file));
    const policy = await loadEffectivePermissionPolicy(agent, [file], undefined, () => undefined);
    expect(policy.rules.length).toBe(1 + 1 + DEFAULT_PERMISSION_POLICY.rules.length);
    expect(policy.origins?.slice(0, 3)).toEqual([
      { layer: "config", index: 0 },
      { layer: "sidecar", index: 2, file: 0, revision },
      { layer: "default", index: 0 },
    ]);
    expect(policy.origins).toHaveLength(policy.rules.length);
    expect((await readPermissionPolicyFileRevision(file)).revision).toBe(revision);
  });

  it("marks an allow capped to ask behind an unreadable sidecar", async () => {
    const dir = await temp();
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json", "utf8");
    const policy = await loadEffectivePermissionPolicy(agent, [bad], () => undefined);
    const firstDefaultAllow = DEFAULT_PERMISSION_POLICY.rules.findIndex((r) => r.decision === "allow");
    expect(firstDefaultAllow).toBeGreaterThanOrEqual(0);
    expect(policy.rules[1 + firstDefaultAllow]?.decision).toBe("ask");
    expect(policy.origins?.[1 + firstDefaultAllow]).toEqual({
      layer: "default",
      index: firstDefaultAllow,
      capped: true,
    });
    expect(policy.origins?.[0]).toEqual({ layer: "config", index: 0 });
  });

  it("a missing sidecar contributes nothing and has an empty revision", async () => {
    const dir = await temp();
    expect(await readPermissionPolicyFileRevision(join(dir, "none.json"))).toEqual({
      doc: { version: 1, agents: {} },
      revision: "",
    });
  });
});
