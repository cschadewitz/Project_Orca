// A child process that holds an event file's append lock over half of one event, finishes it when
// told to, and then appends an event of its own; see event-observation.test.ts.
import { appendFile } from "node:fs/promises";
import { withFileLock } from "../../src/file-lock.js";
import { JsonlEventStore } from "../../src/jsonl-event-store.js";

const [dir, file, bytes, started] = process.argv.slice(2) as [string, string, string, string];
const send = (message: string) => process.send!(message);
const next = () => new Promise((resolve) => process.once("message", resolve));

await withFileLock(`${file}.lock`, async () => {
  const middle = Math.floor(bytes.length / 2);
  await appendFile(file, bytes.slice(0, middle));
  send("partial");
  await next();
  await appendFile(file, bytes.slice(middle));
});
await next();
await new JsonlEventStore(dir).append(JSON.parse(started) as Parameters<JsonlEventStore["append"]>[0]);
process.disconnect();
