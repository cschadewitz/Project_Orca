/** Negative build-provenance checks and Node resolution/process isolation for the emitted retry closure. */
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileRetryWorker, retrySourceRoot } from "./admission-retry-multiprocess/compiled-worker.js";
import { Worker } from "./admission-retry-multiprocess/harness.js";

const run = promisify(execFile);
let root: string;
let compiled: ReturnType<typeof compileRetryWorker>;
const workers: Worker[] = [];
beforeAll(() => {
  mkdirSync(join(retrySourceRoot, ".orca"), { recursive: true });
  root = mkdtempSync(join(retrySourceRoot, ".orca/retry-source-regression-"));
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json"])
    cpSync(join(retrySourceRoot, path), join(root, path));
  symlinkSync(join(retrySourceRoot, "node_modules"), join(root, "node_modules"), "junction");
  for (const name of ["agents", "core", "store", "engine"]) {
    const destination = join(root, "packages", name);
    mkdirSync(destination, { recursive: true });
    cpSync(join(retrySourceRoot, "packages", name, "src"), join(destination, "src"), { recursive: true });
    cpSync(join(retrySourceRoot, "packages", name, "package.json"), join(destination, "package.json"));
    symlinkSync(join(retrySourceRoot, "packages", name, "node_modules"), join(destination, "node_modules"), "junction");
  }
  cpSync(
    join(retrySourceRoot, "packages/engine/test/admission-retry-multiprocess"),
    join(root, "packages/engine/test/admission-retry-multiprocess"),
    { recursive: true },
  );
  compiled = compileRetryWorker(root);
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.kill()));
});
afterAll(() => {
  compiled?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("compiled retry worker contract", () => {
  it("retains source aliases, direct-import identity and dynamic imports without a loader", async () => {
    const code = `import * as alias from '@orca/core';
      import * as direct from '../../core/src/index.js';
      if (alias.OrcaError !== direct.OrcaError || alias.parseWorkflow !== direct.parseWorkflow)
        throw new Error('Split source module identity');
      if ((await import('@orca/core')).extractStructuredData !== direct.extractStructuredData)
        throw new Error('Split dynamic module identity');
      console.log(JSON.stringify({alias: import.meta.resolve('@orca/core'), direct: import.meta.resolve('../../core/src/index.js')}));`;
    const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: join(compiled.directory, "packages/engine/src"),
      timeout: 15_000,
    });
    const result = JSON.parse(stdout) as { alias: string; direct: string };
    expect(result.alias).toBe(result.direct);
    expect(result.alias).toContain("/packages/core/src/index.js");
    expect(Object.keys(compiled.sourceHashes)).toContain("packages/engine/test/admission-retry-multiprocess/worker.ts");
    expect(Object.keys(compiled.artifactHashes).every((path) => !path.includes("dist/"))).toBe(true);
  });

  it("retains exact Node ESM external-package resolution for every importing package", async () => {
    for (const [name, specifiers] of [
      ["core", ["zod", "yaml"]],
      ["agents", ["@agentclientprotocol/sdk"]],
      ["store", ["zod"]],
      ["engine", ["zod"]],
    ] as const) {
      const code = `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map(s => import.meta.resolve(s))));`;
      const original = await run(process.execPath, ["--input-type=module", "--eval", code], {
        cwd: join(root, "packages", name),
        timeout: 15_000,
      });
      const emitted = await run(process.execPath, ["--input-type=module", "--eval", code], {
        cwd: join(compiled.directory, "packages", name),
        timeout: 15_000,
      });
      expect(JSON.parse(emitted.stdout)).toEqual(JSON.parse(original.stdout));
    }
  });

  it("fails closed on an equal-size/equal-mtime source mutation and binds a new candidate hash", () => {
    const path = join(root, "packages/engine/test/admission-retry-multiprocess/fixture.ts");
    const original = readFileSync(path);
    const timestamps = statSync(path);
    try {
      writeFileSync(path, original.toString().replace("Real admission", "Fake admission"));
      utimesSync(path, timestamps.atime, timestamps.mtime);
      expect(statSync(path).size).toBe(original.length);
      expect(() => compiled.verify()).toThrow("Stale retry worker input");
      const changed = compileRetryWorker(root);
      try {
        expect(changed.candidateHash).not.toBe(compiled.candidateHash);
      } finally {
        changed.dispose();
      }
    } finally {
      writeFileSync(path, original);
      utimesSync(path, timestamps.atime, timestamps.mtime);
    }
    compiled.verify();
  });

  it.each(["tsconfig.json", "pnpm-lock.yaml"])("fails closed when %s changes", (name) => {
    const path = join(root, name);
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
      expect(() => compiled.verify()).toThrow("Stale retry worker input");
    } finally {
      writeFileSync(path, original);
    }
    compiled.verify();
  });

  it("fails closed on corrupted and missing output without rebuilding", () => {
    const original = readFileSync(compiled.entry);
    try {
      writeFileSync(compiled.entry, "throw new Error('corrupted emitted worker');");
      expect(() => compiled.verify()).toThrow("Stale retry worker artifact");
      rmSync(compiled.entry);
      expect(() => compiled.verify()).toThrow();
    } finally {
      writeFileSync(compiled.entry, original);
    }
    compiled.verify();
  });

  it("fails closed on a replaced source-alias link", () => {
    const path = join(compiled.directory, "node_modules/@orca/core");
    rmSync(path);
    try {
      symlinkSync(join(compiled.directory, "packages/store"), path, "junction");
      expect(() => compiled.verify()).toThrow("Stale retry worker link");
    } finally {
      rmSync(path);
      symlinkSync(join(compiled.directory, "packages/core"), path, "junction");
    }
    compiled.verify();
  });

  it.each([
    "packages/engine/src/package.json",
    "packages/engine/test/admission-retry-multiprocess/package.json",
    "packages/engine/node_modules/@orca/core",
    "packages/engine/src/program/node_modules/@orca/core",
  ])("rejects an added resolution-changing entry at %s", (name) => {
    const path = join(compiled.directory, name);
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (name.endsWith(".json")) writeFileSync(path, JSON.stringify({ type: "commonjs" }));
      else mkdirSync(path);
      expect(() => compiled.verify()).toThrow("Stale retry worker tree");
    } finally {
      // Remove only added parents, stopping at the original package/source directory.
      const addition = name.includes("/node_modules/@orca/")
        ? join(compiled.directory, name.split("/node_modules/")[0]!, "node_modules")
        : path;
      if (name.startsWith("packages/engine/node_modules/")) rmSync(dirname(path), { recursive: true });
      else rmSync(addition, { recursive: true });
    }
    compiled.verify();
  });

  it.each(["packages/engine/test/admission-retry-multiprocess/worker.js", "packages/engine/src"])(
    "rejects identical emitted bytes through a replaced symlink at %s",
    (name) => {
      const path = join(compiled.directory, name);
      const replacement = join(root, "replacement");
      const directory = statSync(path).isDirectory();
      cpSync(path, replacement, { recursive: directory });
      rmSync(path, { recursive: directory });
      try {
        symlinkSync(replacement, path, directory ? "junction" : "file");
        expect(() => compiled.verify()).toThrow("Stale retry worker tree");
      } finally {
        rmSync(path);
        cpSync(replacement, path, { recursive: directory });
        rmSync(replacement, { recursive: directory });
      }
      compiled.verify();
    },
  );

  it("rejects a closer shadow package before a real Worker can execute its module", async () => {
    const initial = new Worker(mkdtempSync(join(root, "shadow-initial-")), "request");
    workers.push(initial);
    expect(await initial.wait("ready")).toEqual({ operations: [], runs: [], starts: 0 });
    expect(await initial.kill()).toEqual({ code: null, signal: "SIGKILL" });
    const emitted = resolve(dirname(initial.child.spawnargs[1]!), "../../../..");
    const scope = join(emitted, "packages/engine/src");
    const shadow = join(scope, "node_modules/@orca/core");
    const marker = join(root, "unverified-module-executed");
    const code = "console.log(import.meta.resolve('@orca/core'));";
    const original = await run(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: scope,
      timeout: 15_000,
    });
    mkdirSync(shadow, { recursive: true });
    writeFileSync(
      join(shadow, "package.json"),
      JSON.stringify({ name: "@orca/core", type: "module", exports: "./index.js" }),
    );
    writeFileSync(
      join(shadow, "index.js"),
      `import {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'unverified');
      export * from ${JSON.stringify(pathToFileURL(join(emitted, "packages/core/src/index.js")).href)};`,
    );
    let unexpected: Worker | undefined;
    let refusal: unknown;
    try {
      const changed = await run(process.execPath, ["--input-type=module", "--eval", code], {
        cwd: scope,
        timeout: 15_000,
      });
      expect(changed.stdout.trim()).toBe(pathToFileURL(join(shadow, "index.js")).href);
      expect(changed.stdout).not.toBe(original.stdout);
      try {
        unexpected = new Worker(mkdtempSync(join(root, "shadow-rejected-")), "request");
        workers.push(unexpected);
      } catch (error) {
        refusal = error;
      }
      // With the old verifier this reaches real IPC ready and writes the marker,
      // then the assertion fails. Reap that owned negative-control child as well.
      if (unexpected) {
        await unexpected.wait("ready");
        await unexpected.kill();
      }
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain("Stale retry worker tree");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await unexpected?.kill();
      rmSync(join(scope, "node_modules"), { recursive: true });
      rmSync(marker, { force: true });
    }
  });

  it("reuses emitted bytes while every Worker retains a fresh PID, IPC, state and SIGKILL cleanup", async () => {
    for (const kind of ["request", "direct"] as const) {
      const dir = mkdtempSync(join(root, `state-${kind}-`));
      workers.push(new Worker(dir, kind));
    }
    expect(new Set(workers.map((worker) => worker.child.pid)).size).toBe(2);
    expect(workers.map((worker) => worker.child.pid)).not.toContain(process.pid);
    expect(workers[0]!.child.spawnargs[1]).toBe(workers[1]!.child.spawnargs[1]);
    expect(workers[0]!.child.spawnargs[1]).toMatch(/retry-worker-.*worker\.js$/);
    for (const worker of workers) {
      expect(worker.child.spawnargs).not.toContain("--import");
      expect(await worker.wait("ready")).toEqual({ operations: [], runs: [], starts: 0 });
      expect(await worker.kill()).toEqual({ code: null, signal: "SIGKILL" });
    }
    const artifact = workers[0]!.child.spawnargs[1]!;
    const bytes = readFileSync(artifact);
    try {
      rmSync(artifact);
      expect(() => new Worker(join(root, "rejected-state"), "request")).toThrow();
    } finally {
      writeFileSync(artifact, bytes);
    }
  });
});
