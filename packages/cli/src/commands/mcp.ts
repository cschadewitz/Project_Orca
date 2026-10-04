/** CLI integration helper. It never bootstraps an owner credential or starts a daemon. */
import { DaemonOperatorBackend, serveOperatorStdio } from "@orca/integrations/mcp";
import { OrcaError } from "@orca/core";

export async function mcpCommand(
  options: { endpoint?: string; tokenEnv?: string } = {},
  environment: NodeJS.ProcessEnv = process.env,
) {
  const endpoint = options.endpoint ?? environment.ORCA_DAEMON_URL;
  const tokenEnv = options.tokenEnv ?? "ORCA_MCP_TOKEN";
  if (!endpoint || !environment[tokenEnv])
    throw new OrcaError(
      "CONFIG_INVALID",
      "orca mcp requires --endpoint (or ORCA_DAEMON_URL) and an explicit credential in ORCA_MCP_TOKEN (or --token-env)",
    );
  const backend = new DaemonOperatorBackend({ endpoint, credential: async () => environment[tokenEnv] ?? "" });
  await backend.call("discover", {}); // fail before opening stdio for an identity-less/unsupported daemon
  return serveOperatorStdio(backend);
}
