/** Pure synthetic contract oracle. No filesystem probes, subprocesses, locks or launch authority. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path/posix";

const schemas = Object.fromEntries(
  ["contract", "snapshot", "result"].map((name) => [
    name,
    JSON.parse(readFileSync(new URL(`./${name}-v1.schema.json`, import.meta.url), "utf8")),
  ]),
);
const refuse = (ok, code) => {
  if (!ok) throw new Error(code);
};

/** Canonical JSON v1: sorted ASCII object keys, ordered arrays, safe integers only. */
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    refuse(Number.isSafeInteger(value) && !Object.is(value, -0), "NON_JSON_NUMBER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  refuse(value && Object.getPrototypeOf(value) === Object.prototype, "NON_JSON_OBJECT");
  const keys = Object.keys(value).sort();
  refuse(
    keys.every((key) => /^[\x20-\x7e]+$/.test(key)),
    "NON_ASCII_KEY",
  );
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
export const digest = (value) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
/** External v1 envelopes must use canonical bytes; this also rejects duplicate JSON keys. */
export function decodeCanonical(text) {
  const value = JSON.parse(text);
  refuse(canonical(value) === text, "NON_CANONICAL_JSON");
  return value;
}
const same = (a, b) => canonical(a) === canonical(b);

/** Only the checked-in schemas' vocabulary is supported; this is not a general JSON Schema library. */
function shape(value, schema) {
  if (schema.anyOf) {
    refuse(
      schema.anyOf.some((choice) => {
        try {
          shape(value, choice);
          return true;
        } catch {
          return false;
        }
      }),
      "SCHEMA",
    );
    return;
  }
  if (Object.hasOwn(schema, "const")) refuse(same(value, schema.const), "SCHEMA");
  if (schema.enum)
    refuse(
      schema.enum.some((x) => same(x, value)),
      "SCHEMA",
    );
  if (schema.type === "object") {
    refuse(value && Object.getPrototypeOf(value) === Object.prototype, "SCHEMA");
    refuse(
      Object.keys(value).length === schema.required.length && schema.required.every((key) => Object.hasOwn(value, key)),
      "SCHEMA",
    );
    for (const key of schema.required) shape(value[key], schema.properties[key]);
  }
  if (schema.type === "array") {
    refuse(Array.isArray(value) && value.length <= schema.maxItems, "SCHEMA");
    for (const item of value) shape(item, schema.items);
  }
  if (schema.type === "string") {
    refuse(
      typeof value === "string" &&
        value.length >= (schema.minLength ?? 0) &&
        value.length <= schema.maxLength &&
        !value.includes("\0"),
      "SCHEMA",
    );
    if (schema.pattern) refuse(new RegExp(schema.pattern).test(value), "SCHEMA");
  }
  if (schema.type === "integer")
    refuse(
      Number.isSafeInteger(value) && !Object.is(value, -0) && value >= schema.minimum && value <= schema.maximum,
      "SCHEMA",
    );
  if (schema.type === "boolean") refuse(typeof value === "boolean", "SCHEMA");
  if (schema.type === "null") refuse(value === null, "SCHEMA");
}
export const validateShape = (value, name) => {
  canonical(value);
  shape(value, schemas[name]);
};
const unique = (values, code) => refuse(new Set(values).size === values.length, code);
const canonicalComponents = (value) =>
  typeof value === "string" &&
  !/[\p{Cc}\u2028\u2029\\]/u.test(value) &&
  value.split("/").every((component) => component && component !== "." && component !== "..");
const relative = (value) => {
  refuse(
    canonicalComponents(value) && value.split("/").every((component) => component !== ".git" && component !== ".orca"),
    "UNSAFE_PATH",
  );
};
const absolute = (value) => {
  // Git metadata is a legitimate identity location, never an allowed copy output.
  refuse(typeof value === "string" && value.startsWith("/") && canonicalComponents(value.slice(1)), "UNSAFE_ROOT");
};
const within = (value, root) => value === root || value.startsWith(`${root}/`);

export function validateBinding(contract, trustedDigest, now) {
  validateShape(contract, "contract");
  refuse(digest(contract) === trustedDigest, "CONTRACT_PIN");
  const i = contract.inputs;
  const r = i.receipt;
  refuse(
    r.runId === i.runId &&
      r.path === i.root.path &&
      r.repo === i.repository &&
      r.branch === i.branch &&
      r.commonDir === i.commonDir &&
      r.baseCommit === i.baseCommit &&
      i.ready.gitDir === i.gitDir,
    "BINDING_JOIN",
  );
  [i.repository, i.commonDir, i.gitDir, i.root.path, i.source.path].forEach(absolute);
  refuse(
    !within(i.source.path, i.root.path) &&
      !within(i.root.path, i.source.path) &&
      !(i.source.device === i.root.device && i.source.inode === i.root.inode),
    "ROOT_OVERLAP",
  );
  refuse(
    contract.validity.notBefore <= now && now < contract.validity.expiresAt && contract.validity.checkpointMaxAgeMs > 0,
    "CONTRACT_EXPIRED",
  );
  refuse(
    contract.outputs.length > 0 && contract.requiredChecks.length > 0 && i.manifests.length > 0 && i.tools.length > 0,
    "EMPTY_REQUIREMENTS",
  );
  unique(contract.outputs, "DUPLICATE_OUTPUT");
  contract.outputs.forEach(relative);
  i.manifests.forEach((manifest) => relative(manifest.path));
  relative(i.lock.path);
  for (const a of contract.outputs)
    for (const b of contract.outputs) refuse(a === b || !within(a, b), "OUTPUT_OVERLAP");
  unique(contract.requiredChecks, "DUPLICATE_CHECK");
  unique(
    i.manifests.map((m) => m.path),
    "DUPLICATE_MANIFEST",
  );
  unique(
    i.tools.map((t) => t.name),
    "DUPLICATE_TOOL",
  );
  return trustedDigest;
}

function inventory(entries, outputs, workspace = false) {
  unique(
    entries.map((e) => e.path),
    "DUPLICATE_ENTRY",
  );
  const map = new Map(entries.map((e) => [e.path, e]));
  for (const e of entries) {
    relative(e.path);
    refuse(workspace || outputs.some((o) => within(e.path, o)), "OUTPUT_SCOPE");
    refuse(e.mode <= 0o777, "SPECIAL_MODE");
    if (e.kind === "file") refuse(e.nlink === 1 && e.target === "", "SHARED_HARDLINK");
    else refuse(e.bytes === 0 && (e.kind === "symlink" || e.target === ""), "ENTRY_FIELDS");
    const parent = path.dirname(e.path);
    if (!workspace && !outputs.includes(e.path)) refuse(map.get(parent)?.kind === "directory", "INVENTORY_PARENT");
  }
  if (!workspace) for (const o of outputs) refuse(map.get(o)?.kind === "directory", "OUTPUT_DIRECTORY");
  unique(
    entries.filter((e) => e.kind === "file").map((e) => `${e.device}:${e.inode}`),
    "SHARED_HARDLINK",
  );
  return map;
}

/** Resolve complete virtual chains, including children exposed by workspace-directory links. */
function links(entries, workspaceEntries, outputs) {
  const dep = inventory(entries, outputs);
  const ws = inventory(workspaceEntries, outputs, true);
  const all = new Map([...dep, ...ws]);
  refuse(all.size === dep.size + ws.size, "WORKSPACE_OVERLAP");
  unique(
    [...all.values()].filter((e) => e.kind === "file").map((e) => `${e.device}:${e.inode}`),
    "SHARED_HARDLINK",
  );
  const parents = new Set();
  for (const p of all.keys()) {
    let parent = path.dirname(p);
    while (parent !== ".") {
      parents.add(parent);
      parent = path.dirname(parent);
    }
  }
  // A link to a workspace directory exposes every child. Check its complete
  // pinned inventory too, including indirect symlinks rather than just the root.
  for (const e of [...all.values()].filter((e) => e.kind === "symlink")) {
    let todo = e.path.split("/");
    const parts = [];
    let traversed = 0;
    while (todo.length) {
      const part = todo.shift();
      if (part === "." || part === "") continue;
      if (part === "..") {
        refuse(parts.length > 0, "ESCAPING_LINK");
        parts.pop();
        continue;
      }
      refuse(![".git", ".orca"].includes(part), "PRIVATE_LINK");
      const p = [...parts, part].join("/");
      const item = all.get(p);
      refuse(item || parents.has(p), "UNKNOWN_LINK_TARGET");
      if (item?.kind === "symlink") {
        refuse(++traversed <= 40, "CYCLIC_LINK");
        refuse(
          item.target && !item.target.startsWith("/") && !item.target.includes("\0") && !item.target.includes("\\"),
          "ABSOLUTE_LINK",
        );
        todo = [...item.target.split("/"), ...todo];
      } else {
        refuse(!todo.length || !item || item.kind === "directory", "NONDIRECTORY_LINK");
        parts.push(part);
      }
    }
    refuse(all.has(parts.join("/")), "UNKNOWN_LINK_TARGET");
  }
}

function capacity(contract, observed, now) {
  const c = contract.capacity;
  refuse(observed.profileSha256 === contract.inputs.profile.sha256, "CAPACITY_PROFILE");
  refuse(observed.at <= now && now - observed.at <= contract.validity.checkpointMaxAgeMs, "CAPACITY_STALE");
  refuse(
    observed.cgroupMembershipCount === 1 &&
      observed.cgroupMountCount === 1 &&
      observed.ancestorsComplete &&
      observed.cgroups.length > 0,
    "CAPACITY_AMBIGUOUS",
  );
  const headrooms = [observed.hostAvailableBytes];
  unique(
    observed.cgroups.map((g) => g.path),
    "CAPACITY_AMBIGUOUS",
  );
  const groups = observed.cgroups;
  refuse(groups.at(-1).isHierarchyRoot && groups.slice(0, -1).every((g) => !g.isHierarchyRoot), "CAPACITY_AMBIGUOUS");
  for (let index = 0; index < groups.length; index++) {
    const g = groups[index];
    absolute(g.path);
    if (index > 0) refuse(path.dirname(groups[index - 1].path) === g.path, "CAPACITY_AMBIGUOUS");
    if (g.currentBytes === null)
      refuse(g.isHierarchyRoot && g.maxBytes === null && g.highBytes === null, "CAPACITY_MISSING");
    else
      for (const limit of [g.maxBytes, g.highBytes])
        if (limit !== null) headrooms.push(Math.max(0, limit - g.currentBytes));
  }
  for (const limit of [observed.rlimitAsSoft, observed.rlimitAsHard, observed.rlimitDataSoft, observed.rlimitDataHard])
    if (limit !== null) headrooms.push(Math.max(0, limit - observed.virtualBytes));
  const required = Math.max(
    c.minimumAvailableBytes,
    4 * c.largestFileBytes + 4 * c.retainedShimBytes + 8 * c.manifestBytes + 192 * 1024 * 1024,
  );
  refuse(Number.isSafeInteger(required) && Math.min(...headrooms) >= required, "CAPACITY_INSUFFICIENT");
  refuse(observed.diskFreeBytes >= c.minimumFreeBytes, "DISK_INSUFFICIENT");
}

export function validateSnapshot(contract, observed, trustedDigest, now) {
  validateBinding(contract, trustedDigest, now);
  validateShape(observed, "snapshot");
  refuse(same(contract.inputs, observed.inputs), "INPUT_DRIFT");
  refuse(observed.at <= now && now - observed.at <= contract.validity.checkpointMaxAgeMs, "SNAPSHOT_STALE");
  refuse(
    digest(observed.entries) === contract.inputs.inventorySha256 &&
      digest(observed.workspaceEntries) === contract.inputs.workspaceSha256 &&
      digest(observed.shims) === contract.inputs.shimInventorySha256,
    "INVENTORY_DRIFT",
  );
  refuse(observed.existingOutputs.length === 0, "PARTIAL_OUTPUT");
  refuse(observed.git.length === 2 && new Set(observed.git.map((g) => g.role)).size === 2, "GIT_EVIDENCE");
  for (const g of observed.git) {
    refuse(g.filterKeys.length === 0, "GIT_FILTER");
    refuse(
      g.indexTags.every((tag) => tag === "H"),
      "GIT_INDEX_FLAGS",
    );
    refuse(
      !g.gitlinks && !g.gitmodules && g.trackedClean && g.registrationValid && g.pathsNoSymlinks,
      "GIT_UNSUPPORTED",
    );
  }
  links(observed.entries, observed.workspaceEntries, contract.outputs);
  const files = observed.entries.filter((e) => e.kind === "file");
  const shimPaths = files
    .filter((e) => e.path.includes("/.bin/"))
    .map((e) => e.path)
    .sort();
  unique(
    observed.shims.map((s) => s.path),
    "SHIM_SET",
  );
  refuse(same(shimPaths, observed.shims.map((s) => s.path).sort()), "SHIM_SET");
  for (const s of observed.shims) {
    refuse(s.template === "reviewed-pnpm-posix-v1", "UNKNOWN_SHIM");
    refuse(
      files.find((f) => f.path === s.path)?.sha256 === s.beforeSha256 &&
        files.find((f) => f.path === s.path)?.mode === 0o755,
      "SHIM_DRIFT",
    );
    refuse(s.prefixEdits >= 3 && s.prefixEdits % 2 === 1, "SHIM_SPANS");
    const growth = Buffer.byteLength(contract.inputs.root.path) - Buffer.byteLength(contract.inputs.source.path);
    refuse(s.afterBytes === files.find((f) => f.path === s.path).bytes + s.prefixEdits * growth, "SHIM_SIZE");
  }
  const retained = observed.shims.reduce(
    (sum, s) => sum + Math.max(s.afterBytes, files.find((f) => f.path === s.path).bytes),
    0,
  );
  refuse(Number.isSafeInteger(retained) && retained <= contract.capacity.retainedShimBytes, "SHIM_BUDGET");
  refuse(
    Math.max(0, ...[...files, ...observed.workspaceEntries].map((f) => f.bytes)) <= contract.capacity.largestFileBytes,
    "PAYLOAD_BUDGET",
  );
  capacity(contract, observed.capacity, now);
}

function checkpoint(c, result, contract, earliest, latest) {
  const i = contract.inputs;
  refuse(
    c.nonce === result.nonce &&
      c.runId === i.runId &&
      c.stepRunId === i.stepRunId &&
      c.nodeId === i.nodeId &&
      c.inputId === i.inputId &&
      c.generationSha256 === i.generation.sha256,
    "CHECKPOINT_JOIN",
  );
  refuse(
    earliest <= c.at && c.at <= latest && latest - c.at <= contract.validity.checkpointMaxAgeMs,
    "CHECKPOINT_STALE",
  );
}

function ownershipValid(trust, now) {
  return (
    trust.exclusive === true &&
    Number.isSafeInteger(trust.leaseExpiresAt) &&
    now < trust.leaseExpiresAt &&
    [trust.attemptId, trust.fenceId, trust.nonce].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0"),
    )
  );
}

/** Trust contains externally pinned digests and acquired fence identity, never values from the result. */
export function validateResult(contract, before, result, trust, now) {
  validateSnapshot(contract, before, trust.contractDigest, result.startedAt);
  validateBinding(contract, trust.contractDigest, now);
  validateShape(result, "result");
  refuse(digest(result) === trust.resultDigest, "RESULT_PIN");
  const i = contract.inputs;
  refuse(
    result.contractDigest === trust.contractDigest &&
      result.runId === i.runId &&
      same(result.root, i.root) &&
      result.branch === i.branch &&
      result.baseCommit === i.baseCommit &&
      result.generationSha256 === i.generation.sha256 &&
      result.profileSha256 === i.profile.sha256,
    "RESULT_JOIN",
  );
  refuse(
    ownershipValid(trust, now) &&
      result.attemptId === trust.attemptId &&
      result.fenceId === trust.fenceId &&
      result.nonce === trust.nonce,
    "OWNERSHIP_UNAVAILABLE",
  );
  refuse(
    result.startedAt <= result.completedAt &&
      result.completedAt <= now &&
      now < result.expiresAt &&
      result.expiresAt <= contract.validity.expiresAt,
    "RESULT_STALE",
  );
  checkpoint(result.beforeCheckpoint, result, contract, result.startedAt, result.startedAt);
  checkpoint(result.afterCheckpoint, result, contract, result.completedAt, now);
  const v = result.verification;
  refuse(
    v.sourceBeforeSha256 === i.inventorySha256 &&
      v.sourceAfterSha256 === i.inventorySha256 &&
      v.workspaceSha256 === i.workspaceSha256,
    "SOURCE_DRIFT",
  );
  refuse(digest(v.entries) === result.copy.outputInventorySha256, "OUTPUT_DIGEST");
  const dest = inventory(v.entries, contract.outputs);
  const source = new Map(before.entries.map((e) => [e.path, e]));
  refuse(dest.size === source.size, "OUTPUT_SET");
  const forbidden = new Set(
    [...before.entries, ...before.workspaceEntries, ...(trust.otherRootFiles ?? [])]
      .filter((e) => e.kind === "file")
      .map((e) => `${e.device}:${e.inode}`),
  );
  for (const e of dest.values()) {
    const original = source.get(e.path);
    refuse(
      original && original.kind === e.kind && original.mode === e.mode && original.target === e.target,
      "OUTPUT_CHANGED",
    );
    if (e.kind === "file") {
      refuse(!forbidden.has(`${e.device}:${e.inode}`), "SHARED_ROOT_FILE");
      const shim = before.shims.find((s) => s.path === e.path);
      refuse(
        e.sha256 === (shim?.afterSha256 ?? original.sha256) && e.bytes === (shim?.afterBytes ?? original.bytes),
        "OUTPUT_CHANGED",
      );
    }
  }
  links(v.entries, before.workspaceEntries, contract.outputs);
  unique(
    v.checks.map((c) => c.name),
    "CHECK_SET",
  );
  refuse(same(v.checks.map((c) => c.name).sort(), [...contract.requiredChecks].sort()), "CHECK_SET");
  refuse(
    v.checks.every((c) => c.status === "passed" && c.profileSha256 === i.profile.sha256),
    "CHECK_NOT_PASSED",
  );
  return digest(result);
}

/** Model a projection only. No failed/uncertain attempt can request a second copy. */
export function transition(state, event, context) {
  refuse(
    Object.keys(state).sort().join(",") === "attemptId,evidence,reason,status" && Array.isArray(state.evidence),
    "STATE",
  );
  refuse(Object.keys(event).sort().join(",") === "evidenceDigest,kind", "EVENT");
  refuse(["fresh", "preparing", "prepared", "blocked", "uncertain"].includes(state.status), "STATE");
  const next = (status, reason) => ({
    status,
    attemptId: state.attemptId,
    evidence: [...state.evidence, event.evidenceDigest],
    reason,
  });
  refuse(/^[a-f0-9]{64}$/.test(event.evidenceDigest), "EVENT_EVIDENCE");
  if (["blocked", "uncertain"].includes(state.status)) throw new Error("INSPECTION_REQUIRED");
  if (["crash", "lost-owner", "partial-output"].includes(event.kind)) return next("uncertain", event.kind);
  if (["drift", "expired", "refusal", "concurrent-owner"].includes(event.kind))
    return next(
      state.status === "preparing" && event.kind !== "concurrent-owner" ? "uncertain" : "blocked",
      event.kind,
    );
  if (event.kind === "begin") {
    refuse(state.status === "fresh", "SECOND_COPY");
    if (!ownershipValid(context.trust, context.now)) return next("blocked", "ownership");
    try {
      validateSnapshot(context.contract, context.before, context.trust.contractDigest, context.now);
    } catch {
      return next("blocked", "validation-refused");
    }
    return { ...next("preparing", "reserved"), attemptId: context.trust.attemptId };
  }
  if (event.kind === "verified") {
    refuse(state.status === "preparing" && state.attemptId === context.trust.attemptId, "ATTEMPT_JOIN");
    try {
      validateResult(context.contract, context.before, context.result, context.trust, context.now);
    } catch {
      return next("uncertain", "verification-refused");
    }
    return next("prepared", "verified");
  }
  throw new Error("UNSUPPORTED_EVENT");
}
