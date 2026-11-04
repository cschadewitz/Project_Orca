/** Execute the actual workflow selection step, including its refusal path. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { desktopMatrix } from "../desktop-matrix.js";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = parse(readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8"));
const selection = workflow.jobs.targets.steps.find((step) => step.id === "select");

it.each(["workflow_dispatch", "workflow_call", "push"])("defaults %s to the complete existing matrix", (event) => {
  const { include } = desktopMatrix(event);
  expect(include.map(({ name, os }) => ({ name, os }))).toEqual([
    { name: "linux", os: ["self-hosted", "linux", "x64", "homelab"] },
    { name: "macos", os: "macos-latest" },
    { name: "windows", os: "windows-latest" },
  ]);
  expect(include.every((target) => target.cache_path.trim().split("\n").length === 2)).toBe(true);
});

it("manual Windows selection contains only the unchanged Windows runner and caches", () => {
  const selected = desktopMatrix("workflow_dispatch", "windows").include;
  expect(selected).toEqual(desktopMatrix("workflow_call").include.filter((target) => target.name === "windows"));
  expect(selected).toHaveLength(1);
  expect(selected[0].cache_path).toBe(
    "~\\AppData\\Local\\electron\\Cache\n~\\AppData\\Local\\electron-builder\\Cache\n",
  );
});

it.each([
  ["workflow_dispatch", "linux"],
  ["workflow_dispatch", "WINDOWS"],
  ["workflow_call", "windows"],
  ["push", "windows"],
  [undefined, "windows"],
])("refuses unsupported selection %s / %s", (event, platform) => {
  expect(() => desktopMatrix(event, platform)).toThrow();
});

it("only manual dispatch offers reduction; packaging depends on selection at the same source", () => {
  expect(workflow.on.workflow_dispatch.inputs.platform).toMatchObject({ options: ["all", "windows"], default: "all" });
  expect(workflow.on.workflow_call.inputs).not.toHaveProperty("platform");
  expect(workflow.jobs.package.needs).toBe("targets");
  expect(workflow.jobs.package.strategy.matrix).toBe("${{ fromJSON(needs.targets.outputs.matrix) }}");
  expect(workflow.jobs.targets.outputs.matrix).toBe("${{ steps.select.outputs.matrix }}");
  expect(workflow.jobs.targets.steps[0].with.ref).toBe(workflow.jobs.package.steps[0].with.ref);
  expect(selection.env).toEqual({
    DESKTOP_EVENT_NAME: "${{ github.event_name }}",
    DESKTOP_PLATFORM: "${{ inputs.platform || 'all' }}",
  });
});

it.skipIf(process.platform === "win32")("the actual selection shell emits usable JSON and no output on refusal", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orca-desktop-matrix-"));
  const output = join(scratch, "output");
  const run = (event, platform) =>
    execFileSync("bash", ["-c", selection.run], {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, DESKTOP_EVENT_NAME: event, DESKTOP_PLATFORM: platform, GITHUB_OUTPUT: output },
      stdio: "pipe",
    });
  try {
    for (const platform of ["all", "windows"]) {
      writeFileSync(output, "");
      run("workflow_dispatch", platform);
      const line = readFileSync(output, "utf8");
      expect(line.startsWith("matrix=")).toBe(true);
      expect(JSON.parse(line.slice(7))).toEqual(desktopMatrix("workflow_dispatch", platform));
    }
    for (const [event, platform] of [
      ["workflow_dispatch", "invalid"],
      ["workflow_call", "windows"],
    ]) {
      writeFileSync(output, "");
      expect(() => run(event, platform)).toThrow();
      expect(readFileSync(output, "utf8")).toBe("");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
