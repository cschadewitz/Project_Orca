/** Synthetic-only acceptance tests; standard-library runner, no real copy or host probes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  canonical,
  decodeCanonical,
  digest,
  validateBinding,
  validateSnapshot,
  validateResult,
  transition,
} from "./validate-contract.mjs";

/** Register the same assertions with Node or Vitest; registration itself has no effects. */
export function defineContractTests(test) {
  const original = JSON.parse(readFileSync(new URL("./fixtures/synthetic-v1.json", import.meta.url), "utf8"));
  const fixture = () => structuredClone(original);
  const result = (f) => validateResult(f.contract, f.before, f.result, f.trust, f.now);
  const snapshot = (f) => validateSnapshot(f.contract, f.before, f.trust.contractDigest, f.result.startedAt);
  const binding = (f) => validateBinding(f.contract, f.trust.contractDigest, f.now);
  // Tests may model a *separately approved* synthetic policy to reach a semantic guard.
  // Production MUST NOT create trusted pins from incoming content to make it pass.
  function pinContract(f) {
    f.trust.contractDigest = digest(f.contract);
    f.before.inputs = structuredClone(f.contract.inputs);
    f.result.contractDigest = f.trust.contractDigest;
  }
  function pinInventories(f) {
    f.contract.inputs.inventorySha256 = digest(f.before.entries);
    f.contract.inputs.workspaceSha256 = digest(f.before.workspaceEntries);
    f.contract.inputs.shimInventorySha256 = digest(f.before.shims);
    pinContract(f);
  }
  function pinResult(f) {
    f.trust.resultDigest = digest(f.result);
  }
  function negative(name, mutate, validate = result, code, approve) {
    test(name, () => {
      const f = fixture();
      mutate(f);
      approve?.(f);
      assert.throws(() => validate(f), code ? (error) => error.message === code : undefined);
    });
  }

  test("valid synthetic contract and result have frozen deterministic digests", () => {
    const f = fixture();
    assert.equal(binding(f), "280c63f2a77506a2ea915e89a55adf4d7add1c776430b88fed443dab4f340abe");
    assert.equal(result(f), "bdfd0bdd16ff1d92477ce213359a92afb7f2e3c304bede6c94ffe9c00c53d258");
    assert.equal(digest({ z: 1, a: [false, null, "fixture"] }), digest({ a: [false, null, "fixture"], z: 1 }));
  });
  for (const value of [NaN, Infinity, -0, 0.5, undefined, new Date(0)]) {
    test(`canonical JSON refuses ${String(value)}`, () => assert.throws(() => canonical(value)));
  }
  test("external canonical envelope rejects duplicate keys and noncanonical encoding", () => {
    assert.deepEqual(decodeCanonical('{"a":1}'), { a: 1 });
    for (const text of ['{"a":1,"a":1}', '{ "a":1}', '{"a":1e0}', '{"a":-0}'])
      assert.throws(() => decodeCanonical(text));
  });
  for (const part of ["contract", "snapshot", "result"]) {
    const root = part === "snapshot" ? "before" : part;
    // Exhaustively exercise additionalProperties:false for every example object.
    const visit = (value, route = []) => {
      if (value && typeof value === "object") {
        if (!Array.isArray(value))
          negative(
            `${part} refuses unknown field at ${route.join(".") || "root"}`,
            (f) => {
              let target = f[root];
              for (const key of route) target = target[key];
              target.agentReady = true;
            },
            part === "contract" ? binding : part === "snapshot" ? snapshot : result,
          );
        for (const [key, child] of Object.entries(value)) visit(child, [...route, key]);
      }
    };
    visit(original[root]);
  }
  for (const [name, mutate] of [
    [
      "wrong run",
      (i) => {
        i.runId = "synthetic-other-run";
      },
    ],
    [
      "wrong root",
      (i) => {
        i.root.path = "/synthetic/other-root";
      },
    ],
    [
      "wrong branch",
      (i) => {
        i.branch = "synthetic/other-branch";
      },
    ],
    [
      "wrong base",
      (i) => {
        i.baseCommit = "3".repeat(40);
      },
    ],
    [
      "wrong common directory",
      (i) => {
        i.commonDir = "/synthetic/other-common";
      },
    ],
    [
      "wrong original ready marker",
      (i) => {
        i.ready.gitDir = "/synthetic/agent-ready";
      },
    ],
  ])
    negative(name, (f) => mutate(f.contract.inputs), binding, "BINDING_JOIN", pinContract);
  negative(
    "boolean receipt version",
    (f) => {
      f.contract.inputs.receipt.version = true;
    },
    binding,
    "SCHEMA",
  );
  negative(
    "unsupported version",
    (f) => {
      f.contract.version = 2;
    },
    binding,
    "SCHEMA",
  );
  negative(
    "missing field",
    (f) => {
      delete f.contract.inputs.lock;
    },
    binding,
    "SCHEMA",
  );
  negative(
    "overlapping roots",
    (f) => {
      f.contract.inputs.source.path = f.contract.inputs.root.path + "/source";
    },
    binding,
    "ROOT_OVERLAP",
    pinContract,
  );
  negative(
    "different root names cannot conceal identical directory inode",
    (f) => {
      f.contract.inputs.source.inode = f.contract.inputs.root.inode;
    },
    binding,
    "ROOT_OVERLAP",
    pinContract,
  );
  negative(
    "root inode drift",
    (f) => {
      f.before.inputs.root.inode++;
    },
    snapshot,
    "INPUT_DRIFT",
  );
  negative(
    "changed source after initial validation",
    (f) => {
      binding(f);
      f.before.inputs.baseCommit = "4".repeat(40);
    },
    snapshot,
    "INPUT_DRIFT",
  );
  for (const [name, change] of [
    [
      "manifest",
      (i) => {
        i.manifests[0].sha256 = "a".repeat(64);
      },
    ],
    [
      "lock",
      (i) => {
        i.lock.sha256 = "a".repeat(64);
      },
    ],
    [
      "lock Git blob",
      (i) => {
        i.lock.gitBlob = "a".repeat(40);
      },
    ],
    [
      "tool",
      (i) => {
        i.tools[0].sha256 = "a".repeat(64);
      },
    ],
    [
      "generation",
      (i) => {
        i.generation.sha256 = "a".repeat(64);
      },
    ],
    [
      "profile",
      (i) => {
        i.profile.sha256 = "a".repeat(64);
      },
    ],
    [
      "receipt pin",
      (i) => {
        i.receiptSha256 = "a".repeat(64);
      },
    ],
  ])
    negative(`changed ${name} refuses`, (f) => change(f.before.inputs), snapshot, "INPUT_DRIFT");
  negative(
    "agent recomputing incoming contract hash cannot approve drift",
    (f) => {
      f.contract.inputs.lock.sha256 = "a".repeat(64);
      f.result.contractDigest = digest(f.contract);
    },
    binding,
    "CONTRACT_PIN",
  );
  negative(
    "changed inventory",
    (f) => {
      f.before.entries[1].sha256 = "a".repeat(64);
    },
    snapshot,
    "INVENTORY_DRIFT",
  );
  negative(
    "changed shim inventory",
    (f) => {
      f.before.shims[0].prefixEdits++;
    },
    snapshot,
    "INVENTORY_DRIFT",
  );
  negative(
    "changed workspace inventory",
    (f) => {
      f.before.workspaceEntries[1].sha256 = "a".repeat(64);
    },
    snapshot,
    "INVENTORY_DRIFT",
  );

  for (const role of [0, 1]) {
    for (const key of [
      "filter.fixture.clean",
      "filter.fixture.process",
      "filter.fixture.smudge",
      "filter..clean",
      "filter..process",
    ]) {
      negative(
        `${role ? "root" : "source"} refuses ${key}`,
        (f) => {
          f.before.git[role].filterKeys.push(key);
        },
        snapshot,
        "GIT_FILTER",
      );
    }
    for (const tag of ["h", "S", "s", "M"])
      negative(
        `root role ${role} index tag ${tag}`,
        (f) => {
          f.before.git[role].indexTags = [tag];
        },
        snapshot,
        "GIT_INDEX_FLAGS",
      );
    for (const key of ["gitlinks", "gitmodules", "trackedClean", "registrationValid", "pathsNoSymlinks"])
      negative(
        `root role ${role} guard ${key}`,
        (f) => {
          f.before.git[role][key] = !f.before.git[role][key];
        },
        snapshot,
        "GIT_UNSUPPORTED",
      );
  }
  negative(
    "missing Git evidence",
    (f) => {
      f.before.git.pop();
    },
    snapshot,
    "GIT_EVIDENCE",
  );
  negative(
    "partial outputs are retained and refuse",
    (f) => {
      f.before.existingOutputs.push("node_modules");
    },
    snapshot,
    "PARTIAL_OUTPUT",
  );
  negative(
    "shared writable hardlink",
    (f) => {
      f.before.entries[1].nlink = 2;
    },
    snapshot,
    "SHARED_HARDLINK",
    pinInventories,
  );
  negative(
    "repeated source inode",
    (f) => {
      f.before.entries[2].inode = f.before.entries[1].inode;
    },
    snapshot,
    "SHARED_HARDLINK",
    pinInventories,
  );
  negative(
    "unknown shim template",
    (f) => {
      f.before.shims[0].template = "unknown";
    },
    snapshot,
    "UNKNOWN_SHIM",
    pinInventories,
  );
  negative(
    "missing shim mapping",
    (f) => {
      f.before.shims = [];
    },
    snapshot,
    "SHIM_SET",
    pinInventories,
  );
  negative(
    "relocation growth exceeds retained-shim budget",
    (f) => {
      f.contract.capacity.retainedShimBytes = 1;
    },
    snapshot,
    "SHIM_BUDGET",
    pinContract,
  );
  for (const [target, code] of [
    ["/synthetic/private", "ABSOLUTE_LINK"],
    ["../../private", "ESCAPING_LINK"],
    ["widget", "CYCLIC_LINK"],
    [".git/config", "PRIVATE_LINK"],
    ["missing", "UNKNOWN_LINK_TARGET"],
  ])
    negative(
      `link refuses ${target}`,
      (f) => {
        f.before.entries.at(-1).target = target;
      },
      snapshot,
      code,
      pinInventories,
    );
  negative(
    "special mode",
    (f) => {
      f.before.entries[1].mode = 0o4755;
    },
    snapshot,
    "SPECIAL_MODE",
    pinInventories,
  );
  negative(
    "unapproved output tree",
    (f) => {
      f.before.entries[1].path = "private/payload";
    },
    snapshot,
    "OUTPUT_SCOPE",
    pinInventories,
  );
  negative(
    "missing directory parent",
    (f) => {
      f.before.entries[1].path = "node_modules/missing/payload";
    },
    snapshot,
    "INVENTORY_PARENT",
    pinInventories,
  );
  for (const [target, code] of [
    ["/synthetic/private", "ABSOLUTE_LINK"],
    ["../../../private", "ESCAPING_LINK"],
    ["escape", "CYCLIC_LINK"],
    ["../../.git/config", "PRIVATE_LINK"],
    ["missing", "UNKNOWN_LINK_TARGET"],
  ])
    negative(
      `exposed workspace child refuses ${target}`,
      (f) => {
        f.before.workspaceEntries.push({
          ...f.before.entries.at(-1),
          path: "packages/widget/escape",
          inode: 90,
          target,
        });
      },
      snapshot,
      code,
      pinInventories,
    );
  negative(
    "workspace child sharing source writable inode",
    (f) => {
      f.before.workspaceEntries[1].inode = f.before.entries[1].inode;
    },
    snapshot,
    "SHARED_HARDLINK",
    pinInventories,
  );

  for (const [name, change, code] of [
    [
      "ambiguous mount",
      (c) => {
        c.cgroupMountCount = 2;
      },
      "CAPACITY_AMBIGUOUS",
    ],
    [
      "missing mount",
      (c) => {
        c.cgroupMountCount = 0;
      },
      "CAPACITY_AMBIGUOUS",
    ],
    [
      "ambiguous membership",
      (c) => {
        c.cgroupMembershipCount = 2;
      },
      "CAPACITY_AMBIGUOUS",
    ],
    [
      "missing ancestor",
      (c) => {
        c.ancestorsComplete = false;
      },
      "CAPACITY_AMBIGUOUS",
    ],
    [
      "missing nonroot measurements",
      (c) => {
        c.cgroups[0].currentBytes = null;
      },
      "CAPACITY_MISSING",
    ],
    [
      "host memory",
      (c) => {
        c.hostAvailableBytes = 1;
      },
      "CAPACITY_INSUFFICIENT",
    ],
    [
      "cgroup memory.high",
      (c) => {
        c.cgroups[0].highBytes = 1;
      },
      "CAPACITY_INSUFFICIENT",
    ],
    [
      "cgroup memory.max",
      (c) => {
        c.cgroups[0].maxBytes = 1;
      },
      "CAPACITY_INSUFFICIENT",
    ],
    [
      "RLIMIT_AS",
      (c) => {
        c.rlimitAsSoft = 1;
      },
      "CAPACITY_INSUFFICIENT",
    ],
    [
      "RLIMIT_DATA",
      (c) => {
        c.rlimitDataHard = 1;
      },
      "CAPACITY_INSUFFICIENT",
    ],
    [
      "disk",
      (c) => {
        c.diskFreeBytes = 1;
      },
      "DISK_INSUFFICIENT",
    ],
    [
      "wrong profile",
      (c) => {
        c.profileSha256 = "a".repeat(64);
      },
      "CAPACITY_PROFILE",
    ],
    [
      "stale measurement",
      (c) => {
        c.at = 0;
      },
      "CAPACITY_STALE",
    ],
  ])
    negative(`capacity refuses ${name}`, (f) => change(f.before.capacity), snapshot, code);
  negative(
    "overflowed memory budget",
    (f) => {
      f.contract.capacity.largestFileBytes = Number.MAX_SAFE_INTEGER;
    },
    snapshot,
    "CAPACITY_INSUFFICIENT",
    pinContract,
  );

  negative(
    "missing preparation evidence",
    (f) => {
      delete f.result.copy;
    },
    result,
    "SCHEMA",
  );
  negative(
    "altered result",
    (f) => {
      f.result.copy.journalSha256 = "a".repeat(64);
    },
    result,
    "RESULT_PIN",
  );
  negative(
    "recomputed result hash is not trusted",
    (f) => {
      f.result.expiresAt++;
      digest(f.result);
    },
    result,
    "RESULT_PIN",
  );
  negative(
    "agent-created dependency ready marker",
    (f) => {
      f.result = { ready: true, runId: f.contract.inputs.runId };
    },
    (f) => validateResult(f.contract, f.before, f.result, f.trust, f.now),
  );
  for (const field of ["runId", "branch", "baseCommit", "generationSha256", "profileSha256"])
    negative(
      `result inconsistent ${field}`,
      (f) => {
        f.result[field] = field.endsWith("Sha256")
          ? "a".repeat(64)
          : field === "baseCommit"
            ? "a".repeat(40)
            : "synthetic-other";
      },
      result,
      "RESULT_JOIN",
      pinResult,
    );
  negative(
    "another root cannot claim receipt",
    (f) => {
      f.result.root.inode++;
    },
    result,
    "RESULT_JOIN",
    pinResult,
  );
  negative(
    "stale result",
    (f) => {
      f.now = f.result.expiresAt;
    },
    result,
    "RESULT_STALE",
  );
  negative(
    "contract expired",
    (f) => {
      f.now = f.contract.validity.expiresAt;
    },
    binding,
    "CONTRACT_EXPIRED",
  );
  for (const key of ["attemptId", "fenceId", "nonce"])
    negative(
      `ownership mismatched ${key}`,
      (f) => {
        f.trust[key] = "synthetic-other";
      },
      result,
      "OWNERSHIP_UNAVAILABLE",
    );
  negative(
    "owner attestation is not acquired ownership",
    (f) => {
      f.trust.exclusive = false;
    },
    result,
    "OWNERSHIP_UNAVAILABLE",
  );
  negative(
    "expired lease",
    (f) => {
      f.trust.leaseExpiresAt = f.now;
    },
    result,
    "OWNERSHIP_UNAVAILABLE",
  );
  for (const name of ["beforeCheckpoint", "afterCheckpoint"]) {
    negative(
      `${name} nonce mismatch`,
      (f) => {
        f.result[name].nonce = "synthetic-other";
      },
      result,
      "CHECKPOINT_JOIN",
      pinResult,
    );
    negative(
      `${name} wrong gate step`,
      (f) => {
        f.result[name].stepRunId = "synthetic-other";
      },
      result,
      "CHECKPOINT_JOIN",
      pinResult,
    );
    negative(
      `${name} reused old checkpoint`,
      (f) => {
        f.result[name].at = 0;
      },
      result,
      "CHECKPOINT_STALE",
      pinResult,
    );
    for (const key of ["authenticated", "complete", "gateScheduled"])
      negative(
        `${name} requires ${key}`,
        (f) => {
          f.result[name][key] = false;
        },
        result,
        "SCHEMA",
        pinResult,
      );
  }
  negative(
    "copy can run only once",
    (f) => {
      f.result.copy.invocations = 2;
    },
    result,
    "SCHEMA",
    pinResult,
  );
  negative(
    "independent verification required",
    (f) => {
      f.result.verification.independent = false;
    },
    result,
    "SCHEMA",
    pinResult,
  );
  negative(
    "source drift during preparation",
    (f) => {
      f.result.verification.sourceAfterSha256 = "a".repeat(64);
    },
    result,
    "SOURCE_DRIFT",
    pinResult,
  );
  negative(
    "same-UID modes do not prove independence",
    (f) => {
      f.result.verification.entries[1].inode = f.before.entries[1].inode;
      f.result.copy.outputInventorySha256 = digest(f.result.verification.entries);
    },
    result,
    "SHARED_ROOT_FILE",
    pinResult,
  );
  negative(
    "two roots cannot share writable files",
    (f) => {
      f.trust.otherRootFiles = [f.result.verification.entries[1]];
    },
    result,
    "SHARED_ROOT_FILE",
  );
  negative(
    "metadata bytes cannot be relocated",
    (f) => {
      f.result.verification.entries[2].sha256 = "a".repeat(64);
      f.result.copy.outputInventorySha256 = digest(f.result.verification.entries);
    },
    result,
    "OUTPUT_CHANGED",
    pinResult,
  );
  for (const status of ["failed", "blocked", "skipped", "not-run"])
    negative(
      `check status ${status} is not ready`,
      (f) => {
        f.result.verification.checks[0].status = status;
      },
      result,
      "CHECK_NOT_PASSED",
      pinResult,
    );
  negative(
    "owner native-load cannot certify worker profile",
    (f) => {
      f.result.verification.checks[2].profileSha256 = digest("synthetic-worker-profile");
    },
    result,
    "CHECK_NOT_PASSED",
    pinResult,
  );
  negative(
    "missing required check",
    (f) => {
      f.result.verification.checks.pop();
    },
    result,
    "CHECK_SET",
    pinResult,
  );

  const fresh = () => ({ status: "fresh", attemptId: null, evidence: [], reason: "new" });
  const event = (kind) => ({ kind, evidenceDigest: digest(kind) });
  const context = (f, now = f.now) => ({ ...f, now });
  for (const [key, value] of [
    ["exclusive", "false"],
    ["exclusive", 1],
    ["leaseExpiresAt", undefined],
    ["leaseExpiresAt", NaN],
    ["leaseExpiresAt", 2000],
    ["attemptId", undefined],
    ["fenceId", undefined],
    ["nonce", undefined],
    ["attemptId", ""],
    ["nonce", "\0"],
  ])
    test(`begin blocks malformed ownership ${key}=${String(value)}`, () => {
      const f = fixture();
      f.trust[key] = value;
      const blocked = transition(fresh(), event("begin"), context(f, 2000));
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.attemptId, null);
      assert.deepEqual(blocked.evidence, [digest("begin")]);
    });
  test("fresh -> preparing -> prepared retains evidence and never starts an agent", () => {
    const f = fixture();
    const preparing = transition(fresh(), event("begin"), context(f, 2000));
    const prepared = transition(preparing, event("verified"), context(f));
    assert.equal(prepared.status, "prepared");
    assert.deepEqual(prepared.evidence, [digest("begin"), digest("verified")]);
    assert.throws(() => transition(prepared, event("begin"), context(f)), /SECOND_COPY/);
    assert.throws(() => transition(prepared, event("start-agent"), context(f)), /UNSUPPORTED_EVENT/);
  });
  for (const kind of ["crash", "lost-owner", "partial-output", "drift", "expired", "refusal"])
    test(`preparing ${kind} retains uncertain evidence; no automatic retry`, () => {
      const f = fixture();
      const preparing = transition(fresh(), event("begin"), context(f, 2000));
      const uncertain = transition(preparing, event(kind), context(f));
      assert.equal(uncertain.status, "uncertain");
      assert.equal(uncertain.evidence.length, 2);
      for (const recovery of ["begin", "cleanup", "rollback", "answer-gate", "start-agent"])
        assert.throws(() => transition(uncertain, event(recovery), context(f)), /INSPECTION_REQUIRED/);
    });
  test("concurrent contender stays blocked; incumbent can independently verify", () => {
    const f = fixture();
    const preparing = transition(fresh(), event("begin"), context(f, 2000));
    const losing = transition(fresh(), event("concurrent-owner"), context(f));
    assert.equal(losing.status, "blocked");
    assert.equal(losing.evidence.length, 1);
    assert.throws(() => transition(losing, event("begin"), context(f)), /INSPECTION_REQUIRED/);
    assert.equal(transition(preparing, event("verified"), context(f)).status, "prepared");
  });
  test("drift before copy blocks without creating an attempt", () => {
    const f = fixture();
    f.before.inputs.lock.sha256 = "a".repeat(64);
    const blocked = transition(fresh(), event("begin"), context(f, 2000));
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.attemptId, null);
  });
  test("failed verification retains attempt and marks uncertain", () => {
    const f = fixture();
    const preparing = transition(fresh(), event("begin"), context(f, 2000));
    f.result.verification.sourceAfterSha256 = "a".repeat(64);
    const uncertain = transition(preparing, event("verified"), context(f));
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.attemptId, f.trust.attemptId);
  });
  test("expiry or drift invalidates prepared evidence", () => {
    const f = fixture();
    const preparing = transition(fresh(), event("begin"), context(f, 2000));
    const prepared = transition(preparing, event("verified"), context(f));
    for (const kind of ["expired", "drift"])
      assert.equal(transition(prepared, event(kind), context(f)).status, "blocked");
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) defineContractTests(nodeTest);
