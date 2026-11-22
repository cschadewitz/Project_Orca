/**
 * `orca remote add [user@]host`: make a reachable Linux machine a managed ORCA server in one
 * step (#881), from a terminal. The same setup as the desktop app's "Add a machine": this
 * checkout's `tools/deploy/orca-server-setup.py`, with its managed adapter embedded, runs on
 * the server over ORCA's own config-free ssh, pinning the server's host key on first use the
 * way a first connect does. It installs this version's signed server bundle, the wrappers and
 * the systemd user unit, and starts and checks the daemon; a re-run verifies and repairs.
 *
 * It issues no credential and prints none: sign in from the app, whose profile for the
 * machine runs the managed launcher this prints (`ServerSetupResult.command`).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrcaError } from "@orca/core";
import { ConnectionProfileSchema, profileIdFor, SshTunnel } from "@orca/protocol/remote-access";
import {
  readSetup,
  setupCommand,
  setupProgram,
  SETUP_SCRIPT,
  SETUP_TIMEOUT_MS,
  type SetupOutcome,
} from "@orca/protocol/server-setup";
import { readOrcaVersion } from "../version.js";
import type { CommandContext } from "./index.js";

const ORCA_VERSION = readOrcaVersion();

/** This checkout's setup files; a bundled CLI carries none. */
export function setupScripts(): string | undefined {
  const dir = fileURLToPath(new URL("../../../../tools/deploy/", import.meta.url));
  return existsSync(join(dir, SETUP_SCRIPT)) ? dir : undefined;
}

/** Where the CLI keeps the host keys it pinned: one file per server, like the app's. */
function pinsDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "orca", "known_hosts");
}

function port(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (typeof value !== "string" || !Number.isInteger(n) || n < 1 || n > 65535)
    throw new OrcaError("CONFIG_INVALID", `${flag} must be a port number from 1 to 65535`);
  return n;
}

const RESULT_WORDS = {
  ok: "already done",
  changed: "done",
  repaired: "repaired",
  warning: "warning",
  refused: "refused",
  failed: "failed",
} as const;

export async function remoteCommand(
  ctx: CommandContext,
  deps: {
    tunnel?: (
      options: ConstructorParameters<typeof SshTunnel>[0],
    ) => Pick<SshTunnel, "open" | "exec" | "close" | "hostKeyFingerprint">;
    scripts?: string;
    version?: string;
  } = {},
): Promise<number> {
  const [sub, destination, ...extra] = ctx.positionals;
  if (sub !== "add" || !destination || extra.length)
    throw new OrcaError(
      "CONFIG_INVALID",
      "usage: orca remote add [user@]host [--ssh-port N] [--identity FILE] [--port N]",
    );
  const scripts = deps.scripts ?? setupScripts();
  if (!scripts)
    throw new OrcaError(
      "CONFIG_INVALID",
      "orca remote add runs from a source checkout; in the desktop app, use Add a machine in the connection dialog.",
    );
  const sshPort = port(ctx.flags["ssh-port"], "--ssh-port");
  const daemonPort = port(ctx.flags.port, "--port") ?? 6722;
  const identity = ctx.flags.identity;
  if (identity !== undefined && typeof identity !== "string")
    throw new OrcaError("CONFIG_INVALID", "--identity takes a key file");
  const parsed = ConnectionProfileSchema.safeParse({
    id: profileIdFor(destination, new Set()),
    name: destination,
    destination,
    remotePort: daemonPort,
    ...(sshPort ? { sshPort } : {}),
    ...(identity ? { identityFile: identity } : {}),
  });
  if (!parsed.success) throw new OrcaError("CONFIG_INVALID", parsed.error.issues[0]?.message ?? "Invalid destination");
  const profile = parsed.data;
  const command = setupCommand(deps.version ?? ORCA_VERSION, profile.remotePort);
  const options = { profile, knownHostsFile: join(pinsDir(), profile.id) };
  const tunnel = deps.tunnel ? deps.tunnel(options) : new SshTunnel(options);
  ctx.err(`Setting up ORCA ${deps.version ?? ORCA_VERSION} on ${destination}. This takes a few minutes.`);
  let outcome: SetupOutcome;
  try {
    await tunnel.open();
    if (tunnel.hostKeyFingerprint)
      ctx.err(`Host key ${tunnel.hostKeyFingerprint} (pinned in ${options.knownHostsFile}).`);
    outcome = readSetup(await tunnel.exec(command, SETUP_TIMEOUT_MS, setupProgram(scripts)));
  } finally {
    await tunnel.close();
  }
  if (ctx.flags.json) ctx.out(JSON.stringify(outcome));
  else {
    for (const step of outcome.steps)
      ctx.out(`${step.step}: ${RESULT_WORDS[step.result]}${step.detail ? ` (${step.detail})` : ""}`);
  }
  switch (outcome.kind) {
    case "ready":
      if (!ctx.flags.json)
        ctx.out(
          `${destination} is a managed ORCA server (v${outcome.version}). To connect and sign in, add an SSH profile for it in the desktop app with server command ${outcome.command}, or use Add a machine there.`,
        );
      return 0;
    case "refused":
      ctx.err(`Not set up: ${outcome.detail}`);
      return 2;
    case "failed":
      ctx.err(
        `Setup failed at "${outcome.step}": ${outcome.detail} Nothing it started was left enabled; run it again once this is fixed.`,
      );
      return 1;
    case "no-python":
      ctx.err(`${destination} has no python3. Install Python 3.8 or newer there, then run this again.`);
      return 1;
    default:
      ctx.err(
        "The setup did not report how it ended (the connection may have dropped). Run it again: it picks up where it stopped.",
      );
      return 1;
  }
}
