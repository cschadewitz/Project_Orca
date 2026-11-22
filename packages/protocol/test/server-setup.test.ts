/**
 * The client side of one-step server setup (#881): what the person is shown and confirms is
 * exactly what ssh would print, and the confirmation is bound to all of it.
 */
import { describe, expect, it } from "vitest";
import { ConnectionProfileSchema } from "../src/remote-access.js";
import {
  confirmationCode,
  inspectCommand,
  keyFingerprints,
  readInspection,
  setupCommand,
} from "../src/server-setup.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMGC5YgJWg846Er1M8f6jE+18UxKVqDbV+HNuA7JZB+l";

describe("server setup confirmation (#881)", () => {
  it("shows host keys as ssh-keygen -l does", () => {
    // `ssh-keygen -lf` of this key: SHA256:AoBh5CZHxZdn9fXciS2K6KkP0njP09OhLkUwfWqW9Eo
    const keys = JSON.stringify([KEY, KEY]);
    expect(keyFingerprints(keys)).toEqual({
      server: ["ssh-ed25519 SHA256:AoBh5CZHxZdn9fXciS2K6KkP0njP09OhLkUwfWqW9Eo"],
      jump: ["ssh-ed25519 SHA256:AoBh5CZHxZdn9fXciS2K6KkP0njP09OhLkUwfWqW9Eo"],
    });
    expect(keyFingerprints(JSON.stringify([KEY, null]))).not.toHaveProperty("jump");
  });

  it("binds the code to the connection, keys, account, version, revision and scope", () => {
    const profile = ConnectionProfileSchema.parse({ id: "lab", name: "Lab", destination: "dev@lab" });
    const base = {
      profile,
      keys: JSON.stringify([KEY, null]),
      account: "dev",
      version: "0.8.0",
      scope: "install" as const,
    };
    const code = confirmationCode(base);
    expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(confirmationCode({ ...base })).toBe(code);
    for (const changed of [
      { ...base, profile: { ...profile, sshPort: 2222 } },
      { ...base, profile: { ...profile, jump: { destination: "gw" } } },
      { ...base, keys: JSON.stringify([KEY, KEY]) },
      { ...base, account: "root" },
      { ...base, version: "0.8.1" },
      { ...base, scope: "install-and-sign-in" as const },
      { ...base, revision: 1 },
    ])
      expect(confirmationCode(changed)).not.toBe(code);
  });

  it("inspects read only, and sets up only as the confirmed account", () => {
    expect(inspectCommand("0.8.0", 6722)).toEqual([
      "python3",
      "-",
      "--version",
      "0.8.0",
      "--port",
      "6722",
      "--inspect",
    ]);
    expect(setupCommand("0.8.0", 6722, "dev")).toContain("--expect-account");
    expect(() => setupCommand("0.8.0", 6722, "-oProxyCommand=x")).toThrow("account");
    expect(() => setupCommand("0.8.0", 6722, "-x")).toThrow("account");
    expect(() => setupCommand("0.8.0", 6722, "dev lab")).toThrow("account");
    expect(() => setupCommand("0.8.0", 6722, "")).toThrow("account");
  });

  it("reads an inspection, and nothing else as one", () => {
    const line = (value: unknown) => `orca-setup: ${JSON.stringify(value)}`;
    const inspected = { inspected: true, account: "dev", root: "/home/dev/.local/share/orca-server", current: null };
    expect(readInspection({ code: 0, serverLines: [], stdout: line(inspected) })).toMatchObject({
      kind: "inspected",
      inspected,
    });
    // A refusal wins over a stray inspected line; a nonzero exit is never inspected.
    expect(
      readInspection({
        code: 2,
        serverLines: [],
        stdout: [line({ step: "inventory", result: "refused", detail: "x" }), line(inspected)].join("\n"),
      }).kind,
    ).toBe("refused");
    expect(readInspection({ code: 1, serverLines: [], stdout: line(inspected) }).kind).toBe("unknown");
    expect(readInspection({ code: 0, serverLines: [], stdout: line({ ...inspected, account: "a b" }) }).kind).toBe(
      "unknown",
    );
  });
});
