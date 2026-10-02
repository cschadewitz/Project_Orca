/** Revision reads and edits recheck current grants and exact run ownership after the originating gate closes. */
import { expect, it } from "vitest";
import { revisionAccess, revisionAuthority } from "../src/revision-input.js";
import { Authorizer } from "../src/auth/guard.js";
import { OwnershipStore } from "../src/auth/ownership.js";
import type { Principal, Permission } from "../src/auth/principal.js";
function setup() {
  let id = "human";
  let permissions: Permission[] = ["runs.read", "inputs.answer", "runs.control"];
  const ownership = new OwnershipStore();
  ownership.record("run", "human");
  const authorizer = new Authorizer({
    ownership,
    resolver: {
      run: async (run) => (run === "run" ? { workflowId: "flow" } : undefined),
      inputRun: async () => undefined,
      artifactRun: async () => undefined,
      claimRun: async () => undefined,
      workflowExists: () => true,
    },
  });
  const currentPrincipal = async (): Promise<Principal> => ({
    id,
    kind: "credential",
    credentialId: "rotated",
    permissions: new Set(permissions),
    scope: { workflows: ["flow"], runs: "owned" },
  });
  const access = revisionAccess({ workspaceId: "workspace", principalId: "human", currentPrincipal, authorizer });
  return {
    access,
    change: (next: Permission[]) => {
      permissions = next;
    },
    wrong: () => {
      id = "other";
    },
  };
}
it("allows owned pending revisions without consulting the closed-input lookup", async () => {
  const f = setup();
  await expect(f.access.mutate("run")).resolves.toBeUndefined();
  expect(await f.access.actor()).toEqual({ principalId: "human", credentialId: "rotated" });
  expect(await f.access.read("run")).toEqual({ content: true, mutate: true });
  await expect(f.access.read("other")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
});
it("omits payload for readers and rejects edits without both mutation grants", async () => {
  const f = setup();
  f.change(["runs.read"]);
  expect(await f.access.read("run")).toEqual({ content: false, mutate: false });
  await expect(f.access.mutate("run")).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  f.change(["inputs.answer"]);
  await expect(f.access.mutate("run")).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  f.change(["runs.control"]);
  await expect(f.access.mutate("run")).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
});
it("rechecks principal and revocation on reads and retries", async () => {
  const f = setup();
  const authority = revisionAuthority(f.access);
  await authority.authorize({ target: { runId: "run" } });
  f.wrong();
  await expect(authority.authorize({ target: { runId: "run" } })).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  await expect(f.access.read("run")).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
});
