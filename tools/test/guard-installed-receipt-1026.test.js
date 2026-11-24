/**
 * What an installed receipt must show for tiers A and B (#1026): every route the row lists as
 * unsupported shown refused or asked about on the installed agent, and every case run either
 * live through the real agent with per-call evidence, or, only where a live agent cannot make
 * the call, on ORCA's installed program.
 */
import { describe, expect, it } from "vitest";
import {
  installedCaseProblems,
  installedInputProblems,
  installedSettingsProblems,
  programEvidenceProblems,
  uncoveredRouteProblems,
} from "../guard-qualification/check-support-matrix.js";

const agent = { id: "claude", unsupportedRoutes: ["Remote sessions over SSH while the hook is on"] };
const how = "a hooked session on an SSH host is refused before it opens";

describe("an installed receipt shows every uncovered route refused or asked about", () => {
  it("holds when each is shown, with how", () => {
    expect(
      uncoveredRouteProblems(
        { uncoveredRoutes: [{ route: agent.unsupportedRoutes[0], result: "refused", how }] },
        agent,
      ),
    ).toEqual([]);
    expect(
      uncoveredRouteProblems({ uncoveredRoutes: [{ route: agent.unsupportedRoutes[0], result: "asked", how }] }, agent),
    ).toEqual([]);
  });

  it("refuses a route not shown, shown as anything else, or without how", () => {
    expect(uncoveredRouteProblems({}, agent)).toEqual([
      "uncovered route not shown refused: Remote sessions over SSH while the hook is on",
    ]);
    for (const r of [
      { route: agent.unsupportedRoutes[0], result: "allowed", how },
      { route: agent.unsupportedRoutes[0], result: "refused" },
      { route: agent.unsupportedRoutes[0], result: "refused", how: "trust me" },
    ])
      expect(uncoveredRouteProblems({ uncoveredRoutes: [r] }, agent)).toEqual([
        "uncovered route needs result refused or asked, and how it was shown: Remote sessions over SSH while the hook is on",
      ]);
  });
});

describe("each installed case runs live, or on the program only where a live agent cannot", () => {
  const route = {
    id: "claude-native-hook",
    installed: { live: "claude-connected", program: { F01: "a live agent builds the hook's input itself" } },
  };
  const assertions = {
    format: "orca-706-assertions/1",
    paths: { "claude-connected": { L03: [{ tool: "Write", expected: ["deny"] }] } },
    programs: {
      "claude-native-hook": {
        F01: [
          { args: "installed", expected: ["block"] },
          { args: "replaced", expected: ["ask"], surfaceLimit: 512 },
        ],
      },
    },
  };
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "/usr/bin/node", args: ["/h.js", "/c.json"], timeout: 10, onFailure: "block" },
          ],
        },
      ],
    },
  };
  const run = (extra = {}) => ({
    command: "/usr/bin/node",
    args: "installed",
    input: { sha256: "d".repeat(64), bytes: 8 },
    exitCode: 2,
    stdout: "",
    stderr: "ORCA: malformed hook input",
    outcome: "block",
    ...extra,
  });
  const asked = run({
    args: "replaced",
    exitCode: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }),
    stderr: "",
    outcome: "ask",
  });
  const programCase = (calls) => ({ id: "F01", result: "pass", via: "program", calls });
  const denied = {
    toolUseId: "toolu_1",
    tool: "Write",
    expected: ["deny"],
    outcome: "deny",
    orcaDecision: "observed",
    refusal: "orca-deny",
    approvals: [],
    effect: "none",
    effectRef: { kind: "file", path: "p", before: null, after: null, written: "w" },
  };
  const receipt = (cases) => ({ route: "claude-native-hook", cases, installedSettings: settings });

  it("holds for live cases with evidence and program cases the route lists", () => {
    expect(
      installedCaseProblems(
        receipt([{ id: "L03", result: "pass", via: "live", calls: [denied] }, programCase([run(), asked])]),
        ["L03", "F01"],
        assertions,
        route,
      ),
    ).toEqual([]);
  });

  it("refuses a route with no installed runner", () => {
    expect(installedCaseProblems(receipt([]), ["L03"], assertions, { id: "acp-ask" })).toEqual([
      "route claude-native-hook has no installed runner in the matrix",
    ]);
    // Tier A's receipt runs no case and needs no runner.
    expect(installedCaseProblems(receipt([]), [], assertions, { id: "acp-ask" })).toEqual([]);
  });

  it("refuses a case on the program that a live agent can make, or one that says neither", () => {
    expect(
      installedCaseProblems(receipt([{ id: "L03", result: "pass", via: "program" }]), ["L03"], assertions, route),
    ).toEqual(["case L03: run on the program, but a live agent can make it"]);
    expect(installedCaseProblems(receipt([{ id: "L03", result: "pass" }]), ["L03"], assertions, route)).toEqual([
      "case L03: needs via live or program",
    ]);
  });

  it("checks a live case's calls as a connected receipt's are", () => {
    const ran = { ...denied, effectRef: { ...denied.effectRef, after: "w" } };
    expect(
      installedCaseProblems(
        receipt([{ id: "L03", result: "pass", via: "live", calls: [ran] }]),
        ["L03"],
        assertions,
        route,
      ),
    ).toEqual([
      "case L03: Write: its evidence shows effect observed, not none (live, on claude-connected)",
      "case L03: Write: outcome deny does not follow from its evidence (live, on claude-connected)",
    ]);
    expect(
      installedCaseProblems(receipt([{ id: "L03", result: "pass", via: "live" }]), ["L03"], assertions, route),
    ).toEqual(["case L03: no per-call evidence (live, on claude-connected)"]);
    expect(
      installedCaseProblems(
        receipt([{ id: "L03", result: "pass", via: "live", calls: [denied] }]),
        ["L03"],
        assertions,
        {
          ...route,
          installed: { program: {} },
        },
      ),
    ).toEqual(["route claude-native-hook: no live runner for cases L03"]);
  });

  it("re-derives each program run's outcome from its exit code and output, against the inventory", () => {
    const problems = (calls, r = receipt([programCase(calls)])) => programEvidenceProblems(r, ["F01"], assertions);
    expect(problems([run(), asked])).toEqual([]);
    expect(problems([run()])).toEqual(["case F01 (program): 1 runs, the inventory requires 2"]);
    // A run that says it blocked but exited 0 with no output allowed.
    expect(problems([run({ exitCode: 0, stderr: "" }), asked])).toEqual([
      "case F01 (program): run 1: its output shows allow, not block",
    ]);
    // A run whose outcome holds, but not one the inventory accepts for that run.
    expect(problems([run(), { ...asked, exitCode: 2, stdout: "", outcome: "block" }])).toEqual([
      "case F01 (program): run 2: outcome block is not one the inventory accepts (ask)",
    ]);
    expect(problems([run({ args: "replaced" }), asked])).toEqual([
      "case F01 (program): run 1: ran with replaced arguments, the inventory's run uses installed",
    ]);
    expect(problems([run({ command: "/tmp/other" }), asked])).toEqual([
      "case F01 (program): run 1: not the installed command",
    ]);
    expect(problems([run({ input: undefined }), asked])).toEqual([
      "case F01 (program): run 1: needs its input digest, exit code, stdout and stderr",
    ]);
    expect(problems([run(), { ...asked, stderr: "x".repeat(513) }])).toEqual([
      "case F01 (program): run 2: stderr is 513 bytes, over 512",
    ]);
    expect(problems([run(), asked], { ...receipt([programCase([run(), asked])]), route: "elsewhere" })).toEqual([
      "no committed program inventory for route elsewhere",
    ]);
  });

  it("holds a program case only with settings that put the hook in front of every tool", () => {
    expect(installedSettingsProblems(settings)).toEqual([]);
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    const withHook = (h, extra = {}) => ({ hooks: { PreToolUse: [{ matcher: "*", hooks: [h], ...extra }] } });
    expect(installedSettingsProblems(undefined)).toEqual(["needs exactly one PreToolUse entry"]);
    expect(installedSettingsProblems(withHook(hook, { matcher: "Bash" }))).toEqual([
      "the PreToolUse entry must match every tool",
    ]);
    expect(installedSettingsProblems(withHook({ ...hook, onFailure: "allow" }))).toEqual([
      "a hook that fails must block",
    ]);
    expect(installedSettingsProblems(withHook({ ...hook, timeout: 600 }))).toEqual([
      "needs a timeout of at most 30 seconds",
    ]);
    expect(installedSettingsProblems(withHook({ ...hook, command: "node" }))).toEqual(["needs an absolute executable"]);
    expect(installedSettingsProblems(withHook({ ...hook, command: "/bin/sh -c x;y" }))).toEqual([
      "needs the exec form, not a shell line",
    ]);
    expect(installedSettingsProblems({ ...settings, permissions: { allow: ["*"] } })).toEqual([
      "changes more of the agent's settings than its hooks",
    ]);
    expect(
      programEvidenceProblems(
        { ...receipt([programCase([run(), asked])]), installedSettings: {} },
        ["F01"],
        assertions,
      ),
    ).toEqual(["installed settings: needs exactly one PreToolUse entry"]);
  });
});

describe("an installed receipt is bound to what it ran and to the requirements it ran against", () => {
  const artifacts = {
    adapterIntegrity: "sha512-abc",
    runtimeSha256: "a".repeat(64),
    hookProgramSha256: "b".repeat(64),
  };
  const agent = { id: "claude", pin: { artifacts } };
  const profile = "c".repeat(64);
  const receipt = (inputs = {}) => ({
    inputs: {
      adapter: { version: "0.109.1", integrity: artifacts.adapterIntegrity },
      runtime: { sha256: artifacts.runtimeSha256 },
      hookProgram: { sha256: artifacts.hookProgramSha256 },
      profile,
      ...inputs,
    },
  });

  it("holds when the artifacts are the row's pinned ones and the profile is the current one", () => {
    expect(installedInputProblems(receipt(), agent, profile)).toEqual([]);
  });

  it("refuses a receipt with no inputs, other artifacts, or other requirements", () => {
    const missing = ["needs inputs: the adapter's integrity, the runtime and hook program digests, and the profile"];
    expect(installedInputProblems({}, agent, profile)).toEqual(missing);
    expect(installedInputProblems(receipt({ runtime: { sha256: "short" } }), agent, profile)).toEqual(missing);
    expect(installedInputProblems(receipt({ hookProgram: { sha256: "e".repeat(64) } }), agent, profile)).toEqual([
      `hookProgramSha256 ${"e".repeat(64)} is not the row's pinned ${artifacts.hookProgramSha256}`,
    ]);
    expect(installedInputProblems(receipt(), { id: "claude", pin: {} }, profile)).toEqual([
      "adapterIntegrity sha512-abc is not the row's pinned nothing",
      `runtimeSha256 ${artifacts.runtimeSha256} is not the row's pinned nothing`,
      `hookProgramSha256 ${artifacts.hookProgramSha256} is not the row's pinned nothing`,
    ]);
    expect(installedInputProblems(receipt(), agent, "f".repeat(64))).toEqual([
      "ran against other requirements than the matrix states now (profile differs)",
    ]);
  });
});
