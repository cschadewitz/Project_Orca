/** Disposable one-process workload probe, emitting only bounded numerical measurements. */
import { withSyntheticProfile } from "./crash-harness.js";
import { measureRecoveryWorkload } from "./workload-measurement.js";
import { cleanupFixtureHelper } from "./implementation-fixture.js";

try {
  const measurements = await withSyntheticProfile(measureRecoveryWorkload);
  process.stdout.write(JSON.stringify(measurements) + "\n");
} finally {
  await cleanupFixtureHelper();
}
