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
 * When the agent keeps tool-call telemetry (#1000), the line that records the answer is
 * written after the answer, with one synchronous append that never throws; whether it was
 * written changes nothing about the answer or the exit code.
 */
import { answer } from "./hook-output-guard.js";
import {
  CLAUDE_PRE_TOOL_FRAME_LIMIT,
  claudePreToolHookFailure,
  runClaudePreToolHook,
  runClaudeRuntimeAttestation,
} from "../claude-pre-tool-hook.js";
import { recordHookTelemetry } from "../hook-telemetry.js";

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

const args = process.argv.slice(2);
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
answer(result);
if ("telemetry" in result && result.telemetry !== undefined)
  try {
    recordHookTelemetry(result.telemetry.target, result.telemetry.line);
  } catch {
    // Recording never changes the answer, which is already out.
  }
