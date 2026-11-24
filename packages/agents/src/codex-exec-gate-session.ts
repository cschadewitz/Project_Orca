/**
 * The opt-in route for ORCA's gate in Codex's executor path (#1026): `codexExecGate:
 * experimental` on an agent. On this route Codex is to run every command, patch and file
 * request through ORCA's gate (`codex-exec-gate.ts`) into an executor in namespaces ORCA makes
 * and checks (`codex-exec-isolation.ts`), with nothing to fall back to.
 *
 * **This step wires none of that into a session, and refuses every session that asks for the
 * route.** It decides, before the agent starts, whether a session could take the route at all,
 * and names every reason it cannot. The reasons, in the order they are found:
 *
 * - **The layout.** ORCA's config directory, its store, the permission sidecar inside it and a
 *   config file loaded from elsewhere (`--config`) are all outside every directory the agent
 *   may write (the workspace and any additional directory), and no such directory is inside
 *   them. Each is compared by its resolved path, links followed. The default layout, where the
 *   config directory is the workspace, is refused, with the setting that fixes it. A single
 *   file in a directory a command can write cannot be kept from that command: it can be
 *   replaced by a rename, or the directory above it moved aside. So the protection is the
 *   whole directory, kept apart.
 * - **The host.** Linux on x64 (the closed executor's filter is x64 only), a bubblewrap and an
 *   `unshare` the system installed (root's, not writable by anyone else, not set-user-ID), and
 *   no host-wide Codex configuration: `/etc/codex` holds files that sit above or below the
 *   settings ORCA would give Codex (a managed config that overrides them, requirements that
 *   constrain them, a system config). A host with any of it is administrator-configured, which
 *   is a separate configuration with its own evidence, not this one.
 * - **The closed executor.** ORCA makes it once with a stand-in program and checks it as the
 *   gate would (`spawnIsolatedCodexExecServer` with `closed`), then reads
 *   `codexExecProofShortfalls`. Any entry is a reason. That list is never empty today: a named
 *   pipe is still reached, what a command leaves in its writable directories stays, and the
 *   filter in place is not read back.
 * - **The wiring**, which is not there yet: ORCA does not start Codex on this route.
 *
 * So the answer is always a refusal, with the reasons. Nothing falls back to the hook or to a
 * session without the gate: an agent that asks for this route runs on it or not at all.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { OrcaError } from "@orca/core";
import {
  codexExecMasks,
  codexExecProofShortfalls,
  CodexExecIsolationError,
  spawnIsolatedCodexExecServer,
  systemBubblewrap,
  systemUnshare,
  type CodexExecIsolatedSpawn,
  type CodexExecIsolationProof,
} from "./codex-exec-isolation.js";
import type { ProtectedPaths } from "./permissions.js";

type GateSetting = "off" | "experimental" | undefined;

/** Whether the agent asks for the gate route. */
export function codexExecGateRequested(agent: { codexExecGate?: GateSetting }): boolean {
  return agent.codexExecGate === "experimental";
}

/**
 * The refusal for `codexExecGate` wherever ORCA would open the agent other than through its
 * session factory (`openAcpSession` called directly), or on a remote daemon (delegation).
 */
export function codexExecGateRefused(
  agent: { id: string; codexExecGate?: GateSetting },
  where: "outside-factory" | "remote-delegation",
): OrcaError | undefined {
  if (!codexExecGateRequested(agent)) return undefined;
  const why =
    where === "remote-delegation"
      ? "it is an orca-daemon agent, and the gate route applies to agents ORCA starts itself"
      : "ORCA takes this route only in sessions its daemon or a workflow run opens, not in this one-off session";
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agent.id} has codexExecGate: experimental, but ${why}. ORCA refuses the session rather than run ` +
      `Codex without its gate; remove codexExecGate to run the agent without it.`,
    { agentId: agent.id },
  );
}

/** Where ORCA's own files are, and the directories the agent may write. */
export interface CodexExecGateLayout {
  configDir: string;
  /** Absolute, or relative to `configDir`. */
  storeDir: string;
  /** The config file that was loaded, when `--config` put it outside `configDir`. */
  configFile?: string | undefined;
  /** The session's workspace. */
  workspace: string;
  /** More directories the agent may write. */
  additionalDirectories?: readonly string[] | undefined;
}

/** `path` is `root` or inside it. Both resolved. */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * What in the layout keeps a session off the gate route: one sentence per conflict, empty
 * when there is none. Every path is compared resolved, links followed; a path that does not
 * resolve is a reason too, since what it would come to name is not known.
 */
export function codexExecGateLayoutProblems(
  layout: CodexExecGateLayout,
  real: (path: string) => string = (path) => realpathSync.native(path),
): string[] {
  const problems: string[] = [];
  const resolved = (what: string, path: string): string | undefined => {
    try {
      return real(resolve(path));
    } catch (error) {
      problems.push(`${what} ${path} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? "error"})`);
      return undefined;
    }
  };
  const configDir = resolve(layout.configDir);
  const orca: { what: string; path: string | undefined }[] = [
    { what: "ORCA's config directory", path: resolved("ORCA's config directory", configDir) },
    { what: "ORCA's store", path: resolved("ORCA's store", resolve(configDir, layout.storeDir)) },
  ];
  if (layout.configFile !== undefined) {
    const dir = dirname(resolve(layout.configFile));
    orca.push({
      what: "the directory of the config file ORCA loaded",
      path: resolved("the config file's directory", dir),
    });
  }
  const agentRoots = [
    { what: "the workspace", path: resolved("the workspace", layout.workspace) },
    ...(layout.additionalDirectories ?? []).map((dir) => ({
      what: "the additional directory",
      path: resolved("the additional directory", dir),
    })),
  ];
  for (const own of orca) {
    if (own.path === undefined) continue;
    for (const root of agentRoots) {
      if (root.path === undefined) continue;
      if (root.path === own.path)
        problems.push(
          `${root.what} ${root.path} is ${own.what}: on this route ORCA's files have to be outside every directory ` +
            `the agent may write. Set \`workspace:\` in the config to a directory outside ${own.path}`,
        );
      else if (within(own.path, root.path))
        problems.push(`${own.what} ${own.path} is inside ${root.what} ${root.path}, which the agent may write`);
      else if (within(root.path, own.path))
        problems.push(`${root.what} ${root.path} is inside ${own.what} ${own.path}`);
    }
  }
  return problems;
}

/** The host-wide Codex configuration, any of which keeps a host off this route. */
export const CODEX_SYSTEM_CONFIG_DIR = "/etc/codex";

/** What ORCA reads of the host for this route. */
export interface CodexExecGateHost {
  platform: NodeJS.Platform;
  arch: string;
  bubblewrap: string | undefined;
  unshare: string | undefined;
  /** What `/etc/codex` holds, by name; undefined when it is not there. */
  systemCodexConfig: string[] | undefined;
}

/** The host as it is, read now. */
export function codexExecGateHost(): CodexExecGateHost {
  let systemCodexConfig: string[] | undefined;
  try {
    // A link or a file there is as much a configuration as a directory of files.
    lstatSync(CODEX_SYSTEM_CONFIG_DIR);
    try {
      systemCodexConfig = statSync(CODEX_SYSTEM_CONFIG_DIR).isDirectory()
        ? readdirSync(CODEX_SYSTEM_CONFIG_DIR)
        : [CODEX_SYSTEM_CONFIG_DIR];
    } catch {
      systemCodexConfig = [CODEX_SYSTEM_CONFIG_DIR];
    }
  } catch (error) {
    systemCodexConfig = (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : [CODEX_SYSTEM_CONFIG_DIR];
  }
  return {
    platform: process.platform,
    arch: process.arch,
    bubblewrap: systemBubblewrap(),
    unshare: systemUnshare(),
    systemCodexConfig,
  };
}

/** What in the host keeps a session off the gate route: one sentence per reason. */
export function codexExecGateHostProblems(host: CodexExecGateHost): string[] {
  const problems: string[] = [];
  if (host.platform !== "linux" || host.arch !== "x64")
    problems.push(`the route runs on Linux x64 only, and this is ${host.platform} ${host.arch}`);
  if (host.bubblewrap === undefined)
    problems.push("the system has no bubblewrap of its own (root's, at /usr/bin/bwrap or /bin/bwrap, not set-user-ID)");
  if (host.unshare === undefined)
    problems.push("the system has no unshare of its own (root's, at /usr/bin/unshare or /bin/unshare)");
  if (host.systemCodexConfig !== undefined)
    problems.push(
      `${CODEX_SYSTEM_CONFIG_DIR} holds host-wide Codex configuration (${host.systemCodexConfig.length === 0 ? "an empty directory" : host.systemCodexConfig.join(", ")}), ` +
        `which could override or add to the settings ORCA gives Codex; an administrator-configured host is not this configuration`,
    );
  return problems;
}

/** How the route's admission is checked. Every field but the first three is for tests. */
export interface CodexExecGateAdmission {
  agentId: string;
  layout: CodexExecGateLayout;
  /** ORCA's protected paths, as every session lists them (`orcaProtectedPaths`). */
  protectedPaths: ProtectedPaths;
  /** The host as read; `codexExecGateHost()` unless given. */
  host?: CodexExecGateHost | undefined;
  /** What ORCA's runtime needs in its environment to run as Node (the desktop app's Electron). */
  runtimeEnv?: Readonly<Record<string, string>> | undefined;
  /** What makes the closed executor; `spawnIsolatedCodexExecServer` unless given. */
  isolate?: ((spec: CodexExecIsolatedSpawn) => ReturnType<typeof spawnIsolatedCodexExecServer>) | undefined;
  /** How resolved paths are found; `realpathSync.native` unless given. */
  real?: ((path: string) => string) | undefined;
}

/**
 * The closed executor, made once with a stand-in for the executor and checked as the gate
 * would check it: the proof, or the reason it was refused.
 */
async function tryClosedExecutor(
  admission: CodexExecGateAdmission,
  host: CodexExecGateHost,
): Promise<{ proof: CodexExecIsolationProof } | { refused: string }> {
  const workspace = resolve(admission.layout.workspace);
  const writable = [workspace, ...(admission.layout.additionalDirectories ?? []).map((dir) => resolve(dir))];
  let backend: ReturnType<typeof spawnIsolatedCodexExecServer> | undefined;
  try {
    backend = (admission.isolate ?? spawnIsolatedCodexExecServer)({
      // A program every such host has, which waits on its input and does nothing else.
      program: "/bin/cat",
      env: { PATH: "/usr/bin:/bin" },
      cwd: workspace,
      masks: codexExecMasks(admission.protectedPaths),
      closed: { writable },
      bubblewrap: host.bubblewrap,
      unshare: host.unshare,
      runtimeEnv: admission.runtimeEnv,
      stopGraceMs: 1000,
    });
    return { proof: await backend.isolated };
  } catch (error) {
    return {
      refused: error instanceof CodexExecIsolationError || error instanceof Error ? error.message : String(error),
    };
  } finally {
    await backend?.stop().catch(() => undefined);
  }
}

/**
 * Decide whether a session may take the gate route, before its agent starts. It never may
 * yet: this throws, with every reason found, in the order the module's notes give.
 */
export async function admitCodexExecGateSession(admission: CodexExecGateAdmission): Promise<never> {
  const reasons = codexExecGateLayoutProblems(admission.layout, admission.real);
  const host = admission.host ?? codexExecGateHost();
  reasons.push(...codexExecGateHostProblems(host));
  // The closed executor is made only on a host and layout that could hold it.
  if (reasons.length === 0) {
    const tried = await tryClosedExecutor(admission, host);
    if ("refused" in tried) reasons.push(`the closed executor could not be made and shown: ${tried.refused}`);
    else reasons.push(...codexExecProofShortfalls(tried.proof));
  }
  reasons.push("ORCA does not start Codex on this route yet (#1026)");
  throw new OrcaError(
    "NOT_SUPPORTED",
    `agent ${admission.agentId} has codexExecGate: experimental, and ORCA refuses the session: ` +
      reasons.map((reason, i) => `(${i + 1}) ${reason}`).join("; ") +
      `. Nothing falls back to running Codex without the gate; remove codexExecGate to run the agent without it.`,
    { agentId: admission.agentId, reasons },
  );
}
