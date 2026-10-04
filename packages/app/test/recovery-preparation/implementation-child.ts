/** Actual coordinator/disk kill fixture. IPC signals only reached real mutation boundaries. */
import { join } from "node:path";
import { implementationFixture, enableAndPreview, value, borrowFixtureHelper } from "./implementation-fixture.js";

const profile = process.argv[2];
const boundary = process.argv[3];
if (profile === undefined || boundary === undefined) throw new Error("Missing synthetic fixture arguments");
const helper = process.argv[4];
if (helper !== undefined) borrowFixtureHelper(helper);
if (boundary === "measurement") {
  const { measureRecoveryWorkload } = await import("./workload-measurement.js");
  process.send?.({ type: "measurement", value: await measureRecoveryWorkload(profile) });
  process.exit(0);
}

async function reached(name: string): Promise<never> {
  process.send?.({ type: "boundary", name });
  setInterval(() => {}, 1000);
  return new Promise<never>(() => {});
}

const fixture = await implementationFixture(profile);
if (boundary === "maximum-checkpoint-committed") {
  value(await fixture.controller.setEnabled(true, 1));
  for (let index = 0; index < 8192; index += 1) {
    fixture.clock.reading.elapsedMs += 1;
    fixture.controller.record("unknown", "unknown");
  }
  await fixture.controller.checkpoint();
  await reached(boundary);
}
const preview = await enableAndPreview(fixture);
if (boundary === "checkpoint-committed") {
  await fixture.controller.checkpoint();
  await reached(boundary);
}
if (boundary === "before-checkpoint-manifest" || boundary === "after-checkpoint-manifest") {
  await fixture.controller.checkpoint();
  fixture.controller.record("run", "run_failed");
  fixture.clock.reading.elapsedMs += 100;
  const hook = async (_source: string, destination: string) => {
    if (destination.endsWith("manifest.json")) await reached(boundary);
  };
  if (boundary === "before-checkpoint-manifest") fixture.native.beforeReplace = hook;
  else fixture.native.afterReplace = hook;
  await fixture.controller.checkpoint();
}
fixture.native.publication = () => Promise.resolve("unknown");
const destination = value(await fixture.controller.chooseDestination(preview.handle));
if (boundary === "before-stage-identity") {
  fixture.native.beforeReplace = async (source, destination) => {
    if (
      destination.endsWith("export.json") &&
      (await (await import("node:fs/promises")).readFile(source, "utf8")).includes('"stage":')
    )
      await reached(boundary);
  };
}
if (boundary === "before-stage-write") {
  fixture.native.beforeWrite = async (_handle, bytes) => {
    if (bytes.includes(Buffer.from("connection_lost"))) await reached(boundary);
  };
}
await fixture.controller.save(preview.handle, destination.token);
const id = fixture.controller.status().unknownOperation;
if (id === undefined) throw new Error("No actual unresolved operation");
await fixture.controller.retryCleanup();
if (boundary === "before-ack") {
  fixture.native.beforeReplace = async (_source, destination) => {
    if (destination.endsWith("export.json")) await reached(boundary);
  };
} else if (boundary === "after-ack") {
  fixture.native.afterReplace = async (_source, destination) => {
    if (destination.endsWith("export.json")) await reached(boundary);
  };
}
value(await fixture.controller.acknowledgeUnknown(id));
if (boundary === "during-fresh-intent") {
  value(await fixture.controller.closePreview(preview.handle));
  const fresh = value(await fixture.controller.preparePreview("current"));
  fixture.picker.destination = join(profile, "fresh-report.json");
  const selected = value(await fixture.controller.chooseDestination(fresh.handle));
  fixture.native.beforeReplace = async (_source, destination) => {
    if (destination.endsWith("export.json")) await reached(boundary);
  };
  await fixture.controller.save(fresh.handle, selected.token);
}
throw new Error("Synthetic fixture did not reach the requested actual boundary");
