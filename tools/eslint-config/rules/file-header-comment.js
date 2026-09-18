// Encodes one of the layout conventions in docs/DEVELOPMENT.md: every file except a
// pure re-export barrel starts with a comment saying what it is for.
//
// "Starts with" means the comment precedes the first statement, so a file may open with
// either `// what this is` or `/** what this is */`. A barrel — a file whose every
// statement re-exports from somewhere else — is exempt, since its name is the whole story.

/** A statement that only forwards another module's exports: `export * from "x"`, `export { a } from "x"`. */
function isReExport(node) {
  return (node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") && node.source != null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require a leading comment saying what a file is for (re-export barrels exempt).",
    },
    schema: [],
    messages: {
      missing: "File must start with a comment saying what it is for (see docs/DEVELOPMENT.md).",
    },
  },
  create(context) {
    return {
      Program(node) {
        if (node.body.length === 0) return;
        if (node.body.every(isReExport)) return;

        const source = context.sourceCode;
        const first = node.body[0];
        // A shebang parses as a leading comment but says nothing about the file, and a
        // comment on the first statement's own line is a trailing note on something else.
        const leading = source
          .getCommentsBefore(first)
          .filter((c) => !(c.type === "Shebang" || (c.type === "Line" && c.value.startsWith("!"))));
        if (leading.some((c) => c.loc.end.line < first.loc.start.line)) return;

        context.report({ node: first, messageId: "missing" });
      },
    };
  },
};
