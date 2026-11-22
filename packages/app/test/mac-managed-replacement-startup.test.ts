/** The managed Mac startup gate over a synthetic backend and journal: real kernel slots and
 * window files on Linux. Darwin addon loading, F_FULLFSYNC and the Keychain are not exercised. */
import { fsyncSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fenceDirectory } from "@orca/protocol/first-run-fence";
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
import { copyToFenceDirectory, fencePorts, selectFenceDirectory } from "./fixtures/fence-ports.js";

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
      if (operation === "provisionReplacementRoot") {
        // A root this fixture creates gets an identity clear of kernel autobind (#807).
        let created = true;
        await mkdir(path, { mode: 0o700 }).catch(() => (created = false));
        if (created) await selectFenceDirectory(path, fencedAs(path));
      } else if (operation === "openRoot") {
        if (!(await lstat(path)).isDirectory()) throw new Error("fixture root unavailable");
      } else if (operation !== "closeRoot") throw new Error("fixture operation unavailable");
      return {};
    },
  };
}
type Layout = { base: string; home: string; appRoot: string; control: string; workspace: string };
/** Other paths a fixture directory's inode is fenced under: the same directory once its
 * home folder is renamed (prepareHomeMove). Selection keeps all of them clear of autobind. */
function fencedAs(path: string): string[] {
  const match = /^(.*\/orca-mac-startup-[^/]+)\/home(\/.*)?$/.exec(path);
  return match ? [`${match[1]}/renamed${match[2] ?? ""}`] : [];
}
function layout(base: string, home = join(base, "home")): Layout {
  const appRoot = join(home, "ORCA");
  return { base, home, appRoot, control: appRoot + "-native-replacement", workspace: join(home, "workspace") };
}
/** userData, its sibling control namespace and one workspace; provisioned and enrolled as main
 * does on a first launch unless `fresh`. A port collision retries with a fresh directory. */
async function installed(fresh = false, prepare?: (f: Layout) => Promise<void>): Promise<Layout> {
  for (let attempt = 0; ; attempt++) {
    const f = layout(await mkdtemp(join(process.cwd(), "orca-mac-startup-")));
    bases.push(f.base);
    for (const path of [f.home, f.appRoot, f.workspace]) await mkdir(path, { mode: 0o700 });
    // Fenced directories get identities whose slots kernel autobind cannot take (#807).
    for (const path of [f.appRoot, f.workspace]) await selectFenceDirectory(path, fencedAs(path));
    try {
      if (!fresh) {
        await provisionMacUpdateNamespace(f.control, [f.appRoot], backend());
        await enrollMacUpdateRoots(f.control, [f.workspace], backend());
      }
      await prepare?.(f);
      return f;
    } catch (error) {
      await rm(f.base, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 4) throw error;
    }
  }
}
async function holdFixtureSlot(identity: ReturnType<typeof fenceDirectory>, slot: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: fencePorts(identity)[slot], exclusive: true, reusePort: false }, resolve);
  });
  return server;
}
/** Probe before the scenario, never retry a startup outcome or change production ownership. */
async function probeUnownedSlots(identities: ReturnType<typeof fenceDirectory>[]): Promise<void> {
  const held: Server[] = [];
  try {
    for (const identity of identities)
      for (let slot = 0; slot < 8; slot++) held.push(await holdFixtureSlot(identity, slot));
  } finally {
    for (const server of held) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function prepareFirstLaunch(f: Layout): Promise<void> {
  await probeUnownedSlots([fenceDirectory(f.appRoot)]);
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
  await probeUnownedSlots(identities);
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
  // The copy's new inode is chosen clear of kernel autobind, like every fixture root (#807).
  await copyToFenceDirectory(path + "-before", path, (from, to) => cp(from, to, { recursive: true }), fencedAs(path));
  await rm(path + "-before", { recursive: true });
}
const enrolledPaths = (control: string) => inspectUpdateWindowRoots(control).roots.map((root) => root.path);

it("provisions on a first launch and opens ordinary startup", async () => {
  const f = await installed(true, prepareFirstLaunch);
  await expect(lstat(f.control)).rejects.toMatchObject({ code: "ENOENT" });
  const { startup, outcome } = await launch(f);
  expect(outcome).toBe("ordinary");
  expect(startup.bootstrap.ordinaryAllowed).toBe(true);
  expect(enrolledPaths(f.control)).toEqual([f.appRoot]);
});

it("selects a fresh fixture before startup when a provisioning slot is occupied", async () => {
  const candidates: Layout[] = [];
  const f = await installed(true, async (candidate) => {
    candidates.push(candidate);
    if (candidates.length === 1) {
      const held = await holdFixtureSlot(fenceDirectory(candidate.appRoot), 0);
      closers.push(() => new Promise<void>((resolve) => held.close(() => resolve())));
    }
    await prepareFirstLaunch(candidate);
  });
  expect(candidates.length).toBeGreaterThan(1);
  expect(f.base).not.toBe(candidates[0]?.base);
  await expect(lstat(f.control)).rejects.toMatchObject({ code: "ENOENT" });
  const { startup, outcome } = await launch(f);
  expect(outcome).toBe("ordinary");
  expect(startup.bootstrap.ordinaryAllowed).toBe(true);
});

it("keeps first-launch startup closed if a slot is occupied after fixture selection", async () => {
  const f = await installed(true, prepareFirstLaunch);
  const identity = fenceDirectory(f.appRoot);
  const held = await holdFixtureSlot(identity, 0);
  closers.push(() => new Promise<void>((resolve) => held.close(() => resolve())));
  await expect(probeUnownedSlots([identity])).rejects.toMatchObject({ code: "EADDRINUSE" });
  const { startup, outcome } = await launch(f);
  expect(outcome).toBe("unknown");
  expect(startup.bootstrap.ordinaryAllowed).toBe(false);
  expect(startup.bootstrap.existingWorkAllowed).toBe(false);
  expect(startup.resettable).toBe(false);
  await expect(lstat(join(f.control, "enrolled.json"))).rejects.toMatchObject({ code: "ENOENT" });
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
