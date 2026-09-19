/**
 * @orca/daemon - the long-lived `orca serve` process. Exposes the orchestrator over the
 * wire contract in `@orca/protocol` so several clients (the desktop app, a CLI in client
 * mode, an editor integration) can watch and steer the same runs. Today: the transport,
 * the method table and the handshake; the run/plan methods land as the app needs them.
 */
export * from "./methods.js";
export * from "./server.js";
