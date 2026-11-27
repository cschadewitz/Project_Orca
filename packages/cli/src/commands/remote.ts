/**
 * `orca remote add [user@]host`: make a reachable Linux machine a managed ORCA server in one
 * step (#881), from a terminal. The same setup as the desktop app's "Add a machine": this
 * checkout's `tools/deploy/orca-server-setup.py`, with its managed adapter embedded, runs on
 * the server over ORCA's own config-free ssh. It installs this version's signed server bundle,
 * the wrappers and the systemd user unit, and starts and checks the daemon; a re-run verifies
 * and repairs. A Windows machine (#1238) runs `tools/deploy/orca-server-setup.ps1` in its own
 * Windows PowerShell instead, which downloads and verifies the bundle there and runs the daemon
 * as a scheduled task.
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
 *
 * With the incubating `tailnet-hosts` flag (#1225), `--tailnet` names a machine on this
 * computer's tailnet instead of a host (`build-1`, its full MagicDNS name, or its node ID): ssh
 * dials that node's current address, a Tailscale SSH check-mode login prints its approval link,
 * and the host keys the tailnet advertises are what ssh checks the server against (#1227).
 * `--push-bundle` carries the signed bundle from this computer for a host with no internet
 * access (#1234). `orca remote push-repo` puts a repository on such a server from this computer,
 * through the host key `remote add` pinned (#1235). `orca remote agent install|status|login`
 * installs a pinned agent there from this computer and signs it in with the agent's own device
 * code, approved in this computer's browser (#1236).
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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
  launcherCommand,
  windowsSshBootstrap,
  readSetup,
  setupInvocation,
  SETUP_SCRIPT,
  type InspectOutcome,
  type ServerOs,
  type SetupOutcome,
  type SetupTunnel,
} from "@orca/protocol/server-setup";
import {
  bindingFor,
  findTailnetPeer,
  readTailnet,
  tailnetEnabled,
  tailnetHostResolver,
  tailnetLoginOrigins,
  type ReadTailnetOptions,
  type TailnetPeer,
} from "@orca/protocol/tailnet";
import { dropCourier, httpsFetch, prepareCourier, pushCourier, type CourierFetch } from "@orca/protocol/server-courier";
import {
  bundleRepository,
  localGit,
  pushRepository,
  refsToPush,
  repositoryName,
  RepositoryRefused,
  workspaceSnippet,
  type LocalGit,
} from "@orca/protocol/server-repository";
import {
  hostAgent,
  hostAgentSettings,
  hostAgentSignInCommand,
  hostAgentsProgram,
  hostAgentStatus,
  HostAgentRefused,
  HOST_AGENTS,
  installHostAgent,
  prepareHostAgent,
  signInHostAgent,
} from "@orca/protocol/server-agents";
import { readOrcaVersion } from "../version.js";
import type { CommandContext } from "./index.js";
import { remoteEnrollCommand } from "./remote-enroll.js";

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
    /** Test seams for `--tailnet` and `--push-bundle`. */
    tailnet?: ReadTailnetOptions;
    courierFetch?: CourierFetch;
    cacheDir?: string;
    /** Test seam for `push-repo`: git on this computer. */
    git?: LocalGit;
  } = {},
): Promise<number> {
  // `orca remote enroll <id>` (#883): delegation's one-time trust step for a configured remote.
  if (ctx.positionals[0] === "enroll") return remoteEnrollCommand(ctx);
  const [sub, destination, ...extra] = ctx.positionals;
  if (sub === "push-repo" && destination && !extra.length) return pushRepoCommand(ctx, destination, deps);
  if (sub === "agent" && destination && extra.length === 1) return agentCommand(ctx, destination, extra[0]!, deps);
  if (sub === "windows-ssh" && !destination) return windowsSshCommand(ctx, deps);
  if (sub !== "add" || !destination || extra.length)
    throw new OrcaError(
      "CONFIG_INVALID",
      "usage: orca remote add [user@]host [--tailnet] [--ssh-port N] [--identity FILE] [--port N] [--push-bundle] [--confirm CODE], orca remote push-repo [user@]host [--tailnet] [--repo DIR] [--name NAME] [--ref REF]..., orca remote agent install|status|login [user@]host [--tailnet] [--agent ID], orca remote windows-ssh, or orca remote enroll <id> [--host-key SHA256:... | --tailnet]",
    );
  const scripts = deps.scripts ?? setupScripts();
  if (!scripts)
    throw new OrcaError(
      "CONFIG_INVALID",
      "orca remote add runs from a source checkout; in the desktop app, use Add a machine in the connection dialog.",
    );
  if (ctx.flags["push-bundle"] && !tailnetEnabled(deps.tailnet?.features))
    throw new OrcaError("CONFIG_INVALID", "--tailnet and --push-bundle are not available in this build.");
  const { profile, peer, base } = await profileFor(ctx, destination, deps);
  const version = deps.version ?? ORCA_VERSION;
  const confirm = ctx.flags.confirm;
  if (confirm !== undefined && typeof confirm !== "string")
    throw new OrcaError("CONFIG_INVALID", "--confirm takes the code the first run printed");
  const make = deps.tunnel ?? ((options: ConstructorParameters<typeof SshTunnel>[0]) => new SshTunnel(options));

  ctx.err(`Checking ${destination} (read only).`);
  const discovery = await discoverServer({
    base,
    tunnel: make,
    version,
    scripts,
    // A machine shared in from another tailnet is vouched for by that tailnet, not yours: confirm by hand.
    ...(peer?.sshHostKeys.length && !peer.sharedIn
      ? { advertised: { alias: `orca-${profile.id}`, keys: peer.sshHostKeys } }
      : {}),
  });
  const found = discovery.outcome;
  if (found.kind !== "inspected") {
    dropDiscovery(discovery);
    return finish(ctx, destination, found);
  }
  const { account, root, current } = found.inspected;
  const { os } = discovery;
  const code = confirmationCode({
    profile,
    keys: discovery.keys,
    account,
    root,
    current,
    version,
    scope: "install",
    ...(os === "windows" ? { os } : {}),
  });
  if (confirm !== code) {
    dropDiscovery(discovery);
    const fingerprints = keyFingerprints(discovery.keys);
    if (ctx.flags.json)
      ctx.out(
        JSON.stringify({
          kind: "confirm",
          fingerprints,
          firstUse: discovery.firstUse,
          ...(discovery.advertised ? { advertised: true } : {}),
          account,
          root,
          current,
          version,
          ...(os === "windows" ? { os } : {}),
          confirmation: code,
        }),
      );
    else {
      for (const key of fingerprints.server)
        ctx.out(
          `Host key: ${key}${discovery.advertised ? " (advertised by your tailnet's coordination server)" : discovery.firstUse ? " (not pinned yet)" : " (pinned)"}`,
        );
      ctx.out(`Account: ${account}`);
      const service = os === "windows" ? "its scheduled task \\ORCA\\orca-server" : "its systemd user service";
      ctx.out(
        current
          ? `Would verify and repair ORCA ${current} in ${root}, and ${service}.`
          : os === "windows"
            ? `Would install ORCA ${version} from its signed server bundle in ${root}, and register and start ${service} (at boot where ${account} may register that, otherwise at its logon, and the setup says so).`
            : `Would install ORCA ${version} from its signed server bundle in ${root}, and enable and start ${service} with lingering.`,
      );
    }
    if (confirm !== undefined) {
      ctx.err(
        `--confirm ${confirm} does not match what ${destination} presents now (its host keys, account or this version). Nothing was changed. Check the above, then confirm with ${code}.`,
      );
      return 2;
    }
    ctx.err(
      `${discovery.firstUse && !discovery.advertised ? "Check that the host key is the server's own (ssh-keygen -lf on the server). " : ""}To set it up, run again with --confirm ${code}`,
    );
    return 3;
  }

  if (ctx.flags["push-bundle"] && os === "windows") {
    dropDiscovery(discovery);
    throw new OrcaError(
      "CONFIG_INVALID",
      "--push-bundle is not available for a Windows server yet; it downloads its own bundle.",
    );
  }
  // Confirmed: pin exactly the keys shown, and set up only through them, as that account.
  enrollDiscovered(discovery, base.knownHostsFile, profile.jump !== undefined);
  const tunnel = make({ ...base, pinnedOnly: true, expectKeys: discovery.keys });
  ctx.err(`Setting up ORCA ${version} on ${destination} as ${account}. This takes a few minutes.`);
  let outcome: SetupOutcome;
  const courier = ctx.flags["push-bundle"]
    ? await prepareCourier({
        version,
        cacheDir: deps.cacheDir ?? cacheDir(),
        ...(deps.courierFetch ? { fetch: deps.courierFetch } : {}),
      })
    : undefined;
  try {
    await tunnel.open();
    if (courier) ctx.err(`Copying the signed server bundle to ${destination}.`);
    const transport = {
      exec: (command: readonly string[], timeoutMs?: number) => tunnel.exec(command, timeoutMs),
      upload: (path: string, remotePath: string, timeoutMs?: number) => {
        if (!tunnel.upload) throw new OrcaError("CONFIG_INVALID", "This connection cannot copy files to the server.");
        return tunnel.upload(path, remotePath, timeoutMs);
      },
    };
    const scratch = courier ? await pushCourier(transport, courier) : undefined;
    try {
      // Only the setup that was confirmed counts: what the server reports must match it.
      const run = setupInvocation(os, scripts, version, profile.remotePort, { account, root, current }, scratch?.path);
      outcome = confirmedResult(
        readSetup(await tunnel.exec(run.command, run.timeoutMs, run.input)),
        { version, port: profile.remotePort, account, root },
        os,
      );
    } finally {
      if (scratch) await dropCourier(transport, scratch);
    }
  } finally {
    await tunnel.close();
  }
  return finish(ctx, destination, outcome, os);
}

type RemoteDeps = NonNullable<Parameters<typeof remoteCommand>[1]>;

/**
 * The profile a destination names, as `remote add` and `push-repo` both build it: the same id,
 * so the same pin file. With `--tailnet`, bound to the node and dialled at its current address.
 */
async function profileFor(ctx: CommandContext, destination: string, deps: RemoteDeps) {
  const sshPort = port(ctx.flags["ssh-port"], "--ssh-port");
  const daemonPort = port(ctx.flags.port, "--port") ?? 6722;
  const identity = ctx.flags.identity;
  if (identity !== undefined && typeof identity !== "string")
    throw new OrcaError("CONFIG_INVALID", "--identity takes a key file");
  if (ctx.flags.tailnet && !tailnetEnabled(deps.tailnet?.features))
    throw new OrcaError("CONFIG_INVALID", "--tailnet and --push-bundle are not available in this build.");
  const peer = ctx.flags.tailnet ? await tailnetPeer(ctx, destination, deps.tailnet) : undefined;
  const at = destination.lastIndexOf("@");
  const user = at < 0 ? "" : destination.slice(0, at + 1);
  const parsed = ConnectionProfileSchema.safeParse({
    id: profileIdFor(peer ? peer.dnsName.split(".")[0]! : destination, new Set()),
    name: peer ? peer.dnsName : destination,
    destination: peer ? `${user}${peer.dnsName}` : destination,
    ...(peer ? { tailnet: bindingFor(peer) } : {}),
    remotePort: daemonPort,
    ...(sshPort ? { sshPort } : {}),
    ...(identity ? { identityFile: identity } : {}),
  });
  if (!parsed.success) throw new OrcaError("CONFIG_INVALID", parsed.error.issues[0]?.message ?? "Invalid destination");
  const profile = parsed.data;
  const base = {
    profile,
    knownHostsFile: join(pinsDir(), profile.id),
    ...(profile.tailnet ? { resolveHost: tailnetHostResolver(profile.tailnet, deps.tailnet) } : {}),
    // Only for a machine on the tailnet, and only a page on its control plane (#1228).
    ...(profile.tailnet
      ? {
          onLoginApproval: (url: string) =>
            ctx.err(`Tailscale asks you to approve this login. Open this page, then wait here: ${url}`),
          approvalOrigins: tailnetLoginOrigins(),
        }
      : {}),
  };
  return { profile, peer, base };
}

/**
 * `orca remote push-repo [user@]host` (#1235): put this repository's current branch (or each
 * `--ref`) on a server `remote add` set up, over its pinned ssh only. The host needs no git
 * credentials; it fetches from a bundle this computer carries. Prints the workspace settings
 * that point the server's daemon at the checkout.
 */
async function pushRepoCommand(ctx: CommandContext, destination: string, deps: RemoteDeps): Promise<number> {
  if (!tailnetEnabled(deps.tailnet?.features))
    throw new OrcaError("CONFIG_INVALID", "orca remote push-repo is not available in this build.");
  const repoFlag = ctx.flags.repo;
  if (repoFlag !== undefined && typeof repoFlag !== "string")
    throw new OrcaError("CONFIG_INVALID", "--repo takes a directory");
  const nameFlag = ctx.flags.name;
  if (nameFlag !== undefined && typeof nameFlag !== "string")
    throw new OrcaError("CONFIG_INVALID", "--name takes a name");
  const refFlag = ctx.flags.ref;
  const requested = refFlag === undefined ? [] : Array.isArray(refFlag) ? refFlag.map(String) : [String(refFlag)];
  const git = deps.git ?? localGit;
  const repo = resolve(ctx.cwd, repoFlag ?? ".");
  const top = await git(["rev-parse", "--show-toplevel"], repo);
  if (top.code !== 0) throw new OrcaError("CONFIG_INVALID", `${repo} is not in a git repository.`);
  const worktree = top.stdout.trim();
  try {
    const name = repositoryName(nameFlag ?? basename(worktree));
    const refs = await refsToPush(git, worktree, requested);
    const { base } = await profileFor(ctx, destination, deps);
    // Only through a host key `remote add` already pinned: a push never trusts a key on first use.
    const make = deps.tunnel ?? ((options: ConstructorParameters<typeof SshTunnel>[0]) => new SshTunnel(options));
    const tunnel = make({ ...base, pinnedOnly: true });
    ctx.err(`Bundling ${refs.join(", ")}.`);
    const bundle = await bundleRepository(git, worktree, refs);
    try {
      await tunnel.open();
      ctx.err(`Copying it to ${destination}.`);
      const pushed = await pushRepository(
        {
          exec: (command, timeoutMs) => tunnel.exec(command, timeoutMs),
          upload: (path, remotePath, timeoutMs) => {
            if (!tunnel.upload)
              throw new OrcaError("CONFIG_INVALID", "This connection cannot copy files to the server.");
            return tunnel.upload(path, remotePath, timeoutMs);
          },
        },
        bundle,
        { name, refs },
      );
      if (ctx.flags.json) ctx.out(JSON.stringify(pushed));
      else {
        ctx.out(`Pushed ${refs.join(", ")} to ${pushed.hub}.`);
        ctx.out(
          pushed.checkoutState.kind === "kept"
            ? `The checkout ${pushed.checkout} was left as it was: ${pushed.checkoutState.reason}.`
            : `Checkout: ${pushed.checkout} (${pushed.checkoutState.kind}).`,
        );
        const snippet = workspaceSnippet(pushed);
        if (snippet) {
          ctx.out("To work there, set this in the server's orca.config.yaml, then apply it:");
          ctx.out(snippet);
        } else ctx.err(`There is no checkout of ${pushed.hub} to work in yet. Fix the above, then push again.`);
      }
      return workspaceSnippet(pushed) ? 0 : 1;
    } finally {
      rmSync(bundle.dir, { recursive: true, force: true });
      await tunnel.close();
    }
  } catch (error) {
    if (error instanceof RepositoryRefused) throw new OrcaError("CONFIG_INVALID", error.message);
    throw error;
  }
}

/**
 * `orca remote agent install|status|login [user@]host --agent ID` (#1236): on a server `remote
 * add` set up, over its pinned ssh only. `install` carries the agent's pinned packages from
 * this computer (downloaded once, then from the cache) and prints the server config that runs
 * it; `login` runs the agent's own sign-in there and prints its link and code to approve in a
 * browser here; `status` lists each agent's installed versions and whether it is signed in.
 * Claude Code is never signed in by ORCA: the person runs its own sign-in on the server, with
 * the command `install` and `status` print.
 */
async function agentCommand(ctx: CommandContext, action: string, destination: string, deps: RemoteDeps) {
  if (!tailnetEnabled(deps.tailnet?.features))
    throw new OrcaError("CONFIG_INVALID", "orca remote agent is not available in this build.");
  if (!["install", "status", "login"].includes(action))
    throw new OrcaError("CONFIG_INVALID", "usage: orca remote agent install|status|login [user@]host [--agent ID]");
  const scripts = deps.scripts ?? setupScripts();
  if (!scripts) throw new OrcaError("CONFIG_INVALID", "orca remote agent runs from a source checkout.");
  // `--agent` may be given more than once for other commands; here it names exactly one.
  const agentValue = ctx.flags.agent;
  const agentFlag = Array.isArray(agentValue) ? (agentValue.length === 1 ? agentValue[0] : undefined) : agentValue;
  if (action !== "status" && typeof agentFlag !== "string")
    throw new OrcaError("CONFIG_INVALID", `--agent names the agent: ${Object.keys(HOST_AGENTS).join(" or ")}.`);
  try {
    const agent = action === "status" ? undefined : hostAgent(agentFlag as string);
    // Refused before any profile, connection or prompt: ORCA offers no sign-in for it.
    if (agent && action === "login" && agent.signIn === "yourself")
      throw new HostAgentRefused(
        `ORCA does not sign ${agent.name} in. Sign it in on ${destination} yourself: orca remote agent status ${destination} names the command to run there.`,
      );
    const program = hostAgentsProgram(scripts);
    const { base } = await profileFor(ctx, destination, deps);
    // Only through a host key `remote add` already pinned, as for push-repo.
    const make = deps.tunnel ?? ((options: ConstructorParameters<typeof SshTunnel>[0]) => new SshTunnel(options));
    const tunnel = make({ ...base, pinnedOnly: true });
    const transport = {
      exec: (command: readonly string[], timeoutMs?: number, input?: string) => tunnel.exec(command, timeoutMs, input),
      upload: (path: string, remotePath: string, timeoutMs?: number) => {
        if (!tunnel.upload) throw new OrcaError("CONFIG_INVALID", "This connection cannot copy files to the server.");
        return tunnel.upload(path, remotePath, timeoutMs);
      },
    };
    try {
      if (agent && action === "install") {
        ctx.err(`Getting ${agent.name} ${agent.version} ready on this computer.`);
        const prepared = await prepareHostAgent(agent.id, {
          fetch: deps.courierFetch ?? httpsFetch,
          cacheDir: join(deps.cacheDir ?? cacheDir(), "agents"),
        });
        try {
          await tunnel.open();
          ctx.err(`Copying it to ${destination}.`);
          const installed = await installHostAgent(transport, prepared, program);
          if (ctx.flags.json) ctx.out(JSON.stringify(installed));
          else {
            ctx.out(
              installed.result === "ok"
                ? `${agent.name} ${installed.version} was already installed at ${installed.dir}.`
                : `Installed ${agent.name} ${installed.version} at ${installed.dir}.`,
            );
            ctx.out("To run it there, add this to the server's orca.config.yaml, then apply it:");
            ctx.out(hostAgentSettings(installed));
            const yourself = hostAgentSignInCommand(installed);
            if (agent.signIn === "yourself")
              ctx.out(
                `Then sign it in yourself on ${destination} (ORCA does not take part)${
                  yourself ? `, by running there: ${yourself}` : ": orca remote agent status names the command."
                }`,
              );
            else ctx.out(`Then sign it in: orca remote agent login ${destination} --agent ${agent.id}`);
          }
          return 0;
        } finally {
          rmSync(prepared.dir, { recursive: true, force: true });
        }
      }
      await tunnel.open();
      if (agent) {
        if (!tunnel.execStreaming)
          throw new OrcaError("CONFIG_INVALID", "This connection cannot follow a sign-in on the server.");
        const stream = tunnel.execStreaming.bind(tunnel);
        ctx.err(`Starting ${agent.name}'s sign-in on ${destination}.`);
        await signInHostAgent(stream, agent.id, program, (prompt) => {
          if (prompt.url && prompt.code)
            ctx.err(`Open ${prompt.url} in your browser and enter the code ${prompt.code}, then wait here.`);
          else if (prompt.url) ctx.err(`Open ${prompt.url} in your browser to sign in, then wait here.`);
          else ctx.err(`Enter the code ${prompt.code} where ${agent.name} asks for it, then wait here.`);
        });
        ctx.out(`${agent.name} is signed in on ${destination}.`);
        return 0;
      }
      const status = await hostAgentStatus(transport, program);
      if (ctx.flags.json) ctx.out(JSON.stringify(status));
      else
        for (const item of status)
          ctx.out(
            `${HOST_AGENTS[item.agent]!.name}: ${
              item.versions.length ? `installed ${item.versions.join(", ")}` : "not installed"
            }; signed in: ${item.signedIn}${item.problem ? `. Not usable: ${item.problem}` : ""}${
              item.signInCommand ? `. Sign it in yourself by running this on the server: ${item.signInCommand}` : ""
            }`,
          );
      return 0;
    } finally {
      await tunnel.close();
    }
  } catch (error) {
    if (error instanceof HostAgentRefused) throw new OrcaError("CONFIG_INVALID", error.message);
    throw error;
  }
}

/** Where the CLI caches what it carries to servers (#1234). */
function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "orca", "courier");
}

/** The machine `--tailnet` names, from this computer's own Tailscale client (#1226). */
async function tailnetPeer(
  ctx: CommandContext,
  destination: string,
  options: ReadTailnetOptions | undefined,
): Promise<TailnetPeer> {
  const read = await readTailnet(options);
  if (read.state !== "running")
    throw new OrcaError("CONFIG_INVALID", "Tailscale is not installed, running and signed in on this computer.");
  const name = destination.slice(destination.lastIndexOf("@") + 1);
  const peer = findTailnetPeer(read.snapshot, name);
  if (!peer) throw new OrcaError("CONFIG_INVALID", `No single machine named ${name} on your tailnet.`);
  if (!peer.hostSupported)
    throw new OrcaError(
      "CONFIG_INVALID",
      `${peer.dnsName} is not a Linux or Windows machine; ORCA servers run on those.`,
    );
  if (!peer.online) throw new OrcaError("CONFIG_INVALID", `${peer.dnsName} is offline on your tailnet.`);
  if (peer.sharedIn)
    ctx.err(`${peer.dnsName} is shared from another tailnet: check its host key by hand before you confirm.`);
  if (!peer.tailscaleSsh)
    ctx.err(
      peer.os.toLowerCase() === "windows"
        ? // Tailscale SSH has no Windows server: Windows' own OpenSSH Server it is (#1238).
          `${peer.dnsName} is a Windows machine, so its host key is not advertised: check it by hand before you confirm. It needs the Windows OpenSSH Server; if that is not on yet, run the line orca remote windows-ssh prints on it, in an administrator PowerShell.`
        : `${peer.dnsName} does not run Tailscale SSH, so its host key is not advertised and it needs its own sshd. To log in with Tailscale SSH instead, run this on it: sudo tailscale set --ssh`,
    );
  return peer;
}

/**
 * `orca remote windows-ssh` (#1238): the line that turns a Windows machine's OpenSSH Server on,
 * which runs the download only if it matches this checkout's own copy.
 */
function windowsSshCommand(ctx: CommandContext, deps: { scripts?: string; version?: string }): number {
  const scripts = deps.scripts ?? setupScripts();
  if (!scripts)
    throw new OrcaError(
      "CONFIG_INVALID",
      "orca remote windows-ssh runs from a source checkout; in the desktop app, pick the Windows machine in Add a machine.",
    );
  const bootstrap = windowsSshBootstrap(scripts, deps.version ?? ORCA_VERSION);
  if (ctx.flags.json) {
    ctx.out(JSON.stringify(bootstrap));
    return 0;
  }
  ctx.err(
    "Run this once on the Windows machine, in an administrator PowerShell. It downloads orca-windows-ssh.ps1 for this version and runs it only if its SHA-256 is that of this ORCA's own copy:",
  );
  ctx.err(`  ${bootstrap.sha256}`);
  ctx.err(
    "If the OpenSSH Server is already on, it changes nothing. Otherwise it lists each change (install the Windows feature, allow SSH only over the Tailscale adapter, start sshd automatically) and asks before making any. Windows Update keeps the OpenSSH Server updated; ORCA does not bundle it.",
  );
  ctx.out(bootstrap.command);
  return 0;
}

function finish(
  ctx: CommandContext,
  destination: string,
  outcome: SetupOutcome | InspectOutcome,
  os: ServerOs = "linux",
): number {
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
          `${destination} is a managed ORCA server (v${outcome.version}). To connect and sign in, add an SSH profile for it in the desktop app with server command ${launcherCommand(outcome.root, os)}, or use Add a machine there.`,
        );
      if (!ctx.flags.json && outcome.startsAt === "logon")
        ctx.out(
          `Its daemon starts when ${outcome.account} logs on, not at boot: that account may not register a task that starts at boot. To start it at boot, run this again while ${outcome.account} is an administrator there (an administrator's SSH sessions on Windows are elevated).`,
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
