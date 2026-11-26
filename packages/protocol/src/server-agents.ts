/**
 * Install and sign in agents on a managed server from the client (#1236), Node-only like
 * `server-courier`: the server needs no npm, no registry access and no terminal.
 *
 * This computer downloads the pinned npm tarballs for the agent (`HOST_AGENT_LOCK`, each
 * checked against npm's sha512 integrity, and kept in a cache here so a second server needs no
 * download), carries them over the profile's pinned ssh into a courier directory, and
 * `tools/deploy/orca-host-agents.py`, sent as `python3 -` like the setup, checks them again and
 * unpacks them under the server root. No package's install script runs anywhere.
 *
 * Sign-in is the agent's own, run on the server on the agent's own profile there: with no
 * terminal it prints a link and a one-time code, which this module picks out of its output and
 * hands to the caller to show. The person approves in their own browser; the credential is
 * written by the agent, on the server. No key or token goes from this computer to the server.
 *
 * Behind the incubating `tailnet-hosts` flag: nothing calls it while the flag is off.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_AGENT_LOCK, type HostAgentPackage } from "./host-agents-lock.js";
import type { RemoteCommand } from "./remote-access.js";
import {
  CourierRefused,
  dropCourier,
  fileSha256,
  pushCourier,
  type CourierFetch,
  type CourierFile,
  type CourierPackage,
  type CourierTransport,
} from "./server-courier.js";

/** The program the server runs, as shipped: `server-setup/` in a packaged app, `tools/deploy/` in a checkout. */
export const HOST_AGENTS_SCRIPT = "orca-host-agents.py";
/** The reviewed lock it checks every carried package against, shipped beside it. */
export const HOST_AGENTS_LOCK_FILE = "host-agents.lock.json";

/** What this ORCA can put on a server, by agent id. */
export interface HostAgent {
  id: string;
  name: string;
  version: string;
  /** The origins its sign-in link may be on: any other link it prints is not shown. */
  loginOrigins: readonly string[];
}

export const HOST_AGENTS: Readonly<Record<string, HostAgent>> = {
  codex: {
    id: "codex",
    name: "Codex",
    version: HOST_AGENT_LOCK.codex!.version,
    loginOrigins: ["https://auth.openai.com"],
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot CLI",
    version: HOST_AGENT_LOCK.copilot!.version,
    loginOrigins: ["https://github.com"],
  },
};

/** Thrown when an agent cannot be installed or signed in; the server says what changed, if anything. */
export class HostAgentRefused extends Error {
  override readonly name = "HostAgentRefused";
}

/** The agent for `id`, or a refusal naming the ones there are. */
export function hostAgent(id: string): HostAgent {
  const agent = Object.hasOwn(HOST_AGENTS, id) ? HOST_AGENTS[id] : undefined;
  if (!agent) throw new HostAgentRefused(`No agent called ${id}: choose ${Object.keys(HOST_AGENTS).join(" or ")}.`);
  return agent;
}

/**
 * `orca-host-agents.py`, from the directory the setup's scripts are in, with the lock shipped
 * beside it embedded ahead of it: the server checks what was carried against this lock, never
 * against the carried list alone. `testing` replaces the lock and lowers the entry limit.
 */
export function hostAgentsProgram(dir: string, testing?: { lock?: string; entryLimit?: number }): string {
  const lock = testing?.lock ?? readFileSync(join(dir, HOST_AGENTS_LOCK_FILE), "utf8");
  const limit = testing?.entryLimit === undefined ? "" : `ENTRY_LIMIT = ${Math.trunc(testing.entryLimit)}\n`;
  return `EMBEDDED_LOCK = "${Buffer.from(lock).toString("base64")}"\n${limit}${readFileSync(join(dir, HOST_AGENTS_SCRIPT), "utf8")}`;
}

const TARBALL_LIMIT = 1024 ** 3;

function integrityOf(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(`sha512-${hash.digest("base64")}`));
  });
}

/** An agent ready to carry: the courier package, and a directory the caller removes. */
export interface PreparedHostAgent {
  agent: HostAgent;
  dir: string;
  pkg: CourierPackage;
}

export interface PrepareHostAgentOptions {
  fetch: CourierFetch;
  /** Where downloaded tarballs are kept, by integrity, for the next server. */
  cacheDir: string;
  /** Test seam: the packages instead of the pinned ones. */
  packages?: readonly HostAgentPackage[];
}

/**
 * Every pinned tarball for the agent, from the cache here or downloaded into it, each checked
 * against its sha512 integrity; then `agent.json`, the list the server checks them against.
 */
export async function prepareHostAgent(id: string, options: PrepareHostAgentOptions): Promise<PreparedHostAgent> {
  const agent = hostAgent(id);
  const packages = options.packages ?? HOST_AGENT_LOCK[agent.id]?.packages ?? [];
  if (!packages.length) throw new HostAgentRefused(`No packages are pinned for ${agent.name}.`);
  mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmpdir(), "orca-host-agent-"));
  try {
    const files: CourierFile[] = [];
    const listed: { path: string; file: string; integrity: string }[] = [];
    for (const [index, entry] of packages.entries()) {
      const key = Buffer.from(entry.integrity.slice("sha512-".length), "base64").toString("hex");
      const cached = join(options.cacheDir, `${key}.tgz`);
      if (!existsSync(cached) || (await integrityOf(cached)) !== entry.integrity) {
        const bytes = await options.fetch(entry.tarball, TARBALL_LIMIT);
        const got = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        if (got !== entry.integrity)
          throw new HostAgentRefused(`${entry.path} ${entry.version} does not match its pinned integrity.`);
        const partial = `${cached}.${process.pid}.partial`;
        writeFileSync(partial, bytes, { mode: 0o600 });
        renameSync(partial, cached);
      }
      const name = `${String(index).padStart(3, "0")}.tgz`;
      files.push({ name, path: cached, sha256: await fileSha256(cached), size: statSync(cached).size });
      listed.push({ path: entry.path, file: name, integrity: entry.integrity });
    }
    const manifest = join(dir, "agent.json");
    writeFileSync(
      manifest,
      JSON.stringify({ agent: agent.id, version: agent.version, packages: listed }, null, 2) + "\n",
    );
    files.push({
      name: "agent.json",
      path: manifest,
      sha256: await fileSha256(manifest),
      size: statSync(manifest).size,
    });
    return { agent, dir, pkg: { version: agent.version, files } };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** What the server's program needs: the courier's commands, and one run with `python3 -` on stdin. */
export interface HostAgentTransport extends CourierTransport {
  exec(command: readonly string[], timeoutMs?: number, input?: string): Promise<{ code: number; stdout: string }>;
}

/** Unpacking a large agent on a small host. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 3 * 60_000;
const LINE = /^orca-agents: (\{.*\})$/;

function records(stdout: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (value && typeof value === "object" && !Array.isArray(value)) found.push(value as Record<string, unknown>);
    } catch {
      // Not ours.
    }
  }
  return found;
}

function refusal(found: readonly Record<string, unknown>[]): string | undefined {
  const refused = found.find((record) => record.result === "refused");
  return refused
    ? (typeof refused.detail === "string" ? refused.detail : "The server refused.").slice(0, 2000)
    : undefined;
}

/** Where an agent is on the server once installed. */
export interface HostAgentInstalled {
  agent: string;
  version: string;
  /** `changed`: installed now; `ok`: exactly this install was already there. */
  result: "changed" | "ok";
  dir: string;
  /** The agent's own profile on the server (`CODEX_HOME`, `COPILOT_HOME`). */
  home: string;
  binary: string;
}

const SERVER_PATH = /^\/[A-Za-z0-9._/@-]{1,1000}$/;

/** Carry a prepared agent to the server and install it there. */
export async function installHostAgent(
  transport: HostAgentTransport,
  prepared: PreparedHostAgent,
  program: string,
): Promise<HostAgentInstalled> {
  let scratch;
  try {
    scratch = await pushCourier(transport, prepared.pkg);
  } catch (error) {
    if (error instanceof CourierRefused) throw new HostAgentRefused(`${error.message}. Nothing was installed.`);
    throw error;
  }
  try {
    const ran = await transport.exec(
      ["python3", "-", "install", "--scratch", scratch.path],
      INSTALL_TIMEOUT_MS,
      program,
    );
    const found = records(ran.stdout);
    const refused = refusal(found);
    if (refused) throw new HostAgentRefused(refused);
    const done = found.find((record) => record.step === "install");
    if (ran.code !== 0 || !done || (done.result !== "changed" && done.result !== "ok"))
      throw new HostAgentRefused(
        ran.code === 127 ? "The server has no python3." : `The server could not install ${prepared.agent.name}.`,
      );
    const { dir, home, binary } = done;
    if (
      done.agent !== prepared.agent.id ||
      done.version !== prepared.agent.version ||
      ![dir, home, binary].every((path) => typeof path === "string" && SERVER_PATH.test(path))
    )
      throw new HostAgentRefused("The server reported an install this computer did not ask for.");
    return {
      agent: prepared.agent.id,
      version: prepared.agent.version,
      result: done.result,
      dir: dir as string,
      home: home as string,
      binary: binary as string,
    };
  } finally {
    await dropCourier(transport, scratch);
  }
}

/** One agent's state on the server. */
export interface HostAgentStatus {
  agent: string;
  /** The pinned version, when it is installed exactly as recorded. */
  versions: string[];
  /** Other versions found there, which this ORCA does not run. */
  others: string[];
  signedIn: "yes" | "no" | "unknown";
  /** Why the pinned version there cannot be used (changed since install, say). */
  problem?: string;
}

/** Every known agent's state on the server, from one run of the program there. */
export async function hostAgentStatus(transport: HostAgentTransport, program: string): Promise<HostAgentStatus[]> {
  const ran = await transport.exec(["python3", "-", "status"], STATUS_TIMEOUT_MS, program);
  const found = records(ran.stdout);
  const refused = refusal(found);
  if (refused) throw new HostAgentRefused(refused);
  const list = found.find((record) => Array.isArray(record.status))?.status as unknown[] | undefined;
  if (ran.code !== 0 || !list) throw new HostAgentRefused("The server could not report its agents.");
  return list.flatMap((item): HostAgentStatus[] => {
    if (!item || typeof item !== "object") return [];
    const { agent, versions, others, signedIn, problem } = item as Record<string, unknown>;
    if (typeof agent !== "string" || !Object.hasOwn(HOST_AGENTS, agent)) return [];
    const list = (value: unknown) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) : [];
    return [
      {
        agent,
        versions: list(versions),
        others: list(others),
        signedIn: signedIn === "yes" || signedIn === "no" ? signedIn : "unknown",
        ...(typeof problem === "string" ? { problem: problem.slice(0, 2000) } : {}),
      },
    ];
  });
}

/** What the person needs to approve a sign-in: the link to open, and the code to enter there. */
export interface HostAgentLoginPrompt {
  url?: string;
  code?: string;
}

/** Terminal escapes: CSI sequences and OSC strings (which cannot hold another escape). */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]{0,64}[ -/]{0,8}[@-~]|\x1b\][^\x07\x1b]{0,2048}\x07/g;
/** The most of one line that is looked at: a sign-in prompt is short. */
const PROMPT_LINE_LIMIT = 4096;
/** A device code as Codex and GitHub print them: `ABCD-EFGH`, `ABCD-EFGHI`. */
const CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/;

/**
 * The sign-in link and code in one line of an agent's output, if any. Only an https link with
 * no credentials on one of `origins` is taken: an agent's output is shown to no one, and a link
 * elsewhere is never offered.
 */
export function loginPrompt(line: string, origins: readonly string[]): HostAgentLoginPrompt {
  const text = line.slice(0, PROMPT_LINE_LIMIT).replace(ANSI, "");
  const prompt: HostAgentLoginPrompt = {};
  for (const candidate of text.match(/https:\/\/[^\s"'<>]{1,2000}/g) ?? []) {
    try {
      const url = new URL(candidate.replace(/[.,;:)]+$/, ""));
      if (url.protocol === "https:" && !url.username && !url.password && origins.includes(url.origin)) {
        prompt.url = url.href;
        break;
      }
    } catch {
      // Not a link.
    }
  }
  const code = CODE.exec(text);
  if (code) prompt.code = code[1]!;
  return prompt;
}

/** Run a command on the server, following its lines, with `input` on stdin (`SshTunnel.execStreaming`). */
export type HostAgentStream = (
  command: readonly string[],
  onLine: (stream: "stdout" | "stderr", line: string) => void,
  input?: string,
) => RemoteCommand;

/** How long the person has to approve a sign-in in their browser. */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;

/**
 * Sign the agent in on the server with its own device-code sign-in. `onPrompt` is called with
 * the link and the code as soon as the agent has printed both (or either, when it prints only
 * one), then again only if they change. Resolves once the agent reports success.
 */
export async function signInHostAgent(
  stream: HostAgentStream,
  id: string,
  program: string,
  onPrompt: (prompt: HostAgentLoginPrompt) => void,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<void> {
  const agent = hostAgent(id);
  const seen: HostAgentLoginPrompt = {};
  let shown = "";
  let refused: string | undefined;
  let started = false;
  const command = stream(
    ["python3", "-", "login", "--agent", agent.id],
    (_, line) => {
      const ours = LINE.exec(line);
      if (ours) {
        const found = records(line);
        refused ??= refusal(found);
        if (found.some((record) => record.step === "login" && record.result === "started")) started = true;
        return;
      }
      if (!started) return;
      const prompt = loginPrompt(line, agent.loginOrigins);
      if (prompt.url) seen.url = prompt.url;
      if (prompt.code) seen.code = prompt.code;
      const key = `${seen.url ?? ""} ${seen.code ?? ""}`;
      if (key.trim() && key !== shown) {
        shown = key;
        onPrompt({ ...seen });
      }
    },
    program,
  );
  const timer = setTimeout(() => command.kill(), timeoutMs);
  try {
    const exit = await command.exit;
    if (refused) throw new HostAgentRefused(refused);
    if (exit.kind === "exited" && exit.code === 0 && started) return;
    if (exit.kind === "exited" && exit.code === 127) throw new HostAgentRefused("The server has no python3.");
    if (exit.kind === "signalled" || exit.kind === "refused")
      throw new HostAgentRefused(`${agent.name} was not signed in: the sign-in was stopped or the connection ended.`);
    throw new HostAgentRefused(`${agent.name} was not signed in on the server.`);
  } finally {
    clearTimeout(timer);
  }
}

/** The YAML for the server's own config that runs an installed agent, under `agents:`. */
export function hostAgentSettings(installed: HostAgentInstalled): string {
  const agent = hostAgent(installed.agent);
  const suffix = `/agents/${agent.id}/${installed.version}`;
  if (!installed.dir.endsWith(suffix)) throw new HostAgentRefused("The install is not under the server root.");
  const root = installed.dir.slice(0, -suffix.length);
  if (agent.id === "codex")
    return [
      "agents:",
      "  - id: codex",
      `    name: ${agent.name}`,
      `    command: ${root}/current/runtime/bin/node`,
      `    args: [${installed.dir}/files/node_modules/@agentclientprotocol/codex-acp/dist/index.js]`,
      "    env:",
      `      CODEX_HOME: ${installed.home}`,
    ].join("\n");
  return [
    "agents:",
    "  - id: copilot",
    `    name: ${agent.name}`,
    `    command: ${installed.binary}`,
    "    args: [--acp, --stdio, --no-auto-update, --disable-builtin-mcps, --no-ask-user]",
    "    env:",
    `      COPILOT_HOME: ${installed.home}`,
    '      COPILOT_AUTO_UPDATE: "false"',
    '      COPILOT_ALLOW_ALL: "false"',
  ].join("\n");
}
