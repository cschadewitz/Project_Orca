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
  ["plain prose only", "README.md\ndocs/guide.md", true],
  ["consumed prepared-root JSON", "docs/preparation/trusted-prepared-roots/fixtures/synthetic-v1.json", true],
  ["unknown Python in docs", "docs/helper.py", true],
  ["unknown shell in docs", "docs/helper.sh", true],
  ["unknown evidence log in docs", "docs/build.log", true],
  ["unknown YAML in docs", "docs/proposal.yaml", true],
  ["consumed preparation Markdown", "docs/preparation/contract.md", true],
  ["Markdown about JavaScript", "docs/example.js.md", true],
  ["consumed daemon permission matrix", "docs/daemon-security.md", true],
  ["consumed documentation outside docs", "packages/protocol/README.md", true],
  ["unknown Markdown", "docs/unknown.md", true],
  ["test renamed to Markdown, destination only", "packages/app/renderer/test/format-time.md", true],
  [
    "test renamed to Markdown, both paths",
    "packages/app/renderer/test/format-time.test.tsx\npackages/app/renderer/test/format-time.md",
    true,
  ],
  ["code renamed into docs", "packages/core/src/index.ts\ndocs/source.md", true],
  ["Markdown renamed to a new test", "docs/guide.md\npackages/app/renderer/test/guide.test.tsx", true],
  ["deleted test", "packages/app/renderer/test/format-time.test.tsx", true],
  ["deleted consumed documentation", "docs/daemon-security.md", true],
  ["consumed documentation renamed, destination only", "docs/renamed-security.md", true],
  ["consumed documentation renamed, both paths", "docs/daemon-security.md\ndocs/renamed-security.md", true],
  ["deleted unknown Markdown", "docs/unknown.md", true],
  ["empty or unavailable diff", "", true],
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
