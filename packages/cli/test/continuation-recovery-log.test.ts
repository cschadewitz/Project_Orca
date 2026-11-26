/** #1197: the 5 s continuation recovery tick logs once per change of state, with the reason. */
import { expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import { continuationRecoveryLog } from "../src/continuation-recovery-log.js";

it("logs the first failure with its reason, stays quiet while it repeats, and says when it clears", () => {
  const logger = { warn: vi.fn(), info: vi.fn() };
  const log = continuationRecoveryLog(logger);
  const stuck = new OrcaError(
    "STORE_LOCK_TIMEOUT",
    "lock /store/admission-retries/catalog.lock still held after 100ms",
  );

  log.passed();
  for (let tick = 0; tick < 12; tick++) log.failed(stuck); // one minute of ticks
  expect(logger.warn).toHaveBeenCalledOnce();
  expect(logger.warn).toHaveBeenCalledWith("Continuation recovery could not run; retrying every 5 s", {
    code: "STORE_LOCK_TIMEOUT",
    message: stuck.message,
    help: "docs/storage/file-locks.md",
  });

  log.failed(new OrcaError("RUN_STATE", "Retry admission journal is unavailable"));
  expect(logger.warn).toHaveBeenCalledTimes(2);
  expect(logger.warn).toHaveBeenLastCalledWith("Continuation recovery could not run; retrying every 5 s", {
    code: "RUN_STATE",
    message: "Retry admission journal is unavailable",
  });

  log.passed();
  log.passed();
  expect(logger.info).toHaveBeenCalledOnce();
  expect(logger.info).toHaveBeenCalledWith("Continuation recovery is running again");

  log.failed(stuck);
  expect(logger.warn).toHaveBeenCalledTimes(3);
});
