/** Fresh-observation controls for one managed owner check invocation. Temporary roots and
 * synthetic lifetime/build ports only; no installed bridge or accepted build is implied. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createManagedTypedWorkspace,
  resolveManagedRootBinding,
  type ManagedRootInput,
} from "../src/typed-workspace-gate.js";

const probe = vi.hoisted(() => ({
  recording: false,
  lstat: [] as string[],
  realpath: 0,
  openTarget: "",
  afterOpen: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
    if (probe.recording) probe.lstat.push(String(args[0]));
    return fs.lstatSync(...args);
  }) as typeof fs.lstatSync;
  const realpathSync = Object.assign(
    (...args: Parameters<typeof fs.realpathSync>) => {
      probe.realpath++;
      return fs.realpathSync(...args);
    },
    { native: fs.realpathSync.native },
  ) as typeof fs.realpathSync;
  const openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...args);
    if (args[0] === probe.openTarget && probe.afterOpen) {
      const hook = probe.afterOpen;
      probe.afterOpen = undefined;
      hook();
    }
    return fd;
  }) as typeof fs.openSync;
  return { ...fs, default: { ...fs, lstatSync, realpathSync, openSync }, lstatSync, realpathSync, openSync };
});

const roots: string[] = [];
afterEach(async () => {
  probe.recording = false;
  probe.lstat = [];
  probe.realpath = 0;
  probe.openTarget = "";
  probe.afterOpen = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const ancestors = (path: string) => {
  const result: string[] = [];
  for (let cursor = path; ; cursor = dirname(cursor)) {
    result.push(cursor);
    if (dirname(cursor) === cursor) return result;
  }
};
const counts = (paths: readonly string[]) => {
  const result = new Map<string, number>();
  for (const path of paths) result.set(path, (result.get(path) ?? 0) + 1);
  return result;
};
async function recorded<T>(work: () => T | Promise<T>) {
  probe.lstat = [];
  probe.realpath = 0;
  probe.recording = true;
  try {
    await work();
  } finally {
    probe.recording = false;
  }
  return { lstat: counts(probe.lstat), realpath: probe.realpath };
}

/** Roots below a nested ancestor, so an ancestor can be swapped while child inodes stay. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "orca-managed-observations-"));
  roots.push(base);
  const nest = join(base, "nest");
  const config = join(nest, "workspace"),
    store = join(config, ".orca"),
    identityDirectory = join(store, "workspace-identity");
  const control = join(nest, "control"),
    releases = join(nest, "releases"),
    sidecar = join(config, "orca.permissions.json");
  for (const path of [nest, config, store, identityDirectory, control, releases]) await mkdir(path, { mode: 0o700 });
  const identity = join(identityDirectory, "id");
  const id = randomUUID() + "\n";
  await writeFile(identity, id, { mode: 0o600 });
  const roles: ManagedRootInput[] = [
    { role: "config", path: config },
    { role: "sidecar", path: sidecar },
    { role: "store", path: store },
  ];
  const binding = resolveManagedRootBinding(roles, control, releases);
  await writeFile(join(control, "never-typed"), `${hash(id)}\n${binding.rootBindingRef}\n`, { mode: 0o600 });
  const state = { owned: true, buildCurrent: true, inLifetime: undefined as (() => void) | undefined };
  const lifetime = vi.fn(() => {
    const hook = state.inLifetime;
    state.inLifetime = undefined;
    hook?.();
    if (!state.owned) throw new Error("synthetic lifetime lost");
    return undefined;
  });
  const build = vi.fn(() => {
    if (!state.buildCurrent) throw new Error("synthetic image changed");
    return undefined;
  });
  const owner = createManagedTypedWorkspace({
    binding,
    lifetime: { mode: "enrollment", assertCurrent: lifetime },
    assertBuildCurrent: build,
    qualify: vi.fn(async () => {
      throw new Error("no protected qualifier installed");
    }),
  });
  return {
    ...{ base, nest, config, store, identityDirectory, identity, control, releases, sidecar, roles, binding },
    owner,
    state,
    lifetime,
    build,
  };
}
async function enrolled() {
  const f = await fixture();
  await f.owner.enrollFresh();
  const available = await f.owner.currentStore();
  if (!available.available) throw new Error("fixture enrollment unavailable");
  return { ...f, active: available.binding };
}
/** Replace a directory by a symlink to itself renamed: every inode below it is unchanged. */
async function aliasDirectory(path: string) {
  await rename(path, `${path}-real`);
  await symlink(`${path}-real`, path);
}

it("observes each distinct root and ancestor once per resolution, without a second realpath walk", async () => {
  const f = await fixture();
  await writeFile(f.sidecar, "{}\n", { mode: 0o600 });
  const directories = new Set(
    [f.control, f.releases, f.config, f.store, f.identityDirectory].flatMap((path) => ancestors(path)),
  );
  const first = await recorded(() =>
    expect(resolveManagedRootBinding(f.roles, f.control, f.releases)).toEqual(f.binding),
  );
  expect(first.realpath).toBe(0);
  for (const path of directories) expect(first.lstat.get(path), path).toBe(1);
  // Present before the bounded read, then the fresh post-read named identity check.
  expect(first.lstat.get(f.sidecar)).toBe(2);
  expect(first.lstat.get(f.identity)).toBe(1);
  expect([...first.lstat.keys()].sort()).toEqual([...directories, f.sidecar, f.identity].sort());
  // A second resolution observes everything again; nothing crosses invocations.
  const second = await recorded(() =>
    expect(resolveManagedRootBinding(f.roles, f.control, f.releases)).toEqual(f.binding),
  );
  expect(second).toEqual(first);
});

it("checks each current fact once per assertion and twice for an inspected enrolled state", async () => {
  const f = await enrolled();
  // releases is in no marker path, so its count isolates owner check invocations.
  const assertion = await recorded(() => f.active.assertCurrent());
  expect(assertion.realpath).toBe(0);
  expect(assertion.lstat.get(f.releases)).toBe(1);
  expect(f.lifetime.mock.calls.length).toBeGreaterThan(0);
  const before = [f.lifetime.mock.calls.length, f.build.mock.calls.length];
  const inspected = await recorded(() => expect(f.owner.inspect().state).toBe("enrolled"));
  expect(inspected.lstat.get(f.releases)).toBe(2);
  expect([f.lifetime.mock.calls.length - before[0]!, f.build.mock.calls.length - before[1]!]).toEqual([2, 2]);
  // Repeated assertions observe again every time.
  const repeated = await recorded(() => {
    for (let i = 0; i < 5; i++) f.active.assertCurrent();
  });
  for (const [path, count] of assertion.lstat) expect(repeated.lstat.get(path), path).toBe(5 * count);
});

it.each(["ancestor", "control", "releases", "config", "store", "identity directory"] as const)(
  "refuses a %s replaced by a symlink to the same directory between invocations",
  async (target) => {
    const f = await enrolled();
    f.active.assertCurrent();
    const path = {
      ancestor: f.nest,
      control: f.control,
      releases: f.releases,
      config: f.config,
      store: f.store,
      "identity directory": f.identityDirectory,
    }[target];
    await aliasDirectory(path);
    expect(() => f.active.assertCurrent()).toThrow();
    expect(() => f.owner.inspect()).toThrow();
    expect((await f.owner.currentStore()).available).toBe(false);
    expect(() => resolveManagedRootBinding(f.roles, f.control, f.releases)).toThrow(/alias|identity|ownership/);
  },
);

it("an ancestor aliased by the only change below it is refused as a root alias", async () => {
  const f = await enrolled();
  await aliasDirectory(f.nest);
  // Every root inode is unchanged; only the per-component no-follow observation detects it.
  expect(() => f.active.assertCurrent()).toThrow("root alias");
  expect(() => resolveManagedRootBinding(f.roles, f.control, f.releases)).toThrow("root alias");
});

it.each(["ancestor alias", "replaced root", "replaced identity"] as const)(
  "observes a %s made synchronously inside the same invocation, before its own observations",
  async (change) => {
    const f = await enrolled();
    const { renameSync, symlinkSync, mkdirSync, readFileSync, writeFileSync } =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    f.active.assertCurrent();
    // The lifetime port runs first in each owner check; the mutation lands after it and
    // before that same invocation observes roots, so no earlier observation can satisfy it.
    f.state.inLifetime = () => {
      if (change === "ancestor alias") {
        renameSync(f.nest, `${f.nest}-real`);
        symlinkSync(`${f.nest}-real`, f.nest);
      } else if (change === "replaced root") {
        renameSync(f.releases, `${f.releases}-retired`);
        mkdirSync(f.releases, { mode: 0o700 });
      } else {
        const bytes = readFileSync(f.identity);
        renameSync(f.identity, `${f.identity}.retired`);
        writeFileSync(f.identity, bytes, { mode: 0o600 });
      }
    };
    expect(() => f.active.assertCurrent()).toThrow();
    expect(f.state.inLifetime).toBeUndefined();
  },
);

it.each(["lifetime", "build", "replaced root", "mode", "identity bytes", "sidecar alias", "marker"] as const)(
  "refuses %s changed between assertion invocations, on both assertion and inspected paths",
  async (change) => {
    const f = await enrolled();
    for (let i = 0; i < 4; i++) f.active.assertCurrent();
    if (change === "lifetime") f.state.owned = false;
    else if (change === "build") f.state.buildCurrent = false;
    else if (change === "replaced root") {
      await rename(f.store, `${f.store}-retired`);
      await mkdir(f.store, { mode: 0o700 });
    } else if (change === "mode") await chmod(f.releases, 0o720);
    else if (change === "identity bytes") {
      const bytes = await readFile(f.identity);
      await rename(f.identity, `${f.identity}.retired`);
      await writeFile(f.identity, bytes, { mode: 0o600 });
    } else if (change === "sidecar alias") await link(f.sidecar, join(f.base, "linked-policy"));
    else {
      const path = join(f.control, "enrolled.json");
      const marker = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
      await rename(path, `${path}.retired`);
      await writeFile(path, JSON.stringify({ ...marker, enrollmentRef: randomUUID() }), { mode: 0o600 });
    }
    expect(() => f.active.assertCurrent()).toThrow();
    expect(() => f.owner.inspect()).toThrow();
  },
);

it("an assertion observes ownership once, before its marker reads; read-for-use inspect re-checks after", async () => {
  const f = await enrolled();
  const enrolledMarker = join(f.control, "enrolled.json");
  // Read-for-use: a change made while the confirmed marker is open is refused by the
  // same inspect() call, because the returned state is used after these reads.
  probe.openTarget = enrolledMarker;
  probe.afterOpen = () => {
    f.state.owned = false;
  };
  expect(() => f.owner.inspect()).toThrow("synthetic lifetime lost");
  f.state.owned = true;
  f.active.assertCurrent();
  // Assertion only: its single ownership observation precedes the marker reads, as in
  // any one check invocation. The next invocation observes the change and refuses.
  probe.afterOpen = () => {
    f.state.owned = false;
  };
  expect(f.active.assertCurrent()).toBeUndefined();
  expect(probe.afterOpen).toBeUndefined();
  expect(() => f.active.assertCurrent()).toThrow("synthetic lifetime lost");
  expect((await f.owner.currentStore()).available).toBe(false);
});
