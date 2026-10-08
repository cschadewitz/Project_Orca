/** Automatic receipt verification must settle before daemon shutdown, separately from execution. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import { fileStores } from "@orca/store";
import { startDaemon } from "@orca/daemon";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { DirectAdmissionService } from "../../engine/src/direct-admission.js";
import { admissionRuntime, actor } from "../../engine/test/admission-execution-fixture.js";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { AdmissionRetryModel } from "../src/admission-retry.js";
import { OwnershipStore } from "../src/auth/ownership.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(execute?: (runId: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-dispatch-"));
  const f = await admissionRuntime(fileStores(dir));
  const ownership = new OwnershipStore(join(dir, "ownership.json"));
  const authority = {
    actor,
    workspaceId: "admission-workspace",
    authorize: vi.fn(async () => {}),
    onRunAdmitted: async (id: string) => {
      ownership.record(id, actor.principalId);
      await ownership.flush(id);
    },
    verifyRunAdmitted: (id: string) => ownership.verify(id, actor.principalId),
  };
  const faults = {
    conflict: () => new OrcaError("RUN_STATE", "conflict"),
    limit: () => new OrcaError("RUN_STATE", "limit"),
  };
  const claims = new RegisteredRetryClaims(
    new FileRetryClaimStore({ storeDir: dir, execution: f.stores.execution, faults }),
    faults,
  );
  const direct = new DirectAdmissionService({
    orchestrator: f.orc,
    retries: claims,
    captureLaunch: f.generations.captureLaunch,
    restoreLaunch: f.generations.restoreDirectLaunch,
  });
  const execution = vi.fn(
    execute ??
      (async (id: string) => {
        await f.orc.run(id);
      }),
  );
  const failed = vi.fn();
  const model = new AdmissionRetryModel({
    claims,
    direct,
    requests: submissionFixture().service,
    orchestrator: f.orc,
    execute: execution,
    executionFailed: failed,
  });
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.read"],
    source: f.orc,
    auth: { mode: "loopback-unauthenticated" },
    admissionRetries: model,
  });
  const admit = () => model.admitRetry({ workflowId: "admission-fence" }, { idempotencyKey: "original" }, authority);
  return { ...f, dir, claims, direct, authority, model, daemon, admit, execution, failed };
}

it.each([false, true])(
  "shutdown settles an active background receipt read before returning (rejects=%s)",
  async (rejects) => {
    const f = await fixture();
    const entered = barrier(),
      finish = barrier(),
      settled = barrier();
    const inspect = f.claims.inspect.bind(f.claims);
    const failure = new Error("original verification failure");
    vi.spyOn(f.claims, "inspect").mockImplementation(async (...args) => {
      entered.release();
      await finish.promise;
      try {
        await writeFile(join(f.dir, "verification-settled"), "original write");
        if (rejects) throw failure;
        return await inspect(...args);
      } finally {
        settled.release();
      }
    });
    let closing: Promise<void> | undefined;
    try {
      const receipt = await f.admit();
      expect(receipt).toMatchObject({ state: "resolved", result: { state: "accepted" } });
      await entered.promise;
      let closed = false;
      closing = f.daemon.close().then(() => {
        closed = true;
      });
      await nextTurn();
      await nextTurn();
      expect(closed).toBe(false);
      finish.release();
      await closing;
      expect(await readFile(join(f.dir, "verification-settled"), "utf8")).toBe("original write");
      expect(f.execution).not.toHaveBeenCalled();
      expect(f.failed).toHaveBeenCalledTimes(rejects ? 1 : 0);
      expect(
        await f.direct.admitRun({ workflowId: "admission-fence" }, { idempotencyKey: "original" }, f.authority),
      ).toEqual({ ...receipt, replayed: true });
      expect(await f.stores.events.listRuns()).toHaveLength(1);
      await f.daemon.close();
    } finally {
      finish.release();
      await settled.promise;
      await (closing ?? f.daemon.close());
      vi.restoreAllMocks();
      await rm(f.dir, { recursive: true });
    }
  },
);

it("fences verification still queued for setImmediate without attaching an admitted run", async () => {
  const f = await fixture();
  const inspect = vi.spyOn(f.claims, "inspect");
  try {
    const receipt = await f.admit();
    expect(receipt).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    await f.daemon.close();
    await nextTurn();
    expect(inspect).not.toHaveBeenCalled();
    expect(f.execution).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  } finally {
    await f.daemon.close();
    vi.restoreAllMocks();
    await rm(f.dir, { recursive: true });
  }
});

it("shutdown does not await or cancel separately started workflow execution", async () => {
  const entered = barrier(),
    finish = barrier(),
    settled = barrier();
  const failure = new Error("original execution failure");
  const f = await fixture(async () => {
    entered.release();
    await finish.promise;
    try {
      throw failure;
    } finally {
      settled.release();
    }
  });
  try {
    await f.admit();
    await entered.promise;
    await f.daemon.close();
    expect(f.execution).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
    finish.release();
    await settled.promise;
    await nextTurn();
    expect(f.failed).toHaveBeenCalledTimes(1);
  } finally {
    finish.release();
    await settled.promise;
    await f.daemon.close();
    await rm(f.dir, { recursive: true });
  }
});
