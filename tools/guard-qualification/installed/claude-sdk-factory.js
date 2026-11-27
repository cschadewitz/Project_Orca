/**
 * What the installed receipt for the Claude Agent SDK route (#1128) runs: the daemon's own
 * session factory and the bridge it opens, bundled into one file (`childBundle`) that the run
 * imports and drives. The receipt's `bridgeSha256` is the digest of that file, so it names the
 * code the run exercised, not a selection of sources. The types a session is opened with come
 * from the same bundle, so the factory sees its own copies of them.
 */
export { makeSessionFactory } from "../../../packages/cli/src/bootstrap.ts";
export { LocalHost } from "@orca/agents";
export { AgentSpecSchema, silentLogger } from "@orca/core";
