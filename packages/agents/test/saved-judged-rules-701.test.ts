/**
 * Saved plain-language rules (#701, item 3b): the app's save method writes a judged rule to the
 * sidecar, which becomes version 4; the loader carries it in `policy.judged` after every
 * hand-written rule; and the judged lane can allow one call by it, exactly as by a configured one.
 */
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readlinkSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** This process's liveness domain, computed as the lock does; null where none is established. */
const DOMAIN = ((): string | null => {
  if (process.platform !== "linux") return null;
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `linux:${boot}:${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return null;
  }
})();
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
    ["a title pattern that does not compile", { match: { kind: "read" as const, titlePattern: "[" } }],
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

describe("sidecar ownership", () => {
  it("never takes over a lock by age, from a writer of this release or a legacy lock file", async () => {
    await save();
    const before = await readFile(file, "utf8");
    const lock = `${file}.lock`;
    for (const leftover of ["directory", "legacy file"] as const) {
      if (leftover === "directory") await mkdir(lock);
      else await writeFile(lock, JSON.stringify({ pid: 1, at: "2020-01-01T00:00:00.000Z" }));
      await utimes(lock, new Date(0), new Date(0));
      for (const write of [
        () => save({ criterion: "Reading docs.", lock: { timeoutMs: 40, staleMs: 0 } }),
        () => replacePermissionPolicyFile(file, { version: 1, agents: {} }, { lock: { timeoutMs: 40, staleMs: 0 } }),
        () =>
          recordAlwaysDecision({
            file,
            agentId: "a",
            request: call("read", join(ws, "src", "a.ts")),
            decision: "deny",
            workspaceCwd: ws,
            lock: { timeoutMs: 40, staleMs: 0 },
          }),
      ])
        await expect(write()).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
      expect(await readFile(file, "utf8")).toBe(before);
      await rm(lock, { recursive: true });
    }
  });

  it("commits nothing once its ownership is gone, and leaves the successor's lock and edit", async () => {
    await save();
    const before = await readFile(file, "utf8");
    const lock = `${file}.lock`;
    let calls = 0;
    // Unsupported interference standing in for a lost lock: the guarantee is that no
    // supported writer takes one over; this checks the final ownership check as well.
    const authorize = async () => {
      if (++calls > 1) return;
      await rename(lock, `${lock}.retired`);
      await mkdir(lock);
      await writeFile(file, before.replace("Reading source.", "Edited meanwhile."));
    };
    await expect(save({ criterion: "Reading docs.", authorize })).rejects.toMatchObject({
      code: "STORE_LOCK_TIMEOUT",
    });
    expect((await stat(lock)).isDirectory()).toBe(true);
    expect(await readFile(file, "utf8")).toContain("Edited meanwhile.");
    expect(await readFile(file, "utf8")).not.toContain("Reading docs.");
  });
});

describe("a lock left by a sidecar writer that is gone", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });
  const writer = () => {
    const child = fork(fileURLToPath(new URL("./sidecar-lock-child.ts", import.meta.url)), [file], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    return { child, message: () => once(child, "message").then(([value]) => value as { state: string }) };
  };

  it.skipIf(DOMAIN === null)(
    "is removed without a person once its process is dead, and the next save goes through",
    async () => {
      const child = writer();
      expect(await child.message()).toMatchObject({ state: "locked" });
      const exited = once(child.child, "exit");
      child.child.kill("SIGKILL");
      await exited;
      await utimes(`${file}.lock`, new Date(), new Date());
      expect(await save({ lock: { timeoutMs: 2_000 } })).toMatchObject({ outcome: "added" });
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readPermissionPolicyFile(file)).agents["a"]!.rules).toHaveLength(1);
    },
  );

  it("is kept while its process is running, however long it waits", async () => {
    const child = writer();
    expect(await child.message()).toMatchObject({ state: "locked" });
    await utimes(`${file}.lock`, new Date(0), new Date(0));
    await expect(save({ lock: { timeoutMs: 100 } })).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    const saved = child.message();
    child.child.send("continue");
    expect(await saved).toMatchObject({ state: "saved" });
    expect((await readPermissionPolicyFile(file)).agents["a"]!.rules[0]).toMatchObject({
      judge: { criterion: "Written by the child." },
    });
  });

  const dead = 2 ** 22 + 12345; // above the default pid range, so no process has it
  const nonce = "0f0f0f0f-0000-4000-8000-000000000000";
  const valid = () => ({ version: 1, kind: "sidecar", pid: dead, domain: DOMAIN, nonce });
  const leave = async (name: string, text: string) => {
    await mkdir(`${file}.lock`, { mode: 0o700 });
    await writeFile(join(`${file}.lock`, name), text, { mode: 0o600 });
  };

  it.skipIf(DOMAIN === null)("is removed for a well-formed token of this liveness domain", async () => {
    await leave(`owner.${dead}.${nonce}.json`, JSON.stringify(valid()));
    expect(await save({ lock: { timeoutMs: 2_000 } })).toMatchObject({ outcome: "added" });
  });

  it("is never removed for another owner, another liveness domain, or a token it cannot fully read", async () => {
    const name = `owner.${dead}.${nonce}.json`;
    const cases: [string, string][] = [
      [name, JSON.stringify({ version: 1, pid: dead, nonce })], // a typed or budget owner: no kind
      [name, JSON.stringify({ ...valid(), domain: "linux:another-boot:pid:[1]" })],
      [name, JSON.stringify({ ...valid(), domain: null })], // no liveness domain was known
      [`owner.${dead + 1}.${nonce}.json`, JSON.stringify(valid())], // the name and the token disagree
      [`owner.${dead}.not-a-uuid.json`, JSON.stringify(valid())],
      [`owner.${dead}.1f0f0f0f-0000-4000-8000-000000000000.json`, JSON.stringify(valid())], // another nonce
      [name, JSON.stringify({ ...valid(), nonce: "n" })],
      [name, JSON.stringify({ ...valid(), version: 2 })],
      [name, JSON.stringify({ ...valid(), extra: true })],
      [name, JSON.stringify({ ...valid(), pid: String(dead) })],
      [name, "{not json"],
      [name, "[]"],
    ];
    for (const [entry, text] of cases) {
      await leave(entry, text);
      await expect(save({ lock: { timeoutMs: 60 } })).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
      expect(await readdir(`${file}.lock`)).toEqual([entry]);
      await rm(`${file}.lock`, { recursive: true });
    }
    // Nor an empty directory (a crash between taking the lock and writing its token), nor two tokens.
    await mkdir(`${file}.lock`);
    await expect(save({ lock: { timeoutMs: 60 } })).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    expect((await stat(`${file}.lock`)).isDirectory()).toBe(true);
    await writeFile(join(`${file}.lock`, name), JSON.stringify(valid()));
    await writeFile(
      join(`${file}.lock`, `owner.${dead}.1f0f0f0f-0000-4000-8000-000000000000.json`),
      JSON.stringify(valid()),
    );
    await expect(save({ lock: { timeoutMs: 60 } })).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    expect(await readdir(`${file}.lock`)).toHaveLength(2);
  });

  it.skipIf(DOMAIN === null)(
    "is recovered once while ordinary writers contend for it, and every one of them commits",
    async () => {
      await leave(`owner.${dead}.${nonce}.json`, JSON.stringify(valid()));
      const criteria = Array.from({ length: 6 }, (_, i) => `Reading part ${i}.`);
      const results = await Promise.all(criteria.map((criterion) => save({ criterion, lock: { timeoutMs: 5_000 } })));
      expect(results.map((r) => r.outcome)).toEqual(criteria.map(() => "added"));
      const rules = (await readPermissionPolicyFile(file)).agents["a"]!.rules;
      expect(rules.map((r) => ("judge" in r ? r.judge?.criterion : undefined)).sort()).toEqual([...criteria].sort());
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(DOMAIN === null)(
    "is left for a person outside a private workspace: a shared directory, lock or token",
    async () => {
      const name = `owner.${dead}.${nonce}.json`;
      const shared = [
        () => chmod(ws, 0o775),
        () => chmod(`${file}.lock`, 0o770),
        () => chmod(join(`${file}.lock`, name), 0o660),
      ];
      for (const share of shared) {
        await leave(name, JSON.stringify(valid()));
        await share();
        await expect(save({ lock: { timeoutMs: 60 } })).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
        expect(await readdir(`${file}.lock`)).toEqual([name]);
        await chmod(ws, 0o700);
        await rm(`${file}.lock`, { recursive: true });
      }
    },
  );

  it.skipIf(DOMAIN === null)("is never removed through a link, for the lock or its token", async () => {
    const name = `owner.${dead}.${nonce}.json`;
    // The lock is a symbolic link to a directory holding a dead, well-formed token.
    const elsewhere = join(ws, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, name), JSON.stringify(valid()));
    await symlink(elsewhere, `${file}.lock`);
    await expect(save({ lock: { timeoutMs: 60 } })).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    expect(await readdir(elsewhere)).toEqual([name]);
    expect((await lstat(`${file}.lock`)).isSymbolicLink()).toBe(true);
    await rm(`${file}.lock`);
    // The token is a second link to a file that lives elsewhere too.
    await mkdir(`${file}.lock`);
    await link(join(elsewhere, name), join(`${file}.lock`, name));
    await expect(save({ lock: { timeoutMs: 60 } })).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    expect(await readdir(`${file}.lock`)).toEqual([name]);
  });
});

describe("the version-4 sidecar", () => {
  it("refuses an invalid saved rule wherever it comes from: the reader and a whole-file replace", async () => {
    for (const match of [
      { kind: "read", path: "/etc/passwd" },
      { kind: "read", pathPrefix: "../x" },
      { kind: "read", titlePattern: "(" },
      { kind: "read", titlePattern: "a".repeat(257) },
    ]) {
      const doc = { version: 4, agents: { a: { rules: [{ match, judge: { criterion: "x" } }] } } };
      expect(PermissionPolicyFileSchema.safeParse(doc).success).toBe(false);
      await writeFile(file, JSON.stringify(doc));
      await expect(readPermissionPolicyFile(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(replacePermissionPolicyFile(file, doc)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("fails closed on a title pattern that does not compile: no allow, and a deny still denies", async () => {
    const { decidePermission } = await import("@orca/agents");
    const request = call("read", join(ws, "src", "a.ts"));
    const policy = (decision: "allow" | "deny") => ({
      default: "ask" as const,
      rules: [{ match: { kind: "read" as const, titlePattern: "(" }, decision }],
    });
    expect(decidePermission(policy("allow"), request, ctx)).toBe("ask");
    expect(decidePermission(policy("deny"), request, ctx)).toBe("deny");
  });

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
