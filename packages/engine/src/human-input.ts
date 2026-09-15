/**
 * HumanInputPort - how the engine asks a person something (gate decisions,
 * `ask` permissions, free questions). Implementations: auto (tests/demos),
 * pausing (run waits until `orca answer` is invoked), CLI prompt, or an
 * upstream ACP client when ORCA runs as an agent inside Kepler/Zed/T3 Code.
 */
export interface HumanInputQuery {
  runId: string;
  stepRunId: string;
  requestId: string;
  kind: "decision" | "permission" | "question";
  question: string;
  options: string[];
  context: Record<string, unknown>;
}

export interface HumanInputPort {
  /** Resolve with the chosen option / free text, or undefined to cancel. */
  ask(query: HumanInputQuery): Promise<string | undefined>;
}

/** Always answers with `option` (or the first option). */
export function autoHumanInput(option?: string): HumanInputPort {
  return { ask: async (q) => option ?? q.options[0] };
}

/** Parks questions until someone calls `answer(requestId, value)`. */
export class PausingHumanInput implements HumanInputPort {
  private readonly pending = new Map<string, { query: HumanInputQuery; resolve: (v: string | undefined) => void }>();
  ask(query: HumanInputQuery): Promise<string | undefined> {
    return new Promise((resolve) => this.pending.set(query.requestId, { query, resolve }));
  }
  list(): HumanInputQuery[] {
    return [...this.pending.values()].map((p) => p.query);
  }
  answer(requestId: string, value: string | undefined): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve(value);
    return true;
  }
}
