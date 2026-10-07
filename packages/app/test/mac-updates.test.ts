import { CredentialStore, OwnershipStore, startDaemon, methodsFor, createDaemonIdentity } from "@orca/daemon";
import { HelloResultSchema, MaintenanceResultSchema, PROTOCOL_VERSION } from "@orca/protocol";
import { z } from "zod";
import { prepareDrafts } from "../src/main/update-ipc.js";
import { describe, expect, it, vi } from "vitest";
import {
  MacUpdates,
  type MacUpdateCandidate,
  type MacUpdateTarget,
  type MacUpdatePorts,
  type MacAdmissionLease,
  type MacDraftLease,
} from "../src/main/mac-updates.js";

const candidate: MacUpdateCandidate = {
  manifestSha256: "a".repeat(64),
  channel: "stable",
  compatibilityPlanId: "synthetic-v4",
  recoveryPlanId: "synthetic-full-state",
};
const target: MacUpdateTarget = {
  workspaceId: "973de3ea-4338-4af5-850b-d44a5f1fb889",
  instanceId: "92b1e198-29dd-4e6d-8ee9-9d58ea5f7d8f",
  epoch: 1,
};
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function rig() {
  const order: string[] = [];
  const drafts: MacDraftLease = {
    release: vi.fn(async () => {
      order.push("release-drafts");
      return "released" as const;
    }),
  };
  const leaseTarget = { ...target };
  const admission: MacAdmissionLease = {
    target: leaseTarget,
    release: vi.fn(async () => {
      order.push("resume-owned");
      return "released" as const;
    }),
  };
  const ports: MacUpdatePorts = {
    download: vi.fn(async () => {
      order.push("download-verified");
      return "verified" as const;
    }),
    prepareDrafts: vi.fn(async () => {
      order.push("drafts");
      return { outcome: "ready" as const, lease: drafts };
    }),
    prepareAdmission: vi.fn(async () => {
      order.push("fence");
      return { outcome: "ready" as const, lease: admission };
    }),
    revalidate: vi.fn(async () => {
      order.push("revalidate");
      return "valid" as const;
    }),
    activate: vi.fn(async () => {
      order.push("activate");
      return "committed" as const;
    }),
  };
  const updates = new MacUpdates(ports);
  const id = updates.present(candidate, target)!;
  return { ports, drafts, admission, leaseTarget, updates, id, order };
}
describe("Mac candidate approval coordinator (synthetic; no native adapter)", () => {
  it("requires approval, downloads once, fences before activation, and never calls committed startup ready", async () => {
    const r = rig();
    expect(r.updates.state.phase).toBe("available");
    await r.updates.reconsider();
    await r.updates.approve("replayed-or-foreign");
    expect(r.ports.download).not.toHaveBeenCalled();
    const first = r.updates.approve(r.id);
    await r.updates.approve(r.id);
    await first;
    expect(r.order).toEqual(["download-verified", "drafts", "fence", "revalidate", "activate"]);
    expect(r.updates.state.phase).toBe("awaiting-restart");
    expect(r.ports.download).toHaveBeenCalledTimes(1);
    expect(r.ports.activate).toHaveBeenCalledWith(candidate, r.admission);
    expect(r.admission.release).not.toHaveBeenCalled();
    expect(r.updates.defer(r.id)).toBe(false);
    expect(r.updates.present(candidate, target)).toBeUndefined();
    await r.updates.approve(r.id);
    await r.updates.reconsider();
    expect(r.ports.activate).toHaveBeenCalledTimes(1);
  });
  it.each(["manifestSha256", "channel", "compatibilityPlanId", "recoveryPlanId"] as const)(
    "invalidates previous consent when %s changes",
    async (field) => {
      const r = rig();
      r.ports.prepareDrafts = vi.fn(async () => ({ outcome: "blocked" as const, blocker: "drafts" as const }));
      await r.updates.approve(r.id);
      const changed = { ...candidate, [field]: field === "manifestSha256" ? "b".repeat(64) : "changed" };
      const next = r.updates.present(changed, target)!;
      expect(next).not.toBe(r.id);
      await r.updates.approve(r.id);
      await r.updates.reconsider();
      expect(r.ports.download).toHaveBeenCalledTimes(1);
      await r.updates.approve(next);
      expect(r.ports.download).toHaveBeenLastCalledWith(changed, expect.any(AbortSignal));
    },
  );
  it("copies/freeze-binds candidate and target instead of trusting mutable caller objects", async () => {
    const r = rig();
    const mutable = { ...candidate };
    const mutableTarget = { ...target };
    const id = r.updates.present(mutable, mutableTarget)!;
    mutable.manifestSha256 = "b".repeat(64);
    mutableTarget.epoch++;
    await r.updates.approve(id);
    expect(r.ports.download).toHaveBeenCalledWith(candidate, expect.any(AbortSignal));
    expect(r.ports.prepareAdmission).toHaveBeenCalledWith(target, expect.any(String));
    expect(Object.isFrozen(r.updates.state)).toBe(true);
  });
  it("refuses incomplete approval context and invalid hashes before any download", async () => {
    const r = rig();
    for (const field of ["manifestSha256", "channel", "compatibilityPlanId", "recoveryPlanId"] as const)
      expect(r.updates.present({ ...candidate, [field]: "" }, target)).toBeUndefined();
    expect(r.updates.present(candidate, { ...target, epoch: NaN })).toBeUndefined();
    await r.updates.approve("invalid");
    expect(r.ports.download).not.toHaveBeenCalled();
  });
  it("revokes download consent and ignores late completion without ever native staging", async () => {
    const r = rig();
    const downloaded = pending<"verified">();
    r.ports.download = vi.fn(() => downloaded.promise);
    const first = r.updates.approve(r.id);
    const signal = vi.mocked(r.ports.download).mock.calls[0]![1];
    expect(r.updates.present(candidate, target)).toBeUndefined();
    expect(r.updates.defer("foreign")).toBe(false);
    expect(r.updates.defer(r.id)).toBe(true);
    expect(signal.aborted).toBe(true);
    downloaded.resolve("verified");
    expect((await first).phase).toBe("deferred");
    await r.updates.reconsider();
    expect(r.ports.prepareDrafts).not.toHaveBeenCalled();
    expect(r.ports.activate).not.toHaveBeenCalled();
  });
  it.each(["drafts", "window-unavailable"] as const)(
    "waits for %s without cancellation, then automatically continues on an idle signal",
    async (blocker) => {
      const r = rig();
      vi.mocked(r.ports.prepareDrafts).mockResolvedValueOnce({ outcome: "blocked" as const, blocker });
      expect(await r.updates.approve(r.id)).toMatchObject({ phase: "waiting", blocker });
      expect(r.ports.prepareAdmission).not.toHaveBeenCalled();
      expect(r.drafts.release).not.toHaveBeenCalled();
      await r.updates.reconsider();
      expect(r.updates.state.phase).toBe("awaiting-restart");
      expect(r.ports.download).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["activity", "identity"] as const)(
    "leaves %s untouched and releases only the acquired draft lease",
    async (blocker) => {
      const r = rig();
      r.ports.prepareAdmission = vi.fn(async () => ({ outcome: "blocked" as const, blocker }));
      expect(await r.updates.approve(r.id)).toMatchObject({ phase: "waiting", blocker });
      expect(r.order).toEqual(["download-verified", "drafts", "release-drafts"]);
      expect(r.admission.release).not.toHaveBeenCalled();
      expect(r.ports.activate).not.toHaveBeenCalled();
      r.updates.defer(r.id);
      await r.updates.reconsider();
      expect(r.ports.prepareAdmission).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["approve", "reconsider"] as const)(
    "coalesces idle notifications received while %s is releasing a busy guard",
    async (entry) => {
      const r = rig();
      if (entry === "reconsider") {
        vi.mocked(r.ports.prepareDrafts).mockResolvedValueOnce({ outcome: "blocked", blocker: "drafts" });
        await r.updates.approve(r.id);
      }
      vi.mocked(r.ports.prepareAdmission).mockResolvedValueOnce({ outcome: "blocked", blocker: "activity" });
      const releasing = pending<void>();
      const release = pending<"released">();
      r.drafts.release = vi.fn(() => {
        releasing.resolve();
        return release.promise;
      });
      const operation = entry === "approve" ? r.updates.approve(r.id) : r.updates.reconsider();
      await releasing.promise;
      // The only idle transition occurs before release settles. Duplicate notifications
      // must coalesce rather than compete for leases or require a later manual action.
      await r.updates.reconsider();
      await r.updates.reconsider();
      expect(r.ports.prepareAdmission).toHaveBeenCalledOnce();
      expect(r.ports.activate).not.toHaveBeenCalled();
      release.resolve("released");
      expect((await operation).phase).toBe("awaiting-restart");
      expect(r.ports.prepareAdmission).toHaveBeenCalledTimes(2);
      expect(r.ports.download).toHaveBeenCalledOnce();
      expect(r.ports.activate).toHaveBeenCalledOnce();
      expect(r.admission.release).not.toHaveBeenCalled();
      expect(r.drafts.release).toHaveBeenCalledOnce();
    },
  );
  it.each(["defer", "unknown-release"] as const)(
    "does not drain an idle notification after %s invalidates readiness",
    async (end) => {
      const r = rig();
      vi.mocked(r.ports.prepareAdmission).mockResolvedValueOnce({ outcome: "blocked", blocker: "activity" });
      const releasing = pending<void>();
      const release = pending<"released" | "unknown">();
      r.drafts.release = vi.fn(() => {
        releasing.resolve();
        return release.promise;
      });
      const operation = r.updates.approve(r.id);
      await releasing.promise;
      await r.updates.reconsider();
      if (end === "defer") r.updates.defer(r.id);
      release.resolve(end === "defer" ? "released" : "unknown");
      expect((await operation).phase).toBe(end === "defer" ? "deferred" : "recovery-required");
      expect(r.ports.prepareAdmission).toHaveBeenCalledOnce();
      expect(r.ports.activate).not.toHaveBeenCalled();
      expect(r.admission.release).not.toHaveBeenCalled();
    },
  );
  it.each([
    { name: "missing draft lease", port: "prepareDrafts", lease: undefined },
    { name: "null draft lease", port: "prepareDrafts", lease: null },
    { name: "draft lease without release", port: "prepareDrafts", lease: {} },
    { name: "draft lease with noncallable release", port: "prepareDrafts", lease: { release: true } },
    { name: "missing admission release", port: "prepareAdmission", lease: { target } },
    { name: "noncallable admission release", port: "prepareAdmission", lease: { target, release: "release" } },
    { name: "missing admission target", port: "prepareAdmission", lease: { release: vi.fn() } },
    { name: "null admission target", port: "prepareAdmission", lease: { target: null, release: vi.fn() } },
    {
      name: "invalid admission epoch",
      port: "prepareAdmission",
      lease: { target: { ...target, epoch: "1" }, release: vi.fn() },
    },
  ])("seals malformed ready result: $name", async ({ port, lease }) => {
    const r = rig();
    Object.assign(r.ports, { [port]: () => Promise.resolve({ outcome: "ready", lease }) });
    expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
    expect(r.ports.revalidate).not.toHaveBeenCalled();
    expect(r.ports.activate).not.toHaveBeenCalled();
    expect(r.drafts.release).not.toHaveBeenCalled();
    expect(r.admission.release).not.toHaveBeenCalled();
    if (lease && "release" in lease && typeof lease.release === "function")
      expect(lease.release).not.toHaveBeenCalled();
    if (port === "prepareDrafts") expect(r.ports.prepareAdmission).not.toHaveBeenCalled();
    await r.updates.reconsider();
    await r.updates.approve(r.id);
    expect(r.ports.download).toHaveBeenCalledOnce();
  });
  it.each([
    { guard: "drafts", validation: "valid" },
    { guard: "admission", validation: "valid" },
    { guard: "drafts", validation: "refused" },
    { guard: "admission", validation: "refused" },
  ] as const)(
    "rechecks the $guard lease after $validation asynchronous validation before activation or release",
    async ({ guard, validation }) => {
      const r = rig();
      r.ports.revalidate = vi.fn(async () => {
        Object.assign(guard === "drafts" ? r.drafts : r.admission, { release: undefined });
        return validation;
      });
      expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
      expect(r.ports.activate).not.toHaveBeenCalled();
      if (guard === "drafts") expect(r.admission.release).not.toHaveBeenCalled();
      else expect(r.drafts.release).not.toHaveBeenCalled();
    },
  );
  it.each(["prepareDrafts", "prepareAdmission", "revalidate"] as const)(
    "retains guards and stops on unknown %s",
    async (port) => {
      const r = rig();
      r.ports[port] = vi.fn(() => Promise.reject(new Error("secret raw failure")));
      expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
      expect(r.admission.release).not.toHaveBeenCalled();
      expect(r.drafts.release).not.toHaveBeenCalled();
      expect(r.ports.activate).not.toHaveBeenCalled();
      expect(JSON.stringify(r.updates.state)).not.toContain("secret");
      expect(r.updates.defer(r.id)).toBe(false);
      expect(r.updates.present(candidate, target)).toBeUndefined();
      await r.updates.approve(r.id);
      await r.updates.reconsider();
      expect(r.ports.download).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["workspaceId", "instanceId", "epoch"] as const)(
    "refuses a mismatched returned lease %s without resuming a wrong target",
    async (field) => {
      const r = rig();
      r.ports.prepareAdmission = vi.fn(async () => ({
        outcome: "ready" as const,
        lease: { ...r.admission, target: { ...target, [field]: field === "epoch" ? 2 : "wrong" } },
      }));
      expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
      expect(r.admission.release).not.toHaveBeenCalled();
      expect(r.ports.activate).not.toHaveBeenCalled();
    },
  );
  it("refuses a lease whose identity changes during final validation", async () => {
    const r = rig();
    r.ports.revalidate = vi.fn(async () => {
      r.leaseTarget.epoch++;
      return "valid" as const;
    });
    expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
    expect(r.ports.activate).not.toHaveBeenCalled();
    expect(r.admission.release).not.toHaveBeenCalled();
  });
  it.each(["prepareDrafts", "prepareAdmission", "revalidate"] as const)(
    "handles defer during %s and releases settled owned guards",
    async (port) => {
      const r = rig();
      const entered = pending<void>();
      const continueOperation = pending<void>();
      const delay = async <T>(operation: () => Promise<T>) => {
        entered.resolve();
        await continueOperation.promise;
        return operation();
      };
      if (port === "prepareDrafts") {
        const original = r.ports.prepareDrafts;
        r.ports.prepareDrafts = () => delay(() => original());
      } else if (port === "prepareAdmission") {
        const original = r.ports.prepareAdmission;
        r.ports.prepareAdmission = (t, token) => delay(() => original(t, token));
      } else {
        const original = r.ports.revalidate;
        r.ports.revalidate = (c, t) => delay(() => original(c, t));
      }
      const first = r.updates.approve(r.id);
      await entered.promise;
      r.updates.defer(r.id);
      continueOperation.resolve();
      expect((await first).phase).toBe("deferred");
      expect(r.drafts.release).toHaveBeenCalledOnce();
      expect(r.admission.release).toHaveBeenCalledTimes(port === "prepareDrafts" ? 0 : 1);
      expect(r.ports.activate).not.toHaveBeenCalled();
    },
  );
  it("invalidates approval and verification on a known candidate/trust/recovery refusal", async () => {
    const r = rig();
    r.ports.revalidate = vi.fn(async () => "refused" as const);
    expect(await r.updates.approve(r.id)).toMatchObject({ phase: "failed", blocker: "candidate" });
    expect(r.order.slice(-2)).toEqual(["resume-owned", "release-drafts"]);
    await r.updates.reconsider();
    expect(r.ports.activate).not.toHaveBeenCalled();
    await r.updates.approve(r.id);
    expect(r.ports.download).toHaveBeenCalledTimes(2);
  });
  it.each(["unknown", "throw"] as const)("does not retry/reopen after %s activation", async (failure) => {
    const r = rig();
    r.ports.activate = vi.fn(() => {
      if (failure === "throw") throw new Error("native activation result lost");
      return Promise.resolve("unknown" as const);
    });
    expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
    await r.updates.approve(r.id);
    await r.updates.reconsider();
    expect(r.ports.activate).toHaveBeenCalledOnce();
    expect(r.admission.release).not.toHaveBeenCalled();
    expect(r.drafts.release).not.toHaveBeenCalled();
  });
  it("releases known-safe untouched state on explicit activation refusal, requiring new approval", async () => {
    const r = rig();
    r.ports.activate = vi.fn(async () => "refused" as const);
    expect((await r.updates.approve(r.id)).phase).toBe("failed");
    expect(r.order.slice(-2)).toEqual(["resume-owned", "release-drafts"]);
    await r.updates.reconsider();
    expect(r.ports.activate).toHaveBeenCalledOnce();
  });
  it.each(["admission", "drafts"] as const)("keeps recovery blocked on a failed %s release", async (lease) => {
    const r = rig();
    r.ports.activate = vi.fn(async () => "refused" as const);
    const release = lease === "admission" ? r.admission : r.drafts;
    release.release = vi.fn(() => {
      throw new Error("release result lost");
    });
    expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
    if (lease === "admission") expect(r.drafts.release).not.toHaveBeenCalled();
    await r.updates.approve(r.id);
    expect(r.ports.activate).toHaveBeenCalledOnce();
  });
  it("keeps a failed download distinct from activation uncertainty, with no installed-state mutation", async () => {
    const r = rig();
    r.ports.download = vi.fn(() => {
      throw new Error("credential/path/private detail");
    });
    expect((await r.updates.approve(r.id)).phase).toBe("failed");
    expect(r.ports.prepareDrafts).not.toHaveBeenCalled();
    expect(JSON.stringify(r.updates.state)).not.toContain("private");
    await r.updates.reconsider();
    expect(r.ports.download).toHaveBeenCalledOnce();
  });
  it("defer cannot reverse an activation that already crossed the commit boundary", async () => {
    const r = rig();
    const entered = pending<void>();
    const committed = pending<"committed">();
    r.ports.activate = vi.fn(() => {
      entered.resolve();
      return committed.promise;
    });
    const operation = r.updates.approve(r.id);
    await entered.promise;
    expect(r.updates.state.phase).toBe("activating");
    expect(r.updates.defer(r.id)).toBe(false);
    committed.resolve("committed");
    expect((await operation).phase).toBe("awaiting-restart");
    expect(r.drafts.release).not.toHaveBeenCalled();
  });
  it.each(["prepareDrafts", "prepareAdmission", "revalidate", "activate"] as const)(
    "fails closed if an adapter violates the %s result contract",
    async (port) => {
      const r = rig();
      // A JS/native adapter returning malformed data is not a known refusal.
      Object.assign(r.ports, { [port]: () => Promise.resolve(undefined) });
      expect((await r.updates.approve(r.id)).phase).toBe("recovery-required");
      expect(r.drafts.release).not.toHaveBeenCalled();
      expect(r.admission.release).not.toHaveBeenCalled();
      await r.updates.reconsider();
      expect(r.ports.download).toHaveBeenCalledOnce();
    },
  );
  it("a fresh process never restores download or install permission", async () => {
    const r = rig();
    r.ports.prepareDrafts = vi.fn(async () => ({ outcome: "blocked" as const, blocker: "drafts" as const }));
    await r.updates.approve(r.id);
    const next = new MacUpdates(r.ports);
    expect(next.state.phase).toBe("idle");
    await next.approve(r.id);
    next.present(candidate, target);
    await next.reconsider();
    expect(r.ports.download).toHaveBeenCalledOnce();
    expect(r.ports.activate).not.toHaveBeenCalled();
  });
});

describe("Mac coordinator with real authenticated maintenance (synthetic activation)", () => {
  it.each(["refused", "committed", "unknown", "prepare-response-lost"] as const)(
    "fences new-admission races and handles %s activation without native acceptance claims",
    async (activation) => {
      const credentials = new CredentialStore();
      const owner = await credentials.issue({ principal: "synthetic-updater", preset: "owner" });
      const entered = pending<void>();
      const finish = pending<void>();
      let active = true;
      let admitted = 0;
      const identity = createDaemonIdentity(target.workspaceId);
      const daemon = await startDaemon({
        orcaVersion: "0.0.0-mac-update-fixture",
        workspaceId: target.workspaceId,
        identity,
        capabilities: [],
        auth: {
          mode: "token",
          credentials,
          ownership: new OwnershipStore(),
          resolver: {
            run: async () => undefined,
            inputRun: async () => undefined,
            artifactRun: async () => undefined,
            claimRun: async () => undefined,
            workflowExists: () => false,
          },
        },
        methods: {
          ...methodsFor({
            orcaVersion: "0.0.0-mac-update-fixture",
            capabilities: [],
            identity,
            processId: process.pid,
          }),
          "agents.list": {
            params: z.object({}),
            handle: async () => {
              admitted++;
              if (active) {
                entered.resolve();
                await finish.promise;
              }
              return [];
            },
          },
        },
      });
      const rpc = async (method: string, params: unknown = {}) => {
        const response = await fetch(daemon.url + "/rpc", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
          body: JSON.stringify({ kind: "request", id: 1, method, params }),
        });
        return (await response.json()) as { ok: boolean; result?: unknown };
      };
      let work: Promise<{ ok: boolean; result?: unknown }> | undefined;
      try {
        const hello = HelloResultSchema.parse(
          (await rpc("hello", { client: "synthetic-updater", protocol: PROTOCOL_VERSION })).result,
        );
        expect(hello.identity).toBeDefined();
        const ownedTarget = { ...hello.identity!, epoch: 1 };
        const r = rig();
        let frozen = false;
        r.ports.prepareDrafts = async () => {
          let ack!: (sender: number, value: unknown) => void;
          await prepareDrafts({
            ids: [1, 2],
            listen: (callback) => {
              ack = callback;
              return () => undefined;
            },
            send: (nonce) => {
              frozen = true;
              ack(1, { nonce, ready: true });
              ack(2, { nonce, ready: true });
            },
          });
          return {
            outcome: "ready",
            lease: {
              release: async () => {
                frozen = false;
                return "released";
              },
            },
          };
        };
        r.ports.prepareAdmission = async (expected, token) => {
          const current = HelloResultSchema.parse(
            (await rpc("hello", { client: "synthetic-updater", protocol: PROTOCOL_VERSION })).result,
          );
          if (
            current.identity?.workspaceId !== expected.workspaceId ||
            current.identity.instanceId !== expected.instanceId
          )
            return { outcome: "blocked", blocker: "identity" };
          const prepared = await rpc("maintenance", { action: "prepare", token });
          if (!prepared.ok) return { outcome: "unknown" };
          if (!MaintenanceResultSchema.parse(prepared.result).ready) return { outcome: "blocked", blocker: "activity" };
          // Inject loss after a real successful fence, never forge a protocol reply.
          if (activation === "prepare-response-lost") throw new Error("synthetic dropped prepare response");
          return {
            outcome: "ready",
            lease: {
              target: expected,
              release: async () => {
                const resumed = await rpc("maintenance", { action: "resume", token });
                return resumed.ok && !MaintenanceResultSchema.parse(resumed.result).ready ? "released" : "unknown";
              },
            },
          };
        };
        const admissionResults: boolean[] = [];
        const frozenAtBoundary: boolean[] = [];
        let wrongOwnerRejected = false;
        r.ports.revalidate = async () => {
          frozenAtBoundary.push(frozen);
          admissionResults.push((await rpc("agents.list")).ok);
          wrongOwnerRejected = !(await rpc("maintenance", { action: "resume", token: "wrong-owner" })).ok;
          return "valid";
        };
        r.ports.activate = vi.fn(async () => {
          frozenAtBoundary.push(frozen);
          admissionResults.push((await rpc("agents.list")).ok);
          return activation === "prepare-response-lost" ? "unknown" : activation;
        });
        const id = r.updates.present(candidate, ownedTarget)!;
        work = rpc("agents.list");
        await entered.promise;
        expect(await r.updates.approve(id)).toMatchObject({ phase: "waiting", blocker: "activity" });
        expect(frozen).toBe(false);
        expect(r.ports.activate).not.toHaveBeenCalled();
        active = false;
        finish.resolve();
        expect((await work).ok).toBe(true);
        await r.updates.reconsider();
        expect(r.ports.activate).toHaveBeenCalledTimes(activation === "prepare-response-lost" ? 0 : 1);
        expect(admissionResults).toEqual(activation === "prepare-response-lost" ? [] : [false, false]);
        expect(frozenAtBoundary).toEqual(activation === "prepare-response-lost" ? [] : [true, true]);
        expect(wrongOwnerRejected).toBe(activation !== "prepare-response-lost");
        expect(admitted).toBe(1); // both racing admissions were rejected, no replay
        expect(r.updates.state.phase).toBe(
          activation === "refused" ? "failed" : activation === "committed" ? "awaiting-restart" : "recovery-required",
        );
        expect(frozen).toBe(activation !== "refused");
        expect((await rpc("agents.list")).ok).toBe(activation === "refused");
        expect(admitted).toBe(activation === "refused" ? 2 : 1);
      } finally {
        finish.resolve();
        await work;
        await daemon.close();
      }
    },
  );
});
