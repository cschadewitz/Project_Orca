/** Portable synthetic files and Mach-O bytes; never invokes a provider or reads credentials. */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { machOArchitectureMismatch, inspectLocalTool } from "../src/main/first-run/agent-preflight.js";

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

it("names a driver: claude-agent-sdk agent's route, finds claude on PATH when no command is set, and runs nothing (#1131)", async () => {
  const f = await fixture();
  const claude = join(f.bin, "claude");
  const sentinel = join(f.root, "not-executed");
  await writeFile(claude, `#!/bin/sh\nprintf 'executed' > '${sentinel}'\n`);
  await chmod(claude, 0o700);
  const check = await inspectLocalTool({
    id: "claude-sdk",
    command: "",
    driver: "claude-agent-sdk",
    env: { PATH: [f.bin].join(delimiter) },
  });
  expect(check).toMatchObject({
    state: "handshake-required",
    evidence: { configuredRoute: "claude-agent-sdk-candidate", signIn: "unknown" },
  });
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  // The same command under the default driver is an unverified route, not the SDK's.
  const acp = await inspectLocalTool({ id: "claude", command: claude, env: {} });
  expect(acp.evidence.configuredRoute).toBe("unverified");
});

it("reports a driver: claude-agent-sdk agent unsupported on Windows without looking for or reading claude (#1320 review)", async () => {
  const f = await fixture();
  const claude = join(f.bin, "claude");
  await writeFile(claude, "#!/bin/sh\n");
  await chmod(claude, 0o700);
  const check = await inspectLocalTool({
    id: "claude-sdk",
    command: "",
    driver: "claude-agent-sdk",
    platform: "win32",
    env: { PATH: f.bin },
  });
  expect(check.state).toBe("unsupported");
  expect(check.evidence).toMatchObject({ configuredRoute: "claude-agent-sdk-candidate", signIn: "unknown" });
  // The ACP route on the same computer is reviewed as before.
  const acp = await inspectLocalTool({ id: "claude", command: claude, platform: "win32", env: {} });
  expect(acp.state).toBe("handshake-required");
});
