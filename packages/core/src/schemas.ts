/**
 * `@orca/core/schemas` - the domain model and event schemas, and nothing that touches the
 * filesystem, the clock's environment or `node:crypto`.
 *
 * This subpath exists for the one consumer that runs in a browser: `@orca/protocol` builds
 * its wire schemas out of these, and `packages/app`'s renderer bundles the protocol (ADR
 * 0008). Importing the package root there would pull `ids.ts`, `util/glob.ts` and the JSONL
 * helpers into the bundle along with it, and a bundler cannot drop a `node:crypto` or
 * `node:fs` import it has already been asked to include - the build fails on the externalised
 * module instead. Runtime imports in `protocol` come from here; `import type` may still come
 * from the root, because types are erased before a bundler ever sees them.
 *
 * Keep this barrel node-free. Everything re-exported below depends only on `zod` and on
 * other modules in this list.
 */
export * from "./errors.js";

export * from "./model/artifact.js";
export * from "./model/request.js";
export * from "./model/agent.js";
export * from "./model/run.js";
export * from "./model/workflow.js";
export * from "./model/plan.js";
export * from "./model/plan-events.js";

export * from "./events/events.js";
export * from "./events/reduce.js";

export * from "./model/run-provenance.js";
export * from "./model/recovery.js";

export * from "./model/revision-input.js";

export { OrcaConfigSchema } from "./config.js";
