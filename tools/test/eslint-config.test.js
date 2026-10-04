/** Keep plain-JS CLI validators linted without weakening the TypeScript project rules. */
import { ESLint } from "eslint";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const eslint = new ESLint();

it.each(["validate-documentation.mjs", "validate-proposal.mjs"])(
  "lints %s and permits its CLI output",
  async (name) => {
    const results = await eslint.lintText('/** CLI validation result. */\nconsole.log("PASS");\n', {
      filePath: `docs/preparation/owned-root-candidate-49efcc7/${name}`,
    });
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  },
);

it.each(["js", "mjs", "cjs"])("keeps ordinary .%s modules linted with the console rule", async (extension) => {
  const results = await eslint.lintText('/** Ordinary module. */\nconsole.log("unexpected");\n', {
    filePath: `docs/example.${extension}`,
  });
  expect(results.flatMap((result) => result.messages.map((message) => message.ruleId))).toEqual(["no-console"]);
});

it("retains type-aware checks for TypeScript", async () => {
  const filePath = "packages/core/src/index.ts";
  const config = await eslint.calculateConfigForFile(filePath);
  expect(config.languageOptions.parserOptions.project).toBe("./tsconfig.json");
  expect(config.rules["@typescript-eslint/no-floating-promises"][0]).toBe(2);
  // CI's single-run parser reads the project's source files from disk. lintText with
  // replacement text for a real barrel instead checks that barrel's original AST.
  // Use real, temporary files included by the unchanged repository TS project.
  const directory = mkdtempSync(new URL("../../packages/core/test/eslint-config-", import.meta.url));
  const unhandled = join(directory, "unhandled.ts");
  const handled = join(directory, "handled.ts");
  try {
    writeFileSync(unhandled, "/** Unhandled asynchronous work. */\nPromise.resolve();\n");
    writeFileSync(handled, "/** Explicitly handled asynchronous work. */\nvoid Promise.resolve();\n");
    const results = await eslint.lintFiles([unhandled, handled]);
    const messagesFor = (path) => results.find((result) => result.filePath === path).messages;
    expect(messagesFor(unhandled).map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/no-floating-promises",
    ]);
    expect(messagesFor(handled)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
