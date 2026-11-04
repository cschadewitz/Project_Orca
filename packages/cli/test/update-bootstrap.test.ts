/** Real CLI consumers and authenticated closed read-only startup with disposable auth. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, lstat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ClosedUpdateWindow, enterUpdateWriter, provisionUpdateWindow } from "@orca/protocol/update-window";
import { bootstrapLocalOwner, openAuthDirectory } from "@orca/daemon";
import { DaemonClient } from "../../app/src/client/daemon-client.js";
import { LocalDaemonToken } from "../../app/src/client/auth.js";
import { randomUUID } from "node:crypto";
import { fenceBoot, fenceDirectory, fenceHash, fenceWrite, acquireFirstRunFence } from "@orca/protocol/first-run-fence";

const roots: string[] = [],
  children: ChildProcess[] = [],
  owners: ClosedUpdateWindow[] = [],
  listeners: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await done;
    }
  for (const owner of owners.splice(0)) await owner.detach();
  for (const server of listeners.splice(0))
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
type FixtureLayout = { base: string; workspace: string; control: string };
async function fixture(beforeProvision?: (layout: FixtureLayout) => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    const base = await mkdtemp(join(process.cwd(), "orca-cli-update-"));
    roots.push(base);
    const workspace = join(base, "workspace"),
      control = join(base, "recovery");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(control, { mode: 0o700 });
    await mkdir(join(workspace, ".orca"), { mode: 0o700 });
    await writeFile(join(workspace, "orca.config.yaml"), "storeDir: .orca\n", { mode: 0o600 });
    const layout = { base, workspace, control };
    await beforeProvision?.(layout);
    try {
      await provisionUpdateWindow(layout.control, [layout.workspace]);
    } catch (error) {
      // Production has awaited partial listener cleanup. Select another disposable
      // identity only during initial provisioning, never after capture or child startup.
      await rm(base, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 4) throw error;
      continue;
    }
    const owner = new ClosedUpdateWindow(layout.control);
    owners.push(owner);
    return { ...layout, owner };
  }
}
/** Only for real contention injection: the cross-process fence itself keeps its fixed ports. */
function fixtureSlots(root: string): number[] {
  const start =
    20000 +
    (Number.parseInt(
      fenceHash(JSON.stringify(["orca-update-window-v1", fenceBoot().kernelDomain, fenceDirectory(root)])).slice(0, 8),
      16,
    ) %
      5000) *
      8;
  return Array.from({ length: 8 }, (_, slot) => start + slot);
}
async function occupy(port: number) {
  const server = createServer();
  listeners.push(server);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false }, () => {
      server.removeListener("error", reject);
      done();
    });
  });
  return server;
}

it("selects a fresh CLI fixture after initial contention and releases partially acquired slots", async () => {
  let abandoned: FixtureLayout | undefined, blocker: Server | undefined;
  const slots: number[] = [];
  const f = await fixture(async (layout) => {
    if (blocker) return;
    abandoned = layout;
    slots.push(...fixtureSlots(layout.workspace));
    blocker = await occupy(slots[7]!);
  });
  expect(blocker?.listening).toBe(true);
  expect(f.base).not.toBe(abandoned?.base);
  await expect(lstat(abandoned!.base)).rejects.toMatchObject({ code: "ENOENT" });
  f.owner.closeAdmission("a".repeat(64));
  expect(await f.owner.capture()).toBe(true);
  expect(f.owner.snapshot.phase).toBe("closed");
  await expect(enterUpdateWriter(f.workspace)).rejects.toThrow();
  await f.owner.detach();
  await new Promise<void>((done) => blocker!.close(() => done()));
  for (const port of slots) expect((await occupy(port)).listening).toBe(true);
});

it("bounds initial CLI fixture contention and cleans all exhausted trees", async () => {
  const attempted: FixtureLayout[] = [];
  const blockers = new Map<number, Server>();
  await expect(
    fixture(async (layout) => {
      attempted.push(layout);
      const port = fixtureSlots(layout.workspace)[7]!;
      if (!blockers.has(port)) blockers.set(port, await occupy(port));
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(attempted).toHaveLength(5);
  for (const layout of attempted) await expect(lstat(layout.base)).rejects.toMatchObject({ code: "ENOENT" });
  for (const server of blockers.values()) expect(server.listening).toBe(true);
});

it("propagates non-contention provisioning refusal without selecting another CLI fixture", async () => {
  const attempted: FixtureLayout[] = [];
  await expect(
    fixture(async (layout) => {
      attempted.push(layout);
      layout.control = layout.workspace;
    }),
  ).rejects.toThrow("Protected update window unavailable");
  expect(attempted).toHaveLength(1);
  await expect(lstat(attempted[0]!.base)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not resample a CLI fixture when a writer blocks capture after provisioning", async () => {
  const f = await fixture();
  const blocker = await occupy(fixtureSlots(f.workspace)[7]!);
  f.owner.closeAdmission("a".repeat(64));
  expect(await f.owner.capture()).toBe(false);
  expect(f.owner.snapshot.phase).toBe("draining");
  expect(blocker.listening).toBe(true);
  expect((await lstat(f.base)).isDirectory()).toBe(true);
});

it("provisions 128 CLI fixtures with at most eight concurrent allocations", async () => {
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let trial = 0; trial < 16; trial++) {
        const f = await fixture();
        expect(f.owner.snapshot.phase).toBe("open");
        expect(f.owner.snapshot.roots.map((root) => root.path)).toEqual([f.workspace]);
      }
    }),
  );
});

const cli = resolve("packages/cli/src/main.ts");
it("actual auth/init CLI routes refuse before protected writes while help remains usable", async () => {
  const f = await fixture();
  f.owner.closeAdmission("a".repeat(64));
  expect(await f.owner.capture()).toBe(true);
  // Three independent CLI processes, each paying for tsx to load the CLI: start them together
  // rather than one after another. Help writes nothing, so the check below still sees only what
  // the two refused routes could have left behind.
  const refusals = [
    ["auth", "list", "--cwd", f.workspace],
    ["init", "--dir", f.workspace],
  ].map((args) =>
    expect(
      promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], {
        timeout: 10000,
        env: { ...process.env, ORCA_UPDATE_LAUNCH: undefined, ORCA_UPDATE_ATTEMPT: undefined },
      }),
    ).rejects.toThrow(),
  );
  const [help] = await Promise.all([
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, "--help", "--cwd", f.workspace], {
      timeout: 10000,
    }),
    ...refusals,
  ]);
  expect(await readdir(f.workspace)).not.toContain("auth");
  expect(help.stdout).toContain("usage:");
});
it("replacement capability refuses ordinary serve and auth commands rather than weakening authentication", async () => {
  const f = await fixture();
  f.owner.closeAdmission("a".repeat(64));
  await f.owner.capture();
  const permit = await f.owner.beginMigration();
  const env = { ...process.env, ORCA_UPDATE_ATTEMPT: permit.attempt, ORCA_UPDATE_LAUNCH: permit.token };
  // Each refusal is its own process and writes nothing, so they run together.
  await Promise.all(
    [
      ["serve", "--cwd", f.workspace],
      ["auth", "list", "--cwd", f.workspace],
      ["serve", "--cwd", f.workspace, "--read-only", "--no-resume", "--unauthenticated-loopback"],
    ].map((args) =>
      expect(
        promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], { timeout: 10000, env }),
      ).rejects.toThrow(),
    ),
  );
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
  let output = "";
  const receiptReady = new Promise<void>((done, reject) => {
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("closed update validation: ")) done();
    });
    child.once("exit", () => reject(new Error("Closed receipt unavailable")));
  });
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
  await receiptReady;
  const receiptLine = output.split("\n").find((line) => line.startsWith("closed update validation: "));
  expect(receiptLine).toBeDefined();
  expect(JSON.parse(receiptLine!.slice("closed update validation: ".length))).toEqual({
    version: 1,
    target: { ...hello.identity, processId: child.pid },
    fenceId: permit.attempt,
    directory: join(f.workspace, ".orca"),
    epoch: "orca-file-stores-v1",
    work: "empty",
  });
  expect(output).not.toContain(permit.token);
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
