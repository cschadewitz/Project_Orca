/**
 * Installing and signing in agents on a managed server from the client (#1236). The "server" is
 * a temporary home on this machine: every remote command runs here, in that home, exactly as ssh
 * would run its words, so `tools/deploy/orca-host-agents.py` really unpacks, reports and runs
 * the agent's sign-in. The agent is a stand-in script at the pinned agent's path.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HostAgentPackage } from "../src/host-agents-lock.js";
import type { RemoteCommand, RemoteCommandExit } from "../src/remote-access.js";
import {
  HOST_AGENTS,
  hostAgentSettings,
  hostAgentsProgram,
  hostAgentStatus,
  HostAgentRefused,
  installHostAgent,
  loginPrompt,
  prepareHostAgent,
  signInHostAgent,
  type HostAgentStream,
  type HostAgentTransport,
} from "../src/server-agents.js";

const scripts = fileURLToPath(new URL("../../../tools/deploy/", import.meta.url));
const program = hostAgentsProgram(scripts);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-agents-test-"));
  dirs.push(dir);
  return dir;
};

const COPILOT = "node_modules/@github/copilot-linux-x64";
/** A stand-in Copilot: `login --device-code` prints GitHub's prompt and signs the profile in. */
const FAKE_COPILOT = `#!/bin/sh
if [ "$1" = login ]; then
  printf '\\033[1m! First copy your one-time code: \\033[0mABCD-1234\\n'
  echo "Then open https://evil.example/login/device or https://github.com/login/device in your browser."
  printf '{"loggedInUsers":[{"host":"https://github.com","login":"someone"}]}' > "$COPILOT_HOME/config.json"
  echo "Signed in."
  exit 0
fi
exit 3
`;

/** An npm-style tarball whose top directory is `package/`, with `files` relative to it. */
function tarball(files: Record<string, string>, extra: string[] = []): { path: string; integrity: string } {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, "package", name, ".."), { recursive: true });
    writeFileSync(join(dir, "package", name), text, { mode: 0o755 });
  }
  const path = join(tmp(), "package.tgz");
  const made = spawnSync("tar", ["-czf", path, "-C", dir, "package", ...extra]);
  expect(made.status).toBe(0);
  return { path, integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}` };
}

/** The pinned-package list for a stand-in Copilot, served by a fetch that counts its calls. */
function copilotPackages(binary = FAKE_COPILOT) {
  const made = tarball({ copilot: binary, "package.json": "{}" });
  const packages: HostAgentPackage[] = [
    { path: COPILOT, version: "1.0.114", tarball: "https://registry.example/copilot.tgz", integrity: made.integrity },
  ];
  const fetched: string[] = [];
  const fetch = (url: string) => {
    fetched.push(url);
    return Promise.resolve(readFileSync(made.path));
  };
  return { packages, fetch, fetched };
}

/** A server whose home is a temporary directory, with ORCA set up there (its root exists). */
function server(options: { setUp?: boolean } = {}) {
  const home = tmp();
  const root = join(home, ".local/share/orca-server");
  if (options.setUp !== false) mkdirSync(root, { recursive: true });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" };
  const commands: string[][] = [];
  const transport: HostAgentTransport = {
    exec: (command, _timeout, input) => {
      commands.push([...command]);
      const result = spawnSync(command[0]!, command.slice(1), { cwd: home, env, encoding: "utf8", input });
      return Promise.resolve({ code: result.status ?? 255, stdout: result.stdout ?? "" });
    },
    upload: (path, remotePath) => {
      copyFileSync(path, remotePath.startsWith("/") ? remotePath : join(home, remotePath));
      return Promise.resolve();
    },
  };
  const stream: HostAgentStream = (command, onLine, input) => {
    commands.push([...command]);
    const child = spawn(command[0]!, command.slice(1), { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(input);
    const exit = new Promise<RemoteCommandExit>((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.once("close", (code, signal) => {
        for (const line of out.split("\n")) if (line) onLine("stdout", line);
        resolve(code === null ? { kind: "signalled", signal: signal ?? "unknown" } : { kind: "exited", code });
      });
    });
    return { exit, kill: () => child.kill() } satisfies RemoteCommand;
  };
  return { home, root, transport, stream, commands };
}

async function install(host: ReturnType<typeof server>, made = copilotPackages(), cacheDir = tmp()) {
  const prepared = await prepareHostAgent("copilot", { fetch: made.fetch, cacheDir, packages: made.packages });
  try {
    return await installHostAgent(host.transport, prepared, program);
  } finally {
    rmSync(prepared.dir, { recursive: true, force: true });
  }
}

describe("installing an agent on the server", () => {
  it("unpacks the pinned packages under the server root, once, and says how to run the agent", async () => {
    const host = server();
    const made = copilotPackages();
    const cache = tmp();
    const first = await install(host, made, cache);
    expect(first).toMatchObject({
      agent: "copilot",
      version: "1.0.114",
      result: "changed",
      dir: `${host.root}/agents/copilot/1.0.114`,
      home: `${host.root}/agents/copilot/home`,
      binary: `${host.root}/agents/copilot/1.0.114/${COPILOT}/copilot`,
    });
    expect(readFileSync(first.binary, "utf8")).toBe(FAKE_COPILOT);
    expect(lstatSync(first.home).mode & 0o777).toBe(0o700);
    // The courier directory is gone, and nothing was read by a shell.
    expect(readdirSync(join(host.home, ".cache/orca-courier"))).toEqual([]);
    expect(host.commands.some((command) => ["sh", "bash", "-c"].includes(command[0]!))).toBe(false);

    // Again: from this computer's cache, and the same install is accepted as it is.
    const again = await install(host, made, cache);
    expect(again.result).toBe("ok");
    expect(made.fetched).toHaveLength(1);

    const settings = hostAgentSettings(first);
    expect(settings).toContain(`command: ${first.binary}`);
    expect(settings).toContain(`COPILOT_HOME: ${first.home}`);
  });

  it("refuses a different install already at that version, and changes nothing", async () => {
    const host = server();
    await install(host);
    const other = copilotPackages(FAKE_COPILOT.replace("Signed in.", "Other build."));
    await expect(install(host, other)).rejects.toThrow(/another install of copilot 1\.0\.114/);
    expect(readFileSync(`${host.root}/agents/copilot/1.0.114/${COPILOT}/copilot`, "utf8")).toBe(FAKE_COPILOT);
  });

  it("never carries a package that does not match its pinned integrity", async () => {
    const made = copilotPackages();
    const tampered = { ...made, fetch: () => Promise.resolve(Buffer.from("not the package")) };
    await expect(
      prepareHostAgent("copilot", { fetch: tampered.fetch, cacheDir: tmp(), packages: made.packages }),
    ).rejects.toBeInstanceOf(HostAgentRefused);
  });

  it("refuses a package holding a link, and leaves no install behind", async () => {
    const host = server();
    const dir = tmp();
    mkdirSync(join(dir, "package"));
    writeFileSync(join(dir, "package/copilot"), FAKE_COPILOT, { mode: 0o755 });
    spawnSync("ln", ["-s", "/etc/passwd", join(dir, "package/passwd")]);
    const path = join(tmp(), "linked.tgz");
    spawnSync("tar", ["-czf", path, "-C", dir, "package"]);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
    const made = {
      packages: [{ path: COPILOT, version: "1.0.114", tarball: "https://registry.example/x.tgz", integrity }],
      fetch: () => Promise.resolve(readFileSync(path)),
      fetched: [],
    };
    await expect(install(host, made)).rejects.toThrow(/link or special file/);
    expect(existsSync(`${host.root}/agents/copilot/1.0.114`)).toBe(false);
  });

  it("refuses a machine that is not set up yet", async () => {
    await expect(install(server({ setUp: false }))).rejects.toThrow(/not an ORCA server yet/);
  });

  it("refuses an agents directory that is a link", async () => {
    const host = server();
    const elsewhere = tmp();
    spawnSync("ln", ["-s", elsewhere, join(host.root, "agents")]);
    await expect(install(host)).rejects.toThrow(/not a directory of the ORCA server's own/);
    expect(spawnSync("ls", ["-A", elsewhere]).stdout.toString()).toBe("");
  });
});

describe("signing an agent in on the server", () => {
  it("relays only a link on the agent's own sign-in page and the code, then reports it signed in", async () => {
    const host = server();
    expect(await hostAgentStatus(host.transport, program)).toEqual([
      { agent: "codex", versions: [], signedIn: "no" },
      { agent: "copilot", versions: [], signedIn: "no" },
    ]);
    await install(host);
    expect((await hostAgentStatus(host.transport, program))[1]).toEqual({
      agent: "copilot",
      versions: ["1.0.114"],
      signedIn: "no",
    });
    const prompts: unknown[] = [];
    await signInHostAgent(host.stream, "copilot", program, (prompt) => prompts.push(prompt));
    expect(prompts.at(-1)).toEqual({ url: "https://github.com/login/device", code: "ABCD-1234" });
    expect(JSON.stringify(prompts)).not.toContain("evil.example");
    expect((await hostAgentStatus(host.transport, program))[1]!.signedIn).toBe("yes");
  });

  it("refuses to sign in an agent that is not installed", async () => {
    const host = server();
    await expect(signInHostAgent(host.stream, "copilot", program, () => {})).rejects.toThrow(/not installed/);
    await expect(signInHostAgent(host.stream, "nope", program, () => {})).rejects.toThrow(/No agent called nope/);
  });

  it("takes links only from the agent's origins, without credentials", () => {
    const origins = HOST_AGENTS.codex!.loginOrigins;
    expect(loginPrompt("Open https://auth.openai.com/codex/device and enter WXYZ-12345.", origins)).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "WXYZ-12345",
    });
    expect(loginPrompt("https://user:pw@auth.openai.com/x", origins)).toEqual({});
    expect(loginPrompt("http://auth.openai.com/codex/device", origins)).toEqual({});
    expect(loginPrompt("https://auth.openai.com.evil.example/codex/device", origins)).toEqual({});
  });
});
