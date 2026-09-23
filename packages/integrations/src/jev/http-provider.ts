/**
 * The TypeSafe HTTP API as a `JevProvider`: one POST to `/v1/systemone` with a bearer key. No
 * SDK, just `fetch`, so the dependency surface is the platform's and a test can hand in a
 * fake. The key lives in this object and goes into the Authorization header and nowhere
 * else - not into errors, not into logs, not into anything the executor records.
 */
import { JevProviderError, type JevProvider, type JevRequest } from "./types.js";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";

export interface JevHttpProviderOptions {
  apiKey: string;
  /** Origin of the API; the path is always `/v1/systemone`. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** How much of an error body to quote back; enough to read, not enough to be a payload. */
const BODY_EXCERPT = 400;

export class JevHttpProvider implements JevProvider {
  readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevHttpProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = `${(options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, "")}/v1/systemone`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The timeout is the caller's: the executor's `signal` folds the node's `timeoutMs` in with the run's cancellation. */
  async evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: options.signal,
      });
    } catch (e) {
      if (options.signal.aborted) throw e;
      throw new JevProviderError(`request failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, BODY_EXCERPT);
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      throw new JevProviderError(`HTTP ${res.status}${text ? `: ${text}` : ""}`, retryable, res.status);
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new JevProviderError("response body is not JSON", false, res.status);
    }
  }
}
