/** Bounded read-only roots refuse unsafe topology, incomplete ownership and observed hash races. */
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inventoryRecoveryRoots } from "../src/recovery-inventory.js";
import { validateRecoveryManifest } from "../src/recovery-validation.js";
import { CANDIDATE, observe, recoveryFixture, sourceDigest, type RecoveryFixture } from "./recovery-fixture.js";

const hashMutation = vi.hoisted(() => ({ target: "", fired: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === hashMutation.target) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          if (!hashMutation.fired) {
            hashMutation.fired = true;
            await actual.writeFile(hashMutation.target, "mutation-during-hash");
          }
          return result;
        });
      }
      return handle;
    },
  };
});
const fixtures: RecoveryFixture[] = [];
afterEach(async () => {
  hashMutation.target = "";
  hashMutation.fired = false;
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
async function fixture() {
  const value = await recoveryFixture();
  fixtures.push(value);
  return value;
}
const reasons = (result: Awaited<ReturnType<typeof inventoryRecoveryRoots>>) =>
  result.ok ? result.manifest.reasons : result.reasons;

it("observes every supplied root with hidden keys, identity, digests and access evidence, without changing sources", async () => {
  const f = await fixture(),
    before = await sourceDigest(f),
    manifest = await observe(f.plan);
  expect(manifest.roots.length).toBe(4);
  for (const root of manifest.roots.filter((item) => item.role === "store")) {
    expect(root.observedIdentity === root.expectedIdentity).toBe(true);
    for (const path of [
      "private-execution/.execution-key",
      "private-workflows/.execution-key",
      "private-execution/generation.generation.json",
    ])
      expect(
        root.entries.some((entry) => entry.path === path && entry.sha256?.length === 64 && entry.access.mode === 0o600),
      ).toBe(true);
  }
  expect((await sourceDigest(f)) === before).toBe(true);
  expect(JSON.stringify(manifest).includes(f.base)).toBe(false);
  expect(resolve(f.roots[3]!, "../store-cli-acp") === f.roots[1]).toBe(true);
});

it("never initializes damaged coupled identity metadata and refuses identity mismatch", async () => {
  const f = await fixture();
  await rm(join(f.roots[0]!, ".workspace-identified"));
  expect((await observe(f.plan)).reasons).toContain("IDENTITY_MISSING");
  f.plan.roots[1]!.expectedIdentity = f.plan.roots[0]!.expectedIdentity;
  expect((await observe(f.plan)).reasons).toContain("IDENTITY_MISMATCH");
  await expect(
    import("node:fs/promises").then((fs) => fs.stat(join(f.roots[0]!, ".workspace-identified"))),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("records external/unverified dependencies without opening credential paths", async () => {
  const f = await fixture(),
    config = f.plan.roots[3]!;
  config.components.find((item) => item.id === "credentials")!.state = "external-unverified";
  await mkdir(join(config.path, "auth"), { mode: 0o700 });
  await writeFile(join(config.path, "auth/credentials.json"), "must-never-read", { mode: 0o000 });
  f.plan.external[0]!.state = "external-unverified";
  f.plan.external[1]!.state = "external-unverified";
  const manifest = await observe(f.plan);
  expect(manifest.roots[3]!.entries.some((entry) => entry.path.startsWith("auth"))).toBe(false);
  expect(manifest.reasons).toEqual([]);
  expect(validateRecoveryManifest(JSON.stringify(manifest), { expectedCandidateRef: CANDIDATE }).coverage.status).toBe(
    "unknown",
  );
});

it("fails completeness for newly discovered unclassified durable files", async () => {
  const f = await fixture();
  await writeFile(join(f.roots[1]!, "future-journal"), "opaque", { mode: 0o600 });
  const manifest = await observe(f.plan);
  expect(
    validateRecoveryManifest(JSON.stringify(manifest), { expectedCandidateRef: CANDIDATE }).coverage.reasons,
  ).toContain("ENTRY_UNCLASSIFIED");
});

it.each(["nested", "duplicate", "relative", "escape", "case-root"])(
  "refuses unsafe %s roots before inspection",
  async (fault) => {
    const f = await fixture();
    if (fault === "nested") f.plan.roots[1]!.path = join(f.roots[0]!, "nested");
    if (fault === "duplicate") f.plan.roots[1]!.path = f.roots[0]!;
    if (fault === "relative") f.plan.roots[1]!.path = "relative-root";
    if (fault === "escape") f.plan.roots[1]!.components[0]!.paths = ["../escape"];
    if (fault === "case-root") f.plan.roots[1]!.path = f.roots[0]!.toUpperCase();
    expect((await inventoryRecoveryRoots(f.plan)).ok).toBe(false);
  },
);

it.each([
  "file-symlink",
  "root-symlink",
  "ancestor-symlink",
  "special-file",
  "case-collision",
  "unsafe-name",
  "unsafe-access",
])("refuses %s without private path diagnostics or permission repair", async (fault) => {
  if (process.platform === "win32") return;
  const f = await fixture(),
    root = f.roots[0]!;
  const target = join(root, "private-execution/run.inputs.json");
  if (fault === "file-symlink") {
    await rm(target);
    await symlink(join(f.roots[1]!, "private-execution/run.inputs.json"), target);
  }
  if (fault === "root-symlink") {
    const alias = join(f.base, "alias");
    await symlink(root, alias);
    f.plan.roots[0]!.path = alias;
  }
  if (fault === "ancestor-symlink") {
    const alias = join(f.base, "alias");
    await symlink(f.base, alias);
    f.plan.roots[0]!.path = join(alias, "store-app");
  }
  if (fault === "special-file") execFileSync("mkfifo", [join(root, "fifo")]);
  if (fault === "case-collision") {
    await writeFile(join(root, "collision"), "a", { mode: 0o600 });
    await writeFile(join(root, "COLLISION"), "b", { mode: 0o600 });
  }
  if (fault === "unsafe-name") await writeFile(join(root, "NUL"), "a", { mode: 0o600 });
  if (fault === "unsafe-access") await chmod(target, 0o644);
  const result = await inventoryRecoveryRoots(f.plan);
  expect(reasons(result).length > 0).toBe(true);
  expect(JSON.stringify(reasons(result)).includes(f.base)).toBe(false);
  if (fault === "unsafe-access") {
    expect(reasons(result)).toContain("ACCESS_UNSAFE");
    expect((await import("node:fs/promises").then((fs) => fs.stat(target))).mode & 0o777).toBe(0o644);
  }
});

it.each(["maxEntries", "maxDepth", "maxFileBytes", "maxTotalBytes", "maxRoots", "maxManifestBytes"] as const)(
  "bounds %s",
  async (budget) => {
    const f = await fixture();
    expect(reasons(await inventoryRecoveryRoots(f.plan, { [budget]: 0 }))).toContain("RESOURCE_LIMIT");
  },
);

it("rejects raised budgets and duplicate components before they can claim completeness", async () => {
  const f = await fixture();
  expect(reasons(await inventoryRecoveryRoots(f.plan, { maxRoots: 33 }))).toContain("RESOURCE_LIMIT");
  f.plan.roots[0]!.components.push(f.plan.roots[0]!.components[0]!);
  const manifest = await observe(f.plan);
  expect(
    validateRecoveryManifest(JSON.stringify(manifest), { expectedCandidateRef: CANDIDATE }).structuralValidity.reasons,
  ).toContain("PATH_COLLISION");
});

it("detects mutation during hashing and never offers writer consistency", async () => {
  const f = await fixture();
  hashMutation.target = join(f.roots[0]!, "private-execution/run.inputs.json");
  const result = await inventoryRecoveryRoots(f.plan);
  expect(hashMutation.fired).toBe(true);
  expect(reasons(result)).toContain("OBSERVATION_CHANGED");
  if (result.ok)
    expect(
      validateRecoveryManifest(JSON.stringify(result.manifest), { expectedCandidateRef: CANDIDATE }).writerConsistency
        .status,
    ).toBe("unknown");
});

it("detects an identity-preserving root move as a changed observed filesystem", async () => {
  const f = await fixture();
  const before = await observe(f.plan),
    moved = join(f.base, "moved");
  await rename(f.roots[0]!, moved);
  f.plan.roots[0]!.path = moved;
  const after = await observe(f.plan);
  expect(after.roots[0]!.observedIdentity === before.roots[0]!.observedIdentity).toBe(true);
  expect(
    validateRecoveryManifest(JSON.stringify(after), { expectedCandidateRef: CANDIDATE }).writerConsistency.status,
  ).toBe("unknown");
});

it("refuses a false credential absence declaration before opening its subtree", async () => {
  const f = await fixture(),
    config = f.plan.roots[3]!;
  await mkdir(join(config.path, "auth"), { mode: 0o700 });
  await writeFile(join(config.path, "auth/credentials.json"), "unread-credential-placeholder", { mode: 0o000 });
  const result = await inventoryRecoveryRoots(f.plan);
  expect(reasons(result)).toContain("COMPONENT_MISSING");
  if (result.ok) expect(result.manifest.roots[3]!.entries.some((entry) => entry.path.startsWith("auth"))).toBe(false);
});

it.each(["maxFileBytes", "maxEntries"] as const)(
  "withholds coverage when %s aborts before an unclassified durable entry is recorded",
  async (budget) => {
    const f = await fixture(),
      app = f.plan.roots[2]!;
    await rm(join(app.path, "preferences.json"));
    await rm(join(app.path, "admission-intents.enc"));
    for (const component of app.components) component.state = "absent";
    await writeFile(join(app.path, "future-journal"), "synthetic-unclassified-durable-data", { mode: 0o600 });
    const plan = { ...f.plan, roots: [app], references: [] },
      before = await observe(plan);
    const inventory = await inventoryRecoveryRoots(plan, { [budget]: 0 });
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) throw new Error("EXPECTED_MANIFEST");
    expect(inventory.manifest.roots[0]!.entries).toEqual([]);
    expect(inventory.manifest.enumeration).toBe("incomplete");
    expect(inventory.manifest.reasons).toContain("RESOURCE_LIMIT");
    const json = JSON.stringify(inventory.manifest);
    const result = validateRecoveryManifest(json, { expectedCandidateRef: CANDIDATE, observedJson: json });
    expect(result.structuralValidity.status).toBe("passed");
    expect(result.coverage).toEqual({ status: "unknown", reasons: ["COMPONENT_UNKNOWN"] });
    expect(result.integrity.status).toBe("failed");
    expect(result.writerConsistency.status).toBe("unknown");
    expect(result.recoveryEligibility.status).toBe("unavailable");
    expect(JSON.stringify(result).includes(f.base)).toBe(false);
    expect(JSON.stringify(await observe(plan)) === JSON.stringify(before)).toBe(true);
  },
);

it("compares genuine root access evidence even when both modes satisfy owner-only checks", async () => {
  if (process.platform === "win32") return;
  const f = await fixture(),
    before = await observe(f.plan),
    root = f.plan.roots[0]!.path;
  await chmod(root, 0o500);
  try {
    const after = await observe(f.plan);
    expect(before.roots[0]!.access.mode).toBe(0o700);
    expect(after.roots[0]!.access.mode).toBe(0o500);
    expect(after.enumeration).toBe("complete");
    expect(after.reasons).toEqual([]);
    expect(JSON.stringify(after.roots[0]!.entries) === JSON.stringify(before.roots[0]!.entries)).toBe(true);
    const result = validateRecoveryManifest(JSON.stringify(before), {
      expectedCandidateRef: CANDIDATE,
      observedJson: JSON.stringify(after),
    });
    expect(result.structuralValidity.status).toBe("passed");
    expect(result.coverage.status).toBe("passed");
    expect(result.integrity.reasons).toContain("DIGEST_MISMATCH");
    expect(result.integrity.status).toBe("failed");
    expect(result.writerConsistency.status).toBe("unknown");
    expect(result.recoveryEligibility.status).toBe("unavailable");
    expect(JSON.stringify(result).includes(f.base)).toBe(false);
  } finally {
    // Only this test's fresh synthetic root is changed; restore its mode for test cleanup.
    await chmod(root, 0o700);
  }
});
