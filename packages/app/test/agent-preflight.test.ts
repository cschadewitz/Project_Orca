/** Portable synthetic files and Mach-O bytes; never invokes a provider or reads credentials. */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexPin,
  machOArchitectureMismatch,
  inspectLocalTool,
  type PinFile,
} from "../src/main/first-run/agent-preflight.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-preflight-"));
  roots.push(root);
  const bin = join(root, "Tools α with spaces");
  await mkdir(bin);
  const command = join(bin, "codex-acp");
  return { root, bin, command };
}
it("observes a synthetic script without executing it or exposing args/env/path evidence", async () => {
  const f = await fixture();
  const sentinel = join(f.root, "not-executed");
  await writeFile(f.command, `#!/bin/sh\nprintf 'executed' > '${sentinel}'\n`);
  await chmod(f.command, 0o700);
  const check = await inspectLocalTool({ id: "synthetic", command: f.command, env: { SECRET: "private needle" } });
  expect(check).toEqual({
    agentId: "synthetic",
    state: "handshake-required",
    evidence: {
      configuredRoute: "codex-acp-candidate",
      support: "unknown",
      version: "unknown",
      architecture: "unknown",
      acp: "not-checked",
      signIn: "unknown",
      exactCommand: "unsupported",
    },
  });
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(check)).not.toContain(f.root);
  expect(JSON.stringify(check)).not.toContain("private needle");
});
it("retries a corrected Finder PATH miss without promoting support or sign-in", async () => {
  const f = await fixture();
  const agent = { id: "local", command: "codex-acp", env: { PATH: f.bin } };
  expect((await inspectLocalTool(agent)).state).toBe("missing");
  await writeFile(f.command, "synthetic file; not a provider");
  await chmod(f.command, 0o700);
  expect(await inspectLocalTool(agent)).toMatchObject({
    state: "handshake-required",
    evidence: { support: "unknown", version: "unknown", acp: "not-checked", signIn: "unknown" },
  });
});
it("refuses relative commands and excludes empty or relative PATH entries", async () => {
  const f = await fixture();
  await writeFile(f.command, "synthetic");
  await chmod(f.command, 0o700);
  for (const command of ["./codex-acp", "sub/codex-acp", "sub\\codex-acp"])
    expect((await inspectLocalTool({ id: "local", command, env: { PATH: f.bin } })).state).toBe("missing");
  expect(
    (
      await inspectLocalTool({
        id: "local",
        command: "codex-acp",
        env: { PATH: ["", ".", "relative"].join(delimiter) },
      })
    ).state,
  ).toBe("missing");
});
it("sanitizes inaccessible/invalid paths and nonfiles without throwing private errors", async () => {
  const f = await fixture();
  for (const command of [f.bin, join(f.root, "invalid\0private needle")]) {
    const check = await inspectLocalTool({ id: "local", command, env: {} });
    expect(check.state).toBe("unavailable");
    expect(JSON.stringify(check)).not.toContain("private needle");
  }
});
it("reports a short file unavailable and an unknown executable route honestly", async () => {
  const f = await fixture();
  await writeFile(f.command, "abc");
  await chmod(f.command, 0o700);
  expect((await inspectLocalTool({ id: "local", command: f.command, env: {} })).state).toBe("unavailable");
  const unknown = join(f.bin, "custom-agent");
  await writeFile(unknown, "unknown synthetic format");
  await chmod(unknown, 0o700);
  expect(await inspectLocalTool({ id: "local", command: unknown, env: {} })).toMatchObject({
    evidence: { configuredRoute: "unverified", support: "unknown", architecture: "unknown", signIn: "unknown" },
  });
});
it("names a cline executable as a Cline ACP candidate, and nothing more (#711)", async () => {
  const f = await fixture();
  const cline = join(f.bin, "cline");
  await writeFile(cline, "#!/bin/sh\nexit 0\n");
  await chmod(cline, 0o700);
  expect(await inspectLocalTool({ id: "cline", command: cline, env: {} })).toMatchObject({
    state: "handshake-required",
    evidence: { configuredRoute: "cline-acp-candidate", support: "unknown", version: "unknown", signIn: "unknown" },
  });
});
function machO(cpu: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  return bytes;
}
it("uses complete thin Mach-O CPU evidence only for a known host mismatch", () => {
  expect(machOArchitectureMismatch(machO(0x1000007), "darwin", "arm64")).toBe(true);
  expect(machOArchitectureMismatch(machO(0x100000c), "darwin", "x64")).toBe(true);
  expect(machOArchitectureMismatch(machO(0x100000c), "darwin", "arm64")).toBe(false);
  expect(machOArchitectureMismatch(machO(0x1000007), "linux", "arm64")).toBe(false);
  expect(machOArchitectureMismatch(machO(0x1000007), "darwin", "unknown")).toBe(false);
  for (let length = 0; length < 8; length++)
    expect(machOArchitectureMismatch(machO(0x1000007).subarray(0, length), "darwin", "arm64")).toBe(false);
  for (const bytes of [Buffer.from("#!/bin/sh"), Buffer.from("cafebabecafebabe", "hex"), Buffer.alloc(8)])
    expect(machOArchitectureMismatch(bytes, "darwin", "arm64")).toBe(false);
});
it("names a copilot executable as a Copilot CLI candidate without running it (#709)", async () => {
  const f = await fixture();
  for (const name of ["copilot", "copilot.exe", "Copilot.EXE"]) {
    const command = join(f.bin, name);
    const sentinel = join(f.root, `${name}-executed`);
    await writeFile(command, `#!/bin/sh\nprintf 'executed' > '${sentinel}'\n`);
    await chmod(command, 0o700);
    const check = await inspectLocalTool({ id: "copilot", command, env: {} });
    expect(check.evidence).toMatchObject({ configuredRoute: "copilot-cli-acp-candidate", version: "unknown" });
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
it("names OpenCode's ACP route only for its acp subcommand (#710)", async () => {
  const f = await fixture();
  const opencode = join(f.bin, "opencode");
  await writeFile(opencode, "synthetic file; not a provider");
  await chmod(opencode, 0o700);
  expect(await inspectLocalTool({ id: "oc", command: opencode, args: ["acp", "--pure"], env: {} })).toMatchObject({
    state: "handshake-required",
    evidence: { configuredRoute: "opencode-acp-candidate", support: "unknown", version: "unknown", signIn: "unknown" },
  });
  expect(
    (await inspectLocalTool({ id: "oc", command: opencode, args: ["run"], env: {} })).evidence.configuredRoute,
  ).toBe("unverified");
  expect((await inspectLocalTool({ id: "oc", command: opencode, env: {} })).evidence.configuredRoute).toBe(
    "unverified",
  );
});
it("for driver codex-app-server, compares the executable's bytes with the pinned Codex builds without running it", async () => {
  const { createHash } = await import("node:crypto");
  const f = await fixture();
  const command = join(f.bin, "codex");
  const sentinel = join(f.root, "not-executed");
  const bytes = `#!/bin/sh\nprintf 'executed' > '${sentinel}'\n`;
  await writeFile(command, bytes);
  await chmod(command, 0o700);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const agent = { id: "codex", command, driver: "codex-app-server", env: {} };
  const pinned = await inspectLocalTool(agent, { target: "test-x64", pins: { "9.9.9": { "test-x64": sha } } });
  expect(pinned).toMatchObject({
    state: "handshake-required",
    evidence: {
      configuredRoute: "codex-app-server-candidate",
      codexPin: { state: "pinned", version: "9.9.9" },
      support: "unknown",
      signIn: "unknown",
    },
  });
  // the same bytes on another platform, or other bytes, are not pinned
  expect(
    (
      await inspectLocalTool(agent, {
        target: "other-x64",
        pins: { "9.9.9": { "test-x64": sha, "other-x64": "0".repeat(64) } },
      })
    ).evidence,
  ).toMatchObject({ codexPin: { state: "unpinned" } });
  expect((await inspectLocalTool(agent, { target: "linux-x64" })).evidence).toMatchObject({
    codexPin: { state: "unpinned" },
  });
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(pinned)).not.toContain(f.root);
  // a missing Codex reports missing, with no pin claim
  const missing = await inspectLocalTool({ ...agent, command: join(f.bin, "nope") });
  expect(missing.state).toBe("missing");
  expect(missing.evidence.codexPin).toBeUndefined();
  // without the driver, a command named codex gets no pin check
  expect((await inspectLocalTool({ id: "codex", command, env: {} })).evidence.codexPin).toBeUndefined();
});
it("bounds the Codex pin check, and skips it where ORCA pinned no build", async () => {
  const { createHash } = await import("node:crypto");
  const f = await fixture();
  const command = join(f.bin, "codex");
  const bytes = "x".repeat(4096);
  await writeFile(command, bytes);
  await chmod(command, 0o700);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const pins = { "9.9.9": { "test-x64": sha } };
  const agent = { id: "codex", command, driver: "codex-app-server", env: {} };
  const pinOf = async (codex: Parameters<typeof inspectLocalTool>[1]) =>
    (await inspectLocalTool(agent, codex)).evidence.codexPin;
  // within its bounds, it matches
  expect(await pinOf({ target: "test-x64", pins, maxBytes: 4096, timeoutMs: 10_000 })).toEqual({
    state: "pinned",
    version: "9.9.9",
  });
  // a file past the size bound is not read, and is not called pinned
  expect(await pinOf({ target: "test-x64", pins, maxBytes: 4095 })).toEqual({ state: "unreadable" });
  // a platform with no pin is not read at all
  expect(await pinOf({ target: "plan9-mips", pins })).toEqual({ state: "no-platform-pin" });
  // the executable is still reported found in each case
  expect((await inspectLocalTool(agent, { target: "test-x64", pins, maxBytes: 1 })).state).toBe("handshake-required");
});

describe("the Codex pin check's deadline", () => {
  const bytes = Buffer.from("pinned bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const pins = { "9.9.9": { "test-x64": sha } };
  const stat = { size: bytes.length, ino: 1, mtimeMs: 1, ctimeMs: 1 };
  /** A file whose reads answer from `bytes`, each one held until `gate` lets it through. */
  const fakeFile = (gate: (n: number) => Promise<void>, statGate: () => Promise<void> = async () => {}) => {
    let reads = 0;
    const file: PinFile = {
      stat: async () => (await statGate(), stat),
      read: async (buffer, offset, length, position) => {
        await gate(reads++);
        const n = Math.max(0, Math.min(length, bytes.length - position));
        bytes.copy(buffer, offset, position, position + n);
        return { bytesRead: n };
      },
    };
    return { file, reads: () => reads };
  };

  it("answers pinned when the reads finish in time", async () => {
    const f = fakeFile(async () => {});
    expect(await codexPin(f.file, "test-x64", { pins, timeoutMs: 1_000 })).toEqual({
      pin: { state: "pinned", version: "9.9.9" },
      abandoned: false,
    });
  });

  it("gives up on a read that never answers, at the deadline, and leaves the descriptor to the caller", async () => {
    const f = fakeFile(() => new Promise<void>(() => {}));
    const started = Date.now();
    expect(await codexPin(f.file, "test-x64", { pins, timeoutMs: 50 })).toEqual({
      pin: { state: "unreadable" },
      abandoned: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up on a stat that never answers", async () => {
    const f = fakeFile(
      async () => {},
      () => new Promise<void>(() => {}),
    );
    expect((await codexPin(f.file, "test-x64", { pins, timeoutMs: 50 })).pin).toEqual({ state: "unreadable" });
  });

  it("never turns a read that answers after the deadline into a result", async () => {
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    // the first read is held past the deadline; the EOF read after it would complete the hash
    const f = fakeFile((n) => (n === 0 ? late : Promise.resolve()));
    const answer = await codexPin(f.file, "test-x64", { pins, timeoutMs: 30 });
    expect(answer).toEqual({ pin: { state: "unreadable" }, abandoned: true });
    release();
    await new Promise((r) => setTimeout(r, 20));
    // the work saw the deadline and read no further
    expect(f.reads()).toBe(1);
  });
});
