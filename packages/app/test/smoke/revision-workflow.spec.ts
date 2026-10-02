/** Real renderer controls, production IPC, protected revision journal and deterministic ACP delivery. */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InputsListResultSchema,
  OperatorDiscoverySchema,
  PendingRevisionViewSchema,
  RevisionResultSchema,
  RunsGetResultSchema,
  type RevisionResult,
} from "@orca/protocol";
import type { OrcaBridge } from "../../src/bridge.js";
import { profileDirectoryEvidence, type AdmissionDaemon } from "./admission-daemon.js";
import { installRevisionSmokeObservation, type RevisionSmokeMain } from "./revision-smoke-observation.js";
import {
  pendingTarget,
  revisionEvidence,
  REVISION_FIXTURE as fixture,
  startRevisionDaemon,
  startRevisionRun,
} from "./revision-daemon.js";

const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const phaseTimeout = 30_000;
type ResolvedRevision = Extract<RevisionResult, { state: "resolved" }>;

async function bounded<T>(action: Promise<T>, phase: string, timeout = phaseTimeout): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Native revision acceptance blocked during ${phase}; no OS prompt was approved or security setting changed.`,
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function closeApp(app: ElectronApplication, graceful = false): Promise<void> {
  const child = app.process();
  const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;
  let forced = false;
  try {
    await bounded(app.close(), "Electron shutdown", 5_000);
  } catch {
    forced = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (exited) await bounded(exited, "Electron process exit", 10_000);
  if (graceful && forced) throw new Error("A full graceful Electron restart could not be established");
}
async function launch(daemon: AdmissionDaemon, profile: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !["ELECTRON_RUN_AS_NODE", "ORCA_RENDERER_URL", "ORCA_DAEMON_TOKEN"].includes(key))
      env[key] = value;
  }
  env.ORCA_DAEMON_URL = daemon.url;
  env.ORCA_DAEMON_TOKEN_FILE = daemon.tokenFile;
  const app = await electron
    .launch({ args: [`--user-data-dir=${profile}`, appDir], env, timeout: phaseTimeout })
    .catch(() => {
      // Playwright's launch error can include child arguments and the absolute profile.
      throw new Error("Native revision Electron launch failed; no OS prompt was approved or security setting changed.");
    });
  try {
    const page = await app.firstWindow({ timeout: phaseTimeout });
    await page.waitForLoadState("domcontentloaded");
    // Read-only readiness. Every tested mutation below starts with a real user control.
    await page.waitForFunction(() => {
      const bridge = (window as unknown as { orca: OrcaBridge }).orca;
      return bridge?.connection.read().state === "live" && bridge.daemonConnection?.read().identity !== undefined;
    });
    const status = await bounded(
      app.evaluate(({ app }) => ({
        ready: app.isReady(),
        userDataPath: app.getPath("userData"),
        platform: process.platform,
        electronVersion: process.versions.electron,
      })),
      "profile identity",
    );
    const { userDataPath, ...publicStatus } = status;
    const identity = { ...publicStatus, ...profileDirectoryEvidence(profile, userDataPath) };
    expect(identity).toMatchObject({
      ready: true,
      canonicalProfileMatches: true,
      directoryIdentityAvailable: true,
      sameDirectoryIdentity: true,
    });
    await observe(app);
    await page.keyboard.press("ControlOrMeta+Digit1");
    return { app, page, identity };
  } catch (error) {
    await closeApp(app);
    throw error;
  }
}

/**
 * Observe the actual compiled client without retaining request params or protected reads.
 * One replacement can pause immediately before HTTP so a second authenticated client
 * deterministically wins the CAS. A read-only timing barrier exercises recoverable refresh without replacing responses.
 * Writes always forward the original arguments and original daemon response unchanged.
 */
async function observe(app: ElectronApplication) {
  await bounded(
    app.evaluate(installRevisionSmokeObservation, join(appDir, "dist/client/daemon-client.js")),
    "installing sanitized RPC observation",
  );
}
async function observation(app: ElectronApplication) {
  return bounded(
    app.evaluate(() => {
      const {
        methods,
        receipts,
        errors,
        replacementWaiting,
        revisionReadsWaiting,
        activeRevisionReads,
        pendingReadsWaiting,
        delayedReadCount,
      } = (globalThis as unknown as RevisionSmokeMain).orcaRevisionSmoke;
      return {
        methods,
        receipts,
        errors,
        replacementWaiting,
        revisionReadsWaiting,
        activeRevisionReads,
        pendingReadsWaiting,
        delayedReadCount,
      };
    }),
    "reading sanitized RPC evidence",
  );
}
async function configureProbe(
  app: ElectronApplication,
  settings: {
    holdNextReplacement?: boolean;
    holdRevisionReads?: boolean;
    holdPendingReads?: boolean;
    release?: boolean;
  },
) {
  await bounded(
    app.evaluate((_electron, settings) => {
      const probe = (globalThis as unknown as RevisionSmokeMain).orcaRevisionSmoke;
      if (settings.holdNextReplacement !== undefined) probe.holdNextReplacement = settings.holdNextReplacement;
      if (settings.holdRevisionReads !== undefined) {
        probe.holdRevisionReads = settings.holdRevisionReads;
        if (!settings.holdRevisionReads) for (const release of probe.releaseRevisionReads.splice(0)) release();
      }
      if (settings.holdPendingReads !== undefined) {
        probe.holdPendingReads = settings.holdPendingReads;
        if (!settings.holdPendingReads) for (const release of probe.releasePendingReads.splice(0)) release();
      }
      if (settings.release) probe.releaseReplacement?.();
    }, settings),
    "configuring the bounded test barrier",
  );
}
async function receipt(app: ElectronApplication, index: number): Promise<ResolvedRevision> {
  await expect.poll(async () => (await observation(app)).receipts.length).toBe(index + 1);
  const result = RevisionResultSchema.parse((await observation(app)).receipts[index]!.value);
  if (result.state !== "resolved") throw new Error("The UI revision was not durably resolved");
  return result;
}
async function palette(page: Page, query: string, choice: string) {
  await page.keyboard.press("ControlOrMeta+KeyK");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.getByRole("combobox", { name: "Command palette" }).fill(query);
  await dialog.getByRole("option").filter({ hasText: choice }).click();
  await expect(dialog).toBeHidden();
}
async function resumeThroughUi(page: Page, runId: string) {
  await palette(page, `orca://run/${runId}`, "Open link");
  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();
  await tree.focus();
  await palette(page, `Resume ${fixture.workflowId}`, `Resume ${fixture.workflowId}`);
}

// No trace, screenshots, video, profiles or prompt logs are uploaded by this project.
test("revision controls survive restart and conflict, then deliver the reviewed correction exactly once", async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "orca-native-revision-")));
  const evidence: Record<string, unknown> = {
    fixture: "compiled authenticated CLI; one counter-free ACP agent; two sequential runs",
  };
  let daemon: AdmissionDaemon | undefined;
  let app: ElectronApplication | undefined;
  try {
    daemon = await startRevisionDaemon((probe) => {
      evidence.ownershipProbe = probe;
    });
    const discovery = OperatorDiscoverySchema.parse(await daemon.rpc("operator.discover"));
    expect(discovery.authentication).toBe("credential");
    const input = await startRevisionRun(daemon, "corrective-run");
    const boundary = input.revision!;
    let launched = await launch(daemon, profile);
    app = launched.app;
    evidence.firstProfile = launched.identity;
    const firstPid = app.process().pid;
    let page = launched.page;
    await expect(page.getByText(`Destination: ${fixture.destination}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: `gate, ${fixture.question}` })).toBeVisible();
    await page.getByRole("textbox", { name: "Correction", exact: true }).fill(fixture.initial);
    await page.getByRole("button", { name: "Request changes", exact: true }).click();
    const first = await receipt(app, 0);
    expect(first.result.target).toEqual(boundary.target);
    let recorded = page.getByRole("region", { name: "Recorded correction", exact: true });
    await expect(recorded.locator("pre")).toHaveText(fixture.initial);
    await expect(page.getByRole("region", { name: `gate, ${fixture.question}` })).toHaveCount(0);
    const expectedFirst = {
      receipt: first.result,
      operationId: first.operationId,
      principalId: discovery.principalId,
      workspaceId: discovery.target.workspaceId,
      text: fixture.initial,
    };
    evidence.atomicSave = await revisionEvidence(daemon, input.runId, "corrective-run", expectedFirst);
    expect(evidence.atomicSave).toMatchObject({
      promptCount: 0,
      revisionCommitCount: 1,
      atomicDecisionCount: 1,
      standaloneDecisionCount: 0,
      atomicDecisionMatches: true,
      committedPayloadMatches: true,
      exactReceiptMatches: true,
      exactProvenanceMatches: true,
      protectedMarkers: true,
      publicHistoryExcludesCorrections: true,
      workflowValuesExcludeCorrectionsAndRationale: true,
    });
    evidence.firstRpc = await observation(app);
    expect((await observation(app)).methods).toEqual(["inputs.revise"]);
    await closeApp(app, true);
    app = undefined;

    launched = await launch(daemon, profile);
    app = launched.app;
    page = launched.page;
    evidence.secondProfile = launched.identity;
    evidence.newProcess = app.process().pid !== firstPid;
    expect(evidence.newProcess).toBe(true);
    recorded = page.getByRole("region", { name: "Recorded correction", exact: true });
    await expect(recorded.locator("pre")).toHaveText(fixture.initial);
    await expect(recorded.getByText(`Destination: ${fixture.destination}`, { exact: true })).toBeVisible();
    const recovered = PendingRevisionViewSchema.parse(
      await daemon.rpc("inputs.revisionPending", { target: pendingTarget(first.result) }),
    );
    expect(recovered).toMatchObject({
      target: pendingTarget(first.result),
      expectedRevision: first.result.expectedRevision,
      state: "pending",
      replacementAllowed: true,
      payload: { kind: "text", text: fixture.initial },
    });
    expect((await observation(app)).methods).toEqual([]);
    evidence.pendingRecoveredAfterRestart = true;

    const draft = recorded.getByRole("textbox", { name: "Correction", exact: true });
    const replace = recorded.getByRole("button", { name: "Replace pending correction", exact: true });
    await draft.fill(fixture.final);
    await expect(replace).toBeEnabled();
    await configureProbe(app, { holdNextReplacement: true });
    await replace.click();
    await expect.poll(async () => (await observation(app!)).replacementWaiting).toBe(true);
    let competitor: ResolvedRevision;
    await configureProbe(app, { holdRevisionReads: true });
    try {
      // Drain calls already forwarded, then hold both lease-taking read routes while
      // competing writes reach the real CAS. No read result, notification or error is replaced.
      await expect.poll(async () => (await observation(app!)).activeRevisionReads).toBe(0);
      // This independent HTTP client owns the same synthetic principal, never the app's IPC.
      const competing = RevisionResultSchema.parse(
        await daemon.rpc("inputs.replaceRevision", {
          command: {
            target: pendingTarget(first.result),
            expectedRevision: recovered.expectedRevision,
            payload: { kind: "text", text: fixture.competing },
          },
          retry: { idempotencyKey: "native-revision-competing-client" },
        }),
      );
      expect(competing.state).toBe("resolved");
      if (competing.state !== "resolved") throw new Error("The competing client did not establish a new revision");
      competitor = competing;
      // The competitor's genuine notifications still reach the renderer and request refreshes.
      await expect.poll(async () => (await observation(app!)).revisionReadsWaiting).toBeGreaterThan(0);
      expect((await observation(app)).activeRevisionReads).toBe(0);
      await configureProbe(app, { release: true });
      await expect
        .poll(async () =>
          (await observation(app!)).errors.some(
            (entry) => entry.method === "inputs.replaceRevision" && entry.code === "REVISION_STALE",
          ),
        )
        .toBe(true);
      expect((await observation(app)).methods.filter((method) => method === "inputs.replaceRevision")).toHaveLength(1);
      evidence.staleCasReadBarrier = {
        readsDrained: true,
        notificationReadsHeld: true,
        originalMutationSentOnce: true,
      };
    } finally {
      // Failed assertions must not strand refreshes. Never retry the held mutation.
      await configureProbe(app, { holdRevisionReads: false });
    }
    await expect(
      recorded.getByText("The correction changed. Your draft is preserved; review the current correction.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(draft).toHaveValue(fixture.final);
    await expect(recorded.locator("pre")).toHaveText(fixture.competing);
    await expect(replace).toBeDisabled();
    evidence.staleCasPreservedDraft = true;

    // Delay the next real protected read until the checking state is visible.
    // No error, credential, target, daemon response or notification is fabricated.
    await configureProbe(app, { holdPendingReads: true });
    await recorded.getByRole("button", { name: "Refresh correction", exact: true }).click();
    await expect.poll(async () => (await observation(app!)).pendingReadsWaiting).toBeGreaterThan(0);
    await expect(
      recorded.getByText("Checking the current correction. Your draft is preserved.", { exact: true }),
    ).toBeVisible();
    await expect(draft).toHaveValue(fixture.final);
    await expect(replace).toBeDisabled();
    await configureProbe(app, { holdPendingReads: false });
    await expect(recorded.locator("pre")).toHaveText(fixture.competing);
    await expect(draft).toHaveValue(fixture.final);
    await recorded.getByRole("button", { name: "Use reviewed correction version", exact: true }).click();
    await expect(replace).toBeEnabled();
    await replace.click();
    const final = await receipt(app, 0);
    expect(final.result.target.destinationId).toBe(first.result.target.destinationId);
    expect(final.result.attemptId).toBe(first.result.attemptId);
    expect(final.result.revisionId).not.toBe(competitor.result.revisionId);
    await expect(recorded.locator("pre")).toHaveText(fixture.final);
    await expect(draft).toHaveValue("");
    evidence.recoverableRefreshPreservedDraft = true;
    const expectedFinal = {
      ...expectedFirst,
      receipt: final.result,
      operationId: final.operationId,
      text: fixture.final,
    };
    evidence.beforeContinuation = await revisionEvidence(daemon, input.runId, "corrective-run", expectedFinal);
    expect(evidence.beforeContinuation).toMatchObject({
      promptCount: 0,
      revisionCommitCount: 3,
      atomicDecisionCount: 1,
      exactReceiptMatches: true,
      exactProvenanceMatches: true,
      committedPayloadMatches: true,
    });

    await resumeThroughUi(page, input.runId);
    await expect
      .poll(async () => RunsGetResultSchema.parse(await daemon!.rpc("runs.get", { runId: input.runId })).run.status)
      .toBe("succeeded");
    await page.keyboard.press("ControlOrMeta+Digit1");
    recorded = page.getByRole("region", { name: "Recorded correction", exact: true });
    await expect(recorded.getByText(/Delivered/)).toBeVisible();
    await expect(
      recorded.getByText("The agent has already received this correction. It cannot be replaced.", { exact: true }),
    ).toBeVisible();
    const lateButton = recorded.getByRole("button", { name: "Replace pending correction", exact: true });
    expect((await lateButton.count()) === 0 || (await lateButton.isDisabled())).toBe(true);
    const delivered = PendingRevisionViewSchema.parse(
      await daemon.rpc("inputs.revisionPending", { target: pendingTarget(final.result) }),
    );
    expect(delivered).toMatchObject({ state: "delivered", replacementAllowed: false, unavailableReason: "delivered" });
    await expect(
      daemon.rpc("inputs.replaceRevision", {
        command: {
          target: pendingTarget(final.result),
          expectedRevision: delivered.expectedRevision,
          payload: { kind: "text", text: "SYNTHETIC-LATE: must never reach an agent" },
        },
        retry: { idempotencyKey: "native-revision-late-client" },
      }),
    ).rejects.toThrow("REVISION_STALE");
    evidence.delivery = await revisionEvidence(daemon, input.runId, "corrective-run", expectedFinal);
    expect(evidence.delivery).toMatchObject({
      promptCount: 1,
      agentStepCount: 1,
      agentDestinationMatches: true,
      exactAttemptExecuted: true,
      receiverHasExactProvenance: true,
      receiverHasExactCorrectionOnce: true,
      receiverExcludesSupersededCorrections: true,
      promptExcludesRationale: true,
      confirmedDeliveryCount: 1,
      protectedPromptMatchesReceiver: true,
      workflowValuesExcludeCorrectionsAndRationale: true,
      publicHistoryExcludesCorrections: true,
      completed: true,
    });
    evidence.lateReplacementRefused = true;

    const ordinary = await startRevisionRun(daemon, "ordinary-run");
    const gate = page.getByRole("region", { name: `gate, ${fixture.question}` });
    await expect(gate).toBeVisible();
    await gate.getByRole("button", { name: /Continue unchanged/ }).click();
    // The actual gate's documented Shift+Enter action opens its rationale field.
    await gate.focus();
    await page.keyboard.press("Shift+Enter");
    await gate.getByRole("textbox", { name: "Note", exact: true }).fill(fixture.rationale);
    await gate.getByRole("button", { name: "Answer", exact: true }).click();
    await expect
      .poll(async () => RunsGetResultSchema.parse(await daemon!.rpc("runs.get", { runId: ordinary.runId })).run.status)
      .toBe("succeeded");
    evidence.ordinaryRationale = await revisionEvidence(daemon, ordinary.runId, "ordinary-run");
    expect(evidence.ordinaryRationale).toMatchObject({
      promptCount: 1,
      revisionCommitCount: 0,
      standaloneDecisionCount: 1,
      rationaleRetainedWithDecision: true,
      promptHasNoRevision: true,
      promptExcludesRationale: true,
      workflowValuesExcludeCorrectionsAndRationale: true,
      agentStepCount: 1,
      agentDestinationMatches: true,
      completed: true,
    });
    expect(InputsListResultSchema.parse(await daemon.rpc("inputs.list")).waiting).toBe(0);
    evidence.finalRpc = await observation(app);
    expect((await observation(app)).methods).toEqual([
      "inputs.replaceRevision",
      "inputs.replaceRevision",
      "runs.resume",
      "inputs.answer",
    ]);
    expect((await observation(app)).delayedReadCount).toBeGreaterThan(0);
    // Re-read after the second sequential run: it must not cause any duplicate first delivery.
    expect(await revisionEvidence(daemon, input.runId, "corrective-run", expectedFinal)).toEqual(evidence.delivery);
    evidence.accepted = true;
  } finally {
    try {
      if (app) evidence.lastRpc = await observation(app).catch(() => ({ unavailable: true }));
      await test.info().attach("revision-workflow-evidence.json", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: "application/json",
      });
    } finally {
      try {
        if (app) await closeApp(app);
      } finally {
        try {
          await daemon?.stop();
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      }
    }
  }
});
