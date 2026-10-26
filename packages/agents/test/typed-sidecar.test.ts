/** Disposable synthetic stores/owners only. No installed provider or managed-gate acceptance is implied. */
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateStrictPermission } from "@orca/core";
import {
  bindInactiveTypedSidecarOwner,
  createInactiveTypedSidecarStore,
  createStrictPermissionSource,
  parseTypedSidecar,
  readTypedSidecar,
  recordAlwaysDecision,
  replacePermissionPolicyFile,
  strictPermissionRuleRevision,
  type InactiveTypedSidecarOwner,
  type ScopedRuleGrantAuthority,
  type TypedCompatibilityMarker,
} from "@orca/agents";
import { actionFixture, complete, NOW, ruleFixture, stateFixture } from "./strict-permission-fixtures.js";

const faults = vi.hoisted(() => ({ rename: "none", write: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: vi.fn(async (...args: Parameters<typeof fs.writeFile>) => {
      if (faults.write && typeof args[0] === "string" && args[0].endsWith(".tmp"))
        throw new Error("synthetic disk full");
      return fs.writeFile(...args);
    }),
    rename: vi.fn(async (...args: Parameters<typeof fs.rename>) => {
      if (faults.rename === "before") throw new Error("synthetic rename refused");
      await fs.rename(...args);
      if (faults.rename === "after") throw new Error("synthetic lost publication acknowledgement");
    }),
  };
});
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  faults.rename = "none";
  faults.write = false;
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill();
        await closed;
      }
    }),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const revision = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function revised(rule = ruleFixture()) {
  return { ...rule, ruleRevision: strictPermissionRuleRevision(rule) };
}
async function fixture(initialize = true) {
  const root = await mkdtemp(join(tmpdir(), "orca-typed-sidecar-"));
  roots.push(root);
  const file = join(root, "orca.permissions.json");
  const marker: TypedCompatibilityMarker = {
    version: 1,
    workspaceRef: "test:workspace",
    sidecarRef: "test:sidecar",
    format: "orca-permissions-v2",
    minimumWriterContract: "orca-typed-sidecar-v1",
    rootBindingRef: "test:original-root-binding",
    enrollmentRef: "test:enrollment",
    state: "enrolled",
  };
  let currentMarker = marker;
  let grantRevision = "test:authority";
  const checkCompatibility = vi.fn(async () => currentMarker);
  const qualify = vi.fn(async () => ({
    sourceRefs: ["test:protected-reviews"],
    scopeEvidenceRef: "test:scope-projection",
    approvalRecordRef: "test:approval-projection",
    authorityRevision: grantRevision,
  }));
  const owner = bindInactiveTypedSidecarOwner({ file, marker, checkCompatibility, qualify, lockTimeoutMs: 50 });
  const store = createInactiveTypedSidecarStore(owner);
  const authority: ScopedRuleGrantAuthority = {
    actor: { principalId: "test:principal", credentialId: "test:credential" },
    authorizeGrant: vi.fn(async () => grantRevision),
    verifyApproval: vi.fn(async () => ({ scopeEvidenceRef: "test:scope" })),
  };
  const pendingMarker = { ...marker, state: "enrollment-pending" as const };
  const initializer = createInactiveTypedSidecarStore(
    bindInactiveTypedSidecarOwner({
      file,
      marker: pendingMarker,
      checkCompatibility: async () => pendingMarker,
      qualify,
      lockTimeoutMs: 50,
    }),
  );
  if (initialize) await initializer.initializeFresh();
  const command = async (rule = revised()) => ({
    rule,
    expectedRevision: (await store.read()).revision,
    approvalRecordRef: "test:protected-approval",
  });
  const source = () =>
    createStrictPermissionSource({
      capturedCeiling: complete(true),
      readBoundary: async () => {
        const { rules: _rules, capturedCeiling: _captured, ...boundary } = stateFixture();
        return {
          ...boundary,
          authority: {
            ...boundary.authority,
            authorityRevision: grantRevision,
            currentPolicyRevision: (await store.read()).revision,
          },
        };
      },
      readRules: store.readRules,
    });
  return {
    root,
    file,
    owner,
    store,
    initializer,
    marker,
    authority,
    checkCompatibility,
    qualify,
    command,
    source,
    setMarker: (m: TypedCompatibilityMarker) => {
      currentMarker = m;
    },
    setGrantRevision: (r: string) => {
      grantRevision = r;
    },
  };
}

describe("inactive typed sidecar owner and exact format", () => {
  it("rejects a structural/serialized owner token and fresh opt-in on any existing bytes", async () => {
    expect(() => createInactiveTypedSidecarStore({} as InactiveTypedSidecarOwner)).toThrow(/trusted owner/);
    const f = await fixture();
    expect(() =>
      createInactiveTypedSidecarStore(JSON.parse(JSON.stringify(f.owner)) as InactiveTypedSidecarOwner),
    ).toThrow();
    const before = await readFile(f.file, "utf8");
    await expect(f.initializer.initializeFresh()).rejects.toThrow(/absent sidecar/);
    expect(await readFile(f.file, "utf8")).toBe(before);
  });

  it("pending enrollment permits initialization only; ordinary reads and grants stay closed", async () => {
    const f = await fixture(false);
    await expect(f.store.initializeFresh()).rejects.toThrow(/enrollment phase/);
    await f.initializer.initializeFresh();
    await expect(f.initializer.read()).rejects.toThrow(/enrollment phase/);
    await expect(f.initializer.createScopedRule(await f.command(), f.authority)).rejects.toThrow(/enrollment phase/);
    expect(await f.store.read()).toMatchObject({ document: { version: 2 } });
  });

  it.each(["", "{", '{"version":1,"agents":{}}', '{"version":3,"agents":{}}'])(
    "never migrates, repairs or replaces existing material %j during opt-in",
    async (bytes) => {
      const f = await fixture(false);
      await writeFile(f.file, bytes);
      await expect(f.initializer.initializeFresh()).rejects.toThrow();
      expect(await readFile(f.file, "utf8")).toBe(bytes);
    },
  );

  it("does not fall back for a missing required typed file", async () => {
    const f = await fixture();
    const command = await f.command();
    await rm(f.file);
    await expect(f.store.read()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.store.createScopedRule(command, f.authority)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.store.readRules(actionFixture(), new AbortController().signal)).toMatchObject({
      state: "unavailable",
    });
    expect(await readdir(f.root)).toEqual([]);
  });

  it.each([
    "{",
    "",
    '{"version":1,"agents":{}}',
    '{"version":3,"agents":{},"scopedRules":{"version":1,"records":[]}}',
    '{"version":2,"agents":{},"scopedRules":{"version":2,"records":[]}}',
    '{"version":3,"version":2,"agents":{},"scopedRules":{"version":1,"records":[]}}',
    '{"version":2,"agents":{},"scopedRules":{"version":1,"records":[]},"future":true}',
  ])("refuses unsupported/corrupt/ambiguous bytes without rewriting: %s", async (bytes) => {
    const f = await fixture();
    await writeFile(f.file, bytes);
    await expect(
      f.store.createScopedRule(
        { rule: revised(), expectedRevision: revision(bytes), approvalRecordRef: "test:approval" },
        f.authority,
      ),
    ).rejects.toThrow();
    expect(await readFile(f.file, "utf8")).toBe(bytes);
    expect(await readdir(f.root)).toEqual(["orca.permissions.json"]);
    expect(await f.store.readRules(actionFixture(), new AbortController().signal)).toMatchObject({
      state: "unavailable",
    });
  });

  it("rejects unknown fields at every nested typed and legacy level", async () => {
    const f = await fixture();
    await f.store.createScopedRule(await f.command(), f.authority);
    const original = (await f.store.read()).document;
    const changes = [
      ["scopedRules"],
      ["scopedRules", "records", "0"],
      ["scopedRules", "records", "0", "rule"],
      ["scopedRules", "records", "0", "rule", "match"],
      ["scopedRules", "records", "0", "actor"],
      ["scopedRules", "records", "0", "rule", "match", "resources", "0"],
      ["agents", "legacy"],
      ["agents", "legacy", "rules", "0", "match"],
    ];
    for (const path of changes) {
      const changed = structuredClone(original);
      const mutable = { ...changed, agents: { legacy: { rules: [{ match: { kind: "read" }, decision: "deny" }] } } };
      let node: unknown = mutable;
      for (const key of path) node = (node as Record<string, unknown>)[key];
      Object.assign(node as object, { future: true });
      const bytes = JSON.stringify(mutable);
      await writeFile(f.file, bytes);
      await expect(readTypedSidecar(f.file)).rejects.toThrow();
      await expect(
        f.store.revokeScopedRule(
          {
            ruleId: "rule-1",
            ruleRevision: revised().ruleRevision,
            expectedRevision: revision(bytes),
            approvalRecordRef: "test:revoke",
          },
          f.authority,
        ),
      ).rejects.toThrow();
      expect(await readFile(f.file, "utf8")).toBe(bytes);
    }
  });

  it("rejects invalid UTF-8 without hashing replacement characters or rewriting", async () => {
    const f = await fixture();
    const bytes = Buffer.concat([
      Buffer.from('{"version":2,"agents":{"'),
      Buffer.from([0xff]),
      Buffer.from('":{"rules":[]}},"scopedRules":{"version":1,"records":[]}}'),
    ]);
    await writeFile(f.file, bytes);
    await expect(f.store.read()).rejects.toThrow(/UTF-8/);
    expect(await readFile(f.file)).toEqual(bytes);
  });

  it.each(["pending", "missing", "corrupt", "future"])("refuses %s enrollment evidence", async (state) => {
    const f = await fixture();
    const command = await f.command();
    f.checkCompatibility.mockResolvedValue({ ...f.marker, state } as never);
    await expect(f.store.read()).rejects.toThrow(/compatibility ownership/);
    await expect(f.store.createScopedRule(command, f.authority)).rejects.toThrow();
    expect((await readTypedSidecar(f.file)).revision).toBe(command.expectedRevision);
  });

  it("rejects missing, sparse, duplicate and mismatched-revision records", async () => {
    const f = await fixture();
    await f.store.createScopedRule(await f.command(), f.authority);
    const doc = (await f.store.read()).document;
    const record = doc.scopedRules.records[0]!;
    for (const records of [
      [record, record],
      new Array<unknown>(1),
      [{ ...record, rule: ruleFixture() }],
      [{ rule: record.rule }],
    ]) {
      expect(() => parseTypedSidecar({ ...doc, scopedRules: { version: 1, records } })).toThrow();
    }
  });
});

describe("compare, protected approval and original grant rechecks", () => {
  it("returns exact authoritative receipt and preserves unrelated legacy/typed records", async () => {
    const f = await fixture();
    const doc = (await f.store.read()).document;
    const agents = {
      legacy: {
        rules: [
          {
            match: { kind: "read" as const, path: "synthetic" },
            decision: "deny" as const,
            addedAt: "legacy-attribution",
            grantedFor: "legacy-title",
          },
        ],
      },
    };
    await writeFile(f.file, JSON.stringify({ ...doc, agents }));
    const cmd = await f.command();
    const result = await f.store.createScopedRule(cmd, f.authority);
    expect(result).toEqual({
      outcome: "saved",
      rule: cmd.rule,
      approvalRecordRef: cmd.approvalRecordRef,
      scopeEvidenceRef: "test:scope",
      actor: f.authority.actor,
      authorityRevision: "test:authority",
      previousRevision: cmd.expectedRevision,
      revision: revision(await readFile(f.file, "utf8")),
    });
    expect(f.authority.authorizeGrant).toHaveBeenCalledTimes(2);
    expect(f.authority.verifyApproval).toHaveBeenCalledTimes(2);
    const second = await f.command(revised({ ...ruleFixture(), ruleId: "rule-2" }));
    await f.store.createScopedRule(second, f.authority);
    const current = (await f.store.read()).document;
    expect(current.agents).toEqual(agents);
    expect(current.scopedRules.records[0]).toEqual({
      rule: result.rule,
      approvalRecordRef: result.approvalRecordRef,
      scopeEvidenceRef: result.scopeEvidenceRef,
      actor: result.actor,
      authorityRevision: result.authorityRevision,
    });
    await expect(replacePermissionPolicyFile(f.file, { version: 1, agents: {} })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(
      recordAlwaysDecision({
        file: f.file,
        agentId: "legacy",
        decision: "allow",
        workspaceCwd: f.root,
        request: {
          sessionId: "synthetic",
          toolCall: { toolCallId: "synthetic", kind: "read", locations: [{ path: join(f.root, "x") }] },
          options: [],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("serializes concurrent exact-revision saves and refuses stale edits without merging", async () => {
    const f = await fixture();
    const cmd = await f.command();
    const results = await Promise.allSettled([
      f.store.createScopedRule(cmd, f.authority),
      f.store.createScopedRule({ ...cmd, rule: revised({ ...ruleFixture(), ruleId: "other" }) }, f.authority),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "CONFIG_STALE" } });
    expect((await f.store.read()).document.scopedRules.records).toHaveLength(1);
    await expect(f.store.createScopedRule(cmd, f.authority)).rejects.toMatchObject({ code: "CONFIG_STALE" });
  });

  it("snapshots mutable command/actor and callbacks before compatibility awaits", async () => {
    const f = await fixture();
    const cmd = await f.command();
    const original = structuredClone(cmd);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.checkCompatibility.mockImplementationOnce(async () => {
      enter();
      await blocked;
      return f.marker;
    });
    const result = f.store.createScopedRule(cmd, f.authority);
    await entered;
    Object.assign(cmd.rule.match, { principalRef: "attacker" });
    cmd.approvalRecordRef = "unreviewed";
    f.authority.actor.principalId = "attacker";
    Object.assign(f.authority, {
      authorizeGrant: async () => {
        throw new Error("substituted");
      },
    });
    release();
    expect(await result).toMatchObject({
      rule: original.rule,
      approvalRecordRef: original.approvalRecordRef,
      actor: { principalId: "test:principal" },
    });
  });

  it.each([
    "initial-authority",
    "final-authority",
    "authority-revision",
    "approval",
    "final-approval",
    "owner",
    "owner-final",
  ])("refuses %s loss without publishing or dropping the previous revision", async (mode) => {
    const f = await fixture();
    const cmd = await f.command();
    const before = await readFile(f.file, "utf8");
    if (mode === "initial-authority") vi.mocked(f.authority.authorizeGrant).mockRejectedValueOnce(new Error("revoked"));
    if (mode === "final-authority")
      vi.mocked(f.authority.authorizeGrant)
        .mockResolvedValueOnce("test:authority")
        .mockRejectedValueOnce(new Error("revoked"));
    if (mode === "authority-revision")
      vi.mocked(f.authority.authorizeGrant).mockResolvedValueOnce("test:authority").mockResolvedValueOnce("changed");
    if (mode === "approval")
      vi.mocked(f.authority.verifyApproval).mockRejectedValueOnce(new Error("unprotected approval"));
    if (mode === "final-approval")
      vi.mocked(f.authority.verifyApproval)
        .mockResolvedValueOnce({ scopeEvidenceRef: "test:scope" })
        .mockRejectedValueOnce(new Error("review revoked"));
    if (mode === "owner") f.setMarker({ ...f.marker, enrollmentRef: "new-enrollment" });
    if (mode === "owner-final")
      f.checkCompatibility
        .mockResolvedValueOnce(f.marker)
        .mockResolvedValueOnce({ ...f.marker, enrollmentRef: "new-enrollment" });
    await expect(f.store.createScopedRule(cmd, f.authority)).rejects.toThrow();
    expect(await readFile(f.file, "utf8")).toBe(before);
    expect(await readdir(f.root)).toEqual(["orca.permissions.json"]);
  });

  it("Allow once/Deny and non-allow create decisions have no standing persistence command", async () => {
    const f = await fixture();
    const before = await readFile(f.file, "utf8");
    for (const decision of ["deny", "require-human"] as const) {
      await expect(
        f.store.createScopedRule(await f.command(revised({ ...ruleFixture(), decision })), f.authority),
      ).rejects.toThrow();
    }
    expect(Object.keys(f.store).sort()).toEqual([
      "createScopedRule",
      "initializeFresh",
      "read",
      "readRules",
      "revokeScopedRule",
    ]);
    expect(await readFile(f.file, "utf8")).toBe(before);
  });
});

describe("fresh reads, expiry, revocation and uncertain publication", () => {
  it("bounds repeat authority by exact scope/lifetime and observes revoke/expiry/restart without replay", async () => {
    const f = await fixture();
    const saved = await f.store.createScopedRule(await f.command(), f.authority);
    const evaluate = async (time = NOW, action = actionFixture(), source = f.source()) => {
      const current = {
        ...action,
        authority: {
          ...action.authority,
          currentPolicyRevision: (await f.store.read()).revision,
          authorityRevision: "test:authority",
        },
        expiresAt: new Date(NOW + 120_000).toISOString(),
      };
      return evaluateStrictPermission(
        current,
        await source.readCurrent(current, new AbortController().signal),
        time,
        "test:review",
      );
    };
    for (let repeat = 0; repeat < 3; repeat++)
      expect(await evaluate()).toMatchObject({ verdict: { outcome: "allow" } });
    expect(await evaluate(NOW + 60_001)).toMatchObject({
      verdict: { outcome: "indeterminate", reason: "rule-not-current" },
    });
    const originalAction = actionFixture();
    const unrelated = { ...originalAction, invocation: { ...originalAction.invocation, agentId: "other-agent" } };
    expect(await evaluate(NOW, unrelated)).toMatchObject({ verdict: { outcome: "require-human" } });
    // New store/source objects reread persisted state; no in-memory approval is reconstructed.
    const restarted = createInactiveTypedSidecarStore(f.owner);
    expect((await restarted.read()).revision).toBe(saved.revision);
    const revoked = await restarted.revokeScopedRule(
      {
        ruleId: saved.rule.ruleId,
        ruleRevision: saved.rule.ruleRevision,
        expectedRevision: saved.revision,
        approvalRecordRef: "test:revoke-approval",
      },
      f.authority,
    );
    expect(revoked.rule.status).toBe("revoked");
    expect(await evaluate()).toMatchObject({ verdict: { outcome: "deny", reason: "rule-revoked" } });
    expect((await restarted.read()).document.scopedRules.records).toHaveLength(1);
    await expect(restarted.createScopedRule(await f.command(), f.authority)).rejects.toThrow(/identity already used/);
    await expect(
      restarted.revokeScopedRule(
        {
          ruleId: saved.rule.ruleId,
          ruleRevision: saved.rule.ruleRevision,
          expectedRevision: revoked.revision,
          approvalRecordRef: "test:revoke",
        },
        f.authority,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
  });

  it("never promotes legacy entries and refuses unverifiable records/current read authority", async () => {
    const f = await fixture();
    expect(await f.store.readRules(actionFixture(), new AbortController().signal)).toMatchObject({ rules: [] });
    await f.store.createScopedRule(await f.command(), f.authority);
    f.qualify.mockRejectedValueOnce(new Error("protected approval missing"));
    const current = await f.source().readCurrent(actionFixture(), new AbortController().signal);
    expect(evaluateStrictPermission(actionFixture(), current, NOW, "test:review")).toMatchObject({
      verdict: { outcome: "indeterminate" },
    });
  });

  it("refuses a qualification racing revocation", async () => {
    const f = await fixture();
    const saved = await f.store.createScopedRule(await f.command(), f.authority);
    const proof = await f.qualify();
    f.qualify.mockImplementationOnce(async () => {
      await f.store.revokeScopedRule(
        {
          ruleId: saved.rule.ruleId,
          ruleRevision: saved.rule.ruleRevision,
          expectedRevision: saved.revision,
          approvalRecordRef: "test:revoke",
        },
        f.authority,
      );
      return proof;
    });
    expect(await f.store.readRules(actionFixture(), new AbortController().signal)).toMatchObject({
      state: "unavailable",
    });
  });

  it("does not classify a prepublication temporary-write failure as a successful save", async () => {
    const f = await fixture();
    const cmd = await f.command();
    faults.write = true;
    await expect(f.store.createScopedRule(cmd, f.authority)).rejects.toThrow(/disk full/);
    expect((await f.store.read()).revision).toBe(cmd.expectedRevision);
  });

  it.each(["before", "after"])("treats %s-rename failures as uncertain and reconciles by read only", async (mode) => {
    const f = await fixture();
    const cmd = await f.command();
    faults.rename = mode;
    await expect(f.store.createScopedRule(cmd, f.authority)).rejects.toMatchObject({
      code: "INTERNAL",
      details: { publication: "uncertain", intendedRevision: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const after = await createInactiveTypedSidecarStore(f.owner).read();
    expect(after.document.scopedRules.records).toHaveLength(mode === "after" ? 1 : 0);
    expect(f.authority.authorizeGrant).toHaveBeenCalledTimes(2);
    if (mode === "after")
      await expect(f.store.createScopedRule(cmd, f.authority)).rejects.toMatchObject({ code: "CONFIG_STALE" });
    expect(await readdir(f.root)).toEqual(["orca.permissions.json"]);
  });
});

function childFixture(args: string[]) {
  const child = fork(fileURLToPath(new URL("./typed-sidecar-lock-child.ts", import.meta.url)), args, {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return {
    child,
    message: () =>
      once(child, "message").then(
        ([value]) =>
          value as {
            state: string;
            code?: string;
            unchanged?: string;
          },
      ),
  };
}
describe("cross-process strict policy ownership", () => {
  it("a paused/aged typed writer cannot be stolen by revoke or legacy mtime recovery", async () => {
    const f = await fixture();
    const saved = await f.store.createScopedRule(await f.command(), f.authority);
    const before = await readFile(f.file, "utf8");
    const writer = childFixture([f.file, "pause", saved.revision]);
    expect(await writer.message()).toMatchObject({ state: "locked" });
    // Deterministic age advancement: no 30-second sleep, heartbeat or mocked lock ownership.
    await utimes(`${f.file}.lock`, new Date(0), new Date(0));
    for (const mode of ["revoke", "legacy"]) {
      const contender = childFixture([f.file, mode, saved.revision, saved.rule.ruleId, saved.rule.ruleRevision]);
      expect(await contender.message()).toMatchObject({
        state: "refused",
        code: "STORE_LOCK_TIMEOUT",
        unchanged: before,
      });
    }
    const published = writer.message();
    writer.child.send("continue");
    expect(await published).toMatchObject({ state: "saved" });
    const next = await f.store.read();
    const revocation = await f.store.revokeScopedRule(
      {
        ruleId: saved.rule.ruleId,
        ruleRevision: saved.rule.ruleRevision,
        expectedRevision: next.revision,
        approvalRecordRef: "test:explicit-revoke",
      },
      f.authority,
    );
    const final = await f.store.read();
    expect(final.revision).toBe(revocation.revision);
    expect(final.document.scopedRules.records.map((r) => [r.rule.ruleId, r.rule.status])).toEqual([
      ["rule-1", "revoked"],
      ["child-rule", "approved"],
    ]);
    expect(await readdir(f.root)).toEqual(["orca.permissions.json"]);
  });

  it("a crashed typed owner leaves closed evidence; neither typed nor legacy writers take it over", async () => {
    const f = await fixture();
    const saved = await f.store.createScopedRule(await f.command(), f.authority);
    const before = await readFile(f.file, "utf8");
    const writer = childFixture([f.file, "pause", saved.revision]);
    expect(await writer.message()).toMatchObject({ state: "locked" });
    const exited = once(writer.child, "exit");
    writer.child.kill("SIGKILL");
    await exited;
    await utimes(`${f.file}.lock`, new Date(0), new Date(0));
    await expect(
      f.store.revokeScopedRule(
        {
          ruleId: saved.rule.ruleId,
          ruleRevision: saved.rule.ruleRevision,
          expectedRevision: saved.revision,
          approvalRecordRef: "test:explicit-revoke",
        },
        f.authority,
      ),
    ).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    const legacy = childFixture([f.file, "legacy", saved.revision]);
    expect(await legacy.message()).toMatchObject({ state: "refused", code: "STORE_LOCK_TIMEOUT", unchanged: before });
    expect(await readFile(f.file, "utf8")).toBe(before);
    expect(await readdir(`${f.file}.lock`)).toHaveLength(1);
  });
});

it("ownership-loss fault injection cannot resume an old writer over a later successful revocation", async () => {
  const f = await fixture();
  const saved = await f.store.createScopedRule(await f.command(), f.authority);
  const writer = childFixture([f.file, "pause", saved.revision]);
  expect(await writer.message()).toMatchObject({ state: "locked" });
  // Deliberate unsupported namespace interference in a disposable store. No supported contender
  // does this; the publication argument relies on strict no-takeover, not this final check alone.
  await rename(`${f.file}.lock`, `${f.file}.retired-lock`);
  const revoked = await f.store.revokeScopedRule(
    {
      ruleId: saved.rule.ruleId,
      ruleRevision: saved.rule.ruleRevision,
      expectedRevision: saved.revision,
      approvalRecordRef: "test:explicit-revoke",
    },
    f.authority,
  );
  const bytes = await readFile(f.file, "utf8");
  const result = writer.message();
  writer.child.send("continue");
  expect(await result).toMatchObject({ state: "refused", code: "STORE_LOCK_TIMEOUT", unchanged: bytes });
  expect((await f.store.read()).revision).toBe(revoked.revision);
  expect(await readFile(f.file, "utf8")).toBe(bytes);
  expect(await readdir(`${f.file}.retired-lock`)).toHaveLength(1);
});
