// A child process that dies after writing half of one durable marker, so the append is cut off
// where the file handle writes it; see continuation-admission-store.test.ts.
import { open } from "node:fs/promises";
import { JsonlLogDir } from "../../src/jsonl-log.js";

const [dir, file] = process.argv.slice(2) as [string, string];
const probe = await open(file, "a+");
const prototype = Object.getPrototypeOf(probe) as {
  writeFile: (this: unknown, bytes: unknown, ...args: unknown[]) => Promise<void>;
};
await probe.close();
const writeFile = prototype.writeFile;
prototype.writeFile = async function (this: unknown, bytes: unknown, ...args: unknown[]) {
  if (typeof bytes === "string" && bytes.includes("continuation-1")) {
    await writeFile.call(this, bytes.slice(0, Math.floor(bytes.length / 2)), ...args);
    process.exit(87);
  }
  return writeFile.call(this, bytes, ...args);
};
await new JsonlLogDir(dir).appendDurableUnique("run", {
  expectedSeq: 0,
  findExisting: () => undefined,
  build: (seq) => ({ seq, correlation: "continuation-1", value: "accepted" }),
});
