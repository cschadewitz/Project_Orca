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
    { name: "linux", os: ["self-hosted", "linux", "x64", "tyler"] },
    { name: "macos", os: "macos-latest" },
    { name: "windows", os: "windows-latest" },
  ]);
  expect(include.every((target) => target.cache_path.trim().split("\n").length === 2)).toBe(true);
});

it("manual Windows selection leaves its runner and caches unchanged", () => {
  const selected = desktopMatrix("workflow_dispatch", "windows").include;
  expect(selected).toEqual(desktopMatrix("workflow_call").include.filter((target) => target.name === "windows"));
  expect(selected).toHaveLength(1);
  expect(selected[0].cache_path).toBe(
    "~\\AppData\\Local\\electron\\Cache\n~\\AppData\\Local\\electron-builder\\Cache\n",
  );
});

it.each(["workflow_dispatch", "workflow_call"])("%s moves only the Linux leg to a hosted fallback", (event) => {
  const tyler = desktopMatrix(event).include;
  expect(desktopMatrix(event, "all", "ubuntu-24.04").include).toEqual([
    { ...tyler[0], os: "ubuntu-24.04" },
    tyler[1],
    tyler[2],
  ]);
});

it.each([["self-hosted", "linux", "x64", "homelab"], "ubuntu-latest", "", ["self-hosted"]])(
  "refuses Linux runner %j",
  (linuxRunner) => {
    expect(() => desktopMatrix("workflow_dispatch", "all", linuxRunner)).toThrow();
  },
);

it("manual Windows/Linux selection uses only the two requested platforms", () => {
  const selected = desktopMatrix("workflow_dispatch", "windows-linux").include;
  const full = desktopMatrix("workflow_call").include;
  expect(selected).toEqual([full[0], full[2]]);
  expect(selected.map((target) => target.name)).toEqual(["linux", "windows"]);
});

it.each([
  ["workflow_dispatch", "linux"],
  ["workflow_dispatch", "WINDOWS"],
  ["workflow_call", "windows"],
  ["workflow_call", "windows-linux"],
  ["push", "windows"],
  ["push", "windows-linux"],
  [undefined, "windows"],
])("refuses unsupported selection %s / %s", (event, platform) => {
  expect(() => desktopMatrix(event, platform)).toThrow();
});

it("only manual dispatch offers reduction; packaging depends on selection at the same source", () => {
  expect(workflow.on.workflow_dispatch.inputs.platform).toMatchObject({
    options: ["all", "windows", "windows-linux"],
    default: "all",
  });
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["platform"]);
  expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(["ref", "version"]);
  expect(workflow.jobs.package.needs).toBe("targets");
  expect(workflow.jobs.package.strategy.matrix).toBe("${{ fromJSON(needs.targets.outputs.matrix) }}");
  expect(workflow.jobs.targets.outputs.matrix).toBe("${{ steps.select.outputs.matrix }}");
  expect(workflow.jobs.targets.steps[0].with.ref).toBe(workflow.jobs.package.steps[0].with.ref);
  expect(selection.env).toEqual({
    DESKTOP_EVENT_NAME: "${{ github.event_name }}",
    DESKTOP_PLATFORM: "${{ inputs.platform || 'all' }}",
    DESKTOP_LINUX_RUNNER: "${{ steps.pick.outputs.runner }}",
  });
  const pick = workflow.jobs.targets.steps.find(({ id }) => id === "pick");
  expect(pick.run).toBe("node tools/linux-runner.js");
  expect(workflow.jobs.targets.steps.indexOf(pick)).toBeLessThan(workflow.jobs.targets.steps.indexOf(selection));
  expect(Object.keys(workflow.on.workflow_call.secrets)).toEqual(["CI_RUNNER_HEALTH_URL"]);
});

it.skipIf(process.platform === "win32")("the actual selection shell emits usable JSON and no output on refusal", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orca-desktop-matrix-"));
  const output = join(scratch, "output");
  const run = (event, platform, linuxRunner) =>
    execFileSync("bash", ["-c", selection.run], {
      cwd: new URL("../../", import.meta.url),
      env: {
        ...process.env,
        DESKTOP_EVENT_NAME: event,
        DESKTOP_PLATFORM: platform,
        DESKTOP_LINUX_RUNNER: linuxRunner === undefined ? "" : JSON.stringify(linuxRunner),
        GITHUB_OUTPUT: output,
      },
      stdio: "pipe",
    });
  try {
    for (const platform of ["all", "windows", "windows-linux"]) {
      writeFileSync(output, "");
      run("workflow_dispatch", platform);
      const line = readFileSync(output, "utf8");
      expect(line.startsWith("matrix=")).toBe(true);
      expect(JSON.parse(line.slice(7))).toEqual(desktopMatrix("workflow_dispatch", platform));
    }
    for (const linuxRunner of ["ubuntu-24.04", ["self-hosted", "linux", "x64", "tyler"]]) {
      writeFileSync(output, "");
      run("workflow_call", "all", linuxRunner);
      expect(JSON.parse(readFileSync(output, "utf8").slice(7))).toEqual(
        desktopMatrix("workflow_call", "all", linuxRunner),
      );
    }
    for (const event of ["workflow_call", "push"]) {
      writeFileSync(output, "");
      run(event, "all");
      const line = readFileSync(output, "utf8");
      expect(line.startsWith("matrix=")).toBe(true);
      expect(JSON.parse(line.slice(7))).toEqual(desktopMatrix(event));
    }
    for (const [event, platform, linuxRunner] of [
      ["workflow_dispatch", "invalid"],
      ["workflow_call", "windows"],
      ["workflow_call", "windows-linux"],
      ["push", "windows"],
      ["workflow_call", "all", ["self-hosted", "linux", "x64", "homelab"]],
    ]) {
      writeFileSync(output, "");
      expect(() => run(event, platform, linuxRunner)).toThrow();
      expect(readFileSync(output, "utf8")).toBe("");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
