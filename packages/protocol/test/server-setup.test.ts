/**
 * The client side of one-step server setup (#881): what the person is shown and confirms is
 * exactly what ssh would print, and the confirmation is bound to all of it.
 */
import { describe, expect, it } from "vitest";
import { ConnectionProfileSchema } from "../src/remote-access.js";
import {
  confirmationCode,
  confirmedResult,
  readSetup,
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

  it("binds the code to the connection, keys, account, directory, install-or-repair, version, revision and scope", () => {
    const profile = ConnectionProfileSchema.parse({ id: "lab", name: "Lab", destination: "dev@lab" });
    const base = {
      profile,
      keys: JSON.stringify([KEY, null]),
      account: "dev",
      root: "/home/dev/.local/share/orca-server",
      current: null as string | null,
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
      { ...base, root: "/srv/orca-server" },
      { ...base, current: "0.8.0" },
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
    const root = "/home/dev/.local/share/orca-server";
    const as = (account: string, at = root, current: string | null = null) =>
      setupCommand("0.8.0", 6722, { account, root: at, current });
    expect(as("dev")).toEqual([
      "python3",
      "-",
      "--version",
      "0.8.0",
      "--port",
      "6722",
      "--expect-account",
      "dev",
      "--expect-root",
      root,
      "--expect-current",
      "none",
    ]);
    expect(as("dev", root, "0.8.0").at(-1)).toBe("0.8.0");
    expect(() => as("-oProxyCommand=x")).toThrow("account");
    expect(() => as("-x")).toThrow("account");
    expect(() => as("dev lab")).toThrow("account");
    expect(() => as("")).toThrow("account");
    expect(() => as("dev", "relative/dir")).toThrow("directory");
    expect(() => as("dev", "/home/dev/../root")).toThrow("directory");
    expect(() => as("dev", "/home/dev; rm -rf /")).toThrow("directory");
    expect(() => as("dev", root, "latest")).toThrow("release version");
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

  it("calls a failure failed only once its put-back is confirmed", () => {
    const line = (value: unknown) => `orca-setup: ${JSON.stringify(value)}`;
    const failed = line({ step: "start", result: "failed", detail: "unhealthy" });
    const read = (...lines: string[]) => readSetup({ code: 1, serverLines: [], stdout: lines.join("\n") });
    expect(read(failed, line({ step: "cleanup", result: "ok", detail: "" }))).toMatchObject({
      kind: "failed",
      step: "start",
      detail: "unhealthy",
    });
    expect(read(failed, line({ step: "cleanup", result: "failed", detail: "active is not back" }))).toMatchObject({
      kind: "unknown",
      detail: "active is not back",
    });
    expect(read(failed)).toMatchObject({ kind: "unknown" });
    const refused = line({ step: "files", result: "refused", detail: "owned key" });
    expect(read(refused, line({ step: "cleanup", result: "ok", detail: "" })).kind).toBe("refused");
    expect(read(refused).kind).toBe("refused");
    expect(read(refused, line({ step: "cleanup", result: "failed", detail: "x" })).kind).toBe("unknown");
  });

  it("accepts a ready result only as exactly the setup confirmed", () => {
    const root = "/home/dev/.local/share/orca-server";
    const ready = {
      kind: "ready" as const,
      steps: [],
      command: `${root}/orca`,
      version: "0.8.0",
      port: 6722,
      account: "dev",
      root,
    };
    const expected = { version: "0.8.0", port: 6722, account: "dev", root };
    expect(confirmedResult(ready, expected)).toBe(ready);
    for (const changed of [
      { port: 7000 },
      { version: "0.8.1" },
      { account: "root" },
      { root: "/tmp/x" },
      { command: "/tmp/orca" },
      { command: `${root}/../orca` },
    ])
      expect(confirmedResult({ ...ready, ...changed }, expected).kind).toBe("mismatch");
  });
});
