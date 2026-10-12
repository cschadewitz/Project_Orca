/**
 * The other process in admission-execution.test.ts: a second interpreter over the test's store
 * directory, started with `race <dir> <runId> <effectFile>` or
 * `crash <dir> <runId> <effectFile> <boundary>`.
 */
import { appendFile } from "node:fs/promises";
import { fileStores } from "@orca/store";
import { admissionRuntime } from "./admission-execution-fixture.js";

const [mode, dir, runId, effectFile, boundary] = process.argv.slice(2) as [string, string, string, string, string?];

if (mode === "race") {
  const f = await admissionRuntime(fileStores(dir), {
    effect: async () => {
      await appendFile(effectFile, "effect\n");
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
  });
  try {
    await f.orc.run(runId);
    process.stdout.write("attached");
  } catch (error) {
    if ((error as { code?: string }).code !== "RUN_LEASED") throw error;
    process.stdout.write("leased");
  }
} else if (mode === "crash") {
  // Die abruptly at `boundary`, where no catch or finally runs, so the test sees exactly what
  // a SIGKILL there would have left in the store.
  const f = await admissionRuntime(fileStores(dir), {
    effect: async () => {
      await appendFile(effectFile, "effect\n");
      if (boundary === "effect-after") process.exit(87);
    },
  });
  const put = f.stores.execution.putGeneration.bind(f.stores.execution);
  f.stores.execution.putGeneration = async (id, value) => {
    const type =
      id === "admission-execution-attempt:" + runId
        ? "attempt"
        : id === "admission-execution-start:" + runId
          ? "witness"
          : "";
    if (boundary === type + "-before") process.exit(87);
    await put(id, value);
    if (boundary === type + "-after") process.exit(87);
  };
  const append = f.stores.events.append.bind(f.stores.events);
  f.stores.events.append = async (event) => {
    if (event.type === "run.started" && boundary === "start-before") process.exit(87);
    const result = await append(event);
    if (event.type === "run.started" && boundary === "start-after") process.exit(87);
    return result;
  };
  const sync = f.stores.events.synchronizeEvent!.bind(f.stores.events);
  f.stores.events.synchronizeEvent = async (event) => {
    if (event.type === "run.started" && boundary === "sync-before") process.exit(87);
    const result = await sync(event);
    if (event.type === "run.started" && boundary === "sync-after") process.exit(87);
    return result;
  };
  await f.orc.run(runId);
  throw new Error("Expected abrupt process termination");
} else {
  throw new Error(`unknown mode ${mode}`);
}
