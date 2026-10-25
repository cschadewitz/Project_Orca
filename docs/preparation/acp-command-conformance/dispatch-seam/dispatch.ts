/** #594 OFFLINE ONLY. Source-correspondent native transport seam; no provider startup. */
import { AsyncLocalStorage } from "node:async_hooks";
import * as rpc from "vscode-jsonrpc/node";
import type { NativeCommandRequest, NativeResponse } from "./native-request.ts";

const METHOD = "item/commandExecution/requestApproval";
const MAX_CALLBACKS = 256;
const MAX_REQUEST_BYTES = 256 * 1024;
type WriteState = "unattempted" | "write-returned" | "uncertain" | "suppressed";
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export interface PendingCommand {
  readonly connectionIncarnation: object;
  readonly callback: object;
  readonly request: DeepReadonly<NativeCommandRequest>;
  readonly signal: AbortSignal;
  /** Settles THIS onRequest promise. True means claimed locally, never delivered/acknowledged. */
  respond(response: NativeResponse): boolean;
  cancel(): void;
  status(): { claimed: boolean; write: WriteState; remoteAcknowledged: false };
  /** No reviewed native release has the required completeness/environment descriptor. */
  exactCommand(): { state: "unsupported"; options: []; reason: "native-descriptor-unavailable" };
}

function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

interface Entry {
  original: rpc.RequestMessage;
  request: DeepReadonly<NativeCommandRequest>;
  callback: object;
  controller: AbortController;
  phase: "received" | "pending" | "settled";
  resolve?: (response: NativeResponse) => void;
  attempted: boolean;
  write: WriteState;
}

const dispatches = new WeakMap<rpc.MessageConnection, ReturnType<typeof createCommandDispatch>>();

export function commandDispatchFor(connection: rpc.MessageConnection) {
  const dispatch = dispatches.get(connection);
  if (!dispatch) throw new Error("NATIVE_DISPATCH_UNAVAILABLE");
  return dispatch;
}

/**
 * Install at CodexJsonRpcConnection's createMessageConnection, BEFORE listen().
 * MessageStrategy invokes the ORIGINAL library next(message); ALS carries that
 * dispatch frame into onRequest. There is no observation/params equality lookup.
 * The promise resolver created in onRequest feeds the library's original reply closure.
 */
export function createCommandDispatch(reader: rpc.MessageReader, writer: rpc.MessageWriter) {
  const connectionIncarnation = Object.freeze({});
  const storage = new AsyncLocalStorage<Entry>();
  const messages = new WeakMap<rpc.Message, Entry>();
  const entries = new Map<string | number, Entry>();
  // 9.0.1's inbound queue stringifies IDs. Reject numeric/string aliases at intake,
  // before they could overwrite an undispatched request in that library queue.
  const queueIds = new Set<string>();
  let closed = false;
  let registered = false;

  function cancel(entry: Entry) {
    entry.controller.abort();
    if (entry.phase === "pending") {
      entry.phase = "settled";
      entry.resolve!({ decision: "cancel" });
    }
  }

  function invalidate() {
    if (closed) return;
    closed = true;
    for (const entry of entries.values()) cancel(entry);
  }

  const guardedReader: rpc.MessageReader = {
    onError: reader.onError,
    onClose: reader.onClose,
    onPartialMessage: reader.onPartialMessage,
    dispose: () => reader.dispose(),
    listen: (callback) =>
      reader.listen((message) => {
        if (closed) return;
        if (rpc.Message.isRequest(message)) {
          const id = message.id;
          if (
            !((typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isSafeInteger(id))) ||
            queueIds.size >= MAX_CALLBACKS ||
            queueIds.has(String(id)) ||
            Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES ||
            (message.method === METHOD &&
              (message.params === null || typeof message.params !== "object" || Array.isArray(message.params)))
          ) {
            // Malformed/reused ID or bounded-capacity exhaustion ends the incarnation.
            // Never synthesize a second reply for a duplicate request ID.
            invalidate();
            connection.dispose();
            return;
          }
          queueIds.add(String(id));
          if (message.method !== METHOD) {
            callback(message);
            return;
          }
          // Native verified transport only; this is not a general untrusted-wire parser.
          // Snapshot every original property, including experimental/unknown fields.
          const entry: Entry = {
            original: message,
            request: freeze(structuredClone(message) as NativeCommandRequest),
            callback: Object.freeze({}),
            controller: new AbortController(),
            phase: "received",
            attempted: false,
            write: "unattempted",
          };
          entries.set(id, entry);
          messages.set(message, entry);
        }
        callback(message);
      }),
  };

  const guardedWriter: rpc.MessageWriter = {
    onError: writer.onError,
    onClose: writer.onClose,
    end: () => {
      invalidate();
      writer.end();
    },
    dispose: () => {
      invalidate();
      writer.dispose();
    },
    async write(message) {
      const entry = rpc.Message.isResponse(message) && message.id !== null ? entries.get(message.id) : undefined;
      if (!entry) {
        await writer.write(message);
        return;
      }
      // The library catches a failed result write and tries replyError. Suppress that
      // second attempt too: the first write may already have reached the native peer.
      if (entry.attempted) return;
      entry.attempted = true;
      if (closed) {
        entry.write = "suppressed";
        return;
      }
      const outgoing = entry.controller.signal.aborted
        ? { jsonrpc: "2.0", id: entry.request.id, result: { decision: "cancel" } }
        : message;
      entry.write = "uncertain";
      try {
        await writer.write(outgoing);
        entry.write = "write-returned";
      } catch {
        // Sanitize the error: native params/transport errors must not become diagnostics.
        throw new Error("NATIVE_RESPONSE_UNCERTAIN");
      }
    },
  };

  const connection = rpc.createMessageConnection(guardedReader, guardedWriter, rpc.NullLogger, {
    messageStrategy: {
      handleMessage(message, next) {
        const entry = messages.get(message);
        return entry ? storage.run(entry, () => next(message)) : next(message);
      },
    },
  });
  connection.onClose(invalidate);
  connection.onDispose(invalidate);

  const dispatch = {
    connection,
    connectionIncarnation,
    onCommand(handler: (pending: PendingCommand) => void | Promise<void>) {
      if (registered) throw new Error("NATIVE_HANDLER_ALREADY_BOUND");
      registered = true;
      return connection.onRequest<NativeCommandRequest["params"], NativeResponse, void>(
        new rpc.RequestType<NativeCommandRequest["params"], NativeResponse, void>(METHOD),
        (params, token) => {
          const entry = storage.getStore();
          if (!entry || entry.phase !== "received" || entry.original.params !== params)
            throw new Error("NATIVE_DISPATCH_UNAVAILABLE");
          entry.phase = "pending";
          const result = new Promise<NativeResponse>((resolve) => {
            entry.resolve = resolve;
          });
          const pending: PendingCommand = Object.freeze({
            connectionIncarnation,
            callback: entry.callback,
            request: entry.request,
            signal: entry.controller.signal,
            respond(response: NativeResponse) {
              if (closed || entry.phase !== "pending" || entry.controller.signal.aborted) return false;
              const snapshot = structuredClone(response);
              entry.phase = "settled"; // Claim synchronously, before any library write await.
              entry.resolve!(snapshot);
              return true;
            },
            cancel: () => cancel(entry),
            status: () => ({
              claimed: entry.phase === "settled",
              write: entry.write,
              remoteAcknowledged: false as const,
            }),
            exactCommand: () => ({
              state: "unsupported" as const,
              options: [] as [],
              reason: "native-descriptor-unavailable" as const,
            }),
          });
          const cancellation = token.onCancellationRequested(() => cancel(entry));
          if (closed || token.isCancellationRequested) cancel(entry);
          if (!pending.signal.aborted) {
            Promise.resolve()
              .then(() => handler(pending))
              .catch(() => cancel(entry));
          }
          return result.finally(() => cancellation.dispose());
        },
      );
    },
  };
  dispatches.set(connection, dispatch);
  return dispatch;
}
