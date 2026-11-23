/**
 * @orca/testing - a scripted ACP agent plus helpers to configure it as an
 * AgentSpec. Used by ORCA's own tests and by `orca demo`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSpec, SessionConfigOption } from "@orca/core";
import { AgentSpecSchema } from "@orca/core";
import { childBundle } from "./child-bundle.js";

export { CHILD_BUNDLE_DIR_ENV, childBundle, type ChildBundleOptions } from "./child-bundle.js";

export { ScriptedAgent, type ScriptedAgentOptions } from "./scripted-agent/agent.js";
export {
  parsePlaybook,
  PlaybookSchema,
  PlaybookEntrySchema,
  type Playbook,
  type PlaybookEntry,
  type PlaybookInput,
} from "./scripted-agent/playbook.js";

const here = dirname(fileURLToPath(import.meta.url));
const runningFromSource = import.meta.url.endsWith(".ts");

/**
 * Build an AgentSpec that launches the scripted agent. When ORCA itself runs
 * from TypeScript sources (tests, `npm run orca`), the agent is started through
 * `tsx`, or from the run's prebuilt bundle under the test runner; when built, the
 * compiled entry point is used directly.
 */
export function scriptedAgentSpec(options: {
  id?: string;
  playbookFile?: string;
  playbookJson?: unknown;
  stateFile?: string;
  promptLog?: string;
  /** Where the agent appends each `session/new` it receives (see `ScriptedAgentOptions`). */
  sessionLog?: string;
  /** Advertise ACP `promptCapabilities.embeddedContext`, so skills can be delivered (#337). */
  embeddedContext?: boolean;
  roles?: string[];
  /** Session config options the agent advertises (overrides the playbook's `configOptions`). */
  configOptions?: SessionConfigOption[];
  hostId?: string;
  sessionMode?: "per-step" | "per-run";
  permissions?: AgentSpec["permissions"];
  turnTimeoutMs?: number;
  cancelGraceMs?: number;
}): AgentSpec {
  const source = join(here, "scripted-agent", runningFromSource ? "main.ts" : "main.js");
  const args: string[] = [];
  const command = process.execPath;
  // Under the test runner, the sources prebuilt once for the run (child-bundle.ts): a plain
  // node start instead of a tsx transpile on every agent launch.
  const bundled = runningFromSource ? childBundle("scripted-agent", { entries: { main: source } })?.main : undefined;
  if (runningFromSource && !bundled) {
    // Route through tsx with the repo tsconfig so `@orca/*` imports resolve to sources (paths mapping).
    const require = createRequire(import.meta.url);
    args.push(require.resolve("tsx/cli"), "--tsconfig", join(here, "..", "..", "..", "tsconfig.json"));
  }
  args.push(bundled ?? source);
  if (options.playbookFile) args.push("--playbook", options.playbookFile);
  if (options.stateFile) args.push("--state", options.stateFile);
  if (options.promptLog) args.push("--log", options.promptLog);
  const env: Record<string, string> = {};
  if (options.playbookJson !== undefined) env.ORCA_PLAYBOOK_JSON = JSON.stringify(options.playbookJson);
  if (options.configOptions) env.ORCA_CONFIG_OPTIONS_JSON = JSON.stringify(options.configOptions);
  if (options.sessionLog) env.ORCA_SESSION_LOG = options.sessionLog;
  if (options.embeddedContext) env.ORCA_EMBEDDED_CONTEXT = "1";
  return AgentSpecSchema.parse({
    id: options.id ?? "scripted",
    name: "Scripted test agent",
    command,
    args,
    env,
    hostId: options.hostId ?? "local",
    roles: options.roles ?? ["planner", "designer", "builder", "tester", "reviewer", "deployer", "decomposer"],
    sessionMode: options.sessionMode ?? "per-step",
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.cancelGraceMs ? { cancelGraceMs: options.cancelGraceMs } : {}),
  });
}
