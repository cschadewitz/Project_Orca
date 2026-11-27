/**
 * Which Claude Code a Claude Agent SDK session runs (#1124): ORCA hashes the image of its own
 * `claude` child (`/proc/<pid>/exe`) once it has answered `initialize`, and compares it with the
 * digest pinned for this SDK version and the Claude Code version its preflight read. With
 * `required` (the agent's `nativeToolHook: experimental`) an unverified one is refused before
 * any work; otherwise it is logged. Nothing the CLI says about itself is read or run.
 *
 * `claude` here is the SDK stand-in behind a shell shim, so the image that runs is Node's: a
 * pair pinned to Node's digest stands in for the real pin.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrcaError, type Logger } from "@orca/core";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_SDK_VERIFIED_PAIRS,
  attestClaudeSdkRuntime,
  openClaudeSdkSession,
  type AgentSession,
  type ClaudeSdkRuntimeAttestation,
  type ClaudeSdkVerifiedPair,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));
const NODE_DIGEST = createHash("sha256")
  .update(await readFile(realpathSync(process.execPath)))
  .digest("hex");
const nodePair = (claudeCode = "2.1.332"): ClaudeSdkVerifiedPair => ({
  sdk: CLAUDE_AGENT_SDK_VERSION,
  claudeCode,
  images: { [`${process.platform}-${process.arch}`]: NODE_DIGEST },
});

let dir: string;
const children: ChildProcess[] = [];
const sessions: AgentSession[] = [];
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-attest-")));
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

it("pins the Claude Agent SDK version this package depends on", async () => {
  const installed = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string };
  expect(CLAUDE_AGENT_SDK_VERSION).toBe(installed.version);
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    dependencies: Record<string, string>;
  };
  expect(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(CLAUDE_AGENT_SDK_VERSION);
  // The acceptance workflow installs a pinned Claude Code, and asserts it attests.
  const workflow = await readFile(
    fileURLToPath(new URL("../../../.github/workflows/claude-sdk-acceptance.yml", import.meta.url)),
    "utf8",
  );
  const installedByCi = /CLAUDE_CODE_VERSION: (\S+)/.exec(workflow)?.[1];
  expect(CLAUDE_SDK_VERIFIED_PAIRS.map((p) => p.claudeCode)).toContain(installedByCi);
  // Every pinned pair names this SDK, and Linux x64 at least.
  for (const pair of CLAUDE_SDK_VERIFIED_PAIRS) {
    expect(pair.sdk).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(pair.images["linux-x64"]).toMatch(/^[0-9a-f]{64}$/);
  }
});

describe.runIf(process.platform === "linux")("attesting ORCA's own child (#1124)", () => {
  const child = () => {
    const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    children.push(c);
    return c;
  };

  it("verifies the image its child runs against the pair for its version", async () => {
    const c = child();
    expect(await attestClaudeSdkRuntime({ pid: c.pid, claudeCodeVersion: "2.1.332", pairs: [nodePair()] })).toEqual({
      verified: true,
      claudeCode: "2.1.332",
      sha256: NODE_DIGEST,
    });
  });

  it("does not verify another image, an unpinned version, an unknown version or another platform", async () => {
    const c = child();
    const other = { ...nodePair(), images: { [`${process.platform}-${process.arch}`]: "0".repeat(64) } };
    const cases: [Parameters<typeof attestClaudeSdkRuntime>[0], RegExp][] = [
      [{ pid: c.pid, claudeCodeVersion: "2.1.332", pairs: [other] }, /image it runs is not the one ORCA verified/],
      [{ pid: c.pid, claudeCodeVersion: "2.1.999", pairs: [nodePair()] }, /2\.1\.999 .* is not a pair ORCA verified/],
      [{ pid: c.pid, claudeCodeVersion: undefined, pairs: [nodePair()] }, /version is unknown/],
      [{ pid: c.pid, claudeCodeVersion: "2.1.332", pairs: [nodePair()], sdkVersion: "0.0.1" }, /is not a pair/],
      [{ pid: c.pid, claudeCodeVersion: "2.1.332", pairs: [nodePair()], platform: "darwin" }, /does not attest/],
    ];
    for (const [options, reason] of cases)
      expect(await attestClaudeSdkRuntime(options)).toMatchObject({
        verified: false,
        reason: expect.stringMatching(reason),
      });
  });

  it("does not verify a process that is not its own child, or none", async () => {
    expect(
      await attestClaudeSdkRuntime({ pid: process.pid, claudeCodeVersion: "2.1.332", pairs: [nodePair()] }),
    ).toMatchObject({ verified: false, reason: expect.stringMatching(/no longer its child/) });
    expect(
      await attestClaudeSdkRuntime({ pid: undefined, claudeCodeVersion: "2.1.332", pairs: [nodePair()] }),
    ).toMatchObject({ verified: false, reason: expect.stringMatching(/not known/) });
    const c = child();
    c.kill("SIGKILL");
    await new Promise((r) => c.once("exit", r));
    expect(
      await attestClaudeSdkRuntime({ pid: c.pid, claudeCodeVersion: "2.1.332", pairs: [nodePair()] }),
    ).toMatchObject({ verified: false });
  });
});

describe.runIf(process.platform === "linux")("a session's Claude Code (#1124)", () => {
  const open = async (
    attestation: NonNullable<Parameters<typeof openClaudeSdkSession>[0]["runtimeAttestation"]>,
    env: Record<string, string> = {},
    logger?: Logger,
  ) => {
    const claude = join(dir, "claude");
    await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`);
    await chmod(claude, 0o755);
    const session = await openClaudeSdkSession({
      agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
      hostId: "local",
      cwd: dir,
      preflight: {
        executable: claude,
        version: "2.1.332",
        env: { PATH: process.env.PATH ?? "", STAND_IN_LOG: join(dir, "claude.log"), ...env },
      },
      startupTimeoutMs: 10_000,
      exitGraceMs: 2_000,
      runtimeAttestation: attestation,
      ...(logger ? { logger } : {}),
    });
    sessions.push(session);
    return session;
  };

  it("opens a required one whose image is the pinned one, and runs a turn", async () => {
    const results: ClaudeSdkRuntimeAttestation[] = [];
    const session = await open({ required: true, pairs: [nodePair()], onResult: (r) => results.push(r) });
    expect(results).toEqual([{ verified: true, claudeCode: "2.1.332", sha256: NODE_DIGEST }]);
    expect((await session.prompt("hello")).stopReason).toBe("end_turn");
  });

  it("refuses a required one that is not verified, before any work, and leaves no process behind", async () => {
    const error = await open({ required: true, pairs: [nodePair("2.1.000")] }).catch((e: unknown) => e as OrcaError);
    expect(error).toBeInstanceOf(OrcaError);
    expect(error).toMatchObject({ code: "NOT_SUPPORTED" });
    expect((error as OrcaError).message).toMatch(/not one ORCA verified: Claude Code 2\.1\.332 .* is not a pair/);
    const log = await readFile(join(dir, "claude.log"), "utf8");
    expect(log).toContain('"subtype":"initialize"');
    expect(log).not.toContain('"type":"user"');
  });

  it("only logs one that is not verified when not required", async () => {
    const warnings: string[] = [];
    const logger = {
      warn: (m: string) => warnings.push(m),
      info: () => undefined,
      debug: () => undefined,
      error: () => undefined,
      child: () => logger,
    } as unknown as Logger;
    const results: ClaudeSdkRuntimeAttestation[] = [];
    const session = await open({ pairs: [], onResult: (r) => results.push(r) }, {}, logger);
    // Not waited for: the session opens and runs while the image is read.
    expect((await session.prompt("hello")).stopReason).toBe("end_turn");
    for (const end = Date.now() + 10_000; !results.length && Date.now() < end;)
      await new Promise((r) => setTimeout(r, 25));
    expect(results).toMatchObject([{ verified: false, sha256: NODE_DIGEST }]);
    expect(warnings).toContain("the Claude Code this session runs is not one ORCA verified");
  });

  it("never runs, or believes, a path the CLI reports about itself", async () => {
    const claimed = join(dir, "claimed-claude");
    const marker = join(dir, "claimed-ran");
    await writeFile(claimed, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(claimed, 0o755);
    const results: ClaudeSdkRuntimeAttestation[] = [];
    // The CLI names another program in its process title, its initialize answer and its init message.
    const session = await open(
      { required: true, pairs: [nodePair()], onResult: (r) => results.push(r) },
      { STAND_IN_CLAIM: claimed },
    );
    expect((await session.prompt("hello")).stopReason).toBe("end_turn");
    await session.close();
    // What was hashed is what the kernel runs for ORCA's child, not what the child said.
    expect(results).toEqual([{ verified: true, claudeCode: "2.1.332", sha256: NODE_DIGEST }]);
    expect(existsSync(marker)).toBe(false);
  });
});
