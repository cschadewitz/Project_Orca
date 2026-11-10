import fs from "node:fs";

/**
 * Replace `fs.readSync` until `mockRestore()`. Unlike `vi.spyOn(fs, "readSync")` this records no calls.
 * A spy keeps every call's arguments, buffers included, until it is restored, and the code under test
 * calls `readSync` in a tight loop. One test file then held up to 1.8 GiB of ArrayBuffers.
 */
export function interceptReadSync(implementation: typeof fs.readSync): { mockRestore(): void } {
  const original = fs.readSync;
  Object.assign(fs, { readSync: implementation });
  return { mockRestore: () => void Object.assign(fs, { readSync: original }) };
}
