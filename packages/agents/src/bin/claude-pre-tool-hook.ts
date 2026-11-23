#!/usr/bin/env node
/**
 * The process Claude Code runs as ORCA's `PreToolUse` hook (#704):
 * `node claude-pre-tool-hook.js <context file>`, with the tool call on stdin.
 *
 * Everything it decides is in `runClaudePreToolHook`; this only moves bytes. Every way it can
 * go wrong ends in exit 2, which Claude Code treats as a block: stdin larger than the limit
 * (refused as soon as the count passes it, before anything is parsed), a read error, or
 * anything thrown that the run did not already turn into an answer.
 */
import {
  CLAUDE_PRE_TOOL_FRAME_LIMIT,
  claudePreToolHookFailure,
  runClaudePreToolHook,
} from "../claude-pre-tool-hook.js";

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

const result = await readInput().then(
  (input) => runClaudePreToolHook(process.argv.slice(2), input),
  (error: unknown) =>
    error instanceof InputTooLarge
      ? { exitCode: 2 as const, stdout: "", stderr: `Blocked by ORCA: ${error.message}.\n` }
      : claudePreToolHookFailure(error),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
