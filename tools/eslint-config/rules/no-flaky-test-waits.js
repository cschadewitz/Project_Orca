// Encodes the test-waiting rules in docs/DEVELOPMENT.md ("Flaky tests are fixed, not
// waited out"), adopted from T3 Code's lint-enforced testing rules (#863):
//
// - no fixed sleeps: `waitForTimeout(...)` passes on a fast machine and fails on a slow one;
//   wait for the thing itself (`expect.poll`, a locator, an event);
// - no automatic retries: a `retries` or `retry` option above 0 hides a flaky test instead
//   of failing it;
// - no silent skips: `it.skip`, `test.skip`, `describe.skip` and `.fixme` (also chained,
//   as in `it.skip.each`) need a
//   `// quarantine: #<issue> <why>` comment on the line above, so every skipped test has an
//   issue that tracks bringing it back. Conditional skips (`skipIf`, `runIf`) and `todo`
//   are not quarantines and are left alone; `.only` is refused outright.

const TEST_OBJECTS = new Set(["it", "test", "describe", "suite"]);
const SKIPS = new Set(["skip", "fixme"]);
const QUARANTINE = /^\s*quarantine:\s*#\d+\s+\S/;

/**
 * Every property in a test call's member chain (`it.skip.each` gives `skip` and `each`,
 * `test.describe.only` gives `describe` and `only`), or an empty set when the chain does not
 * start at a test object. All of them, not the last: a parameterized `.only.each` or
 * `.skip.each` ends in `each`.
 */
function testModifiers(callee) {
  const names = new Set();
  let object = callee;
  while (object.type === "MemberExpression") {
    if (object.computed || object.property.type !== "Identifier") return new Set();
    names.add(object.property.name);
    object = object.object;
  }
  return object.type === "Identifier" && TEST_OBJECTS.has(object.name) && names.size > 0 ? names : new Set();
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
    function checkModifiers(node, chain) {
      const modifiers = testModifiers(chain);
      if (modifiers.has("only")) context.report({ node, messageId: "only" });
      if ([...modifiers].some((name) => SKIPS.has(name))) {
        const above = source
          .getCommentsBefore(node)
          .filter((comment) => comment.loc.end.line === node.loc.start.line - 1);
        if (!above.some((comment) => QUARANTINE.test(comment.value))) context.report({ node, messageId: "skip" });
      }
    }
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
        checkModifiers(node, callee);
      },
      // `test.skip.each\`a | b\`(...)`: the table form tags a template instead of calling.
      TaggedTemplateExpression(node) {
        checkModifiers(node, node.tag);
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
