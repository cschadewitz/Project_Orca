/**
 * The shape of `window.orca` — the only thing the sandboxed renderer can reach. Declared
 * once here so the preload that builds it and the renderer that calls it cannot drift:
 * both import these types, neither imports the other's code.
 *
 * Every call resolves rather than rejects. An IPC rejection across the context bridge
 * arrives as a stringified `Error` with the stack of the main process, which tells the UI
 * nothing it can render; a `BridgeResult` carries the protocol's own error code instead.
 */
import type { HelloResult, ProtocolError } from "@orca/protocol";

export type BridgeResult<T> = { ok: true; result: T } | { ok: false; error: ProtocolError };

export interface OrcaBridge {
  /** The daemon handshake: protocol version, ORCA version and the daemon's capabilities. */
  hello: () => Promise<BridgeResult<HelloResult>>;
}
