/** Fresh disposable source processes exercise closed startup only; no signed Mac or full protected-state recovery. */
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@orca/protocol";
import {
  MacRestartVerification,
  MacUpdateOwnedStop,
  type MacRestartProcess,
  type MacRestartChild,
} from "../src/main/mac-update-restart.js";
import { restartFixture } from "./mac-restart-fixture.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
async function fixture(options: Parameters<typeof restartFixture>[0] = {}) {
  const f = await restartFixture(options);
  closers.push(f.cleanup);
  return f;
}
async function stopped(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.stop().stop(signal());
  expect(result.outcome).toBe("stopped");
  if (result.outcome !== "stopped") throw new Error("Expected clean owned stop");
  return result.receipt;
}
function decorate(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: (process: MacRestartProcess) => MacRestartProcess,
) {
  const launch = f.ports.startClosed;
  Object.assign(f.ports, {
    startClosed: async (...args: Parameters<typeof launch>) => {
      const result = await launch(...args);
      return result.outcome === "started" ? { ...result, process: operation(result.process) } : result;
    },
  });
}
async function admission(f: Awaited<ReturnType<typeof fixture>>) {
  const next = f.replacement();
  if (!next) throw new Error("No disposable replacement");
  return next.client.call("runs.start", { workflowId: "flow" }, z.unknown(), false, signal(), false);
}

it("cleanly stops the exact owned old process, verifies a fresh closed replacement and only then simulates reopening", async () => {
  const f = await fixture();
  expect(f.old.child.child.pid).not.toBe(process.pid);
  const receipt = await stopped(f);
  expect(await f.old.child.closed).toEqual({ code: 0, signal: null });
  expect(f.old.child.signals).toEqual(["SIGTERM"]);
  const verifier = new MacRestartVerification(f.ports, 10_000);
  const result = await verifier.verify(f.request(receipt), signal());
  expect(result.outcome).toBe("verified-closed");
  expect(f.replacement()!.child.child.pid).not.toBe(f.old.child.child.pid);
  expect(f.replacement()!.ready.target.instanceId).not.toBe(receipt.target.instanceId);
  await expect(admission(f)).rejects.toThrow("closed");
  const hello = await f.replacement()!.client.hello("synthetic-authenticated-check", false);
  expect(hello).toMatchObject({
    protocol: PROTOCOL_VERSION,
    orcaVersion: f.manifest.identity.releaseVersion,
    processId: f.replacement()!.child.child.pid,
    identity: { workspaceId: receipt.target.workspaceId, instanceId: f.replacement()!.ready.target.instanceId },
  });
  expect(result.outcome === "verified-closed" && result.startup.scope).toBe("startup-only");
  expect((await verifier.recheck(signal())).outcome).toBe("verified-closed");
  await expect(admission(f)).rejects.toThrow("closed");
  await f.simulateReopen();
  await expect(admission(f)).resolves.toMatchObject({ runId: expect.any(String) });
  expect(await verifier.recheck(signal())).toEqual({ outcome: "unknown" });
});

it.each([
  "refused-owner",
  "wrong-pid",
  "lost-proof",
  "malformed-proof",
  "wrong-proof-target",
  "blocked-proof",
  "lost-reservation",
])("owned stop %s sends no signal and never substitutes another target", async (kind) => {
  const f = await fixture();
  const proof = f.stopBoundary.proof;
  if (kind === "refused-owner") f.reservation(false);
  if (kind === "lost-proof")
    Object.assign(f.stopBoundary, {
      proof: async (...args: Parameters<typeof proof>) => {
        await proof(...args);
        throw new Error("Synthetic lost acknowledgement");
      },
    });
  if (kind === "malformed-proof") Object.assign(f.stopBoundary, { proof: async () => undefined });
  if (kind === "blocked-proof")
    Object.assign(f.stopBoundary, {
      proof: async (target: unknown) => ({ proof: "runtime-v1", target, outcome: "blocked", active: ["execution"] }),
    });
  if (kind === "wrong-proof-target")
    Object.assign(f.stopBoundary, {
      proof: async (...args: Parameters<typeof proof>) => {
        const result = (await proof(...args)) as { target: { instanceId: string } };
        return { ...result, target: { ...result.target, instanceId: randomUUID() } };
      },
    });
  if (kind === "lost-reservation")
    Object.assign(f.stopBoundary, {
      proof: async (...args: Parameters<typeof proof>) => {
        const result = await proof(...args);
        f.reservation(false);
        return result;
      },
    });
  const target =
    kind === "wrong-pid" ? { ...f.old.ready.target, processId: f.old.ready.target.processId + 1 } : f.old.ready.target;
  const stop = new MacUpdateOwnedStop(f.old.child.child, target, f.stopBoundary, 10_000);
  const result = await stop.stop(signal());
  expect(result.outcome).toBe(["refused-owner", "wrong-pid", "blocked-proof"].includes(kind) ? "refused" : "unknown");
  expect(f.old.child.signals).toEqual([]);
  expect(f.old.child.child.exitCode).toBeNull();
  expect(await stop.stop(signal())).toEqual(result);
  expect(f.calls).toEqual([]);
});

it("never force-kills an owned child that ignores SIGTERM; timeout remains unknown and retry sends no second signal", async () => {
  const f = await fixture({ ignoreOldTerm: true });
  vi.useFakeTimers();
  const stop = f.stop(1000);
  const stopping = stop.stop(signal());
  await f.old.child.signalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await stopping).toEqual({ outcome: "unknown" });
  expect(await stop.stop(signal())).toEqual({ outcome: "unknown" });
  expect(f.old.child.signals).toEqual(["SIGTERM"]);
  expect(f.old.child.child.exitCode).toBeNull();
});

it("keeps a crash during the idle-proof boundary unknown and does not send a stop signal", async () => {
  const f = await fixture();
  Object.assign(f.stopBoundary, {
    proof: async () => {
      await f.old.child.crash();
      return undefined;
    },
  });
  expect(await f.stop().stop(signal())).toEqual({ outcome: "unknown" });
  expect(f.old.child.signals).toEqual([]);
});
it("retains unknown when the exact child cleanly exits but its close acknowledgement is lost", async () => {
  const f = await fixture();
  const actual = f.old.child.child;
  const lostClose = {
    get pid() {
      return actual.pid;
    },
    get exitCode() {
      return actual.exitCode;
    },
    get signalCode() {
      return actual.signalCode;
    },
    kill: actual.kill.bind(actual),
    once: () => lostClose,
  } as unknown as MacRestartChild;
  vi.useFakeTimers();
  const stop = new MacUpdateOwnedStop(lostClose, f.old.ready.target, f.stopBoundary, 1000);
  const stopping = stop.stop(signal());
  await f.old.child.signalled();
  expect(await f.old.child.closed).toEqual({ code: 0, signal: null });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await stopping).toEqual({ outcome: "unknown" });
  expect(await stop.stop(signal())).toEqual({ outcome: "unknown" });
  expect(f.old.child.signals).toEqual(["SIGTERM"]);
});
it("does not mint a stopped receipt from a spurious clean-close acknowledgement while the owned child is still alive", async () => {
  const f = await fixture({ ignoreOldTerm: true });
  const actual = f.old.child.child;
  let notify!: (code: number | null, signal: NodeJS.Signals | null) => void;
  const spuriousClose = {
    get pid() {
      return actual.pid;
    },
    get exitCode() {
      return actual.exitCode;
    },
    get signalCode() {
      return actual.signalCode;
    },
    kill: actual.kill.bind(actual),
    once: (_event: string, listener: typeof notify) => {
      notify = listener;
      return spuriousClose;
    },
  } as unknown as MacRestartChild;
  const stopping = new MacUpdateOwnedStop(spuriousClose, f.old.ready.target, f.stopBoundary, 10_000).stop(signal());
  await f.old.child.signalled();
  notify(0, null);
  expect(await stopping).toEqual({ outcome: "unknown" });
  expect(actual.exitCode).toBeNull();
  expect(f.old.child.signals).toEqual(["SIGTERM"]);
});
it("retains unknown without signalling when observed child PID changes while the owned idle proof is pending", async () => {
  const f = await fixture();
  const actual = f.old.child.child;
  let observedPid = actual.pid;
  const changed: MacRestartChild = {
    get pid() {
      return observedPid;
    },
    get exitCode() {
      return actual.exitCode;
    },
    get signalCode() {
      return actual.signalCode;
    },
    kill: actual.kill.bind(actual),
    once: actual.once.bind(actual),
  };
  const proof = f.stopBoundary.proof;
  const boundary = {
    ...f.stopBoundary,
    proof: async (...args: Parameters<typeof proof>) => {
      const result = await proof(...args);
      observedPid = actual.pid! + 1;
      return result;
    },
  };
  expect(await new MacUpdateOwnedStop(changed, f.old.ready.target, boundary, 10_000).stop(signal())).toEqual({
    outcome: "unknown",
  });
  expect(f.old.child.signals).toEqual([]);
  expect(actual.exitCode).toBeNull();
});

it("refuses forged or replayed stop receipts and missing adapters before any replacement launch", async () => {
  const f = await fixture();
  const verifier = new MacRestartVerification(f.ports, 10_000);
  expect(await verifier.verify(f.request({ target: f.old.ready.target }), signal())).toEqual({
    outcome: "refused",
    reason: "ownership",
  });
  expect(f.calls).toEqual([]);
  const receipt = await stopped(f);
  expect(await new MacRestartVerification().verify(f.request(receipt), signal())).toEqual({
    outcome: "refused",
    reason: "ownership",
  });
  expect((await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).outcome).toBe(
    "verified-closed",
  );
  expect(await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).toEqual({
    outcome: "refused",
    reason: "ownership",
  });
  expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
});

it.each(["launch", "closed", "image", "hello", "store"])(
  "lost %s response remains unknown, admission stays closed and no retry launches another child",
  async (boundary) => {
    const f = await fixture();
    const receipt = await stopped(f);
    if (boundary === "launch") {
      const launch = f.ports.startClosed;
      Object.assign(f.ports, {
        startClosed: async (...args: Parameters<typeof launch>) => {
          await launch(...args);
          throw new Error("Synthetic launch response lost");
        },
      });
    } else
      decorate(f, (process) => ({
        ...process,
        [boundary]: async () => {
          throw new Error("Synthetic response lost");
        },
      }));
    const verifier = new MacRestartVerification(f.ports, 10_000);
    expect(await verifier.verify(f.request(receipt), signal())).toEqual({ outcome: "unknown" });
    await expect(admission(f)).rejects.toThrow("closed");
    expect(await verifier.recheck(signal())).toEqual({ outcome: "unknown" });
    expect(await verifier.verify(f.request(receipt), signal())).toEqual({ outcome: "unknown" });
    expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
  },
);

it.each(["closed", "image", "hello", "store"])(
  "child crash at %s verification stays unknown without stopping or reopening any replacement",
  async (boundary) => {
    const f = await fixture();
    const receipt = await stopped(f);
    decorate(f, (process) => ({
      ...process,
      [boundary]: async () => {
        await f.replacement()!.child.crash();
        return undefined;
      },
    }));
    expect(await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).toEqual({
      outcome: "unknown",
    });
    expect(f.replacement()!.child.signals).toEqual([]);
    expect(await f.replacement()!.child.closed).toEqual({ code: 17, signal: null });
  },
);

it.each(["version", "protocol", "pid", "workspace", "boot", "store-dir", "capability", "method"])(
  "refuses authenticated hello %s mismatch while retaining the bootstrap fence",
  async (kind) => {
    const f = await fixture();
    const receipt = await stopped(f);
    decorate(f, (process) => ({
      ...process,
      hello: async (signal) => {
        const result = (await process.hello(signal)) as {
          orcaVersion: string;
          protocol: { major: number; minor: number };
          processId: number;
          identity: { workspaceId: string; instanceId: string };
          storeDir: string;
          capabilities: string[];
          methods: string[];
        };
        if (kind === "version") result.orcaVersion = "other";
        if (kind === "protocol") result.protocol.minor++;
        if (kind === "pid") result.processId++;
        if (kind === "workspace") result.identity.workspaceId = randomUUID();
        if (kind === "boot") result.identity.instanceId = randomUUID();
        if (kind === "store-dir") result.storeDir += "/other";
        if (kind === "capability") result.capabilities = [];
        if (kind === "method") result.methods = ["hello"];
        return result;
      },
    }));
    const expected = ["capability", "method"].includes(kind) ? "capability" : "identity";
    expect(await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).toEqual({
      outcome: "refused",
      reason: expected,
    });
    await expect(admission(f)).rejects.toThrow("closed");
  },
);

it.each(["app-image", "identity", "daemon", "store-epoch"])(
  "detects changed actual synthetic %s bytes before simulated reopening",
  async (kind) => {
    const f = await fixture();
    const receipt = await stopped(f);
    const verifier = new MacRestartVerification(f.ports, 10_000);
    expect((await verifier.verify(f.request(receipt), signal())).outcome).toBe("verified-closed");
    const path =
      kind === "app-image"
        ? f.appPath
        : kind === "identity"
          ? f.identityPath
          : kind === "daemon"
            ? f.daemonPath
            : f.storeEpochPath;
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" changed")]));
    expect(await verifier.recheck(signal())).toEqual({
      outcome: "refused",
      reason: kind === "store-epoch" ? "store" : "image",
    });
    await expect(admission(f)).rejects.toThrow("closed");
    expect(await verifier.verify(f.request(receipt), signal())).toEqual(verifier.state);
  },
);

it.each(["parked", "unsupported-generation"])(
  "refuses %s absent #394–396 restoration proof without replay or opening admission",
  async (work) => {
    const f = await fixture();
    const receipt = await stopped(f);
    decorate(f, (process) => ({
      ...process,
      store: async (signal) => ({ ...((await process.store(signal)) as object), work }),
    }));
    expect(await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).toEqual({
      outcome: "refused",
      reason: "restoration",
    });
    await expect(admission(f)).rejects.toThrow("closed");
  },
);

it.each(["fence", "image-target", "store-target", "malformed-image", "malformed-store"])(
  "rejects %s owner proof mismatch without releasing the fence",
  async (kind) => {
    const f = await fixture();
    const receipt = await stopped(f);
    if (kind === "fence")
      decorate(f, (process) => ({
        ...process,
        closed: async (signal) => ({ ...((await process.closed(signal)) as object), fenceId: randomUUID() }),
      }));
    if (kind === "image-target")
      decorate(f, (process) => ({
        ...process,
        image: async (signal) => ({ ...((await process.image(signal)) as object), target: f.old.ready.target }),
      }));
    if (kind === "store-target")
      decorate(f, (process) => ({
        ...process,
        store: async (signal) => ({ ...((await process.store(signal)) as object), target: f.old.ready.target }),
      }));
    if (kind === "malformed-image")
      decorate(f, (process) => ({ ...process, image: async () => ({ outcome: "verified" }) }));
    if (kind === "malformed-store") decorate(f, (process) => ({ ...process, store: async () => undefined }));
    expect(await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).toEqual(
      kind === "image-target"
        ? { outcome: "refused", reason: "image" }
        : kind === "store-target"
          ? { outcome: "refused", reason: "store" }
          : { outcome: "unknown" },
    );
    await expect(admission(f)).rejects.toThrow("closed");
  },
);
it.each(["app-image", "daemon", "store-epoch", "parked"])(
  "catches late %s changes during the first store observation before returning startup verification",
  async (kind) => {
    const f = await fixture();
    const receipt = await stopped(f);
    decorate(f, (process) => {
      let observations = 0;
      return {
        ...process,
        store: async (signal) => {
          const result = await process.store(signal);
          if (++observations === 1) {
            if (kind === "app-image") await writeFile(f.appPath, "changed synthetic app image");
            if (kind === "daemon") await writeFile(f.daemonPath, "changed synthetic daemon bytes");
            if (kind === "store-epoch") await writeFile(f.storeEpochPath, "changed-epoch");
          }
          return kind === "parked" && observations > 1 ? { ...(result as object), work: "parked" } : result;
        },
      };
    });
    const reason = kind === "store-epoch" ? "store" : kind === "parked" ? "restoration" : "image";
    expect(await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).toEqual({
      outcome: "refused",
      reason,
    });
    await expect(admission(f)).rejects.toThrow("closed");
  },
);
it.each(["final-image", "final-hello", "final-store", "final-fence"])(
  "keeps a lost %s acknowledgement unknown even after earlier identity checks passed",
  async (kind) => {
    const f = await fixture();
    const receipt = await stopped(f);
    const boundary =
      kind === "final-image" ? "image" : kind === "final-hello" ? "hello" : kind === "final-store" ? "store" : "closed";
    decorate(f, (process) => {
      let reads = 0;
      const original = process[boundary];
      return {
        ...process,
        [boundary]: async (signal: AbortSignal) => {
          const result = await original(signal);
          if (++reads === (boundary === "closed" ? 3 : 2)) throw new Error("Synthetic final acknowledgement lost");
          return result;
        },
      };
    });
    const verifier = new MacRestartVerification(f.ports, 10_000);
    expect(await verifier.verify(f.request(receipt), signal())).toEqual({ outcome: "unknown" });
    await expect(admission(f)).rejects.toThrow("closed");
    expect(await verifier.verify(f.request(receipt), signal())).toEqual({ outcome: "unknown" });
  },
);
it("serializes duplicate startup/recheck owners and never returns cached success after an unknown recheck", async () => {
  const f = await fixture();
  const receipt = await stopped(f);
  const verifier = new MacRestartVerification(f.ports, 10_000);
  const request = f.request(receipt);
  const first = verifier.verify(request, signal());
  expect(verifier.verify(request, signal())).toBe(first);
  expect((await first).outcome).toBe("verified-closed");
  f.reservation(false);
  const checked = verifier.recheck(signal());
  expect(verifier.recheck(signal())).toBe(checked);
  expect(await checked).toEqual({ outcome: "unknown" });
  expect(await verifier.verify(request, signal())).toEqual({ outcome: "unknown" });
  expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
  await expect(admission(f)).rejects.toThrow("closed");
});
it("retains unknown after a bounded lost launch result even when the late closed-child handle eventually arrives", async () => {
  const f = await fixture();
  const receipt = await stopped(f);
  const launch = f.ports.startClosed;
  let complete!: (result: Awaited<ReturnType<typeof launch>>) => void;
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const late = new Promise<Awaited<ReturnType<typeof launch>>>((done) => {
    complete = done;
  });
  Object.assign(f.ports, {
    startClosed: async (...args: Parameters<typeof launch>) => {
      await launch(...args);
      entered();
      return late;
    },
  });
  vi.useFakeTimers();
  const verifier = new MacRestartVerification(f.ports, 1000);
  const verifying = verifier.verify(f.request(receipt), signal());
  await ready;
  await vi.advanceTimersByTimeAsync(1000);
  expect(await verifying).toEqual({ outcome: "unknown" });
  complete({ outcome: "started", process: f.process() });
  await late;
  await Promise.resolve();
  expect(verifier.state).toEqual({ outcome: "unknown" });
  expect(await verifier.verify(f.request(receipt), signal())).toEqual({ outcome: "unknown" });
  await expect(admission(f)).rejects.toThrow("closed");
  expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
});
it("refuses real unauthenticated replacement access without falling back or reopening", async () => {
  const f = await fixture();
  const receipt = await stopped(f);
  decorate(f, (process) => ({
    ...process,
    closed: async (signal) => {
      await writeFile(f.replacement()!.ready.tokenFile, "invalid-synthetic-owner-token");
      return process.closed(signal);
    },
  }));
  expect(await new MacRestartVerification(f.ports, 10_000).verify(f.request(receipt), signal())).toEqual({
    outcome: "unknown",
  });
  await expect(admission(f)).rejects.toThrow("AUTH_INVALID");
  expect(f.replacement()!.child.child.exitCode).toBeNull();
});
