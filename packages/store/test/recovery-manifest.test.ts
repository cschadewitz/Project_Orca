/** Malformed or incomplete evidence cannot become compatibility, consistency or restore authority. */
import { expect, it } from "vitest";
import {
  parseRecoveryManifest,
  RECOVERY_LIMITS,
  safeRecoveryPath,
  type RecoveryManifest,
} from "../src/recovery-manifest.js";
import { validateRecoveryManifest } from "../src/recovery-validation.js";

function manifest(): RecoveryManifest {
  return {
    version: 1,
    candidateRef: "binary-a:epoch-4",
    roots: [
      {
        id: "app",
        role: "app",
        access: { mode: 0o700, uid: 0, gid: 0, acl: "posix-mode" },
        components: [
          { id: "preferences", paths: ["preferences.json"], state: "absent", candidateRef: "binary-a:epoch-4" },
          {
            id: "admission-intents",
            paths: ["admission-intents.enc"],
            state: "absent",
            candidateRef: "binary-a:epoch-4",
          },
        ],
        entries: [],
      },
    ],
    references: [],
    external: [
      { id: "workspace", kind: "workspace", state: "not-applicable" },
      { id: "credentials", kind: "credential", state: "not-applicable" },
    ],
    observation: "unchanged",
    reasons: [],
  };
}
const validate = (value: RecoveryManifest) =>
  validateRecoveryManifest(JSON.stringify(value), { expectedCandidateRef: value.candidateRef });

it("parses strictly without side effects and exposes no raw JSON/schema diagnostics", () => {
  expect(parseRecoveryManifest(JSON.stringify(manifest())).valid).toBe(true);
  for (const value of [
    "secret-private-malformed",
    "null",
    '{"privatePath":"/secret/location"}',
    JSON.stringify({ ...manifest(), quiescent: true }),
  ]) {
    expect(parseRecoveryManifest(value)).toEqual({ valid: false, reasons: ["MANIFEST_INVALID"] });
    expect(validateRecoveryManifest(value, { expectedCandidateRef: "binary-a" }).recoveryEligibility.status).toBe(
      "unavailable",
    );
  }
  expect(parseRecoveryManifest(" ".repeat(RECOVERY_LIMITS.maxManifestBytes + 1))).toEqual({
    valid: false,
    reasons: ["RESOURCE_LIMIT"],
  });
});

it.each(["/absolute", "../outside", "a/../b", "a\\b", "a//b", "a/.", "NUL", "a:stream", "trailing.", "a\u0000b"])(
  "rejects unsafe portable relative path %s",
  (path) => {
    expect(safeRecoveryPath(path)).toBe(false);
  },
);

it("refuses compatibility inferred from same epoch and reports conclusions separately", () => {
  const value = manifest();
  const result = validateRecoveryManifest(JSON.stringify(value), {
    expectedCandidateRef: "binary-b:epoch-4",
    observedJson: JSON.stringify(value),
    semanticReads: [{ rootId: "app", candidateRef: value.candidateRef, readable: true }],
  });
  expect(result.structuralValidity.status).toBe("passed");
  expect(result.coverage.status).toBe("passed");
  expect(result.integrity.reasons).toContain("CANDIDATE_MISMATCH");
  expect(result.semanticReadability.status).toBe("passed");
  expect(result.writerConsistency.status).toBe("unknown");
  expect(result.recoveryEligibility.status).toBe("unavailable");
});

it("requires every component and separately declared external dependencies", () => {
  const value = manifest();
  value.roots[0]!.components.pop();
  value.external = [];
  expect(validate(value).coverage.reasons).toContain("COMPONENT_UNKNOWN");
  const external = manifest();
  external.external[0]!.state = "external-unverified";
  expect(validate(external).coverage).toEqual({ status: "unknown", reasons: ["EXTERNAL_UNVERIFIED"] });
  const unknown = manifest();
  unknown.roots[0]!.components[0]!.state = "unknown";
  expect(validate(unknown).coverage.status).toBe("failed");
});

it("detects missing present paths, references, candidate mixtures and duplicate classifications", () => {
  const value = manifest();
  value.roots[0]!.components[0]!.state = "present";
  value.references.push({ rootId: "app", path: "missing-file", candidateRef: "other-era" });
  value.roots[0]!.components.push(value.roots[0]!.components[0]!);
  const result = validate(value);
  expect(result.coverage.reasons).toContain("COMPONENT_MISSING");
  expect(result.coverage.reasons).toContain("REFERENCE_MISSING");
  expect(result.integrity.reasons).toContain("CANDIDATE_MISMATCH");
  expect(result.structuralValidity.reasons).toContain("PATH_COLLISION");
});

it("rejects duplicate/case-colliding entries and withholds integrity without a fresh observation", () => {
  const value = manifest();
  const entry = {
    path: "new.json",
    kind: "file" as const,
    size: 0,
    sha256: "0".repeat(64),
    identity: { device: "1", inode: "2" },
    access: { mode: 0o600, uid: 0, gid: 0, acl: "posix-mode" as const },
    candidateRef: value.candidateRef,
  };
  value.roots[0]!.entries = [entry, { ...entry, path: "NEW.json" }];
  const result = validate(value);
  expect(result.structuralValidity.status).toBe("failed");
  expect(result.coverage.reasons).toContain("ENTRY_UNCLASSIFIED");
  expect(result.integrity.reasons).toContain("INTEGRITY_UNVERIFIED");
});

it("cannot substitute semantic evidence from another root/candidate or accept unreadable protected data", () => {
  const value = manifest(),
    json = JSON.stringify(value);
  expect(
    validateRecoveryManifest(json, {
      expectedCandidateRef: value.candidateRef,
      semanticReads: [{ rootId: "unknown", candidateRef: value.candidateRef, readable: true }],
    }).semanticReadability.status,
  ).toBe("failed");
  expect(
    validateRecoveryManifest(json, {
      expectedCandidateRef: value.candidateRef,
      semanticReads: [{ rootId: "app", candidateRef: value.candidateRef, readable: false }],
    }).semanticReadability.reasons,
  ).toEqual(["SEMANTIC_UNREADABLE"]);
  expect(validate(value).semanticReadability.status).toBe("unknown");
});

it("leaves Windows ACL evidence unverified and refuses observed mutation even with a matching hash list", () => {
  const value = manifest();
  value.roots[0]!.access.acl = "unverified";
  expect(validate(value).integrity.reasons).toContain("ACL_UNVERIFIED");
  value.observation = "failed";
  value.reasons = ["OBSERVATION_CHANGED"];
  const result = validateRecoveryManifest(JSON.stringify(value), {
    expectedCandidateRef: value.candidateRef,
    observedJson: JSON.stringify(value),
  });
  expect(result.integrity.status).toBe("failed");
  expect(result.writerConsistency.reasons).toEqual(["WRITER_COVERAGE_UNKNOWN"]);
});

it("refuses failed observations with no reasons and impossible parent topology", () => {
  const value = manifest();
  value.observation = "failed";
  expect(
    validateRecoveryManifest(JSON.stringify(value), {
      expectedCandidateRef: value.candidateRef,
      observedJson: JSON.stringify(manifest()),
    }).integrity.reasons,
  ).toContain("OBSERVATION_CHANGED");
  value.roots[0]!.entries.push({
    path: "missing-parent/file",
    kind: "file",
    size: 0,
    sha256: "0".repeat(64),
    identity: { device: "1", inode: "1" },
    access: { mode: 0o600, uid: 0, gid: 0, acl: "posix-mode" },
    candidateRef: value.candidateRef,
  });
  expect(validate(value).structuralValidity.reasons).toContain("PATH_UNSAFE");
});
