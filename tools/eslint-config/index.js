// The workspace's ESLint flat config. Lives in its own package so that the TypeScript
// version typescript-eslint resolves is this package's (TS 6, the last release with the
// JS type-checker API) rather than the repo's TS 7 — see this package's package.json.
// Globs stay relative to the repo root, where eslint.config.js re-exports this.
//
// Formatting is Prettier's job, not ESLint's: `eslint-config-prettier` is applied last
// and switches off every rule that would disagree with it. Rules here are about
// correctness and the conventions in docs/DEVELOPMENT.md.
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import orca from "./rules/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The desktop app sees ORCA only through the wire contract (ADR 0008) and renders with the
// design system. Reaching past `@orca/protocol` into the engine or the stores would tie the
// app to internals the daemon is supposed to own, and would break the "attach to a remote
// daemon" case. It binds to the main/preload side and to the renderer alike — the renderer
// is the half most likely to be tempted, since it is where the screens are.
const appImportBoundary = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["@orca/*", "!@orca/protocol", "!@orca/design"],
          message: "The app may only import @orca/protocol and @orca/design; everything else goes through the daemon.",
        },
      ],
    },
  ],
};

export default tseslint.config(
  {
    // packages/design/src/tokens.ts is generated; its formatting is the generator's.
    ignores: ["**/dist/**", "coverage/**", "**/*.tsbuildinfo", "packages/design/src/tokens.ts"],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: repoRoot },
    },
    plugins: { orca },
    rules: {
      // docs/DEVELOPMENT.md: every file except a pure re-export barrel starts with a
      // comment saying what it is for.
      "orca/file-header-comment": "error",

      // `exactOptionalPropertyTypes` is on and the code uses conditional spreads
      // (`...(x ? { x } : {})`) everywhere. These two read those as redundant.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/prefer-optional-chain": "off",

      // Ports are async by contract; an implementation that happens to be synchronous
      // (the in-memory stores, the pausing human-input port) still has to declare `async`.
      "@typescript-eslint/require-await": "off",

      // `Promise<T> | T` is how the ports say "sync or async, we await either way".
      "@typescript-eslint/no-redundant-type-constituents": "off",

      // `const self = this` is how the orchestrator builds a StepContext of closures.
      "@typescript-eslint/no-this-alias": ["error", { allowedNames: ["self"] }],

      // Unused arguments are how a port's signature documents itself; `_`-prefixed
      // names are the opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // The engine is async throughout; a floating promise there is a lost failure.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],

      // `unknown`-typed event payloads and plugin-registered nodes are cast at the
      // boundary on purpose; demanding a guard at every such site is not worth it.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // Deliberate escape hatches must say why.
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description" }],
      "no-console": ["error", { allow: ["error", "warn"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": ["error", { destructuring: "all" }],
    },
  },
  {
    // Inactive guard contract consumers have their own no-emit project; retain all type-aware rules.
    files: ["docs/preparation/tool-execution-guards/*.ts"],
    languageOptions: {
      parserOptions: { project: "./docs/preparation/tool-execution-guards/tsconfig.json", tsconfigRootDir: repoRoot },
    },
  },
  {
    // Plain JS tooling, including documentation validators, is outside the TS project.
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  {
    // The CLI, the scripted agent, the examples and the tooling scripts *are* their
    // process's stdout.
    files: [
      "packages/cli/src/**/*.ts",
      "packages/testing/src/**/*.ts",
      "examples/**/*.ts",
      "tools/**/*.js",
      "docs/preparation/**/validate-*.mjs",
      "packages/design/build-tokens.js",
      "packages/app/scripts/**/*.js",
    ],
    rules: { "no-console": "off" },
  },
  {
    // The app's renderer runs in Chromium, not Node, and is its own TypeScript project
    // (DOM lib, no @types/node, bundler resolution) — so the type-aware rules have to be
    // pointed at that project rather than the root one.
    files: ["packages/app/renderer/src/**/*.{ts,tsx}", "packages/app/renderer/test/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { project: "./packages/app/renderer/tsconfig.json", tsconfigRootDir: repoRoot },
    },
    rules: appImportBoundary,
  },
  {
    files: ["packages/app/src/**/*.ts"],
    rules: appImportBoundary,
  },
  {
    // docs/design/RULES.md rule 1, the TSX half: no literal colours or sizes in an inline
    // `style` object. The CSS half is `pnpm run lint:css`, which the `lint` script chains.
    // Scoped to the app because that is where screens are written; `packages/design` owns
    // the literals by definition, and nothing else renders.
    files: ["packages/app/**/*.{ts,tsx}"],
    rules: { "orca/design-tokens-only": "error" },
  },
  {
    // Tests poke at internals and fake ports; the strictness that protects src gets in the way.
    files: ["packages/*/test/**/*.ts", "packages/app/renderer/test/**/*.{ts,tsx}"],
    rules: {
      "orca/file-header-comment": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
      // A spy keeps every call's arguments, buffers included, until it is restored. Code under
      // test calls readSync in a tight loop, so spying on it held up to 1.8 GiB per test file.
      // A warning for now; interceptReadSync (packages/cli/test) records nothing.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='spyOn'][arguments.0.name='fs'][arguments.1.value='readSync']",
          message:
            "vi.spyOn(fs, 'readSync') retains every call's buffers until restored. Use interceptReadSync from packages/cli/test/intercept-read-sync.ts, or see 'Test memory' in docs/DEVELOPMENT.md.",
        },
      ],
    },
  },
  prettier,
);
