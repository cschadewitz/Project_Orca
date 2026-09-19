/**
 * The app's only way to reach ORCA: request envelopes over the daemon's HTTP endpoint,
 * results validated against the protocol schemas. Lives in the main process (the
 * renderer talks to it over IPC via the preload bridge) and imports nothing but
 * `@orca/protocol`, which the lint config enforces for the whole app package.
 */
import {
  HELLO_METHOD,
  HelloResultSchema,
  PROTOCOL_VERSION,
  ResponseMessageSchema,
  type HelloResult,
  type ProtocolError,
  type RequestMessage,
} from "@orca/protocol";
import type { ZodType } from "zod";

/** Where `orca serve` listens unless told otherwise; 6722 spells ORCA on a phone keypad. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:6722";

export class DaemonClientError extends Error {
  override readonly name = "DaemonClientError";
  constructor(readonly error: ProtocolError) {
    super(`${error.code}: ${error.message}`);
  }
}

export class DaemonClient {
  private nextId = 1;

  constructor(
    readonly url: string = DEFAULT_DAEMON_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<R>(method: string, params: unknown, result: ZodType<R>): Promise<R> {
    const req: RequestMessage = { kind: "request", id: this.nextId++, method, params };
    const res = await this.fetchImpl(`${this.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const parsed = ResponseMessageSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new DaemonClientError({
        code: "PROTOCOL_MESSAGE",
        message: `daemon sent something that is not a response`,
      });
    }
    if (!parsed.data.ok) throw new DaemonClientError(parsed.data.error);
    return result.parse(parsed.data.result);
  }

  hello(client: string): Promise<HelloResult> {
    return this.call(HELLO_METHOD, { client, protocol: PROTOCOL_VERSION }, HelloResultSchema);
  }
}
