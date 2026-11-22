/**
 * A small SFTP v3 server over stdin/stdout against the local file system, so
 * `SshHost`'s SFTP path is tested without sshd (and on Windows).
 *
 * Environment knobs for failure tests:
 * - FAKE_SFTP_REFUSE=1      exit before answering INIT (no sftp subsystem)
 * - FAKE_SFTP_DROP_AFTER=n  exit after answering n requests (a dropped session)
 * - FAKE_SFTP_COUNT_FILE=p  append one line per started session to p
 * - FAKE_SFTP_HANG_AFTER=n  stop answering (but stay up) after n requests
 * - FAKE_SFTP_MALFORMED_AFTER=n  answer request n+1 with a truncated ATTRS reply
 * - FAKE_SFTP_STAT_SIZE=n   report every STAT size as n (a lying or stale size)
 * - FAKE_SFTP_WRITE_FAIL_AT=n  fail every WRITE at offset >= n with "No space left on device"
 * - FAKE_SFTP_LOG=p         append "write <offset>", "close" and "write-after-close" lines to p
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";

const FXP = { INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, FSTAT: 8, MKDIR: 14, STAT: 17 };
const STATUS = 101,
  HANDLE = 102,
  DATA = 103,
  ATTRS = 105;
const FX_OK = 0,
  FX_EOF = 1,
  FX_NO_SUCH_FILE = 2,
  FX_PERMISSION_DENIED = 3,
  FX_FAILURE = 4;

if (process.env.FAKE_SFTP_COUNT_FILE) appendFileSync(process.env.FAKE_SFTP_COUNT_FILE, "session\n");
if (process.env.FAKE_SFTP_REFUSE) {
  process.stderr.write("subsystem request failed on channel 0\n");
  process.exit(1);
}
let dropAfter = Number(process.env.FAKE_SFTP_DROP_AFTER ?? Infinity);
let hangAfter = Number(process.env.FAKE_SFTP_HANG_AFTER ?? Infinity);
let malformedAfter = Number(process.env.FAKE_SFTP_MALFORMED_AFTER ?? Infinity);
const statSize = process.env.FAKE_SFTP_STAT_SIZE === undefined ? undefined : Number(process.env.FAKE_SFTP_STAT_SIZE);
const writeFailAt = Number(process.env.FAKE_SFTP_WRITE_FAIL_AT ?? Infinity);
const log = (line: string) => {
  if (process.env.FAKE_SFTP_LOG) appendFileSync(process.env.FAKE_SFTP_LOG, `${line}\n`);
};
const closedHandles = new Set<string>();

const handles = new Map<string, number>();
let nextHandle = 1;

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const str = (b: Buffer | string) => {
  const v = typeof b === "string" ? Buffer.from(b) : b;
  return Buffer.concat([u32(v.length), v]);
};
const send = (...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  process.stdout.write(Buffer.concat([u32(body.length), body]));
};
const status = (id: number, code: number, msg: string) =>
  send(Buffer.from([STATUS]), u32(id), u32(code), str(msg), str(""));
const attrs = (st: { size: number; mode: number }) => {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(st.size));
  return Buffer.concat([u32(0x1 | 0x4), size, u32(st.mode)]);
};
const errStatus = (id: number, e: NodeJS.ErrnoException) =>
  status(
    id,
    e.code === "ENOENT" || e.code === "ENOTDIR"
      ? FX_NO_SUCH_FILE
      : e.code === "EACCES"
        ? FX_PERMISSION_DENIED
        : FX_FAILURE,
    e.code === "ENOENT" ? "No such file" : (e.message ?? "Failure"),
  );

let buf = Buffer.alloc(0);
process.stdin.on("data", (d: Buffer) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) return;
    const p = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    handle(p);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(p: Buffer): void {
  let off = 0;
  const rd32 = () => ((off += 4), p.readUInt32BE(off - 4));
  const rd64 = () => ((off += 8), Number(p.readBigUInt64BE(off - 8)));
  const rdBytes = () => {
    const n = rd32();
    off += n;
    return p.subarray(off - n, off);
  };
  const type = p[off++]!;
  if (type === FXP.INIT) {
    send(Buffer.from([FXP.VERSION]), u32(3));
    return;
  }
  const id = rd32();
  if (dropAfter-- <= 0) process.exit(1);
  if (hangAfter-- <= 0) return;
  if (malformedAfter-- <= 0) {
    // ATTRS that promises a size and then ends: undecodable.
    send(Buffer.from([ATTRS]), u32(id), u32(0x1));
    return;
  }
  try {
    switch (type) {
      case FXP.OPEN: {
        const path = rdBytes().toString();
        const pflags = rd32();
        const flags = pflags & 0x02 ? (pflags & 0x10 ? "w" : "r+") : "r";
        const fd = openSync(path, flags === "r+" && pflags & 0x08 ? "a+" : flags);
        const h = String(nextHandle++);
        handles.set(h, fd);
        send(Buffer.from([HANDLE]), u32(id), str(h));
        return;
      }
      case FXP.CLOSE: {
        const h = rdBytes().toString();
        const fd = handles.get(h);
        if (fd === undefined) return status(id, FX_FAILURE, "bad handle");
        handles.delete(h);
        closedHandles.add(h);
        log("close");
        closeSync(fd);
        return status(id, FX_OK, "");
      }
      case FXP.READ: {
        const fd = handles.get(rdBytes().toString())!;
        const at = rd64();
        const n = rd32();
        const out = Buffer.alloc(n);
        const got = readSync(fd, out, 0, n, at);
        if (got === 0) return status(id, FX_EOF, "EOF");
        send(Buffer.from([DATA]), u32(id), str(out.subarray(0, got)));
        return;
      }
      case FXP.WRITE: {
        const h = rdBytes().toString();
        const fd = handles.get(h);
        const at = rd64();
        const data = rdBytes();
        if (fd === undefined) {
          if (closedHandles.has(h)) log("write-after-close");
          return status(id, FX_FAILURE, "bad handle");
        }
        log(`write ${at}`);
        if (at >= writeFailAt) return status(id, FX_FAILURE, "No space left on device");
        writeSync(fd, data, 0, data.length, at);
        return status(id, FX_OK, "");
      }
      case FXP.FSTAT: {
        const st = fstatSync(handles.get(rdBytes().toString())!);
        send(Buffer.from([ATTRS]), u32(id), attrs(st));
        return;
      }
      case FXP.STAT: {
        const st = statSync(rdBytes().toString());
        send(Buffer.from([ATTRS]), u32(id), attrs(statSize === undefined ? st : { size: statSize, mode: st.mode }));
        return;
      }
      case FXP.MKDIR: {
        mkdirSync(rdBytes().toString());
        return status(id, FX_OK, "");
      }
      default:
        return status(id, 8, "unsupported");
    }
  } catch (e) {
    errStatus(id, e as NodeJS.ErrnoException);
  }
}
