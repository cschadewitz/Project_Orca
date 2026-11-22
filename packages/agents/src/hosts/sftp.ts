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
  packet(): Buffer {
    const body = Buffer.concat(this.parts);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, body]);
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

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
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
    for (const p of this.pending.values()) p.reject(e);
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
    if (r.type === SSH_FXP_DATA) return r.data;
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
      this.pending.set(id, { resolve, reject });
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
    this.pending.delete(id);
    switch (type) {
      case SSH_FXP_STATUS: {
        const status = r.u32();
        // Version 3 servers send a message and language tag; very old ones may omit them.
        const message = r.remaining >= 4 ? r.str() : "";
        p.resolve({ type, status, message });
        return;
      }
      case SSH_FXP_HANDLE:
        p.resolve({ type, handle: Buffer.from(r.bytes()) });
        return;
      case SSH_FXP_DATA:
        p.resolve({ type, data: Buffer.from(r.bytes()) });
        return;
      case SSH_FXP_ATTRS:
        p.resolve({ type, attrs: r.attrs() });
        return;
      default:
        throw new SftpConnectionError(`unexpected sftp packet type ${type}`);
    }
  }
}

/**
 * Read a whole file: open and stat together, then keep `WINDOW` reads of
 * `CHUNK` bytes in flight. A short read re-requests the gap; reading past the
 * stat size continues if the file grew. The close is not awaited.
 */
export async function readAll(c: SftpClient, path: string): Promise<Buffer> {
  const [handle, attrs] = await Promise.all([c.open(path, SSH_FXF_READ), c.stat(path).catch((): SftpAttrs => ({}))]);
  try {
    const chunks = new Map<number, Buffer>();
    let eofAt = Infinity;
    const hint = attrs.size ?? 0;
    const queue: Array<[number, number]> = [];
    for (let off = 0; off < hint; off += CHUNK) queue.push([off, Math.min(CHUNK, hint - off)]);
    queue.push([hint, CHUNK]); // confirms EOF, or picks up growth
    let next = hint + CHUNK;
    await new Promise<void>((resolve, reject) => {
      let inflight = 0;
      let failed = false;
      const pump = (): void => {
        while (!failed && inflight < WINDOW && queue.length) {
          const [off, len] = queue.shift()!;
          if (off >= eofAt) continue;
          inflight++;
          c.read(handle, off, len).then(
            (data) => {
              inflight--;
              if (data === null || data.length === 0) {
                eofAt = Math.min(eofAt, off);
              } else {
                chunks.set(off, data);
                if (data.length < len) queue.push([off + data.length, len - data.length]);
                else if (off + len === next) {
                  // The tail read came back full: the file is longer than the stat said.
                  queue.push([next, CHUNK]);
                  next += CHUNK;
                }
              }
              if (inflight === 0 && !queue.some(([o]) => o < eofAt)) resolve();
              else pump();
            },
            (e: unknown) => {
              failed = true;
              reject(e instanceof Error ? e : new Error(String(e)));
            },
          );
        }
        if (!failed && inflight === 0 && !queue.some(([o]) => o < eofAt)) resolve();
      };
      pump();
    });
    const ordered = [...chunks.entries()].filter(([o]) => o < eofAt).sort((a, b) => a[0] - b[0]);
    const out: Buffer[] = [];
    let at = 0;
    for (const [o, d] of ordered) {
      if (o > at) throw new SftpStatusError(SSH_FX_FAILURE, `sftp read left a gap at offset ${at}`);
      if (o + d.length <= at) continue;
      out.push(d.subarray(at - o));
      at = o + d.length;
    }
    return Buffer.concat(out);
  } finally {
    c.close(handle).catch(() => {});
  }
}

/** Write `data` to an open handle with `WINDOW` writes of `CHUNK` bytes in flight. */
export async function writeAll(c: SftpClient, handle: Buffer, data: Buffer): Promise<void> {
  const offsets: number[] = [];
  for (let off = 0; off < data.length; off += CHUNK) offsets.push(off);
  let i = 0;
  const lane = async (): Promise<void> => {
    while (i < offsets.length) {
      const off = offsets[i++]!;
      await c.write(handle, off, data.subarray(off, off + CHUNK));
    }
  };
  await Promise.all(Array.from({ length: Math.min(WINDOW, offsets.length) }, lane));
}
