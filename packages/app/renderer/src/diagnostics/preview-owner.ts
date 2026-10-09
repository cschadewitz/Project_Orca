/** One bounded UTF-8 owner per view; no complete report string crosses the bridge. */
import {
  DIAGNOSTIC_PREVIEW_BLOCK_BYTES,
  DIAGNOSTIC_PREVIEW_MAX_BYTES,
  type DiagnosticPreview,
  type DiagnosticsBridge,
  type DiagnosticsResult,
} from "../../../src/diagnostics-contract.js";

export class DiagnosticPreviewOwner {
  readonly bytes: Uint8Array;
  readonly blocks: string[] = [];
  private disposed = false;
  constructor(readonly preview: DiagnosticPreview) {
    if (
      !Number.isSafeInteger(preview.byteLength) ||
      preview.byteLength < 1 ||
      preview.byteLength > DIAGNOSTIC_PREVIEW_MAX_BYTES
    )
      throw new Error("capacity_limited");
    this.bytes = new Uint8Array(preview.byteLength);
  }
  dispose(): void {
    this.disposed = true;
    this.bytes.fill(0);
    this.blocks.length = 0;
  }
  async read(bridge: Pick<DiagnosticsBridge, "readPreviewBlock" | "releasePreviewBlock">): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    try {
      while (offset < this.bytes.length) {
        if (this.disposed) throw new Error("stale_preview");
        const result = await bridge.readPreviewBlock(this.preview.handle, offset);
        if (!result.ok) throw new Error(result.code);
        const block = result.value;
        let released: DiagnosticsResult<boolean>;
        try {
          if (
            this.disposed ||
            block.handle !== this.preview.handle ||
            block.offset !== offset ||
            !(block.bytes instanceof Uint8Array) ||
            block.bytes.length < 1 ||
            block.bytes.length > Math.min(DIAGNOSTIC_PREVIEW_BLOCK_BYTES, this.bytes.length - offset) ||
            (offset + block.bytes.length < this.bytes.length && block.bytes.at(-1) !== 10)
          )
            throw new Error("stale_preview");
          this.bytes.set(block.bytes, offset);
          this.blocks.push(decoder.decode(block.bytes, { stream: offset + block.bytes.length < this.bytes.length }));
          offset += block.bytes.length;
        } finally {
          block.bytes.fill(0);
          released = await bridge.releasePreviewBlock(this.preview.handle, block.offset);
        }
        if (!released.ok && !this.disposed) throw new Error(released.code);
        // Yield between decoding/layout batches, including fake/local bridges.
        if (offset < this.bytes.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (this.disposed) throw new Error("stale_preview");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
}
