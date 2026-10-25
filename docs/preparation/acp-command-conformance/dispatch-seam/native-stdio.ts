// #594 offline copy of the pinned native framing functions, plus the proposed writer fix.
// Original bytes: upstream/StdUtils.ts.txt. No provider startup, ACP SDK, or traffic logging.
import { StringDecoder } from "node:string_decoder";
import { finished, type Readable, type Writable } from "node:stream";
import {
  Emitter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
  type PartialMessageInfo,
} from "vscode-jsonrpc/node";

export function createJSONRPCWriter(writable: Writable): MessageWriter {
  const writeLine = createLineWriter(writable);
  return {
    async write(msg: Message) {
      const wire: { jsonrpc?: string; [key: string]: unknown } = { ...msg };
      delete wire.jsonrpc;
      await writeLine(JSON.stringify(wire) + "\n");
    },
    end() {
      writable.end();
    },
    onError: new Emitter<[Error, Message | undefined, number | undefined]>().event,
    onClose: new Emitter<void>().event,
    dispose() {},
  };
}

export function createJSONRPCReader(readable: Readable): MessageReader & { deliver?: (message: Message) => void } {
  let listener: DataCallback | null = null;
  return {
    /** Hands `message` to the connection after the messages read so far. */
    deliver(message: Message) {
      listener?.(message);
    },
    listen(callback: DataCallback): Disposable {
      listener = callback;
      const onLine = (text: string) => {
        const line = text.trim();
        if (!line) return;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch (_error) {
          // A lost line can be a lost response, and its request then waits forever.
          // Offline prototype: do not log malformed native input or parse-error excerpts.
          return;
        }
        if (msg && typeof msg === "object" && (msg as { jsonrpc?: unknown }).jsonrpc === undefined) {
          (msg as { jsonrpc: string }).jsonrpc = "2.0";
        }
        callback(msg as Message);
      };
      const lines = new LineSplitter(onLine);
      const onData = (chunk: Buffer) => lines.push(chunk);
      const onEnd = () => lines.end();
      readable.on("data", onData);
      readable.on("end", onEnd);
      return {
        dispose() {
          readable.off("data", onData);
          readable.off("end", onEnd);
        },
      };
    },
    onError: new Emitter<Error>().event,
    onClose: new Emitter<void>().event,
    onPartialMessage: new Emitter<PartialMessageInfo>().event,
    dispose() {},
  };
}

export function createLineWriter(writable: Writable): (line: string | Uint8Array) => Promise<void> {
  let failure: Error | undefined;
  const waiting = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  const stopWatching = finished(writable, (error) => {
    stopWatching();
    // `finished` no longer listens, so a later error must not become an uncaught exception.
    writable.on("error", () => {});
    writable.off("drain", onDrain);
    failure = error ?? new Error("The output stream ended");
    for (const waiter of waiting) waiter.reject(failure);
    waiting.clear();
  });
  const onDrain = () => {
    for (const waiter of waiting) waiter.resolve();
    waiting.clear();
  };
  writable.on("drain", onDrain);
  return (line) => {
    if (failure !== undefined) return Promise.reject(failure);
    if (writable.write(line)) return Promise.resolve();
    return new Promise((resolve, reject) => waiting.add({ resolve, reject }));
  };
}

class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  /** The parts of the line whose end has not arrived yet. */
  private parts: string[] = [];

  private readonly onLine: (line: string) => void;
  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      this.parts.push(text.slice(start, end));
      const line = this.parts.join("");
      this.parts = [];
      start = end + 1;
      this.onLine(line);
    }
    if (start < text.length) this.parts.push(text.slice(start));
  }

  end(): void {
    const rest = this.decoder.end();
    if (rest.length > 0) this.parts.push(rest);
    if (this.parts.length > 0) {
      const line = this.parts.join("");
      this.parts = [];
      this.onLine(line);
    }
  }
}
