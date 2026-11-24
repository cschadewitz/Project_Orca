/**
 * How ORCA's gate in Codex's executor path decides a call (#1026): by the same layered policy
 * the ACP ask and the `PreToolUse` hook use, read fresh for each request, so a grant revoked a
 * moment ago does not decide the next call.
 *
 * The gate cannot pause a request for a person, so an `ask` refuses, as it does at the Codex
 * hook. A person allows the call with a rule.
 */
import { isAbsolute, join, relative, sep } from "node:path";
import type { PermissionPolicy } from "@orca/core";
import { checkPreToolCall, codexPreToolHookOutput, type ClaudeHookContext } from "./claude-pre-tool-hook.js";
import type { CodexExecGateCall, CodexExecGateDecision } from "./codex-exec-gate.js";
import { physicalPathOf, protectedPathFor } from "./permissions.js";

/** A rule allows typed input only when its title pattern says so in these words. */
export const CODEX_TYPED_INPUT_RULE_WORD = "write_stdin";

/**
 * The policy typed input is decided by. Text typed into a running command is a second call
 * the first rule never saw: `npm init` being allowed says nothing about the answers typed into
 * it. So no allow written for commands reaches it, not a kind rule, not a broad title and not
 * a default of `allow`. Only an allow whose title pattern names `write_stdin` does. Every
 * deny and ask stays as written.
 */
export function typedInputPolicy(policy: PermissionPolicy): PermissionPolicy {
  const keep = policy.rules.map(
    (rule) => rule.decision !== "allow" || (rule.match.titlePattern ?? "").includes(CODEX_TYPED_INPUT_RULE_WORD),
  );
  const origins = policy.origins;
  return {
    default: policy.default === "allow" ? "ask" : policy.default,
    rules: policy.rules.filter((_, i) => keep[i]),
    ...(policy.commandsRestricted ? { commandsRestricted: true } : {}),
    ...(origins && origins.length === policy.rules.length ? { origins: origins.filter((_, i) => keep[i]) } : {}),
  };
}

/**
 * The call with the file each path really names added beside the path as written. A rule for
 * the workspace covers a call only when every location is inside it, so a link in the
 * workspace that points out of it is not decided as a workspace file. A path inside the
 * workspace as the file system resolves it is named by the workspace's own spelling, so a
 * workspace reached through a link is still the workspace. Undefined when a path cannot be
 * resolved, which nothing allows.
 */
export function physicalLocations(
  toolCall: CodexExecGateCall["toolCall"],
  workspaceCwd: string,
): CodexExecGateCall["toolCall"] | undefined {
  if (toolCall.locations.length === 0) return toolCall;
  const workspace = physicalPathOf(workspaceCwd);
  if (workspace === undefined) return undefined;
  const locations: { path: string }[] = [];
  for (const { path } of toolCall.locations) {
    const physical = physicalPathOf(path);
    if (physical === undefined) return undefined;
    const within = relative(workspace, physical);
    const inside = within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within));
    const named = inside ? join(workspaceCwd, within) : physical;
    locations.push({ path });
    if (named !== path) locations.push({ path: named });
  }
  return { ...toolCall, locations };
}

/** The gate's `decide` for one session, from the context ORCA already writes for its hook. */
export function codexExecGateDecider(
  context: ClaudeHookContext,
): (call: CodexExecGateCall) => Promise<CodexExecGateDecision> {
  return async (call) => {
    if (call.check === "protected") {
      const hit = call.toolCall.locations.some((l) =>
        protectedPathFor(l.path, "read", context.protectedPaths, context.workspaceCwd),
      );
      return hit
        ? {
            allow: false,
            basis: "protected",
            reason: "Denied by ORCA: the call touches ORCA's own files, which no rule opens to an agent.",
          }
        : { allow: true, basis: "probe" };
    }
    const toolCall = physicalLocations(call.toolCall, context.workspaceCwd);
    if (toolCall === undefined)
      return {
        allow: false,
        basis: "unresolved",
        reason: "Blocked by ORCA: it could not tell which file the call names, so no rule covers it.",
      };
    const verdict = await checkPreToolCall(
      context,
      toolCall,
      { cwd: call.cwd ?? context.workspaceCwd, toolUseId: call.toolCallId },
      call.typedInput ? typedInputPolicy : undefined,
    );
    if (verdict.decision === "allow") return { allow: true, basis: verdict.reason };
    // The same words the Codex hook answers with: an ask is a block, and says what would allow it.
    const reason = codexPreToolHookOutput(verdict).stderr.trim();
    return { allow: false, basis: `${verdict.reason}:${verdict.decision}`, reason };
  };
}
