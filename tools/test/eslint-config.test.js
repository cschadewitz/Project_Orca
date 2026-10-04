/** Keep plain-JS CLI validators linted without weakening the TypeScript project rules. */
import { ESLint } from "eslint";
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
  const results = await eslint.lintText("/** Unhandled asynchronous work. */\nPromise.resolve();\n", { filePath });
  expect(results.flatMap((result) => result.messages.map((message) => message.ruleId))).toContain(
    "@typescript-eslint/no-floating-promises",
  );
});
