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
 * - **The closed executor**, as it stands: what it still cannot close or show
 *   (`CODEX_EXEC_NOT_CLOSED`: a named pipe is still reached, what a command leaves in its
 *   writable directories stays, and the filter in place is not read back). These are stated, not
 *   probed: admission makes no executor. Whether a host lets ORCA make the closed executor at
 *   all is a separate, explicit probe (`tools/codex-exec-host-probe.mjs`), not part of a
 *   session's admission.
 * - **The wiring**, which is not there yet: ORCA does not start Codex on this route.
 * So the answer is always a refusal, with the reasons. Nothing falls back to the hook or to a
 * session without the gate: an agent that asks for this route runs on it or not at all. Where
 * ORCA launches an ACP agent (`openAcpSession`), the route is refused outright as well, with
 * session metadata or without: metadata is not an admission, and nothing admits yet.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { OrcaError } from "@orca/core";
import { CODEX_EXEC_NOT_CLOSED, systemBubblewrap, systemUnshare } from "./codex-exec-isolation.js";

type GateSetting = "off" | "experimental" | undefined;

/** Whether the agent asks for the gate route. */
export function codexExecGateRequested(agent: { codexExecGate?: GateSetting }): boolean {
  return agent.codexExecGate === "experimental";
}

/**
 * The refusal for `codexExecGate` where ORCA launches an ACP agent (`openAcpSession`), whatever
 * session metadata it is given, and on a remote daemon (delegation). The session factory refuses
 * first, with every reason; this is the boundary under it, so that nothing reaches a launch.
 */
export function codexExecGateRefused(
  agent: { id: string; codexExecGate?: GateSetting },
  where: "launch" | "remote-delegation",
): OrcaError | undefined {
  if (!codexExecGateRequested(agent)) return undefined;
  const why =
    where === "remote-delegation"
      ? "it is an orca-daemon agent, and the gate route applies to agents ORCA starts itself"
      : "ORCA does not launch Codex on this route yet (#1026); the session factory names every reason";
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

/**
 * `path` is `root` or inside it, component by component (`/a/work2` is not inside `/a/work`, and
 * `/a/..x` is inside `/a`). Both resolved.
 */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  if (rel === "") return true;
  return !isAbsolute(rel) && rel.split(sep)[0] !== "..";
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
    // Both where the file is named and where it leads: a link kept apart can lead into a
    // directory the agent may write, and a file kept apart can sit in one by a link above it.
    const named = resolve(layout.configFile);
    const linkDir = resolved("the config file's directory", dirname(named));
    const file = resolved("the config file ORCA loaded", named);
    orca.push({ what: "the directory of the config file ORCA loaded", path: linkDir });
    const targetDir = file === undefined ? undefined : dirname(file);
    if (targetDir !== undefined && targetDir !== linkDir)
      orca.push({ what: "the directory the config file ORCA loaded leads to", path: targetDir });
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

/** How the route's admission is checked. Every field but the first two is for tests. */
export interface CodexExecGateAdmission {
  agentId: string;
  layout: CodexExecGateLayout;
  /** The host as read; `codexExecGateHost()` unless given. */
  host?: CodexExecGateHost | undefined;
  /** How resolved paths are found; `realpathSync.native` unless given. */
  real?: ((path: string) => string) | undefined;
}

/**
 * Decide whether a session may take the gate route, before its agent starts. It never may
 * yet: this throws, with every reason found, in the order the module's notes give. It starts
 * nothing: no executor, no namespace, no agent.
 */
export function admitCodexExecGateSession(admission: CodexExecGateAdmission): never {
  const reasons = codexExecGateLayoutProblems(admission.layout, admission.real);
  reasons.push(...codexExecGateHostProblems(admission.host ?? codexExecGateHost()));
  reasons.push(...CODEX_EXEC_NOT_CLOSED);
  reasons.push("ORCA does not start Codex on this route yet (#1026)");
  throw new OrcaError(
    "NOT_SUPPORTED",
    `agent ${admission.agentId} has codexExecGate: experimental, and ORCA refuses the session: ` +
      reasons.map((reason, i) => `(${i + 1}) ${reason}`).join("; ") +
      `. Nothing falls back to running Codex without the gate; remove codexExecGate to run the agent without it.`,
    { agentId: admission.agentId, reasons },
  );
}
