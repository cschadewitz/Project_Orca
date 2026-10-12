/** Exercise the actual positive docs classifier over immutable Git histories, including both rename paths. */
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, expect, it } from "vitest";
import { docsOnly, DOCS_PATH, loadDocs } from "../ci-shadow/docs.js";
import { checkDocumentation } from "../ci-shadow/check-docs.js";
import { createGitFixture } from "./git-fixture.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
let fixture;
let repo;
let base;
const command = (...args) => fixture.command(...args);
const write = (path, content) => fixture.write(path, content);
const save = () => fixture.save();
const reset = () => fixture.reset(base);
const input = () => {
  const head = save();
  return { repo, base, head, candidate: head };
};
beforeAll(() => {
  fixture = createGitFixture({ prefix: "orca-ci-docs-", message: "classification fixture" });
  repo = fixture.directory;
  for (const path of [DOCS_PATH, "tools/ci-shadow/docs.js", "tools/ci-shadow/git.js"])
    write(path, readFileSync(join(root, path)));
  for (const path of [
    "README.md",
    "docs/DEVELOPMENT.md",
    "docs/daemon-security.md",
    "changelog.d/README.md",
    "packages/engine/test/example.test.ts",
    "packages/engine/src/reader.ts",
  ])
    write(path, path.endsWith(".md") ? "# Existing prose\n" : "/** Existing source. */\n");
  base = save();
});
afterAll(() => fixture?.remove());

it.each(["README.md", "docs/DEVELOPMENT.md", "changelog.d/README.md"])(
  "avoids both expensive runtime suites for audited ordinary %s",
  (path) => {
    reset();
    write(
      path,
      "# Corrected prose\n[Existing doc](docs/DEVELOPMENT.md)\n".replace(
        "(docs/",
        path.includes("/") ? "(../docs/" : "(docs/",
      ),
    );
    const change = input();
    expect(docsOnly(change)).toBe(true);
    expect(checkDocumentation(change)).toContain(path);
  },
);
it.each([
  "docs/daemon-security.md",
  "docs/unknown.md",
  "docs/preparation/contract.md",
  "docs/preparation/validator.mjs",
  "templates/task.md",
  "changelog.d/99-added.added.md",
  "tools/ci-shadow/docs.js",
  DOCS_PATH,
  "packages/engine/src/reader.ts",
  "packages/engine/src/new-reader.ts",
  ".github/workflows/ci.yml",
])("retains runtime checks for consumed/unknown/consumer/classifier input %s", (path) => {
  reset();
  write(path, "changed\n");
  expect(docsOnly(input())).toBe(false);
});
it("does not turn a mixed docs/code change into docs-only", () => {
  reset();
  write("README.md", "Updated\n");
  write("packages/engine/src/reader.ts", "changed\n");
  expect(docsOnly(input())).toBe(false);
});
it.each(["README.md", "docs/daemon-security.md", "packages/engine/test/example.test.ts"])(
  "keeps deleted %s full",
  (path) => {
    reset();
    command("rm", path);
    expect(docsOnly(input())).toBe(false);
  },
);
it.each([
  ["packages/engine/test/example.test.ts", "docs/new-test.md"],
  ["packages/engine/test/example.test.ts", "README.md"],
  ["docs/daemon-security.md", "docs/new-security.md"],
  ["README.md", "docs/new-readme.md"],
])("keeps both rename paths from %s to %s full", (from, to) => {
  reset();
  command("mv", "-f", from, to);
  expect(docsOnly(input())).toBe(false);
});
it("rejects new inventoried destinations, unknown bases and mode changes", () => {
  reset();
  write("docs/ARCHITECTURE.md", "New file\n");
  expect(docsOnly(input())).toBe(false);
  reset();
  chmodSync(join(repo, "README.md"), 0o755);
  expect(docsOnly(input())).toBe(false);
  expect(() => docsOnly({ repo, base: "0".repeat(40), head: base, candidate: base })).toThrow();
});
it.each(["# Broken\n[Missing](no-such-file.md)\n", "# Broken\n```ts\n", "# Trailing  \n", "# CRLF\r\n"])(
  "blocks malformed prose or local links",
  (text) => {
    reset();
    write("README.md", text);
    expect(() => checkDocumentation(input())).toThrow();
  },
);
it("positive inventory excludes all known consumed prose scopes rather than accepting arbitrary Markdown", () => {
  const paths = loadDocs().paths;
  expect(paths.length).toBeGreaterThan(50);
  expect(paths).toContain("changelog.d/README.md");
  expect(paths).not.toContain("docs/daemon-security.md");
  expect(paths.some((path) => path.startsWith("docs/preparation/") || path.startsWith("templates/"))).toBe(false);
});
