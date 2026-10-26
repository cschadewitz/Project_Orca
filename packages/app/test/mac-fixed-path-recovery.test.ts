/** Real disposable fixed-path copies and interrupted restore; no signing/continuity fiction. */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
  symlink,
  link,
  rename,
  lstat,
  chmod,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { fenceBoot, fenceDirectory, fenceHash } from "@orca/protocol/first-run-fence";
import { afterEach, expect, it as platformIt, vi } from "vitest";
import { ClosedUpdateWindow, enterUpdateWriter, provisionUpdateWindow } from "@orca/protocol/update-window";
import { createPairTreePort, type PairTreePort } from "../src/main/mac-fixed-path-files.js";
import { MacFixedPathRecovery, type FixedPathRecoveryPorts } from "../src/main/mac-fixed-path-recovery.js";
import { MacClosedWindowCommit } from "../src/main/mac-closed-window-commit.js";
import { MacClosedWindowValidation } from "../src/main/mac-closed-window-validation.js";
import { readMacManifest, sha256 } from "../src/main/mac-candidate-manifest.js";
import type { MacNativeCommitRequest } from "../src/main/mac-native-handoff.js";
import { randomUUID } from "node:crypto";

// The "posix-fixture" pair tree port is Linux-only fixture evidence and refuses elsewhere.
const it = platformIt.skipIf(process.platform !== "linux");
const roots: string[] = [],
  closers: (() => Promise<void>)[] = [];
const signal = () => new AbortController().signal;
const old = "a".repeat(64),
  candidate = "b".repeat(64),
  continuity = "c".repeat(64);
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
type FixtureLayout = { base: string; control: string; data: string[]; binary: string };
async function provisionFixture(beforeProvision?: (layout: FixtureLayout) => Promise<void>) {
  // Fence slots are fixed by each root's identity, so unrelated listeners (or two
  // roots hashing to one range) can refuse a new disposable fixture. Select another
  // tree only during initial provisioning; never retry capture or recovery operations.
  for (let attempt = 0; ; attempt++) {
    const base = await mkdtemp(join(process.cwd(), "orca-fixed-pair-"));
    roots.push(base);
    const control = join(base, "recovery"),
      data = [join(base, "app"), join(base, "store")],
      binary = join(base, "Orca.app");
    for (const path of [control, ...data, binary]) await mkdir(path, { mode: 0o700 });
    await writeFile(join(data[0]!, "intents.enc"), "protected-old", { mode: 0o600 });
    await writeFile(join(data[1]!, "history.json"), "old-history", { mode: 0o600 });
    await writeFile(join(binary, "manifest"), old, { mode: 0o600 });
    await beforeProvision?.({ base, control, data, binary });
    try {
      await provisionUpdateWindow(control, data);
    } catch (error) {
      // Provisioning awaits closure of every partial listener before rejecting.
      await rm(base, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 4) throw error;
      continue;
    }
    return { base, control, data, binary };
  }
}
async function fixture(candidateHash = candidate, beforeProvision?: (layout: FixtureLayout) => Promise<void>) {
  const { base, control, data, binary } = await provisionFixture(beforeProvision);
  const window = new ClosedUpdateWindow(control);
  closers.push(() => window.detach());
  window.closeAdmission(candidateHash);
  expect(await window.capture()).toBe(true);
  const trees = createPairTreePort("posix-fixture");
  const ports: FixedPathRecoveryPorts = {
    trees,
    verifyBinary: vi.fn(async (path, hash) => (await readFile(join(path, "manifest"), "utf8")) === hash),
    continuity: vi.fn(async () => continuity),
  };
  const recovery = new MacFixedPathRecovery(window, control, binary, ports);
  const changed = async () => {
    await writeFile(join(data[1]!, "history.json"), "migration-write", { mode: 0o600 });
    await writeFile(join(binary, "manifest"), candidate, { mode: 0o600 });
  };
  const fresh = async (override: Partial<FixedPathRecoveryPorts> = {}) => {
    await window.detach();
    const owner = new ClosedUpdateWindow(control);
    closers.push(() => owner.detach());
    expect(await owner.capture()).toBe(true);
    return { owner, recovery: new MacFixedPathRecovery(owner, control, binary, { ...ports, ...override }) };
  };
  return { base, control, data, binary, window, ports, trees, recovery, changed, fresh };
}
// Contention is injected with an owned kernel listener, never a free-port probe or a
// mocked fence. Mirror only the production identity mapping needed to occupy its slots.
function fixtureSlots(root: string) {
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
  const server: Server = createServer();
  const close = async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  closers.push(close);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return { server, close };
}
it("admits a fresh fixture after real initial slot contention and releases every abandoned listener", async () => {
  const abandoned: FixtureLayout[] = [],
    slots = new Set<number>();
  let blocker: Awaited<ReturnType<typeof occupy>> | undefined;
  const f = await fixture(candidate, async (layout) => {
    if (blocker) return;
    abandoned.push(layout);
    for (const root of layout.data) for (const port of fixtureSlots(root)) slots.add(port);
    // Late in the second root: provisioning must release its already acquired slots.
    blocker = await occupy(fixtureSlots(layout.data[1]!)[7]!);
  });
  expect(blocker!.server.listening).toBe(true);
  expect(f.base).not.toBe(abandoned[0]!.base);
  expect(f.window.check()).toBe(true);
  expect(f.window.snapshot.phase).toBe("closed");
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
  await expect(lstat(abandoned[0]!.base)).rejects.toMatchObject({ code: "ENOENT" });
  await f.window.detach();
  await blocker!.close();
  // Reacquire and retain the abandoned range, proving partial provisioning did not leak.
  for (const port of slots) expect((await occupy(port)).server.listening).toBe(true);
});
it("bounds initial fixture admission and cleans every exhausted tree while contenders remain owned", async () => {
  const attempted: FixtureLayout[] = [],
    blockers = new Map<number, Awaited<ReturnType<typeof occupy>>>();
  await expect(
    fixture(candidate, async (layout) => {
      attempted.push(layout);
      const port = fixtureSlots(layout.data[1]!)[7]!;
      if (!blockers.has(port)) blockers.set(port, await occupy(port));
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(attempted).toHaveLength(5);
  expect(new Set(attempted.map((layout) => layout.base)).size).toBe(5);
  for (const layout of attempted) await expect(lstat(layout.base)).rejects.toMatchObject({ code: "ENOENT" });
  for (const { server } of blockers.values()) expect(server.listening).toBe(true);
});
it("propagates a non-contention provisioning refusal without resampling the fixture", async () => {
  const attempted: FixtureLayout[] = [];
  await expect(
    fixture(candidate, async (layout) => {
      attempted.push(layout);
      // Invalid enrollment refuses before listening, independently of other test ports.
      layout.data.push(layout.data[0]!);
    }),
  ).rejects.toThrow("Protected update window unavailable");
  expect(attempted).toHaveLength(1);
  await expect(lstat(attempted[0]!.base)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([1, 123, 199, 999])("preserves millisecond %i through fixed-path copy and restore", async (fraction) => {
  const f = await fixture(),
    file = join(f.binary, "manifest"),
    copy = join(f.base, "timestamp-copy"),
    mtime = 1_700_000_000_000 + fraction,
    seconds = (mtime + 0.25) / 1000;
  await utimes(file, seconds, seconds);
  await symlink("manifest", join(f.binary, "current"));
  const original = await lstat(file),
    root = await lstat(f.binary),
    digest = await f.trees.digest(f.binary, signal());
  expect(Math.trunc(original.mtimeMs)).toBe(mtime);
  await f.trees.copy(f.binary, copy, signal());
  const verify = async (path: string) => {
    const stat = await lstat(join(path, "manifest"));
    expect(stat).toMatchObject({ mode: original.mode, uid: original.uid, gid: original.gid, size: original.size });
    expect(Math.trunc(stat.mtimeMs)).toBe(mtime);
    expect(await readFile(join(path, "manifest"), "utf8")).toBe(old);
    expect(await readlink(join(path, "current"))).toBe("manifest");
    expect(await f.trees.digest(path, signal())).toBe(digest);
  };
  await verify(copy);
  await verify(f.binary);
  // A real millisecond change must still be detected independently of bytes and modes.
  await utimes(file, (mtime + 1.5) / 1000, (mtime + 1.5) / 1000);
  expect(await f.trees.digest(f.binary, signal())).not.toBe(digest);
  await writeFile(file, "migration-write");
  await chmod(file, 0o640);
  await f.trees.restore(copy, f.binary, signal());
  expect(await lstat(f.binary)).toMatchObject({ dev: root.dev, ino: root.ino });
  await verify(f.binary);
  await verify(copy);
});
it("verifies every root and matching binary before replacement and restores migration writes while closed", async () => {
  const f = await fixture();
  const previous = await f.recovery.backupPrevious(old, signal());
  expect(previous.roots).toHaveLength(2);
  await f.changed();
  expect(await f.recovery.restore(old, candidate, signal())).toBe("restored-closed");
  expect(await readFile(join(f.data[1]!, "history.json"), "utf8")).toBe("old-history");
  expect(await readFile(join(f.binary, "manifest"), "utf8")).toBe(old);
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
  const pair = join(f.control, "pairs", f.window.snapshot.attempt!);
  expect(await readFile(join(pair, "current", "root-1", "history.json"), "utf8")).toBe("migration-write");
  expect(await readFile(join(pair, "current", "binary", "manifest"), "utf8")).toBe(candidate);
  expect(await f.recovery.restore(old, candidate, signal())).toBe("restored-closed");
});
async function commitFixture() {
  const raw = JSON.parse(
    await readFile(
      new URL(
        "../../../tools/deploy/tests/native-mac/fixtures/valid/delivery/native-mac-artifact.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  raw.kind = "candidate";
  const bytes = Buffer.from(JSON.stringify(raw)),
    manifest = readMacManifest(bytes),
    candidateHash = sha256(bytes);
  const f = await fixture(candidateHash);
  await f.window.detach();
  // Return to the already durably closed draining fixture only for this synthetic
  // handoff's natural-stop boundary. This is not production/native consent evidence.
  const record = JSON.parse(await readFile(join(f.control, "window.json"), "utf8")) as Record<string, unknown>;
  record.phase = "draining";
  await writeFile(join(f.control, "window.json"), JSON.stringify(record), { mode: 0o600 });
  const window = new ClosedUpdateWindow(f.control);
  closers.push(() => window.detach());
  const recovery = new MacFixedPathRecovery(window, f.control, f.binary, f.ports);
  const directory = join(f.base, "candidate");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "native-mac-artifact.json"), bytes, { mode: 0o600 });
  const target = { workspaceId: randomUUID(), instanceId: randomUUID(), epoch: 1 },
    previousTarget = { workspaceId: target.workspaceId, instanceId: target.instanceId, processId: 8100 },
    token = randomUUID();
  const request: MacNativeCommitRequest = {
    prepared: {
      scope: "preparation-only",
      directory,
      target,
      binding: {
        manifest,
        candidate: {
          manifestSha256: candidateHash,
          channel: "fixture",
          compatibilityPlanId: "fixture",
          recoveryPlanId: "fixture",
        },
        source: "https://delivery.invalid/",
      },
    },
    lease: {
      target,
      token,
      release: async () => "released",
      stopOwned: vi.fn(async () => ({ outcome: "stopped" as const, receipt: { target: previousTarget } })),
    },
  };
  const authorization = { token, previousTarget, previousManifestSha256: old };
  const ports = {
    window,
    recovery,
    storeDir: f.data[1]!,
    authorize: vi.fn(async () => authorization),
    pauseAppWriters: vi.fn(async () => true),
  };
  return { f, window, recovery, request, ports };
}
it("the existing native handoff gets readiness only after durable exact startup identity and verified old pair", async () => {
  const c = await commitFixture(),
    commit = new MacClosedWindowCommit(c.ports, 5000),
    prepare = commit.prepare;
  expect(await prepare(c.request)).toBe("ready");
  expect(c.request.lease.stopOwned).toHaveBeenCalledOnce();
  const identity = await c.recovery.readStartupIdentity(signal());
  expect(identity.previousTarget.processId).toBe(8100);
  expect(identity.candidate.manifestSha256).toBe(c.request.prepared.binding.candidate.manifestSha256);
  expect(identity.storeDir).toBe(c.f.data[1]!);
  expect(await prepare({ ...c.request })).toBe("unknown");
  expect(c.window.snapshot.phase).toBe("closed");
});
it("a failed replacement producer retains closure and cannot complete validation", async () => {
  const c = await commitFixture();
  expect(await new MacClosedWindowCommit(c.ports, 5000).prepare(c.request)).toBe("ready");
  const startClosed = vi.fn(async () => undefined),
    validation = new MacClosedWindowValidation(c.window, c.recovery, { startClosed }, 5000);
  expect(await validation.verify(signal())).toEqual({ outcome: "unknown" });
  expect(startClosed).toHaveBeenCalledOnce();
  const stop = vi.fn(async () => true);
  expect(await validation.finishAfterCleanChildExit(signal(), stop)).toBe("unknown");
  expect(stop).not.toHaveBeenCalled();
  expect(c.window.snapshot.phase).toBe("migrating");
  expect(() => c.window.reopen()).toThrow();
});
it("refuses a foreign approval before stop or pair mutation", async () => {
  const c = await commitFixture();
  Object.assign(c.request.lease, { token: randomUUID() });
  expect(await new MacClosedWindowCommit(c.ports, 5000).prepare(c.request)).toBe("unknown");
  expect(c.request.lease.stopOwned).not.toHaveBeenCalled();
  expect(await readdir(c.f.control)).not.toContain("pairs");
});
it("resumes a partial multi-root restore on the same boot without recapturing partial live state", async () => {
  const f = await fixture();
  await f.recovery.backupPrevious(old, signal());
  await f.changed();
  let count = 0;
  const trees: PairTreePort = {
    ...f.trees,
    restore: async (from, to, s) => {
      await f.trees.restore(from, to, s);
      if (++count === 2) throw new Error("lost restoration acknowledgement");
    },
  };
  const broken = new MacFixedPathRecovery(f.window, f.control, f.binary, { ...f.ports, trees });
  await expect(broken.restore(old, candidate, signal())).rejects.toThrow();
  expect(f.window.snapshot.phase).toBe("restoring");
  await expect(enterUpdateWriter(f.data[0]!)).rejects.toThrow();
  const fresh = await f.fresh();
  expect(await fresh.recovery.restore(old, candidate, signal())).toBe("restored-closed");
  expect(await readFile(join(f.binary, "manifest"), "utf8")).toBe(old);
  const current = join(f.control, "pairs", fresh.owner.snapshot.attempt!, "current");
  expect(await readFile(join(current, "root-1", "history.json"), "utf8")).toBe("migration-write");
});
it("preserves exact broken candidate bytes without claiming signature acceptance before restoring the matching previous binary", async () => {
  const f = await fixture();
  await f.recovery.backupPrevious(old, signal());
  await f.changed();
  await writeFile(join(f.binary, "manifest"), "partial-broken-candidate", { mode: 0o600 });
  const denied = new MacFixedPathRecovery(f.window, f.control, f.binary, {
    ...f.ports,
    verifyBinary: async (path, hash, s) => hash !== candidate && (await f.ports.verifyBinary(path, hash, s)),
  });
  expect(await denied.restore(old, candidate, signal())).toBe("restored-closed");
  const current = join(f.control, "pairs", f.window.snapshot.attempt!, "current");
  expect(await readFile(join(current, "binary", "manifest"), "utf8")).toBe("partial-broken-candidate");
  expect(JSON.parse(await readFile(join(current, "pair.json"), "utf8"))).toMatchObject({
    binaryVerified: false,
    manifestSha256: candidate,
  });
  expect(await readFile(join(f.binary, "manifest"), "utf8")).toBe(old);
  expect(f.window.snapshot.phase).toBe("restored");
});
it("refuses changed continuity, corrupt original and stale manifest without modifying live state", async () => {
  const f = await fixture();
  await f.recovery.backupPrevious(old, signal());
  await f.changed();
  const changed = new MacFixedPathRecovery(f.window, f.control, f.binary, {
    ...f.ports,
    continuity: async () => "d".repeat(64),
  });
  await expect(changed.restore(old, candidate, signal())).rejects.toThrow();
  const receipt = join(f.control, "pairs", f.window.snapshot.attempt!, "previous", "root-1", "history.json");
  await writeFile(receipt, "corrupt");
  const fresh = await f.fresh();
  await expect(fresh.recovery.restore(old, candidate, signal())).rejects.toThrow();
  expect(await readFile(join(f.binary, "manifest"), "utf8")).toBe(candidate);
});
it("categorically refuses restoration after admission has reopened", async () => {
  const f = await fixture();
  await f.recovery.backupPrevious(old, signal());
  f.window.setPhase("validating");
  f.window.setPhase("validated");
  f.window.reopen();
  await expect(f.recovery.restore(old, candidate, signal())).rejects.toThrow();
  expect(await readdir(join(f.control, "pairs", f.window.snapshot.attempt ?? "missing")).catch(() => [])).toEqual([]);
});
it("refuses a different candidate identity before preserving or changing any live state", async () => {
  const f = await fixture();
  await f.recovery.backupPrevious(old, signal());
  await f.changed();
  await expect(f.recovery.restore(old, "d".repeat(64), signal())).rejects.toThrow();
  expect(await readdir(join(f.control, "pairs", f.window.snapshot.attempt!))).toEqual(["previous"]);
  expect(await readFile(join(f.binary, "manifest"), "utf8")).toBe(candidate);
  expect(f.window.snapshot.phase).toBe("closed");
});
it("retains incomplete copies and refuses backup acknowledgement after writer owner loss", async () => {
  const f = await fixture();
  const trees: PairTreePort = {
    ...f.trees,
    copy: async (from, to, s) => {
      await f.trees.copy(from, to, s);
      f.window.seal();
    },
  };
  const broken = new MacFixedPathRecovery(f.window, f.control, f.binary, { ...f.ports, trees });
  await expect(broken.backupPrevious(old, signal())).rejects.toThrow();
  const fresh = await f.fresh();
  await expect(fresh.recovery.backupPrevious(old, signal())).rejects.toThrow();
  expect(await readdir(join(f.control, "pairs", fresh.owner.snapshot.attempt!, "previous"))).toEqual(["root-0"]);
});
it.each(["state", "binary"])(
  "detects %s mutation between inspection and copying and keeps its failed receipt absent",
  async (kind) => {
    const f = await fixture();
    const trees: PairTreePort = {
      ...f.trees,
      copy: async (from, to, s) => {
        await f.trees.copy(from, to, s);
        if ((kind === "binary") === (from === f.binary)) await writeFile(join(from, "extra"), "unexpected");
      },
    };
    const broken = new MacFixedPathRecovery(f.window, f.control, f.binary, { ...f.ports, trees });
    await expect(broken.backupPrevious(old, signal())).rejects.toThrow();
    await expect(
      readFile(join(f.control, "pairs", f.window.snapshot.attempt!, "previous", "pair.json")),
    ).rejects.toThrow();
  },
);
it("refuses external symlinks and hardlinks before producing a complete backup", async () => {
  const f = await fixture();
  await symlink(f.binary, join(f.data[0]!, "external"));
  await expect(f.recovery.backupPrevious(old, signal())).rejects.toThrow();
  const other = await fixture();
  await link(join(other.data[0]!, "intents.enc"), join(other.data[0]!, "hardlink"));
  await expect(other.recovery.backupPrevious(old, signal())).rejects.toThrow();
});
it("preserves internal binary symlinks with exact bytes and modes", async () => {
  const f = await fixture();
  await symlink("manifest", join(f.binary, "current"));
  const previous = await f.recovery.backupPrevious(old, signal());
  expect(previous.binary.sha256).toBe(await f.trees.digest(f.binary, signal()));
});
it("refuses root/binary aliases, cancellation and replaced live root identity", async () => {
  const f = await fixture();
  expect(() => new MacFixedPathRecovery(f.window, f.control, f.data[0]!, f.ports)).toThrow();
  const aborted = new AbortController();
  aborted.abort();
  await expect(f.recovery.backupPrevious(old, aborted.signal)).rejects.toThrow();
  const fresh = await f.fresh();
  await rename(f.data[0]!, f.data[0]! + "-old");
  await mkdir(f.data[0]!, { mode: 0o700 });
  expect(fresh.owner.check()).toBe(false);
  await expect(fresh.recovery.backupPrevious(old, signal())).rejects.toThrow();
});
