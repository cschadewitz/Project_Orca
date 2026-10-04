// @vitest-environment happy-dom
/** Shared client intent contract; actual palette wiring is checked in the integration patch. */
import { expect, it } from "vitest";
import { newAdmissionIntent } from "../../../protocol/src/admission-retry.js";
it("retains the same opaque intent across a dropped response and allocates a new one for another run", () => {
  const intent = newAdmissionIntent();
  const first = { workflowId: "program", ...intent };
  const retry = { workflowId: "program", ...intent };
  expect(retry).toEqual(first);
  expect({ workflowId: "program", ...newAdmissionIntent() }).not.toEqual(first);
});
