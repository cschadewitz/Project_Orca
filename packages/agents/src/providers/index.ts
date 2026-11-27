/** The provider guards ORCA applies, one per agent product, and the session factory wrapper. */
import { OrcaError } from "@orca/core";
import type { OpenSessionOptions } from "../acp-session.js";
import type { AgentSession } from "../session.js";
import { clineGuard } from "./cline.js";
import { copilotCliGuard } from "./copilot-cli.js";
import type { ProviderGuard } from "./guard.js";
import { openCodeGuard } from "./opencode.js";

export type { ProviderGuard } from "./guard.js";
export * from "./copilot-cli.js";
export * from "./opencode.js";
export * from "./cline.js";

/** Every provider guard. Add a provider's guard here, one line, in its own module. */
export function providerGuards(): ProviderGuard[] {
  return [copilotCliGuard(), openCodeGuard(), clineGuard()];
}

/** The guard responsible for this agent, if any. Two matching guards is a configuration error. */
export function providerGuardFor(
  agent: OpenSessionOptions["agent"],
  guards: readonly ProviderGuard[] = providerGuards(),
): ProviderGuard | undefined {
  const matching = guards.filter((g) => g.matches(agent));
  if (matching.length > 1)
    throw new OrcaError(
      "CONFIG_INVALID",
      `Agent '${agent.id}' matches more than one provider (${matching.map((g) => g.id).join(", ")}).`,
      { agentId: agent.id },
    );
  return matching[0];
}

/**
 * `open` with the matching provider's checks around it. Agents no guard recognises open
 * exactly as before.
 */
export function withProviderGuards<O extends OpenSessionOptions>(
  open: (options: O) => Promise<AgentSession>,
  guards: readonly ProviderGuard[] = providerGuards(),
): (options: O) => Promise<AgentSession> {
  return async (options) => {
    const guard = providerGuardFor(options.agent, guards);
    if (!guard) return open(options);
    // A guarded agent's pinned behaviour is what its provider vouches for, and questions were
    // not part of it (#1133): it is not offered form elicitation, and refuses it as before.
    const { askElicitation: _notChecked, ...unasked } = options;
    const prepared = (await guard.prepare(unasked as O)) as O;
    return guard.guard(await open(prepared));
  };
}
