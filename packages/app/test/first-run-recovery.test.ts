/** Real disposable owner crash, authenticated CLI children, kernel fencing and same-boot recreation. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { firstRunRequiresExplicitContinuationRecovery } from "../../cli/src/first-run-recovery-fence.js";
import {
  enterFirstRunWriter,
  fenceDirectory,
  fencePort,
  observeFirstRunFence,
  acquireFirstRunFence,
} from "@orca/protocol/first-run-fence";
import type { HelloResult } from "@orca/protocol";
import { readFileSync } from "node:fs";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import { startBundledDaemon, type BundledDaemon } from "../src/main/daemon-process.js";
import { FirstRunRecovery } from "../src/main/first-run/recovery.js";
import { inspectFirstRunOwnership, reserveFirstRunOwnership } from "../src/main/first-run/ownership.js";
import { compiledSourceFixture } from "./compiled-source-fixture.js";

const compileOwner = compiledSourceFixture(process.cwd(), "packages/app/test/fixtures/same-boot-owner.ts", []);
const compileDaemon = compiledSourceFixture(process.cwd(), "packages/app/test/fixtures/first-run-daemon.ts", []);
const roots: string[] = [],
  owners: ChildProcess[] = [],
  daemons: BundledDaemon[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const daemon of daemons) await daemon.stop();
  daemons.length = 0;
  for (const child of owners.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function availableWorkspace() {
  let occupied: unknown;
  for (let attempt = 0; attempt < 16; attempt++) {
    const root = await mkdtemp(join(process.cwd(), ".orca-same-boot-test-"));
    roots.push(root);
    const path = join(root, "workspace");
    await mkdir(path);
    let fence;
    try {
      // Select a fresh disposable identity before reservation; production keeps its fixed mapping.
      fence = await acquireFirstRunFence(fenceDirectory(path), () => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      occupied = error;
      await rm(root, { recursive: true, force: true });
      continue;
    }
    await new Promise<void>((resolve) => fence.close(() => resolve()));
    return { root, path };
  }
  throw new Error("No free initial fixture fence after 16 fresh workspaces", { cause: occupied });
}
async function fixture() {
  const { root, path } = await availableWorkspace();
  await writeFile(
    join(path, "orca.config.yaml"),
    JSON.stringify({
      version: 1,
      storeDir: ".orca",
      agents: [],
      roles: {},
      plugins: [],
      hosts: [{ id: "local", type: "local" }],
      workspace: { provider: "local", root: path, hostId: "local" },
      workflows: [],
      templates: [],
      humanInput: { mode: "pause" },
    }) + "\n",
  );
  const entry = join(root, "daemon.mjs");
  await writeFile(entry, compileDaemon().source);
  return { root, path, entry };
}
async function start(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  const daemon = await startBundledDaemon({
    entry: f.entry,
    cwd: f.path,
    configPath: join(f.path, "orca.config.yaml"),
    firstRunToken: token,
    execPath: process.execPath,
    env: { PATH: process.env.PATH ?? "" },
    startTimeoutMs: 10000,
    stopTimeoutMs: 1000,
  });
  daemons.push(daemon);
  const auth = new LocalDaemonToken({ url: daemon.url, tokenFile: daemon.tokenFile!, env: {} });
  const hello = await new DaemonClient(daemon.url, fetch, { auth, requireAuthentication: true }).hello(
    "fixture",
    false,
  );
  return { daemon, hello };
}
async function crashOwner(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = join(f.root, "owner.mjs");
  await writeFile(entry, compileOwner().source);
  const child = spawn(process.execPath, [entry, f.path, f.entry], { stdio: ["pipe", "pipe", "pipe"] });
  owners.push(child);
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, "line");
  const ready = JSON.parse(String(line)) as { url: string; pid: number; tokenFile: string; hello: HelloResult };
  // The fixture really is the OS parent of this daemon. Record birth before crashing the app.
  const processFields = () => readFileSync(`/proc/${ready.pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
  const fields = processFields();
  expect(Number(fields[1])).toBe(child.pid);
  const birth = fields[19];
  let exited = false;
  const daemon: BundledDaemon = {
    url: ready.url,
    pid: ready.pid,
    tokenFile: ready.tokenFile,
    get exited() {
      return exited;
    },
    stop: async () => {
      if (exited) return;
      // Fixture cleanup only: exact known descendant birth plus live writer digest, never guessed PID cleanup.
      expect(processFields()[19]).toBe(birth);
      expect(typeof (await observeFirstRunFence(fenceDirectory(f.path)))).toBe("string");
      process.kill(ready.pid, "SIGTERM");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          const fence = await acquireFirstRunFence(fenceDirectory(f.path), () => undefined);
          await new Promise<void>((resolve) => fence.close(() => resolve()));
          exited = true;
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      throw new Error("Owned fixture daemon did not release its lifetime fence");
    },
  };
  daemons.push(daemon);
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
  return { daemon, hello: ready.hello };
}

it.skipIf(process.platform !== "linux")(
  "distinguishes the surviving exact daemon, then recovers after owner and child loss on the same boot without replay or credential loss",
  async () => {
    const f = await fixture();
    const live = await crashOwner(f);
    expect(() => reserveFirstRunOwnership(f.path)).toThrow("reconciliation");
    await writeFile(join(f.path, ".orca", "retained-journal.jsonl"), "retained audit and work\n");
    const credential = await readFile(join(f.path, "auth", "local-client.token"), "utf8");
    const before = inspectFirstRunOwnership(f.path, true).latest!.texts;
    const recovery = new FirstRunRecovery(f.path);
    const request = recovery.prepare(() => {});
    expect(await recovery.reconcile(request.requestId, () => {})).toMatchObject({ state: "surviving-owned-daemon" });
    expect(live.daemon.exited).toBe(false);
    await live.daemon.stop();
    expect(await new FirstRunRecovery(f.path).reconcile(request.requestId, () => {})).toMatchObject({
      state: "reconciled",
    });
    const recovered = inspectFirstRunOwnership(f.path).latest!.texts;
    for (const [name, text] of Object.entries(before)) expect(recovered[name]).toBe(text);
    expect(firstRunRequiresExplicitContinuationRecovery(f.path)).toBe(true);
    expect(await readFile(join(f.path, "auth", "local-client.token"), "utf8")).toBe(credential);
    const owner = reserveFirstRunOwnership(f.path);
    const fresh = await start(f, owner.launchToken!());
    owner.attach(fresh.daemon);
    owner.verify(fresh.hello);
    expect(fresh.hello.identity!.workspaceId).toBe(live.hello.identity!.workspaceId);
    expect(fresh.hello.identity!.instanceId).not.toBe(live.hello.identity!.instanceId);
    // Normal Connect retains its inherited bootstrap-token rotation; recovery itself never touches auth.
    expect(await readFile(join(f.path, ".orca", "retained-journal.jsonl"), "utf8")).toBe("retained audit and work\n");
    await fresh.daemon.stop();
    expect(owner.complete()).toBe(true);
  },
  30000,
);
it("settles claim-only interruption and fences a delayed child with the old launch capability", async () => {
  const f = await fixture();
  const owner = reserveFirstRunOwnership(f.path);
  const token = owner.launchToken!();
  const recovery = new FirstRunRecovery(f.path);
  const request = recovery.prepare(() => {});
  expect(await recovery.reconcile(request.requestId, () => {})).toMatchObject({ state: "reconciled" });
  await expect(enterFirstRunWriter(f.path, join(f.path, ".orca"), token)).rejects.toThrow("no longer authorized");
  expect(await readdir(f.path)).not.toContain(".orca");
  expect(() => reserveFirstRunOwnership(f.path)).not.toThrow();
});
it("reports a foreign occupied fence without adopting, signalling or settling it", async () => {
  const f = await fixture();
  reserveFirstRunOwnership(f.path);
  const server = createServer((socket) => socket.end('{"processId":123}\n'));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(fencePort(fenceDirectory(f.path)), "127.0.0.1", resolve));
  const recovery = new FirstRunRecovery(f.path);
  const request = recovery.prepare(() => {});
  expect(await recovery.reconcile(request.requestId, () => {})).toMatchObject({ state: "unknown-writer" });
  expect(server.listening).toBe(true);
  expect(inspectFirstRunOwnership(f.path, true).latest!.texts["recovery.json"]).toBeUndefined();
});
it("arbitrates concurrent reconciliations and refuses stale handles", async () => {
  const f = await fixture();
  reserveFirstRunOwnership(f.path);
  const recovery = new FirstRunRecovery(f.path);
  const request = recovery.prepare(() => {});
  const outcomes = await Promise.allSettled([
    recovery.reconcile(request.requestId, () => {}),
    new FirstRunRecovery(f.path).reconcile(request.requestId, () => {}),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled" && result.value.state === "reconciled"),
  ).toHaveLength(1);
  expect(inspectFirstRunOwnership(f.path).latest!.settled).toBe(true);
  await expect(recovery.reconcile("11111111-1111-4111-8111-111111111111", () => {})).rejects.toThrow();
});
it.skipIf(process.platform !== "linux")(
  "refuses replaced store identity and preserves all uncertain records",
  async () => {
    const f = await fixture();
    const live = await crashOwner(f);
    await live.daemon.stop();
    const recovery = new FirstRunRecovery(f.path);
    const request = recovery.prepare(() => {});
    await rename(join(f.path, ".orca"), join(f.path, "retained-store"));
    await mkdir(join(f.path, ".orca"));
    await expect(recovery.reconcile(request.requestId, () => {})).rejects.toThrow("reconciliation");
    expect(inspectFirstRunOwnership(f.path, true).latest!.texts["recovery.json"]).toBeUndefined();
  },
);
it("refuses legacy uncertain claims because no lifetime-fence authority was recorded", async () => {
  const f = await fixture();
  reserveFirstRunOwnership(f.path);
  const claimPath = join(f.path, ".orca-first-run-ownership", "000001", "claim.json");
  const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
  claim.version = 1;
  delete claim.launchHash;
  delete claim.fence;
  delete claim.boot;
  delete claim.store;
  await writeFile(claimPath, JSON.stringify(claim) + "\n");
  expect(() => new FirstRunRecovery(f.path).prepare(() => {})).toThrow("reconciliation");
});

it("refuses wrong boot/domain evidence and stale caller authority without writing a resolution", async () => {
  const f = await fixture();
  reserveFirstRunOwnership(f.path);
  const recovery = new FirstRunRecovery(f.path);
  const request = recovery.prepare(() => {});
  await expect(
    recovery.reconcile(request.requestId, () => {
      throw new Error("stale caller");
    }),
  ).rejects.toThrow("stale caller");
  expect(inspectFirstRunOwnership(f.path, true).latest!.texts["recovery.json"]).toBeUndefined();
  const claimPath = join(f.path, ".orca-first-run-ownership", "000001", "claim.json");
  const claim = JSON.parse(await readFile(claimPath, "utf8")) as { boot: { kernelDomain: string } };
  claim.boot.kernelDomain = "foreign-domain";
  await writeFile(claimPath, JSON.stringify(claim) + "\n");
  await expect(recovery.reconcile(request.requestId, () => {})).rejects.toThrow("reconciliation");
});
