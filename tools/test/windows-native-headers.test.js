/** Exercise the workflow's real tar command with a drive-letter path, without downloads. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = parse(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
const step = workflow.jobs.package.steps.find(
  (entry) => entry.name === "Stage native addons for all requested Windows architectures",
);
const extraction = step.run.split("\n").find((line) => line.includes("tar -xzf"));

it.skipIf(process.platform === "win32")("extracts verified headers from a drive-letter path with spaces", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orca-windows-headers-"));
  // On POSIX, this relative directory reproduces GNU tar's host:path interpretation
  // of the absolute D:/... path returned by mktemp in Git Bash on the Windows runner.
  const headers = "D:/runner temp/native headers";
  const archive = "node-v24.0.0-headers.tar.gz";
  const fixture = join(scratch, "fixture");
  const expected = "/* synthetic Node header */\n";
  try {
    mkdirSync(join(scratch, headers), { recursive: true });
    mkdirSync(join(fixture, "node-v24.0.0"), { recursive: true });
    writeFileSync(join(fixture, "node-v24.0.0/node.h"), expected);
    execFileSync("tar", ["-czf", join(scratch, headers, archive), "-C", fixture, "node-v24.0.0"]);
    expect(extraction).toBeDefined();
    const run = () =>
      execFileSync("bash", ["-c", `set -euo pipefail\n${extraction}\nprintf extracted`], {
        cwd: scratch,
        env: { ...process.env, headers_scratch: headers, archive },
        encoding: "utf8",
        stdio: "pipe",
        timeout: 5000,
      });
    expect(run()).toBe("extracted");
    expect(readFileSync(join(scratch, headers, "node-v24.0.0/node.h"), "utf8")).toBe(expected);
    writeFileSync(join(scratch, headers, archive), "invalid archive");
    expect(run).toThrow();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
