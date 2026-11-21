/** The local lint rule that keeps sleeps, retries and untracked skips out of tests (#863). */
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../eslint-config/rules/no-flaky-test-waits.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } }).run("no-flaky-test-waits", rule, {
  valid: [
    "await expect(page.locator('.x')).toBeVisible();",
    "it.skipIf(process.platform === 'win32')('name', () => {});",
    "describe.runIf(ok)('name', () => {});",
    "it.todo('pending acceptance');",
    "export default { retries: 0 };",
    "const config = { test: { retry: 0 } };",
    "f({ retries: options.claims });",
    "// quarantine: #123 fails on arm64 until the driver is fixed\nit.skip('name', () => {});",
    "// quarantine: #9 tracked\ntest.describe.skip('name', () => {});",
    "page.waitForSelector('.x');",
    "it.each([1, 2])('n %i', () => {});",
    "test.describe.parallel('name', () => {});",
    "it.concurrent.each([1])('n %i', () => {});",
    "// quarantine: #7 tracked\nit.skip.each([1, 2])('n %i', () => {});",
    "obj.skip.only();",
  ],
  invalid: [
    { code: "await page.waitForTimeout(500);", errors: [{ messageId: "sleep" }] },
    { code: "export default { retries: 2 };", errors: [{ messageId: "retries" }] },
    { code: "const c = { test: { retry: 1 } };", errors: [{ messageId: "retries" }] },
    { code: "it.skip('name', () => {});", errors: [{ messageId: "skip" }] },
    { code: "// flaky\ntest.fixme('name', () => {});", errors: [{ messageId: "skip" }] },
    { code: "// quarantine: no issue\ndescribe.skip('name', () => {});", errors: [{ messageId: "skip" }] },
    { code: "// quarantine: #12 why\n\nit.skip('blank line between', () => {});", errors: [{ messageId: "skip" }] },
    { code: "it.only('name', () => {});", errors: [{ messageId: "only" }] },
    // Chained and parameterized modifiers: the helper reads the whole member chain.
    { code: "it.only.each([1, 2])('n %i', () => {});", errors: [{ messageId: "only" }] },
    { code: "describe.only.each([1])('n %i', () => {});", errors: [{ messageId: "only" }] },
    { code: "test.describe.only('name', () => {});", errors: [{ messageId: "only" }] },
    { code: "it.concurrent.only('name', () => {});", errors: [{ messageId: "only" }] },
    { code: "it.skip.each([1, 2])('n %i', () => {});", errors: [{ messageId: "skip" }] },
    { code: "test.skip.each`a | b`('n', () => {});", errors: [{ messageId: "skip" }] },
    { code: "describe.skip.each([1])('n %i', () => {});", errors: [{ messageId: "skip" }] },
    { code: "test.describe.fixme('name', () => {});", errors: [{ messageId: "skip" }] },
  ],
});
