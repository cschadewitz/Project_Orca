/** The managed Mac startup gate over a synthetic backend and journal: real kernel slots and
 * window files on Linux. Darwin addon loading, F_FULLFSYNC and the Keychain are not exercised. */
import { fsyncSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fenceBoot, fenceDirectory, fenceHash } from "@orca/protocol/first-run-fence";
import { enterUpdateWriter, inspectUpdateWindowRoots } from "@orca/protocol/update-window";
import { createManagedMacReplacementStartup } from "../src/main/mac-managed-replacement-startup.js";
import {
  createNativeClosedUpdateWindow,
  enrollMacUpdateRoots,
  provisionMacUpdateNamespace,
} from "../src/main/mac-update-namespace.js";
import { PosixFixtureNativeAdapter } from "../src/main/diagnostics/native-adapter.js";
import { nodeRecoveryFiles } from "../src/main/diagnostics/recovery-files.js";
import type { NativeStorageBackend } from "../src/main/diagnostics/native-storage.js";
import { SyntheticKeys } from "./recovery-preparation/implementation-fixture.js";

const GUARD = ".orca-update-window.json";
const bases: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});

/** Creates and opens private roots the way the packaged addon does; nothing else. */
function backend(): NativeStorageBackend {
  return {
    abi: 1,
    platform: "posix-fixture",
    replacementStorage: 1,
    flushDescriptorSync: (fd) => fsyncSync(fd),
    async call(operation, _root, _file, path) {
      if (operation === "provisionReplacementRoot") await mkdir(path, { mode: 0o700 }).catch(() => undefined);
      else if (operation === "openRoot") {
        if (!(await lstat(path)).isDirectory()) throw new Error("fixture root unavailable");
      } else if (operation !== "closeRoot") throw new Error("fixture operation unavailable");
      return {};
    },
  };
}
type Layout = { base: string; home: string; appRoot: string; control: string; workspace: string };
function layout(base: string, home = join(base, "home")): Layout {
  const appRoot = join(home, "ORCA");
  return { base, home, appRoot, control: appRoot + "-native-replacement", workspace: join(home, "workspace") };
}
/** userData, its sibling control namespace and one workspace; provisioned and enrolled as main
 * does on a first launch unless `fresh`. Only disposable preparation retries a port collision.
 * A fresh fixture probes appRoot slots while control is absent; it never starts/retries startup. */
async function installed(fresh = false, prepare?: (f: Layout) => Promise<void>): Promise<Layout> {
  for (let attempt = 0; ; attempt++) {
    const f = layout(await mkdtemp(join(process.cwd(), "orca-mac-startup-")));
    bases.push(f.base);
    for (const path of [f.home, f.appRoot, f.workspace]) await mkdir(path, { mode: 0o700 });
    let freshProbe = false;
    try {
      if (fresh) {
        // The hook can arrange a real preparation collision. Its own errors are
        // outside the retryable probe; no control inode or startup exists yet.
        await prepare?.(f);
        freshProbe = true;
        await probeSlots([fenceDirectory(f.appRoot)]);
      } else {
        await provisionMacUpdateNamespace(f.control, [f.appRoot], backend());
        await enrollMacUpdateRoots(f.control, [f.workspace], backend());
        await prepare?.(f);
      }
      return f;
    } catch (error) {
      await rm(f.base, { recursive: true, force: true });
      if (
        (fresh && !freshProbe) ||
        (error as NodeJS.ErrnoException | null | undefined)?.code !== "EADDRINUSE" ||
        attempt >= 4
      )
        throw error;
    }
  }
}
/** Select an unowned fixture before moving anything. Mirror update-window's kernel-port
 * mapping only here: the moved app writer must not share slots with later enrollment.
 * Require disjoint, available old/new ranges, including those re-anchoring will capture.
 * These probes close before the scenario; no startup/enrollment error is retried. */
async function prepareHomeMove(f: Layout): Promise<void> {
  const moved = layout(f.base, join(f.base, "renamed"));
  const identities = [
    fenceDirectory(f.appRoot),
    fenceDirectory(f.workspace),
    ...(["appRoot", "workspace", "control"] as const).map((key) => ({ ...fenceDirectory(f[key]), path: moved[key] })),
  ];
  await probeSlots(identities);
}
function fixtureSlots(identity: ReturnType<typeof fenceDirectory>): number[] {
  const start =
    20000 +
    (Number.parseInt(
      fenceHash(JSON.stringify(["orca-update-window-v1", fenceBoot().kernelDomain, identity])).slice(0, 8),
      16,
    ) %
      5000) *
      8;
  return Array.from({ length: 8 }, (_, slot) => start + slot);
}
/** A probe owns real listeners only until preparation returns. It is availability
 * selection, not a reservation or permission to retry any later startup outcome. */
async function probeSlots(identities: readonly ReturnType<typeof fenceDirectory>[]): Promise<void> {
  const held: Server[] = [];
  try {
    for (const identity of identities) {
      for (const port of fixtureSlots(identity)) {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false }, resolve);
        });
        held.push(server);
      }
    }
  } finally {
    for (const server of held) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
/** Test-owned contention, never a substitute socket mapping or production adapter. */
async function occupy(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false }, resolve);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
  closers.push(close);
  return { server, close };
}
async function launch(f: Pick<Layout, "appRoot" | "control">) {
  const startup = createManagedMacReplacementStartup({
    control: f.control,
    appRoot: f.appRoot,
    safeStorage: {} as never,
    fixture: {
      backend: backend(),
      journal: {
        native: new PosixFixtureNativeAdapter({ stopped: async () => true, moveNoReplace: async () => "refused" }),
        files: nodeRecoveryFiles,
        keys: new SyntheticKeys(),
        close: async () => {},
      },
    },
  });
  closers.push(() => startup.close());
  return { startup, outcome: await startup.initialize([f.appRoot]) };
}
/** What Migration Assistant or a Time Machine restore leaves: same path and bytes, new inode. */
async function recreate(path: string) {
  await rename(path, path + "-before");
  await cp(path + "-before", path, { recursive: true });
  await rm(path + "-before", { recursive: true });
}
const enrolledPaths = (control: string) => inspectUpdateWindowRoots(control).roots.map((root) => root.path);

it("provisions on a first launch and opens ordinary startup", async () => {
  const f = await installed(true);
  await expect(lstat(f.control)).rejects.toMatchObject({ code: "ENOENT" });
  const { startup, outcome } = await launch(f);
  expect(outcome).toBe("ordinary");
  expect(startup.bootstrap.ordinaryAllowed).toBe(true);
  expect(enrolledPaths(f.control)).toEqual([f.appRoot]);
});

it("keeps first startup unknown when a mapped app-root slot is occupied after preparation", async () => {
  const f = await installed(true);
  await expect(lstat(f.control)).rejects.toMatchObject({ code: "ENOENT" });
  const blocker = await occupy(fixtureSlots(fenceDirectory(f.appRoot))[7]!);
  const { startup, outcome } = await launch(f); // One original initialization; never retried.
  expect(outcome).toBe("unknown");
  expect(startup.bootstrap.ordinaryAllowed).toBe(false);
  expect(blocker.server.listening).toBe(true);
  await expect(lstat(join(f.appRoot, GUARD))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(f.control, "window.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await blocker.close();
  await probeSlots([fenceDirectory(f.appRoot)]); // Initial provisioning released its partial listeners.
});

it("resamples a blocked preparation before one genuine first startup", async () => {
  const attempted: Layout[] = [];
  let blocker: Awaited<ReturnType<typeof occupy>> | undefined;
  const f = await installed(true, async (candidate) => {
    if (attempted.length) {
      await expect(lstat(attempted.at(-1)!.base)).rejects.toMatchObject({ code: "ENOENT" });
      await blocker!.close();
    }
    attempted.push(candidate);
    if (attempted.length === 1) blocker = await occupy(fixtureSlots(fenceDirectory(candidate.appRoot))[7]!);
  });
  expect(attempted.length).toBeGreaterThanOrEqual(2);
  expect(attempted.length).toBeLessThanOrEqual(5);
  expect(f).toBe(attempted.at(-1));
  await expect(lstat(f.control)).rejects.toMatchObject({ code: "ENOENT" });
  const { startup, outcome } = await launch(f); // Startup begins only after selection, once.
  expect(outcome).toBe("ordinary");
  expect(startup.bootstrap.ordinaryAllowed).toBe(true);
  expect(enrolledPaths(f.control)).toEqual([f.appRoot]);
});

it("selects at most five unprovisioned candidates and releases partial preparation probes", async () => {
  const attempted: { fixture: Layout; ports: number[] }[] = [];
  const blockers = new Map<number, Awaited<ReturnType<typeof occupy>>>();
  await expect(
    installed(true, async (f) => {
      if (attempted.length)
        await expect(lstat(attempted.at(-1)!.fixture.base)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(f.control)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(f.appRoot, GUARD))).rejects.toMatchObject({ code: "ENOENT" });
      const ports = fixtureSlots(fenceDirectory(f.appRoot));
      attempted.push({ fixture: f, ports });
      const port = ports[7]!;
      if (!blockers.has(port)) blockers.set(port, await occupy(port));
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(attempted).toHaveLength(5);
  expect(new Set(attempted.map(({ fixture }) => fixture.base)).size).toBe(5);
  for (const { fixture } of attempted) await expect(lstat(fixture.base)).rejects.toMatchObject({ code: "ENOENT" });
  for (const { server } of blockers.values()) expect(server.listening).toBe(true);
  // The rejected candidates' probes released every non-blocker, including the
  // seven acquired before the deliberate last-slot collision. No startup ran.
  for (const port of new Set(attempted.flatMap(({ ports }) => ports))) {
    if (!blockers.has(port)) await (await occupy(port)).close();
  }
});

it.each([
  { label: "EACCES", failure: Object.assign(new Error("Private preparation failure"), { code: "EACCES" }) },
  { label: "EADDRINUSE", failure: Object.assign(new Error("Private preparation failure"), { code: "EADDRINUSE" }) },
  { label: "null", failure: null },
  { label: "undefined", failure: undefined },
  { label: "primitive", failure: 7 },
])("preserves a fresh preparation-hook $label without resampling", async ({ failure }) => {
  const attempted: Layout[] = [];
  await expect(
    installed(true, async (f) => {
      attempted.push(f);
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise exact unknown rejection identity, including primitives.
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(attempted).toHaveLength(1);
  await expect(lstat(attempted[0]!.base)).rejects.toMatchObject({ code: "ENOENT" });
});

it("resumes ordinary startup after Migration Assistant or Time Machine recreates every directory", async () => {
  const f = await installed();
  for (const path of [f.control, f.appRoot, f.workspace]) await recreate(path);
  const { startup, outcome } = await launch(f);
  expect(outcome).toBe("ordinary");
  expect(startup.resettable).toBe(false);
  expect(enrolledPaths(f.control)).toEqual([f.appRoot, f.workspace]);
});

it("resumes ordinary startup after the home folder moves, and enrolls the moved workspace again", async () => {
  const f = await installed(false, prepareHomeMove);
  const moved = layout(f.base, join(f.base, "renamed"));
  await rename(f.home, moved.home);
  const { startup, outcome } = await launch(moved);
  expect(outcome).toBe("ordinary");
  expect(startup.bootstrap.ordinaryAllowed).toBe(true);
  expect(startup.resettable).toBe(false);
  expect(enrolledPaths(moved.control)).toEqual([moved.appRoot]);
  await startup.enrollProtectedRoots([moved.workspace]);
  expect(enrolledPaths(moved.control)).toEqual([moved.appRoot, moved.workspace]);
  expect(startup.bootstrap.ordinaryAllowed).toBe(true);
  const writer = await enterUpdateWriter(moved.workspace);
  if (writer) closers.push(() => writer.close());
  expect(writer?.check()).toBe(true);
});

it("resumes ordinary startup after an enrolled workspace is deleted", async () => {
  const f = await installed();
  await rm(f.workspace, { recursive: true });
  const { outcome } = await launch(f);
  expect(outcome).toBe("ordinary");
  expect(enrolledPaths(f.control)).toEqual([f.appRoot]);
});

it.each([
  ["a torn window record", "window"],
  ["a torn app-root guard", "guard"],
  ["a lost enrollment acknowledgement", "temporary"],
] as const)("resumes ordinary startup after a crash left %s", async (_, torn) => {
  const f = await installed();
  if (torn === "window") {
    for (const path of [join(f.control, "enrolled.json"), join(f.appRoot, GUARD)]) await rm(path);
    await writeFile(join(f.control, "window.json"), '{"version":1,"id":', { mode: 0o600, flag: "w" });
  } else if (torn === "guard") {
    await rm(join(f.control, "enrolled.json"));
    await writeFile(join(f.appRoot, GUARD), "", { mode: 0o600, flag: "w" });
  } else await writeFile(join(f.control, "window.json.tmp"), "{", { mode: 0o600 });
  const { outcome } = await launch(f);
  expect(outcome).toBe("ordinary");
  expect(enrolledPaths(f.control)).toContain(f.appRoot);
});

it("keeps refusing while an attempt is in flight, in the window or in the journal", async () => {
  const f = await installed();
  createNativeClosedUpdateWindow(f.control, backend()).closeAdmission("a".repeat(64));
  expect((await launch(f)).outcome).toBe("closed");
  const published = await readFile(join(f.control, "window.json"));
  await recreate(f.control);
  const moved = await launch(f);
  expect(moved.outcome).toBe("unknown");
  expect(moved.startup.resettable).toBe(false);
  expect(await moved.startup.reset()).toBe(false);
  expect(await readFile(join(f.control, "window.json"))).toEqual(published);

  const journaled = await installed();
  await writeFile(join(journaled.control, "journal", "replacement.enc"), "record", { mode: 0o600 });
  const enrollment = await readFile(join(journaled.control, "enrolled.json"));
  await recreate(journaled.control);
  const recorded = await launch(journaled);
  expect(recorded.outcome).toBe("unknown");
  expect(recorded.startup.resettable).toBe(false);
  expect(await readFile(join(journaled.control, "enrolled.json"))).toEqual(enrollment);
});

it("keeps the former in-userData namespace closed and untouched", async () => {
  const f = await installed(true);
  await mkdir(join(f.appRoot, "native-replacement"), { mode: 0o700 });
  const { startup, outcome } = await launch(f);
  expect(outcome).toBe("closed");
  expect(startup.resettable).toBe(false);
  await expect(lstat(f.control)).rejects.toMatchObject({ code: "ENOENT" });
});

it("offers a reset for a lost control namespace, after which the next launch provisions", async () => {
  const f = await installed();
  await rm(f.control, { recursive: true });
  const lost = await launch(f);
  expect(lost.outcome).toBe("unknown");
  expect(lost.startup.resettable).toBe(true);
  expect(await lost.startup.reset()).toBe(true);
  await expect(readFile(join(f.appRoot, GUARD))).rejects.toMatchObject({ code: "ENOENT" });
  await lost.startup.close();
  const { startup, outcome } = await launch(f);
  expect(outcome).toBe("ordinary");
  // The workspace's guard names this control path, so enrolling it again replaces it.
  await startup.enrollProtectedRoots([f.workspace]);
  expect(enrolledPaths(f.control)).toEqual([f.appRoot, f.workspace]);
});
