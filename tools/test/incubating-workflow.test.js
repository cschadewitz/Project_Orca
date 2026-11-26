// .github/workflows/incubating.yml: dark code (incubating feature flags) stays tested.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = parse(readFileSync(resolve(".github/workflows/incubating.yml"), "utf8"));
const job = workflow.jobs.incubating;
const step = (name) => job.steps.find((s) => s.name === name);

describe("the incubating features workflow", () => {
  it("runs nightly, on pushes to main and feature branches, and on dispatch, on GitHub-hosted runners", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "schedule", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["main", "feature/**"]);
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("runs the whole suite with every incubating flag on, and only when there is one", () => {
    const test = step("Test with every incubating flag on");
    expect(test.env).toEqual({ ORCA_INCUBATING: "all" });
    expect(test.if).toBe("steps.flags.outputs.names != ''");
    expect(step("Build").if).toBe("steps.flags.outputs.names != ''");
  });

  it("reads the registry without a build", () => {
    // The same import the step makes; Node 24 strips the types by default, 22 behind a flag.
    const script = /node --input-type=module -e '([\s\S]*?)'\s*\)/.exec(step("Incubating flags").run)[1];
    const out = execFileSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
      },
    );
    expect(out.trim()).toBe("");
  });
});
