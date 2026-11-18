/** Hold app-smoke's runner routing and checks; native prerequisites still require runner proof. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = parse(readFileSync(new URL("../../.github/workflows/app-smoke.yml", import.meta.url), "utf8"));
const proof = workflow.jobs["type-proof"];
const matrix = proof.strategy.matrix.include;
const linux = matrix.find((entry) => entry.os === "ubuntu-latest");
const picked = "${{ fromJSON(needs.runner.outputs.runner) }}";

it("routes the heavy Linux jobs to the runner the picker chose, from the workflow's own commit", () => {
  expect(workflow.jobs.smoke["runs-on"]).toBe(picked);
  expect(workflow.jobs.smoke.needs).toBe("runner");
  expect(linux.runner).toBe(picked);
  expect(workflow.jobs.changes["runs-on"]).toBe("ubuntu-24.04");
  const runner = workflow.jobs.runner;
  expect(runner["runs-on"]).toBe("ubuntu-24.04");
  expect(runner.outputs.runner).toBe("${{ steps.pick.outputs.runner }}");
  const checkout = runner.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  expect(checkout.with.ref).toBeUndefined();
  const pick = runner.steps.find(({ id }) => id === "pick");
  expect(pick.run).toBe("node tools/linux-runner.js");
  expect(pick.env).toEqual({
    FORCE_HOSTED: "${{ vars.CI_FORCE_HOSTED }}",
    HEALTH_URL: "${{ secrets.CI_RUNNER_HEALTH_URL }}",
  });
  expect(Object.keys(workflow.on.workflow_call.secrets)).toEqual(["CI_RUNNER_HEALTH_URL"]);
});

it("prepares only GitHub-hosted Linux runners, never a self-hosted one", () => {
  for (const job of [workflow.jobs.smoke, proof]) {
    const prep = job.steps.find(({ name }) => name === "Prepare a GitHub-hosted Linux runner");
    expect(prep.if).toBe("runner.os == 'Linux' && runner.environment == 'github-hosted'");
    const names = job.steps.map(({ name }) => name);
    expect(names.indexOf("Prepare a GitHub-hosted Linux runner")).toBeLessThan(
      names.indexOf("Check the Linux display and sandbox prerequisites"),
    );
  }
});

it("keeps release-call inputs, exact test checkouts and both native hosted legs", () => {
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["ref"]);
  expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(["ref"]);
  expect(matrix.map(({ os }) => os)).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
  for (const entry of matrix.filter(({ os }) => os !== "ubuntu-latest")) expect(entry.runner).toBe(entry.os);
  expect(proof["runs-on"]).toBe("${{ matrix.runner }}");
  expect(proof.needs).toEqual(["changes", "runner"]);
  expect(proof.strategy["fail-fast"]).toBe(false);
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const job of Object.values(workflow.jobs).filter((job) => job !== workflow.jobs.runner))
    for (const step of job.steps.filter(({ uses }) => uses?.startsWith("actions/checkout@")))
      expect(step.with.ref).toBe("${{ inputs.ref || github.sha }}");
});

it("retains Linux prerequisite refusals, smoke/type proof and native restart acceptance", () => {
  for (const job of [workflow.jobs.smoke, proof]) {
    const check = job.steps.find(({ name }) => name === "Check the Linux display and sandbox prerequisites");
    expect(check.run).toContain("command -v xvfb-run");
    expect(check.run).toContain("unshare --user --map-root-user true");
    expect(check.run).toContain("exit 1");
    const commands = job.steps.map(({ run }) => run ?? "").join("\n");
    expect(commands).not.toMatch(/--no-sandbox|ORCA_SMOKE_NO_SANDBOX/);
  }
  expect(workflow.jobs.smoke.steps.some(({ run }) => run === "xvfb-run -a pnpm run app:smoke")).toBe(true);
  for (const command of [
    "xvfb-run -a pnpm run app:type-proof",
    "pnpm run app:type-proof",
    "pnpm run app:admission-intents",
    "pnpm run app:revision-workflow",
  ])
    expect(proof.steps.some(({ run }) => run === command)).toBe(true);
});
