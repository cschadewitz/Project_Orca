/**
 * `orca remote add [user@]host`: make a reachable Linux machine a managed ORCA server in one
 * step (#881), from a terminal. The same setup as the desktop app's "Add a machine": this
 * checkout's `tools/deploy/orca-server-setup.py`, with its managed adapter embedded, runs on
 * the server over ORCA's own config-free ssh. It installs this version's signed server bundle,
 * the wrappers and the systemd user unit, and starts and checks the daemon; a re-run verifies
 * and repairs.
 *
 * Nothing is installed on a key nobody confirmed: the first run only inspects, read only and
 * with a first-seen host key held aside rather than pinned, and prints the host keys, the
 * account, what it would do, and a code bound to all of it. Running again with `--confirm CODE`
 * inspects again, and only when the code still matches what the server presents pins those
 * keys (in `~/.config/orca/known_hosts/`) and runs the setup over a pinned-only connection, as
 * exactly the confirmed account.
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
  confirmationCode,
  confirmedResult,
  discoverServer,
  dropDiscovery,
  enrollDiscovered,
  keyFingerprints,
  managedLauncher,
  readSetup,
  setupCommand,
  setupProgram,
  SETUP_SCRIPT,
  SETUP_TIMEOUT_MS,
  type InspectOutcome,
  type SetupOutcome,
  type SetupTunnel,
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
    tunnel?: (options: ConstructorParameters<typeof SshTunnel>[0]) => SetupTunnel;
    scripts?: string;
    version?: string;
  } = {},
): Promise<number> {
  const [sub, destination, ...extra] = ctx.positionals;
  if (sub !== "add" || !destination || extra.length)
    throw new OrcaError(
      "CONFIG_INVALID",
      "usage: orca remote add [user@]host [--ssh-port N] [--identity FILE] [--port N] [--confirm CODE]",
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
  const version = deps.version ?? ORCA_VERSION;
  const confirm = ctx.flags.confirm;
  if (confirm !== undefined && typeof confirm !== "string")
    throw new OrcaError("CONFIG_INVALID", "--confirm takes the code the first run printed");
  const base = { profile, knownHostsFile: join(pinsDir(), profile.id) };
  const make = deps.tunnel ?? ((options: ConstructorParameters<typeof SshTunnel>[0]) => new SshTunnel(options));
  const program = setupProgram(scripts);

  ctx.err(`Checking ${destination} (read only).`);
  const discovery = await discoverServer({ base, tunnel: make, version, program });
  const found = discovery.outcome;
  if (found.kind !== "inspected") {
    dropDiscovery(discovery);
    return finish(ctx, destination, found);
  }
  const { account, root, current } = found.inspected;
  const code = confirmationCode({ profile, keys: discovery.keys, account, version, scope: "install" });
  if (confirm !== code) {
    dropDiscovery(discovery);
    const fingerprints = keyFingerprints(discovery.keys);
    if (ctx.flags.json)
      ctx.out(
        JSON.stringify({
          kind: "confirm",
          fingerprints,
          firstUse: discovery.firstUse,
          account,
          root,
          current,
          version,
          confirmation: code,
        }),
      );
    else {
      for (const key of fingerprints.server)
        ctx.out(`Host key: ${key}${discovery.firstUse ? " (not pinned yet)" : " (pinned)"}`);
      ctx.out(`Account: ${account}`);
      ctx.out(
        current
          ? `Would verify and repair ORCA ${current} in ${root}, and its systemd user service.`
          : `Would install ORCA ${version} from its signed server bundle in ${root}, and enable and start its systemd user service with lingering.`,
      );
    }
    if (confirm !== undefined) {
      ctx.err(
        `--confirm ${confirm} does not match what ${destination} presents now (its host keys, account or this version). Nothing was changed. Check the above, then confirm with ${code}.`,
      );
      return 2;
    }
    ctx.err(
      `${discovery.firstUse ? "Check that the host key is the server's own (ssh-keygen -lf on the server). " : ""}To set it up, run again with --confirm ${code}`,
    );
    return 3;
  }

  // Confirmed: pin exactly the keys shown, and set up only through them, as that account.
  enrollDiscovered(discovery, base.knownHostsFile, profile.jump !== undefined);
  const tunnel = make({ ...base, pinnedOnly: true, expectKeys: discovery.keys });
  ctx.err(`Setting up ORCA ${version} on ${destination} as ${account}. This takes a few minutes.`);
  let outcome: SetupOutcome;
  try {
    await tunnel.open();
    // Only the setup that was confirmed counts: what the server reports must match it.
    outcome = confirmedResult(
      readSetup(await tunnel.exec(setupCommand(version, profile.remotePort, account), SETUP_TIMEOUT_MS, program)),
      { version, port: profile.remotePort, account, root },
    );
  } finally {
    await tunnel.close();
  }
  return finish(ctx, destination, outcome);
}

function finish(ctx: CommandContext, destination: string, outcome: SetupOutcome | InspectOutcome): number {
  if (ctx.flags.json) ctx.out(JSON.stringify(outcome));
  else {
    for (const step of outcome.steps)
      ctx.out(`${step.step}: ${RESULT_WORDS[step.result]}${step.detail ? ` (${step.detail})` : ""}`);
  }
  switch (outcome.kind) {
    case "inspected":
      return 0;
    case "ready":
      if (!ctx.flags.json)
        ctx.out(
          `${destination} is a managed ORCA server (v${outcome.version}). To connect and sign in, add an SSH profile for it in the desktop app with server command ${managedLauncher(outcome.root)}, or use Add a machine there.`,
        );
      return 0;
    case "refused":
      ctx.err(`Not set up: ${outcome.detail}`);
      return 2;
    case "failed":
      ctx.err(
        `Setup failed at "${outcome.step}": ${outcome.detail} Everything it changed is back as it was; run it again once this is fixed.`,
      );
      return 1;
    case "mismatch":
      ctx.err(`${outcome.detail} Use none of it; check the server.`);
      return 1;
    case "no-python":
      ctx.err(`${destination} has no python3. Install Python 3.8 or newer there, then run this again.`);
      return 1;
    default:
      ctx.err(
        outcome.kind === "unknown" && outcome.detail
          ? `The setup could not confirm that everything is back as it was: ${outcome.detail}`
          : "The setup did not report how it ended (the connection may have dropped). Run it again: it first puts back anything an unfinished run changed.",
      );
      return 1;
  }
}
