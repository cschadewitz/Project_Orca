/** Fresh-process production bootstrap driver. No credentials, network providers, live agents or consent restores. */
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { consoleLogger, OrcaError, type DirectAdmissionAuthority } from "@orca/core";
import { LiveHumanInput, type LiveDecisionTarget } from "../../src/live-input.js";
import { bootstrap } from "../../../cli/src/bootstrap.js";
import { bindLocalAdmissionExecution } from "../../../cli/src/admission-execution-authority.js";
import {
  assertOwned,
  canaries,
  containsCanary,
  type Command,
  type Receipt,
  type Report,
  type VerificationRecord,
  providerTrace,
} from "./fixture.js";

async function run(command: Command): Promise<Report> {
  const report: Report = {
    pid: process.pid,
    bootId: randomUUID(),
    nodeVersion: process.version,
    runtimeSha256: createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex"),
    outcome: "ok",
    provisioned: 0,
    providerCalls: 0,
    permissionDelivered: 0,
    consentWrites: 0,
    publicLeak: false,
    logLeak: false,
    errorLeak: false,
  };
  let initialTrace = 0;
  try {
    await assertOwned(command);
    initialTrace = (await providerTrace(command)).length;
    const trusted = JSON.parse(
      await readFile(join(command.root, "restoration-verification.json"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "[]";
          throw error;
        },
      ),
    ) as VerificationRecord[];
    let restorationStarted = false;
    const verifyPluginRestorationIdentity = async (candidate: {
      spec: string;
      identity: unknown;
      entry: { url: string; digest: string };
    }) => {
      if (command.verification === "throws") throw new Error(canaries[0]);
      if (command.verification === "refused" || (command.verification === "restore-refused" && restorationStarted))
        return false;
      const record = trusted.find((row) => row.spec === candidate.spec);
      if (!record || !isDeepStrictEqual(record.identity, candidate.identity)) return false;
      const path = join(command.root, record.spec);
      return (
        candidate.entry.url === pathToFileURL(path).href &&
        candidate.entry.digest === record.entryDigest &&
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") === record.entryDigest
      );
    };
    const app = await bootstrap({
      configPath: join(command.root, "orca.config.json"),
      ...(trusted.length && command.verification !== "absent" ? { verifyPluginRestorationIdentity } : {}),
      logger: consoleLogger("debug", {}, (line) => {
        report.logLeak ||= containsCanary(line);
      }),
    });
    restorationStarted = true;
    report.descriptorPresent = Reflect.has(app.generations.current.snapshot, "pluginRestoration");
    const orc = app.orchestrator;
    // Instrument existing accepted ports; no fixture-specific restoration API is invented.
    const workspace = orc.generationWorkspaceProvider!.bind(orc);
    orc.generationWorkspaceProvider = (generation) => {
      const provider = workspace(generation);
      return {
        ...provider,
        name: provider.name,
        provision: async (input) => {
          report.provisioned++;
          return provider.provision(input);
        },
      };
    };
    orc.sessionFactory = async (options) => {
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      // Scripted in-process session only: never spawn the configured command or call a network provider.
      return {
        id: "fixture-session",
        acpSessionId: "fixture-acp-session",
        agentId: options.agent.id,
        hostId: options.host.id,
        cwd: options.cwd,
        configOptions: [],
        closed,
        prompt: async () => {
          report.providerCalls++;
          return { stopReason: "end_turn", durationMs: 1 };
        },
        onUpdate: () => () => {},
        setConfigOption: async () => [],
        cancel: async () => {},
        close: async () => {
          close();
        },
      };
    };
    report.activeModel = app.generations.current.agents.resolve("worker").agent.defaultModel!;
    report.activeWorkspace =
      app.generations.current.snapshot.config.workspace.provider === "local"
        ? (app.generations.current.snapshot.config.workspace.root ?? ".")
        : "other";
    const path = join(command.root, "receipt.json");
    const readReceipt = async () => JSON.parse(await readFile(path, "utf8")) as Receipt;
    const saveReceipt = async (receipt: Receipt) => writeFile(path, JSON.stringify(receipt), { mode: 0o600 });

    if (command.action === "permission-open" || command.action === "permission-answer") {
      const live = new LiveHumanInput(report.bootId);
      const targetPath = join(command.root, "permission-target.json");
      if (command.action === "permission-open") {
        const target: LiveDecisionTarget = {
          instanceId: report.bootId,
          sessionId: "synthetic-session",
          turnId: "synthetic-turn",
          invocationId: "synthetic-invocation",
          runId: "synthetic-run",
          stepRunId: "synthetic-step",
          requestId: "synthetic-ask",
        };
        const callback = live.ask({
          ...target,
          kind: "permission",
          question: "Synthetic permission?",
          options: [{ id: "allow", label: "Allow" }],
          context: {},
          live: {
            identity: target,
            signal: new AbortController().signal,
            withOwnership: async (fn) => fn(),
            emitOwned: async () => {
              report.permissionDelivered++;
            },
          },
        });
        if (live.inspect(target) !== "pending") throw new Error("Permission callback was not registered");
        await writeFile(targetPath, JSON.stringify(target), { mode: 0o600 });
        live.close();
        if ((await callback) !== undefined) report.permissionDelivered++;
      } else {
        const target = JSON.parse(await readFile(targetPath, "utf8")) as LiveDecisionTarget;
        // No durable consent writer or original callback is supplied to this new owner.
        await live.answer(
          { target, optionId: "allow" },
          { actor: { principalId: "fixture-owner" }, authorize: async () => {} },
        );
      }
    } else if (command.action === "park" || command.action === "new" || command.action === "run-new") {
      const launch = await app.generations.captureLaunch({ purpose: "workflow", workflowId: "restoration-396" });
      const runId = await launch.startRun({ vars: { secret: canaries[1] } });
      if (command.action !== "new") await orc.run(runId);
      const pending = await orc.pendingInputs(runId);
      const receipt: Receipt = {
        runId,
        generationId: launch.generationId,
        ...(pending[0] ? { inputId: pending[0].id } : {}),
      };
      report.receipt = receipt;
      await saveReceipt(receipt);
    } else if (command.action === "admit" || command.action === "admit-lost-response") {
      const authority = authorityFor(command, app.orchestrator.stores.execution);
      bindLocalAdmissionExecution(orc, "direct", authority);
      const result = await app.directAdmissions!.admitRun(
        { workflowId: "restoration-396", vars: { secret: canaries[1] } },
        { idempotencyKey: "fixture-intent-396" },
        authority,
      );
      if (result.state !== "resolved" || result.result.state !== "accepted")
        throw new Error("Synthetic admission failed");
      const runId = result.result.runId;
      const state = await orc.getState(runId);
      const receipt = {
        runId,
        generationId: state.run.provenance!.configGeneration,
        admissionId: result.result.admissionId,
      };
      await saveReceipt(receipt);
      if (command.action === "admit-lost-response") report.outcome = "response-lost";
      else report.receipt = receipt;
    } else {
      const receipt = await readReceipt();
      report.receipt = receipt;
      if (command.action === "restore-current") {
        const current = app.generations.current;
        try {
          await app.generations.restore(receipt.generationId);
          throw new Error("Expected reconstruction refusal");
        } catch (error) {
          if (!(error instanceof OrcaError)) throw error;
          {
            const reason = restorationReason(error);
            if (reason) report.restorationReason = reason;
          }
          report.errorLeak ||= containsCanary([error.message, error.details]);
        }
        report.currentGenerationUnchanged = app.generations.current === current;
        const launch = await app.generations.captureLaunch({ purpose: "workflow", workflowId: "restoration-396" });
        const runId = await launch.startRun({ vars: { secret: canaries[1] } });
        await orc.run(runId);
        report.receipt = { runId, generationId: launch.generationId };
      } else if (command.action === "restore" || command.action === "historical-admit") {
        const material = await app.generations.restore(receipt.generationId);
        report.recordedModel = material.agents.resolve("worker").agent.defaultModel!;
        report.recordedWorkspace =
          material.snapshot.config.workspace.provider === "local"
            ? (material.snapshot.config.workspace.root ?? ".")
            : "other";
        report.workflowName = material.workflows.get("restoration-396").name;
        report.workflowVersion = material.workflows.get("restoration-396").version;
        if (command.action === "historical-admit") {
          await orc.startRun({ workflowId: "restoration-396" }, material);
        }
      } else if (command.action === "resume") {
        // A restart itself grants no gate answer. Only this explicit fixture command answers one.
        if (receipt.inputId) await orc.answer(receipt.inputId, "go", receipt.runId);
        await orc.resume(receipt.runId);
      } else if (command.action === "execute-admitted") {
        if (command.authority !== "missing")
          bindLocalAdmissionExecution(orc, "direct", authorityFor(command, orc.stores.execution));
        await orc.run(receipt.runId);
      } else if (command.action === "hold-lease") {
        await orc.stores.leases.acquire({
          resource: `run:${receipt.runId}`,
          holder: "fixture-live-lease",
          ttlMs: 60_000,
        });
        // The harness keeps this owning process alive until its explicit release message.
        await new Promise<void>((resolve) => {
          process.once("message", () => resolve());
          process.send!({ held: true });
        });
      }
    }
    report.runs = (await orc.listRuns()).length;
    if (report.receipt) {
      const state = await orc.getState(report.receipt.runId);
      report.status = state.run.status;
      report.pending = (await orc.pendingInputs(report.receipt.runId)).length;
      const events = await orc.stores.events.read(report.receipt.runId);
      report.events = events.length;
      report.publicLeak = containsCanary([state, events]);
    }
  } catch (error) {
    report.outcome = "refused";
    // Assert raw error secrecy internally; never transport raw plugin/parser/credential diagnostics.
    report.errorLeak = containsCanary(
      error instanceof Error ? [error.message, error instanceof OrcaError ? error.details : {}] : error,
    );
    report.code = error instanceof OrcaError ? error.code : "FIXTURE_FAILURE";
    if (error instanceof Error && error.message.startsWith("JEV restoration options-unsupported:"))
      report.adapterReason = "options-unsupported";
    if (error instanceof OrcaError) {
      const reason = restorationReason(error);
      if (reason) report.restorationReason = reason;
    }
  }
  report.factoryCalls = Number(Reflect.get(globalThis, "fixture396Factories") ?? 0);
  const trace = await providerTrace(command);
  report.providerCalls += trace.length - initialTrace;
  report.executionModels = trace.slice(initialTrace).map((row) => row.model);
  return report;
}

function restorationReason(error: OrcaError): string | undefined {
  const reason = error.details?.pluginRestorationReason;
  return typeof reason === "string" &&
    [
      "invalid_descriptor",
      "incompatible_identity",
      "identity_unverified",
      "unavailable_plugin",
      "unsupported_registration",
      "reconstruction_failed",
      "legacy_generation",
    ].includes(reason)
    ? reason
    : undefined;
}
function authorityFor(command: Command, store: import("@orca/store").ExecutionStore): DirectAdmissionAuthority {
  const actor = { principalId: command.authority === "principal-mismatch" ? "another-owner" : "fixture-owner" };
  return {
    workspaceId: command.authority === "workspace-mismatch" ? "another-workspace" : command.owner,
    actor,
    authorize: async () => {
      if (command.authority === "revoked") throw new OrcaError("RUN_STATE", "Synthetic authority revoked");
    },
    onRunAdmitted: async (runId) => {
      await store.putGeneration(`fixture-owner:${runId}`, { principalId: actor.principalId });
    },
    verifyRunAdmitted: async (runId) => {
      const owner = (await store.getGeneration(`fixture-owner:${runId}`)) as { principalId?: unknown } | undefined;
      if (owner?.principalId !== actor.principalId) throw new OrcaError("RUN_STATE", "Synthetic owner mismatch");
    },
  };
}

process.once("message", (command: Command) => {
  void run(command).then(
    (report) => {
      process.send!(report, () => process.disconnect!());
    },
    () => {
      process.exitCode = 1;
      process.disconnect!();
    },
  );
});
