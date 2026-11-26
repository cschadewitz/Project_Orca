/** Real native Windows first-run fixtures. Never changes an existing directory ACL. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  link,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  windowsDirectory,
  windowsPrivateChild,
  windowsRead,
  windowsWrite,
  fenceBoot,
  acquireFirstRunFence,
} from "@orca/protocol/first-run-fence";
import { FirstRunSetup } from "../src/main/first-run/setup.js";
import { windowsWorkspaceParent } from "../src/main/first-run/directories.js";
import { refusalMessage } from "../src/main/first-run/ipc.js";
import { untrustedWriterReason } from "../src/first-run-windows-reasons.js";
import { verifyFirstRunSampleAssets } from "../src/main/first-run/sample-assets.js";
import { inspectFirstRunOwnership, reserveFirstRunOwnership } from "../src/main/first-run/ownership.js";
const roots: string[] = [];
// Test-only fixture selection: managed Temp ACLs can correctly fail safe ancestry.
const fixtureParent = process.env.ORCA_WINDOWS_TEST_PARENT ?? tmpdir();
/** Whether the fixture drive's root grants Authenticated Users Modify on the root itself, as Windows does for data drives. */
const stockDataDriveRoot =
  process.platform === "win32" &&
  execFileSync("icacls", [`${fixtureParent.slice(0, 2)}\\`], { encoding: "utf8", windowsHide: true, stdio: "pipe" })
    .split(/\r?\n/)
    .some((line) => /Authenticated Users:\(M\)\s*$/.test(line));
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  windowsDirectory(fixtureParent, "parent");
  const root = await mkdtemp(join(fixtureParent, "orca-first-run-win-"));
  roots.push(root);
  const project = join(root, "project"),
    profile = join(root, "profile"),
    home = join(root, "home");
  windowsPrivateChild(project);
  windowsPrivateChild(profile);
  windowsPrivateChild(home);
  await writeFile(join(root, "empty-git-config"), "");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", project, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
      timeout: 5000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, "empty-git-config"),
        GIT_CONFIG_SYSTEM: join(root, "empty-git-config"),
        GIT_TERMINAL_PROMPT: "0",
      },
    }).trim();
  git("init", "-b", "prepared");
  await writeFile(join(project, "sentinel"), "unchanged\n");
  git("add", "sentinel");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  const deps = {
    home,
    receiptPath: join(profile, "first-run", "selection.json"),
    choose: async (kind: "project" | "workspace") => (kind === "project" ? project : root),
    current: () => false,
    prepareConnection: async () => {
      throw new Error("unused");
    },
  };
  const setup = new FirstRunSetup(deps);
  const review = await setup.choose(() => {});
  if (review.state !== "review") throw new Error("review missing");
  return { root, project, deps, setup, review: review.review, workspace: review.review.workspace };
}
describe.skipIf(process.platform !== "win32")("native Windows first-run", () => {
  it("reviews a missing private child, creates exact samples and preserves the receipt across recreation", async () => {
    const f = await fixture();
    expect(typeof process.getuid).toBe("undefined");
    expect(f.review.creation).toEqual({ parent: f.root, kind: "private-child" });
    expect(await readdir(f.root)).not.toContain(f.workspace.split("\\").at(-1));
    const prepared = await f.setup.prepare(f.review.id, () => {});
    expect(prepared.state).toBe("prepared");
    await verifyFirstRunSampleAssets(f.workspace);
    const original = await readFile(f.deps.receiptPath, "utf8");
    const receipt = JSON.parse(original) as { workspace: { dev: string; ino: string; uid: string } };
    expect(receipt.workspace.uid).toMatch(/^win32:sid:S-1-/);
    expect(receipt.workspace.dev).toMatch(/^win32:ntfs:/);
    expect(receipt.workspace.ino).toMatch(/^win32:file:/);
    expect((await new FirstRunSetup(f.deps).status()).state).toBe("prepared");
    expect(await readFile(f.deps.receiptPath, "utf8")).toBe(original);
    expect(await readFile(join(f.project, "sentinel"), "utf8")).toBe("unchanged\n");
  });
  it("refuses a replaced reviewed parent before creating its child", async () => {
    const f = await fixture();
    const original = `${f.root}-original`;
    roots.push(original);
    await rename(f.root, original);
    await mkdir(f.root);
    await expect(f.setup.prepare(f.review.id, () => {})).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  });
  it("refuses hard-linked, reparse and replaced sample assets without changing the receipt", async () => {
    const f = await fixture();
    await f.setup.prepare(f.review.id, () => {});
    const receipt = await readFile(f.deps.receiptPath, "utf8");
    const asset = join(f.workspace, "first-run", "task.json");
    await link(asset, join(f.root, "hardlink"));
    await expect(verifyFirstRunSampleAssets(f.workspace)).rejects.toThrow();
    await unlink(join(f.root, "hardlink"));
    const assets = join(f.workspace, "first-run");
    await rename(assets, `${assets}-original`);
    await symlink(`${assets}-original`, assets, "junction");
    await expect(verifyFirstRunSampleAssets(f.workspace)).rejects.toThrow();
    await unlink(assets);
    await rename(`${assets}-original`, assets);
    await writeFile(asset, "changed\n");
    expect((await new FirstRunSetup(f.deps).status()).state).toBe("selection-required");
    expect(await readFile(f.deps.receiptPath, "utf8")).toBe(receipt);
  });
  it("refuses inherited non-private ACLs and unsafe path namespaces", async () => {
    const f = await fixture();
    expect(() => windowsDirectory(f.root)).toThrow();
    for (const path of [
      f.root.toLowerCase(),
      `\\\\?\\${f.root}`,
      "\\\\server\\share\\workspace",
      join(f.root, "..", "alias"),
    ])
      expect(() => windowsDirectory(path)).toThrow();
    expect(() => windowsWrite(join(f.project, "outside.txt"), "never")).toThrow();
  });
  it("refuses a folder another account can change, by its own code (#1217)", async () => {
    const f = await fixture();
    // A new fixture folder, granted Modify to Authenticated Users on itself only; its child inherits nothing from that.
    const shared = join(f.root, "shared");
    windowsPrivateChild(shared);
    execFileSync("icacls", [shared, "/grant", "*S-1-5-11:(M)"], { windowsHide: true, stdio: "pipe" });
    const inner = join(shared, "inner");
    await mkdir(inner);
    for (const path of [shared, inner]) {
      for (const mode of ["project", "parent"] as const)
        expect(() => windowsDirectory(path, mode)).toThrow(
          expect.objectContaining({ code: "FIRST_RUN_WINDOWS_UNTRUSTED_WRITER" }),
        );
    }
  });
  it("labels only a confirmed writer: read-only grants pass and unknown refusals stay generic, through to the screen's text (#1217)", async () => {
    const f = await fixture();
    // Read and execute for another account is not a writer: the selection passes.
    const readable = join(f.root, "readable");
    windowsPrivateChild(readable);
    execFileSync("icacls", [readable, "/grant", "*S-1-5-11:(RX)"], { windowsHide: true, stdio: "pipe" });
    expect(windowsDirectory(readable, "project").path).toBe(readable);
    // A private folder with that same grant is refused, but not as a writer: the cause is not one to act on.
    expect(() => windowsDirectory(readable, "directory")).toThrow(
      expect.objectContaining({ code: "FIRST_RUN_WINDOWS_UNAVAILABLE" }),
    );
    // An unsupported namespace is unknown, never labelled.
    expect(() => windowsDirectory("\\\\server\\share\\workspace", "parent")).toThrow(
      expect.objectContaining({ code: "FIRST_RUN_WINDOWS_UNAVAILABLE" }),
    );
    // The native code reaches the screen as the specific reason only for a confirmed writer.
    const shared = join(f.root, "shared-parent");
    windowsPrivateChild(shared);
    execFileSync("icacls", [shared, "/grant", "*S-1-5-11:(M)"], { windowsHide: true, stdio: "pipe" });
    const screen = (path: string) => {
      try {
        windowsWorkspaceParent(path);
      } catch (error) {
        return refusalMessage(error);
      }
      throw new Error("expected a refusal");
    };
    expect(screen(shared)).toBe(untrustedWriterReason(false));
    const unknown = screen("\\\\server\\share\\workspace");
    expect(unknown).not.toBe(untrustedWriterReason(false));
    expect(unknown).not.toContain("another account");
  });
  // A data drive's stock root grants Authenticated Users Modify on the root itself. A root cannot be renamed or
  // deleted, so that alone no longer refuses everything on the drive. Runs where the fixture's drive has that root.
  it.skipIf(!stockDataDriveRoot)("accepts a project on a drive whose root carries the stock Modify grant", async () => {
    const f = await fixture();
    expect(windowsDirectory(f.project, "project").path).toBe(f.project);
    expect(windowsDirectory(f.root, "parent").path).toBe(f.root);
  });
  it("refuses physical workspace replacement and uncertified legacy Windows receipts", async () => {
    const f = await fixture();
    await f.setup.prepare(f.review.id, () => {});
    const original = await readFile(f.deps.receiptPath, "utf8");
    const identity = windowsDirectory(f.workspace);
    await rename(f.workspace, `${f.workspace}-old`);
    windowsPrivateChild(f.workspace);
    await expect(acquireFirstRunFence(identity, () => undefined)).rejects.toThrow();
    expect((await new FirstRunSetup(f.deps).status()).state).toBe("selection-required");
    expect(await readFile(f.deps.receiptPath, "utf8")).toBe(original);
    await rmdir(f.workspace);
    await rename(`${f.workspace}-old`, f.workspace);
    const legacy = JSON.parse(original) as { workspace: { uid: string; dev: string; ino: string } };
    legacy.workspace.uid = "0";
    windowsWrite(f.deps.receiptPath, JSON.stringify(legacy) + "\n", true);
    expect((await new FirstRunSetup(f.deps).status()).state).toBe("selection-required");
    expect(windowsRead(f.deps.receiptPath, 65536)).toContain('"uid":"0"');
  });
  it("releases short recovery locks, refuses competing writers and uses stable native boot identity", async () => {
    const f = await fixture();
    await f.setup.prepare(f.review.id, () => {});
    const workspace = windowsDirectory(f.workspace);
    const boot = fenceBoot();
    expect(fenceBoot()).toEqual(boot);
    const fence = await acquireFirstRunFence(workspace, () => undefined);
    try {
      await expect(acquireFirstRunFence(workspace, () => undefined)).rejects.toThrow();
    } finally {
      await new Promise<void>((done) => fence.close(() => done()));
    }
    const again = await acquireFirstRunFence(workspace, () => undefined);
    await new Promise<void>((done) => again.close(() => done()));
    const owner = reserveFirstRunOwnership(f.workspace);
    owner.check();
    expect(inspectFirstRunOwnership(f.workspace, true).latest?.settled).toBe(false);
    expect(() => reserveFirstRunOwnership(f.workspace)).toThrow();
  });
  it("retains a native writer lock across ordinary release and garbage collection", async () => {
    // Isolated child owns this lifetime handle. The parent never attempts to remove a live lock.
    const f = await fixture();
    await f.setup.prepare(f.review.id, () => {});
    const backend = createRequire(import.meta.url)(
      join(process.cwd(), "packages/app/native/diagnostics/build/Release/first_run_windows.node"),
    ) as { call(op: string, arg: unknown, extra: unknown): unknown };
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const source = `const a=require(${JSON.stringify(join(process.cwd(), "packages/app/native/diagnostics/build/Release/first_run_windows.node"))});let h=a.call('lock',${JSON.stringify(f.workspace)},null);a.call('retain',h,null);a.call('release',h,null);h=null;global.gc();process.stdout.write('retained\\n');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--expose-gc", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.resume();
    try {
      const output = await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw new Error("child refused");
        }),
      ]);
      expect(String(output[0])).toBe("retained\n");
      expect(() => backend.call("lock", f.workspace, null)).toThrow();
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    const lock = backend.call("lock", f.workspace, null);
    backend.call("release", lock, null);
  });
});
