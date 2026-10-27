/**
 * Parse a store's durable records with the schemas of one checkout, without opening the store.
 *
 *   cd <checkout> && node --import tsx <this file> <checkout> <storeDir>
 *
 * Run from inside the checkout so that its own `tsx`, `zod` and `@orca/core` source answer.
 * Only `readFileSync` touches the store: no store class is constructed, so no lock, journal
 * repair, key creation or identity initialization can happen. The JSON report says, per
 * record family, how many records that checkout refuses and which fields it would silently
 * drop - which is what an older binary would do with a newer store, measured without letting
 * the older binary near it. Families this reader does not know are listed as unread rather
 * than reported clean. Dropped fields are found by comparing object keys; keys inside array
 * elements are not compared, so a field lost there would go unreported.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, store] = process.argv.slice(2);
if (!checkout || !store) {
  console.error("usage: schema-read.js <checkout> <storeDir>");
  process.exit(2);
}
const core = await import(pathToFileURL(join(checkout, "packages/core/src/index.ts")).href);

const families = [
  { name: "run events", dir: "runs", schema: "OrcaEventSchema", label: (r) => r.type },
  { name: "plan journal", dir: "plans", schema: "PlanEventSchema", label: (r) => r.type },
  { name: "artifact index", file: "artifacts/index.jsonl", schema: "ArtifactSchema", lines: true },
  { name: "requests", file: "requests.json", schema: "RequestSchema" },
  { name: "work items", file: "work-items.json", schema: "WorkItemSchema" },
  { name: "plans", file: "plans.json", schema: "PlanSchema" },
  { name: "dependencies", file: "dependencies.json", schema: "DependencySchema" },
  { name: "risks", file: "risks.json", schema: "RiskSchema" },
  { name: "decisions", file: "decisions.json", schema: "DecisionSchema" },
];
const read = new Set(["runs", "plans", "artifacts", ...families.flatMap((f) => (f.file ? [f.file] : []))]);
const jsonl = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
const keys = (value, prefix = "") =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, inner]) => [prefix + key, ...keys(inner, `${prefix}${key}.`)])
    : [];

const report = { checkout, families: [], unread: [] };
for (const family of families) {
  const schema = core[family.schema];
  const entry = { name: family.name, schema: family.schema, records: 0, refused: 0, refusedBy: {}, dropped: {} };
  if (!schema) {
    report.families.push({ ...entry, available: false });
    continue;
  }
  const sources = family.dir
    ? existsSync(join(store, family.dir))
      ? readdirSync(join(store, family.dir))
          .filter((name) => name.endsWith(".jsonl"))
          .sort()
          .map((name) => jsonl(join(store, family.dir, name)))
      : []
    : existsSync(join(store, family.file))
      ? [family.lines ? jsonl(join(store, family.file)) : JSON.parse(readFileSync(join(store, family.file), "utf8"))]
      : [];
  for (const record of sources.flat()) {
    entry.records++;
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      entry.refused++;
      const key = `${family.label?.(record) ?? "record"}: ${parsed.error.issues[0]?.code ?? "invalid"}`;
      entry.refusedBy[key] = (entry.refusedBy[key] ?? 0) + 1;
      continue;
    }
    const kept = new Set(keys(parsed.data));
    for (const key of keys(record)) if (!kept.has(key)) entry.dropped[key] = (entry.dropped[key] ?? 0) + 1;
  }
  report.families.push({ ...entry, available: true });
}
if (existsSync(store)) for (const name of readdirSync(store).sort()) if (!read.has(name)) report.unread.push(name);
console.log(JSON.stringify(report));
