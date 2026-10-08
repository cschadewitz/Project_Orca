/** #396 acceptance ledger. Pending rows are obligations, never simulated implementation proof. */
export const baselineSha = "65606fbce827cba914a67b999b1a47c0aab2797a";
export const candidatePins = {
  substrate394: "7202a6e06525052f304f4f49abbfd783e163a375",
  jev395: "e4039a32e4a82aa19cd95b3e98f2813b47486903",
} as const;
/** Null means independent exact-head review remains unresolved. */
export const implementationPins = { substrate394: null, jev395: "e4039a32e4a82aa19cd95b3e98f2813b47486903" } as const;
/** Observed draft contract only; this does not authorize acceptance or activate tests. */
export const provisionalContract = {
  substrateComment: "https://github.com/cschadewitz/Project_Orca/issues/394#issuecomment-6051433591",
  jevDraftHead: "e4039a32e4a82aa19cd95b3e98f2813b47486903",
  supportedRegistration: "custom-executor-only",
} as const;
export const pendingAcceptance = [
  ["394", "opted-in executor restores captured closure inputs; new admission adopts changed inputs"],
  ["394", "supported descriptor schema restores; future and unsupported legacy schemas refuse"],
  ["394", "missing, malformed and tampered descriptors refuse before provisioning or execution"],
  ["394", "code and transitive dependency identity mismatch refuse before effects"],
  ["394", "duplicate identities and partial candidate reconstruction never activate any registration"],
  ["394", "host/workspace/plan/human-input callbacks explicitly refuse under executor-only v1"],
  ["394", "unclassified callbacks make the entire candidate non-restorable"],
  ["395", "JEV before evaluation restores model/endpoint defaults and preserves node overrides"],
  ["395", "JEV after durable evaluation retains artifact/result/provenance without reevaluation"],
  ["395", "missing, revoked or changed credential reference/provider/account refuses before a call"],
  ["395", "injected arbitrary provider callbacks refuse without a compatible explicit factory"],
  ["395", "lost provider response stays visibly ambiguous; resume cannot assert exactly-once effects"],
  ["395", "descriptor, public provenance, artifacts, logs and errors contain no credential values"],
  ["394/395", "current resume authority and lease fencing compose with the restored plugin candidate"],
  ["Actual-Cal", "actual private MCP route inspects and explicitly resumes the agreed permitted plugin"],
] as const;
