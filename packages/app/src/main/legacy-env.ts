/**
 * Imported first by `index.ts`, so it runs before any other module of the main process reads
 * the environment: variables set under their names from before the rename are adopted under
 * the new ones, with a warning, for one release (`adoptLegacyEnv` in `@orca/core`).
 */
// The one exception to "protocol and design only": the app's own environment is read in this
// process, so the daemon cannot adopt the old names for it. A pure function, no I/O.
// eslint-disable-next-line no-restricted-imports -- adoptLegacyEnv must run in app main (rename compat, v0.9.0)
import { adoptLegacyEnv } from "@orca/core";

adoptLegacyEnv();
