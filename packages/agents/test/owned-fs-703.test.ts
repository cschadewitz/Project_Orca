/**
 * ORCA's own file executor is held to the policy (#703).
 *
 * An agent that is given `fs/*` asks ORCA to read and write its files. Before this, those
 * requests checked the session roots and ORCA's own files and nothing else, so an agent that
 * never sent `session/request_permission` wrote whatever the policy would have refused. Here a
 * real ACP agent over stdio makes the calls, and each is decided by the policy just before
 * the I/O: a deny refuses, an ask needs a one-time allow, and that allow is good once.
 */
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type PermissionRule } from "@orca/core";
import {
  isHostFileMissing,
  LocalHost,
  decideFsCall,
  fsToolCall,
  openAcpSession,
  permissionPolicyPath,
  OwnedFsFailedWithoutEffect,
  resolveOwnedFsTarget,
  type FsAuthorizationRecord,
  type FsOperationOutcome,
  type FsOutcomeRecorder,
  type OpenSessionOptions,
  type PermissionRuleRecord,
} from "@orca/agents";

/**
 * An ACP agent that performs the operations in `OPS` during each turn — `fs/*` requests and
 * `session/request_permission` asks — and writes what came back for each to `RESULT_LOG`.
 */
const probingAgent = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const perform = (op) => {
  if (op.write !== undefined) return request("fs/write_text_file", { sessionId: op.session || "s1", path: op.write, content: op.content });
  if (op.read !== undefined) return request("fs/read_text_file", { sessionId: op.session || "s1", path: op.read });
  return request("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "t", title: op.title, kind: op.ask, locations: (op.paths || []).map((path) => ({ path })) },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
};
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "prober", version: "0" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    const results = [];
    for (const op of JSON.parse(process.env.OPS)) results.push(await perform(op));
    require("node:fs").writeFileSync(process.env.RESULT_LOG, JSON.stringify(results));
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve(m.error ? { error: m.error.data, code: m.error.code, message: m.error.message } : { result: m.result });
  }
});
setInterval(() => {}, 1000);
`;

type Op =
  | { write: string; content: string; session?: string }
  | { read: string; session?: string }
  | { ask: string; title: string; paths?: string[] };
type Outcome = { result?: unknown; error?: { path?: string; reason?: string }; code?: number; message?: string };

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
async function workspace(): Promise<string> {
  const dir = await temp("orca-owned-fs-");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), "export {};\n", "utf8");
  return dir;
}

/**
 * One turn of the probing agent with `policy`. `answer` stands for the person: it gets each
 * ask ORCA puts through and returns an option id, or undefined for no answer channel at all.
 */
async function turn(
  dir: string,
  ops: Op[],
  policy: { default?: "allow" | "deny" | "ask"; rules?: PermissionRule[] },
  answer?: (request: acp.RequestPermissionRequest) => string | undefined,
  permissionFiles?: string[],
  host: LocalHost = new LocalHost({ id: "local", type: "local" }),
  extra: Partial<OpenSessionOptions> = {},
): Promise<{
  outcomes: Outcome[];
  decisions: string[];
  rules: (PermissionRuleRecord | undefined)[];
  asked: acp.RequestPermissionRequest[];
}> {
  const log = join(await temp("orca-owned-fs-log-"), "results.json");
  const agent = AgentSpecSchema.parse({
    id: "prober",
    command: process.execPath,
    args: ["-e", probingAgent],
    env: { OPS: JSON.stringify(ops), RESULT_LOG: log },
    permissions: { rules: [], ...policy },
  });
  const decisions: string[] = [];
  const rules: (PermissionRuleRecord | undefined)[] = [];
  const asked: acp.RequestPermissionRequest[] = [];
  const session = await openAcpSession({
    ...extra,
    host,
    agent,
    cwd: dir,
    ...(permissionFiles ? { permissionFiles } : {}),
    onPermission: (info) => {
      decisions.push(info.decision);
      rules.push(info.rule);
    },
    ...(answer
      ? {
          askPermission: async (request: acp.RequestPermissionRequest) => {
            asked.push(request);
            return answer(request);
          },
        }
      : {}),
  });
  try {
    await session.prompt("go");
  } finally {
    await session.close();
  }
  return { outcomes: JSON.parse(await readFile(log, "utf8")) as Outcome[], decisions, rules, asked };
}

const refused = (o: Outcome | undefined) => o?.error?.reason;

/** A record as the tests see it: each authorization, then the outcome its recorder was given. */
type FsOperationRecord =
  | ({ phase: "authorized" } & FsAuthorizationRecord)
  | { phase: "completed"; operationId: string; outcome: FsOperationOutcome };

/** `recordFsOperation` collecting into `records`, running `during` while the authorization is written. */
function recorder(
  records: FsOperationRecord[],
  during?: (record: FsAuthorizationRecord) => Promise<void>,
): (record: FsAuthorizationRecord) => Promise<FsOutcomeRecorder> {
  return async (record) => {
    records.push({ phase: "authorized", ...record });
    await during?.(record);
    return async (outcome) => {
      records.push({ phase: "completed", operationId: record.operationId, outcome });
    };
  };
}

describe("the policy decides ORCA's own file executor (#703)", () => {
  it("refuses a write the policy denies, though the agent never asked", async () => {
    const dir = await workspace();
    const secret = join(dir, "src", "a.ts");
    const { outcomes, decisions } = await turn(dir, [{ write: secret, content: "pwned" }], {
      rules: [{ match: { kind: "edit", path: "src/a.ts" }, decision: "deny" }],
    });
    expect(refused(outcomes[0])).toMatch(/not allowed: deny/);
    expect(decisions).toEqual(["fs:deny"]);
    expect(await readFile(secret, "utf8")).toBe("export {};\n");
  });

  it("refuses an ask nobody can answer, before any I/O", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const { outcomes, decisions } = await turn(dir, [{ write: file, content: "x" }, { read: file }], {
      default: "ask",
    });
    expect(refused(outcomes[0])).toMatch(/ask:no-answerer/);
    expect(refused(outcomes[1])).toMatch(/ask:no-answerer/);
    expect(decisions).toEqual(["fs:ask:no-answerer", "fs:ask:no-answerer"]);
    expect(await readFile(file, "utf8")).toBe("export {};\n");
  });

  it("asks on the agent's behalf when it did not, and a one-time allow covers that one call", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "b.ts");
    let answered = 0;
    const { outcomes, decisions, asked } = await turn(
      dir,
      [
        { write: file, content: "one" },
        { write: file, content: "two" },
      ],
      { default: "ask" },
      () => (answered++ === 0 ? "allow" : "reject"),
    );
    // The first is allowed once; the second is asked again and refused.
    expect(outcomes[0]).toEqual({ result: {} });
    expect(refused(outcomes[1])).toMatch(/ask:reject_once/);
    expect(asked.map((r) => [r.toolCall.kind, r.toolCall.title])).toEqual([
      ["edit", `Write ${file}`],
      ["edit", `Write ${file}`],
    ]);
    expect(asked.flatMap((r) => r.options.map((o) => o.kind))).not.toContain("allow_always");
    expect(decisions).toEqual(["fs:ask:allow_once", "fs:ask:reject_once"]);
    expect(await readFile(file, "utf8")).toBe("one");
  });

  it("does not reuse the answer to the agent's own ask: one answer covers one operation", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "c.ts");
    const { outcomes, decisions, asked } = await turn(
      dir,
      [
        { ask: "edit", title: "Edit c.ts", paths: [file] },
        { write: file, content: "first" },
      ],
      { default: "ask" },
      (request) => (request.toolCall.title === "Edit c.ts" ? "allow" : "reject"),
    );
    expect(outcomes[0]).toEqual({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
    // The write is its own operation, put to a person, and refused here.
    expect(refused(outcomes[1])).toMatch(/ask:reject_once/);
    expect(asked.map((r) => r.toolCall.title)).toEqual(["Edit c.ts", `Write ${file}`]);
    expect(decisions).toEqual(["ask:allow_once", "fs:ask:reject_once"]);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads the policy again after a person answers, and a deny that appeared meanwhile wins", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "d.ts");
    const sidecar = permissionPolicyPath(dir);
    const { outcomes, decisions } = await turn(
      dir,
      [{ write: file, content: "late" }],
      { default: "ask" },
      () => {
        // While the person was deciding, a deny for this file was saved.
        writeFileSync(
          sidecar,
          JSON.stringify({
            version: 1,
            agents: { prober: { rules: [{ match: { kind: "edit", path: "src/d.ts" }, decision: "deny" }] } },
          }),
        );
        return "allow";
      },
      [sidecar],
    );
    expect(refused(outcomes[0])).toMatch(/denies it now/);
    expect(decisions).toEqual(["fs:ask:allow_once:denied-since"]);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves only this session's own ACP session", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const { outcomes, decisions } = await turn(
      dir,
      [
        { write: file, content: "x", session: "someone-else" },
        { read: file, session: "someone-else" },
      ],
      { default: "allow" },
    );
    expect(refused(outcomes[0])).toBe("not this session");
    expect(refused(outcomes[1])).toBe("not this session");
    expect(decisions).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("export {};\n");
  });

  it("lets what the policy allows through without asking", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const { outcomes, decisions, asked } = await turn(
      dir,
      [{ write: file, content: "ok" }, { read: file }],
      {
        default: "ask",
        rules: [
          { match: { kind: "edit", path: "src/a.ts" }, decision: "allow" },
          { match: { kind: "read", scope: "workspace" }, decision: "allow" },
        ],
      },
      () => "reject",
    );
    expect(outcomes[0]).toEqual({ result: {} });
    expect(outcomes[1]).toEqual({ result: { content: "ok" } });
    expect(asked).toEqual([]);
    expect(decisions).toEqual(["fs:allow", "fs:allow"]);
  });
});

describe("a read of a file that is not there", () => {
  it("is told apart from other failures by the local host itself", async () => {
    const dir = await workspace();
    const { fs } = new LocalHost({ id: "local", type: "local" });
    expect(isHostFileMissing(await fs.readFile(join(dir, "src", "none.ts")).catch((e: unknown) => e))).toBe(true);
    expect(isHostFileMissing(await fs.readFile(join(dir, "nope", "none.ts")).catch((e: unknown) => e))).toBe(true);
    // A directory is there; reading it fails some other way.
    expect(isHostFileMissing(await fs.readFile(join(dir, "src")).catch((e: unknown) => e))).toBe(false);
  });

  it("is reported as an error, not as missing, when the host cannot classify the failure", async () => {
    const dir = await workspace();
    // A host whose I/O goes through its own file system (any but the local one, whose
    // operations ORCA binds itself), standing in for an SSH host's `cat` fallback.
    const host = new LocalHost({ id: "local", type: "local" });
    Object.defineProperty(host, "spec", { value: { id: "remote", type: "ssh" } });
    host.fs.readFile = () => Promise.reject(Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }));
    const { outcomes } = await turn(
      dir,
      [{ read: join(dir, "src", "new.ts") }],
      { rules: [{ match: { kind: "read", scope: "workspace" }, decision: "allow" }] },
      undefined,
      undefined,
      host,
    );
    expect(outcomes[0]?.code).toBe(-32603);
    expect(outcomes[0]?.message).not.toMatch(/Resource not found/);
  });

  it("answers Resource not found once the policy allows it, so an agent can tell missing from broken", async () => {
    const dir = await workspace();
    const missing = join(dir, "src", "new.ts");
    const { outcomes, decisions } = await turn(dir, [{ read: missing }], {
      rules: [{ match: { kind: "read", scope: "workspace" }, decision: "allow" }],
    });
    expect(outcomes[0]).toMatchObject({
      code: -32002,
      message: `Resource not found: ${missing}`,
      error: { uri: missing },
    });
    expect(decisions).toEqual(["fs:allow"]);
  });

  it("is refused by the policy exactly as an existing file is, before anything is looked up", async () => {
    const dir = await workspace();
    const missing = join(dir, "src", "new.ts");
    const present = join(dir, "src", "a.ts");
    const { outcomes } = await turn(dir, [{ read: missing }, { read: present }], {
      rules: [{ match: { kind: "read" }, decision: "deny" }],
    });
    expect(outcomes[0]?.code).toBe(outcomes[1]?.code);
    expect(refused(outcomes[0])).toBe("not allowed: deny");
    expect(refused(outcomes[1])).toBe("not allowed: deny");
  });
});

describe("each decision records the rule that made it (#702)", () => {
  it("names the config rule, the sidecar rule by its place in the file, and the fallthrough", async () => {
    const dir = await workspace();
    const sidecar = permissionPolicyPath(dir);
    await writeFile(
      sidecar,
      JSON.stringify({
        version: 1,
        agents: {
          prober: {
            rules: [
              { match: { kind: "edit", path: "src/x.ts" }, decision: "ask" },
              { match: { kind: "edit", path: "src/b.ts" }, decision: "deny" },
            ],
          },
        },
      }),
      "utf8",
    );
    const { decisions, rules } = await turn(
      dir,
      [
        { read: join(dir, "src", "a.ts") },
        { write: join(dir, "src", "b.ts"), content: "no" },
        { ask: "fetch", title: "Fetch https://example.test" },
      ],
      { default: "deny", rules: [{ match: { kind: "read", scope: "workspace" }, decision: "allow" }] },
      () => "allow",
      [sidecar],
    );
    expect(decisions).toEqual(["fs:allow", "fs:deny", "deny"]);
    expect(rules).toEqual([
      { basis: "rule", layer: "config", index: 0 },
      // No revision: the file's digest stays out of the public run log (#702 review).
      { basis: "rule", layer: "sidecar", index: 1, file: 0 },
      { basis: "default" },
    ]);
  });
});

describe("an fs call as the policy sees it", () => {
  it("is decided as the kind an ask for it would carry", () => {
    expect(fsToolCall("/w/a.ts", "read")).toMatchObject({ kind: "read", title: "Read /w/a.ts" });
    expect(fsToolCall("/w/a.ts", "write")).toMatchObject({ kind: "edit", title: "Write /w/a.ts" });
    const policy = {
      default: "ask" as const,
      rules: [{ match: { kind: "edit" as const, path: "a.ts" }, decision: "deny" as const }],
    };
    expect(decideFsCall(policy, "/w/a.ts", "write", { workspaceCwd: "/w" })).toBe("deny");
    expect(decideFsCall(policy, "/w/a.ts", "read", { workspaceCwd: "/w" })).toBe("ask");
  });
});

describe("a local fs/* request is decided by the file it reaches (#703)", () => {
  it("refuses a link inside the roots that leads outside them, existing target or not", async () => {
    const dir = await workspace();
    const outside = await temp("orca-owned-fs-outside-");
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "safe", "utf8");
    await symlink(victim, join(dir, "src", "link.txt"));
    await symlink(join(outside, "created.txt"), join(dir, "src", "dangling.txt"));
    await symlink(outside, join(dir, "out"));
    const { outcomes } = await turn(
      dir,
      [
        { write: join(dir, "src", "link.txt"), content: "pwned" },
        { write: join(dir, "src", "dangling.txt"), content: "pwned" },
        { write: join(dir, "out", "new.txt"), content: "pwned" },
        { read: join(dir, "src", "link.txt") },
      ],
      { default: "allow" },
    );
    for (const o of outcomes) expect(refused(o)).toBe("outside session roots once links are followed");
    expect(await readFile(victim, "utf8")).toBe("safe");
    expect(existsSync(join(outside, "created.txt"))).toBe(false);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });

  it("holds a link to a file inside the roots to the rules for that file: the stricter answer stands", async () => {
    const dir = await workspace();
    const target = join(dir, "src", "a.ts");
    await mkdir(join(dir, "docs"));
    await symlink(target, join(dir, "docs", "notes.md"));
    const { outcomes, decisions, rules } = await turn(dir, [{ write: join(dir, "docs", "notes.md"), content: "x" }], {
      default: "allow",
      rules: [
        { match: { kind: "edit", path: "docs/notes.md" }, decision: "allow" },
        { match: { kind: "edit", path: "src/a.ts" }, decision: "deny" },
      ],
    });
    expect(refused(outcomes[0])).toMatch(/not allowed: deny/);
    expect(decisions).toEqual(["fs:deny"]);
    expect(rules[0]).toMatchObject({ basis: "rule", index: 1 });
    expect(await readFile(target, "utf8")).toBe("export {};\n");
  });

  it("asks about the file the link reaches, and a one-time allow writes that file", async () => {
    const dir = await workspace();
    const target = join(dir, "src", "a.ts");
    await symlink(target, join(dir, "alias.ts"));
    const { outcomes, asked } = await turn(
      dir,
      [{ write: join(dir, "alias.ts"), content: "changed" }],
      { default: "ask" },
      () => "allow",
    );
    expect(outcomes[0]?.result).toEqual({});
    expect(asked[0]?.toolCall.locations).toEqual([{ path: target }]);
    expect(await readFile(target, "utf8")).toBe("changed");
  });

  it("reads and writes through links that stay inside the roots", async () => {
    const dir = await workspace();
    await symlink(join(dir, "src"), join(dir, "lib"));
    const { outcomes } = await turn(
      dir,
      [{ read: join(dir, "lib", "a.ts") }, { write: join(dir, "lib", "b.ts"), content: "b" }],
      { default: "allow" },
    );
    expect(outcomes[0]?.result).toEqual({ content: "export {};\n" });
    expect(await readFile(join(dir, "src", "b.ts"), "utf8")).toBe("b");
  });

  it("matches the workspace's own rules when the workspace is reached through a linked directory", async () => {
    const real = await workspace();
    const via = join(await temp("orca-owned-fs-via-"), "ws");
    await symlink(real, via);
    const { outcomes, decisions } = await turn(via, [{ write: join(via, "src", "a.ts"), content: "ok" }], {
      default: "ask",
      rules: [{ match: { kind: "edit", path: "src/a.ts" }, decision: "allow" }],
    });
    expect(outcomes[0]?.result).toEqual({});
    expect(decisions).toEqual(["fs:allow"]);
    expect(await readFile(join(real, "src", "a.ts"), "utf8")).toBe("ok");
  });

  it("resolves a target under the root it is in, as that root is written", async () => {
    const real = await workspace();
    const via = join(await temp("orca-owned-fs-via-"), "ws");
    await symlink(real, via);
    const resolved = resolveOwnedFsTarget(join(via, "src", "new.ts"), [via]);
    expect(resolved).toMatchObject({ ok: true, asWritten: join(via, "src", "new.ts") });
    expect(resolved.ok && resolved.io.endsWith(join("src", "new.ts"))).toBe(true);
    expect(resolveOwnedFsTarget(join(via, "..", "elsewhere"), [via])).toEqual({ ok: false, reason: "outside" });
  });
});

describe("ORCA's own file executor records each operation before its I/O (#703)", () => {
  const local = () => new LocalHost({ id: "local", type: "local" });

  it("records the authorization before the write starts, and the outcome after it", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const records: FsOperationRecord[] = [];
    const seen: string[] = [];
    const { outcomes } = await turn(
      dir,
      [{ write: file, content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      local(),
      {
        recordFsOperation: async (record) => {
          records.push({ phase: "authorized", ...record });
          seen.push(await readFile(file, "utf8"));
          return async (outcome) => {
            records.push({ phase: "completed", operationId: record.operationId, outcome });
            seen.push(await readFile(file, "utf8"));
          };
        },
      },
    );
    expect(outcomes[0]?.result).toEqual({});
    expect(records).toEqual([
      expect.objectContaining({
        phase: "authorized",
        access: "write",
        display: join("src", "a.ts"),
        decision: "allow",
        rule: { basis: "default" },
      }),
      expect.objectContaining({ phase: "completed", outcome: "completed" }),
    ]);
    expect(seen).toEqual(["export {};\n", "new"]);
    // Neither the absolute path nor anything resolved from it is in the record.
    expect(JSON.stringify(records)).not.toContain(dir);
    expect(records[0]!.operationId).toBe(records[1]!.operationId);
  });

  it("refuses the operation when its authorization cannot be recorded", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const records: FsOperationRecord[] = [];
    const { outcomes } = await turn(
      dir,
      [{ write: file, content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      local(),
      {
        recordFsOperation: recorder(records, () => Promise.reject(new Error("store refused"))),
      },
    );
    expect(refused(outcomes[0])).toBe("the authorization could not be recorded, so the file I/O did not start");
    expect(records.map((r) => r.phase)).toEqual(["authorized"]);
    expect(await readFile(file, "utf8")).toBe("export {};\n");
  });

  it("records not-dispatched when the path changes while the authorization is written", async () => {
    const dir = await workspace();
    const other = join(dir, "src", "b.ts");
    await writeFile(other, "b\n", "utf8");
    const alias = join(dir, "alias.ts");
    await symlink(join(dir, "src", "a.ts"), alias);
    const records: FsOperationRecord[] = [];
    const { outcomes } = await turn(
      dir,
      [{ write: alias, content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      local(),
      {
        recordFsOperation: recorder(records, async () => {
          await rm(alias);
          await symlink(other, alias);
        }),
      },
    );
    expect(refused(outcomes[0])).toBe("the path changed before the file I/O started");
    expect(records.map((r) => (r.phase === "completed" ? r.outcome : r.phase))).toEqual([
      "authorized",
      "not-dispatched",
    ]);
    expect(await readFile(join(dir, "src", "a.ts"), "utf8")).toBe("export {};\n");
    expect(await readFile(other, "utf8")).toBe("b\n");
  });

  it("records a read of a missing file as failed, and still answers Resource not found", async () => {
    const dir = await workspace();
    const records: FsOperationRecord[] = [];
    const { outcomes } = await turn(
      dir,
      [{ read: join(dir, "src", "gone.ts") }],
      { default: "allow" },
      undefined,
      undefined,
      local(),
      {
        recordFsOperation: recorder(records),
      },
    );
    expect(outcomes[0]?.code).toBe(-32002);
    expect(records.map((r) => (r.phase === "completed" ? r.outcome : r.phase))).toEqual(["authorized", "failed"]);
  });
});

describe("authority and identity survive the wait for the record (#703 review)", () => {
  const local = () => new LocalHost({ id: "local", type: "local" });
  const phases = (records: FsOperationRecord[]) => records.map((r) => (r.phase === "completed" ? r.outcome : r.phase));

  it("reads the policy again after recording, and a deny that appeared meanwhile refuses the I/O", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const sidecar = permissionPolicyPath(dir);
    const records: FsOperationRecord[] = [];
    const { outcomes } = await turn(
      dir,
      [{ write: file, content: "new" }],
      { default: "allow" },
      undefined,
      [sidecar],
      local(),
      {
        recordFsOperation: recorder(records, () =>
          writeFile(
            sidecar,
            JSON.stringify({
              version: 1,
              agents: { prober: { rules: [{ match: { kind: "edit", path: "src/a.ts" }, decision: "deny" }] } },
            }),
            "utf8",
          ),
        ),
      },
    );
    expect(refused(outcomes[0])).toBe("not allowed now: the policy changed before the file I/O");
    expect(phases(records)).toEqual(["authorized", "not-dispatched"]);
    expect(await readFile(file, "utf8")).toBe("export {};\n");
  });

  it("writes only the very file authorized: one put in its place under the same name is left alone", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const records: FsOperationRecord[] = [];
    const { outcomes } = await turn(
      dir,
      [{ write: file, content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      local(),
      {
        recordFsOperation: recorder(records, async () => {
          await writeFile(join(dir, "src", "swap.ts"), "swapped", "utf8");
          await rename(join(dir, "src", "swap.ts"), file);
        }),
      },
    );
    expect(refused(outcomes[0])).toBe("the path changed before the file I/O started");
    expect(phases(records)).toEqual(["authorized", "not-dispatched"]);
    expect(await readFile(file, "utf8")).toBe("swapped");
  });

  it("creates a new file only where it was authorized, not where a file appeared meanwhile", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "new.ts");
    const records: FsOperationRecord[] = [];
    const { outcomes } = await turn(
      dir,
      [{ write: file, content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      local(),
      {
        recordFsOperation: recorder(records, () => writeFile(file, "someone else's", "utf8")),
      },
    );
    expect(refused(outcomes[0])).toBe("the path changed before the file I/O started");
    expect(phases(records)).toEqual(["authorized", "not-dispatched"]);
    expect(await readFile(file, "utf8")).toBe("someone else's");
  });

  it("creates a new file, directories and all, under the directory it was authorized for", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "deep", "er", "new.ts");
    const { outcomes } = await turn(
      dir,
      [{ write: file, content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      local(),
    );
    expect(outcomes[0]?.result).toEqual({});
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("refuses a local request on a host that cannot bind its I/O to the file, and leaves the file alone", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const host = local();
    Object.defineProperty(host, "fs", { value: { ...host.fs, bound: undefined } });
    const { outcomes } = await turn(
      dir,
      [{ write: file, content: "x" }],
      { default: "allow" },
      undefined,
      undefined,
      host,
    );
    expect(refused(outcomes[0])).toBe("the file's identity cannot be established");
    expect(await readFile(file, "utf8")).not.toBe("x");
  });

  it("records a write that failed after it may have started as effect-unknown, and tells the agent so", async () => {
    const dir = await workspace();
    const host = local();
    const bound = host.fs.bound!;
    Object.defineProperty(host, "fs", {
      value: { ...host.fs, bound: { ...bound, write: () => Promise.reject(new Error("no space left on device")) } },
    });
    const records: FsOperationRecord[] = [];
    const { outcomes } = await turn(
      dir,
      [{ write: join(dir, "src", "a.ts"), content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      host,
      { recordFsOperation: recorder(records) },
    );
    expect(phases(records)).toEqual(["authorized", "effect-unknown"]);
    expect(refused(outcomes[0])).toMatch(/whether the file changed is unknown, so it is not safe to retry/);
  });

  it("records a write that failed before changing anything as failed", async () => {
    const dir = await workspace();
    const host = local();
    const bound = host.fs.bound!;
    Object.defineProperty(host, "fs", {
      value: {
        ...host.fs,
        bound: {
          ...bound,
          write: () => Promise.reject(new OwnedFsFailedWithoutEffect(new Error("permission denied"))),
        },
      },
    });
    const records: FsOperationRecord[] = [];
    await turn(
      dir,
      [{ write: join(dir, "src", "a.ts"), content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      host,
      { recordFsOperation: recorder(records) },
    );
    expect(phases(records)).toEqual(["authorized", "failed"]);
  });

  it("records a remote write that failed as effect-unknown: the host cannot show it changed nothing", async () => {
    const dir = await workspace();
    const host = local();
    Object.defineProperty(host, "spec", { value: { id: "remote", type: "ssh" } });
    host.fs.writeFile = () => Promise.reject(new Error("connection reset"));
    const records: FsOperationRecord[] = [];
    await turn(
      dir,
      [{ write: join(dir, "src", "a.ts"), content: "new" }],
      { default: "allow" },
      undefined,
      undefined,
      host,
      { recordFsOperation: recorder(records) },
    );
    expect(phases(records)).toEqual(["authorized", "effect-unknown"]);
  });

  it("records the file by a bounded reference relative to its root", async () => {
    const dir = await workspace();
    const deep = join(dir, "src", ...Array.from({ length: 30 }, (_, i) => `directory-${i}`), "new.ts");
    const records: FsOperationRecord[] = [];
    await turn(dir, [{ write: deep, content: "x" }], { default: "allow" }, undefined, undefined, local(), {
      recordFsOperation: recorder(records),
    });
    const authorized = records[0] as Extract<FsOperationRecord, { phase: "authorized" }>;
    expect(authorized.display.length).toBe(200);
    expect(authorized.display.startsWith("…")).toBe(true);
    expect(authorized.display.endsWith(join("directory-29", "new.ts"))).toBe(true);
    expect(authorized.display).not.toContain(dir);
  });
});
