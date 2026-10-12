/**
 * The other process in admission-retry.test.ts: claims the key "key" in the test's store
 * directory and runs its operation, started as `<dir> <resultFile> [crash]`. Its operation
 * records one effect line per `prepare`, and with `crash` dies (exit 17) right after that, so
 * the next process finds a bound operation whose owner is gone.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { OrcaError } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";

const [dir, resultFile, crash] = process.argv.slice(2) as [string, string, string?];
const faults = {
  conflict: () => new OrcaError("RUN_STATE", "conflict"),
  limit: () => new OrcaError("RUN_STATE", "limit"),
};
const store = new FileRetryClaimStore({
  storeDir: dir,
  execution: new FileExecutionStore(dir),
  faults,
  lockTimeoutMs: 2000,
});
const claims = new RegisteredRetryClaims(store, faults);
const operation = claims.register({
  kind: "run.admit",
  canonicalize: (command: { value: string }) => command,
  prepare: async (_command, context) => {
    await context.bind({ id: context.operationId });
    await appendFile(join(dir, "effects"), context.operationId + "\n");
    if (crash === "crash") process.exit(17);
    return { id: context.operationId };
  },
  recover: async (_command, context) => ({ id: (await context.readBinding())!.id }),
});
const result = await claims.execute(
  operation,
  { value: "same" },
  { idempotencyKey: "key" },
  { principalId: "alice", workspaceId: "workspace", authorize: async () => {} },
);
await appendFile(resultFile, JSON.stringify(result));
