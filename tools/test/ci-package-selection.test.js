/** Package-policy regression probes over real Git histories: package closure, non-import triggers and exact runtime reports. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { git } from "../ci-shadow/git.js";
import { TOOL_PATHS, MANIFEST_PATH } from "../ci-shadow/graph.js";
import { createPlan, loadManifest, validatePlan } from "../ci-shadow/selector.js";
import { executionPlan, runSelected } from "../ci-shadow/execute.js";
import { INTENTIONAL_SKIPS } from "../ci-shadow/evidence.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
let repo, base, manifest;
const command = (...args) => git(repo, args).toString().trim();
const write = (path, content) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const save = () => {
  command("add", "-A");
  command("commit", "-qm", "package fixture");
  return command("rev-parse", "HEAD");
};
const reset = () => {
  command("checkout", "--detach", base);
  command("clean", "-fdq");
};
const candidate = () => {
  const head = save();
  const merge = git(repo, ["commit-tree", `${head}^{tree}`, "-p", base, "-p", head], "candidate\n")
    .toString()
    .trim();
  command("checkout", "--detach", merge);
  return { repo, base, head, candidate: merge };
};
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "orca-ci-packages-"));
  command("init", "-q");
  command("config", "user.name", "CI fixture");
  command("config", "user.email", "ci@example.invalid");
  manifest = loadManifest();
  manifest.edges = [];
  manifest.runners = [];
  for (const path of TOOL_PATHS) write(path, readFileSync(join(root, path)));
  write(MANIFEST_PATH, JSON.stringify(manifest));
  for (const [name, dependencies] of Object.entries({
    engine: {},
    cli: { "@orca/engine": "workspace:*" },
    app: {},
    core: {},
    integrations: {},
  })) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({ name: `@orca/${name}`, type: "module", exports: "./src/index.ts", dependencies }),
    );
    write(`packages/${name}/src/index.ts`, "/** Domain source. */\nexport const value = 1;\n");
    write(`packages/${name}/test/domain.test.ts`, "/** Domain tests. */\n");
  }
  for (const { path } of INTENTIONAL_SKIPS) write(path, "/** Independently reviewed opt-in case. */\n");
  write("tools/test/changelog.test.js", "/** Release-fragment consumer assertions. */\n");
  write("README.md", "# Prose\n");
  write("docs/daemon-security.md", "# Consumed matrix\n");
  base = save();
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

it.each([24])("selects engine plus downstream CLI domains on Node %s, without unrelated app tests", (node) => {
  reset();
  write("packages/engine/src/index.ts", "/** Changed feature behavior. */\nexport const value = 2;\n");
  const input = candidate();
  const result = executionPlan(input, "pull_request", node, manifest);
  expect(result.mode).toBe("targeted");
  expect(result.plan.graphs.every((entry) => entry.complete)).toBe(true);
  expect(result.plan.wouldRun.vitestFiles).toEqual([
    "packages/cli/test/domain.test.ts",
    "packages/engine/test/domain.test.ts",
  ]);
  expect(executionPlan(input, "push", node, manifest).mode).toBe("full");
  const artifact = join(repo, "plan.json"),
    report = join(repo, "result.json");
  writeFileSync(artifact, JSON.stringify(result.plan));
  const run = (_binary, args) => {
    expect(args).toContain("--maxWorkers=1");
    const files = result.plan.wouldRun.vitestFiles;
    writeFileSync(
      report,
      JSON.stringify({
        success: true,
        numTotalTests: files.length,
        numPassedTests: files.length,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: files.map((path) => ({
          name: join(repo, path),
          status: "passed",
          assertionResults: [{ status: "passed", fullName: "domain behavior" }],
        })),
      }),
    );
    return { status: 0 };
  };
  expect(runSelected(input, artifact, report, 1, run, manifest, node)).toMatchObject({
    candidate: input.candidate,
    node,
    selectedFilesPassed: 2,
  });
  const stale = structuredClone(result.plan);
  stale.wouldRun.vitestFiles.pop();
  writeFileSync(artifact, JSON.stringify(stale));
  expect(() => runSelected(input, artifact, report, 1, run, manifest, node)).toThrow(
    "stale_mismatched_or_modified_plan",
  );
});
it("includes new tests and deletes removed tests inside affected package domains", () => {
  reset();
  write("packages/engine/test/new.test.ts", "/** New behavior. */\n");
  const added = createPlan(candidate(), manifest);
  expect(added.wouldRun.tier).toBe("targeted");
  expect(added.wouldRun.vitestFiles).toContain("packages/engine/test/new.test.ts");
  reset();
  command("rm", "packages/engine/test/domain.test.ts");
  const removed = createPlan(candidate(), manifest);
  expect(removed.wouldRun.tier).toBe("targeted");
  expect(removed.wouldRun.vitestFiles).not.toContain("packages/engine/test/domain.test.ts");
  expect(removed.wouldRun.vitestFiles).toContain("packages/cli/test/domain.test.ts");
});
it.each([
  ["packages/core/src/index.ts", "export const value = 2;"],
  ["packages/engine/src/index.ts", 'import "./missing.js";'],
  ["packages/engine/src/index.ts", 'import { readFileSync } from "node:fs"; readFileSync("README.md");'],
  ["packages/engine/src/index.ts", 'import("./index.js");'],
  ["packages/engine/src/index.ts", 'import { readFileSync as load } from "node:fs"; load("README.md");'],
  ["packages/engine/src/index.ts", "process.env.ORCA_FEATURE;"],
  ["packages/engine/src/index.ts", 'process["env"].ORCA_FEATURE;'],
  ["packages/engine/src/index.ts", "const load = require; load('external-plugin');"],
  ["packages/engine/test/pending.test.ts", 'import { it } from "vitest"; it.todo("unbound acceptance");'],
  ["packages/engine/src/auth.ts", "export const secret = 2;"],
  ["packages/engine/package.json", '{"name":"@orca/engine","dependencies":{}}'],
  ["docs/daemon-security.md", "changed permission row"],
  ["docs/unknown.md", "new prose"],
  ["templates/prompt.md", "changed executable input"],
  ["packages/integrations/test/jev-eval.live.test.ts", "changed opt-in assertions"],
])("retains full checks for shared/non-import/uncertain input %s", (path, text) => {
  reset();
  write(path, path.endsWith(".json") ? `${text}\n` : `/** Changed input. */\n${text}\n`);
  const input = candidate();
  expect(createPlan(input, manifest).wouldRun.tier).toBe("full");
  expect(executionPlan(input, "pull_request", 24, manifest).mode).toBe("full");
});
it("selects real changelog checks for consumed release fragments and CSS package domains", () => {
  reset();
  write("changelog.d/123-feature.added.md", "- **engine:** new feature.\n");
  expect(createPlan(candidate(), manifest).wouldRun.vitestFiles).toEqual(["tools/test/changelog.test.js"]);
  reset();
  write("packages/app/renderer/src/form.css", "/** Form layout. */\n.form { display: block; }\n");
  expect(createPlan(candidate(), manifest).wouldRun.vitestFiles).toEqual(["packages/app/test/domain.test.ts"]);
});

it("audited new package README inputs retain whole-domain tests, while unknown Markdown stays full", () => {
  reset();
  write("packages/app/renderer/src/config/structured-form/README.md", "# Audited integration handoff\n");
  const plan = createPlan(candidate(), manifest);
  expect(plan.wouldRun.tier).toBe("targeted");
  expect(plan.wouldRun.vitestFiles).toEqual(["packages/app/test/domain.test.ts"]);
  reset();
  write("packages/app/renderer/src/unknown.md", "# Unknown input\n");
  expect(createPlan(candidate(), manifest).wouldRun.tier).toBe("full");
});
it("test fixture I/O selects its entire domain and downstream consumers without ignoring runtime readers", () => {
  reset();
  write(
    "packages/engine/test/fixture.ts",
    'import { readFileSync } from "node:fs";\nreadFileSync("synthetic.json");\n',
  );
  const plan = createPlan(candidate(), manifest);
  expect(plan.wouldRun.tier).toBe("targeted");
  expect(plan.wouldRun.vitestFiles).toEqual([
    "packages/cli/test/domain.test.ts",
    "packages/engine/test/domain.test.ts",
  ]);
});

it("proposes an explicit prose verdict with no invented full-suite evidence", () => {
  reset();
  write("README.md", "# Ordinary narrative correction\n");
  const input = candidate();
  const plan = createPlan(input, manifest);
  expect(plan.wouldRun.tier).toBe("docs");
  expect(plan.wouldRun.vitestFiles).toEqual([]);
  validatePlan(plan, input, manifest);
});
it("test-to-doc rename and mixed consumed doc/source retain full checks", () => {
  reset();
  command("mv", "packages/engine/test/domain.test.ts", "docs/new-test.md");
  expect(createPlan(candidate(), manifest).wouldRun.tier).toBe("full");
  reset();
  write("packages/engine/src/index.ts", "/** Feature. */\nexport const value = 3;\n");
  write("docs/daemon-security.md", "changed\n");
  expect(createPlan(candidate(), manifest).wouldRun.tier).toBe("full");
});

it("does not hide test renames in audited README/release paths or prose mode changes in mixed changes", () => {
  for (const destination of [
    "packages/app/renderer/src/config/structured-form/README.md",
    "changelog.d/123-feature.added.md",
  ]) {
    reset();
    write(destination, "temporary\n");
    command("mv", "-f", "packages/engine/test/domain.test.ts", destination);
    expect(createPlan(candidate(), manifest).wouldRun.tier).toBe("full");
  }
  reset();
  chmodSync(join(repo, "README.md"), 0o755);
  write("packages/engine/src/index.ts", "/** Feature. */\nexport const value = 2;\n");
  expect(createPlan(candidate(), manifest).wouldRun.tier).toBe("full");
});
