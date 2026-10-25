/** Probe existing Documents ancestry with the actual NTFS/native ownership and ACL validator. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { verifySeal } from "./manifest.mjs";
const [source, runtime, seal, output, digest] = process.argv.slice(2);
fs.mkdirSync(output, { recursive: true });
const receiptFile = path.join(output, "setup.json");
assert.equal(fs.existsSync(receiptFile), false, "fresh setup receipt required");
const receipt = {
  schema: 1,
  accepted: false,
  productionEnabled: false,
  candidate: "existing userhome/Documents",
  aclRepair: false,
};
let storage,
  probe,
  verified = false;
try {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  verifySeal(source, runtime, seal, digest);
  const parent = path.join(os.homedir(), "Documents");
  receipt.parent = parent;
  assert.ok(
    fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(),
    "existing Documents required",
  );
  assert.equal(fs.realpathSync(parent), parent, "canonical Documents required");
  const backend = createRequire(import.meta.url)(
    path.join(runtime, "resources/native/diagnostics/win32-x64/diagnostics_storage.node"),
  );
  const { createHandleRelativeStorage } = await import(
    pathToFileURL(path.join(source, "packages/app/dist/main/diagnostics/native-storage.js"))
  );
  probe = path.join(parent, "orca-c15-probe-" + randomUUID());
  assert.equal(fs.existsSync(probe), false);
  receipt.probe = probe;
  storage = createHandleRelativeStorage(probe, backend);
  verified = await storage.native.verifyRoot(probe);
  assert.equal(verified, true, "native NTFS/owner/ACL ancestry refused");
  receipt.parent = parent;
  receipt.accepted = true;
  receipt.method =
    "Native openRoot checks NTFS volume, each existing ancestor owner/DACL, reparse/hardlink identity and new private root; no ACL repair";
} catch (error) {
  receipt.failureCode = error.message;
  process.exitCode = 1;
} finally {
  try {
    await storage?.close();
    receipt.nativeProbeVerified = verified;
    if (verified) {
      assert.equal(fs.realpathSync(probe), probe);
      assert.equal(fs.readdirSync(probe).length, 0);
      fs.rmdirSync(probe);
      receipt.probeRemoved = true;
    }
  } catch (error) {
    receipt.accepted = false;
    receipt.cleanupFailure = error.message;
    process.exitCode = 1;
  }
  receipt.probeRetained = Boolean(probe && fs.existsSync(probe));
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  if (receipt.accepted && process.env.GITHUB_ENV)
    fs.appendFileSync(process.env.GITHUB_ENV, `C15_PARENT=${receipt.parent}\n`);
  process.stdout.write(JSON.stringify({ accepted: receipt.accepted, failureCode: receipt.failureCode }) + "\n");
}
