/**
 * HumanInputPort - how the engine asks a person something (gate decisions,
 * `ask` permissions, free questions). Implementations: auto (tests/demos),
 * pausing (run waits until `orca answer` is invoked), CLI prompt, or an
 * upstream ACP client when ORCA runs as an agent inside Kepler/Zed/T3 Code.
 */
import { OrcaError } from "@orca/core";

export interface HumanInputQuery {
  runId: string;
  stepRunId: string;
  requestId: string;
  kind: "decision" | "permission" | "question";
  question: string;
  options: string[];
  context: Record<string, unknown>;
  /**
   * Fires when the run is cancelled while the question is still open. Ports
   * that park questions (a queue, a chat thread, a web UI) should drop the
   * request and reject with `CANCELLED`; the engine stops waiting either way.
   */
  signal?: AbortSignal;
}

export interface HumanInputPort {
  /** Resolve with the chosen option / free text, or undefined to cancel. */
  ask(query: HumanInputQuery): Promise<string | undefined>;
}

/** The error a port should reject with once `query.signal` has fired. */
export function humanInputCancelled(signal?: AbortSignal): OrcaError {
  return new OrcaError("CANCELLED", String(signal?.reason ?? "cancelled"));
}

/** Always answers with `option` (or the first option). */
export function autoHumanInput(option?: string): HumanInputPort {
  return { ask: async (q) => option ?? q.options[0] };
}

/**
 * Wraps a port so `ask` rejects with `CANCELLED` as soon as `signal` fires,
 * even if the underlying port never settles. The signal is also forwarded on
 * the query so cooperative ports can clean up.
 */
export function abortableHumanInput(port: HumanInputPort, signal: AbortSignal): HumanInputPort {
  return {
    ask(query) {
      if (signal.aborted) return Promise.reject(humanInputCancelled(signal));
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(humanInputCancelled(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        port
          .ask({ ...query, signal })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
}

/** Parks questions until someone calls `answer(requestId, value)`; a cancelled run drops its questions. */
export class PausingHumanInput implements HumanInputPort {
  private readonly pending = new Map<string, { query: HumanInputQuery; settle: (v: string | undefined) => void }>();
  ask(query: HumanInputQuery): Promise<string | undefined> {
    const { signal } = query;
    if (signal?.aborted) return Promise.reject(humanInputCancelled(signal));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(query.requestId);
        reject(humanInputCancelled(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(query.requestId, {
        query,
        settle: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
      });
    });
  }
  list(): HumanInputQuery[] {
    return [...this.pending.values()].map((p) => p.query);
  }
  answer(requestId: string, value: string | undefined): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.settle(value);
    return true;
  }
}
