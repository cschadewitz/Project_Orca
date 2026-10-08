/** Entry races and owner-only runtime fences, including unavailable observations. */
import { expect, it } from "vitest";
import { RuntimeActivity } from "../src/runtime-activity.js";
it("owns producer lifetimes and refuses new entries until its exact owner resumes", () => {
  const activity = new RuntimeActivity();
  activity.bind(
    () => ({ available: true, active: [] }),
    () => false,
  );
  const finish = activity.enter("dispatch");
  expect(activity.prepare("owner")).toEqual({ held: false, active: ["dispatch"] });
  finish();
  finish();
  expect(activity.prepare("owner")).toEqual({ held: true, active: [] });
  expect(() => activity.enter("callback")).toThrow("closed");
  expect(() => activity.resume("foreign")).toThrow("owner changed");
  expect(() => activity.prepare("foreign")).toThrow("Another updater");
  activity.resume("owner");
  activity.enter("callback")();
});
it("catches producer entry during a reentrant source observation before publishing idle", () => {
  const activity = new RuntimeActivity();
  let finish: (() => void) | undefined;
  activity.bind(
    () => {
      finish ??= activity.enter("renewal");
      return { available: true, active: [] };
    },
    () => false,
  );
  expect(activity.prepare("owner")).toEqual({ held: false, active: ["renewal"] });
  finish!();
  expect(activity.prepare("owner")).toEqual({ held: true, active: [] });
});
it("refuses missing, throwing, closed or changed proof without opening an owned fence", () => {
  const missing = new RuntimeActivity();
  expect(missing.prepare("owner").held).toBe(false);
  let available = true;
  const activity = new RuntimeActivity();
  activity.bind(
    () => {
      if (!available) throw new Error("unknown");
      return { available: true, active: [] };
    },
    () => false,
  );
  expect(activity.prepare("owner").held).toBe(true);
  available = false;
  expect(() => activity.resume("owner")).toThrow("unavailable");
  expect(() => activity.enter("dispatch")).toThrow("closed");
  available = true;
  activity.close();
  expect(() => activity.resume("owner")).toThrow("unavailable");
});
