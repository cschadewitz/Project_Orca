/**
 * Whether this host lets the process running it make the Codex exec gate's closed executor
 * (#1026), and under which AppArmor label each part runs. For the host question of #1026:
 * which exact stock host, with ORCA's installed package and nothing else changed, gives
 * the daemon's own program the user namespaces that bubblewrap and `unshare` need.
 *
 *   node tools/codex-exec-host-probe.mjs <scratch-dir>
 *   ELECTRON_RUN_AS_NODE=1 /opt/ORCA/orca-desktop tools/codex-exec-host-probe.mjs <scratch-dir>
 *
 * The second is the identity the daemon has once the desktop app starts it: the installed
 * Electron binary run as Node (packages/app/src/main/daemon-process.ts). AppArmor attaches
 * a profile by the program's path, so the label is the installed package's. The executor
 * started is a stand-in shell, not Codex, and the backend is the repository's build, not
 * the one bundled in the package: this shows what the host allows that program, nothing
 * about a session. `<scratch-dir>` must not be under /tmp (a closed executor has its own).
 *
 * Prints one JSON object. Exits 0 when the closed executor was admitted and behaved as
 * closed, 1 when it was refused (the reason is in the output), 2 on a probe error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

const agents = await import(new URL("../packages/agents/dist/index.js", import.meta.url).href);

const read = (path) => {
  try {
    return readFileSync(path, "utf8").replace(/\0/g, "").trim();
  } catch (error) {
    return `unreadable (${error.code ?? error.message})`;
  }
};
const label = (pid) => read(`/proc/${pid}/attr/current`);

const scratch = process.argv[2];
if (!scratch) {
  console.error("usage: codex-exec-host-probe.mjs <scratch-dir>");
  process.exit(2);
}
const root = await realpath(await mkdtemp(join(await realpath(scratch), "codex-exec-host-")));

const report = {
  runtime: process.execPath,
  electron: process.versions.electron ?? null,
  label: label("self"),
  os: Object.fromEntries(
    read("/etc/os-release")
      .split("\n")
      .map((line) => line.split("="))
      .filter(([key]) => ["ID", "VERSION_ID", "VERSION_CODENAME"].includes(key))
      .map(([key, value]) => [key, value.replace(/"/g, "")]),
  ),
  arch: process.arch,
  kernel: read("/proc/sys/kernel/osrelease"),
  apparmor_restrict_unprivileged_userns: read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
  unprivileged_userns_clone: read("/proc/sys/kernel/unprivileged_userns_clone"),
  ptrace_scope: read("/proc/sys/kernel/yama/ptrace_scope"),
  bubblewrap: agents.systemBubblewrap() ?? null,
  unshare: agents.systemUnshare() ?? null,
};

// Each system program alone, started by this process: can it make a user namespace?
const tryAlone = (program, args) => {
  const run = spawnSync(program, args, { encoding: "utf8", timeout: 10_000 });
  return {
    status: run.status,
    error: run.error?.code,
    stdout: run.stdout?.trim().slice(0, 300),
    stderr: run.stderr?.trim().slice(0, 300),
  };
};
if (report.bubblewrap)
  report.bubblewrapAlone = tryAlone(report.bubblewrap, [
    "--unshare-user",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "/bin/cat",
    "/proc/self/attr/current",
  ]);
if (report.unshare)
  report.unshareAlone = tryAlone(report.unshare, [
    "--user",
    "--map-current-user",
    "--mount",
    "--propagation",
    "private",
    "--",
    "/bin/cat",
    "/proc/self/attr/current",
  ]);

// The closed executor as the gate's backend makes it, with a stand-in executor.
const config = join(root, "config");
const store = join(config, ".orca");
const work = join(root, "work");
const tools = join(root, "tools");
for (const dir of [join(config, "auth"), join(store, "work"), work, tools]) await mkdir(dir, { recursive: true });
await writeFile(join(config, "auth", "owner.token"), "the-owner-token\n");
const program = join(tools, "executor.sh");
await writeFile(
  program,
  [
    "#!/bin/bash",
    "while IFS= read -r line; do",
    '  out=$(bash -c "$line" 2>&1 | head -c 4000 | base64 -w0)',
    '  echo "{\\"out\\":\\"$out\\"}"',
    "done",
    "",
  ].join("\n"),
);
await chmod(program, 0o755);

let backend;
try {
  backend = agents.spawnIsolatedCodexExecServer({
    program,
    env: { PATH: "/usr/bin:/bin" },
    cwd: work,
    masks: { hidden: [join(config, "auth")], readOnly: [store, tools], writable: [join(store, "work")] },
    closed: { writable: [work] },
    // The installed binary runs as Electron unless told to run as Node.
    runtimeEnv: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
    setupWaitMs: 30_000,
    stopGraceMs: 1000,
  });
  const answers = [];
  backend.onMessage((message) => answers.shift()?.(Buffer.from(JSON.parse(message).out, "base64").toString("utf8")));
  const run = (command) =>
    new Promise((resolve) => {
      answers.push(resolve);
      backend.send(command, () => undefined);
    });
  const proof = await backend.isolated;
  report.admitted = true;
  report.proof = proof;
  report.holderLabel = label(proof.holder);
  report.executorLabel = label(proof.executor);
  report.shortfalls = agents.codexExecProofShortfalls(proof);
  report.inside = {
    label: (await run("cat /proc/self/attr/current")).trim(),
    writesWork: (await run(`echo ok > ${work}/made && cat ${work}/made`)).trim(),
    writesRoot: (await run(`echo no > ${root}/made 2>&1; echo $?`)).trim(),
    token: (await run(`cat ${join(config, "auth", "owner.token")} 2>&1 || true`)).trim(),
  };
  const closedAsShown =
    report.inside.writesWork === "ok" && report.inside.writesRoot !== "0" && !existsSync(join(root, "made"));
  report.closedAsShown = closedAsShown;
  await backend.stop();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(closedAsShown ? 0 : 2);
} catch (error) {
  report.admitted = false;
  report.refused = error instanceof agents.CodexExecIsolationError ? error.message : String(error?.stack ?? error);
  await backend?.stop().catch(() => undefined);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(error instanceof agents.CodexExecIsolationError ? 1 : 2);
}
