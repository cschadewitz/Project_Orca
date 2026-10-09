/** Compiled Windows Node refusal only; never packaged Electron or native positive acceptance. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDiagnosticsInitializer } from "../../dist/main/diagnostics/initialize.js";

assert.equal(process.platform, "win32");
const directory = await mkdtemp(join(tmpdir(), "orca-compiled-win-"));
assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
let keyCalls = 0;
let pickerCalls = 0;
const fixture = createDiagnosticsInitializer({
  root: join(directory, "diagnostics"),
  safeStorage: {
    async isAsyncEncryptionAvailable() {
      keyCalls++;
      return true;
    },
    async encryptStringAsync() {
      keyCalls++;
      throw Error("unused");
    },
    async decryptStringAsync() {
      keyCalls++;
      throw Error("unused");
    },
  },
  async chooseDestination() {
    pickerCalls++;
    return undefined;
  },
});
try {
  await fixture.initialize();
  assert.equal((await fixture.controller.setEnabled(true, 1)).ok, false);
  assert.equal((await fixture.controller.preparePreview("current")).ok, false);
  assert.equal(fixture.controller.record("run", "run_failed"), false);
  const status = fixture.controller.status();
  assert.equal(status.enabled, false);
  assert.equal(status.productionEnabled, false);
  assert.equal(status.payloadReservedBytes, 0);
  await fixture.close();
  assert.deepEqual(await readdir(directory), []);
  assert.equal(keyCalls, 0);
  assert.equal(pickerCalls, 0);
  process.stdout.write(
    JSON.stringify({
      source: "a991fbfea9da6d39dea2f0c513cc5a000d993c14",
      scope: "compiled Windows Node initializer; not packaged Electron",
      noCreatedDiagnosticFiles: true,
      keyCalls,
      pickerCalls,
      status,
    }) + "\n",
  );
} finally {
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
