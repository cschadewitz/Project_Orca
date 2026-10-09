/** Test-only complete-text oracle assembled through the production byte protocol. */
import type { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import type { DiagnosticPreview } from "../../src/diagnostics-contract.js";

export async function previewText(controller: RecoveryController, preview: DiagnosticPreview) {
  const bytes = Buffer.alloc(preview.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await controller.readPreviewBlock(preview.handle, offset);
    if (!result.ok) throw new Error(result.code);
    bytes.set(result.value.bytes, offset);
    offset += result.value.bytes.length;
    const released = await controller.releasePreviewBlock(preview.handle, result.value.offset);
    if (!released.ok) throw new Error(released.code);
  }
  const text = bytes.toString("utf8");
  bytes.fill(0);
  return { ...preview, text };
}
