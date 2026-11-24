/**
 * Records attested receipts in the support matrix (#1026), for guard-receipts.yml:
 *
 *   node tools/guard-qualification/record-receipts.js <receipt.json>...
 *
 * Each receipt (already copied under tools/guard-qualification/receipts/, its Sigstore bundle
 * beside it) is listed on its agent's row, replacing that row's receipts for the same route,
 * and the row's pin is set to the receipt's agent version, adapter version, host and build,
 * and, from an installed receipt, the digests of the artifacts it ran (`pin.artifacts`). A
 * row's receipts must all share one pin, so receipts of one agent from another build are dropped.
 *
 * Tiers are not changed here: a promotion is a reviewed edit in the pull request this opens,
 * and the checker refuses it unless the receipts hold it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { REPO_ROOT, artifactsOf } from "./check-support-matrix.js";

/** `read` reads a receipt the row already lists (repository-relative); injectable for tests. */
export function recordReceipts(matrix, receipts, read = (f) => JSON.parse(readFileSync(join(REPO_ROOT, f), "utf8"))) {
  const next = structuredClone(matrix);
  for (const { file, receipt } of receipts) {
    const row = next.agents.find((a) => a.id === receipt.agent);
    if (!row) throw new Error(`${file}: no support-matrix row for agent ${receipt.agent}`);
    const pin = {
      agentVersion: receipt.agentVersion,
      adapterVersion: receipt.adapterVersion,
      host: receipt.host,
      build: receipt.build,
    };
    if (!Object.values(pin).every((v) => typeof v === "string" && v !== ""))
      throw new Error(`${file}: names no complete pin`);
    if (receipt.kind === "installed") {
      pin.artifacts = artifactsOf(receipt);
      if (!Object.values(pin.artifacts).every((v) => typeof v === "string" && v !== ""))
        throw new Error(`${file}: names no artifact digests`);
    }
    const samePin = row.pin && JSON.stringify(row.pin) === JSON.stringify(pin);
    const kept = samePin
      ? (row.receipts ?? []).filter((f) => {
          const r = read(f);
          return !(r.route === receipt.route && r.kind === receipt.kind);
        })
      : [];
    row.pin = pin;
    row.receipts = [...kept.filter((f) => f !== file), file].sort();
  }
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const matrixFile = join(REPO_ROOT, "tools/guard-qualification/support-matrix.json");
  const files = process.argv.slice(2).map((f) => relative(REPO_ROOT, resolve(f)));
  const receipts = files.map((file) => ({ file, receipt: JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) }));
  const matrix = JSON.parse(readFileSync(matrixFile, "utf8"));
  writeFileSync(matrixFile, `${JSON.stringify(recordReceipts(matrix, receipts), null, 2)}\n`);
}
