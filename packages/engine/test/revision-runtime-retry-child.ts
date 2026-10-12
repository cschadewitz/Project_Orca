/**
 * The other process in revision-runtime-retry.test.ts, over the test's store directory. It is
 * started as `writer <dir> <command-json>`, `reader <dir>` or `observer <dir>`, and each mode
 * talks to the test through stdout lines and, where it waits to be released, one line on stdin.
 */
import { OrcaError } from "@orca/core";
import { fileStores } from "@orca/store";
import type { RevisionCommand } from "../../core/src/model/revision-input.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";
import { RevisionInputService, registerRevisionInputOperation } from "../src/revision-input.js";
import { createRevisionRuntime } from "../src/revision-runtime.js";

const [mode, dir, commandJson] = process.argv.slice(2) as [string, string, string?];
const stores = fileStores(dir);
const authorizeExecution = async () => {};
const nextLine = () => new Promise((resolve) => process.stdin.once("data", resolve));

if (mode === "writer") {
  // A second writer for the same key: it announces when it starts contending for the run's
  // lease, answers its first submit, then submits again once the test says to.
  const faults = {
    conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
    limit: () => new OrcaError("RETRY_LIMIT", "limit"),
  };
  const claimStore = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
  let claimCalls = 0;
  const claim = claimStore.claim.bind(claimStore);
  claimStore.claim = async (...args) => {
    claimCalls++;
    return claim(...args);
  };
  const claims = new RegisteredRetryClaims(claimStore, faults);
  const runtime = createRevisionRuntime({ stores, authorizeExecution });
  const service = new RevisionInputService({
    journal: runtime.journal,
    retries: runtime.fenceRetries(claims),
    assertRetryFence: runtime.assertRetryFence,
    stale: () => new OrcaError("REVISION_STALE", "stale"),
    access: {
      principalId: "user",
      workspaceId: "workspace",
      actor: async () => ({ principalId: "user" }),
      read: async () => ({ content: true, mutate: true }),
      mutate: async () => {},
    },
  });
  registerRevisionInputOperation(claims, service.submitOperation, runtime.journal);
  registerRevisionInputOperation(claims, service.replaceOperation, runtime.journal);
  const authority = { principalId: "user", workspaceId: "workspace", authorize: async () => {} };
  const submit = () =>
    service.submit(JSON.parse(commandJson!) as RevisionCommand, { idempotencyKey: "submit" }, authority);
  const acquire = stores.leases.acquire.bind(stores.leases);
  let announced = false;
  stores.leases.acquire = async (request) => {
    if (!announced) {
      announced = true;
      process.stdout.write("contending\n");
    }
    return acquire(request);
  };
  let first;
  try {
    first = await submit();
  } catch (error) {
    first = { state: "refused", code: (error as { code?: string }).code };
  }
  const retry = nextLine();
  process.stdout.write(JSON.stringify({ first, claimCalls }) + "\n");
  await retry;
  process.stdin.pause();
  process.stdout.write(JSON.stringify(await submit()) + "\n");
} else if (mode === "reader") {
  // A writer-owned transaction that has done its reading and holds its lease until released.
  const runtime = createRevisionRuntime({ stores, authorizeExecution });
  const release = stores.leases.release.bind(stores.leases);
  stores.leases.release = async (lease) => {
    process.stdout.write("held\n");
    await nextLine();
    process.stdin.pause();
    await release(lease);
  };
  await runtime.journal.withRun("run", () => runtime.readBoundaries("run"));
} else if (mode === "observer") {
  // An observational transaction that stays open until released; it ends in RUN_STATE
  // because the writer that ran meanwhile changed what it was observing.
  const runtime = createRevisionRuntime({ stores, authorizeExecution });
  try {
    await runtime.readJournal.withRun("run", async () => {
      process.stdout.write("ready\n");
      await nextLine();
      process.stdin.pause();
    });
    throw new Error("changed observation unexpectedly succeeded");
  } catch (error) {
    if ((error as { code?: string }).code !== "RUN_STATE") throw error;
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
