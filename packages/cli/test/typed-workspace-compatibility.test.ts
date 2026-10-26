/** Real pre-producer CLI boundaries, no installed service or operator data. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig } from "@orca/core";
import { bootstrap, loadConfig } from "../src/bootstrap.js";
import { authCommand } from "../src/commands/auth.js";
import { enterConfiguredUpdateBootstrap } from "../src/update-bootstrap.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), "orca-typed-cli-"));
  roots.push(root);
  await writeFile(join(root, ".orca-typed-workspace"), "synthetic refusal evidence\n", { mode: 0o600 });
  await writeFile(join(root, "orca.config.yaml"), "storeDir: .orca\n", { mode: 0o600 });
  return root;
}
it("direct bootstrap/config/auth entrypoints refuse before stores, plugins or credentials", async () => {
  const root = await fixture(),
    before = await readdir(root);
  await expect(bootstrap({ cwd: root })).rejects.toThrow("trusted Linux inspection bridge");
  await expect(
    bootstrap({ cwd: root, config: parseOrcaConfig({ plugins: ["never-load-this-plugin"] }), configDir: root }),
  ).rejects.toThrow("trusted Linux inspection bridge");
  await expect(loadConfig(root)).rejects.toThrow("trusted Linux inspection bridge");
  await expect(enterConfiguredUpdateBootstrap(root, join(root, ".orca"))).rejects.toThrow(
    "trusted Linux inspection bridge",
  );
  await expect(
    authCommand({ cwd: root, flags: {}, positionals: ["list"], out: vi.fn(), err: vi.fn() }),
  ).rejects.toThrow("trusted Linux inspection bridge");
  expect(await readdir(root)).toEqual(before);
});
it("resolved store role cannot evade the guard by placing config elsewhere", async () => {
  const root = await fixture(),
    outside = join(root, "outside");
  await mkdir(outside);
  await expect(
    bootstrap({ cwd: outside, config: parseOrcaConfig({ storeDir: root }), configDir: outside }),
  ).rejects.toThrow("trusted Linux inspection bridge");
  expect(await readdir(outside)).toEqual([]);
});
it("actual argv refuses demo/auth/serve/acp before producers while help/version stay usable", async () => {
  const root = await fixture();
  const cli = resolve("packages/cli/src/main.ts");
  const execute = (args: string[]) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], { timeout: 15000 });
  const before = await readdir(root),
    evidence = await readFile(join(root, ".orca-typed-workspace"));
  for (const args of [
    ["demo", "--dir", root],
    ["auth", "list", "--cwd", root],
    ["serve", "--cwd", root],
    ["acp", "--cwd", root],
  ]) {
    await expect(execute(args)).rejects.toThrow("trusted Linux inspection bridge");
  }
  expect((await execute(["--help", "--cwd", root])).stdout).toContain("usage:");
  expect((await execute(["--version", "--cwd", root])).stdout).toMatch(/^\d+\.\d+\.\d+/);
  expect(await readdir(root)).toEqual(before);
  expect(await readFile(join(root, ".orca-typed-workspace"))).toEqual(evidence);
});
