/**
 * @orca/daemon - the long-lived `orca serve` process. Exposes the orchestrator over the
 * wire contract in `@orca/protocol` so several clients (the desktop app, a CLI in client
 * mode, an editor integration) can watch and steer the same runs. Today: the transport, the
 * method table, the handshake and the read methods over a store; writes and the event
 * stream land as the app needs them.
 */
export * from "./read-model.js";
export * from "./methods.js";
export * from "./server.js";
