/**
 * The TypeSafe "System One" wire shapes ORCA sends and reads (POST /v1/systemone), and the
 * provider port the `custom:jev-eval` executor calls so a test can script answers without a
 * network. Three question primitives - Choice, Score, Noul - evaluated in parallel against one
 * bounded `state`; the model returns typed answers, never text.
 */

/** A yes/no proposition; the answer is the probability it holds. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string } | undefined;
}

/** One option from a fixed set; `criteria` maps option id -> description (string or structured). */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | Record<string, unknown>>;
}

/** A position on an ordered rubric; `criteria` lists the levels low -> high (2..10). */
export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevRequest {
  state: string | Record<string, unknown> | unknown[];
  model: string;
  questions: Record<string, JevQuestion>;
}

/** An answer after validation: the provider's fields, plus arithmetic ORCA adds deterministically. */
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
      /** Number of rubric levels; `score` lies in `[0, levels - 1]`. */
      levels: number;
      /** `score / (levels - 1)`, so scores on different rubrics compare on one 0..1 scale. */
      normalized: number;
      legend?: Record<string, string> | undefined;
    };

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A validated response. `model` is what the provider says it ran, which is what gets recorded. */
export interface JevResponse {
  model: string | undefined;
  answers: Record<string, JevAnswer>;
  usage: JevUsage | undefined;
}

/**
 * The port the executor calls. `evaluate` returns the provider's raw JSON body (the executor
 * validates it) and throws `JevProviderError` for transport and HTTP failures.
 */
export interface JevProvider {
  evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown>;
}

/** A transport or HTTP failure. `retryable` follows the API's guidance: 429/529/5xx and network errors are. */
export class JevProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevProviderError";
  }
}
