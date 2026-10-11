/** Portable candidate engine probes: real owned ZIP transport, fake Electron lifecycle; no signed-native proof. */
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoUpdater } from "electron";
import { afterEach, expect, it as platformIt, vi } from "vitest";
import { MacNativeHandoff, type MacNativeCommitRequest } from "../src/main/mac-native-handoff.js";
import { readMacManifest, sha256 } from "../src/main/mac-candidate-manifest.js";

// Prepared candidate storage requires POSIX private modes and owner. Windows must refuse
// it, so cases that need that storage accepted skip Windows; refusal cases run everywhere.
const it = platformIt.skipIf(process.platform === "win32");

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.useRealTimers();
});
async function fixture(outcome: "ready" | "refused" | "unknown" = "ready") {
  const root = await mkdtemp(join(tmpdir(), "orca-native-handoff-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const source = new URL("../../../tools/deploy/tests/native-mac/fixtures/valid/delivery/", import.meta.url);
  const manifest = readMacManifest(await readFile(new URL("native-mac-artifact.json", source)));
  manifest.kind = "candidate";
  manifest.signing.teamId = "Q2FP9UY5T4";
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, "native-mac-artifact.json"), manifestBytes, { mode: 0o600 });
  const zip = manifest.artifacts.find((record) => record.format === "zip")!;
  const bytes = await readFile(new URL(zip.path, source));
  const zipPath = join(root, zip.path);
  await writeFile(zipPath, bytes, { mode: 0o600 });
  const target = { workspaceId: "synthetic-workspace", instanceId: "synthetic-boot", epoch: 4 };
  const release = vi.fn(async () => "released" as const);
  const request: MacNativeCommitRequest = {
    prepared: {
      scope: "preparation-only",
      directory: root,
      target,
      binding: {
        manifest,
        source: "https://delivery.invalid/beta/",
        candidate: {
          manifestSha256: sha256(manifestBytes),
          channel: "synthetic-beta",
          compatibilityPlanId: "synthetic-compatible",
          recoveryPlanId: "synthetic-complete-state",
        },
      },
    },
    lease: { target: { ...target }, release },
  };
  const events = new EventEmitter();
  let url = "";
  const fakeNative = Object.assign(events, {
    setFeedURL: vi.fn((feed: { url: string }) => {
      url = feed.url;
    }),
    checkForUpdates: vi.fn(() => {}),
    quitAndInstall: vi.fn(() => {}),
  });
  const native = fakeNative as unknown as AutoUpdater;
  const prepare = vi.fn(async (_request: MacNativeCommitRequest) => outcome);
  const options = { native, owner: { prepare }, zipBytes: 100_000, operationMs: 10_000 };
  const engine = new MacNativeHandoff(options);
  const downloaded = (downloadURL: string) => events.emit("update-downloaded", {}, "", "", new Date(), downloadURL);
  return {
    root,
    zipPath,
    bytes,
    request,
    native: fakeNative,
    events,
    prepare,
    release,
    engine,
    options,
    feed: () => url,
    downloaded,
  };
}

platformIt("defaults to unavailable and never calls native or a recovery owner", async () => {
  const f = await fixture();
  expect(await new MacNativeHandoff({ zipBytes: 100_000, operationMs: 10_000 }).activate(f.request)).toBe("refused");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.native.setFeedURL).not.toHaveBeenCalled();
});

it.each(["refused", "unknown"] as const)(
  "preserves %s commit-owner outcome without native calls or release",
  async (outcome) => {
    const f = await fixture(outcome);
    expect(await f.engine.activate(f.request)).toBe(outcome);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.native.setFeedURL).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  },
);

it.each(["valid", undefined, "throws"])(
  "treats malformed/rejected owner result %s as unknown without native touch",
  async (value) => {
    const f = await fixture();
    vi.mocked(f.prepare).mockImplementation(async () => {
      if (value === "throws") throw new Error("Private recovery failure");
      return value as never;
    });
    expect(await f.engine.activate(f.request)).toBe("unknown");
    expect(f.native.setFeedURL).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  },
);

platformIt.each(["bytes", "manifest", "target", "symlink", "budget"])(
  "refuses %s before the commit owner touches state",
  async (fault) => {
    const f = await fixture();
    if (fault === "bytes") await writeFile(f.zipPath, "wrong zip");
    if (fault === "manifest") await writeFile(join(f.root, "native-mac-artifact.json"), "{}");
    if (fault === "target") (f.request.lease.target as { epoch: number }).epoch++;
    if (fault === "symlink") {
      await rm(f.zipPath);
      await symlink("native-mac-artifact.json", f.zipPath);
    }
    const engine = fault === "budget" ? new MacNativeHandoff({ ...f.options, zipBytes: 1 }) : f.engine;
    expect(await engine.activate(f.request)).toBe(fault === "target" ? "unknown" : "refused");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.native.checkForUpdates).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  },
);

it("serves only captured exact ZIP bytes, calls check once and automatically requests quit after matching download", async () => {
  const f = await fixture();
  const calls: string[] = [];
  let transport: Promise<void> | undefined;
  vi.mocked(f.prepare).mockImplementation(async () => {
    calls.push("complete-recovery-owner");
    // Same pathname changes after sealed-byte capture cannot change the native payload.
    await writeFile(f.zipPath, "changed after capture");
    return "ready";
  });
  vi.mocked(f.native.checkForUpdates).mockImplementation(() => {
    calls.push("native-check");
    transport = (async () => {
      const feedURL = f.feed();
      expect(new URL(feedURL).hostname).toBe("127.0.0.1");
      expect((await fetch(new URL("/wrong", feedURL))).status).toBe(404);
      expect((await fetch(`${feedURL}?candidate=other`)).status).toBe(404);
      expect((await fetch(feedURL, { method: "POST" })).status).toBe(404);
      const feed = (await (await fetch(feedURL)).json()) as { url: string; name: string };
      expect(Object.keys(feed).sort()).toEqual(["name", "url"]);
      const response = await fetch(feed.url);
      expect(response.headers.get("content-type")).toBe("application/zip");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
      f.downloaded(feed.url);
      f.downloaded(feed.url);
    })().catch((error: unknown) => {
      f.events.emit("error", error);
      throw error;
    });
  });
  vi.mocked(f.native.quitAndInstall).mockImplementation(() => {
    calls.push("native-quit");
  });
  const pending = f.engine.activate(f.request);
  expect(f.engine.activate(f.request)).toBe(pending);
  expect(await pending).toBe("committed");
  await transport;
  expect(calls).toEqual(["complete-recovery-owner", "native-check", "native-quit"]);
  expect(f.native.checkForUpdates).toHaveBeenCalledOnce();
  expect(f.native.quitAndInstall).toHaveBeenCalledOnce();
  expect(f.release).not.toHaveBeenCalled();
  expect(await new MacNativeHandoff(f.options).activate(f.request)).toBe("committed");
  expect(await readFile(f.zipPath, "utf8")).toBe("changed after capture");
});

it.each(["error", "unavailable", "wrong-url", "feed-throws", "check-throws", "quit-throws", "error-on-quit"])(
  "seals %s after commit ownership, never releases or rechecks native",
  async (fault) => {
    const f = await fixture();
    if (fault === "feed-throws")
      vi.mocked(f.native.setFeedURL).mockImplementation(() => {
        throw new Error("private feed failure");
      });
    vi.mocked(f.native.checkForUpdates).mockImplementation(() => {
      if (fault === "error") f.events.emit("error", new Error("private native error"));
      else if (fault === "unavailable") f.events.emit("update-not-available");
      else if (fault === "wrong-url") f.downloaded("https://wrong.invalid/zip");
      else if (fault === "check-throws") throw new Error("private check failure");
      else f.downloaded(f.feed().replace(/feed$/, "candidate.zip"));
    });
    if (fault === "quit-throws")
      vi.mocked(f.native.quitAndInstall).mockImplementation(() => {
        throw new Error("private quit failure");
      });
    if (fault === "error-on-quit")
      vi.mocked(f.native.quitAndInstall).mockImplementation(() => {
        f.events.emit("error", new Error("unknown quit"));
      });
    expect(await f.engine.activate(f.request)).toBe("unknown");
    expect(await new MacNativeHandoff(f.options).activate(f.request)).toBe("unknown");
    f.downloaded(f.feed().replace(/feed$/, "candidate.zip"));
    expect(() => f.events.emit("error", new Error("late private native error"))).not.toThrow();
    expect(f.native.checkForUpdates).toHaveBeenCalledTimes(fault === "feed-throws" ? 0 : 1);
    expect(f.native.quitAndInstall).toHaveBeenCalledTimes(["quit-throws", "error-on-quit"].includes(fault) ? 1 : 0);
    expect(f.release).not.toHaveBeenCalled();
    expect(await readFile(f.zipPath)).toEqual(f.bytes);
  },
);

it("does not accept a download emitted during feed initialization", async () => {
  const f = await fixture();
  vi.mocked(f.native.setFeedURL).mockImplementation((feed) => {
    f.downloaded(feed.url.replace(/feed$/, "candidate.zip"));
  });
  expect(await f.engine.activate(f.request)).toBe("unknown");
  expect(f.native.checkForUpdates).not.toHaveBeenCalled();
  expect(f.native.quitAndInstall).not.toHaveBeenCalled();
});

it.each(["ready", "refused"] as const)(
  "seals changed lease identity after the %s commit owner without touching native",
  async (outcome) => {
    const f = await fixture();
    vi.mocked(f.prepare).mockImplementation(async () => {
      (f.request.lease.target as { epoch: number }).epoch++;
      return outcome;
    });
    expect(await f.engine.activate(f.request)).toBe("unknown");
    expect(f.native.setFeedURL).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  },
);

it("does not retarget an in-flight singleton through a new wrapper", async () => {
  const f = await fixture();
  vi.mocked(f.prepare).mockImplementation(async () => "unknown");
  const first = f.engine.activate(f.request);
  const next = { ...f.request, prepared: { ...f.request.prepared, directory: `${f.root}-other` } };
  expect(await new MacNativeHandoff(f.options).activate(next)).toBe("unknown");
  const newLease = { ...f.request, lease: { ...f.request.lease, release: vi.fn(async () => "released" as const) } };
  expect(await new MacNativeHandoff(f.options).activate(newLease)).toBe("unknown");
  expect(newLease.lease.release).not.toHaveBeenCalled();
  expect(await first).toBe("unknown");
  expect(f.prepare).toHaveBeenCalledOnce();
});

it("bounds an unknown commit owner and ignores a late ready result", async () => {
  const f = await fixture();
  let enter!: () => void;
  let ready!: (value: "ready") => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const delayed = new Promise<"ready">((resolve) => {
    ready = resolve;
  });
  vi.mocked(f.prepare).mockImplementation(() => {
    enter();
    return delayed;
  });
  vi.useFakeTimers();
  const pending = f.engine.activate(f.request);
  await entered;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toBe("unknown");
  ready("ready");
  await delayed;
  expect(f.native.setFeedURL).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
});

it("seals native timeout without permitting a late download or retry", async () => {
  const f = await fixture();
  let enter!: () => void;
  const checked = new Promise<void>((resolve) => {
    enter = resolve;
  });
  vi.mocked(f.native.checkForUpdates).mockImplementation(() => {
    enter();
  });
  vi.useFakeTimers();
  const pending = f.engine.activate(f.request);
  await checked;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toBe("unknown");
  f.downloaded(f.feed().replace(/feed$/, "candidate.zip"));
  expect(await new MacNativeHandoff(f.options).activate(f.request)).toBe("unknown");
  expect(f.native.quitAndInstall).not.toHaveBeenCalled();
  expect(f.native.checkForUpdates).toHaveBeenCalledOnce();
  expect(f.release).not.toHaveBeenCalled();
});
