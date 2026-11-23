/**
 * The enforcement paths the #706 suite runs its cases against. A path takes a provider-neutral
 * action (`world.js`), sends it through ORCA's real code exactly as that route receives it,
 * and reports one outcome:
 *
 * - `allow`: ORCA lets the call go on. On a hook route that means "no objection": the agent's
 *   own permission check and sandbox still run after it.
 * - `ask`: ORCA puts the call to a person (or, with nobody to ask, does not run it).
 * - `deny`: ORCA refuses it.
 * - `block`: ORCA could not decide and the call does not run.
 *
 * `surfaces` are the strings the path hands to anything outside ORCA's own process (the agent,
 * its transcript, a log line), which the privacy cases search for leaked input.
 *
 * `capabilities` say which kinds of case a path can be asked about at all. A case that needs a
 * capability a path lacks must be excluded for that path in `support-matrix.json`, with the
 * reason: the matrix, not the suite, is where "not covered" is said out loud.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claudePreToolHookSettings,
  loadEffectivePermissionPolicy,
  resolvePermission,
  runClaudePreToolHook,
} from "@orca/agents";
import { claudeShape, permissionRequest } from "./world.js";

/** ORCA's own answer to an ACP permission ask, through `resolvePermission` (`acp-session.ts`). */
export const acpAsk = {
  id: "acp-ask",
  capabilities: ["answerer", "offered-options"],

  async decide(world, action, opts = {}) {
    const request = permissionRequest(world, action, opts.options);
    // `openAcpSession` reads the policy fresh for every ask, a damaged sidecar reported, not thrown.
    const policy = await loadEffectivePermissionPolicy(
      { id: world.agentId, permissions: world.configured },
      [world.sidecar],
      () => {},
    );
    const answerer = opts.noAnswerer
      ? undefined
      : async (req) => {
          world.asked.push(req.toolCall.title);
          if (opts.onAsk) return opts.onAsk(req);
          return world.answers.shift();
        };
    const { response, decision } = await resolvePermission(policy, {
      request,
      scope: { workspaceCwd: world.workspace, protectedPaths: world.protectedPaths },
      ...(answerer ? { ask: answerer } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { outcome: acpOutcome(decision), detail: decision, response, surfaces: [decision] };
  },
};

function acpOutcome(decision) {
  if (decision === "allow") return "allow";
  if (decision.startsWith("deny")) return "deny";
  if (decision.startsWith("ask:")) return "ask";
  return "block";
}

/** ORCA's Claude `PreToolUse` hook (#704), run as its process runs it (`runClaudePreToolHook`). */
export const claudeNativeHook = {
  id: "claude-native-hook",
  capabilities: ["raw-input", "context-file", "cwd", "hook-settings"],

  /** Where the session's hook context lives: inside ORCA's read-only `.orca` area. */
  contextFile(world) {
    return join(world.configDir, ".orca", "hook-context.json");
  },

  /** What ORCA writes when it opens the session; written once, like the session does. */
  async open(world) {
    if (world.hookContextWritten) return;
    await mkdir(join(world.configDir, ".orca"), { recursive: true });
    await writeFile(
      claudeNativeHook.contextFile(world),
      JSON.stringify({
        version: 1,
        agentId: world.agentId,
        permissions: world.configured,
        permissionFiles: [world.sidecar],
        workspaceCwd: world.workspace,
        protectedPaths: world.protectedPaths,
      }),
    );
    world.hookContextWritten = true;
  },

  frame(world, action) {
    const { toolName, toolInput } = claudeShape(action);
    return JSON.stringify({
      session_id: "acceptance-session",
      transcript_path: "/dev/null",
      cwd: action.cwd ?? world.workspace,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: `toolu_${++world.seq}`,
    });
  },

  async decide(world, action) {
    await claudeNativeHook.open(world);
    return claudeNativeHook.decideRaw(world, claudeNativeHook.frame(world, action));
  },

  /** Send the hook exactly these stdin bytes, with these arguments. */
  async decideRaw(world, input, args) {
    await claudeNativeHook.open(world);
    const result = await runClaudePreToolHook(args ?? [claudeNativeHook.contextFile(world)], input);
    return { outcome: hookOutcome(result), detail: result, surfaces: [result.stdout, result.stderr] };
  },

  settings() {
    return claudePreToolHookSettings({
      command: "/usr/bin/node",
      args: ["/opt/orca/claude-pre-tool-hook.js", "/var/orca/hook-context.json"],
    });
  },
};

function hookOutcome(result) {
  if (result.exitCode !== 0) return "block";
  if (result.stdout === "") return "allow";
  const decision = JSON.parse(result.stdout)?.hookSpecificOutput?.permissionDecision;
  // The hook never answers `allow` (it would skip Claude's own check): anything else is a defect
  // the case must see, not a block to be counted as safe.
  return decision === "ask" || decision === "deny" ? decision : `invalid:${String(decision)}`;
}

export const PATHS = [acpAsk, claudeNativeHook];
