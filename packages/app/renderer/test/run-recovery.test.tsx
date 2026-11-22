// @vitest-environment happy-dom
/**
 * The run summary's recovery section (#357) against the fake preload bridge: what it shows,
 * when it is offered at all, and the two writes — a side-effect review and a checkpoint
 * attempt, whose idempotency key is kept across a lost answer and dropped after a refusal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  RecoveryAssessment,
  RecoveryCheckpoint,
  RecoveryStep,
  RunsGetResult,
  RunsRecoverParams,
} from "@orca/protocol";
import { StepDetail } from "../src/step/step-detail.js";
import { AS_OF, HELLO, RUN_DETAILS } from "./fixtures.js";
import { harness } from "./harness.js";
import { fakeBridge, type FakeBridge } from "./fake-bridge.js";

const RECOVERY_METHODS = ["runs.recovery", "runs.reviewEffect", "runs.recover"];

const FAILED: RunsGetResult = {
  ...RUN_DETAILS["run-parent"]!,
  run: { ...RUN_DETAILS["run-parent"]!.run, status: "failed" },
};

const step = (over: Partial<RecoveryStep>): RecoveryStep => ({
  runId: "run-parent",
  stepRunId: "s-deploy-1",
  nodeId: "deploy",
  nodeType: "agent",
  attempt: 1,
  status: "running",
  effect: "uncertain",
  asksAgain: false,
  answerCarried: false,
  artifactIds: [],
  missingArtifactIds: [],
  ...over,
});

const checkpoint = (over: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint => ({
  stepRunId: "s-build-2",
  nodeId: "build",
  attempt: 2,
  readiness: "available",
  blockers: [],
  unverified: [],
  reused: [step({ stepRunId: "s-build-2", nodeId: "build", effect: "reused", status: "completed" })],
  ranAfter: [],
  ...over,
});

const assessment = (over: Partial<RecoveryAssessment> = {}): RecoveryAssessment => ({
  runId: "run-parent",
  workflowId: "ai-sdlc",
  workflowVersion: "1",
  status: "failed",
  options: [
    { kind: "resume", readiness: "blocked", blockers: ["terminal"], unverified: [], runsAgain: [] },
    { kind: "new-run", readiness: "available", blockers: [], unverified: [], runsAgain: [] },
    {
      kind: "checkpoint-attempt",
      readiness: "available",
      blockers: [],
      unverified: [],
      checkpointStepRunId: "s-build-2",
      runsAgain: [],
    },
  ],
  checkpoints: [checkpoint()],
  uncertain: [],
  ...over,
});

let fake: FakeBridge;
const teardown: (() => void)[] = [];

afterEach(() => {
  cleanup();
  for (const undo of teardown.splice(0)) undo();
});

function mount(
  options: { methods?: readonly string[]; detail?: RunsGetResult; onOpenRun?: (id: string) => void } = {},
) {
  fake = fakeBridge({
    connection: {
      state: "live",
      since: AS_OF,
      orcaVersion: HELLO.orcaVersion,
      capabilities: HELLO.capabilities,
      methods: [...(HELLO.methods ?? []), ...(options.methods ?? RECOVERY_METHODS)],
    },
  });
  teardown.push(fake.install());
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <StepDetail detail={options.detail ?? FAILED} connection="live" onOpenRun={options.onOpenRun} />
    </Providers>,
  );
}

const section = (): HTMLElement => screen.getByRole("region", { name: "Recovery" });
const calls = (method: string) => fake.calls.filter((c) => c.method === method);

describe("the recovery section", () => {
  it("is not offered by a daemon that does not list runs.recovery", () => {
    mount({ methods: [] });
    expect(screen.queryByRole("region", { name: "Recovery" })).toBeNull();
    expect(calls("runs.recovery")).toHaveLength(0);
  });

  it("is not offered for a run that succeeded", () => {
    mount({ detail: { ...FAILED, run: { ...FAILED.run, status: "succeeded" } } });
    expect(screen.queryByRole("region", { name: "Recovery" })).toBeNull();
  });

  it("shows each option with the daemon's own reason", async () => {
    mount();
    fake.script({ "runs.recovery": () => ({ ok: true, result: { assessment: assessment(), asOf: AS_OF } }) });
    await screen.findByText("Resume: not available");
    expect(within(section()).getByText(/The run has ended\. Resume only continues/)).toBeTruthy();
    expect(within(section()).getByText("Checkpoint attempt: available")).toBeTruthy();
    expect(calls("runs.recovery")[0]!.params).toEqual({ runId: "run-parent" });
  });

  it("records a review and reads the assessment again", async () => {
    let reviewed = false;
    mount();
    fake.script({
      "runs.recovery": () => ({
        ok: true,
        result: {
          assessment: assessment({
            uncertain: [step(reviewed ? { review: "run-again", effect: "reviewed" } : {})],
          }),
          asOf: AS_OF,
        },
      }),
      "runs.reviewEffect": () => {
        reviewed = true;
        return { ok: true, result: { run: FAILED.run, asOf: AS_OF } };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Mark to run again" }));
    await screen.findByText("Marked to run again.");
    expect(calls("runs.reviewEffect")[0]!.params).toEqual({
      runId: "run-parent",
      stepRunId: "s-deploy-1",
      decision: "run-again",
    });
  });

  it("arms abandoning before it sends it", async () => {
    mount();
    fake.script({
      "runs.recovery": () => ({ ok: true, result: { assessment: assessment({ uncertain: [step({})] }), asOf: AS_OF } }),
      "runs.reviewEffect": () => ({ ok: true, result: { run: FAILED.run, asOf: AS_OF } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Abandon the run" }));
    expect(calls("runs.reviewEffect")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Abandon the run at deploy — confirm" }));
    await waitFor(() => expect(calls("runs.reviewEffect")).toHaveLength(1));
    expect(calls("runs.reviewEffect")[0]!.params).toMatchObject({ decision: "abandon" });
  });

  it("asks again with the same key after a lost answer, then opens the attempt", async () => {
    const onOpenRun = vi.fn();
    mount({ onOpenRun });
    let lost = true;
    fake.script({
      "runs.recovery": () => ({ ok: true, result: { assessment: assessment(), asOf: AS_OF } }),
      "runs.recover": () => {
        if (lost) {
          lost = false;
          return { ok: false, error: { code: "AGENT_TRANSPORT", message: "socket hang up" } };
        }
        return {
          ok: true,
          result: {
            state: "accepted",
            operationId: "retry_00000000-0000-4000-8000-000000000001",
            admissionId: "adm-1",
            runId: "run-attempt",
            sourceRunId: "run-parent",
          },
        };
      },
    });
    const start = await screen.findByRole("button", { name: "Start an attempt from here" });
    fireEvent.click(start);
    await screen.findByText(/socket hang up/);
    fireEvent.click(screen.getByRole("button", { name: "Start an attempt from here" }));
    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith("run-attempt"));
    const [first, second] = calls("runs.recover").map((c) => c.params as RunsRecoverParams);
    expect(first).toMatchObject({ runId: "run-parent", checkpoint: "s-build-2" });
    expect(first!.idempotencyKey).toBeTruthy();
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
  });

  it("starts a new intent after the daemon refuses one", async () => {
    mount();
    fake.script({
      "runs.recovery": () => ({ ok: true, result: { assessment: assessment(), asOf: AS_OF } }),
      "runs.recover": () => ({ ok: false, error: { code: "RECOVERY_BLOCKED", message: "a review is missing" } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Start an attempt from here" }));
    await screen.findByText(/a review is missing/);
    fireEvent.click(screen.getByRole("button", { name: "Start an attempt from here" }));
    await waitFor(() => expect(calls("runs.recover")).toHaveLength(2));
    const [first, second] = calls("runs.recover").map((c) => c.params as RunsRecoverParams);
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it("finishes a reserved attempt by reconciling its receipt, not by starting another", async () => {
    const onOpenRun = vi.fn();
    mount({ onOpenRun });
    const operationId = "retry_00000000-0000-4000-8000-000000000002";
    fake.script({
      "runs.recovery": () => ({ ok: true, result: { assessment: assessment(), asOf: AS_OF } }),
      "runs.recover": () => ({
        ok: true,
        result: {
          state: "recoverable-failure",
          operationId,
          admissionId: "adm-2",
          runId: "run-reserved",
          failure: { code: "RUN_STATE", message: "the process stopped", recovery: "reconcile" },
        },
      }),
      "runs.reconcileRecover": () => ({
        ok: true,
        result: {
          state: "accepted",
          operationId,
          admissionId: "adm-2",
          runId: "run-reserved",
          sourceRunId: "run-parent",
        },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Start an attempt from here" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish the attempt" }));
    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith("run-reserved"));
    expect(calls("runs.recover")).toHaveLength(1);
    expect(calls("runs.reconcileRecover")[0]!.params).toEqual({ operationId });
  });

  it("offers no start for a blocked checkpoint, and says why", async () => {
    mount();
    fake.script({
      "runs.recovery": () => ({
        ok: true,
        result: {
          assessment: assessment({
            checkpoints: [checkpoint({ readiness: "blocked", blockers: ["effect-unreviewed"] })],
          }),
          asOf: AS_OF,
        },
      }),
    });
    await screen.findByText(/did not finish\. Check what it did/);
    expect(screen.queryByRole("button", { name: "Start an attempt from here" })).toBeNull();
  });

  it("draws the read but no writes for a read-only daemon", async () => {
    mount({ methods: ["runs.recovery"] });
    fake.script({
      "runs.recovery": () => ({ ok: true, result: { assessment: assessment({ uncertain: [step({})] }), asOf: AS_OF } }),
    });
    await screen.findByText("Checkpoint attempt: available");
    expect(screen.queryByRole("button", { name: "Start an attempt from here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark to run again" })).toBeNull();
  });

  it("says where a checkpoint attempt and its reused steps came from", () => {
    const [first, ...rest] = FAILED.steps;
    const attempt: RunsGetResult = {
      ...FAILED,
      run: { ...FAILED.run, status: "running", checkpoint: { runId: "run-source", stepRunId: "s-build-2" } },
      steps: [
        { ...first!, reusedFrom: { runId: "run-source", stepRunId: "s-build-2" } },
        ...rest.map((s) => ({ ...s, effectReview: { decision: "run-again" as const, at: AS_OF } })),
      ],
    };
    mount({ detail: attempt });
    expect(screen.getByText(/A checkpoint attempt of/)).toBeTruthy();
    cleanup();
    render(<StepDetail detail={attempt} stepRunId={first!.id} connection="live" />, { wrapper: harness().Providers });
    expect(screen.getByText(/Reused from/)).toBeTruthy();
    cleanup();
    if (rest[0]) {
      render(<StepDetail detail={attempt} stepRunId={rest[0].id} connection="live" />, {
        wrapper: harness().Providers,
      });
      expect(screen.getByText("Effect reviewed: marked to run again.")).toBeTruthy();
    }
  });
});
