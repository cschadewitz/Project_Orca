/** Golden plans and fail-closed probes over isolated real Git histories, without launching runtime fixtures. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonical, digest, git, parseChanges, snapshot, validPath } from "../ci-shadow/git.js";
import { consumers, coveredInventory, graph, imports, MANIFEST_PATH, TOOL_PATHS } from "../ci-shadow/graph.js";
import { createPlan, loadManifest, validateExecution, validatePlan } from "../ci-shadow/selector.js";
import { executionPlan, runSelected, selectedResult } from "../ci-shadow/execute.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const goldens = JSON.parse(readFileSync(new URL("./ci-shadow/golden.v1.json", import.meta.url), "utf8"));
const ownedManifest = loadManifest();
let directory;
let base;
let manifest;
const command = (...args) => git(directory, args).toString().trim();
const write = (path, content) => {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), content);
};
const save = () => {
  command("add", "-A");
  command("commit", "-qm", "synthetic selector scenario");
  return command("rev-parse", "HEAD");
};
const wording = (path, text) =>
  path.endsWith("/src/ui/format-time.ts")
    ? text.replace('return "just now";', 'return "a moment ago";')
    : text.replace('"never renders three units"', '"uses two units"');

const reset = () => {
  command("checkout", "-q", "--detach", base);
  command("clean", "-fdq");
};
const plan = (head = command("rev-parse", "HEAD"), options = {}) =>
  createPlan({ repo: directory, base, head, candidate: head, ...options }, manifest);

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "orca-ci-shadow-"));
  command("init", "-q");
  command("config", "user.name", "Selector fixture");
  command("config", "user.email", "selector-fixture@example.invalid");
  const paths = new Set([
    ...ownedManifest.edges
      .flatMap((edge) => [edge.from, edge.to])
      .filter((node) => node.startsWith("file:"))
      .map((node) => node.slice(5)),
    ...ownedManifest.runners.flatMap((runner) => [runner.config, ...runner.files]),
    ...goldens.filter((entry) => entry.status !== "A").map((entry) => entry.path),
    "packages/app/renderer/test/extra.test.ts",
    "packages/app/test/source-reader.test.ts",
    "packages/cli/test/admission-retry-wiring.test.ts",
    "packages/integrations/test/admission-retry-acp.test.ts",
    "packages/integrations/test/mcp-root-worktree.test.ts",
    "docs/ci-shadow-selection.md",
  ]);
  for (const path of paths) write(path, /\.json$/.test(path) ? "{}\n" : "/** Synthetic graph node. */\n");
  for (const name of [
    "core",
    "store",
    "agents",
    "engine",
    "daemon",
    "protocol",
    "integrations",
    "cli",
    "testing",
    "app",
    "design",
    "maintenance-mcp",
  ])
    for (const file of ["package.json", "tsconfig.json"])
      write(`packages/${name}/${file}`, readFileSync(join(root, `packages/${name}/${file}`), "utf8"));
  for (const path of TOOL_PATHS) write(path, readFileSync(join(root, path), "utf8"));
  for (const path of ownedManifest.islands.flatMap((island) => island.paths))
    write(path, readFileSync(join(root, path), "utf8"));
  for (const name of ["authority", "lifecycle", "recovery"])
    write(
      `packages/integrations/test/mcp-operator-production-${name}.test.ts`,
      'import "./mcp-operator-production-fixture.js";\n',
    );
  for (const path of [
    "packages/integrations/test/mcp-operator-production-fixture.ts",
    "packages/integrations/test/mcp-root-worktree.test.ts",
    "packages/integrations/test/mcp-replay-diagnostics.test.ts",
  ])
    write(path, 'import "./mcp-replay-diagnostics.js";\n');
  write(
    "tools/test/trusted-prepared-roots.test.js",
    'import "../../docs/preparation/trusted-prepared-roots/contract.test.mjs";\n',
  );
  save();
  manifest = structuredClone(ownedManifest);
  manifest.reviewedInventoryHash = coveredInventory(snapshot(directory, command("rev-parse", "HEAD")).files, manifest);
  write(MANIFEST_PATH, JSON.stringify(manifest));
  base = save();
}, 30_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const eligibleCandidate = () => {
  reset();
  const path = manifest.islands[0].paths[1];
  write(path, wording(path, readFileSync(join(directory, path), "utf8")));
  const head = save();
  const candidate = git(directory, ["commit-tree", `${head}^{tree}`, "-p", base, "-p", head], "Selection candidate\n")
    .toString()
    .trim();
  command("checkout", "-q", "--detach", candidate);
  return { repo: directory, base, head, candidate };
};
const selectedRaw = (paths, root = directory) => ({
  success: true,
  numTotalTests: paths.length,
  numPassedTests: paths.length,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: paths.map((path) => ({
    name: join(root, path),
    status: "passed",
    assertionResults: [{ status: "passed", fullName: "selected assertion" }],
  })),
});

it("enforces a useful exact-file PR path while Node 24/main remain full", () => {
  const input = eligibleCandidate();
  const result = executionPlan(input, "pull_request", 22, manifest);
  expect(result.mode).toBe("targeted");
  expect(result.plan.graphs.every((entry) => entry.complete)).toBe(true);
  expect(result.plan.wouldRun.vitestFiles.length).toBeLessThan(result.plan.graphs[1].discoveredVitestFiles.length);
  expect(result.plan.wouldRun.vitestFiles).toContain(manifest.islands[0].paths[1]);
  expect(executionPlan(input, "pull_request", 24, manifest).mode).toBe("full");
  expect(executionPlan(input, "push", 22, manifest).mode).toBe("full");
  expect(executionPlan(input, "unknown", 22, manifest).mode).toBe("full");
  const artifact = join(tmpdir(), `orca-selection-${input.candidate}.json`);
  const reportPath = join(tmpdir(), `orca-selection-result-${input.candidate}.json`);
  writeFileSync(artifact, JSON.stringify(result.plan));
  try {
    let calls = 0;
    const execute = (binary, args, options) => {
      calls++;
      expect(binary).toBe("pnpm");
      expect(args.slice(0, 3)).toEqual(["exec", "vitest", "run"]);
      expect(args.slice(3, 3 + result.plan.wouldRun.vitestFiles.length)).toEqual(result.plan.wouldRun.vitestFiles);
      expect(args).toContain("--maxWorkers=2");
      expect(options.cwd).toBe(directory);
      expect(options.shell).toBeUndefined();
      writeFileSync(reportPath, JSON.stringify(selectedRaw(result.plan.wouldRun.vitestFiles)));
      return { status: 0 };
    };
    expect(runSelected(input, artifact, reportPath, 2, execute, manifest).selectedFilesPassed).toBe(
      result.plan.wouldRun.vitestFiles.length,
    );
    expect(calls).toBe(1);
    const tampered = structuredClone(result.plan);
    tampered.wouldRun.vitestFiles.pop();
    writeFileSync(artifact, JSON.stringify(tampered));
    expect(() => runSelected(input, artifact, reportPath, 2, execute, manifest)).toThrow(
      "stale_mismatched_or_modified_plan",
    );
    expect(calls).toBe(1);
    expect(() => runSelected(input, artifact, reportPath, 3, execute, manifest)).toThrow("invalid_worker_bound");
    writeFileSync(artifact, JSON.stringify(result.plan));
    // A status-zero runner that writes nothing cannot reuse the preceding passing report.
    expect(() => runSelected(input, artifact, reportPath, 2, () => ({ status: 0 }), manifest)).toThrow();
    expect(() => runSelected(input, artifact, reportPath, 2, () => ({ status: 1 }), manifest)).toThrow(
      "selected_process_failed",
    );
    write(manifest.islands[0].paths[0], readFileSync(join(directory, manifest.islands[0].paths[0]), "utf8") + "\n");
    expect(() => runSelected(input, artifact, reportPath, 2, execute, manifest)).toThrow();
  } finally {
    command("reset", "--hard", input.candidate);
    rmSync(artifact, { force: true });
    rmSync(reportPath, { force: true });
  }
});

it.each(["different_tree", "same_tree"])(
  "rejects a fresh passing report after execution moves to a clean %s commit",
  (kind) => {
    const input = eligibleCandidate();
    const { plan } = executionPlan(input, "pull_request", 22, manifest);
    expect(plan.wouldRun.tier).toBe("targeted");
    const artifact = join(tmpdir(), `orca-moved-selection-${input.candidate}.json`);
    const reportPath = join(tmpdir(), `orca-moved-result-${input.candidate}.json`);
    writeFileSync(artifact, JSON.stringify(plan));
    try {
      let calls = 0;
      const execute = () => {
        calls++;
        writeFileSync(reportPath, JSON.stringify(selectedRaw(plan.wouldRun.vitestFiles)));
        if (kind === "different_tree") {
          const path = manifest.islands[0].paths[0];
          write(path, wording(path, readFileSync(join(directory, path), "utf8")));
          save();
        } else command("commit", "--allow-empty", "-qm", "Clean same-tree HEAD move");
        expect(command("status", "--porcelain")).toBe("");
        expect(command("rev-parse", "HEAD")).not.toBe(input.candidate);
        return { status: 0 };
      };
      expect(() => runSelected(input, artifact, reportPath, 2, execute, manifest)).toThrow(
        "checkout_candidate_mismatch",
      );
      expect(calls).toBe(1);
    } finally {
      rmSync(artifact, { force: true });
      rmSync(reportPath, { force: true });
    }
  },
);

it("cannot reduce a head-only checkout or a candidate with swapped parents", () => {
  const input = eligibleCandidate();
  expect(() => executionPlan({ ...input, candidate: input.head }, "pull_request", 22, manifest)).toThrow(
    "candidate_parents_mismatch",
  );
  const swapped = git(
    directory,
    ["commit-tree", `${input.head}^{tree}`, "-p", input.head, "-p", base],
    "Wrong candidate\n",
  )
    .toString()
    .trim();
  expect(() => executionPlan({ ...input, candidate: swapped }, "pull_request", 22, manifest)).toThrow(
    "candidate_parents_mismatch",
  );
  command("checkout", "-q", "--detach", input.head);
  expect(() => executionPlan(input, "pull_request", 22, manifest)).toThrow("checkout_candidate_mismatch");
});

it.each(["missing", "extra", "duplicate", "failed", "skipped", "todo", "empty", "wrong_path", "bad_totals"])(
  "rejects selected execution report %s even if the process exits green",
  (kind) => {
    const paths = ["packages/app/renderer/test/format-time.test.tsx"];
    const result = { identities: { candidate: "a".repeat(40) }, wouldRun: { vitestFiles: paths } };
    const raw = selectedRaw(paths, "/selected");
    if (kind === "missing") raw.testResults = [];
    if (kind === "extra" || kind === "duplicate")
      raw.testResults.push({
        ...raw.testResults[0],
        name: kind === "extra" ? "/selected/extra.test.ts" : raw.testResults[0].name,
      });
    if (["failed", "skipped", "todo"].includes(kind)) raw.testResults[0].assertionResults[0].status = kind;
    if (kind === "empty") raw.testResults[0].assertionResults = [];
    if (kind === "wrong_path") raw.testResults[0].name = "/selected/other.test.ts";
    if (kind === "bad_totals") raw.numPassedTests++;
    expect(() => selectedResult(result, raw, "/selected")).toThrow();
  },
);

it.each(goldens)("golden: $label", ({ path, status, tier, reason }) => {
  reset();
  if (status === "D") rmSync(join(directory, path));
  else if (status === "R") command("mv", path, `${path}.moved`);
  else
    write(
      path,
      status === "A"
        ? "/** New unreviewed node. */\n"
        : ownedManifest.islands.some((island) => island.paths.includes(path))
          ? wording(path, readFileSync(join(directory, path), "utf8"))
          : readFileSync(join(directory, path), "utf8") + "\n/* Golden wording change. */\n",
    );
  const result = plan(save());
  expect(result.wouldRun.tier).toBe(tier);
  expect(result.wouldRun.reasonCodes).toContain(reason);
  expect(result.shadowOnly).toBe(true);
  expect(result.authority).toBe("existing-full-checks");
  if (tier === "full") expect(result.wouldRun.vitestFiles).toEqual(result.graphs[1].discoveredVitestFiles);
  if (tier === "targeted") {
    expect(result.graphs.every((entry) => entry.complete)).toBe(true);
    expect(result.wouldRun.vitestFiles).toContain("packages/app/test/source-reader.test.ts");
    expect(result.wouldRun.vitestFiles).toContain("packages/app/renderer/test/extra.test.ts");
    expect(result.wouldRun.runners.map((runner) => runner.id)).toContain("resources-browser");
  }
});

it("takes full when the reviewed format-time test is renamed to Markdown and discovery shrinks", () => {
  reset();
  command("mv", "packages/app/renderer/test/format-time.test.tsx", "packages/app/renderer/test/format-time.md");
  const result = plan(save());
  expect(result.wouldRun.tier).toBe("full");
  expect(result.graphs[1].discoveredVitestFiles.length).toBe(result.graphs[0].discoveredVitestFiles.length - 1);
  expect(result.wouldRun.reasonCodes).toContain("discovery_inventory_changed");
  expect(result.wouldRun.vitestFiles).toEqual(result.graphs[1].discoveredVitestFiles);
});

it("pins all identities, emits deterministic plans, and recomputes their entire contents", () => {
  reset();
  const path = manifest.islands[0].paths[0];
  write(path, wording(path, readFileSync(join(directory, path), "utf8")));
  const head = save();
  const input = { repo: directory, base, head, candidate: head };
  const result = createPlan(input, manifest);
  expect(result.identities).toEqual({ base, head, candidate: head, mergeBase: base });
  expect(validatePlan(result, input, manifest)).toEqual(result);
  for (const mutate of [
    (copy) => {
      copy.schemaVersion = 2;
    },
    (copy) => {
      copy.identities.base = head;
    },
    (copy) => {
      copy.identities.mergeBase = head;
    },
    (copy) => {
      copy.identities.candidate = base;
    },
    (copy) => {
      copy.selector.hash = "0".repeat(64);
    },
    (copy) => {
      copy.selector.manifestHash = "0".repeat(64);
    },
    (copy) => {
      copy.graphs[0].hash = "0".repeat(64);
    },
    (copy) => {
      copy.wouldRun.vitestFiles.pop();
    },
    (copy) => {
      copy.wouldRun.expectedChecks = [];
    },
    (copy) => {
      copy.changes = [];
    },
    (copy) => {
      copy.observedResults = [{ status: "passed" }];
    },
    (copy) => {
      copy.shadowOnly = false;
    },
  ]) {
    const copy = structuredClone(result);
    mutate(copy);
    expect(() => validatePlan(copy, input, manifest)).toThrow("stale_mismatched_or_modified_plan");
  }
  write(path, readFileSync(join(directory, path), "utf8") + "\n// later head\n");
  const later = save();
  expect(() => validatePlan(result, { ...input, head: later, candidate: later }, manifest)).toThrow();
});

it("retains filesystem and emitted-process consumers in the base/candidate union", () => {
  reset();
  const oldGraph = graph(snapshot(directory, base), manifest);
  const fixture = "docs/preparation/trusted-prepared-roots/fixtures/synthetic-v1.json";
  command("mv", fixture, fixture + ".renamed");
  write(
    "packages/integrations/test/mcp-operator-production-authority.test.ts",
    "/** Removed import in candidate. */\n",
  );
  const head = save();
  const newGraph = graph(snapshot(directory, head), manifest);
  expect(consumers([oldGraph, newGraph], [fixture])).toContain("file:tools/test/trusted-prepared-roots.test.js");
  expect(
    consumers(
      [oldGraph, newGraph],
      ["packages/store/src/index.ts", "packages/cli/package.json", "packages/testing/package.json"],
    ),
  ).toContain("file:packages/integrations/test/mcp-operator-production-authority.test.ts");
  const result = plan(head);
  expect(result.wouldRun.tier).toBe("full");
  expect(result.changes.find((entry) => entry.oldPath === fixture)?.consumers).toContain(
    "file:tools/test/trusted-prepared-roots.test.js",
  );
});

it("retains the reviewed credential-admin and direct emitted-identity regression edges", () => {
  reset();
  const g = graph(snapshot(directory, base), manifest);
  const fixture = "packages/integrations/test/mcp-operator-production-fixture.ts";
  const regression = "packages/integrations/test/mcp-operator-production-fixture.test.ts";
  expect(g.edges).toContainEqual({
    from: "file:packages/daemon/src/auth/bootstrap.ts",
    to: `file:${fixture}`,
    kind: "compiled-credential-admin",
  });
  expect(g.edges).toContainEqual({
    from: "package:daemon",
    to: `file:${regression}`,
    kind: "compiled-subprocess-identity-regression",
  });
  expect(consumers([g], ["packages/daemon/src/auth/bootstrap.ts"])).toContain(`file:${regression}`);
  expect(g.tests).toContain(regression);
});

it("retains reviewed diagnostic preloads, generated helper imports and filesystem readers across a rename", () => {
  reset();
  const oldGraph = graph(snapshot(directory, base), manifest);
  const helper = "packages/integrations/test/mcp-replay-diagnostics.ts";
  const regression = "packages/integrations/test/mcp-replay-diagnostics.test.ts";
  const rootReplay = "packages/integrations/test/mcp-root-worktree.test.ts";
  for (const kind of ["subprocess-diagnostic-preload", "subprocess-typescript-helper"])
    expect(oldGraph.edges).toContainEqual({ from: `file:${helper}`, to: `file:${regression}`, kind });
  expect(oldGraph.edges).toContainEqual({
    from: `file:${helper}`,
    to: "file:packages/integrations/test/mcp-operator-production-fixture.ts",
    kind: "compiled-stdio-diagnostic-preload",
  });
  for (const path of [
    "packages/store/src/admission-retry-store.ts",
    "packages/store/src/jsonl-log.ts",
    "packages/store/src/lease-store.ts",
  ]) {
    expect(oldGraph.edges).toContainEqual({
      from: `file:${path}`,
      to: `file:${helper}`,
      kind: "filesystem-lock-evidence",
    });
    expect(consumers([oldGraph], [path])).toEqual(expect.arrayContaining([`file:${regression}`, `file:${rootReplay}`]));
  }
  expect(oldGraph.tests).toEqual(expect.arrayContaining([regression, rootReplay]));
  command("mv", helper, helper + ".renamed");
  write(rootReplay, "/** Candidate removed helper import. */\n");
  const head = save();
  const newGraph = graph(snapshot(directory, head), manifest);
  expect(newGraph.complete).toBe(false);
  expect(consumers([oldGraph, newGraph], [helper])).toContain(`file:${rootReplay}`);
  const result = plan(head);
  expect(result.wouldRun.tier).toBe("full");
  expect(result.changes.find((entry) => entry.oldPath === helper)?.consumers).toContain(`file:${rootReplay}`);
});

it.each(["mcp-replay-diagnostics.ts", "mcp-replay-diagnostics.test.ts"])(
  "keeps the reviewed diagnostic path full-risk: %s",
  (name) => {
    reset();
    const path = `packages/integrations/test/${name}`;
    write(path, readFileSync(join(directory, path), "utf8") + "\n/* Changed diagnostic input. */\n");
    const result = plan(save());
    expect(result.wouldRun.tier).toBe("full");
    expect(result.wouldRun.reasonCodes).toContain("shared_or_sensitive_package");
    expect(result.wouldRun.vitestFiles).toContain("packages/integrations/test/mcp-replay-diagnostics.test.ts");
  },
);

it("maps shared resource fixtures and preferences to the standalone Playwright runner", () => {
  reset();
  const g = graph(snapshot(directory, base), manifest);
  for (const path of [
    "packages/app/renderer/src/resources/resource-model.ts",
    "packages/protocol/src/host-resource-fixtures.ts",
    "packages/app/src/preferences/schema.ts",
    "packages/app/vite.config.ts",
  ])
    expect(consumers([g], [path])).toContain("runner:resources-browser");
  expect(g.tests).not.toContain("packages/app/renderer/test/resources-browser.spec.ts");
  expect(g.edges.some((edge) => edge.kind === "typescript-reference")).toBe(true);
  expect(g.edges.some((edge) => edge.kind === "workspace-dependency")).toBe(true);
});

it.each([
  ['import("./" + name);', "unreviewed_execution_edge"],
  ['import fs from "node:fs";', "unreviewed_execution_edge"],
  ['globalThis.fetch("https://example.invalid");', "unreviewed_execution_edge"],
  ['navigator.sendBeacon("https://example.invalid/probe", "synthetic");', "unreviewed_execution_edge"],
  ['new EventSource("https://example.invalid/probe");', "unreviewed_execution_edge"],
  ['localStorage.setItem("synthetic-review-probe", "1");', "unreviewed_execution_edge"],
  ['sessionStorage.setItem("synthetic-review-probe", "1");', "unreviewed_execution_edge"],
  ['indexedDB.open("synthetic-review-probe");', "unreviewed_execution_edge"],
  ['caches.open("synthetic-review-probe");', "unreviewed_execution_edge"],
  ['new BroadcastChannel("synthetic-review-probe");', "unreviewed_execution_edge"],
  ["const ambient = { unreviewedTransport };", "unreviewed_execution_edge"],
  ['unreviewedTransport.send("synthetic-review-probe");', "unreviewed_execution_edge"],
  [
    'declare const unreviewedTransport: { send(value: string): void }; unreviewedTransport.send("synthetic");',
    "unreviewed_execution_edge",
  ],
  ['import cp = require("node:child_process"); cp.execSync("true");', "unreviewed_execution_edge"],
  ["const x = ;", "island_graph_incomplete"],
])("falls back for new dependency/ambient/dynamic boundaries: %s", (extra, reason) => {
  reset();
  const path = manifest.islands[0].paths[0];
  write(path, readFileSync(join(directory, path), "utf8") + "\n" + extra);
  const result = plan(save());
  expect(result.wouldRun.tier).toBe("full");
  expect(result.wouldRun.reasonCodes).toContain(reason);
});

it("retains import-equals dependencies and rejects direct unreviewed ambient references", () => {
  const signature = imports('import cp = require("node:child_process"); cp.execSync("true");', "probe.ts");
  expect(signature).toEqual({
    dependencies: ["node:child_process"],
    bindings: ["node:child_process::require::cp"],
    callTargets: ["cp.execSync"],
    memberReferences: ["cp.execSync"],
    unsafe: true,
  });
  const allowed = ["Date", "Math", "undefined"];
  for (const text of [
    'navigator.sendBeacon("x", "x");',
    'new EventSource("x");',
    'localStorage.setItem("x", "x");',
    'new BroadcastChannel("x");',
    "const ambient = { unreviewedTransport };",
  ])
    expect(imports(text, "probe.ts", allowed).unsafe).toBe(true);
  expect(
    imports("const local = { send: (value: string) => value }; local.send('synthetic');", "probe.ts", allowed).unsafe,
  ).toBe(false);
  reset();
  const formatter = manifest.islands[0].paths[0];
  const helper = "packages/app/renderer/src/require-helper.ts";
  write(helper, "export const value = 1;\n");
  write(
    formatter,
    readFileSync(join(directory, formatter), "utf8") + '\nimport helper = require("../require-helper.js");\n',
  );
  const g = graph(snapshot(directory, save()), manifest);
  expect(g.edges).toContainEqual({ from: `file:${helper}`, to: `file:${formatter}`, kind: "static-import-or-alias" });
});

it.each([
  'import { vi } from "vitest"; const cp: any = await vi.importActual("node:child_process"); cp.execSync("true");',
  'import * as expandedHelpers from "vitest";',
  'import expandedHelpers from "vitest";',
  'export { vi } from "vitest";',
])("rejects new foreign bindings from an unchanged reviewed module: %s", (extra) => {
  reset();
  const path = manifest.islands[0].paths[1];
  write(path, readFileSync(join(directory, path), "utf8") + "\n" + extra);
  const result = plan(save());
  expect(result.graphs.every((g) => g.complete)).toBe(true);
  expect(result.wouldRun.tier).toBe("full");
  expect(result.wouldRun.reasonCodes).toContain("unreviewed_execution_edge");
});

it.each([
  'it("probe", async () => await expect("synthetic").toMatchFileSnapshot("synthetic.snap"));',
  "const expanded = expect.getState;",
  "const expanded = it.extend;",
  'it["extend"]({});',
  "it.each`synthetic`;",
])("rejects new API capabilities without changing imports or bindings: %s", (extra) => {
  reset();
  const path = manifest.islands[0].paths[1];
  const original = readFileSync(join(directory, path), "utf8");
  const before = imports(original, path, manifest.islands[0].ambientReferences[path]);
  const after = imports(original + "\n" + extra, path, manifest.islands[0].ambientReferences[path]);
  expect(after.dependencies).toEqual(before.dependencies);
  expect(after.bindings).toEqual(before.bindings);
  write(path, original + "\n" + extra);
  const result = plan(save());
  expect(result.graphs.every((g) => g.complete)).toBe(true);
  expect(result.wouldRun.tier).toBe("full");
  expect(result.wouldRun.reasonCodes).toContain("unreviewed_execution_edge");
});

it.each([
  'it("probe", async () => { const now: any = expect("synthetic"); const { "toMatchFileSnapshot": getTime } = now; now.getTime = getTime; await now.getTime("synthetic.snap"); });',
  'const { "getState": now } = expect;',
  'it("probe", () => { let now: any; ({ "getState": now } = expect); });',
  'it("probe", () => { const [now] = [expect]; });',
  'it("probe", () => { let now: any; [now] = [expect]; });',
  'it("probe", async () => { const now: any = expect("synthetic"); for ({ "toMatchFileSnapshot": now.getTime } of [now]) { await now.getTime("synthetic.snap"); } });',
  'it("probe", async () => { const now: any = expect("synthetic"); for await ({ "toMatchFileSnapshot": now.getTime } of [now]) { await now.getTime("synthetic.snap"); } });',
  'it("probe", () => { const now: any = expect("synthetic"); for ({ "getState": now.getTime } in [now]) {} });',
  'it("probe", () => { const now: any = expect("synthetic"); for ([now.getTime] of [[now]]) {} });',
  'it("probe", () => { const now: any = expect("synthetic"); for ({ ["toMatchFileSnapshot"]: now.getTime } of [now]) {} });',
])("rejects destructuring boundaries hidden behind reviewed names: %s", (extra) => {
  reset();
  const path = manifest.islands[0].paths[1];
  const original = readFileSync(join(directory, path), "utf8");
  const before = imports(original, path, manifest.islands[0].ambientReferences[path]);
  const after = imports(original + "\n" + extra, path, manifest.islands[0].ambientReferences[path]);
  expect(after.dependencies).toEqual(before.dependencies);
  expect(after.bindings).toEqual(before.bindings);
  expect(after.callTargets).toEqual(before.callTargets);
  expect(after.memberReferences).toEqual(before.memberReferences);
  expect(after.unsafe).toBe(true);
  write(path, original + "\n" + extra);
  const head = save();
  const result = plan(head);
  expect(result.graphs.every((g) => g.complete)).toBe(true);
  expect(result.wouldRun.tier).toBe("full");
  expect(result.wouldRun.reasonCodes).toContain("unreviewed_execution_edge");
  expect(validatePlan(result, { repo: directory, base, head, candidate: head }, manifest)).toEqual(result);
});

it.each([
  [0, (text) => text.replace('return "just now";', 'return "a moment ago";')],
  [0, (text) => text.replace("const SECOND = 1000;", "const SECOND = 999;")],
  [0, (text) => text.replace("`${magnitude} ago`", "`${magnitude} earlier`")],
  [1, (text) => text.replace('"never renders three units"', '"uses two units"')],
])("permits only reviewed literal/wording edits: %s", (index, edit) => {
  reset();
  const path = manifest.islands[0].paths[index];
  const original = readFileSync(join(directory, path), "utf8");
  const candidate = edit(original);
  expect(candidate).not.toBe(original);
  write(path, candidate);
  const result = plan(save());
  expect(result.wouldRun.tier).toBe("targeted");
  expect(result.wouldRun.reasonCodes).not.toContain("unreviewed_structure");
});

it.each([
  "const additionalBinding = 1;",
  'it("probe", () => { for (const ms of [0]) expect(formatDuration(ms)).toBe("0ms"); });',
  'it("probe", () => { const now: any = expect("synthetic"); now.getTime = now.getTime; });',
])("forces full for unreviewed structure even with identical capability signatures: %s", (extra) => {
  reset();
  const path = manifest.islands[0].paths[1];
  const original = readFileSync(join(directory, path), "utf8");
  const allowed = manifest.islands[0].ambientReferences[path];
  const before = imports(original, path, allowed);
  const after = imports(original + "\n" + extra, path, allowed);
  expect(after.dependencies).toEqual(before.dependencies);
  expect(after.bindings).toEqual(before.bindings);
  expect(after.callTargets).toEqual(before.callTargets);
  expect(after.memberReferences).toEqual(before.memberReferences);
  expect(after.unsafe).toBe(false);
  expect(after.structureHash).not.toBe(before.structureHash);
  write(path, original + "\n" + extra);
  const result = plan(save());
  expect(result.wouldRun.tier).toBe("full");
  expect(result.wouldRun.reasonCodes).toContain("unreviewed_structure");
});

it.each([
  (text) => text.replace("const SECOND = 1000;", "let SECOND = 1000;"),
  (text) => text.replace("delta > 0", "delta >= 0"),
  (text) => "// @ts-nocheck\n" + text,
  (text) => '/// <reference path="./unreviewed.d.ts" />\n' + text,
])("retains semantic flags/operators and compiler directives in the structural invariant", (edit) => {
  reset();
  const path = manifest.islands[0].paths[0];
  const original = readFileSync(join(directory, path), "utf8");
  const candidate = edit(original);
  expect(candidate).not.toBe(original);
  write(path, candidate);
  const result = plan(save());
  expect(result.wouldRun.tier).toBe("full");
  expect(result.wouldRun.reasonCodes).toContain("unreviewed_structure");
});

it.each(["// @vitest-environment node\n", "// Inert comments are conservatively frozen too.\n", "\n"])(
  "forces full for all changes outside approved literal spans",
  (prefix) => {
    reset();
    const path = manifest.islands[0].paths[1];
    write(path, prefix + readFileSync(join(directory, path), "utf8"));
    const result = plan(save());
    expect(result.wouldRun.tier).toBe("full");
    expect(result.wouldRun.reasonCodes).toContain("unreviewed_structure");
  },
);

it.each(['"@vitest-environment node"', '"wording\\nwith another line"'])(
  "forces full for literal values outside the reviewed one-line wording alphabet",
  (literal) => {
    reset();
    const path = manifest.islands[0].paths[1];
    const original = readFileSync(join(directory, path), "utf8");
    write(path, original.replace('"never renders three units"', literal));
    const result = plan(save());
    expect(result.wouldRun.tier).toBe("full");
    expect(result.wouldRun.reasonCodes).toContain("unreviewed_structure");
  },
);

it("falls back for stale metadata, empty diffs, explicit override and mixed-risk changes", () => {
  reset();
  expect(plan(base).wouldRun.reasonCodes).toContain("empty_change_set");
  write(
    manifest.islands[0].paths[0],
    wording(manifest.islands[0].paths[0], readFileSync(join(directory, manifest.islands[0].paths[0]), "utf8")),
  );
  const head = save();
  expect(plan(head, { forceFull: true }).wouldRun.reasonCodes).toContain("force_full");
  const stale = { ...manifest, reviewedInventoryHash: "0".repeat(64) };
  expect(createPlan({ repo: directory, base, head, candidate: head }, stale).wouldRun.tier).toBe("full");
  write("packages/daemon/src/index.ts", "/** Sensitive mixed change. */\n");
  expect(plan(save()).wouldRun.tier).toBe("full");
});

it("rejects unavailable/abbreviated bases and unrelated candidates without a green artifact", () => {
  reset();
  for (const invalid of ["HEAD", "d3491cc", "f".repeat(40), "--help"])
    expect(() => plan(base, { base: invalid })).toThrow();
  const file = manifest.islands[0].paths[0];
  write(file, wording(file, readFileSync(join(directory, file), "utf8")));
  const head = save();
  expect(() => plan(head, { candidate: base })).toThrow();
  let failure;
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "tools/ci-shadow/cli.js"),
        "plan",
        "--repo",
        directory,
        "--base",
        "HEAD",
        "--head",
        head,
        "--candidate",
        head,
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (error) {
    failure = error;
  }
  expect(failure?.status).toBe(1);
  expect(failure?.stdout).toBe("");
});

it("includes base-only merge-candidate changes and rejects reuse on a moved base", () => {
  reset();
  const file = manifest.islands[0].paths[0];
  write(file, wording(file, readFileSync(join(directory, file), "utf8")));
  const head = save();
  const old = plan(head);
  reset();
  write("packages/daemon/src/index.ts", "/** Main moved independently. */\n");
  const movedBase = save();
  command("merge", "--no-ff", "-qm", "synthetic merge candidate", head);
  const candidate = command("rev-parse", "HEAD");
  const input = { repo: directory, base: movedBase, head, candidate };
  const merged = createPlan(input, manifest);
  expect(merged.identities.mergeBase).toBe(base);
  expect(merged.wouldRun.tier).toBe("full");
  expect(
    merged.changes.some((entry) => entry.origin === "merge-candidate" && entry.path === "packages/daemon/src/index.ts"),
  ).toBe(true);
  expect(() => validatePlan(old, input, manifest)).toThrow();
});

it("parses NUL records and refuses truncated/malformed status, unsafe paths and invalid UTF-8", () => {
  expect(parseChanges(Buffer.from("R100\0old path\0new path\0D\0gone\0"), "pr-head")).toEqual([
    { origin: "pr-head", status: "R100", path: "new path", oldPath: "old path" },
    { origin: "pr-head", status: "D", path: "gone", oldPath: "gone" },
  ]);
  for (const data of [
    Buffer.from("M\0file"),
    Buffer.from("R100\0old\0"),
    Buffer.from("Q\0file\0"),
    Buffer.from([255, 0]),
  ])
    expect(() => parseChanges(data, "pr-head")).toThrow();
  for (const path of ["../bad", "/bad", "a/../b", "a\\b", "a\nb", "a\tb", "a//b", "-flag"])
    expect(validPath(path)).toBe(false);
  expect(imports('import("./x" + variable);', "test.ts").unsafe).toBe(true);
});

it("records malformed changed paths and incomplete/empty discovery as full", () => {
  reset();
  write("docs/new\nfile.md", "prose\n");
  expect(plan(save()).wouldRun.reasonCodes).toContain("malformed_path");
  reset();
  write("packages/app/renderer/src/unmapped.ts", 'import "./absent.js";\n');
  expect(plan(save()).graphs[1].complete).toBe(false);
  reset();
  for (const path of graph(snapshot(directory, base), manifest).tests) rmSync(join(directory, path));
  expect(plan(save()).wouldRun.reasonCodes).toContain("empty_test_discovery");
});

it("treats mode changes and stale selector sources as full", () => {
  reset();
  const file = manifest.islands[0].paths[0];
  chmodSync(join(directory, file), 0o755);
  command("update-index", "--chmod=+x", file);
  command("commit", "-qm", "synthetic executable mode change");
  expect(plan().wouldRun.reasonCodes).toContain("structural_mode_change");
  reset();
  write("tools/ci-shadow/cli.js", "/** Untrusted changed selector. */\n");
  const result = plan(save());
  expect(result.wouldRun.tier).toBe("full");
  expect(result.wouldRun.reasonCodes).toContain("stale_selector_source");
});

it("keeps a seeded failing app-side consumer in the selection and refuses its success claim", () => {
  reset();
  const file = manifest.islands[0].paths[0];
  write(file, wording(file, readFileSync(join(directory, file), "utf8")));
  const result = plan(save());
  const seededPath = "packages/app/test/source-reader.test.ts";
  expect(result.wouldRun.vitestFiles).toContain(seededPath);
  const report = {
    candidate: result.identities.candidate,
    node: 22,
    lane: "suite",
    success: true,
    files: result.wouldRun.vitestFiles.map((path) => ({
      path,
      status: path === seededPath ? "failed" : "passed",
      passed: 1,
      failed: path === seededPath ? 1 : 0,
      skipped: 0,
    })),
  };
  expect(() => validateExecution(result, report)).toThrow();
});

it("rejects malformed manifests and unreviewed prose eligibility", () => {
  reset();
  for (const change of [
    (copy) => {
      copy.schemaVersion = 99;
    },
    (copy) => {
      copy.graphVersion = 99;
    },
    (copy) => {
      copy.prosePaths.push("packages/core/src/index.ts");
    },
    (copy) => {
      copy.islands[0].paths.push("packages/app/renderer/src/authority.ts");
    },
    (copy) => {
      copy.fullRiskRules[0].pattern = "[";
    },
  ]) {
    const copy = structuredClone(manifest);
    change(copy);
    expect(() => createPlan({ repo: directory, base, head: base, candidate: base }, copy)).toThrow();
  }
});

it("rejects missing/duplicate/failed/skipped file results and stale result identity", () => {
  reset();
  const result = plan(base);
  const report = {
    candidate: base,
    node: 24,
    lane: "suite",
    success: true,
    files: result.wouldRun.vitestFiles.map((path) => ({ path, status: "passed", passed: 1, failed: 0, skipped: 0 })),
  };
  expect(validateExecution(result, report).selectedFilesPassed).toBe(report.files.length);
  for (const mutate of [
    (copy) => {
      copy.candidate = "0".repeat(40);
    },
    (copy) => {
      copy.node = 20;
    },
    (copy) => {
      copy.success = false;
    },
    (copy) => {
      copy.files.pop();
    },
    (copy) => {
      copy.files.push(copy.files[0]);
    },
    (copy) => {
      copy.files[0].skipped = 1;
    },
    (copy) => {
      copy.files[0].failed = 1;
    },
    (copy) => {
      copy.files[0].passed = 0;
    },
    (copy) => {
      copy.files[0].status = "cancelled";
    },
  ]) {
    const copy = structuredClone(report);
    mutate(copy);
    expect(() => validateExecution(result, copy)).toThrow();
  }
  const retry = {
    ...report,
    lane: "retry",
    files: [
      "packages/cli/test/admission-retry-wiring.test.ts",
      "packages/integrations/test/admission-retry-acp.test.ts",
    ].map((path) => ({ path, status: "passed", passed: 1, failed: 0, skipped: 0 })),
  };
  expect(validateExecution(result, retry).selectedFilesPassed).toBe(2);
  retry.files[0].skipped = 1;
  expect(() => validateExecution(result, retry)).toThrow();
  expect(digest(canonical(result))).toMatch(/^[a-f0-9]{64}$/);
});
