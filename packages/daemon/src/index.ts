/**
 * @orca/daemon - the long-lived `orca serve` process. Exposes the orchestrator over the
 * wire contract in `@orca/protocol` so several clients (the desktop app, a CLI in client
 * mode, an editor integration) can watch and steer the same runs. Today: the transport, the
 * method table, the handshake, the read methods over a store, the WebSocket endpoint that
 * pushes run, step, agent and input notifications, and - as of v0.4.0 - the four methods
 * that write.
 *
 * Writing makes the daemon one of the interpreters rather than a spectator of them, which
 * is a real change of role: it takes a run's single-writer lease before it appends, exactly
 * as a CLI does, and refuses a run another live process holds (ADR 0008, #101). `orca serve
 * --read-only` leaves the whole of it out.
 */
export * from "./read-model.js";
export * from "./workflow-model.js";
export * from "./plan-model.js";
export * from "./control.js";
export * from "./plan-control.js";
export * from "./config-model.js";
export * from "./config-schema.js";
export * from "./agent-model.js";
export * from "./secrets-model.js";
export * from "./methods.js";
export * from "./notifications.js";
export * from "./subscriptions.js";
export * from "./socket.js";
export * from "./server.js";
export * from "./auth/index.js";
export * from "./workflow-inputs.js";

export * from "./request-submission.js";

export * from "./live-input-authority.js";
export * from "./live-input-notifications.js";

export * from "./daemon-identity.js";
export * from "./execution-runtime.js";

export * from "./admission-retry.js";

export * from "./revision-input.js";

export * from "./operator-read-model.js";
export * from "./continuation-admission.js";

export * from "./host-resources/index.js";
export * from "./host-workstreams.js";
export * from "./operator-host-resources.js";
export * from "./delegation/index.js";
export * from "./judge-budget.js";
export * from "./plain-rule-judge.js";
export * from "./judge-status.js";
