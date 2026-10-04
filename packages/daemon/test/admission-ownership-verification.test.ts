/** Admission inspection proves existing durable attribution without repairing it. */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OwnershipStore } from "../src/auth/ownership.js";
import { Authorizer } from "../src/auth/guard.js";
import { directAdmissionAuthority } from "../src/admission-retry.js";
import { submissionAuthority } from "../src/request-submission.js";
import type { Principal } from "../src/auth/principal.js";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-owner-"));
  directories.push(dir);
  const file = join(dir, "owners.json");
  return { dir, file, ownership: new OwnershipStore(file) };
}
it("refuses absent ownership without creating a file or attributing it", async () => {
  const f = await fixture();
  const record = vi.spyOn(f.ownership, "record");
  await expect(f.ownership.verify("run", "alice")).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(existsSync(f.file)).toBe(false);
  expect(record).not.toHaveBeenCalled();
});
it("ignores pending attribution instead of flushing it as verification", async () => {
  const f = await fixture();
  f.ownership.record("run", "alice");
  const verification = f.ownership.verify("run", "alice");
  expect(f.ownership.owner("run")).toBe("alice");
  await expect(verification).rejects.toMatchObject({ code: "RUN_STATE" });
  await f.ownership.flush("run");
  await f.ownership.verify("run", "alice");
});
it.each(["removed", "rewound", "changed", "corrupt"])(
  "refuses %s durable ownership without repairing it",
  async (change) => {
    const f = await fixture();
    f.ownership.record("run", "alice");
    await f.ownership.flush("run");
    if (change === "removed") unlinkSync(f.file);
    else
      writeFileSync(
        f.file,
        change === "corrupt"
          ? "broken"
          : JSON.stringify({ version: 1, runs: change === "changed" ? { run: "bob" } : {} }),
      );
    const before = existsSync(f.file) ? readFileSync(f.file) : undefined;
    await expect(f.ownership.verify("run", "alice")).rejects.toBeTruthy();
    expect(existsSync(f.file) ? readFileSync(f.file) : undefined).toEqual(before);
  },
);
it("synchronizes existing exact ownership without changing bytes, inode, mode or mtime", async () => {
  const f = await fixture();
  f.ownership.record("run", "alice");
  await f.ownership.flush("run");
  const snapshot = () => {
    const { dev, ino, mode, mtimeMs } = statSync(f.file);
    return { dev, ino, mode, mtimeMs, bytes: readFileSync(f.file) };
  };
  const before = snapshot();
  await f.ownership.verify("run", "alice");
  expect(snapshot()).toEqual(before);
});
it.each(["direct", "request"] as const)(
  "%s authority verification rechecks grants and durable owner without recording",
  async (kind) => {
    const f = await fixture();
    let principal: Principal = {
      id: "alice",
      kind: "credential",
      permissions: new Set(["runs.start", "plan.write"]),
      scope: { workflows: "*", runs: "all" },
    };
    const authorizer = new Authorizer({
      ownership: f.ownership,
      resolver: {
        run: async () => undefined,
        inputRun: async () => undefined,
        artifactRun: async () => undefined,
        claimRun: async () => undefined,
        workflowExists: () => true,
      },
    });
    const factory = kind === "direct" ? directAdmissionAuthority : submissionAuthority;
    const authority = factory({
      workspaceId: "workspace",
      actor: { principalId: "alice" },
      authorizer,
      principal: async () => principal,
    });
    await authority.onRunAdmitted("run");
    const record = vi.spyOn(f.ownership, "record");
    await authority.verifyRunAdmitted!("run");
    expect(record).not.toHaveBeenCalled();
    principal = { ...principal, permissions: new Set() };
    await expect(authority.verifyRunAdmitted!("run")).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  },
);
