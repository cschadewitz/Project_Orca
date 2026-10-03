/** Capture the actual serve command's Request callbacks, including its construction guards. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { silentLogger, type RunState } from "@orca/core";
import { ProgramService, type ExecutionResumeAuthority } from "@orca/engine";
import * as daemonModule from "@orca/daemon";
import * as bootstrapModule from "../src/bootstrap.js";
import { commands, type CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function serving(
  flags: CommandContext["flags"],
  withoutSubmissions: boolean,
  check: (fixture: {
    app: bootstrapModule.OrcaApp;
    requestModel: MockInstance<typeof daemonModule.RequestSubmissionModel>;
    runtimeFactory: MockInstance<typeof daemonModule.daemonExecutionRuntime>;
    start: MockInstance<typeof daemonModule.startDaemon>;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "orca-serve-request-wiring-"));
  dirs.push(dir);
  await writeFile(join(dir, "orca.config.yaml"), "workflows: [program.yaml]\ntemplates: []\n");
  await writeFile(
    join(dir, "program.yaml"),
    "id: program\nname: Program\nstart: start\nnodes:\n  start: {type: start}\n  end: {type: end}\nedges:\n  - {from: start, to: end}\n",
  );
  const app = await bootstrapModule.bootstrap({ cwd: dir, logger: silentLogger });
  if (withoutSubmissions) app.program = new ProgramService(app.orchestrator);
  vi.spyOn(bootstrapModule, "bootstrap").mockResolvedValue(app);
  // Reuse the real app and replace the listener, calling through the model/runtime
  // constructors. The callbacks must come from serve, not a test-owned factory.
  const requestModel = vi.spyOn(daemonModule, "RequestSubmissionModel");
  const runtimeFactory = vi.spyOn(daemonModule, "daemonExecutionRuntime");
  const close = vi.fn(async () => {});
  const start = vi.spyOn(daemonModule, "startDaemon").mockResolvedValue({
    host: "127.0.0.1",
    port: 0,
    url: "http://127.0.0.1:0",
    close,
  });
  const ready = deferred<void>();
  const run = commands.serve!.run({
    cwd: dir,
    positionals: [],
    flags: { port: "0", ...flags },
    out: (line) => {
      if (line.startsWith("authentication:")) ready.resolve();
    },
    err: () => {},
  });
  await Promise.race([
    ready.promise,
    run.then(() => {
      throw new Error("serve ended before readiness");
    }),
  ]);
  try {
    await check({ app, requestModel, runtimeFactory, start });
  } finally {
    process.emit("SIGTERM");
    expect(await run).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  }
}

it("forwards the exact Request run and resume authority through preflight, scoped execution and settlement", async () => {
  await serving({}, false, async ({ app, requestModel, runtimeFactory, start }) => {
    expect(requestModel).toHaveBeenCalledOnce();
    expect(runtimeFactory).toHaveBeenCalledOnce();
    const callbacks = requestModel.mock.calls[0]![0];
    const runtime = runtimeFactory.mock.results[0]!.value as ReturnType<typeof daemonModule.daemonExecutionRuntime>;
    expect(callbacks.service).toBe(app.program.submissions);
    expect(start.mock.calls[0]![0].requestSubmissions).toBe(requestModel.mock.results[0]!.value);
    expect(start.mock.calls[0]![0].auth?.mode).toBe("token");

    const runId = await app.orchestrator.startRun({ workflowId: "program" });
    const state = await app.orchestrator.getState(runId);
    const authority: ExecutionResumeAuthority = {
      actor: { principalId: "original-owner", credentialId: "renewed-credential" },
      authorize: vi.fn(async () => {}),
    };
    const preflight = vi.spyOn(runtime, "checkResumeAuthority").mockResolvedValue(undefined);
    await callbacks.checkResumeAuthority!(runId, authority);
    expect(preflight).toHaveBeenCalledExactlyOnceWith(runId, authority);
    expect(preflight.mock.calls[0]![1]).toBe(authority);
    const refusal = new Error("resume authority refused");
    preflight.mockRejectedValueOnce(refusal);
    await expect(callbacks.checkResumeAuthority!(runId, authority)).rejects.toBe(refusal);

    const runResult = deferred<RunState>();
    const runStarted = deferred<void>();
    const settlement = deferred<undefined>();
    const settlementStarted = deferred<void>();
    let insideAuthority = false;
    const execute = vi.spyOn(app.orchestrator, "run").mockImplementation(() => {
      expect(insideAuthority).toBe(true);
      runStarted.resolve();
      return runResult.promise;
    });
    const scoped = vi.spyOn(runtime, "withResumeAuthority").mockImplementation(async (_id, _authority, operation) => {
      expect(execute).not.toHaveBeenCalled();
      insideAuthority = true;
      try {
        return await operation();
      } finally {
        insideAuthority = false;
      }
    });
    const settle = vi.spyOn(app.program, "settle").mockImplementation(() => {
      settlementStarted.resolve();
      return settlement.promise;
    });
    let finished = false;
    const execution = callbacks.execute(runId, authority).then(() => {
      finished = true;
    });
    try {
      await runStarted.promise;
      expect(scoped).toHaveBeenCalledExactlyOnceWith(runId, authority, expect.any(Function));
      expect(scoped.mock.calls[0]![1]).toBe(authority);
      expect(execute).toHaveBeenCalledExactlyOnceWith(runId);
      expect(settle).not.toHaveBeenCalled();
      runResult.resolve(state);
      await settlementStarted.promise;
      expect(settle).toHaveBeenCalledExactlyOnceWith(state);
      expect(settle.mock.calls[0]![0]).toBe(state);
      // Let an incorrectly unawaited settle() finish the callback before asserting.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally {
      runResult.resolve(state);
      settlement.resolve(undefined);
      await execution;
    }
    expect(finished).toBe(true);
  });
});

it.each([
  { readOnly: false, unauthenticated: false, withoutSubmissions: false, expected: true },
  { readOnly: true, unauthenticated: false, withoutSubmissions: false, expected: false },
  { readOnly: false, unauthenticated: true, withoutSubmissions: false, expected: false },
  { readOnly: true, unauthenticated: true, withoutSubmissions: false, expected: false },
  { readOnly: false, unauthenticated: false, withoutSubmissions: true, expected: false },
])("guards Request construction: %j", async ({ readOnly, unauthenticated, withoutSubmissions, expected }) => {
  await serving(
    { "read-only": readOnly, "unauthenticated-loopback": unauthenticated },
    withoutSubmissions,
    async ({ requestModel, runtimeFactory, start }) => {
      expect(requestModel).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(runtimeFactory).toHaveBeenCalledTimes(!readOnly && !unauthenticated ? 1 : 0);
      const options = start.mock.calls[0]![0];
      expect(options.auth?.mode).toBe(unauthenticated ? "loopback-unauthenticated" : "token");
      expect(Boolean(options.control)).toBe(!readOnly);
      if (expected) expect(options.requestSubmissions).toBe(requestModel.mock.results[0]!.value);
      else expect(options.requestSubmissions).toBeUndefined();
    },
  );
});
