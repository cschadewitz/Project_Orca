/** Revoking execution authority expires callbacks independently of observer connection lifetimes. */
import { expect, it, vi } from "vitest";
import { LiveExecutionAuthorities } from "../src/live-input-authority.js";

it("revalidates idle pending runs and children, without requiring a responder or a UI connection", async () => {
  let valid = true;
  const check = vi.fn(() => valid);
  const authority = new LiveExecutionAuthorities(check, 10);
  try {
    authority.bind("root", { principalId: "alice", credentialId: "credential" });
    authority.inherit("child", "root");
    const root = authority.signalFor("root");
    expect(authority.signalFor("child")).toBe(root);
    expect(root.aborted).toBe(false);
    valid = false;
    await vi.waitFor(() => expect(root.aborted).toBe(true));
    valid = true;
    expect(authority.signalFor("root").aborted).toBe(true);
  } finally {
    authority.close();
  }
});

it("fails closed for unknown roots, broken credential storage, rebind and shutdown", () => {
  const authority = new LiveExecutionAuthorities(() => {
    throw new Error("unreadable");
  });
  expect(() => authority.signalFor("unknown")).toThrow();
  authority.bind("root", { principalId: "alice" });
  expect(authority.signalFor("root").aborted).toBe(true);
  expect(() => authority.bind("root", { principalId: "bob" })).toThrow();
  authority.close();
  expect(() => authority.bind("another", { principalId: "bob" })).toThrow();
});
