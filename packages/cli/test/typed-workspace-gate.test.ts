/** Temporary roots and synthetic exact-build/lifetime ports only. Installed bridge
 * acceptance is deliberately not inferred from these filesystem owner tests. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { strictPermissionRuleRevision, type ScopedRuleGrantAuthority } from "@orca/agents";
import { ruleFixture } from "../../agents/test/strict-permission-fixtures.js";
import {
  ACCEPTED_MANAGED_TYPED_BUILDS,
  unavailableManagedTypedStore,
  createManagedTypedWorkspace,
  resolveManagedRootBinding,
  type ManagedRootInput,
} from "../src/typed-workspace-gate.js";

const roots: string[] = [];
const fault = vi.hoisted(() => ({ target: "", afterRead: undefined as (() => void) | undefined, publication: "none" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: vi.fn(async (...args: Parameters<typeof fs.rename>) => {
      if (fault.publication === "before") throw new Error("synthetic before publication");
      await fs.rename(...args);
      if (fault.publication === "after") throw new Error("synthetic lost initialization acknowledgement");
    }),
    readFile: vi.fn(async (...args: Parameters<typeof fs.readFile>) => {
      const result = await fs.readFile(...args);
      if (args[0] === fault.target && fault.afterRead) {
        const hook = fault.afterRead;
        fault.afterRead = undefined;
        hook();
      }
      return result;
    }),
  };
});
afterEach(async () => {
  fault.target = "";
  fault.afterRead = undefined;
  fault.publication = "none";
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture(shared = false) {
  const base = await mkdtemp(join(tmpdir(), "orca-managed-typed-"));
  roots.push(base);
  const config = join(base, "workspace"),
    control = join(base, "external-control");
  const releases = join(base, "releases");
  const store = shared ? config : join(config, ".orca");
  const sidecar = join(config, "orca.permissions.json");
  await mkdir(config, { mode: 0o700 });
  await mkdir(control, { mode: 0o700 });
  await mkdir(releases, { mode: 0o700 });
  if (!shared) await mkdir(store, { mode: 0o700 });
  await mkdir(join(store, "workspace-identity"), { mode: 0o700 });
  const id = randomUUID() + "\n";
  await writeFile(join(store, "workspace-identity", "id"), id, { mode: 0o600 });
  const roles: ManagedRootInput[] = [
    { role: "config", path: config },
    { role: "sidecar", path: sidecar },
    { role: "store", path: store },
  ];
  const binding = resolveManagedRootBinding(roles, control, releases);
  await writeFile(join(control, "never-typed"), `${hash(id)}\n${binding.rootBindingRef}\n`, { mode: 0o600 });
  let owned = true,
    buildCurrent = true;
  const assertCurrent = vi.fn(() => {
    if (!owned) throw new Error("synthetic lifetime lost");
    return undefined;
  });
  const assertBuildCurrent = vi.fn(() => {
    if (!buildCurrent) throw new Error("synthetic image changed");
    return undefined;
  });
  const qualify = vi.fn(async () => {
    throw new Error("no protected qualifier installed");
  });
  const ports = { binding, lifetime: { mode: "enrollment" as const, assertCurrent }, assertBuildCurrent, qualify };
  const owner = createManagedTypedWorkspace(ports);
  return {
    base,
    config,
    store,
    sidecar,
    control,
    releases,
    binding,
    roles,
    owner,
    ports,
    lose: () => {
      owned = false;
    },
    changeBuild: () => {
      buildCurrent = false;
    },
  };
}

it("keeps production activation unavailable and the accepted real image map empty", async () => {
  expect(await unavailableManagedTypedStore()).toEqual({ available: false, reason: "trusted-linux-owner-unavailable" });
  expect(ACCEPTED_MANAGED_TYPED_BUILDS).toEqual([]);
});
it.each([false, true])(
  "retains three logical roles with a single deduplicated physical target (shared=%s)",
  async (shared) => {
    const f = await fixture(shared);
    expect(f.binding.roles.map((r) => r.role)).toEqual(["config", "sidecar", "store"]);
    expect(f.binding.targets.map((r) => r.path)).toEqual([f.config]);
    expect(resolveManagedRootBinding([...f.roles, f.roles[0]!], f.control, f.releases)).toEqual(f.binding);
  },
);
it("refuses conflicting, omitted, aliased, overlapping-control and broadened original roots", async () => {
  const f = await fixture();
  expect(() => resolveManagedRootBinding(f.roles.slice(1), f.control, f.releases)).toThrow("missing role");
  expect(() =>
    resolveManagedRootBinding([...f.roles, { role: "store", path: f.config }], f.control, f.releases),
  ).toThrow("conflicting role");
  expect(() => resolveManagedRootBinding(f.roles, join(f.config, ".orca"), f.releases)).toThrow("control overlaps");
  expect(() => resolveManagedRootBinding(f.roles, f.releases, f.releases)).toThrow("selected releases");
  const alias = join(f.base, "alias");
  await symlink(f.config, alias);
  expect(() =>
    resolveManagedRootBinding(
      [
        { role: "config", path: alias },
        { role: "sidecar", path: join(alias, "orca.permissions.json") },
        { role: "store", path: f.store },
      ],
      f.control,
      f.releases,
    ),
  ).toThrow("alias");
  const changed = structuredClone(f.binding);
  const owner = createManagedTypedWorkspace({
    ...f.ports,
    binding: { ...changed, targets: [{ ...changed.targets[0]!, path: f.base }] },
  });
  expect(() => owner.inspect()).toThrow("original root identity changed");
});
it("fresh initialization durably confirms enrolled state and exposes only the canonical store", async () => {
  const f = await fixture();
  expect(f.owner.inspect()).toEqual({ state: "never-typed" });
  expect((await f.owner.currentStore()).available).toBe(false);
  const store = await f.owner.enrollFresh();
  expect(f.owner.inspect().state).toBe("enrolled");
  expect((await f.owner.currentStore()).available).toBe(true);
  const first = await f.owner.currentStore(),
    second = await f.owner.currentStore();
  if (!first.available || !second.available) throw new Error("owner unavailable");
  expect(first.binding).toBe(second.binding);
  expect(first.store).toBe(store);
  expect(second.store).toBe(await f.owner.openStore());
  const newLifetime = createManagedTypedWorkspace(f.ports);
  const replacement = await newLifetime.currentStore();
  if (!replacement.available) throw new Error("replacement unavailable");
  expect(replacement.store).not.toBe(store);
  expect((await replacement.store.read()).revision).toBe((await store.read()).revision);
  expect((await store.read()).document).toEqual({ version: 2, agents: {}, scopedRules: { version: 1, records: [] } });
  expect(await readdir(f.control)).toEqual(["enrolled.json", "intent.json"]);
  await expect(f.owner.enrollFresh()).rejects.toThrow("fresh exclusive");
  await expect(store.initializeFresh()).rejects.toThrow();
  const before = await readFile(f.sidecar);
  for (const action of ["update", "rollback", "retarget", "reset", "legacy-write"] as const) {
    const dispatch = vi.fn();
    await expect(f.owner.dispatch(action, dispatch)).rejects.toThrow("operation refused");
    expect(dispatch).not.toHaveBeenCalled();
  }
  expect(await readFile(f.sidecar)).toEqual(before);
});
it("competing enrollment attempts have one fresh initializer and never retry a pending intent", async () => {
  const f = await fixture();
  const other = createManagedTypedWorkspace(f.ports);
  const outcomes = await Promise.allSettled([f.owner.enrollFresh(), other.enrollFresh()]);
  expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(f.owner.inspect().state).toBe("enrolled");
  expect(await readdir(f.control)).toEqual(["enrolled.json", "intent.json"]);
});
it.each(["before", "after"])(
  "interrupted initialization (%s dispatch) preserves intent and prohibits automatic retry",
  async (edge) => {
    const f = await fixture();
    fault.publication = edge;
    await expect(f.owner.enrollFresh()).rejects.toThrow();
    fault.publication = "none";
    expect(await readdir(f.control)).toEqual(["intent.json"]);
    const current = createManagedTypedWorkspace(f.ports);
    expect(current.inspect().state).toBe("enrollment-pending");
    expect((await current.currentStore()).available).toBe(false);
    await expect(current.enrollFresh()).rejects.toThrow("fresh exclusive");
    await expect(current.openStore()).rejects.toThrow("incomplete");
    if (edge === "after")
      expect((JSON.parse(await readFile(f.sidecar, "utf8")) as { version: number }).version).toBe(2);
  },
);
it("canonical marker parser rejects duplicate names and unknown fields without minting ownership", async () => {
  const f = await fixture();
  await f.owner.enrollFresh();
  const file = join(f.control, "intent.json"),
    original = await readFile(file, "utf8");
  for (const bytes of [
    original.replace('"version":1', '"version":1,"version":1'),
    original.replace('"version":1', '"version":1,"future":true'),
    "{",
    Buffer.from([0xff]),
  ]) {
    await writeFile(file, bytes);
    expect(() => f.owner.inspect()).toThrow();
    expect((await f.owner.currentStore()).available).toBe(false);
  }
});
it("normal typed policy publication advances the canonical byte revision without changing enrollment evidence", async () => {
  const f = await fixture();
  const store = await f.owner.enrollFresh();
  const evidence = await readFile(join(f.control, "enrolled.json"));
  const rule = ruleFixture(),
    initial = await store.read();
  const authority: ScopedRuleGrantAuthority = {
    actor: { principalId: "synthetic:principal" },
    authorizeGrant: async () => "synthetic:authority",
    verifyApproval: async () => ({ scopeEvidenceRef: "synthetic:review" }),
    assertCommitCurrent: () => undefined,
  };
  const saved = await store.createScopedRule(
    {
      rule: { ...rule, ruleRevision: strictPermissionRuleRevision(rule) },
      expectedRevision: initial.revision,
      approvalRecordRef: "synthetic:approval",
    },
    authority,
  );
  expect(saved.revision).not.toBe(initial.revision);
  expect((await store.read()).document.scopedRules.records).toHaveLength(1);
  const revoked = await store.revokeScopedRule(
    {
      ruleId: saved.rule.ruleId,
      ruleRevision: saved.rule.ruleRevision,
      expectedRevision: saved.revision,
      approvalRecordRef: "synthetic:revoke-approval",
    },
    authority,
  );
  expect(revoked.rule.status).toBe("revoked");
  expect((await store.read()).document.scopedRules.records[0]!.rule.status).toBe("revoked");
  expect(await readFile(join(f.control, "enrolled.json"))).toEqual(evidence);
});
it.each(["missing", "v1", "corrupt", "pending-lock"])(
  "enrolled %s policy stays closed without a producer or repair",
  async (damage) => {
    const f = await fixture();
    await f.owner.enrollFresh();
    if (damage === "missing") await rm(f.sidecar);
    else if (damage === "pending-lock") await mkdir(f.sidecar + ".lock", { mode: 0o700 });
    else await writeFile(f.sidecar, damage === "v1" ? '{"version":1,"agents":{}}' : "{", { mode: 0o600 });
    const dispatch = vi.fn();
    await expect(f.owner.dispatch("launch", dispatch)).rejects.toThrow();
    await expect(f.owner.openStore()).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.owner.inspect().state).toBe("enrolled");
  },
);
it("pending/corrupt/missing/reset registry never proves legacy even when live policy is v1", async () => {
  const f = await fixture();
  await f.owner.enrollFresh();
  await writeFile(f.sidecar, '{"version":1,"agents":{}}');
  await rm(join(f.control, "enrolled.json"));
  expect(f.owner.inspect().state).toBe("enrollment-pending");
  await expect(f.owner.enrollFresh()).rejects.toThrow();
  await writeFile(join(f.control, "intent.json"), "{}");
  expect(() => f.owner.inspect()).toThrow();
  await rm(join(f.control, "intent.json"));
  expect(() => f.owner.inspect()).toThrow();
});
it("existing legacy bytes refuse fresh enrollment with exact evidence preservation", async () => {
  const f = await fixture();
  const old = '{"version":1,"agents":{}}';
  await writeFile(f.sidecar, old, { mode: 0o600 });
  await expect(f.owner.enrollFresh()).rejects.toThrow("absent sidecar");
  expect(await readFile(f.sidecar, "utf8")).toBe(old);
  expect(await readdir(f.control)).toEqual(["never-typed"]);
});
it("lost enrolled-commit acknowledgement leaves durable evidence and no automatic initialization retry", async () => {
  const f = await fixture();
  const owner = createManagedTypedWorkspace({
    ...f.ports,
    afterEnrollmentCommit: () => {
      throw new Error("synthetic lost acknowledgement");
    },
  });
  await expect(owner.enrollFresh()).rejects.toThrow("lost acknowledgement");
  const before = await readFile(f.sidecar);
  expect(() => owner.inspect()).toThrow("uncertain enrollment");
  await expect(owner.enrollFresh()).rejects.toThrow();
  expect(await readFile(f.sidecar)).toEqual(before);
  // Explicit read-only reconciliation with a new current owner may inspect the actual outcome.
  expect(createManagedTypedWorkspace(f.ports).inspect().state).toBe("enrolled");
});
it.each(["lifetime", "image"])(
  "discards positive reads after %s changes during the final awaited policy read",
  async (change) => {
    const f = await fixture();
    await f.owner.enrollFresh();
    fault.target = f.sidecar;
    fault.afterRead = change === "lifetime" ? f.lose : f.changeBuild;
    const dispatch = vi.fn();
    await expect(f.owner.dispatch("launch", dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  },
);
it("refuses replaced original directory/identity and sidecar hardlink aliases", async () => {
  const f = await fixture();
  await f.owner.enrollFresh();
  const original = await readFile(join(f.store, "workspace-identity", "id"));
  await rename(join(f.store, "workspace-identity", "id"), join(f.store, "workspace-identity", "retired-id"));
  await writeFile(join(f.store, "workspace-identity", "id"), original, { mode: 0o600 });
  expect(() => f.owner.inspect()).toThrow("original root identity changed");
  const g = await fixture();
  await g.owner.enrollFresh();
  await link(g.sidecar, join(g.base, "linked-policy"));
  await expect(g.owner.openStore()).rejects.toThrow("metadata ownership");
  const h = await fixture();
  await h.owner.enrollFresh();
  await rename(h.config, h.config + "-retired");
  await mkdir(h.config, { mode: 0o700 });
  expect(() => h.owner.inspect()).toThrow();
});
it("does not turn an async assertion into retained synchronous ownership", async () => {
  const f = await fixture();
  const owner = createManagedTypedWorkspace({
    ...f.ports,
    lifetime: { mode: "enrollment", assertCurrent: (async () => undefined) as unknown as () => undefined },
  });
  await expect(owner.enrollFresh()).rejects.toThrow("asynchronous ownership assertion");
  expect(await readdir(f.control)).toEqual(["never-typed"]);
});
