/** The Windows ancestry ACL mask policy (#1217), compiled from the same header the native check uses. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const execute = promisify(execFile);
// Linux CI compiles it with cc; elsewhere the native Windows tests cover the check end to end.
const linux = process.platform === "linux";
let root: string;
let helper: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-acl-policy-"));
  helper = join(root, "acl-policy-test");
  if (linux)
    await execute("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(new URL("../native/diagnostics/acl-policy-test.c", import.meta.url)),
      "-o",
      helper,
    ]);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it.skipIf(!linux)(
  "tolerates the stock Modify grant on a volume root only, and refuses rights over the root's security or children",
  async () => {
    const { stdout } = await execute(helper, []).catch((error: { stdout?: string }) => {
      throw new Error(`ACL policy disagreed:\n${error.stdout ?? ""}`);
    });
    const lines = stdout.trim().split("\n");
    expect(lines.filter((line) => !line.startsWith("ok "))).toEqual([]);
    expect(lines).toContain("ok root modify");
    expect(lines).toContain("ok root delete-child");
    expect(lines).toContain("ok root write-dac");
    expect(lines).toContain("ok root write-owner");
    expect(lines).toContain("ok root generic-all");
    expect(lines).toContain("ok below modify");
  },
);
