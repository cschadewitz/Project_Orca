/** Bounded revision fixture over the compiled, authenticated CLI and protected stores. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { InputsListResultSchema, type RevisionReceipt } from "@orca/protocol";
import type { RevisionJournalEntry } from "../../../engine/src/revision-input.js";
import { startAdmissionDaemon, type AdmissionDaemon, type OwnershipProbeEvidence } from "./admission-daemon.js";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
export const REVISION_FIXTURE = {
  workflowId: "native-revision-smoke",
  question: "Review the synthetic revision attempt?",
  destination: "designated-worker",
  agentId: "native-revision-agent",
  initial: "SYNTHETIC-INITIAL: change the heading to amber.",
  competing: "SYNTHETIC-COMPETING: change the heading to violet.",
  final: "SYNTHETIC-FINAL: change the heading to teal. Keep {{literal}} intact.",
  rationale: "SYNTHETIC-RATIONALE-ONLY: accepted after manual inspection.",
} as const;

/** No deliverables means ScriptedAgent.prompt returns before loadState/saveState or counters. */
export function startRevisionDaemon(report: (evidence: OwnershipProbeEvidence) => void = () => {}) {
  return startAdmissionDaemon(report, {
    workflow: {
      id: REVISION_FIXTURE.workflowId,
      name: "Native revision acceptance",
      version: "1",
      start: "start",
      nodes: {
        start: { type: "start" },
        review: {
          type: "gate",
          question: REVISION_FIXTURE.question,
          options: [
            { id: "changes", label: "Request changes" },
            { id: "continue", label: "Continue unchanged" },
          ],
          revision: {
            actionId: "changes",
            destinationNodeId: REVISION_FIXTURE.destination,
            payload: { kind: "text", maxBytes: 4096 },
            composition: "replace-revision-slot",
          },
        },
        [REVISION_FIXTURE.destination]: {
          type: "agent",
          agent: REVISION_FIXTURE.agentId,
          // Include public provenance in the synthetic prompt so the receiver, not only
          // the journal, proves which exact human revision reached this single attempt.
          prompt: [
            "Native revision acceptance. Run marker: {{vars.marker}}",
            "{{#if revision}}Revision identity: {{revision.revisionId}}",
            "Revision author: {{revision.provenance.actor.principalId}}",
            "Revision workspace: {{revision.provenance.workspaceId}}",
            "Revision operation: {{revision.provenance.operationId}}",
            "Revision source: {{revision.provenance.source}}{{/if}}",
          ].join("\n"),
        },
        done: { type: "end", outcome: "success" },
      },
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: REVISION_FIXTURE.destination, when: "choice == 'changes'" },
        { from: "review", to: REVISION_FIXTURE.destination, when: "choice == 'continue'" },
        { from: REVISION_FIXTURE.destination, to: "done" },
      ],
    },
    agents: (dir) => [
      {
        id: REVISION_FIXTURE.agentId,
        command: process.execPath,
        args: [join(root, "packages/testing/dist/scripted-agent/main.js"), "--log", join(dir, "prompts.jsonl")],
        env: { ORCA_PLAYBOOK_JSON: "{}", ORCA_CONFIG_OPTIONS_JSON: "[]" },
        hostId: "local",
        roles: [],
        turnTimeoutMs: 30_000,
        cancelGraceMs: 500,
      },
    ],
  });
}

/** Seed only an actual parked gate. The acceptance test performs its decisions through the UI. */
export async function startRevisionRun(daemon: AdmissionDaemon, marker: string) {
  await daemon.rpc("runs.start", { workflowId: REVISION_FIXTURE.workflowId, vars: { marker } });
  const inputs = InputsListResultSchema.parse(await daemon.rpc("inputs.list"));
  const input = inputs.inputs.find((candidate) => candidate.question === REVISION_FIXTURE.question);
  if (!input?.revision) throw new Error("The compiled revision fixture did not expose its declared gate");
  return input;
}

export function pendingTarget(receipt: RevisionReceipt) {
  return {
    runId: receipt.target.runId,
    revisionId: receipt.revisionId,
    destinationId: receipt.target.destinationId,
    attemptId: receipt.attemptId,
  };
}

export interface ExpectedRevision {
  receipt: RevisionReceipt;
  operationId: string;
  principalId: string;
  workspaceId: string;
  text: string;
}

/**
 * Called only after writes quiesce. Raw events, prompt logs and config never leave this
 * helper. Load this checkout's compiled implementations, not a source alias or sibling.
 */
export async function revisionEvidence(
  daemon: AdmissionDaemon,
  runId: string,
  marker: string,
  expected?: ExpectedRevision,
) {
  const { fileStores, executionEvents } = (await import(
    pathToFileURL(join(root, "packages/store/dist/index.js")).href
  )) as typeof import("@orca/store");
  const { reduceRun } = (await import(
    pathToFileURL(join(root, "packages/core/dist/index.js")).href
  )) as typeof import("@orca/core");
  const stores = fileStores(join(daemon.dir, ".orca"));
  const publicEvents = await stores.events.read(runId);
  const events = await executionEvents(publicEvents, stores.execution);
  const state = reduceRun(events);
  const entries = events.flatMap((event) =>
    event.type === "revision.recorded" && event.payload.entry
      ? [(event.payload.entry as { entry: RevisionJournalEntry }).entry]
      : [],
  );
  const commits = entries.flatMap((entry) => (entry.kind === "commit" ? [entry.change] : []));
  const decisions = commits.filter((commit) => commit.decision);
  const transitions = entries.flatMap((entry) => (entry.kind === "transition" ? [entry.record] : []));
  let logged: string;
  try {
    logged = await readFile(join(daemon.dir, "prompts.jsonl"), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      // The raw filesystem cause contains the private fixture path; never attach it.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Synthetic prompt evidence is unreadable");
    }
    logged = "";
  }
  const prompts = logged
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { text?: string })
    .flatMap((row) => (typeof row.text === "string" && row.text.includes(`Run marker: ${marker}`) ? [row.text] : []));
  const prompt = prompts[0] ?? "";
  const allCorrections = [REVISION_FIXTURE.initial, REVISION_FIXTURE.competing, REVISION_FIXTURE.final];
  const values = JSON.stringify({
    vars: state.run.vars,
    outputs: Object.values(state.steps).map((step) => step.result),
  });
  const result = {
    runId,
    promptCount: prompts.length,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    revisionCommitCount: commits.length,
    atomicDecisionCount: decisions.length,
    standaloneDecisionCount: events.filter((event) => event.type === "human.answered").length,
    protectedMarkers: publicEvents
      .filter((event) => event.type === "revision.recorded")
      .every((event) => Boolean(event.executionPayloadRef) && !event.payload.entry),
    publicHistoryExcludesCorrections: allCorrections.every((text) => !JSON.stringify(publicEvents).includes(text)),
    workflowValuesExcludeCorrectionsAndRationale: [...allCorrections, REVISION_FIXTURE.rationale].every(
      (text) => !values.includes(text),
    ),
    promptExcludesRationale: !prompt.includes(REVISION_FIXTURE.rationale),
    rationaleRetainedWithDecision: events.some(
      (event) => event.type === "human.answered" && event.payload.note === REVISION_FIXTURE.rationale,
    ),
    agentStepCount: Object.values(state.steps).filter((step) => step.nodeType === "agent").length,
    agentDestinationMatches: Object.values(state.steps)
      .filter((step) => step.nodeType === "agent")
      .every((step) => step.nodeId === REVISION_FIXTURE.destination),
    promptHasNoRevision: !prompt.includes("Human revision (") && !prompt.includes("Revision identity:"),
    completed: state.run.status === "completed" && state.run.outcome === "success",
  };
  if (!expected) return result;
  const commit = commits.find((change) => change.record.receipt.revisionId === expected.receipt.revisionId);
  const record = commit?.record;
  const receipt = expected.receipt;
  const first = decisions[0];
  return {
    ...result,
    revisionId: receipt.revisionId,
    attemptId: receipt.attemptId,
    correctionSha256: createHash("sha256").update(expected.text).digest("hex"),
    atomicDecisionMatches:
      first?.decision?.requestId === receipt.target.requestId &&
      first.decision.stepRunId === receipt.target.stepRunId &&
      first.decision.answer === "changes" &&
      first.decision.actor.principalId === expected.principalId &&
      first.record.receipt.target.destinationId === receipt.target.destinationId,
    committedPayloadMatches: record?.payload.kind === "text" && record.payload.text === expected.text,
    exactReceiptMatches: isDeepStrictEqual(record?.receipt, receipt),
    exactProvenanceMatches:
      record?.provenance.actor.principalId === expected.principalId &&
      record.provenance.workspaceId === expected.workspaceId &&
      record.provenance.operationId === expected.operationId &&
      record.provenance.source === "human-revision",
    receiverHasExactProvenance:
      prompt.includes(`Revision identity: ${receipt.revisionId}\n`) &&
      prompt.includes(`Revision author: ${expected.principalId}\n`) &&
      prompt.includes(`Revision workspace: ${expected.workspaceId}\n`) &&
      prompt.includes(`Revision operation: ${expected.operationId}\n`) &&
      prompt.includes("Revision source: human-revision"),
    receiverHasExactCorrectionOnce: prompt.split(expected.text).length - 1 === 1,
    receiverExcludesSupersededCorrections: [REVISION_FIXTURE.initial, REVISION_FIXTURE.competing]
      .filter((text) => text !== expected.text)
      .every((text) => !prompt.includes(text)),
    exactAttemptExecuted: state.steps[receipt.attemptId]?.nodeId === REVISION_FIXTURE.destination,
    confirmedDeliveryCount: transitions.filter(
      (entry) => entry.receipt.revisionId === receipt.revisionId && entry.delivery === "confirmed",
    ).length,
    protectedPromptMatchesReceiver: transitions.some(
      (entry) => entry.receipt.revisionId === receipt.revisionId && entry.prompt === prompt,
    ),
  };
}
