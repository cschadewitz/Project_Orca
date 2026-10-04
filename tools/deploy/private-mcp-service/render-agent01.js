#!/usr/bin/env node
/** Render the fixed agent-01 proposal to stdout; never read host state or install files. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AGENT01 = Object.freeze({
  SERVICE_HOME: "/home/casey",
  WORKSPACE_DIR: "/home/casey/.orca-codex-work",
  REVIEWED_PATH: "/home/casey/.local/share/mise/installs/node/24.21.0/bin:/usr/bin:/bin",
  NODE: "/home/casey/.local/share/mise/installs/node/24.21.0/bin/node",
  ORCA_CLI_ENTRY:
    "/home/casey/.local/share/orca-runtime/49efcc7236ac127c952bb1f7a50fc6ef72f7df84/packages/cli/dist/main.js",
  ORCA_CONFIG: "/home/casey/.orca-codex-work/orca.yaml",
  TMPDIR: "/srv/dev/orca-temp-cal",
  TUNNEL_CLIENT: "/opt/orca-tunnel/0.0.15/tunnel-client",
  TUNNEL_PROFILE: "/home/casey/.orca-codex-work/supervision/tunnel-profile.yaml",
  LIVE_LAUNCHER: "/home/casey/.orca-codex-work/mcp-client.cjs",
  TUNNEL_ID: "tunnel_6ac0b657e5d88191a442de4978b38ea9",
  CONTROL_PLANE_KEY_FILE: "/home/casey/.orca-codex-work/supervision/tunnel-runtime.key",
  // Proposed port: owner must verify availability before approving installation.
  TUNNEL_HEALTH_PORT: "33872",
});

const templates = Object.freeze({
  "orca-daemon.service": "orca-daemon.service.template",
  "orca-tunnel.service": "orca-tunnel.service.template",
  "tunnel-profile.yaml": "tunnel-profile.live-launcher.yaml.template",
});

export function renderAgent01(artifact) {
  if (!Object.hasOwn(templates, artifact)) throw new Error("Unknown agent-01 artifact");
  const source = readFileSync(new URL(templates[artifact], import.meta.url), "utf8");
  return source.replace(/\r\n/g, "\n").replace(/@([A-Z_]+)@/g, (_match, name) => {
    if (!Object.hasOwn(AGENT01, name)) throw new Error("Unresolved agent-01 placeholder");
    return AGENT01[name];
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error("Expected one artifact name");
    process.stdout.write(renderAgent01(process.argv[2]));
  } catch {
    process.stderr.write("Usage: render-agent01.js orca-daemon.service|orca-tunnel.service|tunnel-profile.yaml\n");
    process.exitCode = 64;
  }
}
