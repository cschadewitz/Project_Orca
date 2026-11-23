#!/usr/bin/env node
/**
 * The process Claude Code runs as ORCA's `PreToolUse` hook (#704):
 * `node claude-pre-tool-hook.js <context file>`, with the tool call on stdin.
 *
 * Everything it decides is in `runClaudePreToolHook`; this only moves bytes. Every way it can
 * go wrong ends in exit 2, which Claude Code treats as a block: stdin larger than the limit,
 * a read error, or anything thrown that the run did not already turn into an answer.
 */
import {
  CLAUDE_PRE_TOOL_FRAME_LIMIT,
  claudePreToolHookFailure,
  runClaudePreToolHook,
} from "../claude-pre-tool-hook.js";

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    // One byte over is enough to refuse; the parser reports the size.
    if (size > CLAUDE_PRE_TOOL_FRAME_LIMIT + 1) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const result = await readInput()
  .then((input) => runClaudePreToolHook(process.argv.slice(2), input))
  .catch((error: unknown) => claudePreToolHookFailure(error));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
