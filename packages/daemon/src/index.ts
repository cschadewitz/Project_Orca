/**
 * @orca/daemon - the long-lived `orca serve` process. Exposes the orchestrator over the
 * wire contract in `@orca/protocol` so several clients (the desktop app, a CLI in client
 * mode, an editor integration) can watch and steer the same runs. Today: the transport, the
 * method table, the handshake, the read methods over a store and the WebSocket endpoint that
 * pushes run, step, agent and input notifications; writes land as the app needs them.
 */
export * from "./read-model.js";
export * from "./methods.js";
export * from "./notifications.js";
export * from "./subscriptions.js";
export * from "./socket.js";
export * from "./server.js";
