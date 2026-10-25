// Apply ORCA's existing rules to this isolated offline TypeScript project.
import base from "../../../../eslint.config.js";
import { fileURLToPath } from "node:url";
export default [
  ...base,
  {
    files: ["*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
  },
];
