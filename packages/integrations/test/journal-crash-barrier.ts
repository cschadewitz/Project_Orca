/** Test-only crash placement: retain a real published journal owner until SIGKILL. */
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { until } from "./mcp-operator-production-fixture.js";

export function journalCrashBarrier(root: string) {
  const armFile = join(root, "journal-crash-arm");
  const readyFile = join(root, "journal-crash-ready");
  let selectedLock: string | undefined;
  let ownerPath: string | undefined;
  // Forward every actual write unchanged. Only the selected owner's completed
  // publication is held, before withFileLock can run its callback or unlink it.
  // There is no replacement store, handler, credential or recovery implementation.
  const preload = `
import fs from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const writeFile = fs.writeFile;
let held = false;
fs.writeFile = async (...args) => {
  const result = await writeFile(...args);
  const path = String(args[0]);
  if (held || !dirname(path).endsWith('.jsonl.lock') || !/^owner\\.\\d+\\.[a-f0-9-]+\\.json$/.test(basename(path))) return result;
  let selected;
  try { selected = await fs.readFile(${JSON.stringify(armFile)}, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  if (dirname(path) !== selected) return result;
  held = true;
  await fs.unlink(${JSON.stringify(armFile)});
  await writeFile(${JSON.stringify(readyFile)}, path, {flag: 'wx'});
  await new Promise(() => {});
};
syncBuiltinESMExports();
`;
  return {
    preload,
    async arm(lock: string) {
      selectedLock = lock;
      await writeFile(armFile, lock, { flag: "wx" });
    },
    async publishedOwner() {
      const path = await until(
        async () => {
          try {
            return await readFile(readyFile, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        },
        (value) => value !== undefined,
        "published journal lock owner crash barrier",
      );
      if (!path || dirname(path) !== selectedLock || !/^owner\.\d+\.[a-f0-9-]+\.json$/.test(basename(path)))
        throw new Error("Unexpected journal crash boundary");
      ownerPath = path;
      return JSON.parse(await readFile(path, "utf8")) as { pid: number; host: string; at: number };
    },
    async ownerPresent() {
      if (!ownerPath) throw new Error("Journal owner has not been observed");
      try {
        await access(ownerPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}
