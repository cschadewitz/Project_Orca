/**
 * Provider guards: what one agent product needs beyond the generic ACP session (#709-#711).
 *
 * A guard recognises its agent from the configured spec, checks the launch before anything
 * starts (and may adjust the session options, never the spec), and wraps the opened session.
 * Each provider lives in its own module beside this one and is listed once in `index.ts`;
 * nothing provider-specific goes into `acp-session.ts`. A guard that refuses throws an
 * `OrcaError` and the agent is not started.
 */
import type { AgentSpec } from "@orca/core";
import type { OpenSessionOptions } from "../acp-session.js";
import type { AgentSession } from "../session.js";

export interface ProviderGuard {
  /** Stable name, for logs and the support matrix. */
  readonly id: string;
  /** True for an agent spec this guard is responsible for. At most one guard may match. */
  matches(agent: AgentSpec): boolean;
  /** Check the launch and return the options to open with. Runs before the agent is spawned. */
  prepare(options: OpenSessionOptions): Promise<OpenSessionOptions>;
  /** Wrap the opened session. Throwing closes nothing for you: close the session first. */
  guard(session: AgentSession): AgentSession;
}
