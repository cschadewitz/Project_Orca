#!/usr/bin/env node
/**
 * Which Windows architectures feed-publish.yml serves for one published release (#889).
 *
 *   node tools/deploy/feed-arches.js VERSION RELEASE_JSON
 *
 * Prints "x64" or "x64 arm64". x64 is always served (its acceptance is the release's own gate,
 * docs/RELEASING.md). arm64 is served only when the published release carries the signed arm64
 * installer and its notes hold exactly one signing record and exactly one acceptance record
 * for that installer's digest: release-attach.sh writes the first when it attaches the
 * installer and `Release (accept Windows arm64)` the second when its native acceptance passes.
 * Anything else (an older release without arm64, an installer attached by hand, a record for
 * other bytes) serves x64 alone, with the reason on stderr, so x64 feeding never changes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = "sha256:[0-9a-f]{64}";
export const SIGNED_ARM64 = new RegExp(`<!-- orca-signed-run-arm64: ([0-9]+) (${DIGEST}) -->`, "g");
export const ACCEPTED_ARM64 = new RegExp(`<!-- orca-arm64-accepted: ([0-9]+) (${DIGEST}) -->`, "g");

/** { arches, reason }: reason says why arm64 is left out, if it is. */
export function feedArches(version, release) {
  const x64 = { arches: ["x64"] };
  const name = `ORCA-${version}-win-arm64.exe`;
  const assets = (release?.assets ?? []).filter((asset) => asset.name === name);
  if (assets.length === 0) return { ...x64, reason: `v${version} has no ${name}` };
  const digest = assets[0].digest ?? "";
  if (assets.length !== 1 || !new RegExp(`^${DIGEST}$`).test(digest))
    return { ...x64, reason: `v${version}'s ${name} has no single SHA-256 digest` };
  const body = release.body ?? "";
  const signed = [...body.matchAll(SIGNED_ARM64)];
  const accepted = [...body.matchAll(ACCEPTED_ARM64)];
  if (signed.length !== 1 || signed[0][2] !== digest)
    return { ...x64, reason: `v${version} has no single signing record for its ${name} (${digest})` };
  if (accepted.length !== 1 || accepted[0][2] !== digest)
    return { ...x64, reason: `v${version} has no single native acceptance record for its ${name} (${digest})` };
  return { arches: ["x64", "arm64"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, file] = process.argv.slice(2);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version ?? "") || !file) {
    console.error("usage: feed-arches.js VERSION RELEASE_JSON");
    process.exit(2);
  }
  const { arches, reason } = feedArches(version, JSON.parse(readFileSync(file, "utf8")));
  if (reason) console.error(`arm64 not served: ${reason}`);
  console.log(arches.join(" "));
}
