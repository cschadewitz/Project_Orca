// The TSX half of docs/design/RULES.md rule 1: an inline `style` object may not name a
// colour, and may not give a width, height or padding as a bare number.
//
// The CSS half lives in ../css-tokens.js. This one is deliberately narrow — it looks only at
// `style={{ … }}` on a JSX element, because that is the only place in the renderer where a
// literal value reaches the DOM without passing through `components.css`. A value it cannot
// see at parse time (an identifier, a call, a conditional) is left alone: the rule's job is
// to catch the hurried literal, not to prove a program correct.
//
// `<Text style="caption">` is not an inline style — it is the design system's own prop — and
// a string-valued `style` attribute is skipped for exactly that reason.

/** Colour notations that name a colour instead of referencing one. Mirrors css-tokens.js. */
const COLOUR =
  /#[0-9a-fA-F]{3,8}\b|(?:^|[^\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?:^|[^\w-])(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|teal|cyan|magenta|lime|navy|maroon|olive|brown|coral|crimson|indigo|violet|salmon|khaki|ivory|lavender|turquoise)(?:$|[^\w-])/i;

/** Absolute lengths and durations, the quantities the tokens own. */
const SIZED = /(?:^|[^\w.#-])-?\d*\.?\d+(px|rem|ms|s)(?![\w-])/i;

// React writes a bare number on these as `px`, which is the same literal with the unit
// hidden. Box-model properties only: `flex: 1`, `opacity: 0.5` and `zIndex` are not lengths
// (`zIndex` is caught by the colour/size pass only if written as a string, and belongs to
// the `--z-*` tokens — see the `numeric` message).
const SIZE_PROPS = new Set([
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "paddingInline",
  "paddingInlineStart",
  "paddingInlineEnd",
  "paddingBlock",
  "paddingBlockStart",
  "paddingBlockEnd",
]);

/** The property name, whether written `padding:` or `"padding":` or `"--row-h":`. */
function keyOf(property) {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
  return null;
}

/** The value if it is a literal we can read: a string, a number, or `-number`. */
function literalOf(node) {
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return node.value;
  // A template with no substitutions is just a string written with backticks.
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const inner = literalOf(node.argument);
    return typeof inner === "number" ? -inner : null;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid literal colours and sizes in inline `style` objects (docs/design/RULES.md rule 1).",
    },
    schema: [],
    messages: {
      colour:
        "Literal colour `{{text}}` in `style.{{prop}}`. Reference a token — `var(--status-failed)`, or `v('status-failed')` from @orca/design. If none names it, add it to packages/design/tokens.json and run `pnpm run design:build`.",
      size: "Literal size `{{text}}` in `style.{{prop}}`. Use a spacing or size token — `var(--space-3)`.",
      numeric:
        "Numeric `style.{{prop}}` renders as `{{text}}px`. Use a spacing or size token — `var(--space-3)` — or a class from components.css.",
    },
  },
  create(context) {
    /** Check one `key: value` pair of an inline style object. */
    function checkProperty(property) {
      const prop = keyOf(property);
      if (prop === null) return;
      const value = literalOf(property.value);
      if (value === null) return;

      if (typeof value === "number") {
        // Zero is the same in every design system.
        if (value !== 0 && SIZE_PROPS.has(prop)) {
          context.report({ node: property, messageId: "numeric", data: { prop, text: String(value) } });
        }
        return;
      }

      const colour = COLOUR.exec(value);
      if (colour) {
        context.report({ node: property, messageId: "colour", data: { prop, text: colour[0].trim() } });
        return;
      }
      const sized = SIZED.exec(value);
      if (sized && Number.parseFloat(sized[0].replace(/[^\d.-]/g, "")) !== 0) {
        context.report({ node: property, messageId: "size", data: { prop, text: sized[0].trim() } });
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "style") return;
        const value = node.value;
        if (value?.type !== "JSXExpressionContainer") return;
        if (value.expression.type !== "ObjectExpression") return;
        for (const property of value.expression.properties) {
          // A spread is someone else's object; it is checked where it is built.
          if (property.type === "Property") checkProperty(property);
        }
      },
    };
  },
};
