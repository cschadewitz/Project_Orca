/** Exercise the actual CI classifier without touching Git history or running its check matrix. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const coreRequire = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const { parse } = coreRequire("yaml");
const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const script = workflow.jobs.changes.steps.find((step) => step.id === "classify").run;
const fakeGit = `git() {
  if [ "$1" = cat-file ]; then
    [ "$BASE_AVAILABLE" = true ]
  elif [ "$1" = diff ]; then
    printf '%s\\n' "$CHANGED_PATHS"
  else
    return 2
  fi
}
`;

it.each([
  ["documentation validator", "docs/preparation/owned-root-candidate-49efcc7/validate-documentation.mjs", true],
  ["proposal validator", "docs/preparation/owned-root-candidate-49efcc7/validate-proposal.mjs", true],
  ["plain JavaScript in docs", "docs/example.js", true],
  ["CommonJS in docs", "docs/example.cjs", true],
  ["JSX in docs", "docs/example.jsx", true],
  ["mixed documentation and code", "docs/guide.md\ndocs/example.mjs", true],
  ["prose and evidence only", "README.md\ndocs/guide.md\ndocs/build.log\ndocs/proposal.yaml", false],
  ["Markdown about JavaScript", "docs/example.js.md", false],
  ["runtime prompt template", "templates/task.md", true],
  ["TypeScript source", "packages/core/src/index.ts", true],
  ["unknown base", "docs/guide.md", true, false],
])("classifies %s", (_label, paths, expected, baseAvailable = true) => {
  const directory = mkdtempSync(join(tmpdir(), "orca-ci-classification-"));
  const output = join(directory, "output.txt");
  try {
    execFileSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", fakeGit + script], {
      env: {
        ...process.env,
        BASH_ENV: "",
        ENV: "",
        BASE: "fixture-base",
        HEAD: "fixture-head",
        BASE_AVAILABLE: String(baseAvailable),
        CHANGED_PATHS: paths,
        GITHUB_OUTPUT: output.replaceAll("\\", "/"),
      },
      timeout: 10000,
    });
    expect(readFileSync(output, "utf8").trim()).toBe(`code=${expected}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
