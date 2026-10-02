import { expect, it } from "vitest";
import { admissionRetryOptions } from "../src/commands/admission-retry.js";
it("supports a copyable CLI key across process restarts and a new explicit intent", () => {
  const initial = admissionRetryOptions();
  expect(admissionRetryOptions(initial.idempotencyKey)).toEqual(initial);
  expect(admissionRetryOptions()).not.toEqual(initial);
  expect(() => admissionRetryOptions("")).toThrow();
});
