/**
 * The `store format` row that names the running release's store epoch. The candidate prints
 * `this Orrery`; a release from before the rename (the Latest one on the runner, until a
 * renamed release replaces it) prints `this ORCA`. Shared with the CLI's guard test
 * (packages/cli/test/store-command.test.ts), so the wording cannot drift from this check.
 */
const CURRENT = "ORCA";
const LEGACY = "ORCA"; // rename-keep: the label a release from before the rename prints

export const STORE_FORMAT_ROW = new RegExp(`^this (?:${CURRENT}|${LEGACY})\\s+(\\S+)`, "m");
