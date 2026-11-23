/** Fixed recovery and evidence boundaries for a read-only local tool observation. */
import type { JSX } from "react";
import type { FirstRunAgentCheck } from "../../../src/first-run-contract.js";
import { Text, Well } from "../ui/index.js";

const recovery: Record<FirstRunAgentCheck["state"], string> = {
  missing:
    "Executable missing from the app PATH. In Config, set the approved executable to an absolute path, Save, then review again. Finder may not inherit your terminal PATH. Setup installs nothing.",
  unavailable:
    "Executable access or header could not be read. Check the configured path, file access and runtime prerequisites with an operator, then Save and review again. Setup does not change permissions.",
  architecture:
    "Executable architecture differs from the app runtime. Select an approved matching build in Config, Save, then review again. Physical CPU, translation and native execution remain unverified.",
  "handshake-required":
    "Executable file observed. Its contents, runtime prerequisites and compatibility remain unverified; no agent was started.",
};
const route: Record<FirstRunAgentCheck["evidence"]["configuredRoute"], string> = {
  "claude-code-acp-candidate":
    "Configured command name suggests a Claude Code ACP adapter; installed identity is unverified.",
  "codex-acp-candidate": "Configured command name suggests a Codex ACP bridge; installed identity is unverified.",
  "copilot-cli-acp-candidate":
    "Configured command name suggests GitHub Copilot CLI. ORCA opens it only at a verified version, with --acp and --no-auto-update, its own COPILOT_HOME and no token in the config; sign in with `copilot login` yourself. See docs/agents/copilot-cli.md.",
  unverified:
    "Configured agent route is unverified. Review the command and required ACP adapter in Config with an operator.",
};
export function AgentPreflightReview({ checks }: { checks: readonly FirstRunAgentCheck[] }): JSX.Element {
  return (
    <>
      {checks.length === 0 && (
        <Text style="caption">No local agents configured. The harmless sample needs no provider.</Text>
      )}
      {checks.map((check) => (
        <div key={check.agentId}>
          <Well style="mono-id">{check.agentId}</Well>
          <Text style="caption">{recovery[check.state]}</Text>
          <Text style="caption">{route[check.evidence.configuredRoute]}</Text>
          <Text style="caption">
            Agent/version support: {check.evidence.support}. Installed version: {check.evidence.version}. Architecture:{" "}
            {check.evidence.architecture}. No version command was run. Scripts, interpreters and universal or
            unrecognized formats need separate runtime review.
          </Text>
          <Text style="caption">
            ACP: {check.evidence.acp === "not-checked" ? "not checked" : check.evidence.acp}. Sign-in:{" "}
            {check.evidence.signIn}. An executable or ACP handshake alone does not prove a usable signed-in session.
          </Text>
          <Text style="caption">
            Exact-command approval: {check.evidence.exactCommand} (#594). This review cannot clear that hold.
          </Text>
        </div>
      ))}
      <Text style="body">
        Before real work, hand off the selected agent to an operator to verify its installed provider/bridge versions,
        runtime and ACP support. If sign-in is required or expired, use the provider's own sign-in flow and review its
        subscription or quota, then obtain separate authorization for a bounded connection and real-agent check. Review
        project, transmission, cost, permissions and stop limits in Launch work. Keep credentials out of setup and
        support exports. Binding here only preserves configuration for reopening; it enables no provider check.
      </Text>
    </>
  );
}
