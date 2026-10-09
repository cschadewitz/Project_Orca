/** Bounded #396/R02/L02 proof through compiled authenticated serve and real reference MCP transports. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { serveWithInstalledPluginRelease } from "../../packages/cli/src/commands/index.ts";
import {
  ProductionFixture,
  accepted,
  refused,
  resolved,
  tool,
  transports,
  until,
} from "../../packages/integrations/test/mcp-operator-production-fixture.ts";
import { composePluginRelease } from "../plugin-release.js";

const fixtures = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = resolve("examples/m10-plugin/plugin.mjs");
const compiledCli = pathToFileURL(resolve("packages/cli/dist/index.js")).href;
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function prepare() {
  const f = await ProductionFixture.create((fixture) => fixtures.push(fixture));
  await f.stop();
  const candidate = await composePluginRelease({ plugins: [{ entry: source, id: "m10-owned", schemaVersion: 1 }] });
  await mkdir(join(f.dir, "plugins"));
  await writeFile(join(f.dir, "plugins/m10-owned.mjs"), candidate.bundles[0].bytes);
  await writeFile(join(f.dir, "plugin-release.json"), candidate.manifestBytes);
  await writeFile(join(f.dir, "workflows/m10.yaml"), await readFile("examples/m10-plugin/workflow.yaml"));
  const config = JSON.parse(await readFile(join(f.dir, "orca.config.yaml"), "utf8"));
  // Keep the existing isolated stores, auth directory and persistent synthetic identity/grants.
  config.plugins = ["./plugins/m10-owned.mjs"];
  await writeFile(join(f.dir, "orca.config.yaml"), JSON.stringify(config));
  // Independently maintained harness-only composition: literal pin, no runtime candidate reads.
  // This authorizes only a disposable synthetic fixture, never the checked-in UNAPPROVED launcher.
  const reference = {
    root: f.dir,
    manifestPath: "plugin-release.json",
    manifestSha256: digest(candidate.manifestBytes),
  };
  const launcher = join(f.dir, "operator-launch.mjs");
  await writeFile(
    launcher,
    `import { serveWithInstalledPluginRelease, installProcessErrorHandlers } from ${JSON.stringify(compiledCli)};
installProcessErrorHandlers({keepRunning:true});
process.exitCode = await serveWithInstalledPluginRelease({
  cwd: ${JSON.stringify(f.dir)}, configPath: ${JSON.stringify(join(f.dir, "orca.config.yaml"))},
  flags: {host:"127.0.0.1",port:"0"}, positionals:[],
  out: line => process.stdout.write(line+"\\n"), err: line => process.stderr.write(line+"\\n")
}, ${JSON.stringify(reference)}).catch(() => {
  process.stderr.write("M10 daemon startup refused\\n"); return 1;
});
`,
  );
  return { f, launcher, candidate };
}

async function boot(f, launcher, value) {
  const child = spawn(process.execPath, [launcher], {
    cwd: f.dir,
    env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", ORCA_M10_VALUE: value },
    stdio: "pipe",
  });
  let output = "";
  const capture = (chunk) => (output = (output + chunk.toString()).slice(-32768));
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  f.cleanup.push(() => f.stop(child));
  f.processes.push({ child, output: () => output });
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`Fixture daemon exited: ${output}`);
      return output;
    },
    (text) => /notifications on (ws:\/\/\S+)/.test(text),
    "owned release daemon readiness",
  );
  f.daemon = child;
  f.endpoint = /listening on (http:\/\/\S+)/.exec(output)[1];
  f.socketUrl = /notifications on (ws:\/\/\S+):/.exec(output)[1];
}

async function complete(f, peer, runId, key) {
  const input = await f.pending(peer, runId);
  const decision = {
    lifetime: "durable",
    runId,
    stepRunId: input.stepRunId,
    requestId: input.requestId,
    optionId: "go",
    resume: false,
  };
  await refused(peer, "respond_to_approval", { target: peer.target, decision: { ...decision, optionId: "wrong" } });
  await f.mutation(peer, "operator.answer", { target: peer.target, decision });
  // Exact durable answer alone leaves the run parked and produces no artifact.
  await f.status(peer, runId, "waiting");
  expect((await f.page(peer, "artifacts", { runId })).items).toHaveLength(0);
  await refused(peer, "respond_to_approval", { target: peer.target, decision });
  const params = {
    target: peer.target,
    command: { runId, expectedBoundary: await f.boundary(peer, runId) },
    retry: { idempotencyKey: key },
  };
  const receipt = resolved(await f.mutation(peer, "operator.continueRun", params));
  await f.status(peer, runId, "succeeded");
  const replay = resolved(await f.mutation(peer, "operator.continueRun", params));
  expect(replay).toMatchObject({ operationId: receipt.operationId, replayed: true, result: receipt.result });
  const artifacts = await f.page(peer, "artifacts", { runId });
  expect(artifacts.items).toHaveLength(1);
  const result = await tool(peer.client, "get_artifact", {
    target: peer.target,
    runId,
    artifactId: artifacts.items[0].artifactId,
  });
  const events = await f.observedEvents(peer, runId);
  expect(events.filter((event) => event.type === "run.created")).toHaveLength(1);
  expect(
    events.filter(
      (event) => event.type === "step.completed" && event.payload.result.data.implementation === "m10-owned-v1",
    ),
  ).toHaveLength(1);
  return result;
}

for (const transport of transports)
  it(`retains admitted custom state across a fresh authenticated daemon via ${transport}`, async (ctx) => {
    const { f, launcher } = await prepare();
    await boot(f, launcher, "old-model");
    const old = await f.connect(transport);
    const before = await tool(old.client, "discover_orca", {});
    await f.requireProduction(ctx, old);
    const admission = await f.start(old, "m10-owned", "owned-restart-intent");
    await f.pending(old, admission.runId);
    // Same retained credential and exact isolated store; new daemon process and boot identity.
    await f.stop();
    await boot(f, launcher, "new-model");
    const peer = await f.connect(transport);
    const after = await tool(peer.client, "discover_orca", {});
    expect(after).toMatchObject({
      principalId: before.principalId,
      scope: before.scope,
      operations: before.operations,
    });
    expect(peer.target.workspaceId).toBe(old.target.workspaceId);
    expect(peer.target.instanceId).not.toBe(old.target.instanceId);
    await refused(peer, "start_workflow", admission.params, "RUN_STATE");
    const replay = accepted(await f.mutation(peer, "operator.admitRun", { ...admission.params, target: peer.target }));
    expect(replay).toEqual({ ...admission.receipt, replayed: true });
    await refused(
      peer,
      "start_workflow",
      { ...admission.params, target: peer.target, command: { ...admission.params.command, vars: { changed: true } } },
      "RETRY_CONFLICT",
    );
    const historical = await complete(f, peer, admission.runId, "owned-historical-continuation");
    expect(historical.text).toContain('"model":"old-model"');
    expect(historical.text).not.toContain("new-model");
    // Control: a genuinely new admission uses the new current default.
    const fresh = await f.start(peer, "m10-owned", "owned-new-intent");
    expect(fresh.runId).not.toBe(admission.runId);
    expect((await complete(f, peer, fresh.runId, "owned-new-continuation")).text).toContain('"model":"new-model"');
  });

it("refuses an unauthenticated owned launcher before any bootstrap or listener", async () => {
  await expect(
    serveWithInstalledPluginRelease({ flags: { "unauthenticated-loopback": true } }, {}),
  ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

it("refuses tampered installed bundle bytes in the compiled adapter before readiness", async () => {
  const { f, launcher } = await prepare();
  await writeFile(join(f.dir, "plugins/m10-owned.mjs"), 'throw new Error("UNTRUSTED_PLUGIN_IMPORTED");\n');
  const child = spawn(process.execPath, [launcher], {
    cwd: f.dir,
    env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
    stdio: "pipe",
  });
  f.cleanup.push(() => f.stop(child));
  let output = "";
  child.stderr.on("data", (chunk) => (output = (output + chunk.toString()).slice(-32768)));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code).not.toBe(0);
  expect(output).toContain("M10 daemon startup refused");
  expect(output).not.toContain("UNTRUSTED_PLUGIN_IMPORTED");
  expect(output).not.toContain("listening on");
});

it("keeps the proposed literal-pin launcher UNAPPROVED even with environment overrides", async () => {
  const text = await readFile("tools/m10-operator/launch.mjs", "utf8");
  const bytes = await readFile("examples/m10-plugin/candidate/plugin-release.json");
  expect(text).toContain("const ROOT_APPROVED = false;");
  expect(text).toContain(digest(bytes));
  expect(text).not.toContain("process.env");
  const child = spawn(process.execPath, [resolve("tools/m10-operator/launch.mjs")], {
    env: {
      PATH: process.env.PATH ?? "",
      ROOT_APPROVED: "true",
      ORCA_RELEASE: "/untrusted",
      ORCA_M10_MANIFEST_SHA256: digest(bytes),
    },
    stdio: "pipe",
  });
  let output = "";
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code).not.toBe(0);
  expect(output).toContain("UNAPPROVED M10 plugin release");
  expect(output).not.toContain("listening on");
});
