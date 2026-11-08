/** Legacy bounded Save stops when the operator credential expires (20s real TTL per case).
 * Split out of controlled-standing-workflow.test.ts: it waits in real time, so in its own file it runs beside the rest of the suite instead of in front of it.
 */
import { it } from "vitest";
import { legacyBoundedSave } from "./controlled-standing-workflow-fixture.js";

// Not `it.concurrent`: the scenario spies on module exports and `fs.readSync`, which concurrent cases would share.
it.each([
  ["review", "credential-expiry"],
  ["verify-first", "credential-expiry"],
  ["verify-approval", "credential-expiry"],
] as const)("legacy bounded Save %s stops on %s without late publication", legacyBoundedSave, 45000);
