/** Orchestration with disposable byte fixtures and fake commands; no real store or binary is opened. */
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { rehearse } from "../../store-compat-rehearsal/rehearsal.js";

const temporary = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(fault) {
  const base = await mkdtemp(join(tmpdir(), "orca-rehearsal-driver-"));
  temporary.push(base);
  const work = join(base, "work");
  const live = join(work, "workspace");
  const old = join(base, "old");
  const candidate = join(base, "candidate");
  await mkdir(old);
  await mkdir(candidate);
  const run = vi.fn(async (side, args) => {
    const success = { code: 0, signal: null, matched: false, timedOut: false, tail: "fixture" };
    if (side === "old" && args[0] === "demo") {
      await mkdir(join(live, ".orca", "runs"), { recursive: true });
      await writeFile(join(live, ".orca", "runs", "one.jsonl"), "old fixture\n");
      await writeFile(join(live, ".orca", "requests.json"), "old requests\n");
      await writeFile(join(live, "orca.config.yaml"), `storeDir: ${join(live, ".orca")}\n`);
      return { ...success, code: fault === "generate" ? 1 : 0 };
    }
    if (side === "new" && args[0] === "demo") {
      if (fault !== "negative") await writeFile(join(live, ".orca", "requests.json"), "new requests\n");
      if (fault === "restore")
        await writeFile(join(work, "backup", "workspace", ".orca", "requests.json"), "bad backup\n");
      return { ...success, code: fault === "upgrade" ? 1 : 0 };
    }
    if (side === "new") {
      if (args[0] === "serve")
        return {
          ...success,
          code: null,
          signal: "SIGTERM",
          matched: fault !== "readiness",
          timedOut: fault === "timeout",
        };
      return { ...success, code: fault === "probe" ? 1 : 0 };
    }
    if (fault === "old-writes") await writeFile(join(live, "unexpected"), "changed\n");
    return { ...success, code: fault === "validation" ? 1 : 0 };
  });
  return {
    base,
    old,
    candidate,
    work,
    run,
    options: {
      work,
      entry: "fixture",
      checkouts: [old, candidate],
      describe: vi.fn(() => ({ fixture: true })),
      run,
      schemaRead: vi.fn(() => ({ fixture: true })),
    },
  };
}

it("passes only after complete equality, clean old validation and both negative controls", async () => {
  const { work, options } = await fixture();
  const report = await rehearse(options);
  expect(report.status).toBe("passed");
  expect(report.steps.restore.equalsPreUpgrade).toBe(true);
  expect(report.steps["negative restores"].partial.equal).toBe(false);
  expect(report.steps["negative restores"].mixed.equal).toBe(false);
  expect(JSON.parse(await readFile(join(work, "report.json"), "utf8")).status).toBe("passed");
});

it.each(["generate", "probe", "readiness", "timeout", "upgrade", "restore", "validation", "old-writes", "negative"])(
  "fails closed and preserves a failure report for %s",
  async (fault) => {
    const { work, options, run } = await fixture(fault);
    const report = await rehearse(options);
    expect(report.status).toBe("failed");
    expect(report.failure.message).toBeTruthy();
    const saved = JSON.parse(await readFile(join(work, "report.json"), "utf8"));
    expect(saved.status).toBe("failed");
    expect(saved.evidence).toContain("not installed evidence");
    expect(saved.steps).toEqual(report.steps);
    const validations = run.mock.calls.filter(([side, args]) => side === "old" && args[0] !== "demo");
    if (["generate", "probe", "readiness", "timeout", "upgrade", "restore"].includes(fault))
      expect(validations).toHaveLength(0);
    if (["validation", "old-writes"].includes(fault)) expect(validations).toHaveLength(1);
    if (fault === "restore") expect(saved.steps.restore.equalsPreUpgrade).toBe(false);
    if (fault === "negative") expect(saved.steps["negative restores"].mixed.equal).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "CLI refuses linked --work ancestry before writes or binary launches",
  async () => {
    const { base, old, candidate } = await fixture();
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "unchanged\n");
    await symlink(outside, join(base, "alias"));
    const marker = join(base, "launched");
    const fakeNode = join(base, "fake-node");
    await writeFile(fakeNode, `#!/bin/sh\nprintf launched > '${marker}'\nexit 1\n`, { mode: 0o700 });
    const result = spawnSync(
      process.execPath,
      [
        resolve("tools/store-compat-rehearsal/rehearse.js"),
        "--old",
        old,
        "--new",
        candidate,
        "--work",
        join(base, "alias", "new"),
        "--old-node",
        fakeNode,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LINK_REFUSED");
    expect(await readdir(outside)).toEqual(["sentinel"]);
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("unchanged\n");
    await expect(access(marker)).rejects.toThrow();
  },
);

it("CLI exits nonzero and saves evidence if metadata probing fails before generation", async () => {
  const { base, work } = await fixture();
  const checkout = resolve(".");
  const result = spawnSync(
    process.execPath,
    [
      resolve("tools/store-compat-rehearsal/rehearse.js"),
      "--old",
      checkout,
      "--new",
      checkout,
      "--work",
      work,
      "--old-node",
      join(base, "absent-node"),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status).toBe(1);
  const report = JSON.parse(await readFile(join(work, "report.json"), "utf8"));
  expect(report.status).toBe("failed");
  expect(report.steps).toEqual({});
  expect(report.failure.message).toContain("ENOENT");
});

it("refuses checkout overlap and preexisting work before callbacks or writes", async () => {
  const { old, work, options } = await fixture();
  await expect(rehearse({ ...options, work: join(old, "nested") })).rejects.toMatchObject({ code: "ROOT_OVERLAP" });
  expect(await readdir(old)).toEqual([]);
  await mkdir(work);
  await writeFile(join(work, "sentinel"), "keep\n");
  await expect(rehearse(options)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  expect(await readdir(work)).toEqual(["sentinel"]);
  expect(await readFile(join(work, "sentinel"), "utf8")).toBe("keep\n");
  expect(options.describe).not.toHaveBeenCalled();
  expect(options.run).not.toHaveBeenCalled();
});
