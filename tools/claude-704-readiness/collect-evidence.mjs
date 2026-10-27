/**
 * #704 installed-readiness evidence collector. Offline: it reads one observation journal
 * (observation-format.json), derives sanitized receipts in the merged
 * `orca.claude-qualification-experiment/1` envelope and returns them. It starts no process, opens no
 * connection and writes no file; the CLI prints to stdout.
 *
 * It never resolves ambiguity and never reports success:
 * - A journal that is malformed, carries anything but closed labels, reorders its own sequence or
 *   shares the independent counter's source with another log is REFUSED, with reason codes only.
 * - A receipt that would need an observation the journal cannot support (a dispatch called cached
 *   without a sealed ACP log and an exact remembered grant; a hook called not-invoked without a sealed
 *   hook log; a counter reading without a sealed counter log) is withheld and listed, so the record
 *   stays incomplete instead of being completed by inference.
 * - Duplicates, replays, late answers and unexpected calls are passed through for the merged
 *   classifier to judge. Every result says `qualification: "UNKNOWN"` and `authenticity: "unverified"`.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

export const COLLECTION_FORMAT = "orca.claude-installed-collection/1";
export const OBSERVATION_FORMAT_PATH = "tools/claude-704-readiness/observation-format.json";
export const RECEIPT_FORMAT_PATH =
  "tools/test/fixtures/provider-enforcement-704-705/claude-qualification/evidence-format.json";

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const LEVEL = { synthetic: "synthetic-protocol-tested", installed: "installed-observed" };
const CHANGED = { action: "changed-action", cwd: "changed-cwd" };

/** Every string must be a short closed label: no paths, spaces, digests or long numbers. */
function cleanValue(value, grammar) {
  return (
    typeof value === "string" &&
    new RegExp(grammar.token).test(value) &&
    Object.values(grammar.forbiddenPatterns).every((pattern) => !new RegExp(pattern).test(value))
  );
}

function checkEvent(event, index, grammar, previousSeq) {
  if (!isRecord(event)) return `event-shape:${index}`;
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) return `event-seq:${index}`;
  if (previousSeq !== undefined && event.seq <= previousSeq) return `seq-not-increasing:${index}`;
  const spec = grammar.kinds[event.kind];
  if (!spec) return `unknown-kind:${index}`;
  if (event.source !== event.kind.split(".")[0]) return `source-kind-mismatch:${index}`;
  const allowed = new Set(["seq", "source", "kind", ...spec.required, ...spec.optional]);
  if (Object.keys(event).some((key) => !allowed.has(key))) return `unknown-key:${index}`;
  if (spec.required.some((key) => event[key] === undefined)) return `missing-observation:${index}`;
  for (const [key, value] of Object.entries(event)) {
    if (key === "seq") continue;
    if (!cleanValue(value, grammar)) return `forbidden-value:${index}`;
    const pattern = grammar.labelPatterns[key];
    if (pattern && !new RegExp(pattern).test(value)) return `label-shape:${index}`;
    if (grammar.values[key] && !grammar.values[key].includes(value)) return `value-not-allowed:${index}`;
    if (key === "outcome" && !spec.outcomes.includes(value)) return `outcome-not-allowed:${index}`;
  }
}

function refusalsFor(observations, grammar, receiptFormat) {
  if (!isRecord(observations)) return ["journal-shape"];
  const keys = Object.keys(observations);
  if (keys.some((key) => !grammar.topKeys.includes(key))) return ["journal-unknown-key"];
  if (grammar.requiredTopKeys.some((key) => !Object.hasOwn(observations, key))) return ["journal-missing-key"];
  if (observations.format !== grammar.format) return ["journal-format"];
  if (!grammar.labels.includes(observations.label)) return ["journal-label"];
  if (Buffer.byteLength(JSON.stringify(observations)) > grammar.limits.transportBytes) return ["journal-oversize"];
  const refusals = [];
  const { label, authorizationRef, run, sources, seals, events } = observations;
  if (label === "installed" && !cleanValue(authorizationRef, grammar)) refusals.push("installed-without-authorization");
  if (label === "synthetic" && authorizationRef !== undefined) refusals.push("synthetic-claims-authorization");

  const identity = new RegExp(receiptFormat.experiment.identityToken);
  const identityKeys = new Set(["provider", "tool", "providerVersion", "adapterVersion"]);
  if (
    !isRecord(run) ||
    Object.keys(run).length !== grammar.runKeys.length ||
    !grammar.runKeys.every(
      (key) =>
        typeof run[key] === "string" &&
        (identityKeys.has(key) ? identity.test(run[key]) : cleanValue(run[key], grammar)),
    )
  )
    refusals.push("run-shape");

  if (
    !isRecord(sources) ||
    Object.keys(sources).length !== grammar.sourceNames.length ||
    !grammar.sourceNames.every((name) => cleanValue(sources[name], grammar))
  )
    refusals.push("sources-shape");
  else {
    // Each log is a separate witness; the counter above all must not share a source with the guard path.
    if (new Set(Object.values(sources)).size !== grammar.sourceNames.length) refusals.push("source-not-independent");
    if (label === "installed" && Object.values(sources).some((ref) => ref.startsWith("synthetic:")))
      refusals.push("synthetic-source-labelled-installed");
  }

  const sealShape = (seal) =>
    isRecord(seal) &&
    Object.keys(seal).length === 2 &&
    Number.isSafeInteger(seal.from) &&
    Number.isSafeInteger(seal.to) &&
    seal.from >= 1 &&
    seal.from <= seal.to;
  if (
    !isRecord(seals) ||
    Object.keys(seals).some((name) => !grammar.sealable.includes(name) || !sealShape(seals[name]))
  )
    refusals.push("seals-shape");

  if (!Array.isArray(events) || events.length === 0 || events.length > grammar.limits.events)
    refusals.push("events-shape");
  else {
    let previous;
    for (const [index, event] of events.entries()) {
      const problem = checkEvent(event, index, grammar, previous);
      if (problem) {
        refusals.push(problem);
        break;
      }
      previous = event.seq;
      const seal = isRecord(seals) ? seals[event.source] : undefined;
      if (seal && (event.seq < seal.from || event.seq > seal.to)) refusals.push(`event-outside-seal:${index}`);
    }
  }
  if (refusals.length) return refusals;

  // Contradictions between labels are ambiguity, not evidence: refuse rather than choose.
  const requestScope = new Map();
  const answers = new Set();
  const effects = new Set();
  for (const event of events) {
    if (event.kind === "acp.permission-request") {
      if (requestScope.has(event.inv)) return ["duplicate-permission-request"];
      requestScope.set(event.inv, event.scope);
    }
    if (["executor.start", "executor.effect"].includes(event.kind)) effects.add(event.inv);
    if (event.kind === "acp.permission-answer") {
      if (answers.has(event.inv)) return ["duplicate-permission-answer"];
      if (effects.has(event.inv)) return ["answer-after-execution"];
      answers.add(event.inv);
      if (!requestScope.has(event.inv)) return ["answer-without-request"];
      if (event.outcome === "allow-always-exact" && requestScope.get(event.inv) !== "exact")
        return ["answer-scope-conflict"];
    }
  }
  if ([...requestScope.keys()].some((inv) => !answers.has(inv))) return ["missing-permission-answer"];
  return [];
}

/** Derives receipts from a validated journal. */
function derive({ label, run, sources, seals, events }) {
  const withheld = [];
  const stops = new Set();
  const calls = new Map();
  const windows = new Map();
  for (const event of events) {
    if (event.inv === undefined) continue;
    if (!calls.has(event.inv)) calls.set(event.inv, `call-${calls.size + 1}`);
    const window = windows.get(event.inv) ?? { from: event.seq, to: event.seq };
    window.to = event.seq;
    windows.set(event.inv, window);
  }
  const covers = (name, window) => {
    const seal = seals[name];
    return !!seal && seal.from <= window.from && seal.to >= window.to;
  };
  const has = (inv, kind) => events.some((event) => event.inv === inv && event.kind === kind);
  // A remembered native grant is exact only when the offer named this fixture alone and the operator
  // chose to remember it; a wider offer is a stop for the row, never a cache to rely on.
  const exactGrantAt = events.find(
    (event) => event.kind === "acp.permission-answer" && event.outcome === "allow-always-exact",
  )?.seq;
  if (events.some((event) => event.kind === "acp.permission-request" && event.scope === "wider"))
    stops.add("wider-native-grant-offered");

  const rows = [];
  const row = (event, stage, fields = {}) => {
    const base = {
      stage,
      level: LEVEL[label],
      sourceRef: label === "synthetic" ? `synthetic:${event.source}` : sources[event.source],
      runRef: run.runRef,
    };
    if (event.inv !== undefined) Object.assign(base, { callRef: calls.get(event.inv), invocationRef: event.inv });
    rows.push({ ...base, ...fields });
  };
  const bound = (event) => ({
    ...(event.action === undefined ? {} : { actionRef: event.action === "fixture" ? run.actionRef : CHANGED.action }),
    ...(event.cwd === undefined ? {} : { cwdRef: event.cwd === "fixture" ? run.cwdRef : CHANGED.cwd }),
  });
  const optional = (event) => ({
    ...(event.generation === undefined ? {} : { generation: event.generation }),
    ...(event.binding === undefined ? {} : { bindingRef: event.binding }),
  });
  const seenDispatch = new Set();

  for (const event of events) {
    const callRef = calls.get(event.inv);
    switch (event.kind) {
      case "acp.tool-call": {
        if (event.route !== "fixture") stops.add(`unsupported-route:${event.route}`);
        const window = windows.get(event.inv);
        let outcome;
        if (seenDispatch.has(event.inv)) outcome = "replay";
        else if (has(event.inv, "acp.permission-request")) outcome = "new";
        else if (exactGrantAt !== undefined && exactGrantAt < event.seq && covers("acp", window)) outcome = "cached";
        seenDispatch.add(event.inv);
        if (outcome) row(event, "native-dispatch", { outcome, ...optional(event), ...bound(event) });
        else withheld.push({ callRef, stage: "native-dispatch", reason: "dispatch-kind-unobservable" });
        if (!has(event.inv, "hook.frame")) {
          if (covers("hook", window)) row({ ...event, source: "hook" }, "hook-invoked", { outcome: "not-invoked" });
          else withheld.push({ callRef, stage: "hook-invoked", reason: "hook-log-unsealed" });
        }
        break;
      }
      case "acp.permission-request":
        row(event, "native-ask", { outcome: "asked" });
        break;
      case "acp.permission-answer":
        break;
      case "acp.cancel":
        row(event, "cancellation", { outcome: "cancelled" });
        break;
      case "hook.frame":
        row(event, "hook-invoked", { outcome: "invoked", ...bound(event) });
        break;
      case "hook.response":
      case "guard.hook-failure":
        row(event, "hook-response", { outcome: event.outcome });
        break;
      case "guard.native-continued":
        row(event, "native-continued", { outcome: event.outcome });
        break;
      case "guard.config-mutation":
        row(event, "config-mutation", { outcome: event.outcome });
        break;
      case "policy.decision":
        row(event, "orca-decision", { outcome: event.outcome, ...optional(event), ...bound(event) });
        break;
      case "policy.revocation":
        row(event, "revocation", { outcome: "revoked", ...optional(event) });
        break;
      case "executor.start":
        row(event, "tool-start", { outcome: event.outcome, ...optional(event), ...bound(event) });
        break;
      case "executor.effect":
        row(event, "effect-observed", { outcome: "observed" });
        break;
      case "counter.reading":
        if (seals.counter) row(event, "effect-check", { outcome: event.outcome });
        else withheld.push({ callRef, stage: "effect-check", reason: "counter-log-unsealed" });
        break;
      default:
        throw new Error(`unreachable kind ${event.kind}`);
    }
  }
  const receipts = rows.map((receipt, index) => ({ seq: index + 1, ...receipt }));
  return { receipts, withheld, stops: [...stops].sort() };
}

/** Collects one journal. The result never carries raw events, only receipts and reason codes. */
export function collect(
  observations,
  { grammar = read(OBSERVATION_FORMAT_PATH), receiptFormat = read(RECEIPT_FORMAT_PATH) } = {},
) {
  const label = isRecord(observations) && grammar.labels.includes(observations.label) ? observations.label : "unknown";
  const result = {
    format: COLLECTION_FORMAT,
    label,
    qualification: "UNKNOWN",
    authenticity: "unverified",
  };
  const refusals = refusalsFor(observations, grammar, receiptFormat);
  if (refusals.length) return { ...result, disposition: "REFUSED", refusals, withheld: [], stops: [], record: null };
  const { receipts, withheld, stops } = derive(observations);
  const record = { format: receiptFormat.experiment.format, run: { ...observations.run }, receipts };
  if (Buffer.byteLength(JSON.stringify(record)) > receiptFormat.limits.transportBytes)
    return { ...result, disposition: "REFUSED", refusals: ["record-oversize"], withheld: [], stops: [], record: null };
  return { ...result, disposition: "RECORDED", refusals: [], withheld, stops, record };
}

/** Classifies a collection with the merged classifier; a refused journal has nothing to classify. */
export function classifyCollection(collection, classifier, manifest = classifier.provenance) {
  if (collection.disposition !== "RECORDED") return { outcome: "NOT-CLASSIFIED", route: "UNKNOWN" };
  const { outcome, tier, route, provenance, sequence, review, reasons } = classifier.classifyExperiment(
    collection.record,
    manifest,
    classifier.expectedRun(collection.record.run.tool),
  );
  return {
    outcome: collection.stops.length ? "INCONSISTENT-EVIDENCE" : outcome,
    tier: collection.stops.length ? "collection-stopped" : tier,
    route,
    provenance,
    sequence: collection.stops.length
      ? {
          ...sequence,
          state: "inconsistent",
          inconsistent: [...new Set([...sequence.inconsistent, ...collection.stops])].sort(),
        }
      : sequence,
    review: collection.stops.length
      ? { ...review, decision: "UNKNOWN", cachedRepeatChecked: false, revocationBlocked: false }
      : review,
    ...(reasons ? { reasons } : {}),
    ...(collection.stops.length ? { stops: collection.stops } : {}),
  };
}

export async function main(argv) {
  const args = argv.filter((arg) => arg !== "--classify");
  if (args.length !== 1) {
    process.stderr.write("usage: collect-evidence.mjs <observations.json> [--classify]\n");
    return 64;
  }
  let input;
  try {
    input = readFileSync(args[0], "utf8");
  } catch {
    process.stderr.write("journal-read-error\n");
    return 1;
  }
  let observations;
  try {
    observations = JSON.parse(input);
  } catch {
    process.stderr.write("journal-parse-error\n");
    return 1;
  }
  const collection = collect(observations);
  if (argv.includes("--classify")) {
    const { loadMergedClassifier } = await import("./merged-classifier.mjs");
    collection.classification = classifyCollection(collection, loadMergedClassifier());
  }
  process.stdout.write(`${JSON.stringify(collection, null, 2)}\n`);
  return collection.disposition === "RECORDED" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
