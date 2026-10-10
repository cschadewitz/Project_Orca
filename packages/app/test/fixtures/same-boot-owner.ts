/** Disposable real app owner launches its own CLI child; the test crashes this owner after authenticated binding. */
import { createInterface } from "node:readline";
import { reserveFirstRunOwnership } from "../../src/main/first-run/ownership.js";
import { startBundledDaemon } from "../../src/main/daemon-process.js";
import { DaemonClient } from "../../src/client/daemon-client.js";
import { LocalDaemonToken } from "../../src/client/auth.js";
const path = process.argv[2]!,
  entry = process.argv[3]!;
const owner = reserveFirstRunOwnership(path);
const daemon = await startBundledDaemon({
  entry,
  cwd: path,
  configPath: `${path}/orca.config.yaml`,
  firstRunToken: owner.launchToken!(),
  execPath: process.execPath,
  env: { PATH: process.env.PATH ?? "" },
  startTimeoutMs: 10000,
  stopTimeoutMs: 1000,
});
owner.attach(daemon);
const auth = new LocalDaemonToken({ url: daemon.url, tokenFile: daemon.tokenFile!, env: {} });
const hello = await new DaemonClient(daemon.url, fetch, { auth, requireAuthentication: true }).hello("fixture", false);
owner.verify(hello);
process.stdout.write(JSON.stringify({ url: daemon.url, pid: daemon.pid, tokenFile: daemon.tokenFile, hello }) + "\n");
createInterface({ input: process.stdin }).on("line", () => {
  void daemon.stop().then(() => {
    owner.complete();
    process.exit(0);
  });
});
