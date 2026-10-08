/** Display classification of audited core fields; this grants no read/write authority. */
import type { ConfigFieldMetadata } from "@orca/protocol";

// Arbitrary execution/transport strings may contain credentials. Preserve them in source,
// but do not echo values, enum literals or descriptions into new semantic summaries.
const withheldRoots = [
  "agents[].args",
  "agents[].env",
  "agents[].mcpServers",
  "hosts[].sshArgs",
  "hosts[].remoteShell",
  "hosts[].identityFile",
  "agents[].permissions.rules[].match.titlePattern",
  "plugins",
];

// Explicitly audited from core/config.ts and core/model/agent.ts: schema structure,
// identifiers, binary selectors, file/glob selectors, numeric limits and policy enums.
// A future field never inherits classification merely because its parent is known.
const nonSecret = new Set([
  "",
  "version",
  "storeDir",
  "admissionRetry",
  "admissionRetry.maxClaimsPerWorkspace",
  "admissionRetry.maxClaimsPerPrincipal",
  "hosts",
  "hosts[]",
  "hosts[].id",
  "hosts[].type",
  "hosts[].host",
  "hosts[].user",
  "hosts[].port",
  "hosts[].sshBinary",
  "hosts[].workspaceRoot",
  "hosts[].connectTimeoutMs",
  "agents",
  "agents[]",
  "agents[].id",
  "agents[].name",
  "agents[].command",
  "agents[].hostId",
  "agents[].roles",
  "agents[].roles[]",
  "agents[].sessionMode",
  "agents[].turnTimeoutMs",
  "agents[].cancelGraceMs",
  "agents[].models",
  "agents[].models[]",
  "agents[].models[].id",
  "agents[].models[].name",
  "agents[].defaultModel",
  "agents[].permissions",
  "agents[].permissions.default",
  "agents[].permissions.rules",
  "agents[].permissions.rules[]",
  "agents[].permissions.rules[].match",
  "agents[].permissions.rules[].match.kind",
  "agents[].permissions.rules[].match.path",
  "agents[].permissions.rules[].match.pathPrefix",
  "agents[].permissions.rules[].match.scope",
  "agents[].permissions.rules[].decision",
  "roles",
  "roles.<key>",
  "workflows",
  "workflows[]",
  "templates",
  "templates[]",
  "program",
  "program.workflow",
  "program.itemWorkflow",
  "workspace",
  "workspace.provider",
  "workspace.hostId",
  "workspace.root",
  "workspace.repo",
  "workspace.worktreeRoot",
  "workspace.baseBranch",
  "workspace.branchPrefix",
  "workspace.isolateRoots",
  "workspace.taskDir",
  "humanInput",
  "humanInput.mode",
]);

/** Structural classification permits labels/controls, never raw aggregate value display. */
export function configFieldVisibility(path: string): ConfigFieldMetadata["visibility"] {
  if (withheldRoots.some((root) => path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[]`)))
    return "withheld";
  return nonSecret.has(path) ? "non-secret" : "metadata-unavailable";
}
