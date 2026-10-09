import { previewText } from "./preview-text.js";
/** Single-process 8,192-event empirical probe, separate from allocator/native acceptance. */
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { implementationFixture, value } from "./implementation-fixture.js";
import { inspectPrivateRoot } from "./filesystem-evidence.js";
import { crashImplementationAt } from "./process-fixture.js";

export async function measureRecoveryWorkload(profile: string) {
  await crashImplementationAt(profile, "maximum-checkpoint-committed");
  const fixture = await implementationFixture(profile, { reading: { bootId: "synthetic-boot", elapsedMs: 10_000 } });
  value(await fixture.controller.setEnabled(true, 1));
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  let managedPeak = baseline.heapUsed + baseline.external;
  let rssPeak = baseline.rss;
  let payloadPeak = 0;
  let retainedPeak = 0;
  let stagingPeak = 0;
  let delayPeakMs = 0;
  let lastBeat = performance.now();
  const sample = () => {
    const reading = process.memoryUsage();
    managedPeak = Math.max(managedPeak, reading.heapUsed + reading.external);
    rssPeak = Math.max(rssPeak, reading.rss);
    payloadPeak = Math.max(payloadPeak, fixture.controller.status().payloadReservedBytes);
  };
  const beat = setInterval(() => {
    const now = performance.now();
    delayPeakMs = Math.max(delayPeakMs, now - lastBeat - 1);
    lastBeat = now;
    sample();
  }, 1);
  const inspect = async () => {
    sample();
    const facts = await inspectPrivateRoot(fixture.root);
    retainedPeak = Math.max(retainedPeak, facts.retainedBytes);
    stagingPeak = Math.max(stagingPeak, facts.stagingBytes);
  };
  const unsubscribe = fixture.controller.subscribe(sample);
  fixture.native.beforeWrite = async () => {
    sample();
  };
  fixture.native.afterReplace = inspect;
  fixture.native.beforePublish = inspect;
  try {
    for (let index = 0; index < 8192; index += 1) {
      fixture.clock.reading.elapsedMs += 1;
      fixture.controller.record("unknown", "unknown");
      if (index % 256 === 0) {
        sample();
        await setImmediate();
      }
    }
    sample();
    const started = performance.now();
    await fixture.controller.checkpoint();
    const checkpointMs = performance.now() - started;
    const preview = await previewText(fixture.controller, value(await fixture.controller.preparePreview("current")));
    sample();
    await fixture.controller.checkpoint();
    const destination = value(await fixture.controller.chooseDestination(preview.handle));
    value(await fixture.controller.save(preview.handle, destination.token));
    await inspect();
    const managedIncrementBytes = managedPeak - baseline.heapUsed - baseline.external;
    const rssIncrementBytes = rssPeak - baseline.rss;
    const report = JSON.parse(preview.text) as { events: unknown[]; omissions: { budget: number } };
    return {
      offeredEvents: 8192,
      retainedEvents: report.events.length,
      omissions: report.omissions.budget,
      serializedBytes: preview.byteLength,
      managedIncrementBytes,
      rssIncrementBytes,
      payloadPeak,
      retainedPeak,
      stagingPeak,
      checkpointMs,
      delayPeakMs,
      method:
        "Linux main process; idle baseline after GC; 1 ms samples plus operation/batch boundaries; heapUsed+external, arrayBuffers not double-counted; no renderer/native/power-loss proof",
    };
  } finally {
    clearInterval(beat);
    unsubscribe();
    await fixture.controller.cleanExit();
  }
}
