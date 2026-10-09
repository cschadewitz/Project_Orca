/** Opt-in actual Node-API complete-pair mutations and same-boot process crash. */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat, rename, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClosedUpdateWindow } from "@orca/protocol/update-window";
import { createPairTreePort } from "../src/main/mac-fixed-path-files.js";
import { MacFixedPathRecovery } from "../src/main/mac-fixed-path-recovery.js";
import { provisionMacUpdateNamespace } from "../src/main/mac-update-namespace.js";
import type { NativeStorageBackend } from "../src/main/diagnostics/native-storage.js";

const headers = process.env.ORCA_REPLACEMENT_NATIVE_TEST_HEADERS;
const roots: string[] = [],
  closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe.runIf(process.platform === "linux" && headers)("compiled fixed-path descriptor backend", () => {
  let backend: NativeStorageBackend, addon: string, build: string;
  beforeAll(async () => {
    build = await mkdtemp(join(process.cwd(), "orca-pair-native-build-"));
    addon = join(build, "storage.node");
    await promisify(execFile)(
      "/usr/bin/cc",
      [
        "-shared",
        "-fPIC",
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-DNAPI_VERSION=8",
        "-DORCA_PAIR_FAULTS",
        "-I",
        headers!,
        resolve("packages/app/native/diagnostics/storage.c"),
        "-o",
        addon,
      ],
      { timeout: 10000, maxBuffer: 4096 },
    );
    backend = createRequire(import.meta.url)(addon) as NativeStorageBackend;
  });
  afterAll(async () => {
    if (build) await rm(build, { recursive: true, force: true });
  });
  async function fixture() {
    const base = await mkdtemp(join(process.cwd(), "orca-pair-native-"));
    roots.push(base);
    const control = join(base, "control"),
      data = join(base, "state"),
      binary = join(base, "Orca.app");
    await mkdir(data, { mode: 0o700 });
    await mkdir(binary, { mode: 0o700 });
    await writeFile(join(data, "protected"), "original", { mode: 0o600 });
    await writeFile(join(binary, "manifest"), "a".repeat(64), { mode: 0o600 });
    await provisionMacUpdateNamespace(control, [data], backend);
    const owner = new ClosedUpdateWindow(control);
    closers.push(() => owner.detach());
    owner.closeAdmission("b".repeat(64));
    expect(await owner.capture()).toBe(true);
    const trees = createPairTreePort("posix-fixture", backend),
      ports = {
        trees,
        verifyBinary: async (path: string, hash: string) => (await readFile(join(path, "manifest"), "utf8")) === hash,
        continuity: async () => "c".repeat(64),
      };
    const recovery = new MacFixedPathRecovery(owner, control, binary, ports);
    return { base, control, data, binary, owner, trees, ports, recovery };
  }
  it("provisions native namespaces once and refuses lost/replaced identity", async () => {
    const f = await fixture();
    expect((await readdir(f.control)).sort()).toEqual(["enrolled.json", "journal", "window.json"]);
    await f.owner.detach();
    await rename(f.control, f.control + "-old");
    await expect(provisionMacUpdateNamespace(f.control, [f.data], backend)).rejects.toThrow();
    expect(await readdir(f.base)).not.toContain("control");
  });
  it("refuses a missing established journal, unsafe namespace and stale backend", async () => {
    const f = await fixture();
    await f.owner.detach();
    await rm(join(f.control, "journal"), { recursive: true });
    await expect(provisionMacUpdateNamespace(f.control, [f.data], backend)).rejects.toThrow();
    const wrong = join(f.base, "link");
    await symlink(f.control, wrong);
    await expect(provisionMacUpdateNamespace(wrong, [f.data], backend)).rejects.toThrow();
    const stale = {
      abi: 1,
      platform: "posix-fixture",
      replacementStorage: 1,
      call: async () => {
        throw new Error("old addon");
      },
    } as NativeStorageBackend;
    await expect(provisionMacUpdateNamespace(join(f.base, "fresh"), [f.data], stale)).rejects.toThrow();
  });
  it("copies and restores the actual protected trees and binary without changing live root inodes", async () => {
    const f = await fixture(),
      initial = await lstat(f.data);
    await f.recovery.backupPrevious("a".repeat(64), new AbortController().signal);
    await writeFile(join(f.data, "protected"), "migration");
    await writeFile(join(f.binary, "manifest"), "b".repeat(64));
    expect(await f.recovery.restore("a".repeat(64), "b".repeat(64), new AbortController().signal)).toBe(
      "restored-closed",
    );
    expect((await lstat(f.data)).ino).toBe(initial.ino);
    expect(await readFile(join(f.data, "protected"), "utf8")).toBe("original");
    const saved = join(f.control, "pairs", f.owner.snapshot.attempt!, "current");
    expect(await readFile(join(saved, "root-0", "protected"), "utf8")).toBe("migration");
  });
  it("refuses a changed source identity before native destructive restore", async () => {
    const f = await fixture(),
      saved = join(f.base, "saved");
    await f.trees.copy(f.data, saved, new AbortController().signal);
    const src = await lstat(saved, { bigint: true }),
      dst = await lstat(f.data, { bigint: true });
    await rename(saved, saved + "-old");
    await mkdir(saved, { mode: 0o700 });
    await expect(
      backend.call(
        "pairRestore",
        undefined,
        undefined,
        saved,
        f.data,
        Buffer.from(`${src.dev}:${src.ino}:${dst.dev}:${dst.ino}`),
        0,
        0,
        0,
      ),
    ).rejects.toThrow();
    expect(await readFile(join(f.data, "protected"), "utf8")).toBe("original");
  });
  it("retains private modes, internal links and xattrs through the native mutation path", async () => {
    const f = await fixture();
    await symlink("manifest", join(f.binary, "current"));
    await promisify(execFile)("python", [
      "-c",
      "import os,sys;os.setxattr(sys.argv[1],b'user.orca-test',b'original-attribute')",
      join(f.data, "protected"),
    ]);
    const saved = join(f.base, "saved");
    await f.trees.copy(f.data, saved, new AbortController().signal);
    expect((await lstat(join(saved, "protected"))).mode & 0o777).toBe(0o600);
    const observed = await promisify(execFile)("python", [
      "-c",
      "import os,sys;assert os.getxattr(sys.argv[1],b'user.orca-test')==b'original-attribute';print('verified')",
      join(saved, "protected"),
    ]);
    expect(observed.stdout.trim()).toBe("verified");
    await f.recovery.backupPrevious("a".repeat(64), new AbortController().signal);
  });
  it("full descriptor flush refuses unsafe/nonprivate handles", async () => {
    const f = await fixture();
    const { open } = await import("node:fs/promises");
    const fd = await open(join(f.data, "protected"), "r");
    try {
      expect(() => backend.flushDescriptorSync!(fd.fd)).not.toThrow();
      expect(() => backend.flushDescriptorSync!(-1)).toThrow();
    } finally {
      await fd.close();
    }
  });
  it("a real supervisor SIGKILL after clearing a live root resumes the retained complete pair on the same boot", async () => {
    const f = await fixture();
    await f.recovery.backupPrevious("a".repeat(64), new AbortController().signal);
    await writeFile(join(f.data, "protected"), "migration");
    await writeFile(join(f.binary, "manifest"), "b".repeat(64));
    await f.owner.detach();
    const script = `import { createRequire } from 'node:module'; import { lstat,readFile } from 'node:fs/promises';
import { ClosedUpdateWindow } from ${JSON.stringify(resolve("packages/protocol/src/update-window.ts"))};
import { createPairTreePort } from ${JSON.stringify(resolve("packages/app/src/main/mac-fixed-path-files.ts"))};
import { MacFixedPathRecovery } from ${JSON.stringify(resolve("packages/app/src/main/mac-fixed-path-recovery.ts"))};
const backend=createRequire(import.meta.url)(process.argv[1]), owner=new ClosedUpdateWindow(process.argv[2]);if(!await owner.capture())throw Error('writer busy');
const trees=createPairTreePort('posix-fixture',backend);trees.restore=async(from,to)=>{const a=await lstat(from,{bigint:true}),b=await lstat(to,{bigint:true});await backend.call('pairRestore',undefined,undefined,from,to,Buffer.from(a.dev+':'+a.ino+':'+b.dev+':'+b.ino),0,0,1);};
const recovery=new MacFixedPathRecovery(owner,process.argv[2],process.argv[3],{trees,verifyBinary:async(path,hash)=>await readFile(path+'/manifest','utf8')===hash,continuity:async()=> '${"c".repeat(64)}'});await recovery.restore('${"a".repeat(64)}','${"b".repeat(64)}',new AbortController().signal);`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, addon, f.control, f.binary],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    closers.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise<void>((done) => child.once("close", () => done()));
        child.kill("SIGKILL");
        await ended;
      }
    });
    await new Promise<void>((done, reject) => {
      child.stdout.once("data", (bytes) =>
        String(bytes).includes("PAIR_CLEAR") ? done() : reject(new Error("unexpected fault output")),
      );
      child.once("exit", () => reject(new Error("fault child exited early")));
    });
    const rival = new ClosedUpdateWindow(f.control);
    closers.push(() => rival.detach());
    expect(await rival.capture()).toBe(false);
    const ended = new Promise<void>((done) => child.once("close", () => done()));
    child.kill("SIGKILL");
    await ended;
    expect(await rival.capture()).toBe(true);
    const recovered = new MacFixedPathRecovery(rival, f.control, f.binary, f.ports);
    expect(await recovered.restore("a".repeat(64), "b".repeat(64), new AbortController().signal)).toBe(
      "restored-closed",
    );
    expect(await readFile(join(f.data, "protected"), "utf8")).toBe("original");
    expect(await readFile(join(f.binary, "manifest"), "utf8")).toBe("a".repeat(64));
  });
});
