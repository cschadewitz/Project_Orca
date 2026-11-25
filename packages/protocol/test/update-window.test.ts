/** Real kernel slots and durable closure; synthetic trees are separate from Mac acceptance. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ClosedUpdateWindow,
  enterConfiguredUpdateWriters,
  enterUpdateWriter,
  provisionUpdateWindow,
  updateAdmissionOpen,
  updateExistingWorkAllowed,
  enrollUpdateWindowRoots,
  inspectUpdateWindowRoots,
  reanchorUpdateWindow,
  resetUpdateWindow,
  updateWindowResettable,
  type UpdateWriterLease,
} from "../src/update-window.js";

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(count = 1) {
  for (let attempt = 0; ; attempt++) {
    const base = await mkdtemp(join(process.cwd(), "orca-update-window-"));
    roots.push(base);
    const control = join(base, "control"),
      data = Array.from({ length: count }, (_, i) => join(base, "data-" + i));
    await mkdir(control, { mode: 0o700 });
    for (const root of data) await mkdir(root, { mode: 0o700 });
    try {
      await provisionUpdateWindow(control, data);
    } catch (error) {
      // Real fence slots must stay deterministic across processes. A fresh directory
      // changes their hash when fixture provisioning collides with another listener.
      await rm(base, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 4) throw error;
      continue;
    }
    const window = new ClosedUpdateWindow(control);
    closers.push(() => window.detach());
    return { base, control, data, window };
  }
}
async function writer(root: string, launch?: { attempt: string; token: string }) {
  const lease = await enterUpdateWriter(root, launch);
  if (!lease) throw new Error("missing fixture owner");
  closers.push(() => lease.close());
  return lease;
}
it("enrolls new managed roots before producers while retaining the existing app writer identity", async () => {
  const f = await fixture(),
    app = await writer(f.data[0]!);
  const next = join(f.base, "new-config");
  await mkdir(next, { mode: 0o700 });
  const original = await readFile(join(f.data[0]!, ".orca-update-window.json")); // rename-keep: persisted name kept on purpose
  const enrolled = await enrollUpdateWindowRoots(f.control, [next, join(next, "future-store")]);
  expect(enrolled.roots.map((root) => root.path)).toEqual([f.data[0]!, next].sort());
  expect(app.check()).toBe(true);
  expect(await readFile(join(f.data[0]!, ".orca-update-window.json"))).toEqual(original); // rename-keep: persisted name kept on purpose
  const child = await writer(next);
  expect(child.check()).toBe(true);
  const fresh = new ClosedUpdateWindow(f.control);
  closers.push(() => fresh.detach());
  fresh.closeAdmission("a".repeat(64));
  expect(await fresh.capture()).toBe(false);
  await app.close();
  await child.close();
  expect(await fresh.capture()).toBe(true);
});
it("refuses enrollment into a closed namespace or a broader overlapping root without publication", async () => {
  const f = await fixture(),
    next = join(f.base, "new-config");
  await mkdir(next, { mode: 0o700 });
  const original = await readFile(join(f.control, "window.json"));
  await expect(enrollUpdateWindowRoots(f.control, [f.base])).rejects.toThrow();
  expect(await readFile(join(f.control, "window.json"))).toEqual(original);
  f.window.closeAdmission("a".repeat(64));
  await expect(enrollUpdateWindowRoots(f.control, [next])).rejects.toThrow();
  await expect(readFile(join(next, ".orca-update-window.json"))).rejects.toMatchObject({ code: "ENOENT" }); // rename-keep: persisted name kept on purpose
});
it("torn added-root enrollment refuses ordinary work and preserves the original anchor", async () => {
  const f = await fixture(),
    app = await writer(f.data[0]!),
    next = join(f.base, "new-config");
  await mkdir(next, { mode: 0o700 });
  const original = await readFile(join(f.data[0]!, ".orca-update-window.json")); // rename-keep: persisted name kept on purpose
  await expect(
    enrollUpdateWindowRoots(f.control, [next], {
      fileSync: () => {
        throw new Error("Lost acknowledgement");
      },
    }),
  ).rejects.toThrow();
  expect(app.check()).toBe(false);
  expect(updateAdmissionOpen(f.data[0]!)).toBe(false);
  expect(() => inspectUpdateWindowRoots(f.control)).toThrow();
  expect(await readFile(join(f.data[0]!, ".orca-update-window.json"))).toEqual(original); // rename-keep: persisted name kept on purpose
});
it("closes admission before capture while existing writers finish naturally", async () => {
  const f = await fixture(2),
    lease = await writer(f.data[0]!);
  expect(updateAdmissionOpen(f.data[0]!)).toBe(true);
  f.window.closeAdmission("a".repeat(64));
  expect(updateAdmissionOpen(f.data[0]!)).toBe(false);
  expect(updateExistingWorkAllowed(f.data[0]!)).toBe(true);
  expect(lease.check()).toBe(true);
  expect(await f.window.capture()).toBe(false);
  await expect(enterUpdateWriter(f.data[1]!)).rejects.toThrow();
  await lease.close();
  expect(await f.window.capture()).toBe(true);
  expect(f.window.check()).toBe(true);
  expect(() => f.window.reopen()).toThrow();
});
it("retains closure on app recreation and only opens after validation", async () => {
  const f = await fixture();
  f.window.closeAdmission("a".repeat(64));
  expect(await f.window.capture()).toBe(true);
  await f.window.detach();
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
  const recovery = new ClosedUpdateWindow(f.control);
  closers.push(() => recovery.detach());
  expect(await recovery.capture()).toBe(true);
  recovery.setPhase("validating");
  recovery.setPhase("validated");
  recovery.reopen();
  await recovery.detach();
  expect((await writer(f.data[0]!)).check()).toBe(true);
});
it("does not permit two supervisors or concurrent capture", async () => {
  const f = await fixture();
  f.window.closeAdmission("a".repeat(64));
  const pending = f.window.capture();
  await expect(f.window.capture()).rejects.toThrow();
  expect(await pending).toBe(true);
  const other = new ClosedUpdateWindow(f.control);
  closers.push(() => other.detach());
  expect(await other.capture()).toBe(false);
});
it("detach seals immediately but retains all kernel slots until dispatched writes actually settle", async () => {
  const f = await fixture();
  f.window.closeAdmission("a".repeat(64));
  await f.window.capture();
  let finish!: () => void;
  const write = f.window.track(() => new Promise<void>((resolve) => (finish = resolve)));
  await Promise.resolve();
  const detached = f.window.detach();
  expect(f.window.check()).toBe(false);
  const fresh = new ClosedUpdateWindow(f.control);
  closers.push(() => fresh.detach());
  expect(await fresh.capture()).toBe(false);
  finish();
  await write;
  await detached;
  expect(await fresh.capture()).toBe(true);
});
it("only the original untouched approval may defer; durable stopping excludes defer", async () => {
  const f = await fixture();
  const candidate = "a".repeat(64);
  f.window.closeAdmission(candidate);
  const attempt = f.window.snapshot.attempt!;
  const fresh = new ClosedUpdateWindow(f.control);
  closers.push(() => fresh.detach());
  expect(fresh.beginDefer(candidate, attempt)).toBe(false);
  expect(f.window.beginDefer("b".repeat(64), attempt)).toBe(false);
  expect(f.window.beginDefer(candidate, attempt)).toBe(true);
  expect(updateExistingWorkAllowed(f.data[0]!)).toBe(true);
  expect(() => f.window.beginStop()).toThrow();
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
  expect(f.window.finishDefer(candidate, attempt)).toBe(true);
  f.window.closeAdmission(candidate);
  f.window.beginStop();
  expect(updateExistingWorkAllowed(f.data[0]!)).toBe(false);
  expect(f.window.beginDefer(candidate, f.window.snapshot.attempt!)).toBe(false);
  expect(await f.window.capture()).toBe(true);
  expect(f.window.snapshot.phase).toBe("closed");
});
it("keeps ordinary CLI and aliases out during a one-use closed migration", async () => {
  const f = await fixture(2);
  f.window.closeAdmission("b".repeat(64));
  await f.window.capture();
  const launch = await f.window.beginMigration();
  await expect(enterConfiguredUpdateWriters([join(f.data[0]!, "nested", "store")])).rejects.toThrow();
  await expect(enterUpdateWriter(f.data[0]!, { ...launch, token: randomUUID() })).rejects.toThrow();
  const child = await writer(f.data[0]!, launch);
  expect(child.check()).toBe(true);
  expect(f.window.check()).toBe(false);
  expect(await f.window.endMigration()).toBe(false);
  expect(() => f.window.reopen()).toThrow();
  await child.close();
  expect(await f.window.endMigration()).toBe(true);
  expect(f.window.check()).toBe(true);
  await f.window.detach();
  await expect(enterUpdateWriter(f.data[0]!, launch)).rejects.toThrow();
});
it("refuses lost control identity, replaced roots and unsafe/torn state", async () => {
  const f = await fixture();
  f.window.closeAdmission("a".repeat(64));
  await f.window.capture();
  await rename(f.control, f.control + "-old");
  await mkdir(f.control, { mode: 0o700 });
  expect(f.window.check()).toBe(false);
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
  await expect(provisionUpdateWindow(f.control, f.data)).rejects.toThrow();
});
it("refuses deletion of an enrolled anchor rather than provisioning it again", async () => {
  const f = await fixture();
  await rm(join(f.data[0]!, ".orca-update-window.json")); // rename-keep: persisted name kept on purpose
  await expect(provisionUpdateWindow(f.control, f.data)).rejects.toThrow();
});
it("refuses incomplete writes and cannot use a cached open decision", async () => {
  const f = await fixture();
  const lease = await writer(f.data[0]!);
  await writeFile(join(f.control, "window.json.tmp"), "torn", { mode: 0o600 });
  expect(lease.check()).toBe(false);
  expect(() => f.window.closeAdmission("a".repeat(64))).toThrow();
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
});
it("refuses nested roots, links, changed enrolled set and unknown candidate", async () => {
  const f = await fixture();
  await mkdir(join(f.data[0]!, "nested"));
  await expect(provisionUpdateWindow(f.control, [f.data[0]!, join(f.data[0]!, "nested")])).rejects.toThrow();
  const alias = join(f.base, "alias");
  await symlink(f.data[0]!, alias);
  await expect(enterUpdateWriter(alias)).rejects.toThrow();
  await expect(provisionUpdateWindow(f.control, [f.base])).rejects.toThrow();
  expect(() => f.window.closeAdmission("unknown")).toThrow();
});
it("permits bounded independent participating writers and refuses capacity overflow", async () => {
  const f = await fixture(),
    leases: UpdateWriterLease[] = [];
  for (let i = 0; i < 8; i++) leases.push(await writer(f.data[0]!));
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
  f.window.closeAdmission("a".repeat(64));
  expect(await f.window.capture()).toBe(false);
  for (const lease of leases) await lease.close();
  expect(await f.window.capture()).toBe(true);
});
async function child(root: string, launch?: { attempt: string; token: string }): Promise<ChildProcess> {
  const path = resolve("packages/protocol/src/update-window.ts");
  const script = `import { enterUpdateWriter } from ${JSON.stringify(path)}; const lease = await enterUpdateWriter(process.argv[1], ${JSON.stringify(launch)}); if (!lease) throw new Error('unmanaged'); process.stdout.write('HELD\\n'); setInterval(() => {}, 1000);`;
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  closers.push(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
      await new Promise<void>((done) => process.once("close", () => done()));
    }
  });
  await new Promise<void>((done, reject) => {
    process.stdout.once("data", (data) =>
      String(data).includes("HELD") ? done() : reject(new Error("child unavailable")),
    );
    process.once("exit", () => reject(new Error("child refused")));
  });
  return process;
}
it("a real surviving child blocks same-boot recovery after supervisor loss", async () => {
  const f = await fixture();
  f.window.closeAdmission("a".repeat(64));
  await f.window.capture();
  const launch = await f.window.beginMigration();
  const process = await child(f.data[0]!, launch);
  await f.window.detach();
  const fresh = new ClosedUpdateWindow(f.control);
  closers.push(() => fresh.detach());
  expect(await fresh.capture()).toBe(false);
  const exited = new Promise<void>((done) => process.once("close", () => done()));
  process.kill("SIGKILL");
  await exited;
  expect(await fresh.capture()).toBe(true);
  fresh.setPhase("restoring");
  fresh.setPhase("restored");
  expect(JSON.parse(await readFile(join(f.control, "window.json"), "utf8")).phase).toBe("restored");
});

const GUARD = ".orca-update-window.json"; // rename-keep: persisted name kept on purpose
/** What Migration Assistant or a Time Machine restore leaves: same path and bytes, new inode. */
async function recreate(path: string) {
  const before = path + "-before";
  await rename(path, before);
  await cp(before, path, { recursive: true });
  await rm(before, { recursive: true });
}
/** A home holding the control namespace, the app root and one enrolled workspace. */
async function home() {
  for (let attempt = 0; ; attempt++) {
    const base = await mkdtemp(join(process.cwd(), "orca-update-home-"));
    roots.push(base);
    const at = (dir: string) => ({ control: join(dir, "control"), app: join(dir, "app"), ws: join(dir, "ws") });
    const paths = at(join(base, "home"));
    for (const path of [join(base, "home"), ...Object.values(paths)]) await mkdir(path, { mode: 0o700 });
    try {
      await provisionUpdateWindow(paths.control, [paths.app]);
      await enrollUpdateWindowRoots(paths.control, [paths.ws]);
    } catch (error) {
      await rm(base, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 4) throw error;
      continue;
    }
    return { base, ...paths, moved: at(join(base, "moved")) };
  }
}
const enrolledPaths = (control: string) => inspectUpdateWindowRoots(control).roots.map((root) => root.path);

it("re-anchors an open, idle window whose directories were recreated with new inodes", async () => {
  const f = await fixture(2),
    id = f.window.snapshot.id;
  for (const path of [f.control, ...f.data]) await recreate(path);
  expect(() => inspectUpdateWindowRoots(f.control)).toThrow();
  await expect(enterUpdateWriter(f.data[1]!)).rejects.toThrow();
  const state = await reanchorUpdateWindow(f.control, [f.data[0]!]);
  expect(state).toMatchObject({ id, phase: "open", attempt: null });
  const inodes = await Promise.all(f.data.map(async (path) => String((await stat(path)).ino)));
  expect(state.roots.map((root) => root.ino)).toEqual(inodes);
  for (const root of f.data) expect((await writer(root)).check()).toBe(true);
});

it("follows a moved home: the app root is re-anchored and workspaces left behind are de-enrolled", async () => {
  const f = await home();
  await rename(join(f.base, "home"), join(f.base, "moved"));
  await expect(reanchorUpdateWindow(f.moved.control, [f.moved.app])).resolves.toMatchObject({ phase: "open" });
  expect(enrolledPaths(f.moved.control)).toEqual([f.moved.app]);
  // The moved workspace keeps this namespace's guard, which refuses writers until enrolled again.
  await expect(enterUpdateWriter(f.moved.ws)).rejects.toThrow();
  await enrollUpdateWindowRoots(f.moved.control, [f.moved.ws]);
  expect(enrolledPaths(f.moved.control)).toEqual([f.moved.app, f.moved.ws]);
  expect((await writer(f.moved.ws)).check()).toBe(true);
});

it("de-enrolls a deleted workspace, and one whose guard was removed, rather than refusing", async () => {
  const f = await fixture(3);
  await rm(f.data[1]!, { recursive: true });
  await rm(join(f.data[2]!, GUARD));
  expect(() => inspectUpdateWindowRoots(f.control)).toThrow();
  await reanchorUpdateWindow(f.control, [f.data[0]!]);
  expect(enrolledPaths(f.control)).toEqual([f.data[0]]);
  // Writers there went unfenced while the guard was missing: no guard is recreated for them.
  await expect(readFile(join(f.data[2]!, GUARD))).rejects.toMatchObject({ code: "ENOENT" });
});

it("recovers a torn first provisioning that never committed its enrollment", async () => {
  const f = await fixture(1),
    data = f.data[0]!;
  await f.window.detach();
  await rm(join(f.control, "enrolled.json"));
  await writeFile(join(data, GUARD), '{"version":1,', { mode: 0o600 });
  await expect(provisionUpdateWindow(f.control, [data])).rejects.toThrow();
  await reanchorUpdateWindow(f.control, [data]);
  const lease = await writer(data);
  expect(lease.check()).toBe(true);
  await lease.close();
  // A torn window.json behind no enrollment is discarded and provisioned again.
  await rm(join(data, GUARD));
  await rm(join(f.control, "enrolled.json"));
  await writeFile(join(f.control, "window.json"), "", { mode: 0o600 });
  await writeFile(join(f.control, "window.json.tmp"), "torn", { mode: 0o600 });
  await provisionUpdateWindow(f.control, [data]);
  expect(enrolledPaths(f.control)).toEqual([data]);
  expect((await readdir(f.control)).sort()).toEqual(["enrolled.json", "window.json"]);
});

it.each([
  { at: 1, boundary: "before window publication", retained: false },
  { at: 3, boundary: "after window and guard publication", retained: true },
])("re-anchors enrollment torn $boundary", async ({ at, retained }) => {
  for (let attempt = 0; ; attempt++) {
    const f = await fixture(),
      next = join(f.base, "next");
    await mkdir(next, { mode: 0o700 });
    const original = await readFile(join(f.control, "enrolled.json"));
    const lostAcknowledgement = new Error("Lost acknowledgement");
    let calls = 0;
    const error: unknown = await enrollUpdateWindowRoots(f.control, [next], {
      fileSync: () => {
        if (++calls === at) throw lostAcknowledgement;
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The control mutex or a new root's real kernel slots can collide before any
    // publication. That is not the injected tear: use a fresh fixture, bounded as
    // provisioning is above. Never retry once a durability boundary was reached.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE" && calls === 0 && attempt < 4) continue;
    expect(error).toBe(lostAcknowledgement);
    expect(calls).toBe(at);
    expect(await readFile(join(f.control, "enrolled.json"))).toEqual(original);
    const published = JSON.parse(await readFile(join(f.control, "window.json"), "utf8")) as {
      roots: { path: string }[];
    };
    expect(published.roots.map((root) => root.path).sort()).toEqual(retained ? [f.data[0], next].sort() : [f.data[0]]);
    if (retained) {
      expect(JSON.parse(await readFile(join(next, GUARD), "utf8"))).toMatchObject({ root: { path: next } });
      expect(await readFile(join(f.control, "enrolled.json.tmp"), "utf8")).toContain(next);
    } else {
      await expect(readFile(join(next, GUARD))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(f.control, "window.json.tmp"), "utf8")).toContain(next);
    }
    expect(() => inspectUpdateWindowRoots(f.control)).toThrow();
    expect(updateAdmissionOpen(f.data[0]!)).toBe(false);
    await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
    await reanchorUpdateWindow(f.control, [f.data[0]!]);
    expect(enrolledPaths(f.control)).toEqual(retained ? [f.data[0], next].sort() : [f.data[0]]);
    expect((await writer(retained ? next : f.data[0]!)).check()).toBe(true);
    return;
  }
});

it("keeps refusing while an attempt is recorded, a writer holds a slot, or the original still exists", async () => {
  const f = await fixture(2);
  const lease = await writer(f.data[1]!);
  await rm(join(f.data[1]!, GUARD));
  await expect(reanchorUpdateWindow(f.control, [f.data[0]!])).rejects.toThrow();
  await lease.close();
  // A copy of the namespace never takes over the original's roots.
  await cp(f.control, f.control + "-copy", { recursive: true });
  await expect(reanchorUpdateWindow(f.control + "-copy", [f.data[0]!])).rejects.toThrow();
  f.window.closeAdmission("a".repeat(64));
  const published = await readFile(join(f.control, "window.json"));
  await recreate(f.control);
  await expect(reanchorUpdateWindow(f.control, [f.data[0]!])).rejects.toThrow();
  expect(await readFile(join(f.control, "window.json"))).toEqual(published);
  expect(updateWindowResettable(f.control, [f.data[0]!])).toBe(false);
  await expect(resetUpdateWindow(f.control, [f.data[0]!])).rejects.toThrow();
});

it.each(["missing", "torn"])(
  "refuses a copied namespace with %s enrollment while the original still exists",
  async (enrollment) => {
    const f = await fixture();
    const copy = f.control + "-copy";
    const copiedApp = f.data[0]! + "-copy";
    await cp(f.control, copy, { recursive: true });
    await cp(f.data[0]!, copiedApp, { recursive: true });
    if (enrollment === "missing") await rm(join(copy, "enrolled.json"));
    else await writeFile(join(copy, "enrolled.json"), "{", { mode: 0o600 });
    // The copied open record must not reopen roots whose original closed after the copy.
    f.window.closeAdmission("a".repeat(64));
    const guards = await Promise.all(f.data.map((root) => readFile(join(root, GUARD))));
    await expect(reanchorUpdateWindow(copy, [f.data[0]!])).rejects.toThrow();
    await expect(reanchorUpdateWindow(copy, [copiedApp])).rejects.toThrow();
    expect(await Promise.all(f.data.map((root) => readFile(join(root, GUARD))))).toEqual(guards);
    for (const root of f.data) expect(updateAdmissionOpen(root)).toBe(false);
  },
);

it("an interrupted reset removes enrollment before it can lose the last guard and window", async () => {
  const f = await fixture(2),
    data = f.data[0]!;
  await writeFile(join(f.control, "window.json"), "{", { mode: 0o600 });
  // Force an unlink failure after window.json has been removed, as an interrupted reset.
  await mkdir(join(f.control, "window.json.tmp"));
  const workspaceGuard = await readFile(join(f.data[1]!, GUARD));
  await expect(resetUpdateWindow(f.control, [data])).rejects.toThrow();
  await expect(readFile(join(f.control, "enrolled.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.data[1]!, GUARD))).toEqual(workspaceGuard);
  await rm(join(f.control, "window.json.tmp"), { recursive: true });
  await provisionUpdateWindow(f.control, [data]);
  await enrollUpdateWindowRoots(f.control, [f.data[1]!]);
  expect(enrolledPaths(f.control)).toEqual(f.data);
});

it("a person may reset only a lost or unreadable window, and provisioning then starts again", async () => {
  const f = await fixture(2),
    data = f.data[0]!;
  expect(updateWindowResettable(f.control, [data])).toBe(false);
  await f.window.detach();
  await rm(f.control, { recursive: true });
  await mkdir(f.control, { mode: 0o700 });
  await expect(provisionUpdateWindow(f.control, [data])).rejects.toThrow();
  expect(updateWindowResettable(f.control, [data])).toBe(true);
  await resetUpdateWindow(f.control, [data]);
  await expect(readFile(join(data, GUARD))).rejects.toMatchObject({ code: "ENOENT" });
  await provisionUpdateWindow(f.control, [data]);
  // The other root's guard names this control path, so enrolling it again replaces it.
  await enrollUpdateWindowRoots(f.control, [f.data[1]!]);
  expect(enrolledPaths(f.control)).toEqual(f.data);
  await writeFile(join(f.control, "window.json"), "{", { mode: 0o600, flag: "w" });
  expect(updateWindowResettable(f.control, [data])).toBe(true);
  // Even without an enrollment, a torn window beside a surviving guard is kept and refused.
  await rm(join(f.control, "enrolled.json"));
  await expect(provisionUpdateWindow(f.control, [data])).rejects.toThrow();
  expect(await readFile(join(f.control, "window.json"), "utf8")).toBe("{");
});

it("refuses to replace a guard written by another namespace", async () => {
  const f = await fixture(),
    other = await fixture(),
    target = other.data[0]!;
  await expect(enrollUpdateWindowRoots(f.control, [target])).rejects.toThrow();
  expect(enrolledPaths(other.control)).toEqual([target]);
});
