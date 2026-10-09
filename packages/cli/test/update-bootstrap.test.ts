/** Real CLI consumers and authenticated closed read-only startup with disposable auth. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ClosedUpdateWindow, provisionUpdateWindow } from "@orca/protocol/update-window";
import { bootstrapLocalOwner, openAuthDirectory } from "@orca/daemon";
import { DaemonClient } from "../../app/src/client/daemon-client.js";
import { LocalDaemonToken } from "../../app/src/client/auth.js";
import { randomUUID } from "node:crypto";
import { fenceBoot, fenceDirectory, fenceHash, fenceWrite, acquireFirstRunFence } from "@orca/protocol/first-run-fence";

const roots: string[] = [],
  children: ChildProcess[] = [],
  owners: ClosedUpdateWindow[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await done;
    }
  for (const owner of owners.splice(0)) await owner.detach();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(join(process.cwd(), "orca-cli-update-"));
  roots.push(base);
  const workspace = join(base, "workspace"),
    control = join(base, "recovery");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(control, { mode: 0o700 });
  await mkdir(join(workspace, ".orca"), { mode: 0o700 });
  await writeFile(join(workspace, "orca.config.yaml"), "storeDir: .orca\n", { mode: 0o600 });
  await provisionUpdateWindow(control, [workspace]);
  const owner = new ClosedUpdateWindow(control);
  owners.push(owner);
  return { base, workspace, control, owner };
}
const cli = resolve("packages/cli/src/main.ts");
it("actual auth/init CLI routes refuse before protected writes while help remains usable", async () => {
  const f = await fixture();
  f.owner.closeAdmission("a".repeat(64));
  expect(await f.owner.capture()).toBe(true);
  for (const args of [
    ["auth", "list", "--cwd", f.workspace],
    ["init", "--dir", f.workspace],
  ])
    await expect(
      promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], {
        timeout: 10000,
        env: { ...process.env, ORCA_UPDATE_LAUNCH: undefined, ORCA_UPDATE_ATTEMPT: undefined },
      }),
    ).rejects.toThrow();
  expect(await readdir(f.workspace)).not.toContain("auth");
  const help = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "--help", "--cwd", f.workspace], {
    timeout: 10000,
  });
  expect(help.stdout).toContain("usage:");
});
it("replacement capability refuses ordinary serve and auth commands rather than weakening authentication", async () => {
  const f = await fixture();
  f.owner.closeAdmission("a".repeat(64));
  await f.owner.capture();
  const permit = await f.owner.beginMigration();
  const env = { ...process.env, ORCA_UPDATE_ATTEMPT: permit.attempt, ORCA_UPDATE_LAUNCH: permit.token };
  for (const args of [
    ["serve", "--cwd", f.workspace],
    ["auth", "list", "--cwd", f.workspace],
    ["serve", "--cwd", f.workspace, "--read-only", "--no-resume", "--unauthenticated-loopback"],
  ])
    await expect(
      promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], { timeout: 10000, env }),
    ).rejects.toThrow();
  expect(await readdir(f.workspace)).not.toContain("auth");
});
async function retainFirstRun(workspace: string) {
  const journal = join(workspace, ".orca-first-run-ownership"),
    attempt = join(journal, "000001");
  await mkdir(journal, { mode: 0o700 });
  await mkdir(attempt, { mode: 0o700 });
  const directory = fenceDirectory(workspace),
    boot = fenceBoot();
  fenceWrite(join(workspace, ".orca-first-run-ownership.json"), {
    version: 1,
    workspace: directory,
    journal: fenceDirectory(journal),
  });
  const claim = {
    version: 2,
    reservationId: randomUUID(),
    workspace: directory,
    configHash: fenceHash(await readFile(join(workspace, "orca.config.yaml"), "utf8")),
    previous: null,
    launchHash: fenceHash(randomUUID()),
    fence: "kernel-lifetime-v1",
    boot,
    store: fenceDirectory(join(workspace, ".orca")),
  };
  fenceWrite(join(attempt, "claim.json"), claim);
  const claimBytes = await readFile(join(attempt, "claim.json"), "utf8");
  fenceWrite(join(attempt, "writer.json"), {
    version: 1,
    contract: "kernel-lifetime-v1",
    reservationId: claim.reservationId,
    claimHash: fenceHash(claimBytes),
    workspace: directory,
    store: claim.store,
    processId: 7777,
    generation: randomUUID(),
    ...boot,
  });
  return { attempt, bytes: await readFile(join(attempt, "writer.json")) };
}
it("starts the real authenticated same-boot closed first-run child without adoption, credential rotation or run/config control", async () => {
  const f = await fixture();
  const retained = await retainFirstRun(f.workspace);
  const auth = openAuthDirectory(join(f.workspace, "auth"));
  await bootstrapLocalOwner(auth);
  const tokenFile = join(f.workspace, "auth", "local-client.token"),
    before = await readFile(tokenFile);
  f.owner.closeAdmission("a".repeat(64));
  await f.owner.capture();
  const permit = await f.owner.beginMigration();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cli, "serve", "--cwd", f.workspace, "--port", "0", "--read-only", "--no-resume"],
    {
      env: { ...process.env, ORCA_UPDATE_ATTEMPT: permit.attempt, ORCA_UPDATE_LAUNCH: permit.token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  const url = await new Promise<string>((done, reject) => {
    let bytes = "";
    child.stdout.on("data", (chunk) => {
      bytes += String(chunk);
      const match = /listening on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(bytes);
      if (match) done(match[1]!);
    });
    child.once("exit", () => reject(new Error("Closed child refused before listening")));
  });
  const client = new DaemonClient(url, fetch, {
    auth: new LocalDaemonToken({ url, workspace: f.workspace, tokenFile, env: {} }),
  });
  const hello = await client.hello("closed-source-test");
  expect(hello.capabilities).not.toContain("runs.control");
  expect(hello.methods).not.toContain("config.set");
  expect(hello.methods).not.toContain("runs.start");
  expect(hello.methods).not.toContain("agents.ping");
  expect(await readFile(tokenFile)).toEqual(before);
  expect(await readFile(join(retained.attempt, "writer.json"))).toEqual(retained.bytes);
  expect(await readdir(retained.attempt)).toEqual(["claim.json", "writer.json"]);
  expect(await f.owner.endMigration()).toBe(false);
  const ended = new Promise<void>((done) => child.once("close", () => done()));
  child.kill("SIGTERM");
  await ended;
  expect(child.exitCode).toBe(0);
  expect(await f.owner.endMigration()).toBe(true);
  expect(f.owner.snapshot.phase).toBe("validating");
});
it("refuses uncertified plugin startup before module execution", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "orca.config.yaml"), "storeDir: .orca\nplugins: ['./plugin.mjs']\n");
  await writeFile(
    join(f.workspace, "plugin.mjs"),
    "import {writeFileSync} from 'node:fs';writeFileSync(new URL('./executed',import.meta.url),'external-effect');export function register(){};",
  );
  f.owner.closeAdmission("a".repeat(64));
  await f.owner.capture();
  const permit = await f.owner.beginMigration();
  await expect(
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", cli, "serve", "--cwd", f.workspace, "--port", "0", "--read-only", "--no-resume"],
      {
        timeout: 10000,
        env: { ...process.env, ORCA_UPDATE_ATTEMPT: permit.attempt, ORCA_UPDATE_LAUNCH: permit.token },
      },
    ),
  ).rejects.toThrow();
  expect(await readdir(f.workspace)).not.toContain("executed");
});
it("refuses a surviving first-run writer on the same boot", async () => {
  const f = await fixture();
  await retainFirstRun(f.workspace);
  const kernel = await acquireFirstRunFence(fenceDirectory(f.workspace), () => "retained");
  try {
    f.owner.closeAdmission("a".repeat(64));
    await f.owner.capture();
    const permit = await f.owner.beginMigration();
    await expect(
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", cli, "serve", "--cwd", f.workspace, "--port", "0", "--read-only", "--no-resume"],
        {
          timeout: 10000,
          env: { ...process.env, ORCA_UPDATE_ATTEMPT: permit.attempt, ORCA_UPDATE_LAUNCH: permit.token },
        },
      ),
    ).rejects.toThrow();
  } finally {
    await new Promise<void>((done) => kernel.close(() => done()));
  }
});
