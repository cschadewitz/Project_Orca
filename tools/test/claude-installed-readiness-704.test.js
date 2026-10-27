// #704 installed-readiness packet: offline tests for the evidence collector, the inactive hook
// configuration and the re-verified source pins. Every journal here is synthetic and labelled so;
// an "installed" label appears only on in-memory copies that show a gate is reachable, and none is
// persisted. Passing these tests is not installed evidence: the installed Claude route stays UNKNOWN.
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyCollection, collect, main } from "../claude-704-readiness/collect-evidence.mjs";
import {
  loadMergedClassifier,
  MERGED_REGION_SHA256,
  mergedRegions,
} from "../claude-704-readiness/merged-classifier.mjs";

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
              throw new Error("child_process is forbidden in the #704 readiness tests");
            }
          : value,
      ]),
  );
  return { ...guarded, default: guarded };
});

const root = new URL("../../", import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const READINESS = "tools/test/fixtures/provider-enforcement-704-705/claude-installed-readiness/";
const MERGED = "tools/test/fixtures/provider-enforcement-704-705/claude-qualification/";

const classifier = loadMergedClassifier();
const pins = await json(`${READINESS}source-pins.json`);
const hookConfig = await json(`${READINESS}hook-config.inactive.json`);
const grammar = await json("tools/claude-704-readiness/observation-format.json");
const packetPins = await json("docs/preparation/provider-enforcement-704-705/source-pins.json");
const installed = await json(`${MERGED}installed-observations.json`);
let fetchCalls = 0;

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    fetchCalls++;
    throw new Error("network is forbidden in the #704 readiness tests");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// Synthetic journal builder. Labels only; the journal never carries input, cwd or native ids.

const RUN = {
  runRef: "run-1",
  provider: "claude",
  tool: "orca_fixture_mark",
  providerVersion: "2.1.309",
  adapterVersion: "0.95.0",
  actionRef: "action-1",
  cwdRef: "cwd-1",
};
const SOURCES = {
  acp: "acp-journal",
  hook: "hook-journal",
  guard: "guard-journal",
  policy: "policy-journal",
  executor: "executor-journal",
  counter: "counter-journal",
};
const F = { action: "fixture", cwd: "fixture" };
const dispatch = (inv, extra = {}) => ({
  source: "acp",
  kind: "acp.tool-call",
  inv,
  route: "fixture",
  binding: "binding-1",
  ...F,
  ...extra,
});
const frame = (inv) => ({ source: "hook", kind: "hook.frame", inv, ...F });
const decision = (inv, outcome, generation, extra = {}) => ({
  source: "policy",
  kind: "policy.decision",
  inv,
  outcome,
  generation,
  binding: "binding-1",
  ...F,
  ...extra,
});
const response = (inv, outcome) => ({ source: "hook", kind: "hook.response", inv, outcome });
const failure = (inv, outcome) => ({ source: "guard", kind: "guard.hook-failure", inv, outcome });
const continued = (inv, outcome) => ({ source: "guard", kind: "guard.native-continued", inv, outcome });
const ask = (inv, scope = "exact") => ({ source: "acp", kind: "acp.permission-request", inv, scope });
const answer = (inv, outcome = "allow-always-exact") => ({
  source: "acp",
  kind: "acp.permission-answer",
  inv,
  outcome,
});
const start = (inv, extra = {}) => ({
  source: "executor",
  kind: "executor.start",
  inv,
  outcome: "started",
  binding: "binding-1",
  ...F,
  ...extra,
});
const effect = (inv) => ({ source: "executor", kind: "executor.effect", inv });
const reading = (inv, outcome) => ({ source: "counter", kind: "counter.reading", inv, outcome });
const REVOKE = { source: "policy", kind: "policy.revocation", generation: "gen-1" };
const MUTATION = { source: "guard", kind: "guard.config-mutation", outcome: "hook-removed" };

const firstCall = (inv = "inv-1") => [
  dispatch(inv),
  frame(inv),
  decision(inv, "allow", "gen-0"),
  response(inv, "allow"),
  ask(inv),
  answer(inv),
  start(inv),
  effect(inv),
  reading(inv, "changed"),
];
const repeatCall = (inv = "inv-2") => [
  dispatch(inv),
  frame(inv),
  decision(inv, "allow", "gen-0"),
  response(inv, "allow"),
  start(inv),
  effect(inv),
  reading(inv, "changed"),
];
const revokedCall = (inv = "inv-3") => [
  dispatch(inv),
  frame(inv),
  decision(inv, "deny", "gen-1"),
  response(inv, "deny"),
  reading(inv, "unchanged"),
];
const mainEvents = () => [...firstCall(), ...repeatCall(), REVOKE, ...revokedCall()];

const ALL_SEALED = (n) => ({ acp: { from: 1, to: n }, hook: { from: 1, to: n }, counter: { from: 1, to: n } });
function journal(events, { seals = ALL_SEALED, run = RUN } = {}) {
  const numbered = events.map((event, index) => ({ seq: index + 1, ...event }));
  return {
    format: grammar.format,
    label: "synthetic",
    run: { ...run },
    sources: { ...SOURCES },
    seals: seals(numbered.length),
    events: numbered,
  };
}
/** In-memory relabel that shows a gate is reachable. Never written to disk. */
const asInstalled = (observations) => ({ ...observations, label: "installed", authorizationRef: "auth-hypothetical" });
const hypothetical = classifier.hypotheticalInstalledManifest();
const classifyInstalled = (events, options) =>
  classifyCollection(collect(asInstalled(journal(events, options))), classifier, hypothetical);
/** Replaces every event matching `match` with the result of `replace` (an array, possibly empty). */
const edit = (events, match, replace) => events.flatMap((event) => (match(event) ? replace(event) : [event]));
const at = (inv, kind) => (event) => event.inv === inv && event.kind === kind;

// ---------------------------------------------------------------------------------------------

describe("reuse of the merged completion classifier", () => {
  it("runs the merged regions unchanged, pinned by SHA-256", () => {
    const regions = mergedRegions();
    expect(Object.fromEntries(Object.entries(regions).map(([name, { sha256 }]) => [name, sha256]))).toEqual(
      MERGED_REGION_SHA256,
    );
    expect(regions.classifier.source).toContain("function classifyExperiment(record, manifest");
    expect(regions.classifier.source).toContain('incomplete.add("post-revocation-not-blocked-at-guard")');
    expect(regions.classifier.source).not.toContain("Protocol harness");
  });

  it("refuses to load when the merged classifier no longer matches its pin", () => {
    expect(() => loadMergedClassifier({ pins: { ...MERGED_REGION_SHA256, classifier: "0".repeat(64) } })).toThrow(
      /changed .*review it and update the pin/,
    );
  });

  it("still classifies the committed installed record as NO-EVIDENCE", () => {
    expect(installed.installedObservations).toBe("NONE");
    expect(installed.receipts).toEqual([]);
    const result = classifier.classifyExperiment(
      { format: "orca.claude-qualification-experiment/1", run: { ...RUN }, receipts: installed.receipts },
      classifier.provenance,
    );
    expect(result).toMatchObject({ outcome: "NO-EVIDENCE", route: "UNKNOWN" });
    expect(classifier.expectedRun()).toEqual({
      provider: "claude",
      tool: "orca_fixture_mark",
      providerVersion: pins.artifacts.cli.version,
      adapterVersion: pins.artifacts.adapter.version,
    });
  });
});

describe("re-verified source pins (source-reviewed, not installed)", () => {
  it("agree with the merged candidate identities and adapter excerpt revision", () => {
    const { native, sdk, adapter } = classifier.provenance.candidate;
    expect(pins.artifacts.cli).toMatchObject({
      package: native.package,
      version: native.version,
      integrity: native.integrity,
      shasum: native.shasum,
    });
    expect(pins.artifacts.sdk).toMatchObject({
      package: sdk.package,
      version: sdk.version,
      integrity: sdk.integrity,
      shasum: sdk.shasum,
    });
    expect(pins.artifacts.adapter).toMatchObject({ package: adapter.package, version: adapter.version });
    expect(pins.artifacts.adapter.gitHead).toBe(adapter.revision);
    expect(pins.artifacts.adapter.tag.commit).toBe(adapter.revision);
    for (const excerpt of packetPins.excerpts.filter((e) => e.repository === "agentclientprotocol/claude-agent-acp"))
      expect(excerpt.revision).toBe(pins.adapterSource.revision);
  });

  it("link adapter -> SDK -> native build, and keep the CLI correspondence unknown", () => {
    expect(pins.artifacts.adapter.dependencies[pins.artifacts.sdk.package]).toBe(pins.artifacts.sdk.version);
    expect(pins.artifacts.sdk.manifest.version).toBe(pins.artifacts.cli.version);
    for (const platform of Object.values(pins.artifacts.sdkPlatform)) {
      expect(platform.version).toBe(pins.artifacts.sdk.version);
      expect(platform.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const level = (text) => pins.linkage.find((entry) => entry.claim.includes(text))?.level;
    expect(level("share a native implementation")).toBe("unknown");
    expect(level("binary that runs")).toBe("unknown");
    expect(pins.installedObservations).toBe("NONE");
    expect(pins.execution).toBe("none");
    expect(pins.unknowns.length).toBeGreaterThanOrEqual(10);
  });

  it("record documentation by content hash and distinguish PreToolUse from permission callbacks", () => {
    for (const doc of pins.documentation) expect(doc.sha256 === null || /^[0-9a-f]{64}$/.test(doc.sha256)).toBe(true);
    const relied = pins.documentation.flatMap((doc) => doc.relied).join("\n");
    expect(relied).toMatch(/PreToolUse hooks run before every tool call/);
    expect(relied).toMatch(/PermissionRequest hooks run only when/);
    expect(relied).toMatch(/Auto-approved tools never reach canUseTool/);
    expect(relied).toMatch(/permissionDecision allow skips the permission prompt/);
  });
});

describe("inactive hook configuration template", () => {
  const strings = (value) =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];

  it("is inactive and leaves every host-specific value as a placeholder", () => {
    expect(hookConfig.status).toBe("INACTIVE");
    const [entry] = hookConfig.options.settings.hooks.PreToolUse;
    const [hook] = entry.hooks;
    expect(hook.command).toMatch(/^<[A-Z_]+>$/);
    for (const arg of hook.args) expect(arg).toMatch(/^<[A-Z_]+>$/);
    for (const server of hookConfig.mcpServers)
      for (const value of [server.command, ...server.args]) expect(value).toMatch(/^<[A-Z_]+>$/);
    expect(hookConfig.options.maxBudgetUsd).toMatch(/^<[A-Z_]+>$/);
    // No path, host or credential is committed anywhere in the template.
    for (const value of strings(hookConfig)) {
      expect(value).not.toMatch(/(^|\s)(\/|~\/|[A-Za-z]:\\)/);
      expect(value).not.toMatch(/sk-ant|api[_-]?key=|bearer /i);
    }
  });

  it("fails closed, isolates filesystem settings and never emits a bypassing allow", () => {
    const { options } = hookConfig;
    expect(options.settingSources).toEqual([]);
    // A string here would be read as a file relative to the agent-writable cwd.
    expect(options.settings).toBeTypeOf("object");
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(options).not.toHaveProperty("permissionMode");
    expect(options).not.toHaveProperty("allowedTools");
    expect(options.settings.permissions).toEqual({ defaultMode: "default", allow: [], ask: [], deny: [] });
    const [entry] = options.settings.hooks.PreToolUse;
    expect(options.settings.hooks.PreToolUse).toHaveLength(1);
    expect(entry.matcher).toBe("*");
    expect(entry.hooks).toEqual([expect.objectContaining({ type: "command", timeout: 2, onFailure: "block" })]);
    expect(hookConfig.checkerContract.orcaAllow).toMatch(/exit 0 and print nothing/);
    expect(hookConfig.checkerContract.neverEmit).toEqual(
      expect.arrayContaining(["permissionDecision allow", "permissionDecision defer", "updatedInput"]),
    );
    expect(hookConfig.fixtureTool).toBe(`mcp__${hookConfig.mcpServers[0].name}__${RUN.tool}`);
    expect(JSON.stringify(options)).not.toMatch(/CLAUDE_CODE_EXECUTABLE|bypassPermissions|acceptEdits/);
  });
});

describe("worked synthetic journals (committed, labelled synthetic)", () => {
  const files = async () =>
    (await readdir(new URL(READINESS, root))).filter((name) => /^synthetic-.*\.json$/.test(name)).sort();

  it("are all labelled synthetic and claim no authorization", async () => {
    const names = await files();
    expect(names).toEqual([
      "synthetic-typed-acp-unsealed.json",
      "synthetic-typed-complete.json",
      "synthetic-typed-hook-death.json",
    ]);
    for (const name of names) {
      const observations = await json(`${READINESS}${name}`);
      expect(observations.label).toBe("synthetic");
      expect(observations).not.toHaveProperty("authorizationRef");
    }
    expect(await json(`${READINESS}synthetic-typed-complete.json`)).toEqual(journal(mainEvents()));
  });

  it("complete: every receipt passes the merged format, and the run stays SIMULATION-ONLY", async () => {
    const collection = collect(await json(`${READINESS}synthetic-typed-complete.json`));
    expect(collection).toMatchObject({ disposition: "RECORDED", withheld: [], stops: [], qualification: "UNKNOWN" });
    for (const receipt of collection.record.receipts) {
      expect(classifier.validReceipt(receipt)).toBe(true);
      expect(receipt.level).toBe("synthetic-protocol-tested");
      expect(receipt.sourceRef).toMatch(/^synthetic:/);
    }
    const dispatches = collection.record.receipts.filter((r) => r.stage === "native-dispatch");
    expect(dispatches.map((r) => r.outcome)).toEqual(["new", "cached", "cached"]);
    const result = classifyCollection(collection, classifier);
    expect(result).toMatchObject({ outcome: "SIMULATION-ONLY", route: "UNKNOWN", sequence: { state: "complete" } });
  });

  it("hook death after revocation is kept as a failed run, not discarded", async () => {
    const collection = collect(await json(`${READINESS}synthetic-typed-hook-death.json`));
    const result = classifyCollection(collection, classifier);
    expect(result.outcome).toBe("SIMULATION-ONLY");
    expect(result.sequence.state).toBe("failed");
    expect(result.sequence.failed).toEqual(["effect-without-orca-allow", "native-continued-after-hook-failure"]);
    expect(result.review.decision).toBe("SYNTHETIC-VIOLATION-DETECTED");
  });

  it("an unsealed ACP log withholds the cached derivation instead of inferring it", async () => {
    const collection = collect(await json(`${READINESS}synthetic-typed-acp-unsealed.json`));
    expect(collection.withheld).toEqual([
      { callRef: "call-2", stage: "native-dispatch", reason: "dispatch-kind-unobservable" },
      { callRef: "call-3", stage: "native-dispatch", reason: "dispatch-kind-unobservable" },
    ]);
    const result = classifyCollection(collection, classifier);
    expect(result.sequence.state).toBe("incomplete");
    expect(result.sequence.incomplete).toEqual(
      expect.arrayContaining(["missing-cached-repeat", "post-revocation-not-cached"]),
    );
  });

  it("relabelled in memory as installed, reaches only the unverified tiers", () => {
    const supplied = collect(asInstalled(journal(mainEvents())));
    expect(supplied.record.receipts.every((r) => r.level === "installed-observed")).toBe(true);
    expect(supplied.record.receipts.every((r) => Object.values(SOURCES).includes(r.sourceRef))).toBe(true);
    // The merged manifest has no installed facts, so a perfect sequence still stops at provenance.
    expect(classifyCollection(supplied, classifier).outcome).toBe("PROVENANCE-INCOMPLETE");
    const result = classifyCollection(supplied, classifier, hypothetical);
    expect(result).toMatchObject({
      outcome: "EXPERIMENT-COMPLETE-PROVENANCE-UNVERIFIED",
      route: "UNKNOWN",
      provenance: { authenticity: "unverified" },
    });
    expect(result.review.decision).toBe("REVIEW-CANDIDATE");
  });

  it("the shell row uses the same collector and classifier with tool Bash", () => {
    const result = classifyCollection(
      collect(asInstalled(journal(mainEvents(), { run: { ...RUN, tool: "Bash" } }))),
      classifier,
      hypothetical,
    );
    expect(result.outcome).toBe("EXPERIMENT-COMPLETE-PROVENANCE-UNVERIFIED");
  });
});

describe("failure and negative paths (synthetic; each is preserved, none is a success)", () => {
  const POST = (kind) => at("inv-3", kind);
  const cases = [
    {
      name: "checker unavailable after revocation, native blocks: no ORCA deny, so incomplete",
      events: () =>
        edit(
          edit(mainEvents(), POST("policy.decision"), () => []),
          POST("hook.response"),
          () => [failure("inv-3", "unavailable"), continued("inv-3", "blocked")],
        ),
      outcome: "EXPERIMENT-INCOMPLETE",
      reasons: { incomplete: ["post-revocation-not-blocked-at-guard"] },
    },
    {
      name: "service outage, native continues and the effect happens",
      events: () =>
        edit(
          edit(mainEvents(), POST("policy.decision"), () => []),
          POST("counter.reading"),
          () => [],
        ).flatMap((event) =>
          POST("hook.response")(event)
            ? [
                failure("inv-3", "unavailable"),
                continued("inv-3", "continued"),
                start("inv-3"),
                effect("inv-3"),
                reading("inv-3", "changed"),
              ]
            : [event],
        ),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["effect-without-orca-allow", "native-continued-after-hook-failure"] },
    },
    {
      name: "malformed checker reply on the revoked call",
      events: () =>
        edit(
          edit(mainEvents(), POST("policy.decision"), () => []),
          POST("hook.response"),
          () => [failure("inv-3", "malformed")],
        ),
      outcome: "EXPERIMENT-INCOMPLETE",
      reasons: { incomplete: ["post-revocation-not-blocked-at-guard"] },
    },
    {
      name: "checker timeout on the cached repeat, native continues",
      events: () =>
        edit(
          edit(mainEvents(), at("inv-2", "policy.decision"), () => []),
          at("inv-2", "hook.response"),
          () => [failure("inv-2", "timeout"), continued("inv-2", "continued")],
        ),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["effect-without-orca-allow", "native-continued-after-hook-failure"] },
    },
    {
      name: "command changed before the check",
      events: () => edit(mainEvents(), at("inv-2", "policy.decision"), (e) => [{ ...e, action: "changed" }]),
      outcome: "INCONSISTENT-EVIDENCE",
      reasons: { inconsistent: ["action-mismatch"] },
    },
    {
      name: "command mutated after the check (final input differs at execution)",
      events: () => edit(mainEvents(), at("inv-2", "executor.start"), (e) => [{ ...e, action: "changed" }]),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["final-action-mismatch"] },
    },
    {
      name: "cwd changed after the check",
      events: () => edit(mainEvents(), at("inv-2", "executor.start"), (e) => [{ ...e, cwd: "changed" }]),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["final-cwd-mismatch"] },
    },
    {
      name: "start binding differs from the checked binding",
      events: () => edit(mainEvents(), at("inv-2", "executor.start"), (e) => [{ ...e, binding: "binding-2" }]),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["effect-binding-mismatch"] },
    },
    {
      name: "hook configuration mutated during the run",
      events: () =>
        edit(
          mainEvents(),
          (e) => e === REVOKE,
          () => [MUTATION, REVOKE],
        ),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["configuration-mutated"] },
    },
    {
      name: "cancellation of the revoked call (the merged classifier has no cancellation stage)",
      events: () =>
        edit(mainEvents(), POST("hook.frame"), (e) => [e, { source: "acp", kind: "acp.cancel", inv: "inv-3" }]),
      outcome: "INCONSISTENT-EVIDENCE",
      reasons: { inconsistent: ["unexpected-stage"] },
    },
    {
      name: "late (stale) response after the deny",
      events: () => edit(mainEvents(), POST("hook.response"), (e) => [e, failure("inv-3", "late")]),
      outcome: "INCONSISTENT-EVIDENCE",
      reasons: { inconsistent: ["duplicate-stage-in-call"] },
    },
    {
      name: "duplicate response on the cached repeat",
      events: () => edit(mainEvents(), at("inv-2", "hook.response"), (e) => [e, e]),
      outcome: "INCONSISTENT-EVIDENCE",
      reasons: { inconsistent: ["duplicate-stage-in-call"] },
    },
    {
      name: "replayed native dispatch",
      events: () => edit(mainEvents(), at("inv-2", "counter.reading"), (e) => [e, dispatch("inv-2")]),
      outcome: "INCONSISTENT-EVIDENCE",
      reasons: { inconsistent: ["duplicate-stage-in-call", "replayed-dispatch"] },
    },
    {
      name: "post-revocation answer is require-human, not an explicit deny",
      events: () => edit(mainEvents(), POST("policy.decision"), (e) => [{ ...e, outcome: "require-human" }]),
      outcome: "EXPERIMENT-INCOMPLETE",
      reasons: { incomplete: ["post-revocation-not-blocked-at-guard"] },
    },
    {
      name: "effected decision without a generation (the merged assessor treats it as a violation)",
      events: () => edit(mainEvents(), at("inv-2", "policy.decision"), ({ generation: _generation, ...e }) => [e]),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["effect-after-revocation"], incomplete: ["missing-generation"] },
    },
    {
      name: "effected decision without a binding",
      events: () => edit(mainEvents(), at("inv-2", "policy.decision"), ({ binding: _binding, ...e }) => [e]),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["effect-binding-mismatch"], incomplete: ["missing-binding"] },
    },
    {
      name: "revoked-call decision without a generation",
      events: () => edit(mainEvents(), POST("policy.decision"), ({ generation: _generation, ...e }) => [e]),
      outcome: "EXPERIMENT-INCOMPLETE",
      reasons: { incomplete: ["missing-generation"] },
    },
    {
      name: "revoked-call decision without a binding",
      events: () => edit(mainEvents(), POST("policy.decision"), ({ binding: _binding, ...e }) => [e]),
      outcome: "EXPERIMENT-INCOMPLETE",
      reasons: { incomplete: ["missing-binding"] },
    },
    {
      name: "effect after the revoked call was denied",
      events: () =>
        edit(mainEvents(), POST("counter.reading"), () => [
          start("inv-3"),
          effect("inv-3"),
          reading("inv-3", "changed"),
        ]),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["effect-after-denial", "started-after-denial"] },
    },
    {
      name: "allow after revocation under the new generation",
      events: () =>
        edit(
          edit(mainEvents(), POST("policy.decision"), () => [decision("inv-3", "allow", "gen-1")]),
          POST("hook.response"),
          () => [response("inv-3", "allow")],
        ),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["allow-after-revocation"] },
    },
    {
      name: "counter sees a change nobody reported",
      events: () => edit(mainEvents(), POST("counter.reading"), () => [reading("inv-3", "changed")]),
      outcome: "EXPERIMENT-FAILED",
      reasons: { failed: ["effect-after-denial", "unreported-effect"] },
    },
  ];

  it.each(cases)("$name", ({ events, outcome, reasons }) => {
    const result = classifyInstalled(events());
    expect(result.outcome).toBe(outcome);
    expect(result.route).toBe("UNKNOWN");
    for (const [kind, expected] of Object.entries(reasons))
      expect(result.sequence[kind]).toEqual(expect.arrayContaining(expected));
  });

  it("a cached repeat that never reaches the hook is derived as not-invoked only inside a sealed hook log", () => {
    const skipped = () =>
      edit(
        edit(
          edit(mainEvents(), at("inv-2", "hook.frame"), () => []),
          at("inv-2", "policy.decision"),
          () => [],
        ),
        at("inv-2", "hook.response"),
        () => [],
      );
    const sealed = collect(asInstalled(journal(skipped())));
    expect(sealed.record.receipts).toContainEqual(
      expect.objectContaining({ callRef: "call-2", stage: "hook-invoked", outcome: "not-invoked" }),
    );
    const result = classifyCollection(sealed, classifier, hypothetical);
    expect(result.outcome).toBe("EXPERIMENT-FAILED");
    expect(result.review.violations).toEqual(
      expect.arrayContaining(["cached-repeat-not-checked", "dispatch-not-checked", "effect-without-orca-allow"]),
    );

    const unsealed = collect(
      asInstalled(journal(skipped(), { seals: (n) => ({ acp: { from: 1, to: n }, counter: { from: 1, to: n } }) })),
    );
    expect(unsealed.withheld).toContainEqual({ callRef: "call-2", stage: "hook-invoked", reason: "hook-log-unsealed" });
    expect(unsealed.record.receipts.some((r) => r.outcome === "not-invoked")).toBe(false);
    expect(classifyCollection(unsealed, classifier, hypothetical).outcome).not.toMatch(/COMPLETE-/);
  });

  it("without a sealed counter log, no independent reading is used", () => {
    const collection = collect(
      asInstalled(journal(mainEvents(), { seals: (n) => ({ acp: { from: 1, to: n }, hook: { from: 1, to: n } }) })),
    );
    expect(collection.withheld.filter((w) => w.reason === "counter-log-unsealed")).toHaveLength(3);
    expect(collection.record.receipts.some((r) => r.stage === "effect-check")).toBe(false);
    const result = classifyCollection(collection, classifier, hypothetical);
    expect(result.outcome).toBe("EXPERIMENT-INCOMPLETE");
    expect(result.sequence.incomplete).toEqual(
      expect.arrayContaining(["missing-allowed-effect", "missing-independent-block-evidence"]),
    );
  });

  it("a wider remembered grant is a stop, and later calls are never derived as cached", () => {
    const events = edit(
      edit(mainEvents(), at("inv-1", "acp.permission-request"), () => [ask("inv-1", "wider")]),
      at("inv-1", "acp.permission-answer"),
      () => [answer("inv-1", "allow-once")],
    );
    const collection = collect(asInstalled(journal(events)));
    expect(collection.stops).toEqual(["wider-native-grant-offered"]);
    expect(collection.withheld.map((w) => w.callRef)).toEqual(["call-2", "call-3"]);
    expect(classifyCollection(collection, classifier, hypothetical).outcome).toBe("INCONSISTENT-EVIDENCE");
  });

  it.each(["subagent", "other-mcp", "interactive-stdin", "other-tool"])(
    "an unsupported %s route is a stop and an extra call, never part of a success",
    (route) => {
      const events = edit(
        mainEvents(),
        (e) => e === REVOKE,
        (e) => [
          dispatch("inv-9", { route }),
          frame("inv-9"),
          decision("inv-9", "deny", "gen-0"),
          response("inv-9", "deny"),
          e,
        ],
      );
      const collection = collect(asInstalled(journal(events)));
      expect(collection.stops).toEqual([`unsupported-route:${route}`]);
      const result = classifyCollection(collection, classifier, hypothetical);
      expect(result.outcome).toBe("INCONSISTENT-EVIDENCE");
      expect(result.sequence.inconsistent).toContain("unexpected-call");
    },
  );
});

describe("refusals: ambiguous, sensitive or missing observations", () => {
  const base = () => journal(mainEvents());
  const withEvent = (index, change) => {
    const observations = base();
    observations.events[index] = change(observations.events[index]);
    return observations;
  };
  const cases = [
    ["a path in a label", () => withEvent(0, (e) => ({ ...e, inv: "/tmp/inv-1" })), "forbidden-value:0"],
    ["a command string", () => withEvent(0, (e) => ({ ...e, action: "printf 'orca-704'" })), "forbidden-value:0"],
    ["a raw native tool-use id", () => withEvent(0, (e) => ({ ...e, inv: "toolu_01ABC123" })), "forbidden-value:0"],
    [
      "a payload digest as binding",
      () => withEvent(2, (e) => ({ ...e, binding: "a".repeat(64) })),
      "forbidden-value:2",
    ],
    ["a long number", () => withEvent(2, (e) => ({ ...e, generation: "gen-123456789012" })), "forbidden-value:2"],
    ["an unknown key", () => withEvent(0, (e) => ({ ...e, command: "x" })), "unknown-key:0"],
    ["an unknown kind", () => withEvent(0, (e) => ({ ...e, kind: "acp.transcript" })), "unknown-kind:0"],
    [
      "a source that does not own the kind",
      () => withEvent(0, (e) => ({ ...e, source: "hook" })),
      "source-kind-mismatch:0",
    ],
    ["a decision without action", () => withEvent(2, ({ action: _a, ...e }) => e), "missing-observation:2"],
    ["an outcome outside the kind", () => withEvent(3, (e) => ({ ...e, outcome: "ask" })), "outcome-not-allowed:3"],
    ["a non-label invocation", () => withEvent(0, (e) => ({ ...e, inv: "call-1" })), "label-shape:0"],
    ["a repeated sequence number", () => withEvent(1, (e) => ({ ...e, seq: 1 })), "seq-not-increasing:1"],
    ["a string sequence number", () => withEvent(1, (e) => ({ ...e, seq: "2" })), "event-seq:1"],
    [
      "an event outside its source's seal",
      () => ({ ...base(), seals: { ...base().seals, counter: { from: 1, to: 5 } } }),
      "event-outside-seal:8",
    ],
    [
      "the counter sharing the hook's log",
      () => ({ ...base(), sources: { ...SOURCES, counter: "hook-journal" } }),
      "source-not-independent",
    ],
    [
      "installed without an authorization reference",
      () => ({ ...base(), label: "installed" }),
      "installed-without-authorization",
    ],
    [
      "synthetic claiming an authorization",
      () => ({ ...base(), authorizationRef: "auth-1" }),
      "synthetic-claims-authorization",
    ],
    [
      "installed rows from synthetic sources",
      () => ({ ...asInstalled(base()), sources: { ...SOURCES, acp: "synthetic:acp" } }),
      "synthetic-source-labelled-installed",
    ],
    ["a run header with an extra key", () => ({ ...base(), run: { ...RUN, host: "h" } }), "run-shape"],
    ["an unknown journal key", () => ({ ...base(), transcript: "t" }), "journal-unknown-key"],
    ["another format", () => ({ ...base(), format: "orca.other/1" }), "journal-format"],
    ["an unknown label", () => ({ ...base(), label: "observed" }), "journal-label"],
    ["no events", () => ({ ...base(), events: [] }), "events-shape"],
    [
      "too many events",
      () => journal(Array.from({ length: grammar.limits.events + 1 }, () => reading("inv-1", "changed"))),
      "events-shape",
    ],
    ["a malformed seal", () => ({ ...base(), seals: { acp: { from: 3, to: 1 } } }), "seals-shape"],
    [
      "remembering a grant that was offered wider",
      () => journal(edit(mainEvents(), at("inv-1", "acp.permission-request"), () => [ask("inv-1", "wider")])),
      "answer-scope-conflict",
    ],
    [
      "an answer with no request",
      () => journal(edit(mainEvents(), at("inv-1", "acp.permission-request"), () => [])),
      "answer-without-request",
    ],
    [
      "two permission requests for one invocation",
      () => journal(edit(mainEvents(), at("inv-1", "acp.permission-request"), (e) => [e, e])),
      "duplicate-permission-request",
    ],
  ];

  it.each(cases)("refuses %s, with reason codes only", (_name, make, reason) => {
    const observations = make();
    const collection = collect(observations);
    expect(collection).toMatchObject({ disposition: "REFUSED", record: null, qualification: "UNKNOWN" });
    expect(collection.refusals).toContain(reason);
    // A refusal never echoes what it refused.
    const text = JSON.stringify(collection);
    for (const event of observations.events ?? [])
      for (const value of Object.values(event ?? {}))
        if (typeof value === "string" && /[/ _']|[0-9a-f]{32}/.test(value)) expect(text).not.toContain(value);
    expect(classifyCollection(collection, classifier)).toEqual({ outcome: "NOT-CLASSIFIED", route: "UNKNOWN" });
  });

  it.each([null, [], "journal", 7])("refuses a non-object journal (%j)", (value) => {
    expect(collect(value)).toMatchObject({ disposition: "REFUSED", refusals: ["journal-shape"], label: "unknown" });
  });
});

describe("offline and no-success guarantees", () => {
  it("the collector and loader import nothing that can spawn or connect", async () => {
    for (const file of ["collect-evidence.mjs", "merged-classifier.mjs"]) {
      const source = await readFile(new URL(`tools/claude-704-readiness/${file}`, root), "utf8");
      const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
      expect(imports.every((name) => ["node:fs", "node:url", "node:crypto"].includes(name))).toBe(true);
      expect(source).not.toMatch(/child_process|node:net|node:http|fetch\(|writeFile/);
    }
  });

  it("the CLI prints a classified collection and exits non-zero on refusal", async () => {
    const writes = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => writes.push(String(chunk)));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const path = new URL(`${READINESS}synthetic-typed-complete.json`, root).pathname;
      expect(await main([path, "--classify"])).toBe(0);
      const printed = JSON.parse(writes.join(""));
      expect(printed.classification).toMatchObject({ outcome: "SIMULATION-ONLY", route: "UNKNOWN" });
      expect(printed).toMatchObject({ qualification: "UNKNOWN", authenticity: "unverified" });
      expect(await main([])).toBe(64);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("no collection or classification ever reads as a success or a GO", () => {
    const outputs = [
      collect(journal(mainEvents())),
      collect(asInstalled(journal(mainEvents()))),
      collect(null),
    ].flatMap((collection) => [collection, classifyCollection(collection, classifier, hypothetical)]);
    const text = JSON.stringify(outputs);
    expect(text).not.toMatch(/"GO"|QUALIFIED|SUCCESS|successful|PASSED/i);
    for (const output of outputs) if (output.route) expect(output.route).toBe("UNKNOWN");
    for (const output of outputs) if (output.qualification) expect(output.qualification).toBe("UNKNOWN");
  });

  it("reached neither a child process nor the network", () => {
    expect(forbidden).toEqual([]);
    expect(fetchCalls).toBe(0);
  });
});

describe("review regression controls", () => {
  it("preserves unsupported existing-call collection stops", () => {
    const events = mainEvents();
    events.find((event) => event.kind === "acp.tool-call" && event.inv === "inv-2").route = "other-mcp";
    const collection = collect(asInstalled(journal(events)));
    expect(collection.stops).toContain("unsupported-route:other-mcp");
    expect(classifyCollection(collection, classifier, hypothetical).outcome).toBe("INCONSISTENT-EVIDENCE");
  });
  it.each(["duplicate", "late", "missing"])("refuses %s original answer", (mode) => {
    const events = mainEvents();
    const index = events.findIndex((event) => event.kind === "acp.permission-answer");
    const answer = events[index];
    if (mode === "duplicate") events.splice(index + 1, 0, { ...answer, outcome: "deny" });
    else {
      events.splice(index, 1);
      if (mode === "late") events.push(answer);
    }
    expect(collect(journal(events)).disposition).toBe("REFUSED");
  });
  it("sanitizes malformed JSON and read errors without echo", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const dir = await mkdtemp("/tmp/orca-review-");
    const marker = "DUMMY_SECRET_REVIEW_776";
    const path = `${dir}/${marker}.json`;
    await writeFile(path, `{"${marker}":`);
    const out = [];
    const err = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((s) => out.push(String(s)));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((s) => err.push(String(s)));
    try {
      expect(await main([path])).toBe(1);
      expect(await main([`${path}-missing`])).toBe(1);
      expect(out.join("") + err.join("")).not.toContain(marker);
      expect(err.join("")).toBe("journal-parse-error\njournal-read-error\n");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await rm(dir, { recursive: true });
    }
  });
});
