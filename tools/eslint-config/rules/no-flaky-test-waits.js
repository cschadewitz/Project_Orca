// Encodes the test-waiting rules in docs/DEVELOPMENT.md ("Flaky tests are fixed, not
// waited out"), adopted from T3 Code's lint-enforced testing rules (#863):
//
// - no fixed sleeps: `waitForTimeout(...)` passes on a fast machine and fails on a slow one;
//   wait for the thing itself (`expect.poll`, a locator, an event);
// - no automatic retries: a `retries` or `retry` option above 0 hides a flaky test instead
//   of failing it;
// - no silent skips: `it.skip`, `test.skip`, `describe.skip` and `.fixme` need a
//   `// quarantine: #<issue> <why>` comment on the line above, so every skipped test has an
//   issue that tracks bringing it back. Conditional skips (`skipIf`, `runIf`) and `todo`
//   are not quarantines and are left alone; `.only` is refused outright.

const TEST_OBJECTS = new Set(["it", "test", "describe", "suite"]);
const SKIPS = new Set(["skip", "fixme"]);
const QUARANTINE = /^\s*quarantine:\s*#\d+\s+\S/;

/** `it.skip`, `test.describe.skip`, `describe.only` … as the property name, or null. */
function testModifier(callee) {
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return null;
  let object = callee.object;
  while (object.type === "MemberExpression" && !object.computed) object = object.object;
  return object.type === "Identifier" && TEST_OBJECTS.has(object.name) ? callee.property.name : null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Forbid fixed sleeps, automatic retries and untracked skips in tests." },
    schema: [],
    messages: {
      sleep:
        "No fixed sleeps in tests: wait for the condition itself (a locator, expect.poll, an event). See docs/DEVELOPMENT.md.",
      retries: "No automatic retries: a flaky test is fixed, not retried. See docs/DEVELOPMENT.md.",
      only: "Remove `.only` before committing.",
      skip: "A skipped test needs `// quarantine: #<issue> <why>` on the line above it.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "waitForTimeout"
        ) {
          context.report({ node, messageId: "sleep" });
          return;
        }
        const modifier = testModifier(callee);
        if (modifier === "only") context.report({ node, messageId: "only" });
        if (modifier && SKIPS.has(modifier)) {
          const above = source
            .getCommentsBefore(node)
            .filter((comment) => comment.loc.end.line === node.loc.start.line - 1);
          if (!above.some((comment) => QUARANTINE.test(comment.value))) context.report({ node, messageId: "skip" });
        }
      },
      Property(node) {
        const key =
          node.key.type === "Identifier" ? node.key.name : node.key.type === "Literal" ? node.key.value : null;
        if (key !== "retries" && key !== "retry") return;
        if (node.value.type === "Literal" && typeof node.value.value === "number" && node.value.value > 0)
          context.report({ node, messageId: "retries" });
      },
    };
  },
};
