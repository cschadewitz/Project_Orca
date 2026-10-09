/** Exact rendering storage and cancellation regressions; no device acceptance. */
import { expect, it, vi } from "vitest";
import { DiagnosticPreviewOwner } from "../src/diagnostics/preview-owner.js";
import type { DiagnosticPreview, DiagnosticPreviewBlock, DiagnosticsResult } from "../../src/diagnostics-contract.js";

const preview = (byteLength: number): DiagnosticPreview => ({
  handle: "synthetic",
  byteLength,
  source: "current",
  expiresInMs: 300_000,
  tailLossPossible: false,
});
const ok = <T>(value: T): DiagnosticsResult<T> => ({ ok: true, value });

it.each([0, -1, 1_048_577, NaN, 1.5])("refuses %s-byte owners before allocating", (bytes) => {
  expect(() => new DiagnosticPreviewOwner(preview(bytes))).toThrow("capacity_limited");
});

it("keeps exact UTF-8 and newline, erases each transport copy and disposes retained storage", async () => {
  const text = "αβ\nexact final newline\n",
    bytes = new TextEncoder().encode(text);
  const owner = new DiagnosticPreviewOwner(preview(bytes.length));
  const copy = bytes.slice();
  const releasePreviewBlock = vi.fn(async () => {
    expect(copy.byteLength).toBe(0);
    return ok(true);
  });
  await owner.read({
    readPreviewBlock: async () => ok({ handle: "synthetic", offset: 0, bytes: copy }),
    releasePreviewBlock,
  });
  expect(owner.bytes).toEqual(bytes);
  expect(owner.blocks.join("")).toBe(text);
  expect(releasePreviewBlock).toHaveBeenCalledOnce();
  owner.dispose();
  expect(owner.bytes.byteLength).toBe(0);
  expect(owner.blocks).toEqual([]);
  expect(() => owner.dispose()).not.toThrow();
});

it("erases plaintext before retiring its backing store and retains zeroed fallback storage", () => {
  const owner = new DiagnosticPreviewOwner(preview(4));
  owner.bytes.fill(120);
  const backing = owner.bytes.buffer as ArrayBuffer & { transferToFixedLength: (length: number) => ArrayBuffer };
  const transfer = backing.transferToFixedLength.bind(backing);
  const retire = vi.spyOn(backing, "transferToFixedLength").mockImplementation((length) => {
    expect(owner.bytes.every((byte) => byte === 0)).toBe(true);
    return transfer(length);
  });
  owner.dispose();
  expect(retire).toHaveBeenCalledWith(0);
  expect(owner.bytes.byteLength).toBe(0);
  retire.mockRestore();
  const fallback = new DiagnosticPreviewOwner(preview(4));
  fallback.bytes.fill(120);
  Object.defineProperty(fallback.bytes.buffer, "transferToFixedLength", { value: undefined });
  fallback.dispose();
  expect(fallback.bytes.every((byte) => byte === 0)).toBe(true);
  expect(fallback.blocks).toEqual([]);
});

it.each(["offset", "handle", "length", "utf8"])("erases owner and transport on malformed %s replies", async (kind) => {
  const owner = new DiagnosticPreviewOwner(preview(2));
  const block = {
    handle: kind === "handle" ? "old" : "synthetic",
    offset: kind === "offset" ? 1 : 0,
    bytes: new Uint8Array(kind === "length" ? [1, 2, 3] : kind === "utf8" ? [255, 10] : [120, 10]),
  };
  const releasePreviewBlock = vi.fn(async () => ok(true));
  await expect(owner.read({ readPreviewBlock: async () => ok(block), releasePreviewBlock })).rejects.toThrow();
  expect(block.bytes.byteLength).toBe(0);
  expect(owner.bytes.byteLength).toBe(0);
  expect(owner.blocks).toEqual([]);
  expect(releasePreviewBlock).toHaveBeenCalledOnce();
});

it("disposes a late copy after cancellation without restoring text or reading a successor block", async () => {
  const owner = new DiagnosticPreviewOwner(preview(2));
  let resolve!: (block: DiagnosticsResult<DiagnosticPreviewBlock>) => void;
  const readPreviewBlock = vi.fn(
    () =>
      new Promise<DiagnosticsResult<DiagnosticPreviewBlock>>((r) => {
        resolve = r;
      }),
  );
  const releasePreviewBlock = vi.fn(async () => ok(true));
  const pending = owner.read({ readPreviewBlock, releasePreviewBlock });
  const rejected = expect(pending).rejects.toThrow("stale_preview");
  owner.dispose();
  const bytes = new Uint8Array([120, 10]);
  resolve(ok({ handle: "synthetic", offset: 0, bytes }));
  await rejected;
  expect(bytes.byteLength).toBe(0);
  expect(owner.blocks).toEqual([]);
  expect(readPreviewBlock).toHaveBeenCalledOnce();
  expect(releasePreviewBlock).toHaveBeenCalledOnce();
});
