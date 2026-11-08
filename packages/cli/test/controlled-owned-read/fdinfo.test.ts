/** Source-owned query grammar and cleanup only; no installed qualification. */
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { assertControlledLifetimeFdinfo } from "./producer.js";

const lifetime = 37,
  query = 71;
const locked =
  "pos:\t0\nflags:\t02100002\nmnt_id:\t30\nino:\t123\nlock:\t1: FLOCK  ADVISORY  WRITE 42 00:01:123 0 EOF\n";
afterEach(() => vi.restoreAllMocks());
function fixture(parts: string[]) {
  const info = fs.statSync(import.meta.filename, { bigint: true });
  const order: string[] = [];
  const requests: number[] = [];
  const open = vi.spyOn(fs, "openSync").mockImplementation(() => {
    order.push("open");
    return query;
  });
  const stat = vi.spyOn(fs, "fstatSync").mockImplementation(() => {
    order.push("stat");
    return info;
  });
  const chunks = parts.map((part) => Buffer.from(part));
  const read = vi.spyOn(fs, "readSync").mockImplementation(((
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    count: number,
    position: number | null,
  ) => {
    order.push("read");
    requests.push(count);
    expect(descriptor).toBe(query);
    expect(position).toBeNull();
    expect(count).toBeGreaterThan(0);
    expect(offset + count).toBe(4097);
    const chunk = chunks.shift() ?? Buffer.alloc(0),
      copied = Math.min(count, chunk.length);
    Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(chunk.subarray(0, copied), offset);
    if (copied < chunk.length) chunks.unshift(chunk.subarray(copied));
    return copied;
  }) as typeof fs.readSync);
  const close = vi.spyOn(fs, "closeSync").mockImplementation(() => {
    order.push("close");
  });
  return { info, order, requests, open, stat, read, close };
}
it("identifies the opened query before bounded same-descriptor reads, requires EOF and closes it", () => {
  const f = fixture([locked.slice(0, 21), locked.slice(21)]);
  expect(assertControlledLifetimeFdinfo(lifetime)).toBeUndefined();
  expect(f.open).toHaveBeenCalledExactlyOnceWith(
    `/proc/self/fdinfo/${lifetime}`,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  expect(f.stat).toHaveBeenCalledExactlyOnceWith(query, { bigint: true });
  expect(f.order).toEqual(["open", "stat", "read", "read", "read", "close"]);
  expect(f.requests).toEqual([4097, 4097 - 21, 4097 - Buffer.byteLength(locked)]);
  expect(f.close).toHaveBeenCalledExactlyOnceWith(query);
});
it("accepts the full 4096-byte bound only after a one-byte EOF probe", () => {
  const f = fixture([locked + " ".repeat(4096 - Buffer.byteLength(locked))]);
  assertControlledLifetimeFdinfo(lifetime);
  expect(f.requests).toEqual([4097, 1]);
  expect(f.close).toHaveBeenCalledExactlyOnceWith(query);
});
it.each([
  ["single read", [locked + " ".repeat(4097 - Buffer.byteLength(locked))]],
  ["short prefix read", [locked, " ".repeat(4097 - Buffer.byteLength(locked))]],
] as const)("refuses oversized content after a valid flock prefix (%s)", (_name, parts) => {
  const f = fixture([...parts]);
  expect(() => assertControlledLifetimeFdinfo(lifetime)).toThrow("exceeds 4096 bytes");
  expect(f.read).toHaveBeenCalledTimes(parts.length);
  expect(f.close).toHaveBeenCalledExactlyOnceWith(query);
});

it.each(["", "pos:\t0\n", locked.replace("WRITE", "READ")])(
  "a physical stat alone cannot prove flock ownership (%j)",
  (bytes) => {
    const f = fixture([bytes]);
    expect(() => assertControlledLifetimeFdinfo(lifetime)).toThrow();
    expect(f.stat).toHaveBeenCalledExactlyOnceWith(query, { bigint: true });
    expect(f.read).toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(query);
  },
);
it.each(["stat", "read"] as const)(
  "closes the query after a %s error without closing the lifetime descriptor",
  (operation) => {
    const f = fixture([locked]),
      error = new Error(`injected ${operation} failure`);
    f[operation].mockImplementation(() => {
      throw error;
    });
    expect(() => assertControlledLifetimeFdinfo(lifetime)).toThrow(error);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(query);
    if (operation === "stat") expect(f.read).not.toHaveBeenCalled();
  },
);
it("does not close a nonexistent query when open fails", () => {
  const f = fixture([locked]),
    error = new Error("injected open failure");
  f.open.mockImplementation(() => {
    throw error;
  });
  expect(() => assertControlledLifetimeFdinfo(lifetime)).toThrow(error);
  expect(f.stat).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
});
it.each([
  ["nonregular", false, 1n],
  ["zero inode", true, 0n],
] as const)("refuses invalid physical query metadata before any content read (%s)", (_name, regular, ino) => {
  const f = fixture([locked]);
  f.stat.mockReturnValue({ ...f.info, isFile: () => regular, ino });
  expect(() => assertControlledLifetimeFdinfo(lifetime)).toThrow("not a physical regular file");
  expect(f.read).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledExactlyOnceWith(query);
});

it("propagates close failure rather than reporting successful query completion", () => {
  const f = fixture([locked]),
    error = new Error("injected close failure");
  f.close.mockImplementation(() => {
    throw error;
  });
  expect(() => assertControlledLifetimeFdinfo(lifetime)).toThrow(error);
  expect(f.close).toHaveBeenCalledExactlyOnceWith(query);
});
it.each([0, 2, -1, 3.5, NaN, Infinity])("refuses an invalid lifetime descriptor before opening a query (%s)", (fd) => {
  const f = fixture([locked]);
  expect(() => assertControlledLifetimeFdinfo(fd)).toThrow();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
});
