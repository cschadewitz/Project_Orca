/**
 * @orca/integrations - adapters that let ORCA sit inside, in front of, or
 * beside other tools:
 *   acp-facade/  ORCA exposed as an ACP agent (proxy mode for Kepler, Zed, ...)
 *   kepler/      Kepler task awareness (worktrees, task context)
 *   t3code/      T3 Code threads as ORCA agent sessions (groundwork)
 */
export * from "./acp-facade/index.js";
export * from "./kepler/index.js";
export * from "./t3code/index.js";
