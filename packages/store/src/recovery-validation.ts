/** Pure conclusions about local inventory evidence; execution and production recovery stay unavailable. */
import {
  parseRecoveryManifest,
  pathCollisionKey,
  REQUIRED_COMPONENTS,
  STORE_COMPONENTS,
  type RecoveryManifest,
  type RecoveryReason,
} from "./recovery-manifest.js";

export interface RecoveryConclusion {
  status: "passed" | "failed" | "unknown" | "unavailable";
  reasons: RecoveryReason[];
}
export interface RecoveryValidation {
  structuralValidity: RecoveryConclusion;
  coverage: RecoveryConclusion;
  integrity: RecoveryConclusion;
  semanticReadability: RecoveryConclusion;
  writerConsistency: RecoveryConclusion;
  recoveryEligibility: RecoveryConclusion;
}
export interface SemanticReadEvidence {
  rootId: string;
  candidateRef: string;
  readable: boolean;
}
const conclusion = (status: RecoveryConclusion["status"], reasons: RecoveryReason[] = []): RecoveryConclusion => ({
  status,
  reasons: [...new Set(reasons)],
});
const covers = (base: string, path: string) => path === base || path.startsWith(`${base}/`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Observation and semantic evidence are engineering inputs, never authentication or all-writer authority. */
export function validateRecoveryManifest(
  json: string,
  evidence: { expectedCandidateRef: string; observedJson?: string; semanticReads?: readonly SemanticReadEvidence[] },
): RecoveryValidation {
  const parsed = parseRecoveryManifest(json);
  const result: RecoveryValidation = {
    structuralValidity: conclusion(parsed.valid ? "passed" : "failed", parsed.valid ? [] : parsed.reasons),
    coverage: conclusion("unknown"),
    integrity: conclusion("unknown", ["INTEGRITY_UNVERIFIED"]),
    semanticReadability: conclusion("unknown", ["SEMANTIC_UNVERIFIED"]),
    writerConsistency: conclusion("unknown", ["WRITER_COVERAGE_UNKNOWN"]),
    recoveryEligibility: conclusion("unavailable", ["RECOVERY_DISABLED"]),
  };
  if (!parsed.valid) return result;
  const manifest = parsed.manifest;
  let incompleteEnumeration = manifest.enumeration === "incomplete";
  const structural: RecoveryReason[] = [],
    coverage: RecoveryReason[] = [],
    integrity: RecoveryReason[] = [];
  if (manifest.candidateRef !== evidence.expectedCandidateRef) integrity.push("CANDIDATE_MISMATCH");
  const rootIds = new Set<string>();
  const byRoot = new Map<string, Set<string>>();
  for (const root of manifest.roots) {
    if (rootIds.has(root.id)) structural.push("PATH_COLLISION");
    rootIds.add(root.id);
    const paths = new Set<string>(),
      folded = new Set<string>(),
      components = new Set<string>();
    const entries = new Map(root.entries.map((entry) => [entry.path, entry]));
    const declarations = new Set<string>();
    byRoot.set(root.id, paths);
    for (const entry of root.entries) {
      if (folded.has(pathCollisionKey(entry.path))) structural.push("PATH_COLLISION");
      folded.add(pathCollisionKey(entry.path));
      paths.add(entry.path);
      const parts = entry.path.split("/");
      for (let depth = 1; depth < parts.length; depth++)
        if (entries.get(parts.slice(0, depth).join("/"))?.kind !== "directory") structural.push("PATH_UNSAFE");
      if (entry.candidateRef !== manifest.candidateRef) integrity.push("CANDIDATE_MISMATCH");
      if (entry.access.acl === "unverified") integrity.push("ACL_UNVERIFIED");
      if ((entry.access.mode & 0o077) !== 0) integrity.push("ACCESS_UNSAFE");
      if (entry.access.uid !== root.access.uid) integrity.push("ACCESS_UNSAFE");
      if (
        !root.components.some(
          (component) => component.state === "present" && component.paths.some((base) => covers(base, entry.path)),
        )
      )
        coverage.push("ENTRY_UNCLASSIFIED");
    }
    if (root.access.acl === "unverified") integrity.push("ACL_UNVERIFIED");
    if ((root.access.mode & 0o077) !== 0) integrity.push("ACCESS_UNSAFE");
    for (const component of root.components) {
      if (components.has(component.id)) structural.push("PATH_COLLISION");
      components.add(component.id);
      for (const path of component.paths) {
        const foldedPath = pathCollisionKey(path);
        if (declarations.has(foldedPath)) structural.push("PATH_COLLISION");
        declarations.add(foldedPath);
      }
      if (component.candidateRef !== manifest.candidateRef) integrity.push("CANDIDATE_MISMATCH");
      if (component.state === "unknown") coverage.push("COMPONENT_UNKNOWN");
      if (component.state === "external-unverified") coverage.push("EXTERNAL_UNVERIFIED");
      if (
        component.state === "present" &&
        (!component.paths.length || component.paths.some((path) => !paths.has(path)))
      )
        coverage.push("COMPONENT_MISSING");
      if (
        (component.state === "absent" || component.state === "not-applicable") &&
        root.entries.some((entry) => component.paths.some((base) => covers(base, entry.path)))
      )
        coverage.push("COMPONENT_MISSING");
    }
    for (const id of REQUIRED_COMPONENTS[root.role]) if (!components.has(id)) coverage.push("COMPONENT_UNKNOWN");
    if (root.role === "store") {
      for (const [id, requiredPaths] of Object.entries(STORE_COMPONENTS)) {
        const component = root.components.find((item) => item.id === id);
        if (component && requiredPaths.some((path) => !component.paths.includes(path)))
          coverage.push("COMPONENT_UNKNOWN");
      }
      if (!root.expectedIdentity || !root.observedIdentity) integrity.push("IDENTITY_MISSING");
      else if (root.expectedIdentity !== root.observedIdentity) integrity.push("IDENTITY_MISMATCH");
      if (
        !root.entries.some((entry) => entry.path === "workspace-identity/id" && entry.kind === "file") ||
        !root.entries.some((entry) => entry.path === ".workspace-identified" && entry.kind === "file")
      )
        integrity.push("IDENTITY_MISSING");
      for (const base of ["private-execution", "private-workflows"]) {
        const files = root.entries.filter(
          (entry) => entry.kind === "file" && covers(base, entry.path) && entry.path !== `${base}/.execution-key`,
        );
        const key = root.entries.find((entry) => entry.path === `${base}/.execution-key`);
        if ((files.length || root.entries.some((entry) => entry.path === base)) && !key) integrity.push("KEY_MISSING");
        if (key && (key.kind !== "file" || key.size !== 32)) integrity.push("KEY_INVALID");
      }
    }
    if (root.role === "app") {
      for (const [id, path] of [
        ["preferences", "preferences.json"],
        ["admission-intents", "admission-intents.enc"],
      ])
        if (!root.components.find((component) => component.id === id)?.paths.includes(path!))
          coverage.push("COMPONENT_UNKNOWN");
    }
  }
  for (const reference of manifest.references) {
    if (reference.candidateRef !== manifest.candidateRef) integrity.push("CANDIDATE_MISMATCH");
    if (!byRoot.get(reference.rootId)?.has(reference.path)) coverage.push("REFERENCE_MISSING");
  }
  const dependencyIds = new Set<string>();
  for (const dependency of manifest.external) {
    if (dependencyIds.has(dependency.id)) structural.push("PATH_COLLISION");
    dependencyIds.add(dependency.id);
    if (dependency.state === "external-unverified") coverage.push("EXTERNAL_UNVERIFIED");
    else if (dependency.state !== "not-applicable" && dependency.state !== "absent") coverage.push("COMPONENT_UNKNOWN");
  }
  for (const kind of ["workspace", "credential"])
    if (!manifest.external.some((item) => item.kind === kind)) coverage.push("COMPONENT_UNKNOWN");
  if (manifest.observation === "failed") integrity.push("OBSERVATION_CHANGED");
  integrity.push(...manifest.reasons);
  if (evidence.observedJson !== undefined) {
    const observed = parseRecoveryManifest(evidence.observedJson);
    if (observed.valid && observed.manifest.enumeration === "incomplete") incompleteEnumeration = true;
    if (!observed.valid || !matchesObservation(manifest, observed.manifest)) integrity.push("DIGEST_MISMATCH");
    else if (observed.manifest.observation !== "unchanged" || observed.manifest.reasons.length)
      integrity.push(...observed.manifest.reasons, "OBSERVATION_CHANGED");
  } else integrity.push("INTEGRITY_UNVERIFIED");
  result.structuralValidity = conclusion(structural.length ? "failed" : "passed", structural);
  const hardCoverage = coverage.filter((reason) => reason !== "EXTERNAL_UNVERIFIED");
  // Named-component declarations cannot establish coverage of entries an aborted scan never reached.
  if (incompleteEnumeration) coverage.push("COMPONENT_UNKNOWN");
  result.coverage = conclusion(hardCoverage.length ? "failed" : coverage.length ? "unknown" : "passed", coverage);
  result.integrity = conclusion(
    integrity.some((reason) => !["INTEGRITY_UNVERIFIED", "ACL_UNVERIFIED"].includes(reason))
      ? "failed"
      : integrity.length
        ? "unknown"
        : "passed",
    integrity,
  );
  const reads = evidence.semanticReads ?? [];
  if (reads.some((read) => !rootIds.has(read.rootId) || read.candidateRef !== manifest.candidateRef))
    result.semanticReadability = conclusion("failed", ["CANDIDATE_MISMATCH"]);
  else if (reads.some((read) => !read.readable))
    result.semanticReadability = conclusion("failed", ["SEMANTIC_UNREADABLE"]);
  else if (manifest.roots.every((root) => reads.some((read) => read.rootId === root.id)))
    result.semanticReadability = conclusion("passed");
  return result;
}
function matchesObservation(a: RecoveryManifest, b: RecoveryManifest): boolean {
  if (a.candidateRef !== b.candidateRef || a.roots.length !== b.roots.length) return false;
  return a.roots.every((root) => {
    const observed = b.roots.find((entry) => entry.id === root.id);
    if (
      !observed ||
      root.role !== observed.role ||
      root.observedIdentity !== observed.observedIdentity ||
      !same(root.access, observed.access) ||
      root.entries.length !== observed.entries.length
    )
      return false;
    const entries = new Map(observed.entries.map((entry) => [entry.path, entry]));
    return root.entries.every((entry) => {
      const other = entries.get(entry.path);
      // Physical inode numbers may differ in an isolated copied fixture; contents/access must not.
      return (
        other &&
        entry.kind === other.kind &&
        entry.size === other.size &&
        entry.sha256 === other.sha256 &&
        same(entry.access, other.access)
      );
    });
  });
}
