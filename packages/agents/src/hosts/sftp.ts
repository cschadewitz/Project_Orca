/**
 * A minimal SFTP (protocol version 3) client over a byte stream.
 *
 * `SshHost` opens it on `ssh -s <host> sftp`, so the channel inherits
 * everything the operator configured for the ACP transport (ssh config, keys,
 * ProxyJump, BatchMode) and needs nothing beyond the server's stock
 * `sftp-server`. Only what `HostFileSystem` uses is implemented: open, read,
 * write, close, stat and mkdir.
 *
 * Requests are pipelined: every call gets an id and any number may be in
 * flight, so a batch of stats or the read window of a large file costs round
 * trips, not processes. Replies are matched by id. Incoming packets are bounded
 * (`MAX_PACKET`), so a confused or hostile peer cannot make us buffer without
 * limit.
 */
import { constants as bufferConstants } from "node:buffer";
import type { Readable, Writable } from "node:stream";

const SSH_FXP_INIT = 1;
const SSH_FXP_VERSION = 2;
const SSH_FXP_OPEN = 3;
const SSH_FXP_CLOSE = 4;
const SSH_FXP_READ = 5;
const SSH_FXP_WRITE = 6;
const SSH_FXP_FSTAT = 8;
const SSH_FXP_MKDIR = 14;
const SSH_FXP_STAT = 17;
const SSH_FXP_STATUS = 101;
const SSH_FXP_HANDLE = 102;
const SSH_FXP_DATA = 103;
const SSH_FXP_ATTRS = 105;

export const SSH_FX_OK = 0;
export const SSH_FX_EOF = 1;
export const SSH_FX_NO_SUCH_FILE = 2;
export const SSH_FX_PERMISSION_DENIED = 3;
export const SSH_FX_FAILURE = 4;

export const SSH_FXF_READ = 0x01;
export const SSH_FXF_WRITE = 0x02;
export const SSH_FXF_CREAT = 0x08;
export const SSH_FXF_TRUNC = 0x10;

const ATTR_SIZE = 0x1;
const ATTR_UIDGID = 0x2;
const ATTR_PERMISSIONS = 0x4;
const ATTR_ACMODTIME = 0x8;
const ATTR_EXTENDED = 0x80000000;

/** Bytes asked for per READ / sent per WRITE: the size every server must accept. */
export const CHUNK = 32 * 1024;
/** Requests kept in flight while streaming one file. */
export const WINDOW = 64;
/** Largest incoming packet accepted: a full CHUNK of data plus generous headroom. */
export const MAX_PACKET = 256 * 1024;
/**
 * Largest file `readAll` will buffer. `HostFileSystem.readFile` returns a string,
 * so the per-command path was already bounded by V8's string limit; a UTF-8
 * buffer no longer than that always decodes, so it is the same limit here,
 * enforced before reading rather than after.
 */
export const MAX_READ_BYTES = bufferConstants.MAX_STRING_LENGTH;
/** A request with no reply after this long fails the whole session (see `SftpClientOptions`). */
export const REQUEST_TIMEOUT_MS = 60_000;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

export interface SftpAttrs {
  size?: number;
  permissions?: number;
}

export function isDirectory(a: SftpAttrs): boolean {
  return a.permissions !== undefined && (a.permissions & S_IFMT) === S_IFDIR;
}

/** The server answered with a non-OK status. */
export class SftpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message || `sftp status ${status}`);
    this.name = "SftpStatusError";
  }
}

/** The channel went away (process exit, stream error, malformed packet) with requests outstanding. */
export class SftpConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SftpConnectionError";
  }
}

type Reply =
  | { type: typeof SSH_FXP_STATUS; status: number; message: string }
  | { type: typeof SSH_FXP_HANDLE; handle: Buffer }
  | { type: typeof SSH_FXP_DATA; data: Buffer }
  | { type: typeof SSH_FXP_ATTRS; attrs: SftpAttrs };

interface Pending {
  resolve(r: Reply): void;
  reject(e: Error): void;
  timer?: NodeJS.Timeout;
}

export interface SftpClientOptions {
  /**
   * Deadline for every request after the handshake. One that passes fails the
   * session, which settles every waiter with `SftpConnectionError`; a server
   * that stops answering cannot leave an operation (and so the session) busy
   * for ever. Default `REQUEST_TIMEOUT_MS`.
   */
  requestTimeoutMs?: number;
}

class Writer {
  private parts: Buffer[] = [];
  byte(n: number): this {
    this.parts.push(Buffer.from([n]));
    return this;
  }
  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    this.parts.push(b);
    return this;
  }
  u64(n: number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    this.parts.push(b);
    return this;
  }
  str(s: string | Buffer): this {
    const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
    this.u32(b.length);
    this.parts.push(b);
    return this;
  }
  /** Length-prefixed packet in one allocation: a WRITE's data is copied once, not three times. */
  packet(): Buffer {
    const length = this.parts.reduce((n, b) => n + b.length, 0);
    const out = Buffer.allocUnsafe(4 + length);
    out.writeUInt32BE(length, 0);
    let at = 4;
    for (const b of this.parts) at += b.copy(out, at);
    return out;
  }
}

class Reader {
  private off = 0;
  constructor(private readonly b: Buffer) {}
  private need(n: number): void {
    if (this.off + n > this.b.length) throw new SftpConnectionError("malformed sftp packet");
  }
  byte(): number {
    this.need(1);
    return this.b[this.off++]!;
  }
  u32(): number {
    this.need(4);
    const v = this.b.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  u64(): number {
    this.need(8);
    const v = this.b.readBigUInt64BE(this.off);
    this.off += 8;
    return Number(v);
  }
  bytes(): Buffer {
    const n = this.u32();
    this.need(n);
    const v = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }
  str(): string {
    return this.bytes().toString("utf8");
  }
  attrs(): SftpAttrs {
    const flags = this.u32();
    const a: SftpAttrs = {};
    if (flags & ATTR_SIZE) a.size = this.u64();
    if (flags & ATTR_UIDGID) this.skip(8);
    if (flags & ATTR_PERMISSIONS) a.permissions = this.u32();
    if (flags & ATTR_ACMODTIME) this.skip(8);
    if (flags & ATTR_EXTENDED) {
      const n = this.u32();
      for (let i = 0; i < 2 * n; i++) this.bytes();
    }
    return a;
  }
  skip(n: number): void {
    this.need(n);
    this.off += n;
  }
  get remaining(): number {
    return this.b.length - this.off;
  }
}

/**
 * One SFTP session over `input` (server -> us) and `output` (us -> server).
 * The owner supplies the streams and decides what to do when `closed` settles.
 */
export class SftpClient {
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private version: Pending | undefined;
  private failure: SftpConnectionError | undefined;
  /** Settles once the session can no longer be used; never rejects. */
  readonly closed: Promise<SftpConnectionError>;
  private markClosed!: (e: SftpConnectionError) => void;

  private readonly requestTimeoutMs: number;

  constructor(
    input: Readable,
    private readonly output: Writable,
    options: SftpClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.closed = new Promise((r) => (this.markClosed = r));
    // The owner reports the end of the channel through `fail`, with whatever
    // diagnostics it has (an ssh process's stderr, say).
    input.on("data", (d: Buffer) => this.onData(d));
    input.on("error", (e) => this.fail(new SftpConnectionError(`sftp channel error: ${e.message}`, { cause: e })));
    output.on("error", (e) => this.fail(new SftpConnectionError(`sftp channel error: ${e.message}`, { cause: e })));
  }

  get isClosed(): boolean {
    return this.failure !== undefined;
  }

  /** Send INIT and wait for VERSION. Rejects with `SftpConnectionError` if the channel dies first. */
  init(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.version = {
        resolve: (r) => resolve((r as unknown as { version: number }).version),
        reject,
      };
      this.send(new Writer().byte(SSH_FXP_INIT).u32(3).packet());
    });
  }

  /** Fail every outstanding request and refuse new ones. Idempotent. */
  fail(e: SftpConnectionError): void {
    if (this.failure) return;
    this.failure = e;
    this.version?.reject(e);
    this.version = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.markClosed(e);
  }

  async open(path: string, pflags: number): Promise<Buffer> {
    const r = await this.request(SSH_FXP_OPEN, (w) => w.str(path).u32(pflags).u32(0));
    if (r.type === SSH_FXP_HANDLE) return r.handle;
    throw this.unexpected(r);
  }

  async close(handle: Buffer): Promise<void> {
    this.expectOk(await this.request(SSH_FXP_CLOSE, (w) => w.str(handle)));
  }

  /** Data at `offset`, or `null` at end of file. */
  async read(handle: Buffer, offset: number, length: number): Promise<Buffer | null> {
    const r = await this.request(SSH_FXP_READ, (w) => w.str(handle).u64(offset).u32(length));
    if (r.type === SSH_FXP_DATA) {
      if (r.data.length <= length) return r.data;
      // More than was asked for: the stream can no longer be trusted.
      const e = new SftpConnectionError(`sftp server returned ${r.data.length} bytes for a ${length}-byte read`);
      this.fail(e);
      throw e;
    }
    if (r.type === SSH_FXP_STATUS && r.status === SSH_FX_EOF) return null;
    throw this.unexpected(r);
  }

  async write(handle: Buffer, offset: number, data: Buffer): Promise<void> {
    this.expectOk(await this.request(SSH_FXP_WRITE, (w) => w.str(handle).u64(offset).str(data)));
  }

  async stat(path: string): Promise<SftpAttrs> {
    const r = await this.request(SSH_FXP_STAT, (w) => w.str(path));
    if (r.type === SSH_FXP_ATTRS) return r.attrs;
    throw this.unexpected(r);
  }

  async fstat(handle: Buffer): Promise<SftpAttrs> {
    const r = await this.request(SSH_FXP_FSTAT, (w) => w.str(handle));
    if (r.type === SSH_FXP_ATTRS) return r.attrs;
    throw this.unexpected(r);
  }

  async mkdir(path: string): Promise<void> {
    this.expectOk(await this.request(SSH_FXP_MKDIR, (w) => w.str(path).u32(0)));
  }

  private request(type: number, body: (w: Writer) => Writer): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const id = this.nextId;
      this.nextId = (this.nextId + 1) >>> 0 || 1;
      const timer = setTimeout(
        () => this.fail(new SftpConnectionError(`sftp request timed out after ${this.requestTimeoutMs} ms`)),
        this.requestTimeoutMs,
      );
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send(body(new Writer().byte(type).u32(id)).packet());
    });
  }

  private send(packet: Buffer): void {
    try {
      this.output.write(packet);
    } catch (e) {
      this.fail(new SftpConnectionError(`sftp channel error: ${(e as Error).message}`, { cause: e }));
    }
  }

  private expectOk(r: Reply): void {
    if (r.type === SSH_FXP_STATUS && r.status === SSH_FX_OK) return;
    throw this.unexpected(r);
  }

  private unexpected(r: Reply): Error {
    if (r.type === SSH_FXP_STATUS) return new SftpStatusError(r.status, r.message);
    return new SftpStatusError(SSH_FX_FAILURE, `unexpected sftp reply type ${r.type}`);
  }

  private onData(chunk: Buffer): void {
    if (this.failure) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > MAX_PACKET) {
        this.fail(new SftpConnectionError(`sftp packet of ${len} bytes exceeds the ${MAX_PACKET}-byte bound`));
        return;
      }
      if (this.buf.length < 4 + len) return;
      const packet = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        this.dispatch(packet);
      } catch (e) {
        this.fail(e instanceof SftpConnectionError ? e : new SftpConnectionError(String(e)));
        return;
      }
    }
  }

  private dispatch(packet: Buffer): void {
    const r = new Reader(packet);
    const type = r.byte();
    if (type === SSH_FXP_VERSION) {
      const v = this.version;
      this.version = undefined;
      v?.resolve({ version: r.u32() } as never);
      return;
    }
    const id = r.u32();
    const p = this.pending.get(id);
    if (!p) throw new SftpConnectionError(`sftp reply for unknown request ${id}`);
    // Decode while the request is still registered: a malformed reply throws
    // here, `onData` fails the session, and that settles this waiter too.
    const reply = this.decode(type, r);
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(reply);
  }

  private decode(type: number, r: Reader): Reply {
    switch (type) {
      case SSH_FXP_STATUS: {
        const status = r.u32();
        // Version 3 servers send a message and language tag; very old ones may omit them.
        const message = r.remaining >= 4 ? r.str() : "";
        return { type, status, message };
      }
      case SSH_FXP_HANDLE:
        return { type, handle: Buffer.from(r.bytes()) };
      case SSH_FXP_DATA:
        return { type, data: Buffer.from(r.bytes()) };
      case SSH_FXP_ATTRS:
        return { type, attrs: r.attrs() };
      default:
        throw new SftpConnectionError(`unexpected sftp packet type ${type}`);
    }
  }
}

/**
 * Run `lanes` workers until they all stop, then report the failure that
 * matters. The first failure stops every lane from starting new work, and
 * nothing returns until every request already sent has settled, so a caller's
 * `close` never races a read or write still in flight on the handle. A lost
 * session wins over a status error: it is the one the caller may retry.
 */
async function runLanes(lanes: number, work: (stopped: () => boolean) => Promise<void>): Promise<void> {
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: lanes }, () =>
      work(() => failed).catch((e: unknown) => {
        failed = true;
        throw e;
      }),
    ),
  );
  const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
  if (errors.length === 0) return;
  const e = errors.find((x) => x instanceof SftpConnectionError) ?? errors[0];
  throw e instanceof Error ? e : new Error(String(e));
}

/**
 * Read a whole file: open and stat together, then `WINDOW` lanes each claim
 * the next `CHUNK`-sized slice and read it to the end (a short read asks for
 * the rest). Slices are claimed lazily, so nothing is allocated from the stat
 * size; it only says how far lanes may read ahead. Past it, one lane at a time
 * probes for growth. The size and every byte received count against
 * `maxBytes`. The handle is closed (not awaited) once every read has settled.
 */
export async function readAll(c: SftpClient, path: string, maxBytes = MAX_READ_BYTES): Promise<Buffer> {
  const [handle, attrs] = await Promise.all([c.open(path, SSH_FXF_READ), c.stat(path).catch((): SftpAttrs => ({}))]);
  try {
    const hint = attrs.size !== undefined && Number.isSafeInteger(attrs.size) && attrs.size >= 0 ? attrs.size : 0;
    if (hint > maxBytes)
      throw new SftpStatusError(SSH_FX_FAILURE, `file is ${hint} bytes, over the ${maxBytes}-byte read limit`);
    const slices: Buffer[][] = [];
    let eofAt = Infinity;
    let nextSlice = 0;
    let probing = false;
    let received = 0;
    await runLanes(Math.max(1, Math.min(WINDOW, Math.ceil(hint / CHUNK) + 1)), async (stopped) => {
      while (!stopped()) {
        const k = nextSlice;
        const start = k * CHUNK;
        if (start >= eofAt) return;
        const beyond = start >= hint;
        if (beyond && probing) return; // another lane is already looking past the stat size
        nextSlice++;
        if (beyond) probing = true;
        const parts: Buffer[] = [];
        let got = 0;
        while (got < CHUNK && start + got < eofAt && !stopped()) {
          const data = await c.read(handle, start + got, CHUNK - got);
          if (data === null || data.length === 0) {
            eofAt = Math.min(eofAt, start + got);
            break;
          }
          received += data.length;
          if (received > maxBytes)
            throw new SftpStatusError(SSH_FX_FAILURE, `file is over the ${maxBytes}-byte read limit`);
          parts.push(data);
          got += data.length;
        }
        slices[k] = parts;
        if (beyond) probing = false;
      }
    });
    const out: Buffer[] = [];
    let at = 0;
    for (let k = 0; k < slices.length && at < eofAt; k++) {
      for (const part of slices[k] ?? []) {
        const take = Math.min(part.length, eofAt - at);
        out.push(take === part.length ? part : part.subarray(0, take));
        at += take;
      }
    }
    if (at < eofAt && eofAt !== Infinity)
      throw new SftpStatusError(SSH_FX_FAILURE, `sftp read left a gap at offset ${at}`);
    return Buffer.concat(out);
  } finally {
    c.close(handle).catch(() => {});
  }
}

/**
 * Write `data` to an open handle with up to `WINDOW` writes of `CHUNK` bytes in
 * flight. On the first failure no further chunk is sent, and the call returns
 * only after every write already sent has settled, so the caller can close the
 * handle safely. Which earlier chunks landed is then unknown; callers recover
 * by rewriting the whole file (`SSH_FXF_TRUNC`), never by resuming.
 */
export async function writeAll(c: SftpClient, handle: Buffer, data: Buffer): Promise<void> {
  let next = 0;
  await runLanes(Math.min(WINDOW, Math.ceil(data.length / CHUNK)), async (stopped) => {
    while (!stopped() && next < data.length) {
      const off = next;
      next += CHUNK;
      await c.write(handle, off, data.subarray(off, off + CHUNK));
    }
  });
}
