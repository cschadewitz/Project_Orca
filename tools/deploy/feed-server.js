#!/usr/bin/env node
/**
 * The update feed's server bundle channel file (#877), `latest-linux-x64.yml`:
 *
 *   node tools/deploy/feed-server.js channel DIR VERSION
 *
 * DIR holds the three files of release vVERSION's signed server bundle (#876), already
 * fetched and verified with `orca-release.py fetch-bundle`. This checks that the manifest
 * describes exactly that version and archive, then writes DIR/latest-linux-x64.yml naming the
 * three files with their SHA-256 digests and sizes. feed-r2.sh uploads it in the version's
 * server snapshot; the Worker serves it as `server/latest-linux-x64.yml` per ring.
 *
 * The format is flat `key: value` lines in a fixed order, so a server can read it with the
 * Python standard library alone (#878). It only says where the bundle is; the server still
 * verifies the manifest's signature against the pinned workflow identity before using it.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isVersion } from "./feed-worker/rings.js";

export const SERVER_CHANNEL_FILE = "latest-linux-x64.yml";
const KEYS = [
  "version",
  "platform",
  "sourceSha",
  "archive",
  "archiveSha256",
  "archiveSize",
  "manifest",
  "manifestSha256",
  "manifestSize",
  "signature",
  "signatureSha256",
  "signatureSize",
];

export function bundleNames(version) {
  const stem = `orca-server-${version}-linux-x64`;
  return {
    archive: `${stem}.tar.xz`,
    manifest: `${stem}.manifest.json`,
    signature: `${stem}.manifest.json.sigstore.json`,
  };
}

function described(dir, name) {
  const bytes = readFileSync(join(dir, name));
  if (!statSync(join(dir, name)).isFile()) throw new Error(`${name} is not a file`);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

/** The channel file's text for the bundle in DIR, after checking its manifest. */
export function serverChannel(dir, version) {
  if (!isVersion(version) || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version))
    throw new Error(`${version} is not a final or an -rc.N candidate`);
  const names = bundleNames(version);
  const manifest = JSON.parse(readFileSync(join(dir, names.manifest), "utf8"));
  const archive = described(dir, names.archive);
  if (
    manifest.schema !== "orca-server-bundle/1" ||
    manifest.version !== version ||
    manifest.platform !== "linux-x64" ||
    !/^[0-9a-f]{40}$/.test(manifest.sourceSha ?? "") ||
    manifest.archive?.name !== names.archive ||
    manifest.archive?.sha256 !== archive.sha256 ||
    manifest.archive?.size !== archive.size
  )
    throw new Error(`the manifest in ${dir} does not describe ${names.archive} for ${version}`);
  const manifestFile = described(dir, names.manifest);
  const signature = described(dir, names.signature);
  const values = {
    version,
    platform: "linux-x64",
    sourceSha: manifest.sourceSha,
    archive: names.archive,
    archiveSha256: archive.sha256,
    archiveSize: archive.size,
    manifest: names.manifest,
    manifestSha256: manifestFile.sha256,
    manifestSize: manifestFile.size,
    signature: names.signature,
    signatureSha256: signature.sha256,
    signatureSize: signature.size,
  };
  return KEYS.map((key) => `${key}: ${values[key]}\n`).join("");
}

/**
 * Parse a channel file as strictly as it is written: exactly these keys in this order, the
 * file names derived from the version, hex digests and decimal sizes. Throws otherwise.
 */
export function parseServerChannel(text) {
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw new Error("does not end with a newline");
  lines.pop();
  if (lines.length !== KEYS.length) throw new Error(`has ${lines.length} lines, not ${KEYS.length}`);
  const value = {};
  lines.forEach((line, i) => {
    const match = /^([A-Za-z0-9]+): ([0-9A-Za-z.-]+)$/.exec(line);
    if (!match || match[1] !== KEYS[i]) throw new Error(`line ${i + 1} is not ${KEYS[i]}`);
    value[match[1]] = match[2];
  });
  if (!isVersion(value.version) || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(value.version))
    throw new Error(`unexpected version ${value.version}`);
  const names = bundleNames(value.version);
  if (value.platform !== "linux-x64") throw new Error(`unexpected platform ${value.platform}`);
  if (!/^[0-9a-f]{40}$/.test(value.sourceSha)) throw new Error("no source commit");
  for (const kind of ["archive", "manifest", "signature"]) {
    if (value[kind] !== names[kind]) throw new Error(`${kind} is not ${names[kind]}`);
    if (!/^[0-9a-f]{64}$/.test(value[`${kind}Sha256`])) throw new Error(`${kind}Sha256 is not a SHA-256`);
    if (!/^(0|[1-9]\d{0,11})$/.test(value[`${kind}Size`])) throw new Error(`${kind}Size is not a size`);
    value[`${kind}Size`] = Number(value[`${kind}Size`]);
  }
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, dir, version] = process.argv.slice(2);
    if (action !== "channel" || !dir || !version || process.argv.length !== 5)
      throw new Error("usage: feed-server.js channel DIR VERSION");
    const text = serverChannel(dir, version);
    parseServerChannel(text);
    writeFileSync(join(dir, SERVER_CHANNEL_FILE), text);
    process.stdout.write(text);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
