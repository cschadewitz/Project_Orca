// Types for the local ESLint plugin, so the fixture tests (TypeScript, under the root
// tsconfig) can load it without the repo turning on `allowJs`.
import type { ESLint } from "eslint";

declare const plugin: ESLint.Plugin;
export default plugin;
