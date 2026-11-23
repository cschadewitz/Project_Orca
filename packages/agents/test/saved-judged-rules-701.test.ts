/**
 * Saved plain-language rules (#701, item 3b): the app's save method writes a judged rule to the
 * sidecar, which becomes version 4; the loader carries it in `policy.judged` after every
 * hand-written rule; and the judged lane can allow one call by it, exactly as by a configured one.
 */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, PermissionPolicyFileSchema, PERMISSION_JUDGED_VERSION } from "@orca/core";
import {
  judgedLane,
  loadEffectivePermissionPolicy,
  readPermissionPolicyFile,
  recordAlwaysDecision,
  replacePermissionPolicyFile,
  saveJudgedRule,
  type PermissionEvalContext,
} from "@orca/agents";
import type { JudgePermission } from "../src/review-judge/plain-rule.js";

let ws: string;
let file: string;
let ctx: PermissionEvalContext;
beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), "orca-saved-judged-")));
  await mkdir(join(ws, "src"));
  await writeFile(join(ws, "src", "a.ts"), "export {};\n");
  file = join(ws, "orca.permissions.json");
  ctx = { workspaceCwd: ws, protectedPaths: { readOnly: [file], noAccess: [] } };
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const NOW = new Date("2026-11-23T12:00:00.000Z");
const READS = { kind: "read" as const, scope: "workspace" as const };
const save = (over: Partial<Parameters<typeof saveJudgedRule>[0]> = {}) =>
  saveJudgedRule({ file, agentId: "a", match: READS, criterion: "Reading source.", now: () => NOW, ...over });

const agent = (rules: unknown[] = []) =>
  AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask", rules } });

const call = (kind: string, ...paths: string[]): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t", kind: kind as acp.ToolKind, title: kind, locations: paths.map((path) => ({ path })) },
  options: [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
});

describe("saving a judged rule", () => {
  it("appends it with provenance and makes the file version 4", async () => {
    const saved = await save();
    expect(saved).toMatchObject({ agentId: "a", ruleId: "sidecar:0", outcome: "added" });
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toEqual({
      version: PERMISSION_JUDGED_VERSION,
      agents: {
        a: {
          rules: [{ match: READS, judge: { criterion: "Reading source." }, addedAt: "2026-11-23T12:00:00.000Z" }],
        },
      },
    });
    // The reader takes what the writer wrote.
    expect((await readPermissionPolicyFile(file)).version).toBe(4);
  });

  it("goes after the typed rules already there, and is named by its place as written", async () => {
    await recordAlwaysDecision({
      file,
      agentId: "a",
      request: call("read", join(ws, "src", "a.ts")),
      decision: "deny",
      workspaceCwd: ws,
    });
    const saved = await save();
    expect(saved.ruleId).toBe("sidecar:1");
    const doc = await readPermissionPolicyFile(file);
    expect(doc.agents["a"]!.rules.map((r) => ("judge" in r && r.judge ? "judged" : "typed"))).toEqual([
      "typed",
      "judged",
    ]);
  });

  it("never appends the same rule twice, and extends one that ends sooner in place", async () => {
    const later = "2026-12-01T00:00:00.000Z";
    expect((await save({ expiresAt: "2026-11-24T00:00:00.000Z" })).outcome).toBe("added");
    expect((await save({ expiresAt: "2026-11-23T18:00:00.000Z" })).outcome).toBe("already-present");
    const extended = await save({ expiresAt: later });
    expect(extended).toMatchObject({ outcome: "extended", ruleId: "sidecar:0" });
    expect(extended.rule.expiresAt).toBe(later);
    // A different criterion over the same match is a different rule.
    expect((await save({ criterion: "Reading docs." })).ruleId).toBe("sidecar:1");
    expect((await readPermissionPolicyFile(file)).agents["a"]!.rules).toHaveLength(2);
  });

  it.each([
    ["no kind", { match: { scope: "workspace" as const } }],
    ["a kind the lane never opens for", { match: { kind: "edit" as const, scope: "workspace" as const } }],
    ["execute", { match: { kind: "execute" as const } }],
    ["a command", { match: { kind: "read" as const, command: "git status" } }],
    ["an absolute path", { match: { kind: "read" as const, path: "/etc/passwd" } }],
    ["a path out of the workspace", { match: { kind: "read" as const, pathPrefix: "src/../../x" } }],
    ["a home path", { match: { kind: "read" as const, pathPrefix: "~/.ssh" } }],
    ["a drive path", { match: { kind: "read" as const, path: "C:secrets" } }],
    ["an empty criterion", { criterion: "   " }],
    ["an expiry that is not after now", { expiresAt: NOW.toISOString() }],
  ])("refuses %s and writes nothing", async (_name, over) => {
    await expect(save(over)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks authority under the lock and writes nothing when it fails", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("revoked");
    });
    await expect(save({ authorize })).rejects.toThrow("revoked");
    expect(authorize).toHaveBeenCalledTimes(1);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to write over a sidecar this build cannot read", async () => {
    const bytes = `${JSON.stringify({ version: 2, agents: {}, scopedRules: { version: 1, records: [] } })}\n`;
    await writeFile(file, bytes);
    await expect(save()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });
});

describe("the version-4 sidecar", () => {
  it("refuses a judged row in a version 1 or 3 file rather than read it", () => {
    const judged = { match: READS, judge: { criterion: "Reading source." } };
    for (const version of [1, 3])
      expect(PermissionPolicyFileSchema.safeParse({ version, agents: { a: { rules: [judged] } } }).success).toBe(false);
    expect(PermissionPolicyFileSchema.safeParse({ version: 4, agents: { a: { rules: [judged] } } }).success).toBe(true);
  });

  it("refuses a row with both a decision and a judge, or a saved judged rule with no kind", () => {
    const parse = (rule: unknown) =>
      PermissionPolicyFileSchema.safeParse({ version: 4, agents: { a: { rules: [rule] } } }).success;
    expect(parse({ match: READS, judge: { criterion: "x" }, decision: "allow" })).toBe(false);
    expect(parse({ match: { scope: "workspace" }, judge: { criterion: "x" } })).toBe(false);
    expect(parse({ match: READS, decision: "allow" })).toBe(true);
  });

  it("keeps a saved rule through an always answer, and stays version 4", async () => {
    await save();
    await recordAlwaysDecision({
      file,
      agentId: "a",
      request: call("read", join(ws, "src", "a.ts")),
      decision: "deny",
      workspaceCwd: ws,
    });
    const doc = await readPermissionPolicyFile(file);
    expect(doc.version).toBe(4);
    expect(doc.agents["a"]!.rules).toHaveLength(2);
    expect(doc.agents["a"]!.rules[0]).toMatchObject({ judge: { criterion: "Reading source." } });
  });

  it("is replaced by a Config-surface edit, and removing the last judged rule moves it back to version 1", async () => {
    await save();
    const doc = await readPermissionPolicyFile(file);
    await replacePermissionPolicyFile(file, doc);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(4);
    await replacePermissionPolicyFile(file, { version: 4, agents: { a: { rules: [] } } });
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });
});

describe("loading saved judged rules", () => {
  it("carries them in policy.judged after the configured ones, and leaves the typed rules as they were", async () => {
    await save();
    const typedOnly = await loadEffectivePermissionPolicy(agent(), []);
    const policy = await loadEffectivePermissionPolicy(
      agent([{ match: { kind: "search", scope: "workspace" }, judge: { criterion: "Searching." } }]),
      [file],
    );
    expect(policy.judged?.map((r) => [r.ruleId, r.criterion])).toEqual([
      ["config:0", "Searching."],
      ["sidecar:0", "Reading source."],
    ]);
    expect(policy.rules).toEqual(typedOnly.rules);
    expect(policy.default).toBe("ask");
  });

  it("skips one whose lifetime has ended", async () => {
    await save({ expiresAt: "2026-11-23T13:00:00.000Z" });
    const at = (iso: string) => () => Date.parse(iso);
    const before = await loadEffectivePermissionPolicy(
      agent(),
      [file],
      undefined,
      undefined,
      at("2026-11-23T12:30:00Z"),
    );
    const after = await loadEffectivePermissionPolicy(
      agent(),
      [file],
      undefined,
      undefined,
      at("2026-11-23T13:00:00Z"),
    );
    expect(before.judged?.map((r) => r.ruleId)).toEqual(["sidecar:0"]);
    expect(after.judged).toBeUndefined();
  });

  it("drops every judged rule when a sidecar cannot be read", async () => {
    await save();
    const broken = join(ws, "broken.json");
    await writeFile(broken, "{");
    const policy = await loadEffectivePermissionPolicy(
      agent([{ match: READS, judge: { criterion: "Reading source." } }]),
      [file, broken],
      () => {},
    );
    expect(policy.judged).toBeUndefined();
    expect(policy.commandsRestricted).toBe(true);
  });

  it("lets the judged lane allow one read by a saved rule, and names it", async () => {
    await save();
    const judge = vi.fn<JudgePermission>(async (input) => ({
      outcome: "allow",
      verdict: "covered",
      ruleId: input.rules[0]!.ruleId,
      ruleRevision: input.rules[0]!.ruleRevision,
      reasonCode: "matches-criterion",
      verdicts: [],
      judgeConfigRef: "judge-ref",
    }));
    const load = () => loadEffectivePermissionPolicy(agent(), [file]);
    const lane = judgedLane({ judge, reload: load, localHost: true });
    const request = call("read", join(ws, "src", "a.ts"));
    const answer = await lane(await load(), request, ctx, new AbortController().signal);
    expect(answer).toMatchObject({ decision: "allow", basis: "judged", judged: { ruleId: "sidecar:0" } });
    expect(judge.mock.calls[0]![0].rules.map((r) => r.criterion)).toEqual(["Reading source."]);
  });

  it("closes the lane for a saved rule when a typed restriction matches, wherever it is", async () => {
    await save();
    await recordAlwaysDecision({
      file,
      agentId: "a",
      request: call("read", join(ws, "src", "a.ts")),
      decision: "deny",
      workspaceCwd: ws,
    });
    const judge = vi.fn<JudgePermission>();
    const load = () => loadEffectivePermissionPolicy(agent(), [file]);
    const lane = judgedLane({ judge, reload: load, localHost: true });
    const answer = await lane(await load(), call("read", join(ws, "src", "a.ts")), ctx, new AbortController().signal);
    expect(answer.decision).toBe("deny");
    expect(judge).not.toHaveBeenCalled();
  });
});
