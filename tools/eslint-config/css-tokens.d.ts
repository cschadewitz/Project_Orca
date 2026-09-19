// Types for css-tokens.js, so the fixture tests (TypeScript, under the root tsconfig) can
// import the checker without the repo turning on `allowJs`.

/** One literal design value found in a stylesheet. */
export interface CssTokenViolation {
  /** The label passed to `checkCss`, for the printed message. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The declaration's property name, e.g. `color`. */
  property: string;
  /** The offending text, e.g. `#a32a24`. */
  text: string;
  /** What is wrong and how to fix it. */
  message: string;
}

/** How much of rule 1 to enforce on this stylesheet. */
export interface CssTokenOptions {
  /** `false` checks colours and stacking order only; see the note in css-tokens.js. */
  lengths?: boolean;
}

/** Report every literal colour, length, duration or z-value in a stylesheet. */
export declare function checkCss(source: string, file?: string, options?: CssTokenOptions): CssTokenViolation[];
