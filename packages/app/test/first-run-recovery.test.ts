/** Real retained files; boot transitions are synthetic authority seams, never physical reboot acceptance. */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, rename, writeFile, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BundledDaemon } from "../src/main/daemon-process.js";
import { FirstRunRecovery } from "../src/main/first-run/recovery.js";
import { hash, OWNERSHIP_DIRECTORY, reserveFirstRunOwnership } from "../src/main/first-run/ownership.js";
import {
  assertNoPendingFirstRunRecovery,
  firstRunRequiresExplicitContinuationRecovery,
} from "../../cli/src/first-run-recovery-fence.js";
import { bootstrap } from "../../cli/src/bootstrap.js";
import { parseOrcaConfig } from "@orca/core";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(attached = true) {
  const path = await mkdtemp(join(tmpdir(), "orca-reboot-recovery-"));
  roots.push(path);
  await writeFile(join(path, "orca.config.yaml"), '{"version":1,"storeDir":".orca"}\n');
  const owner = reserveFirstRunOwnership(path);
  await mkdir(join(path, ".orca"));
  await writeFile(join(path, ".orca", "retained.json"), "synthetic retained work\n");
  const stop = vi.fn();
  const child: BundledDaemon = { url: "http://127.0.0.1:12345", pid: 987654, exited: false, stop };
  if (attached) owner.attach(child);
  let boot = randomUUID();
  let hostHash = hash("synthetic host");
  const local = vi.fn();
  const authority = { host: () => ({ platform: "linux" as const, hostHash, bootId: boot }), assertLocalVolume: local };
  return {
    path,
    owner,
    stop,
    child,
    authority,
    local,
    attempt: join(path, OWNERSHIP_DIRECTORY, "000001"),
    reboot: () => {
      boot = randomUUID();
    },
    otherHost: () => {
      hostHash = hash("different host");
    },
    service: () => new FirstRunRecovery(path, authority),
  };
}
async function evidence(path: string) {
  const attempt = join(path, OWNERSHIP_DIRECTORY, "000001");
  const names = await readdir(attempt);
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readFile(join(attempt, name), "utf8")])),
  );
}
it.each([true, false])(
  "recovers an %s attached interrupted reservation only after a synthetic same-host reboot, preserving work",
  async (attached) => {
    const f = await fixture(attached);
    const original = await evidence(f.path);
    expect(firstRunRequiresExplicitContinuationRecovery(f.path)).toBe(false);
    const prepared = f.service().prepare(() => {});
    expect(f.service().prepare(() => {})).toEqual(prepared);
    expect(() => f.owner.check()).toThrow("reconciliation");
    expect(() => reserveFirstRunOwnership(f.path)).toThrow("reconciliation");
    expect(() => assertNoPendingFirstRunRecovery(f.path, join(f.path, ".orca"))).toThrow("pending");
    const pending = await evidence(f.path);
    expect(() => f.service().reconcile(prepared.requestId, () => {})).toThrow("reconciliation");
    expect(await evidence(f.path)).toEqual(pending);
    f.reboot();
    // Process recreation alone has no authority: only this explicit boot observation seam changes.
    expect(new FirstRunRecovery(f.path, f.authority).reconcile(prepared.requestId, () => {})).toEqual({
      state: "reconciled",
      requestId: prepared.requestId,
    });
    expect(f.service().reconcile(prepared.requestId, () => {})).toEqual({
      state: "reconciled",
      requestId: prepared.requestId,
    });
    expect(() => assertNoPendingFirstRunRecovery(f.path)).toThrow("pending");
    reserveFirstRunOwnership(f.path);
    expect(() => assertNoPendingFirstRunRecovery(f.path)).not.toThrow();
    const after = await evidence(f.path);
    for (const [name, text] of Object.entries(original)) expect(after[name]).toEqual(text);
    expect(after["terminal.json"]).toBeUndefined();
    expect(after["recovery.json"]).toContain("same-host-new-boot-fenced");
    expect(await readFile(join(f.path, ".orca", "retained.json"), "utf8")).toBe("synthetic retained work\n");
    expect(f.stop).not.toHaveBeenCalled();
  },
);
it.each([
  "same-boot",
  "other-host",
  "stale-id",
  "changed-config",
  "changed-claim",
  "wrong-child",
  "extra-file",
  "missing-claim",
  "missing-anchor",
  "store-replaced",
  "journal-replaced",
  "request-altered",
  "request-missing",
  "symlink",
  "hardlink",
  "unknown-volume",
  "unknown-boot",
  "stale-epoch",
])("refuses exact recovery failure %s without resolution, deletion, signal or startup", async (failure) => {
  const f = await fixture();
  const request = f.service().prepare(() => {});
  if (failure !== "same-boot") f.reboot();
  if (failure === "other-host") f.otherHost();
  if (failure === "changed-config") await writeFile(join(f.path, "orca.config.yaml"), "changed\n");
  if (failure === "changed-claim") await writeFile(join(f.attempt, "claim.json"), "{}\n");
  if (failure === "wrong-child")
    await writeFile(join(f.attempt, "child.json"), JSON.stringify({ reservationId: randomUUID(), processId: 987654 }));
  if (failure === "extra-file") await writeFile(join(f.attempt, "foreign"), "preserve\n");
  if (failure === "missing-claim") await rm(join(f.attempt, "claim.json"));
  if (failure === "missing-anchor") await rm(join(f.path, ".orca-first-run-ownership.json"));
  if (failure === "store-replaced") {
    await rename(join(f.path, ".orca"), join(f.path, "retained-store"));
    await mkdir(join(f.path, ".orca"));
  }
  if (failure === "journal-replaced") {
    await rename(join(f.path, OWNERSHIP_DIRECTORY), join(f.path, "retained-journal"));
    await mkdir(join(f.path, OWNERSHIP_DIRECTORY));
  }
  if (failure === "request-altered") await writeFile(join(f.attempt, "recovery-request.json"), "{}\n");
  if (failure === "request-missing") await rm(join(f.attempt, "recovery-request.json"));
  if (failure === "symlink" || failure === "hardlink") {
    await rename(join(f.attempt, "child.json"), join(f.path, "retained-child.json"));
    if (failure === "symlink") await symlink(join(f.path, "retained-child.json"), join(f.attempt, "child.json"));
    else await link(join(f.path, "retained-child.json"), join(f.attempt, "child.json"));
  }
  if (failure === "unknown-volume")
    f.local.mockImplementation(() => {
      throw new Error("unknown volume");
    });
  if (failure === "unknown-boot")
    f.authority.host = () => {
      throw new Error("unknown boot");
    };
  const before = failure === "journal-replaced" ? undefined : await evidence(f.path);
  expect(() =>
    f.service().reconcile(failure === "stale-id" ? randomUUID() : request.requestId, () => {
      if (failure === "stale-epoch") throw new Error("stale epoch");
    }),
  ).toThrow();
  if (before) expect(await evidence(f.path)).toEqual(before);
  expect(f.stop).not.toHaveBeenCalled();
  expect(() => reserveFirstRunOwnership(f.path)).toThrow("reconciliation");
});
it("a missing store created after preparation cannot be accepted as the fenced store", async () => {
  const f = await fixture(false);
  await rm(join(f.path, ".orca"), { recursive: true });
  const request = f.service().prepare(() => {});
  await mkdir(join(f.path, ".orca"));
  f.reboot();
  expect(() => f.service().reconcile(request.requestId, () => {})).toThrow("reconciliation");
});
it("pending requests fence real CLI bootstrap before store/auth/plugin writes, including aliases and nested cwd", async () => {
  const f = await fixture();
  f.service().prepare(() => {});
  const alias = join(f.path, "store-alias");
  await symlink(join(f.path, ".orca"), alias);
  await mkdir(join(f.path, "nested"));
  for (const cwd of [f.path, join(f.path, "nested"), alias]) {
    await expect(bootstrap({ cwd, configDir: f.path, config: parseOrcaConfig({}) })).rejects.toThrow("pending");
  }
  expect(await readdir(f.path)).not.toContain("auth");
  expect(await readdir(join(f.path, OWNERSHIP_DIRECTORY))).toEqual(["000001"]);
});
it("a stale recovered record cannot resolve a later generation with the same PID", async () => {
  const f = await fixture();
  const request = f.service().prepare(() => {});
  f.reboot();
  f.service().reconcile(request.requestId, () => {});
  const stale = await readFile(join(f.attempt, "recovery.json"), "utf8");
  const owner = reserveFirstRunOwnership(f.path);
  owner.attach(f.child);
  await writeFile(join(f.path, OWNERSHIP_DIRECTORY, "000002", "recovery.json"), stale);
  expect(() => reserveFirstRunOwnership(f.path)).toThrow("reconciliation");
});
