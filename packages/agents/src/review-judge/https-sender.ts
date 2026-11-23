/**
 * The HTTPS sender for a hosted review judge on the user's own key (#701). It is the `JudgeEndpointSender` a judge
 * connection (connection.ts) hands the frame and the leased BYOK credential (secret-credentials.ts) to, for one
 * fixed destination:
 *
 * - one POST to one fixed URL (the destination the key is pinned to), over TLS with certificate checks always on (TLS 1.2 or later), on a
 *   fresh connection (no pooled socket outlives the call);
 * - no redirects (any status but 200 is a failure, a 3xx is never followed) and no retries;
 * - the response is bounded: a declared or streamed body past `maxResponseBytes` is cut off, compressed or
 *   non-JSON bodies are refused, and the text must be valid UTF-8;
 * - cancellation destroys the request at once and settles the send, so a caller's slot is never held by a
 *   socket nobody is waiting on;
 * - the key goes only into the one configured auth header. It is read from the lease inside the call, checked
 *   for header safety, and never appears in an error, a log or the sender's version;
 * - every failure is a fixed code (`JudgeSenderFailed`), never a provider message, header or body.
 *
 * Nothing here registers or activates a sender: a caller has to construct one and pass it to
 * `prepareJudgeConnection`, and no call site does. Tests use an injected request function against local fakes.
 */
import { createHash } from "node:crypto";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { REQUIRED_SENDER_CAPABILITIES, type JudgeEndpointSender } from "./connection.js";
import { JUDGE_SECRET_CREDENTIAL_KIND } from "./secret-credentials.js";

export const HTTPS_JUDGE_SENDER_VERSION = "https-judge-sender/v1";

/** Fixed reasons a send fails. Never a value, a header, a body or a provider's own words. */
export type JudgeSenderFailure =
  | "cancelled"
  | "credential-mismatch"
  | "credential-invalid"
  | "request-invalid"
  | "network"
  | "http-status"
  | "content-type"
  | "content-encoding"
  | "response-too-large"
  | "malformed-utf8";

export class JudgeSenderFailed extends Error {
  constructor(readonly code: JudgeSenderFailure) {
    super(`judge sender failed: ${code}`);
    this.name = "JudgeSenderFailed";
  }
}

/** Where the key goes: `Authorization: Bearer <key>`, or the key alone in an `x-api-key` header. */
export type HttpsJudgeAuth = { readonly scheme: "bearer" } | { readonly header: "x-api-key" };

export type HttpsRequestFn = (options: RequestOptions & Record<string, unknown>) => ClientRequest;

export interface HttpsJudgeSenderOptions {
  /**
   * The exact URL the key is pinned to and every request goes to, such as `https://judge.example/v1/messages`:
   * the secret's `destination`, written in canonical form, with no credentials, query or fragment.
   */
  readonly destination: string;
  readonly auth: HttpsJudgeAuth;
  /** Fixed non-secret headers the provider requires (such as an API version). Never auth or framing headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Tests inject a request function; defaults to `node:https` `request`. */
  readonly request?: HttpsRequestFn;
}

export type HttpsJudgeSenderResult =
  | { readonly status: "ready"; readonly sender: JudgeEndpointSender }
  | { readonly status: "invalid"; readonly reason: "destination" | "auth" | "headers" };

/** Headers a configured extra may not set: auth, framing, routing and encoding are the sender's own. */
const RESERVED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "transfer-encoding",
  "accept-encoding",
  "connection",
  "upgrade",
  "te",
  "expect",
]);
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEADER_VALUE = /^[\x20-\x7e]{1,256}$/;
const KEY_VALUE = /^[\x21-\x7e]{1,4096}$/;
const PATH = /^\/[A-Za-z0-9._~/-]{0,255}$/;
const JSON_TYPE = /^application\/json\s*(;|$)/i;

function validDestination(destination: unknown): URL | null {
  if (typeof destination !== "string") return null;
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") return null;
  if (url.search !== "" || url.hash !== "" || destination.includes("?") || destination.includes("#")) return null;
  const path = url.pathname;
  if (!PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) return null;
  // Written exactly in its canonical form, so the pin, the connection and the request name one URL.
  const canonical = url.href === destination || (path === "/" && url.origin === destination);
  return canonical ? url : null;
}

function validHeaders(headers: unknown): Record<string, string> | null {
  if (headers === undefined) return {};
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name)) return null;
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) return null;
    out[name] = value;
  }
  return out;
}

function authHeader(auth: unknown): ((key: string) => [string, string]) | null {
  if (auth === null || typeof auth !== "object") return null;
  const keys = Object.keys(auth);
  if (keys.length !== 1) return null;
  if ((auth as Record<string, unknown>).scheme === "bearer") return (key) => ["authorization", `Bearer ${key}`];
  if ((auth as Record<string, unknown>).header === "x-api-key") return (key) => ["x-api-key", key];
  return null;
}

/** The leased value, or a fixed failure. Read once, inside the call; never kept past it. */
function leasedKey(credential: unknown, destination: string): string {
  if (credential === null || typeof credential !== "object") throw new JudgeSenderFailed("credential-mismatch");
  const { kind, destination: pinned, reveal } = credential as Record<string, unknown>;
  if (kind !== JUDGE_SECRET_CREDENTIAL_KIND || pinned !== destination || typeof reveal !== "function")
    throw new JudgeSenderFailed("credential-mismatch");
  let value: unknown;
  try {
    value = (reveal as () => unknown)();
  } catch {
    throw new JudgeSenderFailed("credential-invalid");
  }
  // A value that could split or smuggle a header is refused, never sent.
  if (typeof value !== "string" || !KEY_VALUE.test(value)) throw new JudgeSenderFailed("credential-invalid");
  return value;
}

/**
 * A sender for one destination URL. Invalid options are refused here, before any key is touched. The
 * version names the destination, auth placement and extra headers, never the key.
 */
export function createHttpsJudgeSender(options: HttpsJudgeSenderOptions): HttpsJudgeSenderResult {
  const url = validDestination(options?.destination);
  if (url === null) return { status: "invalid", reason: "destination" };
  const destination = options.destination;
  const path = url.pathname;
  const placeKey = authHeader(options.auth);
  if (placeKey === null) return { status: "invalid", reason: "auth" };
  const extra = validHeaders(options.headers);
  if (extra === null) return { status: "invalid", reason: "headers" };
  const request = options.request ?? httpsRequest;
  const authPlacement = "scheme" in options.auth ? "bearer" : "x-api-key";
  const version = `${HTTPS_JUDGE_SENDER_VERSION}:sha256:${createHash("sha256")
    .update(JSON.stringify([destination, authPlacement, Object.entries(extra).sort()]))
    .digest("hex")}`;
  const port = url.port === "" ? 443 : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // SNI carries a name, never an address.
  const servername = isIP(host) === 0 ? host : undefined;

  const send: JudgeEndpointSender["send"] = ({ frame, credential, signal, maxResponseBytes }) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      let req: ClientRequest | undefined;
      const fail = (code: JudgeSenderFailure) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        req?.destroy();
        reject(new JudgeSenderFailed(code));
      };
      const done = (text: string) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(text);
      };
      const onAbort = () => fail("cancelled");

      if (signal.aborted) return fail("cancelled");
      if (typeof frame !== "string" || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0)
        return fail("request-invalid");
      let key: string;
      try {
        key = leasedKey(credential, destination);
      } catch (error) {
        return fail((error as JudgeSenderFailed).code);
      }
      const body = Buffer.from(frame, "utf8");
      const [authName, authValue] = placeKey(key);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        req = request({
          method: "POST",
          host,
          ...(servername ? { servername } : {}),
          port,
          path,
          agent: false,
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          headers: {
            ...extra,
            accept: "application/json",
            "accept-encoding": "identity",
            "content-type": "application/json",
            "content-length": String(body.byteLength),
            [authName]: authValue,
          },
        });
      } catch {
        return fail("network");
      }
      req.on("error", () => fail("network"));
      req.on("response", (res: IncomingMessage) => {
        if (res.statusCode !== 200) return fail("http-status");
        if (!JSON_TYPE.test(String(res.headers["content-type"] ?? ""))) return fail("content-type");
        const encoding = res.headers["content-encoding"];
        if (encoding !== undefined && encoding.toLowerCase() !== "identity") return fail("content-encoding");
        const declared = res.headers["content-length"];
        if (declared !== undefined && !(Number(declared) <= maxResponseBytes)) return fail("response-too-large");
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxResponseBytes) return fail("response-too-large");
          chunks.push(chunk);
        });
        res.on("error", () => fail("network"));
        res.on("aborted", () => fail("network"));
        res.on("end", () => {
          if (!res.complete) return fail("network");
          try {
            done(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks)));
          } catch {
            fail("malformed-utf8");
          }
        });
        res.on("close", () => fail("network"));
      });
      req.end(body);
    });

  return {
    status: "ready",
    sender: Object.freeze({
      version,
      destination,
      capabilities: Object.freeze([...REQUIRED_SENDER_CAPABILITIES]),
      send,
    }),
  };
}
