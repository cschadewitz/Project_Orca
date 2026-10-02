import { expect, it } from "vitest";
import { directAdmissionAuthority, neverAttached } from "../src/admission-retry.js";
import { Authorizer } from "../src/auth/guard.js";
import { OwnershipStore } from "../src/auth/ownership.js";
import type { Principal } from "../src/auth/principal.js";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
it("direct grants check current workflow and associations and persist exact ownership", async () => {
  let principal: Principal = {
    id: "alice",
    kind: "credential",
    permissions: new Set(["runs.start"]),
    scope: { workflows: ["program"], runs: "owned" },
  };
  const ownership = new OwnershipStore();
  const authorizer = new Authorizer({
    ownership,
    resolver: {
      run: async () => undefined,
      inputRun: async () => undefined,
      artifactRun: async () => undefined,
      claimRun: async () => undefined,
      workflowExists: () => true,
    },
  });
  const authority = directAdmissionAuthority({
    workspaceId: "w",
    actor: { principalId: "alice", credentialId: "first" },
    principal: async () => principal,
    authorizer,
  });
  await authority.authorize({ workflowId: "program" });
  await expect(authority.authorize({ workflowId: "hidden" })).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
  await expect(authority.authorize({ workflowId: "program", requestId: "req" })).rejects.toMatchObject({
    code: "AUTH_FORBIDDEN",
  });
  await expect(authority.authorize({ workflowId: "program", workItemId: "wi" })).rejects.toMatchObject({
    code: "AUTH_FORBIDDEN",
  });
  await authority.onRunAdmitted("run-one");
  expect(ownership.owner("run-one")).toBe("alice");
  principal = { ...principal, credentialId: "rotated" };
  await authority.authorize({ workflowId: "program" });
  principal = { ...principal, permissions: new Set() };
  await expect(authority.authorize({ workflowId: "program" })).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  principal = { ...principal, id: "bob", permissions: new Set(["runs.start"]) };
  await expect(authority.onRunAdmitted("run-one")).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
});
it("automatic admission dispatch only attaches a never-started, unleased run", async () => {
  const f = submissionFixture();
  const admitted = await f.service.submit({ title: "a", body: "b" }, f.authority);
  if (admitted.state !== "accepted") throw new Error("not accepted");
  expect(await neverAttached(f.orc, admitted.runId)).toBe(true);
  await f.orc.run(admitted.runId);
  expect(await neverAttached(f.orc, admitted.runId)).toBe(false);
});
