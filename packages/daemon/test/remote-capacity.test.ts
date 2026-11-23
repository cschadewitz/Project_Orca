/** A remote daemon's session cap, as its hello reports it, for the slot queue (#884). */
import { expect, it, vi } from "vitest";
import { RemoteCapacity } from "../src/delegation/capacity.js";

it("takes an unknown remote's cap as 1 until its hello says, and tells the queue when it changes", () => {
  const capacity = new RemoteCapacity();
  const changed = vi.fn();
  capacity.onChange(changed);
  // Not yet heard from: one session at a time, so the first open learns the real cap.
  expect(capacity.cap("box")).toBe(1);
  capacity.learn("box", 3);
  expect(capacity.cap("box")).toBe(3);
  expect(changed).toHaveBeenCalledTimes(1);
  capacity.learn("box", 3);
  expect(changed).toHaveBeenCalledTimes(1);
  // No cap there (or a remote too old to report one): unlimited.
  capacity.learn("box", undefined);
  expect(capacity.cap("box")).toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(capacity.cap("other")).toBe(1);
});
