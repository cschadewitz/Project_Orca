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
import { createServer, type Server } from "node:net";
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
async function fixtureRoot() {
  const base = await mkdtemp(join(process.cwd(), "orca-cli-update-"));
  roots.push(base);
  const workspace = join(base, "workspace"),
    control = join(base, "recovery");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(control, { mode: 0o700 });
  await mkdir(join(workspace, ".orca"), { mode: 0o700 });
  await writeFile(join(workspace, "orca.config.yaml"), "storeDir: .orca\n", { mode: 0o600 });
  return { base, workspace, control };
}
type FixtureRoot = Awaited<ReturnType<typeof fixtureRoot>>;
function ownFixture(f: FixtureRoot, createOwner = (control: string) => new ClosedUpdateWindow(control)) {
  const owner = createOwner(f.control);
  owners.push(owner);
  return { ...f, owner };
}
async function fixture() {
  const f = await fixtureRoot();
  await provisionUpdateWindow(f.control, [f.workspace]);
  return ownFixture(f);
}
async function discardFixtureRoot(f: FixtureRoot) {
  // Remove only this unadmitted candidate; retain registration if removal fails.
  await rm(f.base, { recursive: true, force: true });
  const index = roots.indexOf(f.base);
  if (index < 0) throw new Error("Unadmitted fixture registration unavailable");
  roots.splice(index, 1);
}
async function admitPluginFixture(
  create = fixtureRoot,
  provision: (control: string, workspaces: readonly string[]) => Promise<void> = provisionUpdateWindow,
  discard = discardFixtureRoot,
) {
  // Same five initial-provision candidates as the protocol fixture. This does
  // not nest with the separate first-run fence allocator or retry the scenario.
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = await create();
    try {
      await provision(f.control, [f.workspace]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE") throw error;
      let cleanupFailed = false;
      let cleanupFailure: unknown;
      try {
        // provision has awaited its own listener cleanup before rejecting.
        await discard(f);
      } catch (cleanup) {
        cleanupFailed = true;
        cleanupFailure = cleanup;
      }
      if (cleanupFailed)
        throw new AggregateError([error, cleanupFailure], "Initial fixture cleanup uncertain", { cause: error });
      if (attempt === 4) throw error;
      continue;
    }
    return f;
  }
  throw new Error("Initial fixture admission exhausted");
}
async function pluginFixture(
  create = fixtureRoot,
  provision: (control: string, workspaces: readonly string[]) => Promise<void> = provisionUpdateWindow,
  discard = discardFixtureRoot,
  createOwner = (control: string) => new ClosedUpdateWindow(control),
) {
  // Owner construction is after admission, outside every resampling catch.
  return ownFixture(await admitPluginFixture(create, provision, discard), createOwner);
}
async function allocateHeldFirstRunFence<T extends { workspace: string; discard(): Promise<void> }>(
  create: () => Promise<T>,
  acquire = acquireFirstRunFence,
) {
  let occupied: unknown;
  for (let attempt = 0; attempt < 16; attempt++) {
    const f = await create();
    try {
      // Allocate only disposable fixture identities before first-run ownership evidence.
      // Keep this exact socket open through the assertion; production never changes ports.
      const kernel = await acquire(fenceDirectory(f.workspace), () => "retained");
      return { ...f, kernel };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      occupied = error;
      await f.discard();
    }
  }
  throw new Error("No free initial fixture fence after 16 fresh workspaces", { cause: occupied });
}
async function heldFirstRunFixture(acquire = acquireFirstRunFence) {
  return allocateHeldFirstRunFence(async () => {
    const f = await fixture();
    return {
      ...f,
      async discard() {
        await f.owner.detach();
        owners.splice(owners.indexOf(f.owner), 1);
        await rm(f.base, { recursive: true, force: true });
        roots.splice(roots.indexOf(f.base), 1);
      },
    };
  }, acquire);
}
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
  const f = await pluginFixture();
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
  const f = await heldFirstRunFixture();
  try {
    await retainFirstRun(f.workspace);
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
    await new Promise<void>((done) => f.kernel.close(() => done()));
  }
});

it("first-run fence fixture replaces only an unreserved colliding identity and retains the exact fence", async () => {
  const attempted: string[] = [];
  const collision = Object.assign(new Error("synthetic occupied setup port"), { code: "EADDRINUSE" });
  const f = await heldFirstRunFixture(async (workspace, observation) => {
    attempted.push(workspace.path);
    expect(await readdir(workspace.path)).not.toContain(".orca-first-run-ownership");
    if (attempted.length === 1) throw collision;
    return acquireFirstRunFence(workspace, observation);
  });
  try {
    expect(attempted.length).toBeGreaterThanOrEqual(2);
    expect(attempted.length).toBeLessThanOrEqual(16);
    expect(new Set(attempted).size).toBe(attempted.length);
    for (const workspace of attempted.slice(0, -1))
      await expect(readdir(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.workspace).toBe(attempted.at(-1));
    await expect(acquireFirstRunFence(fenceDirectory(f.workspace), () => undefined)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  } finally {
    await new Promise<void>((done) => f.kernel.close(() => done()));
  }
});

it("first-run fence fixture stops after the existing 16 fresh-workspace allocation bound", async () => {
  const attempted: string[] = [],
    discarded: string[] = [];
  const collision = Object.assign(new Error("synthetic occupied setup port"), { code: "EADDRINUSE" });
  await expect(
    allocateHeldFirstRunFence(
      async () => {
        // This unit control needs disposable identities, not update-window sockets.
        // Real provisioning and exact held-socket refusal remain in the tests above.
        const workspace = await mkdtemp(join(process.cwd(), "orca-fence-allocation-"));
        roots.push(workspace);
        return {
          workspace,
          async discard() {
            await rm(workspace, { recursive: true, force: true });
            roots.splice(roots.indexOf(workspace), 1);
            discarded.push(workspace);
          },
        };
      },
      async (workspace) => {
        attempted.push(workspace.path);
        throw collision;
      },
    ),
  ).rejects.toMatchObject({ message: "No free initial fixture fence after 16 fresh workspaces", cause: collision });
  expect(new Set(attempted).size).toBe(16);
  expect(discarded).toEqual(attempted);
  for (const workspace of attempted) await expect(readdir(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});

it("first-run fence fixture propagates other setup failures without retry", async () => {
  let attempts = 0;
  const refused = Object.assign(new Error("synthetic setup refusal"), { code: "EACCES" });
  await expect(
    heldFirstRunFixture(async () => {
      attempts++;
      throw refused;
    }),
  ).rejects.toBe(refused);
  expect(attempts).toBe(1);
});

// Test controls use only these disposable fixtures' deterministic update slots.
function initialFixturePort(workspace: string, slot: number) {
  return (
    20000 +
    (Number.parseInt(
      fenceHash(JSON.stringify(["orca-update-window-v1", fenceBoot().kernelDomain, fenceDirectory(workspace)])).slice(
        0,
        8,
      ),
      16,
    ) %
      5000) *
      8 +
    slot
  );
}
async function withInitialFixtureSockets(action: (listen: (port: number) => Promise<Server>) => Promise<void>) {
  const held: Server[] = [];
  let failed = false;
  let failure: unknown;
  try {
    await action(async (port) => {
      const server = createServer((socket) => socket.destroy());
      server.maxConnections = 1;
      held.push(server); // Own the control before listen can fail.
      try {
        await new Promise<void>((done, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false }, () => {
            server.removeListener("error", reject);
            done();
          });
        });
      } catch (cause) {
        // A failed control is not evidence of the intended production refusal.
        throw new Error("Owned initial-fixture socket control unavailable", { cause });
      }
      return server;
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanup: unknown[] = [];
  for (const server of held.splice(0).reverse()) {
    try {
      await new Promise<void>((done, reject) =>
        server.close((error) => {
          // A failed listen never acquired a listening handle.
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else done();
        }),
      );
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (cleanup.length)
    throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, "Owned fixture socket cleanup uncertain");
  if (failed) throw failure;
}

it("plugin fixture admission resamples a real owned slot refusal before a single scenario", async () => {
  const attempted: FixtureRoot[] = [];
  const observations: { error: unknown; port: number; held: boolean; control: string[]; workspace: string[] }[] = [];
  let creates = 0;
  const f = await pluginFixture(
    async () => {
      const candidate = await fixtureRoot();
      creates++;
      attempted.push(candidate);
      return candidate;
    },
    async (control, workspaces) => {
      const workspace = workspaces[0]!;
      if (creates !== 1) {
        // Unrelated contention in the success control must fail visibly, not be
        // mistaken for another intentional blocker or hidden by resampling.
        try {
          await provisionUpdateWindow(control, workspaces);
        } catch (cause) {
          throw new Error("Fresh fixture success control failed", { cause });
        }
        return;
      }
      await withInitialFixtureSockets(async (listen) => {
        const port = initialFixturePort(workspace, 4);
        const blocker = await listen(port);
        const error: unknown = await provisionUpdateWindow(control, workspaces).then(
          () => undefined,
          (error: unknown) => error,
        );
        observations.push({
          error,
          port,
          held: blocker.listening,
          control: await readdir(control),
          workspace: await readdir(workspace),
        });
        // Only the four known earlier slots, once each; no listener scan. Hold
        // them until cleanup so successful binds cannot be mistaken for a leak.
        for (let slot = 0; slot < 4; slot++) await listen(initialFixturePort(workspace, slot));
        if (!(error instanceof Error))
          throw new Error("Owned blocker did not yield an initial provisioning error", { cause: error });
        throw error;
      });
    },
  );
  // All assertions are outside fixture admission and execute once.
  expect(creates).toBe(2);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    error: { code: "EADDRINUSE", address: "127.0.0.1", port: observations[0]!.port },
    held: true,
    control: [],
  });
  expect(observations[0]!.workspace.sort()).toEqual([".orca", "orca.config.yaml"]);
  expect(attempted[0]!.base).not.toBe(f.base);
  await expect(readdir(attempted[0]!.base)).rejects.toMatchObject({ code: "ENOENT" });
  expect(roots).not.toContain(attempted[0]!.base);
  expect(roots).toContain(f.base);
  expect(f.workspace).toBe(attempted[1]!.workspace);
  expect(owners.filter((owner) => owner === f.owner)).toHaveLength(1);
  expect(f.owner.snapshot.phase).toBe("open");
});

it("plugin fixture admission keeps the five-candidate provision bound", async () => {
  const created: FixtureRoot[] = [],
    discarded: FixtureRoot[] = [],
    ordering: string[] = [];
  const collision = Object.assign(new Error("synthetic initial provision collision"), { code: "EADDRINUSE" });
  await expect(
    admitPluginFixture(
      async () => {
        const base = `inert-${created.length}`;
        const f = { base, workspace: `${base}/workspace`, control: `${base}/recovery` };
        created.push(f);
        ordering.push(`create:${base}`);
        return f;
      },
      async () => {
        throw collision;
      },
      async (f) => {
        discarded.push(f);
        ordering.push(`discard:${f.base}`);
      },
    ),
  ).rejects.toBe(collision);
  expect(created).toHaveLength(5);
  expect(discarded).toEqual(created);
  expect(ordering).toEqual(created.flatMap((f) => [`create:${f.base}`, `discard:${f.base}`]));
});

it("plugin fixture admission waits for owned cleanup before creating another candidate", async () => {
  let entered!: () => void, release!: () => void;
  const cleanupEntered = new Promise<void>((done) => (entered = done));
  const cleanupReleased = new Promise<void>((done) => (release = done));
  const collision = Object.assign(new Error("injected initial collision"), { code: "EADDRINUSE" });
  let creates = 0,
    provisions = 0,
    settled = false;
  const pending = admitPluginFixture(
    async () => {
      const base = `inert-${++creates}`;
      return { base, workspace: `${base}/workspace`, control: `${base}/recovery` };
    },
    async () => {
      if (++provisions === 1) throw collision;
    },
    async () => {
      entered();
      await cleanupReleased;
    },
  ).then((result) => {
    settled = true;
    return result;
  });
  await cleanupEntered;
  try {
    expect(creates).toBe(1);
    expect(settled).toBe(false);
  } finally {
    release();
  }
  expect((await pending).base).toBe("inert-2");
  expect([creates, provisions]).toEqual([2, 2]);
});

it("plugin fixture admission never retries creation errors that resemble contention", async () => {
  const failure = Object.assign(new Error("injected creation failure"), { code: "EADDRINUSE" });
  let creates = 0,
    provisions = 0,
    discards = 0;
  await expect(
    admitPluginFixture(
      async () => {
        creates++;
        throw failure;
      },
      async () => {
        provisions++;
      },
      async () => {
        discards++;
      },
    ),
  ).rejects.toBe(failure);
  expect([creates, provisions, discards]).toEqual([1, 0, 0]);
});

it("plugin fixture admission propagates noncontention without resampling or discarding evidence", async () => {
  const failure = Object.assign(new Error("injected provisioning refusal"), { code: "EACCES" });
  let creates = 0,
    discards = 0;
  await expect(
    admitPluginFixture(
      async () => {
        creates++;
        return { base: "inert", workspace: "inert/workspace", control: "inert/recovery" };
      },
      async () => {
        throw failure;
      },
      async () => {
        discards++;
      },
    ),
  ).rejects.toBe(failure);
  expect([creates, discards]).toEqual([1, 0]);
});

it("plugin fixture admission retains both errors and stops when owned cleanup fails", async () => {
  const collision = Object.assign(new Error("injected provision collision"), { code: "EADDRINUSE" });
  const cleanup = new Error("injected owned cleanup uncertainty");
  let creates = 0,
    discards = 0;
  let caught: unknown;
  try {
    await admitPluginFixture(
      async () => {
        creates++;
        return { base: "inert", workspace: "inert/workspace", control: "inert/recovery" };
      },
      async () => {
        throw collision;
      },
      async () => {
        discards++;
        throw cleanup;
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([collision, cleanup]);
  expect((caught as AggregateError).cause).toBe(collision);
  expect([creates, discards]).toEqual([1, 1]);
});

it("plugin fixture admission never retries owner construction after successful provisioning", async () => {
  const failure = Object.assign(new Error("injected owner construction failure"), { code: "EADDRINUSE" });
  let creates = 0,
    provisions = 0,
    ownerCreates = 0,
    discards = 0;
  await expect(
    pluginFixture(
      async () => {
        creates++;
        return { base: "inert", workspace: "inert/workspace", control: "inert/recovery" };
      },
      async () => {
        provisions++;
      },
      async () => {
        discards++;
      },
      () => {
        ownerCreates++;
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect([creates, provisions, ownerCreates, discards]).toEqual([1, 1, 1, 0]);
});
