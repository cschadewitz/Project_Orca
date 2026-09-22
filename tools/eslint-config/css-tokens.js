// Enforces rule 1 of docs/design/RULES.md on the app's own CSS: no literal colours, sizes,
// radii, durations or z-values — reference a token instead.
//
// Why a hand-written check rather than stylelint: the rule is one sentence ("the value must
// be a token reference, zero, or a unitless/relative quantity"), and expressing it in
// stylelint means either `declaration-property-value-allowed-list` with a regex per property
// — which has to be rewritten every time a property is first used — or a custom stylelint
// plugin, which is this file plus a stylelint dependency, a second config format and a
// second runner for `pnpm run lint`. Roughly 150 lines of scanner buys us zero new
// dependencies and lets the fixture tests call a plain function.
//
// The scanner is deliberately not a CSS parser. It only needs to split a stylesheet into
// declarations, which means tracking comments, strings and brace depth; at-rule preludes
// (`@media (max-width: 900px)`) end at their `{` and are never examined, which is right —
// a media query cannot reference a custom property in the first place.

/** Colour notations that name a colour instead of referencing one. */
const COLOUR_FUNCTION = /(?:^|[^\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/g;

// Not all 148 CSS colour names — the ones a hurried hand actually reaches for. `transparent`
// and `currentColor` are not colours in this sense: they inherit a decision, they do not make one.
const NAMED_COLOUR =
  /(?:^|[^\w-])(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|teal|cyan|magenta|lime|navy|maroon|olive|brown|beige|coral|crimson|indigo|violet|salmon|tan|khaki|ivory|lavender|turquoise|light(?:gray|grey|blue|green)|dark(?:gray|grey|blue|green|red))(?:$|[^\w-])/gi;

// Absolute lengths and durations: the quantities a token is supposed to own. Relative and
// intrinsic units (`%`, `fr`, `em`, `ch`, `vh`, `vw`, `deg`) describe a ratio to something
// already chosen, so they are not a hardcoded design decision and are allowed.
const SIZED_NUMBER = /(?:^|[^\w.#-])(-?\d*\.?\d+)(px|rem|ms|s)(?![\w-])/gi;

/** `z-index: 3` is a stacking decision; the layer order lives in the `--z-*` tokens. */
const RAW_NUMBER = /^-?\d*\.?\d+$/;

/** An opt-out for the rare value no token can name. Suppresses this line and the next. */
const ALLOW_MARKER = "orca-allow-literal";

/** Values that mean "whatever the parent decided" rather than a literal choice. */
const NEUTRAL_KEYWORDS = new Set(["auto", "inherit", "initial", "unset", "revert", "revert-layer"]);

/** Advance past a quoted string, so a `;` or `}` inside one does not end a declaration. */
function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") i += 2;
    else if (source[i] === quote) return i + 1;
    else i += 1;
  }
  return source.length;
}

/**
 * Split a stylesheet into its declarations. Each one carries the absolute offset of its
 * value so a violation can be reported at the character that caused it.
 */
function declarations(source) {
  const found = [];
  let start = 0;
  let i = 0;

  const flush = (end) => {
    const text = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
    const colon = text.indexOf(":");
    // No colon: a selector, an at-rule prelude, or whitespace between blocks.
    if (colon !== -1 && !text.trimStart().startsWith("@")) {
      found.push({
        property: text.slice(0, colon).trim(),
        value: text.slice(colon + 1),
        offset: start + colon + 1,
      });
    }
    start = end + 1;
  };

  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      i = skipString(source, i);
    } else if (c === "{") {
      // A prelude, not a declaration: discard it and start the block's first declaration.
      start = i + 1;
      i += 1;
    } else if (c === ";" || c === "}") {
      flush(i);
      i += 1;
    } else {
      i += 1;
    }
  }
  return found;
}

/** Blank out the parts of a value that legitimately contain arbitrary text. */
function maskLiterals(value) {
  return value
    .replace(/url\([^)]*\)/gi, (m) => " ".repeat(m.length))
    .replace(/"[^"]*"|'[^']*'/g, (m) => " ".repeat(m.length));
}

/** Map an absolute offset onto a 1-based line and column. */
function locator(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

/**
 * Report every literal design value in a stylesheet.
 *
 * @param {string} source the stylesheet
 * @param {string} [file] a label for the messages
 * @param {{lengths?: boolean}} [options] `lengths: false` checks colours and stacking order
 *   only. It exists for stylesheets that predate the length pass and cannot yet act on it.
 *   Nothing passes it today: `packages/design/css/components.css` was the one caller, and
 *   #211 removed the ~190 literal type sizes and box heights that made it necessary, so
 *   `lint:css` now checks that file in full. Keep the option only while something needs it —
 *   a stylesheet that wants it is a stylesheet with a missing token family, and the honest
 *   fix is the tokens.
 * @returns {{file: string, line: number, column: number, property: string, text: string, message: string}[]}
 */
export function checkCss(source, file = "<input>", options = {}) {
  const { lengths = true } = options;
  const at = locator(source);
  const lines = source.split("\n");
  const allowed = new Set();
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) {
      allowed.add(index + 1);
      allowed.add(index + 2);
    }
  });

  const violations = [];
  const report = (property, offset, text, message) => {
    const { line, column } = at(offset);
    if (allowed.has(line)) return;
    violations.push({ file, line, column, property, text, message });
  };

  // `pick` turns a match into `{ text, message }`, or null for a match that is allowed.
  // Several of the patterns match a leading boundary character so that they do not fire
  // inside an identifier, so the reported text and column come from `pick`, not `match[0]`.
  const scan = (regex, property, value, offset, pick) => {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(value)) !== null) {
      const hit = pick(match);
      if (hit === null) continue;
      report(property, offset + match.index + match[0].indexOf(hit.text), hit.text, hit.message);
    }
  };

  for (const { property, value, offset } of declarations(source)) {
    const masked = maskLiterals(value);
    const trimmed = masked.trim();

    scan(HEX_COLOUR, property, masked, offset, (m) => ({ text: m[0], message: "hex colour" }));
    scan(COLOUR_FUNCTION, property, masked, offset, (m) => ({ text: m[1], message: "colour function" }));
    scan(NAMED_COLOUR, property, masked, offset, (m) => ({ text: m[1], message: "named colour" }));
    if (lengths)
      scan(SIZED_NUMBER, property, masked, offset, (m) =>
        // Zero is the same in every design system, so `0`, `0px` and `0ms` are allowed.
        Number(m[1]) === 0
          ? null
          : { text: m[1] + m[2], message: `literal ${m[2] === "ms" || m[2] === "s" ? "duration" : "length"}` },
      );

    // A stacking order is a design decision even though it carries no unit, so `z-index`
    // is checked against the whole value: a `--z-*` reference, zero, or a keyword.
    if (property === "z-index") {
      const declared =
        trimmed.includes("var(") ||
        NEUTRAL_KEYWORDS.has(trimmed) ||
        (RAW_NUMBER.test(trimmed) && Number(trimmed) === 0);
      if (!declared) report(property, offset + masked.indexOf(trimmed), trimmed, "raw z-index");
    }
  }

  return violations.map((v) => ({
    ...v,
    message: `${v.message} \`${v.text}\` in \`${v.property}\` — reference a token (\`var(--…)\`); if none names it, add it to packages/design/tokens.json and run \`pnpm run design:build\`.`,
  }));
}
