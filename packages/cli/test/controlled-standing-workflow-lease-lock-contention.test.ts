/** Fresh workflow refuses lease-lock contention; the store lock timeout is real time.
 * Split out of controlled-standing-workflow.test.ts: it waits in real time, so in its own file it runs beside the rest of the suite instead of in front of it.
 */
import { it } from "vitest";
import { freshWorkflowRefuses } from "./controlled-standing-workflow-fixture.js";

it(
  "the fresh workflow refuses lease-lock-contention between intent and fresh execution",
  () => freshWorkflowRefuses("lease-lock-contention"),
  90000,
);
