/** Stage a checksum-pinned owned Electron tree and verified native resources, then seal it. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { specification, sha, regular, inventory, verifyBuild, harness, git } from "./manifest.mjs";
import assert from "node:assert/strict";
const [sourceArg, runtimeArg, archive, sealFile] = process.argv.slice(2);
const source = path.resolve(sourceArg),
  runtime = path.resolve(runtimeArg);
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
verifyBuild(source);
assert.equal(sha(regular(archive)), specification.electron.sha256, "official Electron archive checksum");
assert.equal(fs.existsSync(runtime), false, "owned runtime must be fresh");
assert.equal(fs.existsSync(sealFile), false, "never replace build receipt");
const { verifyNativePackage } = await import(
  pathToFileURL(path.join(source, "packages/app/scripts/diagnostics-native-package.js"))
);
const native = path.join(source, "packages/app/dist/diagnostics-native/win32-x64");
const nativeManifest = verifyNativePackage(native, "x64", path.join(source, "packages/app"), "win32");
assert.equal(nativeManifest.sourceSha256, specification.nativeSourceSha256);
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive -LiteralPath $env:C15_ARCHIVE -DestinationPath $env:C15_RUNTIME",
  ],
  {
    env: { ...process.env, C15_ARCHIVE: path.resolve(archive), C15_RUNTIME: runtime },
    timeout: 120_000,
    stdio: "pipe",
  },
);
// Copy the closed verified package only into the fixed production Electron location.
fs.cpSync(native, path.join(runtime, "resources/native/diagnostics/win32-x64"), {
  recursive: true,
  errorOnExist: true,
  force: false,
});
assert.deepEqual(
  verifyNativePackage(
    path.join(runtime, "resources/native/diagnostics/win32-x64"),
    "x64",
    path.join(source, "packages/app"),
    "win32",
  ),
  nativeManifest,
);
const receipt = {
  schema: 1,
  sourceCommit: specification.sourceCommit,
  source,
  runtime,
  harnessHead: git(harness, "rev-parse", "HEAD").toString().trim(),
  specificationSha256: sha(regular(new URL("candidate.json", import.meta.url))),
  runtimeArchiveSha256: specification.electron.sha256,
  nativeManifest,
  runtimeFiles: inventory(runtime),
  nodeExecutableSha256: sha(regular(process.execPath)),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  productionEnabled: false,
};
const bytes = JSON.stringify(receipt, null, 2) + "\n";
fs.writeFileSync(sealFile, bytes, { flag: "wx" });
const digest = sha(bytes);
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `C15_SEAL_SHA256=${digest}\n`);
process.stdout.write(JSON.stringify({ buildReceiptSha256: digest, sourceCommit: receipt.sourceCommit }) + "\n");
