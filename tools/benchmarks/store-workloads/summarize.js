/**
 * A Markdown summary of one store workload report (#341), for a CI job summary: the headline
 * number of each workload per backend, with the run's machine and commit. The JSON report is the
 * record; this is only what a person reads first.
 *
 *   node tools/benchmarks/store-workloads/summarize.js report.json [more.json ...]
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ms = (x) => (x === undefined ? "—" : `${x < 10 ? x.toFixed(2) : Math.round(x)} ms`);
const num = (x) => (x === undefined ? "—" : Math.round(x).toLocaleString("en-US"));
const mb = (x) => (x === undefined ? "—" : `${(x / 1e6).toFixed(1)} MB`);

/** One report as Markdown. */
export function summarize(report) {
  const lines = [];
  const m = report.machine ?? {};
  lines.push(`### Store workloads: ${report.scale}`);
  lines.push("");
  lines.push(
    `Commit \`${String(report.commit ?? "unknown").slice(0, 12)}\`${report.dirty ? " (dirty)" : ""}, ` +
      `${m.cpu ?? "unknown CPU"} x${m.cpus ?? "?"}, Node ${m.node ?? "?"}, seed ${report.seed}, repeat ${report.repeat}.`,
  );
  lines.push("");
  const ran = report.results.filter((r) => r.status === "ran");
  const skipped = report.results.filter((r) => r.status !== "ran");
  const row = (label, pick) => `| ${label} | ${ran.map((r) => pick(r.workloads ?? {}, r)).join(" | ")} |`;
  const level = (w, n) => w.concurrentMetadataWrites?.levels?.find((l) => l.writers === n);
  const writers = [
    ...new Set(ran.flatMap((r) => r.workloads?.concurrentMetadataWrites?.levels?.map((l) => l.writers) ?? [])),
  ];
  lines.push(`| | ${ran.map((r) => r.backend).join(" | ")} |`);
  lines.push(`|---|${ran.map(() => "---").join("|")}|`);
  lines.push(row("Checks", (_, r) => (r.checksPassed ? "pass" : "**FAIL**")));
  lines.push(row("Event appends while seeding (/s)", (_, r) => num(r.seeding?.history?.appendsPerSecond)));
  lines.push(row("Dependency question, warm p95", (w) => ms(w.dependencyTraversal?.warm?.p95)));
  lines.push(row("History page, forward walk p95 (warm)", (w) => ms(w.paginatedHistory?.warm?.forwardPages?.p95)));
  lines.push(
    row("History tail page p95 (cold)", (w) =>
      ms(w.paginatedHistory?.cold?.tailPage?.p95 ?? w.paginatedHistory?.warm?.tailPage?.p95),
    ),
  );
  for (const n of writers)
    lines.push(
      row(`Metadata writes, ${n} writer${n === 1 ? "" : "s"} (committed ops/s, p95)`, (w) => {
        const l = level(w, n);
        return l ? `${num(l.succeededOpsPerSecond)}, ${ms(l.latency.p95)}` : "—";
      }),
    );
  lines.push(row("Projection rebuild p50", (w) => ms(w.projectionRebuild?.rebuildAfterLoss?.p50)));
  lines.push(
    row("Streamed appends (/s, p95, over 5 ms)", (w) => {
      const c = w.walCheckpoint;
      return !c || c.skipped
        ? "no log"
        : `${num(c.appendsPerSecond)}, ${ms(c.latency.p95)}, ${c.latencyOutliersOver5ms ?? "—"}`;
    }),
  );
  lines.push(
    row("Log file sampled peak", (w) => {
      const c = w.walCheckpoint;
      return !c || c.skipped ? "no log" : mb(c.walBytes?.sampledMax);
    }),
  );
  lines.push(row("Bytes on disk", (_, r) => (r.storeBytes === undefined ? "in memory" : mb(r.storeBytes))));
  if (skipped.length) {
    lines.push("");
    for (const r of skipped) lines.push(`- ${r.backend}: skipped (${r.reason})`);
  }
  lines.push("");
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: summarize.js report.json [more.json ...]");
    process.exit(2);
  }
  for (const file of files) process.stdout.write(summarize(JSON.parse(readFileSync(file, "utf8"))) + "\n");
}
