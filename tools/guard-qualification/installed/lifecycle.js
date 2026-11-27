/**
 * What the installed receipts' lifecycle checks share (#1026, #1129): the simulated person's
 * one-time allow bound to one call, a call's record as a receipt keeps it, and the observers
 * that take a cancelled call's evidence again after a wait.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * A simulated person's one-time allow, bound to one expected fixture (#1026 review): only for
 * an ask in `sessionId`, for a turn of exactly one call, whose tool name and raw input are that
 * call's exactly, and only once. Anything missing, unexpected or ambiguous gets no answer, so
 * nothing runs on it. Native policy is not changed. `nameOf` reads the tool's name from an ask:
 * the ACP adapter's `toolCall.name` by default; the Claude Agent SDK bridge carries it in
 * `toolCall._meta.claudeAgentSdk.toolName`.
 */
export function allowOnlyFixture(sessionId, nameOf = (req) => req.toolCall?.name) {
  let used = false;
  return async (req, turnCalls) => {
    const [want] = turnCalls ?? [];
    const options = (req.options ?? []).filter((o) => o.kind === "allow_once");
    const exact =
      !used &&
      typeof sessionId === "string" &&
      req.sessionId === sessionId &&
      turnCalls?.length === 1 &&
      nameOf(req) === want.name &&
      isDeepStrictEqual(req.toolCall?.rawInput, want.input) &&
      options.length === 1;
    if (!exact) return undefined;
    used = true;
    return options[0].optionId;
  };
}

/** One call's record as the receipt keeps it: what the runner observed, without the result text. */
export function record(got) {
  const { result: _result, ...rest } = got.detail;
  return rest;
}

/**
 * What an observer read: the file's text, a missing file, or a failure to read it. Only a missing
 * file is ever taken as an absence, and only where absence is expected.
 */
export async function observe(file) {
  try {
    return { text: await readFile(file, "utf8") };
  } catch (e) {
    return e?.code === "ENOENT" ? { missing: true } : { failed: String(e?.code ?? "error") };
  }
}

/**
 * A cancelled call's evidence taken again after a wait, for its effect to be recomputed from.
 * An observer that could not read its evidence gives `unobservable`, which shows no absence
 * (`effectFrom` makes it indeterminate). The MCP log exists before the calls, so a missing log
 * is unobservable too. A missing target file is an absence only if it was missing before.
 */
export async function effectAgain(world, got, action, read = observe) {
  const ref = got.detail.effectRef;
  if (ref.kind === "mcp") {
    const seen = await read(join(world.root, "mcp-calls.jsonl"));
    if (seen.text === undefined) return { kind: "unobservable", of: "mcp", why: seen.failed ?? "log missing" };
    const lines = seen.text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return {
      ...ref,
      loggedFor: lines.filter((l) => l.input?.orca706Call === ref.callRef).map((l) => l.nonce),
      unaccountedLines: lines.filter((l) => typeof l.input?.orca706Call !== "string").length,
    };
  }
  if (ref.kind === "file") {
    const seen = await read(action.path);
    if (seen.failed) return { kind: "unobservable", of: "file", why: seen.failed };
    if (seen.missing)
      return ref.before === null ? { ...ref, after: null } : { kind: "unobservable", of: "file", why: "target gone" };
    return { ...ref, after: sha256(seen.text).slice(0, 16) };
  }
  return { kind: "none-available" };
}
