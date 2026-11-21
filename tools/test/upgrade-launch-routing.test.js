/** Hold the upgrade launch check (#863) in ci.yml to app-smoke.yml's Linux launch rules. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));

const ci = workflow("ci.yml").jobs.check.steps;
const smoke = workflow("app-smoke.yml").jobs.smoke.steps;
const named = (steps, name) => steps.find((step) => step.name === name);
const index = (steps, name) => steps.findIndex((step) => step.name === name);
const RUN = "xvfb-run -a pnpm run app:upgrade-launch";

it("runs the upgrade launch check after the build, only when it was decided to", () => {
  const check = named(ci, "Upgrade launch check");
  expect(check.run).toBe(RUN);
  expect(check.if).toBe("steps.launch.outputs.run == 'true'");
  expect(check["timeout-minutes"]).toBeLessThanOrEqual(5);
  expect(index(ci, "Upgrade launch check")).toBeGreaterThan(ci.findIndex((step) => step.run === "pnpm run build"));
  const decide = ci.find((step) => step.id === "launch");
  expect(decide.if).toBe("needs.changes.outputs.code != 'false'");
  // Main pushes always run it; pull requests run it for what ships and for the fixture.
  expect(decide.run).toContain('if [ "$GITHUB_EVENT_NAME" != "pull_request" ]; then');
  for (const path of [
    "/^packages\\//",
    "/^pnpm-lock\\.yaml$/",
    "/^pnpm-workspace\\.yaml$/",
    "/^patches\\//",
    "/^tsconfig[^\\/]*\\.json$/",
    "/^release-compatibility\\.json$/",
  ])
    expect(decide.run).toContain(path);
});

it("prepares Linux exactly as app-smoke.yml's smoke job does, after the binary is on disk", () => {
  for (const name of ["Check the Linux display and sandbox prerequisites", "Prepare a GitHub-hosted Linux runner"]) {
    const ours = named(ci, name);
    const theirs = named(smoke, name);
    expect(ours.run, name).toBe(theirs.run);
    expect(ours.env, name).toEqual(theirs.env);
    // ci.yml adds the launch decision to the runner-environment condition and nothing else.
    expect(ours.if).toBe(`steps.launch.outputs.run == 'true' && ${theirs.if}`);
    expect(index(ci, name)).toBeGreaterThan(ci.findIndex((step) => step.id === "electron"));
  }
  expect(ci.find((step) => step.id === "electron")["working-directory"]).toBe("packages/app");
});

it("never lets ci.yml's install fetch the binary for every other step", () => {
  const install = ci.find((step) => step.run === "pnpm install --frozen-lockfile");
  expect(install.env).toEqual({ ELECTRON_SKIP_BINARY_DOWNLOAD: 1 });
});

it("runs the same check in release verification, and says when an older ref predates it", () => {
  const step = named(smoke, "Upgrade launch check");
  expect(step.run.trimEnd().split("\n").at(-1)).toBe(RUN);
  // Required unless a caller says otherwise; a manual run has no such input and is not required.
  expect(step.env).toEqual({ REQUIRED: "${{ inputs.upgrade_launch_required && 'true' || 'false' }}" });
  expect(step.run).toMatch(/if \[ "\$REQUIRED" = "true" \]; then\s+echo "::error::[^\n]*\n\s+exit 1/);
  expect(step.run).toContain("::notice title=Upgrade launch check::not applicable");
  expect(index(smoke, "Upgrade launch check")).toBeGreaterThan(index(smoke, "Build"));
});
