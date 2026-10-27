/**
 * Runs the merged #704 completion classifier (#745, #760, corrected by #763) exactly as merged.
 *
 * The classifier lives inside tools/test/claude-qualification-704.test.js and is not exported. Copying
 * it would create a second classifier that could drift, and editing that file is out of scope for the
 * readiness packet, so this loader reads the two merged regions, refuses them unless their SHA-256
 * still matches the pins below, and evaluates them with the merged fixtures. A pin mismatch means the
 * merged classifier changed: review the change, then update the pins in a reviewed commit.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const MERGED = "tools/test/claude-qualification-704.test.js";
const FIXTURES = "tools/test/fixtures/provider-enforcement-704-705/claude-qualification/";

/** Region boundaries in the merged file. Start is included, end is excluded. */
const REGIONS = {
  constants: { start: "const LEVELS = [", end: "const CELL = " },
  classifier: {
    start: "/** An installed fact counts only as installed-observed",
    end: "// ---------------------------------------------------------------------------------------------\n// Protocol harness.",
  },
};

export const MERGED_REGION_SHA256 = {
  constants: "8e8b950f6900e56c7d6d921df73138e35e8db6b31da494c46713a66115b75b03",
  classifier: "8665c50ce92b204c9d09d403b36a34ba472459cd036dc2044ee83466f48c13ae",
};

const EXPORTS = [
  "LEVELS",
  "FAILURE_MODES",
  "REQUIRED_INSTALLED_FACTS",
  "classifyProvenance",
  "hypotheticalInstalledManifest",
  "validReceipt",
  "assess",
  "expectedRun",
  "provenanceAuthenticity",
  "classifyExperiment",
];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const json = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

function region(text, { start, end }, name) {
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from);
  if (from < 0 || to < 0 || text.indexOf(start, from + 1) >= 0)
    throw new Error(`merged classifier region "${name}" not found exactly once in ${MERGED}`);
  return text.slice(from, to);
}

/** The merged regions and their digests, without evaluating anything. */
export function mergedRegions() {
  const text = readFileSync(new URL(MERGED, root), "utf8");
  return Object.fromEntries(
    Object.entries(REGIONS).map(([name, bounds]) => {
      const source = region(text, bounds, name);
      return [name, { source, sha256: sha256(source) }];
    }),
  );
}

/** The merged classifier functions, bound to the merged evidence format, scenarios and provenance. */
export function loadMergedClassifier({ pins = MERGED_REGION_SHA256 } = {}) {
  const regions = mergedRegions();
  for (const [name, { sha256: actual }] of Object.entries(regions))
    if (actual !== pins[name])
      throw new Error(`merged classifier region "${name}" changed (sha256 ${actual}); review it and update the pin`);
  const format = json(`${FIXTURES}evidence-format.json`);
  const scenarios = json(`${FIXTURES}scenarios.json`);
  const provenance = json(`${FIXTURES}provenance.json`);
  // canonicalFromProvenance, also in the region, needs the strict-permission fixtures. It is never
  // called through this loader, so they are bound to a function that refuses.
  const unavailable = () => {
    throw new Error("canonical admission is not part of the readiness loader");
  };
  // Evaluates the pinned merged source; see the header comment.
  const factory = new Function(
    "format",
    "scenarios",
    "provenance",
    "actionFixture",
    "stateFixture",
    `"use strict";\n${regions.constants.source}\n${regions.classifier.source}\nreturn { ${EXPORTS.join(", ")} };`,
  );
  return { ...factory(format, scenarios, provenance, unavailable, unavailable), format, scenarios, provenance };
}
