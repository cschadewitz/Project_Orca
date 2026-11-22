/**
 * The two-daemon fixture's smoke test (#885 phase 1): two real `orca serve` processes, each
 * with its own store, port and token, answer an authenticated `hello` and nothing else; one
 * of them is the N-1 daemon an N app falls back to (#880); and, where sshd is installed, one
 * daemon is reached through an SSH port forward the way a remote machine's would be.
 *
 * Needs `pnpm run build` (it runs the compiled CLI); CI builds before it tests.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_PROTOCOL, HELLO_METHOD, HelloResultSchema, PROTOCOL_VERSION } from "@orca/protocol";
import {
  loopbackSshd,
  rpc,
  startTestDaemon,
  startTwoDaemons,
  type LoopbackSshd,
  type TwoDaemons,
} from "@orca/testing/two-daemons";
import { repoRoot } from "@orca/testing/child-bundle";

let pair: TwoDaemons;
beforeAll(async () => {
  pair = await startTwoDaemons();
}, 60_000);
afterAll(async () => {
  await pair?.close();
});

const hello = (client: string) => ({ client, protocol: CLIENT_PROTOCOL });
const result = (answer: Awaited<ReturnType<typeof rpc>>) => {
  if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
  return HelloResultSchema.parse(answer.result);
};

describe("two daemons", () => {
  it("each answers an authenticated hello from its own store", async () => {
    const a = result(await pair.a.call(HELLO_METHOD, hello("two-daemons/a")));
    const b = result(await pair.b.call(HELLO_METHOD, hello("two-daemons/b")));
    expect(a.protocol).toEqual(PROTOCOL_VERSION);
    expect(b.protocol).toEqual(PROTOCOL_VERSION);
    expect(a.storeDir).toBe(join(pair.a.dir, ".orca"));
    expect(b.storeDir).toBe(join(pair.b.dir, ".orca"));
    expect(pair.a.port).not.toBe(pair.b.port);
    // Two installations, not one seen twice.
    expect(a.identity?.workspaceId).toBeDefined();
    expect(a.identity?.workspaceId).not.toBe(b.identity?.workspaceId);
  });

  it("refuses a caller without a token, and each daemon's token on the other", async () => {
    expect(pair.a.token).not.toBe(pair.b.token);
    for (const [daemon, other] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ] as const) {
      expect(await daemon.call(HELLO_METHOD, hello("anonymous"), null)).toMatchObject({ ok: false });
      expect(await daemon.call(HELLO_METHOD, hello("wrong-daemon"), other.token)).toMatchObject({
        ok: false,
        error: { code: expect.stringMatching(/^AUTH_/) },
      });
    }
  });

  it("is the N-1 daemon an N app falls back to", async () => {
    const next = { major: PROTOCOL_VERSION.major + 1, minor: 0 };
    const fallback = result(
      await pair.b.call(HELLO_METHOD, { client: "orca-app/n", protocol: next, fallback: CLIENT_PROTOCOL }),
    );
    expect(fallback.protocol).toEqual(PROTOCOL_VERSION);
    // Without the fallback, the next major is refused with the protocol message.
    expect(await pair.b.call(HELLO_METHOD, { client: "orca-app/n", protocol: next })).toMatchObject({
      ok: false,
      error: { code: "NOT_SUPPORTED" },
    });
  });

  it("still answers the hello a shipped v0.7.0 app sends", async () => {
    const recorded = JSON.parse(
      await readFile(join(repoRoot, "packages/app/test/fixtures/protocol-2.0-hello.json"), "utf8"),
    ) as { request: { params: unknown } };
    expect(result(await pair.a.call(HELLO_METHOD, recorded.request.params)).protocol).toEqual(PROTOCOL_VERSION);
  });

  it("stops one daemon without the other noticing", async () => {
    const third = await startTestDaemon({ name: "c" });
    await third.close();
    await expect(third.call(HELLO_METHOD, hello("gone"))).rejects.toThrow();
    expect(result(await pair.a.call(HELLO_METHOD, hello("still-here"))).protocol).toEqual(PROTOCOL_VERSION);
  });
});

describe("a daemon behind a loopback sshd", () => {
  let sshd: LoopbackSshd | undefined;
  beforeAll(async () => {
    sshd = await loopbackSshd();
  }, 30_000);
  afterAll(async () => {
    await sshd?.close();
  });

  it("answers hello through an SSH port forward with its own token", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const local = await sshd.forward(pair.b.port);
    const through = `http://127.0.0.1:${local}`;
    const answer = result(await rpc(through, HELLO_METHOD, hello("over-ssh"), pair.b.token));
    expect(answer.storeDir).toBe(join(pair.b.dir, ".orca"));
    // The tunnel carries bytes, not trust: a's token is still refused by b.
    expect(await rpc(through, HELLO_METHOD, hello("over-ssh"), pair.a.token)).toMatchObject({ ok: false });
  });

  it("gives the generated key forwarding and nothing else", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    // An ambient ~/.ssh/config that would break every connection is never read.
    const home = await mkdtemp(join(tmpdir(), "orca-ssh-home-"));
    try {
      await mkdir(join(home, ".ssh"));
      await writeFile(join(home, ".ssh", "config"), "Host *\n  ProxyCommand false\n  ControlMaster auto\n");
      const ambient = spawnSync("ssh", [...sshd.sshArgs, "true"], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: home },
      });
      expect(ambient.status, ambient.stderr).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    // The forced command replaces whatever the client asks to run.
    const shell = spawnSync("ssh", [...sshd.sshArgs, "echo", "escaped"], { encoding: "utf8", timeout: 10_000 });
    expect(shell.status).toBe(0);
    expect(shell.stdout).not.toContain("escaped");
    // A forward to anywhere but 127.0.0.1 is refused by the key's permitopen, even to a
    // reachable daemon under another name.
    const elsewhere = spawnSync(
      "ssh",
      ["-F", sshd.sshArgs[1]!, "-o", "ExitOnForwardFailure=yes", "-W", `localhost:${pair.b.port}`, "127.0.0.1"],
      { encoding: "utf8", timeout: 10_000, input: "" },
    );
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.stderr).toContain("forwarding failed");
    // The same request to 127.0.0.1 is allowed, so the refusal above is the key's limit.
    const allowed = spawnSync(
      "ssh",
      ["-F", sshd.sshArgs[1]!, "-o", "ExitOnForwardFailure=yes", "-W", `127.0.0.1:${pair.b.port}`, "127.0.0.1"],
      { encoding: "utf8", timeout: 10_000, input: "" },
    );
    expect(allowed.stderr).not.toContain("forwarding failed");
  });
});

describe("the fixture's own lifecycle", () => {
  let scripts: string;
  beforeAll(async () => {
    scripts = await mkdtemp(join(tmpdir(), "orca-fixture-scripts-"));
  });
  afterAll(async () => {
    await rm(scripts, { recursive: true, force: true });
  });
  const script = async (name: string, body: string) => {
    const path = join(scripts, name);
    await writeFile(path, body);
    return path;
  };
  /** Nothing of a daemon called `name` is left in the temp directory. */
  const leftovers = async (name: string) =>
    (await readdir(tmpdir())).filter((entry) => entry.startsWith(`orca-daemon-${name}-`));

  it("fails a daemon that cannot spawn, without an unhandled error, and removes its directories", async () => {
    const name = `nospawn-${randomUUID()}`;
    await expect(
      startTestDaemon({ name, executable: join(scripts, "no-such-node"), entry: CLI_ENTRY_OR_SCRIPT() }),
    ).rejects.toThrow(/did not start: spawn .*ENOENT/);
    expect(await leftovers(name)).toEqual([]);
  });

  it("fails a daemon that exits before it is ready, with its output", async () => {
    const name = `early-${randomUUID()}`;
    const entry = await script("early.mjs", 'console.error("config is broken"); process.exit(3);\n');
    await expect(startTestDaemon({ name, entry })).rejects.toThrow(
      /exited before readiness \(code 3[\s\S]*config is broken/,
    );
    expect(await leftovers(name)).toEqual([]);
  });

  it("stops a daemon that ignores SIGTERM within its bound, and removes its directories", async () => {
    const name = `stubborn-${randomUUID()}`;
    const entry = await script(
      "stubborn.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const dir = process.argv[process.argv.indexOf("--cwd") + 1];',
        'const token = join(dir, "token");',
        'writeFileSync(token, "orca1.fake\\n");',
        'process.on("SIGTERM", () => {});',
        'console.log("orca daemon test listening on http://127.0.0.1:9 (protocol 2.2)");',
        "console.log(`authentication: token; local token file: ${token}`);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    const daemon = await startTestDaemon({ name, entry, stopMs: 200 });
    expect(daemon.token).toBe("orca1.fake");
    const started = Date.now();
    await daemon.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await leftovers(name)).toEqual([]);
    await daemon.close();
  });
});

/** Any existing file will do for a spawn that fails before it reads its script. */
const CLI_ENTRY_OR_SCRIPT = () => join(repoRoot, "package.json");
