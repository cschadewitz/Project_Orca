/** Local recovery preserves the original standalone principal and never launches a replacement. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bootstrap } from "../src/bootstrap.js";
import { localSubmissionAuthority } from "../src/local-submission-authority.js";
import { admissionsCommand } from "../src/commands/admissions.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
it("discovers, inspects and reconciles a file-backed prepared admission after restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orca-cli-admission-"));
  directories.push(cwd);
  const configPath = join(cwd, "orca.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ workflows: ["flow.yaml"], templates: [], program: { workflow: "flow", itemWorkflow: "flow" } }),
  );
  await writeFile(
    join(cwd, "flow.yaml"),
    "id: flow\nname: Flow\nstart: start\nnodes: {start: {type: start}, end: {type: end}}\nedges: [{from: start, to: end}]\n",
  );
  const initial = await bootstrap({ cwd, configPath, submissionAuthority: localSubmissionAuthority });
  vi.spyOn(initial.orchestrator, "startRun").mockRejectedValueOnce(new Error("interrupted admission"));
  const prepared = await initial.program.submissions!.submit(
    { title: "private title", body: "private body" },
    initial.submissionAuthority!,
  );
  expect(prepared.state).toBe("recoverable-failure");
  const lines: string[] = [];
  const errors: string[] = [];
  const call = async (...positionals: string[]) => {
    lines.length = 0;
    return admissionsCommand({
      cwd,
      configPath,
      positionals,
      flags: {},
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
    });
  };
  expect(await call("list")).toBe(0);
  expect(JSON.parse(lines[0]!)).toEqual({ admissions: [prepared] });
  expect(lines.join(" ")).not.toContain("private title");
  expect(await call("inspect", prepared.admissionId)).toBe(1);
  expect(JSON.parse(lines[0]!)).toEqual(prepared);
  expect(await call("reconcile", prepared.admissionId)).toBe(0);
  const accepted = JSON.parse(lines[0]!);
  expect(accepted).toMatchObject({
    state: "accepted",
    admissionId: prepared.admissionId,
    requestId: prepared.requestId,
  });
  const restarted = await bootstrap({ cwd, configPath, submissionAuthority: localSubmissionAuthority });
  expect(await restarted.orchestrator.listRuns()).toEqual([accepted.runId]);
  expect((await restarted.orchestrator.getState(accepted.runId)).run.status).toBe("created");
  expect(errors.join(" ")).toContain(`orca resume ${accepted.runId}`);
  expect(await call("reconcile", prepared.admissionId)).toBe(0);
  expect(JSON.parse(lines[0]!)).toEqual(accepted);
  expect(await restarted.orchestrator.listRuns()).toEqual([accepted.runId]);
});

it.each([["unknown"], ["inspect"], ["reconcile"], ["list", "unexpected"]])(
  "rejects invalid recovery arguments before bootstrap: %j",
  async (...positionals) => {
    await expect(
      admissionsCommand({ cwd: "/path/not-opened", positionals, flags: {}, out: () => {}, err: () => {} }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  },
);
