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
 * A row's scoped claim (`scoped`) on the receipt's route moves with it, in the same edit: its
 * pin becomes the receipt's and its receipts the receipt, so the claim never points at a build
 * or a file the row no longer holds. Only the ORCA build may move a claim: the build and the
 * hook program ORCA built from it. A receipt for another agent version, adapter, host, adapter
 * package or agent runtime than the claim pins is refused here; re-scoping is a reviewed edit.
 * Nothing else in the claim changes, and the checker then judges it against the new receipt.
 *
 * Tiers are not changed here: a promotion is a reviewed edit in the pull request this opens,
 * and the checker refuses it unless the receipts hold it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { REPO_ROOT, artifactsOf, driverOf, pinShape, rowReceiptProblems } from "./check-support-matrix.js";

/** `read` reads a receipt the row already lists (repository-relative); injectable for tests. */
export function recordReceipts(matrix, receipts, read = (f) => JSON.parse(readFileSync(join(REPO_ROOT, f), "utf8"))) {
  const next = structuredClone(matrix);
  for (const { file, receipt } of receipts) {
    const row = next.agents.find((a) => a.id === receipt.agent);
    if (!row) throw new Error(`${file}: no support-matrix row for agent ${receipt.agent}`);
    // A row and its receipts run on one driver (#1128): an SDK receipt never pins an ACP row.
    if (driverOf(receipt) !== driverOf(row))
      throw new Error(
        `${file}: a receipt on driver ${driverOf(receipt)} cannot pin row ${row.id}, which is on driver ${driverOf(row)}`,
      );
    if (driverOf(row) === "claude-agent-sdk") {
      const wrong = rowReceiptProblems(receipt, row);
      if (wrong.length) throw new Error(`${file}: cannot pin row ${row.id}: ${wrong.join("; ")}`);
    }
    const shape = pinShape(row);
    if (!shape) throw new Error(`${file}: driver ${driverOf(row)} has no pin shape`);
    const pin = {
      ...Object.fromEntries(shape.versions.map((v) => [v, receipt[v]])),
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
    if (row.scoped?.route === receipt.route && receipt.kind === "installed") {
      const moved = claimFollowsBuild(shape)
        .filter(([, of]) => JSON.stringify(of(row.scoped.pin ?? {})) !== JSON.stringify(of(pin)))
        .map(([key]) => key);
      if (moved.length > 0)
        throw new Error(
          `${file}: the scoped claim on ${receipt.route} pins another ${moved.join(", ")}; ` +
            "only a new ORCA build moves a claim, so re-scope it in a reviewed change",
        );
      row.scoped.pin = structuredClone(pin);
      row.scoped.receipts = [file];
    }
  }
  return next;
}

/**
 * What a scoped claim's pin must keep when a receipt moves it: everything but the ORCA build and
 * what ORCA built from it (the hook program, or on the SDK route the bridge's code).
 */
const claimFollowsBuild = (shape) => [
  ...shape.versions.map((v) => [v, (p) => p[v]]),
  ["host", (p) => p.host],
  ...shape.artifacts
    .filter((a) => a !== "hookProgramSha256" && a !== "bridgeSha256")
    .map((a) => [a, (p) => p.artifacts?.[a]]),
];
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const matrixFile = join(REPO_ROOT, "tools/guard-qualification/support-matrix.json");
  const files = process.argv.slice(2).map((f) => relative(REPO_ROOT, resolve(f)));
  const receipts = files.map((file) => ({ file, receipt: JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) }));
  const matrix = JSON.parse(readFileSync(matrixFile, "utf8"));
  writeFileSync(matrixFile, `${JSON.stringify(recordReceipts(matrix, receipts), null, 2)}\n`);
}
