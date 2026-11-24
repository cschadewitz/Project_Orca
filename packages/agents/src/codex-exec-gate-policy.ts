/**
 * How ORCA's gate in Codex's executor path decides a call (#1026): by the same layered policy
 * the ACP ask and the `PreToolUse` hook use, read fresh for each request, so a grant revoked a
 * moment ago does not decide the next call.
 *
 * The gate hands over the link-free paths the executor is sent (`codex-exec-gate.ts`), and a
 * rule reads them as given: it is the executor, not a second resolution here, that holds a
 * request to them. A decision made here is therefore about a path. It is not about the
 * identity of a file, and a protected file reached under another name that is no link (a
 * directory moved into place) is not seen here. A second hard link never gets this far: the
 * gate refuses a file with more than one name. The gate's own notes say what is left open,
 * and what the isolated executor closes.
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
 * A path the kernel named, in the workspace's own spelling when it is inside the workspace,
 * so that a workspace reached through a link is still the workspace to a rule. The path
 * itself is not resolved again: it is the one the executor is held to. Undefined when the
 * workspace cannot be resolved, which nothing allows.
 */
export function workspaceNamed(path: string, workspaceCwd: string): string | undefined {
  const workspace = physicalPathOf(workspaceCwd);
  if (workspace === undefined) return undefined;
  const within = relative(workspace, path);
  const inside = within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within));
  return inside ? join(workspaceCwd, within) : path;
}

const UNRESOLVED: CodexExecGateDecision = {
  allow: false,
  basis: "unresolved",
  reason: "Blocked by ORCA: it could not tell which file the call names, so no rule covers it.",
};

/**
 * The gate's `decide` for one session, from the context ORCA already writes for its hook.
 *
 * A call is decided as the executor will carry it out, and again in the request's own words
 * when they differ. It is allowed only when both are: one decision over both paths would let
 * a rule written for one of them stand for the other.
 */
export function codexExecGateDecider(
  context: ClaudeHookContext,
): (call: CodexExecGateCall) => Promise<CodexExecGateDecision> {
  return async (call) => {
    const named: { path: string }[] = [];
    for (const { path } of call.toolCall.locations) {
      const spelled = workspaceNamed(path, context.workspaceCwd);
      if (spelled === undefined) return UNRESOLVED;
      named.push({ path: spelled });
    }
    const cwd = call.cwd === undefined ? undefined : workspaceNamed(call.cwd, context.workspaceCwd);
    if (call.cwd !== undefined && cwd === undefined) return UNRESOLVED;
    const forms = [{ title: call.toolCall.title, locations: named, cwd }, ...(call.asWritten ? [call.asWritten] : [])];

    if (call.check === "protected") {
      const hit = forms.some((form) =>
        form.locations.some((l) => protectedPathFor(l.path, "read", context.protectedPaths, context.workspaceCwd)),
      );
      return hit
        ? {
            allow: false,
            basis: "protected",
            reason: "Denied by ORCA: the call touches ORCA's own files, which no rule opens to an agent.",
          }
        : { allow: true, basis: "probe" };
    }

    let basis = "";
    for (const form of forms) {
      const verdict = await checkPreToolCall(
        context,
        { title: form.title, kind: call.toolCall.kind, locations: form.locations },
        { cwd: form.cwd ?? context.workspaceCwd, toolUseId: call.toolCallId },
        call.typedInput ? typedInputPolicy : undefined,
      );
      if (verdict.decision !== "allow") {
        // The same words the Codex hook answers with: an ask is a block, and says what would allow it.
        const reason = codexPreToolHookOutput(verdict).stderr.trim();
        return { allow: false, basis: `${verdict.reason}:${verdict.decision}`, reason };
      }
      basis ||= verdict.reason;
    }
    return { allow: true, basis };
  };
}
