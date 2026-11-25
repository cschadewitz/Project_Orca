/**
 * Imported first by `index.ts`, so it runs before any other module of the main process reads
 * the environment: variables set under their names from before the rename are adopted under
 * the new ones, with a warning, for one release (`adoptLegacyEnv` in `@orca/core`).
 */
import { adoptLegacyEnv } from "@orca/core";

adoptLegacyEnv();
