/** Production CLI/ACP bootstrap uses real immutable generations and explicit, live authority. */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { bootstrapLocalOwner, openAuthDirectory } from "@orca/daemon";
import { bootstrap } from "../src/bootstrap.js";
import { localSubmissionAuthority } from "../src/local-submission-authority.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-request-production-"));
  dirs.push(dir);
  for (const id of ["alpha", "beta"])
    await writeFile(
      join(dir, `${id}.yaml`),
      `id: ${id}\nname: ${id}\nversion: '1'\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n`,
    );
  const config = (workflow = "alpha") =>
    parseOrcaConfig({ workflows: ["*.yaml"], templates: [], program: { workflow } });
  return { dir, config, options: { config: config(), configDir: dir, logger: silentLogger } };
}
it("does not invent embedder authority; explicit local admission persists ownership", async () => {
  const f = await fixture(),
    untrusted = await bootstrap(f.options);
  await expect(untrusted.program.submit({ title: "one", body: "" })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  const app = await bootstrap({ ...f.options, submissionAuthority: localSubmissionAuthority });
  const accepted = await app.program.submit({ title: "one", body: "body" });
  expect(accepted.admissionId).toBeTruthy();
  expect(app.submissionAuthority!.actor.principalId).toMatch(/^os-user-/);
  const owners = JSON.parse(await readFile(join(f.dir, "auth", "ownership.json"), "utf8"));
  expect(owners.runs[accepted.runId]).toBe(app.submissionAuthority!.actor.principalId);
  expect((await app.program.runSubmitted(accepted)).run.status).toBe("completed");
});
it("recovers the original run-missing generation after the active default changes", async () => {
  const f = await fixture(),
    first = await bootstrap({ ...f.options, submissionAuthority: localSubmissionAuthority });
  vi.spyOn(first.orchestrator, "startRun").mockRejectedValueOnce(new Error("simulated crash before run creation"));
  const result = await first.program.submissions!.submit(
    { title: "private request", body: "private body", expectedConfigGeneration: first.generations.current.snapshot.id },
    first.submissionAuthority!,
  );
  expect(result.state).toBe("recoverable-failure");
  const second = await bootstrap({
    ...f.options,
    config: f.config("beta"),
    submissionAuthority: localSubmissionAuthority,
  });
  const recovered = await second.program.submissions!.reconcile(result.admissionId, second.submissionAuthority!);
  expect(recovered.state).toBe("accepted");
  if (recovered.state !== "accepted") throw new Error("expected accepted recovery");
  expect((await second.orchestrator.getState(recovered.runId)).run.workflowId).toBe("alpha");
  expect((await second.program.runSubmitted(recovered)).run.status).toBe("completed");
  expect(await second.program.submissions!.reconcile(result.admissionId, second.submissionAuthority!)).toMatchObject({
    runId: recovered.runId,
  });
  await expect(
    second.generations.captureLaunch({
      purpose: "request",
      expectedConfigGeneration: first.generations.current.snapshot.id,
    }),
  ).rejects.toMatchObject({ code: "CONFIG_STALE" });
});
it("uses an existing credential without rotation and rechecks revocation before execution", async () => {
  const f = await fixture(),
    auth = openAuthDirectory(join(f.dir, "auth")),
    issued = await bootstrapLocalOwner(auth);
  const tokenBefore = await readFile(auth.tokenFile, "utf8"),
    app = await bootstrap({ ...f.options, submissionAuthority: localSubmissionAuthority });
  const admitted = await app.program.submit({ title: "one", body: "" });
  expect(app.submissionAuthority!.actor.credentialId).toBe(issued.credentialId);
  expect(await readFile(auth.tokenFile, "utf8")).toBe(tokenBefore);
  await auth.credentials.revoke(issued.credentialId);
  const run = vi.spyOn(app.orchestrator, "run");
  await expect(app.program.runSubmitted(admitted)).rejects.toBeTruthy();
  expect(run).not.toHaveBeenCalled();
  await expect(bootstrap({ ...f.options, submissionAuthority: localSubmissionAuthority })).rejects.toMatchObject({
    code: "RUN_STATE",
  });
});
it("invalidates captured standalone authority when token authentication is configured", async () => {
  const f = await fixture(),
    app = await bootstrap({ ...f.options, submissionAuthority: localSubmissionAuthority });
  await bootstrapLocalOwner(openAuthDirectory(join(f.dir, "auth")));
  await expect(app.program.submit({ title: "one", body: "" })).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("keeps strict request-only input schemas strict without injecting an undeclared program default", async () => {
  const f = await fixture();
  await writeFile(
    join(f.dir, "alpha.yaml"),
    `id: alpha
name: Alpha
version: '1'
inputSchema:
  unknown: reject
  fields:
    request: {type: object, required: true}
start: s
nodes: {s: {type: start}, e: {type: end}}
edges: [{from: s, to: e}]
`,
  );
  const app = await bootstrap({ ...f.options, submissionAuthority: localSubmissionAuthority });
  const admitted = await app.program.submit({ title: "Strict Request", body: "" });
  const state = await app.orchestrator.getState(admitted.runId);
  expect(Object.keys(state.run.vars)).toEqual(["request"]);
  await expect(
    app.program.submit({ title: "Bad", body: "", vars: { itemWorkflow: "undeclared" } }),
  ).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
  expect((await app.program.runSubmitted(admitted)).run.status).toBe("completed");
});
