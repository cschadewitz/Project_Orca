// Local ESLint plugin: the repo conventions worth automating that have no off-the-shelf
// rule. Registered as the `orca` plugin in the config next door.
import fileHeaderComment from "./file-header-comment.js";
import designTokensOnly from "./design-tokens-only.js";
import noFlakyTestWaits from "./no-flaky-test-waits.js";

export default {
  meta: { name: "eslint-plugin-orca", version: "0.1.0" },
  rules: {
    "file-header-comment": fileHeaderComment,
    "design-tokens-only": designTokensOnly,
    "no-flaky-test-waits": noFlakyTestWaits,
  },
};
