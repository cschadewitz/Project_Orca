/** Read-only exact asset check for the reserved harmless sample; no renderer paths or repairs. */
import { windowsRead } from "@orca/protocol/first-run-fence";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FIRST_RUN_SAMPLE_FILES } from "../../first-run-sample.js";
import { ownedDirectory, sameDirectory, selectionFailure } from "./directories.js";

export async function verifyFirstRunSampleAssets(path: string): Promise<void> {
  const root = await ownedDirectory(path, homedir());
  const assets = await ownedDirectory(join(root.path, "first-run"), homedir());
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  for (const [name, expected] of Object.entries(FIRST_RUN_SAMPLE_FILES)) {
    const file = join(root.path, name);
    if (process.platform === "win32") {
      if (digest(windowsRead(file, 1024 * 1024)) !== digest(expected)) throw selectionFailure();
      continue;
    }
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== Buffer.byteLength(expected) ||
      digest(await readFile(file, "utf8")) !== digest(expected)
    )
      throw selectionFailure();
  }
  if (
    !sameDirectory(root, await ownedDirectory(root.path, homedir())) ||
    !sameDirectory(assets, await ownedDirectory(assets.path, homedir()))
  )
    throw selectionFailure();
}
