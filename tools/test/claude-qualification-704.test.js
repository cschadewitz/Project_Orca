/**
 * #704 combined offline Claude qualification harness. Provenance stays candidate-only; the protocol
 * drives the actual inactive ORCA strict policy, disposable-memory owner and one-use fence behind an
 * explicitly synthetic native model. No provider, hook, settings, shell, network or installed claim.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateStrictPermission, selectStrictPermissionOption, strictDecisionBinding } from "@orca/core";
import { lapsed } from "@orca/store";
import { createStrictPolicyPort } from "../../packages/agents/src/strict-permission.ts";
import { actionFixture, NOW, stateFixture } from "../../packages/agents/test/strict-permission-fixtures.ts";
import { DisposableMemoryReadOwner } from "../../packages/engine/src/disposable-memory-read.ts";
import { SyntheticReadFence } from "../../packages/engine/src/synthetic-read-fence.ts";
import { syntheticReadFixture } from "../../packages/engine/test/fixtures/synthetic-read-fence.ts";

// Command strings are data. Any child-process entry point reached from this module graph throws.
const forbidden = vi.hoisted(() => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const guarded = Object.fromEntries(
    Object.entries(actual)
      .filter(([name]) => name !== "default")
      .map(([name, value]) => [
        name,
        typeof value === "function"
          ? () => {
              forbidden.push(`child_process.${name}`);
              throw new Error("child_process is forbidden in the #704 offline harness");
            }
          : value,
      ]),
  );
  return { ...guarded, default: guarded };
});

const root = new URL("../../", import.meta.url);
const packet = new URL("docs/preparation/provider-enforcement-704-705/", root);
const fixtures = new URL("tools/test/fixtures/provider-enforcement-704-705/claude-qualification/", root);
const json = async (url) => JSON.parse(await readFile(url, "utf8"));

const LEVELS = ["source-reviewed", "source-function-tested", "synthetic-protocol-tested", "installed-observed"];
const FAILURE_MODES = ["unavailable", "crash", "timeout", "malformed", "empty"];
const HOOK_FAILURES = new Set([...FAILURE_MODES, "late"]);
/** Fixed here, not read from the manifest, so a deleted fact is reported missing rather than skipped. */
const REQUIRED_INSTALLED_FACTS = [
  "executablePath",
  "launcher",
  "platform",
  "packageIntegrity",
  "cliSdkArtifactCorrespondence",
  "effectiveSettingsProvenance",
  "protectedOwnership",
  "hookPrecedence",
  "hookMatchers",
  "finalInputBinding",
  "finalCwdBinding",
  "failureSemantics",
  "pendingCancellationOwnership",
  "hookDecisionFrame",
  "cachedRepeatHookDispatch",
];
const CELL = "orca-fixture-mark";

// Loaded at collection time so scenario rows can parameterize tests.
const pins = await json(new URL("source-pins.json", packet));
const publication = await json(new URL("claude-publication-metadata.json", packet));
const vectors = await json(new URL("vectors.json", packet));
const provenance = await json(new URL("provenance.json", fixtures));
const format = await json(new URL("evidence-format.json", fixtures));
const scenarios = await json(new URL("scenarios.json", fixtures));
const installed = await json(new URL("installed-observations.json", fixtures));
let fetchCalls = 0;

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    fetchCalls++;
    throw new Error("network is forbidden in the #704 offline harness");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// Provenance: candidate identities are research pins; installed facts need installed receipts.

/** An installed fact counts only as installed-observed with an opaque receipt ref; never by default. */
function installedFact(manifest, name) {
  const fact = manifest?.installed?.[name];
  if (!fact || typeof fact !== "object") return { state: "unknown", reason: "missing-fact" };
  if (fact.state === "unsupported") return { state: "unsupported", reason: fact.reason ?? "unsupported" };
  if (fact.state !== "complete") return { state: "unknown", reason: fact.reason ?? "not-complete" };
  if (
    fact.evidenceLevel !== "installed-observed" ||
    typeof fact.installedRef !== "string" ||
    !new RegExp(format.token).test(fact.installedRef)
  )
    return { state: "unknown", reason: "not-installed-observed" };
  if (name === "failureSemantics" && !FAILURE_MODES.every((mode) => fact.modes?.[mode] === "block"))
    return { state: "unsupported", reason: "failure-continues-or-unobserved" };
  return { state: "complete", value: fact.installedRef };
}

function classifyProvenance(manifest) {
  const facts = Object.fromEntries(REQUIRED_INSTALLED_FACTS.map((name) => [name, installedFact(manifest, name)]));
  return { facts, complete: Object.values(facts).every((fact) => fact.state === "complete") };
}

const allComplete = (...facts) =>
  facts.every((fact) => fact.state === "complete")
    ? { state: "complete", value: facts.map((fact) => fact.value).join("+") }
    : { state: "unknown", reason: facts.find((fact) => fact.state !== "complete").reason };

/** Maps the manifest onto canonical #700 vocabulary. No new admission field or support flag. */
function canonicalFromProvenance(manifest, options = {}) {
  const { facts, complete } = classifyProvenance(manifest);
  const base = actionFixture();
  const installedRefs = Object.values(facts)
    .filter((fact) => fact.state === "complete")
    .map((fact) => fact.value);
  const action = {
    ...base,
    coverage: {
      ...base.coverage,
      coverageId: "claude-candidate:unqualified",
      provider: "claude",
      providerVersion: manifest.candidate.native.version,
      adapterVersion: manifest.candidate.adapter.version,
      tool: "orca_fixture_mark",
      platform: facts.platform.state === "complete" ? facts.platform.value : "unknown",
      level: complete ? "verified-per-execution" : "observation",
      evidence: {
        sourceRefs: manifest.candidate.sourceExcerpts.map((id) => `source-pin:${id}`),
        installedRefs,
        // Only independently observed installed effects can set this; the offline harness has none.
        independentlyObservedEffects: options.independentlyObservedEffects ?? false,
      },
      negotiatedHook: allComplete(facts.hookPrecedence, facts.hookMatchers, facts.hookDecisionFrame),
      protectedConfiguration: allComplete(facts.protectedOwnership, facts.effectiveSettingsProvenance),
      guaranteedEffects: [],
      unsupportedPaths: ["subagents", "mcp-alternate-routes", "interactive-stdin", "descendants", "client-filesystem"],
    },
    effectiveCwd: facts.finalCwdBinding.state === "complete" ? base.effectiveCwd : facts.finalCwdBinding,
  };
  const state = {
    ...stateFixture(action),
    // The trusted owner's precondition: failure, cancellation, pending and final-input ownership.
    coverageAndState:
      options.coverageAndState ??
      (["failureSemantics", "pendingCancellationOwnership", "finalInputBinding", "cachedRepeatHookDispatch"].every(
        (name) => facts[name].state === "complete",
      )
        ? { state: "complete", value: true }
        : { state: "unknown", reason: "installed failure/cancellation/final-input ownership unobserved" }),
  };
  return { action, state };
}

/** A hypothetical manifest used only to show the gates are reachable; never written to fixtures. */
function hypotheticalInstalledManifest() {
  const manifest = structuredClone(provenance);
  for (const name of REQUIRED_INSTALLED_FACTS)
    manifest.installed[name] = {
      state: "complete",
      evidenceLevel: "installed-observed",
      installedRef: `hypothetical:${name.toLowerCase()}`,
      ...(name === "failureSemantics" ? { modes: Object.fromEntries(FAILURE_MODES.map((m) => [m, "block"])) } : {}),
    };
  return manifest;
}

// ---------------------------------------------------------------------------------------------
// Sanitized receipts and their assessment. Receipts carry opaque labels, never inputs or digests.

function validReceipt(row) {
  const token = new RegExp(format.token);
  const allowed = new Set([...format.keys.required, ...format.keys.optional]);
  return (
    format.keys.required.every((key) => Object.hasOwn(row, key)) &&
    Object.keys(row).every((key) => allowed.has(key)) &&
    Number.isSafeInteger(row.seq) &&
    LEVELS.includes(row.level) &&
    Object.hasOwn(format.stages, row.stage) &&
    (row.outcome === undefined || format.stages[row.stage].includes(row.outcome)) &&
    Object.entries(row).every(([key, value]) => key === "seq" || (typeof value === "string" && token.test(value))) &&
    Buffer.byteLength(JSON.stringify(row)) <= format.limits.rowBytes
  );
}

/** Never returns GO. REVIEW-CANDIDATE needs installed receipts plus complete installed provenance. */
function assess(receipts, provenanceComplete) {
  const violations = new Set();
  const calls = new Map();
  for (const row of receipts) if (row.callRef) calls.set(row.callRef, [...(calls.get(row.callRef) ?? []), row]);
  const prior = (row) => (calls.get(row.callRef) ?? []).filter((other) => other.seq < row.seq);
  const effectsByInvocation = new Map();
  let epoch = 0;
  for (const row of receipts) {
    if (row.stage === "revocation") epoch++;
    if (row.stage === "config-mutation") violations.add("configuration-mutated");
    if (row.stage === "hook-invoked" && row.outcome === "not-invoked") {
      violations.add("dispatch-not-checked");
      if (prior(row).some((r) => r.stage === "native-dispatch" && r.outcome === "cached"))
        violations.add("cached-repeat-not-checked");
    }
    if (
      row.stage === "native-continued" &&
      row.outcome === "continued" &&
      prior(row).some((r) => r.stage === "hook-response" && HOOK_FAILURES.has(r.outcome))
    )
      violations.add("native-continued-after-hook-failure");
    if (row.stage === "effect-observed") {
      const before = prior(row);
      const hooked = before.some((r) => r.stage === "hook-invoked" && r.outcome === "invoked");
      const decision = before.find((r) => r.stage === "orca-decision" && r.outcome === "allow");
      if (!hooked || !decision) violations.add("effect-without-orca-allow");
      else {
        if (decision.generation !== `gen-${epoch}`) violations.add("effect-after-revocation");
        const start = before.findLast((r) => r.stage === "tool-start" && r.outcome === "started");
        if (!start || start.bindingRef !== decision.bindingRef) violations.add("effect-binding-mismatch");
      }
      const count = (effectsByInvocation.get(row.invocationRef) ?? 0) + 1;
      effectsByInvocation.set(row.invocationRef, count);
      if (count > 1) violations.add("duplicate-invocation-effect");
    }
  }
  const checked = (call) =>
    call.some((r) => r.stage === "hook-invoked" && r.outcome === "invoked") &&
    call.some((r) => r.stage === "orca-decision");
  const cachedRepeatChecked = [...calls.values()].some(
    (call) => call.some((r) => r.stage === "native-dispatch" && r.outcome === "cached") && checked(call),
  );
  const revocation = receipts.find((r) => r.stage === "revocation");
  const revocationBlocked =
    !!revocation &&
    [...calls.values()].some(
      (call) =>
        call.some((r) => r.stage === "native-dispatch" && r.seq > revocation.seq) &&
        call.some((r) => r.stage === "orca-decision" && r.outcome !== "allow") &&
        !call.some((r) => r.stage === "effect-observed"),
    );
  const allInstalled = receipts.length > 0 && receipts.every((r) => r.level === "installed-observed");
  const decision =
    violations.size > 0
      ? allInstalled
        ? "NO-GO-CANDIDATE"
        : "SYNTHETIC-VIOLATION-DETECTED"
      : allInstalled && provenanceComplete && cachedRepeatChecked && revocationBlocked
        ? "REVIEW-CANDIDATE"
        : "UNKNOWN";
  return { violations: [...violations].sort(), cachedRepeatChecked, revocationBlocked, decision };
}

// ---------------------------------------------------------------------------------------------
// Protocol harness. Synthetic native model (labelled) -> ORCA checker over actual inactive parts.

/** Closed, documented-shape PreToolUse frame (field names documented, not installed-verified). */
function validateFrame(frame, file) {
  const keys = ["hook_event_name", "session_id", "tool_use_id", "tool_name", "tool_input", "cwd"];
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return "invalid-frame";
  if (Object.keys(frame).length !== keys.length || !keys.every((key) => Object.hasOwn(frame, key)))
    return "invalid-frame";
  if (Buffer.byteLength(JSON.stringify(frame)) > format.limits.hookFrameBytes) return "oversize-frame";
  if (frame.hook_event_name !== "PreToolUse" || typeof frame.tool_use_id !== "string" || !frame.tool_use_id)
    return "invalid-frame";
  if (typeof frame.cwd !== "string" || typeof frame.tool_input !== "object" || frame.tool_input === null)
    return "invalid-frame";
  const approved = file.approved.inputs.some((key) =>
    isDeepStrictEqual({ tool: frame.tool_name, input: frame.tool_input }, file.inputs[key]),
  );
  return approved ? undefined : "unapproved-input";
}

const SOURCE = {
  "native-dispatch": "synthetic:native-model",
  "hook-invoked": "synthetic:native-model",
  "hook-response": "synthetic:hook-transport",
  "orca-decision": "orca:strict-policy-port",
  "native-ask": "synthetic:native-permission-cache",
  "native-continued": "synthetic:native-model",
  "permit-claim": "orca:synthetic-read-fence",
  "tool-start": "synthetic:native-model",
  "effect-observed": "orca:disposable-memory-counter",
  revocation: "synthetic:orca-rule-store",
  cancellation: "synthetic:native-model",
  "config-mutation": "synthetic:native-model",
};

async function createHarness(file, scenario) {
  const base = await syntheticReadFixture();
  const receipts = [];
  const emit = (stage, fields) => {
    const row = { seq: receipts.length + 1, stage, level: "synthetic-protocol-tested", sourceRef: SOURCE[stage] };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) row[key] = value;
    receipts.push(row);
  };
  const native = scenario.native;
  const rules = { status: "approved", epoch: 0 };
  const generation = () => `gen-${rules.epoch}`;
  const bindings = new Map(); // Harness-internal comparison only; labels leave, keys never do.
  const bindingRef = (tool, input, cwd) => {
    const key = JSON.stringify([tool, input, cwd]);
    if (!bindings.has(key)) bindings.set(key, `binding-${bindings.size + 1}`);
    return bindings.get(key);
  };
  const nativeRefs = new Map();
  const nativeRef = (toolUseId) => {
    if (!nativeRefs.has(toolUseId)) nativeRefs.set(toolUseId, `inv-${nativeRefs.size + 1}`);
    return nativeRefs.get(toolUseId);
  };
  const remembered = new Set(); // SYNTHETIC native remembered permission; not observed caching.
  const invocations = new Map(); // toolUseId -> ORCA owner/fence/permit for that original invocation
  const calls = new Map();
  const owners = [];
  let hookInstalled = true;
  let shellEffects = 0;

  const project = (resource, snapshot) => ({
    authority: { ...snapshot.authority, revocationEpoch: String(rules.epoch) },
    currentAuthority: { state: "complete", value: true },
    capturedCeiling: { state: "complete", value: true },
    protectedAccess: { state: "complete", value: true },
    coverageAndState: { state: "complete", value: true },
    mandatoryHuman: { state: "complete", value: false },
    profile: {
      state: "complete",
      value: {
        profileRef: "orca-disposable-memory-read-v1",
        minimumCoverage: "policy-per-ask",
        facts: {
          rawDuplicateKeyValidation: "complete-or-absent",
          effectiveCwd: "complete",
          workspaceRef: "complete",
          resources: "complete",
          executableAndInterpreter: "complete-or-absent",
          stdin: "complete-or-absent",
          environmentAndCredentialRefs: "complete",
          relevantStateRefs: "complete",
        },
      },
    },
    rules: {
      state: "complete",
      value: [
        {
          ruleId: "claude-704:fixture-rule",
          ruleRevision: "1",
          status: rules.status,
          notBefore: new Date(base.clock.now() - 1000).toISOString(),
          expiresAt: new Date(base.clock.now() + 60_000).toISOString(),
          decision: "allow",
          match: {
            principalRef: snapshot.invocation.principalRef,
            agentId: snapshot.invocation.agentId,
            hostId: snapshot.invocation.hostId,
            runnerId: snapshot.invocation.runnerId,
            operation: "memory.readText",
            profileRef: "orca-disposable-memory-read-v1",
            coverageId: snapshot.coverage.coverageId,
            effectiveCwd: file.cwds[file.approved.cwd],
            workspaceRef: snapshot.workspaceRef,
            resources: [resource],
            environmentAndCredentialRefs: [],
          },
        },
      ],
    },
  });

  function revoke() {
    rules.status = "revoked";
    rules.epoch++;
    emit("revocation", { outcome: "revoked", generation: generation() });
    // Every live owner receives the new current state; captured actions become stale.
    for (const entry of owners) {
      const snapshot = entry.owner.snapshot();
      entry.owner.replace({ policy: project(entry.resource, snapshot) });
    }
  }

  function openInvocation(toolUseId, cwd, callRef) {
    const holder = { callRef, abortOnRead: false };
    const snapshot = {
      ...base.state.snapshot,
      invocation: { ...base.state.snapshot.invocation, invocationId: `claude-704:${nativeRef(toolUseId)}` },
      authority: { ...base.state.snapshot.authority, revocationEpoch: String(rules.epoch) },
      cwd,
      expiresAt: new Date(base.clock.now() + 60_000).toISOString(),
    };
    const entry = { holder, controller: new AbortController() };
    entry.owner = new DisposableMemoryReadOwner({
      clock: base.clock,
      snapshot,
      withOwnership: base.owner.withOwnership,
      assertLease: () => {
        if (lapsed(base.lease, base.clock.now())) throw new Error("fixture lease lapsed");
      },
      memory: { resourceRef: CELL, content: "ok" },
      policy: (resource, current) => {
        entry.resource = resource;
        return project(resource, current);
      },
      onDispatch: async () => {
        emit("permit-claim", { callRef: holder.callRef, invocationRef: nativeRef(toolUseId), outcome: "claimed" });
      },
      onRead: async () => {
        emit("effect-observed", { callRef: holder.callRef, invocationRef: nativeRef(toolUseId), outcome: "observed" });
      },
      respond: async () => {},
    });
    entry.policy = createStrictPolicyPort({
      source: {
        readCurrent: async (action, signal) => {
          // Deterministic pending-cancellation point: native deadline, checker death or cancel.
          if (holder.abortOnRead) entry.controller.abort();
          return entry.owner.source.readCurrent(action, signal);
        },
      },
      now: () => base.clock.now(),
      authorizeProjection: () => Promise.reject(new Error("no judge in the #704 harness")),
      recordReview: () => Promise.reject(new Error("no judge in the #704 harness")),
    });
    entry.fence = new SyntheticReadFence(entry.owner, entry.owner.executor, entry.policy, base.evidence);
    entry.action = entry.fence.capture({ resourceRef: CELL });
    owners.push(entry);
    invocations.set(toolUseId, entry);
    return entry;
  }

  /** ORCA's hook handler. Its only authority is the actual policy/fence; frames are validated data. */
  async function checker(frame, call) {
    const transport = call.step.transport;
    if (transport === "unavailable") return "unavailable";
    const decide = (outcome, reason) =>
      emit("orca-decision", {
        callRef: call.ref,
        invocationRef: nativeRef(frame.tool_use_id),
        outcome,
        reason,
        generation: generation(),
        bindingRef: call.checkedRef,
      });
    const invalid = validateFrame(frame, file);
    if (invalid) {
      decide("refused", invalid);
      return "deny";
    }
    const existing = invocations.get(frame.tool_use_id);
    if (existing) {
      // A replayed native invocation: the actual fence refuses a second capture for it.
      expect(() =>
        new SyntheticReadFence(existing.owner, existing.owner.executor, existing.policy, base.evidence).capture({
          resourceRef: CELL,
        }),
      ).toThrow();
      decide("refused", "invocation-already-registered");
      return "deny";
    }
    const entry = openInvocation(frame.tool_use_id, frame.cwd, call.ref);
    const dies = ["crash", "malformed", "empty"].includes(transport);
    entry.holder.abortOnRead =
      dies || transport === "timeout" || transport === "late" || call.step.cancel === "pending";
    let evaluation;
    try {
      evaluation = await entry.fence.evaluate(entry.action, entry.controller.signal);
    } catch {
      // The checker that died emits nothing; an owner that saw the cancellation records it.
      if (!dies) decide("refused", "pending-cancelled");
      return transport ?? "cancelled";
    }
    if (evaluation.phase !== "final") {
      decide("refused", "unexpected-review");
      return "deny";
    }
    const verdict = evaluation.verdict;
    decide(verdict.outcome, verdict.outcome === "allow" ? "rule" : verdict.reason);
    if (verdict.outcome !== "allow") return "deny";
    entry.permit = await entry.fence.authorize(entry.action, verdict, entry.controller.signal);
    entry.checked = { tool: call.spec.tool, input: call.spec.input, cwd: frame.cwd };
    return "allow";
  }

  async function nativeCall(step, replayOf) {
    const origin = replayOf ? calls.get(replayOf) : undefined;
    const ref = replayOf ? step.as : step.call;
    const source = origin?.step ?? step;
    const spec = file.inputs[source.input];
    const cwd = file.cwds[source.cwd];
    const call = {
      ref,
      step: source,
      spec,
      toolUseId: source.toolUseId,
      checkedRef: bindingRef(spec.tool, spec.input, cwd),
      final: {
        tool: spec.tool,
        input: file.inputs[source.finalInput ?? source.input].input,
        cwd: file.cwds[source.finalCwd ?? source.cwd],
      },
    };
    calls.set(ref, call);
    const cached = remembered.has(call.checkedRef);
    const invocationRef = nativeRef(call.toolUseId);
    emit("native-dispatch", {
      callRef: ref,
      invocationRef,
      outcome: replayOf ? "replay" : cached ? "cached" : "new",
      bindingRef: call.checkedRef,
    });
    const hookRuns =
      hookInstalled && source.route !== "unmatched" && !(cached && native.cachedRepeatHook === "skipped");
    if (!hookRuns) emit("hook-invoked", { callRef: ref, invocationRef, outcome: "not-invoked" });
    else {
      emit("hook-invoked", { callRef: ref, invocationRef, outcome: "invoked" });
      const frame = {
        hook_event_name: "PreToolUse",
        session_id: "fixture-session",
        tool_use_id: call.toolUseId,
        tool_name: spec.tool,
        tool_input: structuredClone(spec.input),
        cwd,
      };
      const result = await checker(frame, call);
      if (result === "cancelled") {
        emit("cancellation", { callRef: ref, invocationRef, outcome: "cancelled" });
        emit("native-continued", { callRef: ref, invocationRef, outcome: "blocked" });
        return;
      }
      emit("hook-response", { callRef: ref, invocationRef, outcome: result });
      if (result === "deny") {
        emit("native-continued", { callRef: ref, invocationRef, outcome: "blocked" });
        return;
      }
      if (HOOK_FAILURES.has(result)) {
        const continues = native.failurePolicy === "continue";
        emit("native-continued", { callRef: ref, invocationRef, outcome: continues ? "continued" : "blocked" });
        if (!continues) return;
      }
    }
    if (!cached) {
      emit("native-ask", { callRef: ref, invocationRef, outcome: "asked" });
      remembered.add(call.checkedRef);
    }
    if (source.revoke === "after-decision") revoke();
    if (source.cancel === "before-dispatch") {
      invocations.get(call.toolUseId)?.controller.abort();
      emit("cancellation", { callRef: ref, invocationRef, outcome: "cancelled" });
    }
    if (source.phase !== "hook") await execute(ref);
  }

  async function execute(ref, permitOf) {
    const call = calls.get(ref);
    const invocationRef = nativeRef(call.toolUseId);
    const finalRef = bindingRef(call.final.tool, call.final.input, call.final.cwd);
    emit("tool-start", { callRef: ref, invocationRef, outcome: "started", bindingRef: finalRef });
    if (scenario.row === "shell") {
      // Synthetic native shell: a counter stands in for the effect; the command is never run.
      shellEffects++;
      emit("effect-observed", {
        callRef: ref,
        invocationRef,
        outcome: "observed",
        sourceRef: "synthetic:native-shell-counter",
      });
      return;
    }
    const refuse = (reason) => emit("permit-claim", { callRef: ref, invocationRef, outcome: "refused", reason });
    const entry = invocations.get(call.toolUseId);
    if (!entry?.permit || entry.holder.callRef !== ref) return refuse("no-permit");
    if (!isDeepStrictEqual(entry.checked, call.final)) return refuse("final-binding-mismatch");
    if (entry.dispatched) {
      const before = typedEffects();
      const again = await entry.fence.dispatch(entry.permit, entry.controller.signal);
      expect(again).toBe(entry.receipt);
      expect(typedEffects()).toBe(before);
      return refuse("permit-already-consumed");
    }
    const permit = permitOf ? invocations.get(calls.get(permitOf).toolUseId).permit : entry.permit;
    let receipt;
    try {
      receipt = await entry.fence.dispatch(permit, entry.controller.signal);
    } catch {
      return refuse(permitOf ? "foreign-permit" : "fence-rejected");
    }
    entry.dispatched = true;
    entry.receipt = receipt;
    if (receipt.state !== "completed") return refuse("fence-not-dispatched");
  }

  const typedEffects = () => owners.reduce((sum, entry) => sum + entry.owner.observedReads, 0);

  async function run() {
    for (const step of scenario.steps) {
      if (step.call) await nativeCall(step);
      else if (step.replay) await nativeCall(step, step.replay);
      else if (step.execute) await execute(step.execute, step.permitOf);
      else if (step.revoke === true) revoke();
      else if (step.mutateConfig === "remove-hook") {
        hookInstalled = false;
        emit("config-mutation", { outcome: "hook-removed" });
      } else throw new Error(`Unknown harness step ${JSON.stringify(step)}`);
    }
    return {
      receipts,
      independentEffects: scenario.row === "shell" ? shellEffects : typedEffects(),
      executorEntries: owners.reduce((sum, entry) => sum + entry.owner.executorEntries, 0),
    };
  }

  return {
    run,
    dispose() {
      for (const entry of owners) entry.owner.dispose();
      base.abort.abort();
      base.caller.abort();
    },
  };
}

async function runScenario(file, scenario) {
  const hypothesis = { protectedOwnership: "synthetic-assumed", ...scenario.hypothesis };
  // Mutable or unprotected configuration cannot host a positive protocol run at all.
  if (hypothesis.protectedOwnership !== "synthetic-assumed")
    return { preflight: "unsupported:protected-ownership", receipts: [], independentEffects: 0, executorEntries: 0 };
  const harness = await createHarness(file, scenario);
  try {
    return { preflight: "synthetic-assumed", ...(await harness.run()) };
  } finally {
    harness.dispose();
  }
}

function counts(receipts) {
  const count = (stage, outcome) => receipts.filter((r) => r.stage === stage && r.outcome === outcome).length;
  return {
    hookChecks: count("hook-invoked", "invoked"),
    nativeAsks: count("native-ask", "asked"),
    orcaAllows: count("orca-decision", "allow"),
    effects: count("effect-observed", "observed"),
  };
}

function callReason(receipts, ref) {
  return receipts.find(
    (r) =>
      r.callRef === ref &&
      ((r.stage === "orca-decision" && r.outcome !== "allow") ||
        (r.stage === "permit-claim" && r.outcome === "refused")),
  )?.reason;
}

function expectSanitized(receipts, file) {
  expect(receipts.every(validReceipt), JSON.stringify(receipts.find((r) => !validReceipt(r)))).toBe(true);
  const text = JSON.stringify(receipts);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(format.limits.transportBytes);
  expect(text).not.toContain("/");
  const fields = receipts.flatMap((row) => Object.values(row).filter((value) => typeof value === "string"));
  const secrets = [
    ...Object.values(file.inputs).flatMap(({ input }) => Object.values(input)),
    ...Object.values(file.cwds),
  ];
  for (const secret of secrets)
    expect(fields.filter((field) => field === secret || (secret.length > 3 && field.includes(secret)))).toEqual([]);
}

// ---------------------------------------------------------------------------------------------

describe("candidate provenance from the merged #713/#724 packet", () => {
  it("verifies the Claude excerpt pins from repository bytes before using them", async () => {
    const claude = pins.excerpts.filter((excerpt) => provenance.candidate.sourceExcerpts.includes(excerpt.id));
    expect(claude.map((excerpt) => excerpt.id).sort()).toEqual([...provenance.candidate.sourceExcerpts].sort());
    for (const excerpt of claude) {
      const bytes = await readFile(new URL(excerpt.path, root));
      expect(bytes.byteLength).toBe(excerpt.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(excerpt.sha256);
      expect(excerpt.repository).toBe("agentclientprotocol/claude-agent-acp");
      expect(excerpt.revision).toBe(provenance.candidate.adapter.revision);
      expect(excerpt.sourceBlobSha).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it("matches candidate identities to the pinned manifest and publication metadata", () => {
    const record = pins.providers.find((provider) => provider.id === "claude");
    const { native, sdk, adapter } = provenance.candidate;
    expect(record.native.candidateVersion).toBe(native.version);
    expect(record.sdk).toEqual({ name: sdk.package, version: sdk.version, integrity: sdk.integrity });
    expect(record.adapter).toEqual({ name: adapter.package, version: adapter.version, revision: adapter.revision });
    expect(record.installed).toBe("unknown");
    expect(record.feasibility).toBe("unknown");
    for (const candidate of [native, sdk]) {
      const published = publication.find((entry) => entry.name === candidate.package);
      expect(published).toMatchObject({
        version: candidate.version,
        integrity: candidate.integrity,
        shasum: candidate.shasum,
        gitHead: null,
      });
      expect(published.evidence).toMatch(/^metadata only/);
      expect(Object.values(published.optionalDependencies).every((v) => v === candidate.version)).toBe(true);
    }
    expect(provenance.candidate.evidenceLevel).toBe("source-reviewed");
  });

  it("keeps every installed fact unknown with installed observations NONE", () => {
    expect(provenance.installedObservations).toBe("NONE");
    expect(provenance.execution).toBe("none");
    expect(Object.keys(provenance.installed).sort()).toEqual([...REQUIRED_INSTALLED_FACTS].sort());
    const { facts, complete } = classifyProvenance(provenance);
    expect(complete).toBe(false);
    for (const [name, fact] of Object.entries(facts)) {
      expect(fact.state, name).toBe("unknown");
      expect(provenance.installed[name].reason.length, name).toBeGreaterThan(20);
    }
    expect(Object.values(provenance.installed.failureSemantics.modes).every((m) => m === "unknown")).toBe(true);
  });

  it("does not infer CLI/SDK artifact correspondence from matching version suffixes", () => {
    const { native, sdk } = provenance.candidate;
    expect(native.version.split(".").at(-1)).toBe(sdk.version.split(".").at(-1));
    expect(installedFact(provenance, "cliSdkArtifactCorrespondence").state).toBe("unknown");
    const claimed = structuredClone(provenance);
    claimed.installed.cliSdkArtifactCorrespondence = {
      state: "complete",
      evidenceLevel: "source-reviewed",
      basis: "version-suffix",
      installedRef: "suffix:309",
    };
    claimed.candidate.sdk.version = claimed.candidate.native.version;
    expect(installedFact(claimed, "cliSdkArtifactCorrespondence")).toEqual({
      state: "unknown",
      reason: "not-installed-observed",
    });
  });

  it.each(REQUIRED_INSTALLED_FACTS)("a missing %s fact stays unknown, never positive", (name) => {
    const manifest = hypotheticalInstalledManifest();
    expect(classifyProvenance(manifest).complete).toBe(true);
    delete manifest.installed[name];
    expect(installedFact(manifest, name)).toEqual({ state: "unknown", reason: "missing-fact" });
    expect(classifyProvenance(manifest).complete).toBe(false);
  });

  it.each(FAILURE_MODES)("an installed %s failure that continues is unsupported", (mode) => {
    const manifest = hypotheticalInstalledManifest();
    manifest.installed.failureSemantics.modes[mode] = "continue";
    expect(installedFact(manifest, "failureSemantics").state).toBe("unsupported");
  });
});

describe("canonical admission over the provenance record", () => {
  it("the current Claude record cannot be admitted by the actual strict evaluator", () => {
    const { action, state } = canonicalFromProvenance(provenance);
    expect(action.coverage).toMatchObject({ provider: "claude", level: "observation" });
    expect(action.coverage.evidence.installedRefs).toEqual([]);
    expect(action.coverage.negotiatedHook.state).toBe("unknown");
    expect(action.coverage.protectedConfiguration.state).toBe("unknown");
    const result = evaluateStrictPermission(action, state, NOW, "test:review");
    expect(result).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate", reason: "coverage-or-state-unavailable" },
    });
    expect(selectStrictPermissionOption(action, result.verdict, NOW)).toBeUndefined();
  });

  it("an owner precondition alone cannot replace unknown hook or protected coverage", () => {
    const { action, state } = canonicalFromProvenance(provenance, {
      coverageAndState: { state: "complete", value: true },
    });
    expect(evaluateStrictPermission(action, state, NOW, "test:review")).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate", reason: "insufficient-coverage" },
    });
  });

  it("even complete hypothetical provenance needs independently observed installed effects", () => {
    const { action, state } = canonicalFromProvenance(hypotheticalInstalledManifest());
    expect(action.coverage.level).toBe("verified-per-execution");
    expect(evaluateStrictPermission(action, state, NOW, "test:review")).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate", reason: "insufficient-coverage" },
    });
    // Positive control: the mapping is not a constant refusal once every gate is supplied.
    const supplied = canonicalFromProvenance(hypotheticalInstalledManifest(), { independentlyObservedEffects: true });
    const allowed = evaluateStrictPermission(supplied.action, supplied.state, NOW, "test:review");
    expect(allowed).toMatchObject({ phase: "final", verdict: { outcome: "allow" } });
    expect(allowed.verdict).toMatchObject(strictDecisionBinding(supplied.action));
  });

  it.each(REQUIRED_INSTALLED_FACTS)("losing %s returns the record to non-admission", (name) => {
    const manifest = hypotheticalInstalledManifest();
    manifest.installed[name] = { state: "unknown", reason: "offline fixture: not observed" };
    const { action, state } = canonicalFromProvenance(manifest, { independentlyObservedEffects: true });
    const result = evaluateStrictPermission(action, state, NOW, "test:review");
    expect(result.phase).toBe("final");
    expect(result.verdict.outcome).not.toBe("allow");
  });
});

describe("synthetic allow -> cached repeat -> revoke protocol over actual inactive ORCA parts", () => {
  it("scenarios consume every Claude and cross-provider #713 vector", () => {
    const covered = new Set([
      ...scenarios.scenarios.flatMap((scenario) => scenario.vectors),
      ...Object.values(scenarios.failureMatrix.vectors).flat(),
      ...Object.keys(scenarios.externallyCovered),
    ]);
    const relevant = vectors.cases.filter((entry) => entry.provider === "claude" || entry.provider === "all");
    expect(relevant.map((entry) => entry.id).filter((id) => !covered.has(id))).toEqual([]);
    for (const id of covered)
      expect(
        vectors.cases.some((entry) => entry.id === id),
        id,
      ).toBe(true);
    expect(scenarios.execution).toBe("none");
    expect(scenarios.authority).toBe("synthetic-protocol-only");
  });

  it("introduces no activation or support flag in harness data", async () => {
    const keys = [];
    const walk = (value) => {
      if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
    };
    for (const name of ["provenance.json", "scenarios.json", "evidence-format.json", "installed-observations.json"])
      walk(await json(new URL(name, fixtures)));
    expect(keys.filter((key) => /^(enabled?|activat\w*|supported|support|strict)$/i.test(key))).toEqual([]);
  });
});

describe("protocol scenarios (synthetic-protocol-tested; native behaviour is a stated hypothesis)", () => {
  it.each(scenarios.scenarios.map((scenario) => [scenario.id, scenario]))("%s", async (_id, scenario) => {
    const result = await runScenario(scenarios, scenario);
    const { expect: want } = scenario;
    expect(result.preflight).toBe(want.preflight ?? "synthetic-assumed");
    expectSanitized(result.receipts, scenarios);
    expect(result.receipts.every((row) => row.level === "synthetic-protocol-tested")).toBe(true);
    const observed = counts(result.receipts);
    expect(observed).toEqual(want.counts);
    // Effect receipts agree with the independent owner/native counters, not with the fence receipt.
    expect(result.independentEffects).toBe(observed.effects);
    if (scenario.row === "typed") expect(result.executorEntries).toBe(observed.effects);
    for (const [ref, outcome] of Object.entries(want.calls)) {
      const effected = result.receipts.some((r) => r.callRef === ref && r.stage === "effect-observed");
      expect(effected ? "effect" : "no-effect", ref).toBe(outcome);
    }
    for (const [ref, reason] of Object.entries(want.reasons))
      expect(callReason(result.receipts, ref), ref).toBe(reason);
    for (const reason of want.refusals ?? [])
      expect(
        result.receipts.some((r) => r.stage === "permit-claim" && r.reason === reason),
        reason,
      ).toBe(true);
    const assessed = assess(result.receipts, classifyProvenance(provenance).complete);
    expect(assessed).toEqual({
      violations: want.violations,
      cachedRepeatChecked: want.cachedRepeatChecked,
      revocationBlocked: want.revocationBlocked,
      decision: want.decision,
    });
  });

  const matrix = scenarios.failureMatrix;
  const failureCases = FAILURE_MODES.flatMap((mode) =>
    matrix.policies.flatMap((policy) => matrix.rows.map((row) => [mode, policy, row])),
  );
  it.each(failureCases)("checker %s with native %s policy on the %s row", async (mode, policy, row) => {
    const want = matrix.expect[policy === "block" ? "block" : `continue-${row}`];
    const scenario = {
      row,
      native: { cachedRepeatHook: "every-dispatch", failurePolicy: policy },
      steps: [
        {
          call: "call-1",
          toolUseId: "tu-1",
          input: row === "shell" ? "shell-a" : "typed-a",
          cwd: "ws-a",
          transport: mode,
        },
      ],
    };
    const result = await runScenario(scenarios, scenario);
    expectSanitized(result.receipts, scenarios);
    expect(counts(result.receipts)).toEqual(want.counts);
    expect(result.independentEffects).toBe(want.counts.effects);
    expect(result.receipts.find((r) => r.stage === "hook-response")?.outcome).toBe(mode);
    const assessed = assess(result.receipts, false);
    expect(assessed.violations).toEqual(want.violations);
    expect(assessed.decision).toBe(want.decision);
    expect(matrix.vectors[mode].length).toBeGreaterThan(0);
  });

  it("the cached repeat is a synthetic remembered permission, never an observed native cache", async () => {
    const scenario = scenarios.scenarios.find((entry) => entry.id === "allow-cached-revoke");
    const { receipts } = await runScenario(scenarios, scenario);
    const cached = receipts.filter((r) => r.stage === "native-dispatch" && r.outcome === "cached");
    expect(cached.map((r) => r.callRef)).toEqual(["call-2", "call-3"]);
    expect(cached.every((r) => r.sourceRef.startsWith("synthetic:") && r.level === "synthetic-protocol-tested")).toBe(
      true,
    );
    // Identical input, distinct native invocations, and one ORCA check per dispatch.
    const dispatches = receipts.filter((r) => r.stage === "native-dispatch");
    expect(new Set(dispatches.map((r) => r.bindingRef)).size).toBe(1);
    expect(new Set(dispatches.map((r) => r.invocationRef)).size).toBe(3);
    expect(assess(receipts, false).decision).toBe("UNKNOWN");
  });

  it("rejects malformed, oversize and unapproved frames before any capture", () => {
    const frame = {
      hook_event_name: "PreToolUse",
      session_id: "fixture-session",
      tool_use_id: "tu-1",
      tool_name: "orca_fixture_mark",
      tool_input: { caseId: "cached-a", value: "ok" },
      cwd: "/fixture/workspace-a",
    };
    expect(validateFrame(frame, scenarios)).toBeUndefined();
    expect(validateFrame({ ...frame, extra: true }, scenarios)).toBe("invalid-frame");
    expect(validateFrame({ ...frame, hook_event_name: "PermissionRequest" }, scenarios)).toBe("invalid-frame");
    expect(validateFrame({ ...frame, tool_use_id: "" }, scenarios)).toBe("invalid-frame");
    expect(validateFrame({ ...frame, tool_input: { ...frame.tool_input, extra: "x" } }, scenarios)).toBe(
      "unapproved-input",
    );
    expect(validateFrame({ ...frame, tool_input: { caseId: "cached-a", value: "x".repeat(5000) } }, scenarios)).toBe(
      "oversize-frame",
    );
    expect(validateFrame({ ...frame, tool_name: "Bash", tool_input: { command: "printf x" } }, scenarios)).toBe(
      "unapproved-input",
    );
  });
});

describe("evidence assessment and the later installed record", () => {
  it("the installed observation record is NONE and assesses as UNKNOWN", () => {
    expect(installed.installedObservations).toBe("NONE");
    expect(installed.receipts).toEqual([]);
    expect(installed.authorization).toMatch(/^none:/);
    expect(assess(installed.receipts, classifyProvenance(provenance).complete).decision).toBe("UNKNOWN");
  });

  it("relabelled receipts cannot reach review without complete installed provenance", async () => {
    // Hypothetical relabelling to exercise the gate; this is not evidence and is never persisted.
    const scenario = scenarios.scenarios.find((entry) => entry.id === "allow-cached-revoke");
    const { receipts } = await runScenario(scenarios, scenario);
    const relabelled = receipts.map((row) => ({ ...row, level: "installed-observed" }));
    expect(relabelled.every(validReceipt)).toBe(true);
    expect(assess(relabelled, classifyProvenance(provenance).complete).decision).toBe("UNKNOWN");
    expect(assess(relabelled, classifyProvenance(hypotheticalInstalledManifest()).complete).decision).toBe(
      "REVIEW-CANDIDATE",
    );
    expect(assess(receipts, true).decision).toBe("UNKNOWN");
    const mixed = relabelled.map((row, index) => (index === 0 ? receipts[0] : row));
    expect(assess(mixed, true).decision).toBe("UNKNOWN");
  });

  it("an installed violation would be a no-go candidate, a synthetic one only a detected pattern", async () => {
    const scenario = scenarios.scenarios.find((entry) => entry.id === "cached-hook-skipped-shell");
    const { receipts } = await runScenario(scenarios, scenario);
    expect(assess(receipts, true).decision).toBe("SYNTHETIC-VIOLATION-DETECTED");
    const relabelled = receipts.map((row) => ({ ...row, level: "installed-observed" }));
    expect(assess(relabelled, true).decision).toBe("NO-GO-CANDIDATE");
  });

  it("flags an effect authorized under a superseded generation", () => {
    const rows = [
      ["native-dispatch", { callRef: "call-1", invocationRef: "inv-1", outcome: "new", bindingRef: "binding-1" }],
      ["hook-invoked", { callRef: "call-1", invocationRef: "inv-1", outcome: "invoked" }],
      ["orca-decision", { callRef: "call-1", outcome: "allow", generation: "gen-0", bindingRef: "binding-1" }],
      ["revocation", { outcome: "revoked", generation: "gen-1" }],
      ["tool-start", { callRef: "call-1", outcome: "started", bindingRef: "binding-1" }],
      ["effect-observed", { callRef: "call-1", invocationRef: "inv-1", outcome: "observed" }],
    ].map(([stage, fields], index) => ({
      seq: index + 1,
      stage,
      level: "synthetic-protocol-tested",
      sourceRef: "synthetic:handwritten",
      ...fields,
    }));
    expect(rows.every(validReceipt)).toBe(true);
    expect(assess(rows, false).violations).toEqual(["effect-after-revocation"]);
  });

  it("rejects receipts carrying private values or unknown fields", () => {
    const row = { seq: 1, stage: "tool-start", level: "synthetic-protocol-tested", sourceRef: "synthetic:x" };
    expect(validReceipt(row)).toBe(true);
    expect(validReceipt({ ...row, command: "printf x" })).toBe(false);
    expect(validReceipt({ ...row, bindingRef: "printf 'orca-704'" })).toBe(false);
    expect(validReceipt({ ...row, reason: "/fixture/workspace-a" })).toBe(false);
    expect(validReceipt({ ...row, outcome: "allow" })).toBe(false);
    expect(validReceipt({ ...row, level: "installed" })).toBe(false);
    expect(validReceipt({ ...row, reason: "x".repeat(65) })).toBe(false);
  });

  it("reached no child process or network entry point", () => {
    expect(forbidden).toEqual([]);
    expect(fetchCalls).toBe(0);
  });
});
