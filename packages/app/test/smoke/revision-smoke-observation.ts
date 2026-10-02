/** Serialized Electron observer, shared verbatim with its production-error-shape regression tests. */
import type { RevisionResult } from "@orca/protocol";

export interface RevisionSmokeProbe {
  methods: string[];
  receipts: { method: string; value: RevisionResult }[];
  errors: { method: string; code: string }[];
  holdNextReplacement: boolean;
  replacementWaiting: boolean;
  releaseReplacement?: () => void;
  holdPendingReads: boolean;
  pendingReadsWaiting: number;
  releasePendingReads: (() => void)[];
  delayedReadCount: number;
}
export interface RevisionSmokeMain {
  orcaRevisionSmoke: RevisionSmokeProbe;
}

/**
 * Keep this function self-contained: Electron serializes it into the main process.
 * Its runtime dependencies must be loaded inside it from the same compiled client module.
 * Timing barriers delay real calls only; arguments, responses and errors remain unchanged.
 */
export function installRevisionSmokeObservation({ app }: { app: { getAppPath(): string } }, modulePath: string): void {
  const requireFromApp = process
    .getBuiltinModule("module")
    .createRequire(process.getBuiltinModule("path").join(app.getAppPath(), "package.json"));
  const { DaemonClient, DaemonClientError } = requireFromApp(
    modulePath,
  ) as typeof import("../../src/client/daemon-client.js");
  const probe: RevisionSmokeProbe = {
    methods: [],
    receipts: [],
    errors: [],
    holdNextReplacement: false,
    replacementWaiting: false,
    holdPendingReads: false,
    pendingReadsWaiting: 0,
    releasePendingReads: [],
    delayedReadCount: 0,
  };
  (globalThis as unknown as RevisionSmokeMain).orcaRevisionSmoke = probe;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = DaemonClient.prototype.call;
  DaemonClient.prototype.call = async function (
    this: InstanceType<typeof DaemonClient>,
    ...args: Parameters<typeof original>
  ) {
    const method = args[0];
    if (["inputs.revise", "inputs.replaceRevision", "inputs.answer", "runs.resume"].includes(method))
      probe.methods.push(method);
    if (method === "inputs.replaceRevision" && probe.holdNextReplacement) {
      probe.holdNextReplacement = false;
      probe.replacementWaiting = true;
      await new Promise<void>((resolve) => {
        probe.releaseReplacement = resolve;
      });
      probe.replacementWaiting = false;
      delete probe.releaseReplacement;
    }
    if (method === "inputs.revisionPending" && probe.holdPendingReads) {
      probe.delayedReadCount++;
      probe.pendingReadsWaiting++;
      await new Promise<void>((resolve) => {
        probe.releasePendingReads.push(resolve);
      });
      probe.pendingReadsWaiting--;
    }
    try {
      const result = await original.apply(this, args);
      if (method === "inputs.revise" || method === "inputs.replaceRevision")
        probe.receipts.push({ method, value: result as RevisionResult });
      return result;
    } catch (error) {
      // The client wraps the protocol error; its Error object has no top-level code.
      const code = error instanceof DaemonClientError ? error.error.code : undefined;
      probe.errors.push({ method, code: typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "UNKNOWN" });
      throw error;
    }
  } as typeof original;
}
