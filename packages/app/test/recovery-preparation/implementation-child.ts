import { frozenReportText } from "./frozen-report-text.js";
/** Actual coordinator/disk kill fixture. IPC signals only reached real mutation boundaries. */
import { join } from "node:path";
import { implementationFixture, enableAndExport, value, borrowFixtureHelper } from "./implementation-fixture.js";
import type { OptOutCrashEvidence } from "./process-fixture.js";

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

async function reached(name: string, evidence?: OptOutCrashEvidence): Promise<never> {
  process.send?.({ type: "boundary", name, ...(evidence ? { evidence } : {}) });
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
const preview = await enableAndExport(fixture);
if (
  boundary === "before-optout-summary-removal" ||
  boundary === "after-optout-summary-removal" ||
  boundary === "optout-unresolved"
) {
  await fixture.controller.checkpoint();
  const destination = value(await fixture.controller.chooseDestination(preview.handle));
  value(await fixture.controller.save(preview.handle, destination.token));
  if (fixture.controller.status().lastSaveOutcome !== "saved") throw new Error("Prior native export not saved");
  value(await fixture.controller.cancelExport(preview.handle));
  const unknown = await frozenReportText(fixture.controller, value(await fixture.controller.prepareExport("current")));
  fixture.picker.destination = join(profile, "unknown-report.json");
  fixture.native.publication = () => Promise.resolve("unknown");
  const selected = value(await fixture.controller.chooseDestination(unknown.handle));
  await fixture.controller.save(unknown.handle, selected.token);
  const acknowledgedId = fixture.controller.status().unknownOperation;
  if (acknowledgedId === undefined) throw new Error("No unknown operation to acknowledge");
  value(await fixture.controller.retryCleanup());
  value(await fixture.controller.acknowledgeUnknown(acknowledgedId));
  value(await fixture.controller.cancelExport(unknown.handle));
  const evidence: OptOutCrashEvidence = { publishedText: preview.text, acknowledgedId };
  if (boundary === "optout-unresolved") {
    const unresolved = await frozenReportText(
      fixture.controller,
      value(await fixture.controller.prepareExport("current")),
    );
    fixture.picker.destination = join(profile, "unresolved-report.json");
    const selected = value(await fixture.controller.chooseDestination(unresolved.handle));
    await fixture.controller.save(unresolved.handle, selected.token);
    const unresolvedId = fixture.controller.status().unknownOperation;
    if (unresolvedId === undefined) throw new Error("No newer unresolved operation");
    evidence.unresolvedId = unresolvedId;
    fixture.native.beforeRemove = async (path) => {
      if (path === join(fixture.root, "manifest.json")) await reached(boundary, evidence);
    };
  } else if (boundary === "before-optout-summary-removal") {
    fixture.native.beforeRemove = async (path) => {
      if (path === join(fixture.root, "export.json")) await reached(boundary, evidence);
    };
  } else {
    const remove = fixture.native.remove.bind(fixture.native);
    fixture.native.remove = async (path) => {
      await remove(path);
      if (path === join(fixture.root, "export.json")) await reached(boundary, evidence);
    };
  }
  await fixture.controller.setEnabled(false, 1);
  throw new Error("Opt-out did not reach the requested native mutation boundary");
}
if (boundary === "checkpoint-committed" || boundary === "checkpoint-and-unknown") {
  await fixture.controller.checkpoint();
  if (boundary === "checkpoint-committed") await reached(boundary);
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
if (boundary === "checkpoint-and-unknown") await reached(boundary);
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
  value(await fixture.controller.cancelExport(preview.handle));
  const fresh = await frozenReportText(fixture.controller, value(await fixture.controller.prepareExport("current")));
  fixture.picker.destination = join(profile, "fresh-report.json");
  const selected = value(await fixture.controller.chooseDestination(fresh.handle));
  fixture.native.beforeReplace = async (_source, destination) => {
    if (destination.endsWith("export.json")) await reached(boundary);
  };
  await fixture.controller.save(fresh.handle, selected.token);
}
throw new Error("Synthetic fixture did not reach the requested actual boundary");
