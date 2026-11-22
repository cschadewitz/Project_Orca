/**
 * Updating a server from the app (#879), end to end on loopback: a real `orca serve` launched
 * with the managed updater's environment reports it in `hello.deployment`, and the app's
 * updater runs over a real `SshTunnel` to a real sshd, whose key's forced command stands in
 * for `orca-release.py` and records exactly what the app asked to run.
 *
 * Needs `pnpm run build` (the daemon is the compiled CLI) and `/usr/sbin/sshd`; it skips
 * without sshd unless `ORCA_REQUIRE_SSHD=1`, which the two-daemon workflow sets.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_PROTOCOL, HELLO_METHOD, HelloResultSchema } from "@orca/protocol";
import { ConnectionProfileSchema, SshTunnel } from "@orca/protocol/remote-access";
import { loopbackSshd, rpc, startTestDaemon, type LoopbackSshd, type TestDaemon } from "@orca/testing/two-daemons";
import { ServerUpdater } from "../src/main/server-update.js";
import { serverUpdateCommand, type ServerUpdateProgress } from "../src/server-update.js";

let root: string;
let sshd: LoopbackSshd | undefined;
let daemon: TestDaemon;
let tunnel: SshTunnel | undefined;
const updater = () => join(root, "orca-release.py");
const manifest = () => join(root, "deployment.json");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-server-update-"));
  // The stand-in updater: what the server's own would print for each outcome.
  const fake = join(root, "fake-updater.sh");
  await writeFile(
    fake,
    [
      "#!/bin/sh",
      '[ "$SSH_ORIGINAL_COMMAND" = "true" ] && exit 0',
      `printf '%s\\n' "$SSH_ORIGINAL_COMMAND" >> ${join(root, "asked")}`,
      `case "$(cat ${join(root, "mode")})" in`,
      '  ok) echo "/srv/orca/releases/v0.8.0"; exit 0 ;;',
      '  lock) echo "orca-release: Busy: update.lock; another update is running" >&2; exit 1 ;;',
      '  busy) echo "checking the daemon"; echo "orca-release: Daemon busy: 1 run active" >&2; exit 1 ;;',
      "esac",
      "exit 2",
      "",
    ].join("\n"),
  );
  await chmod(fake, 0o755);
  sshd = await loopbackSshd({ forcedCommand: `/bin/sh ${fake}` });
  daemon = await startTestDaemon({
    name: "managed",
    env: {
      ORCA_DEPLOYMENT_ADAPTER: updater(),
      ORCA_DEPLOYMENT_MANIFEST: manifest(),
      ORCA_DEPLOYMENT_RING: "preview",
    },
  });
}, 60_000);
afterAll(async () => {
  await tunnel?.close();
  await daemon?.close();
  await sshd?.close();
  await rm(root, { recursive: true, force: true });
});

describe("updating a managed server over its SSH profile", () => {
  it("runs the updater the daemon reported, over the pinned connection, and reads each outcome", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const answer = await rpc(
      daemon.url,
      HELLO_METHOD,
      { client: "server-update", protocol: CLIENT_PROTOCOL },
      daemon.token,
    );
    if (!answer.ok) throw new Error(answer.error.message);
    const deployment = HelloResultSchema.parse(answer.result).deployment;
    expect(deployment).toEqual({ kind: "managed", adapter: updater(), manifest: manifest(), ring: "preview" });

    tunnel = new SshTunnel({
      profile: ConnectionProfileSchema.parse({
        id: "loopback",
        name: "Loopback",
        destination: `${sshd.user}@127.0.0.1`,
        sshPort: sshd.port,
        identityFile: sshd.identity,
        remotePort: daemon.port,
      }),
      knownHostsFile: join(root, "loopback.known_hosts"),
    });
    await tunnel.open();
    const progress: ServerUpdateProgress[] = [];
    const run = new ServerUpdater({
      version: "0.8.0",
      deployment: () => deployment,
      run: (command, onLine) => ({ command: tunnel!.exec(command, onLine) }),
      onProgress: (line) => progress.push(line),
    });

    const mode = (value: string) => writeFile(join(root, "mode"), value);
    await mode("ok");
    expect(await run.update()).toEqual({ status: "updated", version: "0.8.0" });
    expect(progress).toEqual([{ stream: "stdout", line: "/srv/orca/releases/v0.8.0" }]);
    await mode("lock");
    expect(await run.update()).toMatchObject({ status: "another-update" });
    await mode("busy");
    progress.length = 0;
    expect(await run.update()).toEqual({ status: "work-running", detail: "Daemon busy: 1 run active" });
    expect(progress.map((entry) => entry.line)).toEqual([
      "checking the daemon",
      "orca-release: Daemon busy: 1 run active",
    ]);

    // Each time, the server was asked for exactly the operator's command, word for word.
    const quoted = serverUpdateCommand(deployment!, "0.8.0")
      .map((word) => `'${word}'`)
      .join(" ");
    expect((await readFile(join(root, "asked"), "utf8")).trim().split("\n")).toEqual([quoted, quoted, quoted]);
  }, 60_000);
});
