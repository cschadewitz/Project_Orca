#!/usr/bin/env node
/**
 * The process Claude Code runs as ORCA's `PreToolUse` hook (#704):
 * `node claude-pre-tool-hook.js <context file>`, with the tool call on stdin; and, when the
 * session starts, as its runtime attestation: `node claude-pre-tool-hook.js --attest <context file>`.
 *
 * Everything it decides is in `runClaudePreToolHook`; this only moves bytes. Every way it can
 * go wrong ends in exit 2, which Claude Code treats as a block: stdin larger than the limit
 * (refused as soon as the count passes it, before anything is parsed), a read error, or
 * anything thrown that the run did not already turn into an answer.
 *
 * `hook-output-guard.js` comes first, before any other module runs: it keeps everything but
 * the answer off stdout, and makes every way out other than the answer exit 2.
 *
 * When the agent keeps tool-call telemetry (#1000), the line that records the answer is not
 * written by this process at all. Once the answer has been handed to the OS and its exit code
 * set, the hook hands the line to a detached recorder (this same program, run as
 * `--record-telemetry`, with the line on its stdin and no other stream of the hook's) and
 * leaves without waiting for it: a stalled spool holds only the recorder, never the hook or
 * whatever waits for it to exit. Whether the line was written changes nothing about the answer.
 */
import { answer } from "./hook-output-guard.js";
import {
  CLAUDE_PRE_TOOL_FRAME_LIMIT,
  claudePreToolHookFailure,
  runClaudePreToolHook,
  runClaudeRuntimeAttestation,
} from "../claude-pre-tool-hook.js";
import { spawn } from "node:child_process";
import type { HookTelemetryLine } from "@orca/core";
import { recordHookTelemetryAsync, type HookTelemetryTarget } from "../hook-telemetry.js";

/** The longest a detached recorder lives: a spool that never answers holds it no longer. */
const RECORDER_DEADLINE_MS = 2_000;
/** The most a recorder reads: one target and one line, which is at most 8 KiB. */
const RECORDER_INPUT_LIMIT = 64 * 1024;
const RECORD_TELEMETRY = "--record-telemetry";

class InputTooLarge extends Error {
  constructor() {
    super("tool call is too large to check");
  }
}

/** Stdin, or a refusal the moment it passes the limit: a partial frame is never decided. */
async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > CLAUDE_PRE_TOOL_FRAME_LIMIT) throw new InputTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The recorder: writes the one line it is given and leaves, by `RECORDER_DEADLINE_MS` at the
 * latest. Nobody reads its output or exit code; a bad input is dropped.
 */
async function recordTelemetry(): Promise<never> {
  setTimeout(() => process.exit(0), RECORDER_DEADLINE_MS);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      size += buf.length;
      if (size > RECORDER_INPUT_LIMIT) process.exit(0);
      chunks.push(buf);
    }
    const { target, line } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      target: HookTelemetryTarget;
      line: HookTelemetryLine;
    };
    await recordHookTelemetryAsync(target, line);
  } catch {
    // Dropped: recording is never more than a best effort.
  }
  process.exit(0);
}

/**
 * Hand the line to a detached recorder and do not wait for it: it shares none of the hook's
 * streams, is not waited on, and the line (at most 8 KiB, far under a pipe's buffer) is in the
 * pipe before this returns. Any failure to start it drops the line.
 */
function handOffTelemetry(target: HookTelemetryTarget, line: HookTelemetryLine): void {
  try {
    const recorder = spawn(process.execPath, [...process.execArgv, process.argv[1]!, RECORD_TELEMETRY], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    recorder.on("error", () => undefined);
    recorder.stdin?.on("error", () => undefined);
    recorder.stdin?.end(JSON.stringify({ target, line }));
    recorder.unref();
  } catch {
    // Dropped.
  }
}

const args = process.argv.slice(2);
if (args[0] === RECORD_TELEMETRY) await recordTelemetry();
const result = await readInput().then(
  (input) =>
    args[0] === "--attest"
      ? // The hook's parent is the Claude Code process that ran it.
        runClaudeRuntimeAttestation(args, input, { pid: process.ppid })
      : runClaudePreToolHook(args, input),
  (error: unknown) =>
    error instanceof InputTooLarge
      ? { exitCode: 2 as const, stdout: "", stderr: `Blocked by ORCA: ${error.message}.\n` }
      : claudePreToolHookFailure(error),
);
// The answer first, whole: its exit code is set at once, and nothing below starts until both
// of its streams have been handed to the OS.
await answer(result);
// Only then the telemetry line, handed off: this process does not wait for it to be written.
const telemetry = "telemetry" in result ? result.telemetry : undefined;
if (telemetry !== undefined) handOffTelemetry(telemetry.target, telemetry.line);
