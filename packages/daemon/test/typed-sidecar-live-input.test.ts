/** Actual sidecar + file-backed answer log in disposable stores. All approval/compatibility owners are synthetic. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock, type OrcaEventInput } from "@orca/core";
import { fileStores } from "@orca/store";
import {
  askHumanInput,
  HumanInputPending,
  LiveHumanInput,
  type HumanInputQuery,
  type LiveInputBinding,
} from "@orca/engine";
import {
  bindInactiveTypedSidecarOwner,
  createInactiveTypedSidecarStore,
  strictPermissionRuleRevision,
  type CreateScopedRule,
} from "@orca/agents";
import {
  Authorizer,
  CredentialStore,
  authInvalid,
  OwnershipStore,
  type Principal,
  type ResourceResolver,
} from "../src/auth/index.js";
import { ruleFixture } from "../../agents/test/strict-permission-fixtures.js";
const faults = vi.hoisted(() => ({
  publication: false,
  readTarget: "",
  afterRead: undefined as (() => Promise<void>) | undefined,
  afterDispatch: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const result = await fs.readFile(...args);
      if (args[0] === faults.readTarget && faults.afterRead) {
        const hook = faults.afterRead;
        faults.afterRead = undefined;
        await hook();
      }
      return result;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (String(args[1]).endsWith("orca.permissions.json") && faults.afterDispatch) {
        const hook = faults.afterDispatch;
        faults.afterDispatch = undefined;
        await hook();
      }
      if (faults.publication && String(args[1]).endsWith("orca.permissions.json"))
        throw new Error("lost policy acknowledgement");
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  faults.publication = false;
  faults.readTarget = "";
  faults.afterRead = undefined;
  faults.afterDispatch = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-typed-live-"));
  roots.push(root);
  const file = join(root, "orca.permissions.json");
  const stores = fileStores(join(root, "store"));
  const lease = await stores.leases.acquire({ resource: "run:run", holder: "owner" });
  const marker = {
    version: 1,
    workspaceRef: "synthetic:workspace",
    sidecarRef: "synthetic:sidecar",
    format: "orca-permissions-v2",
    minimumWriterContract: "orca-typed-sidecar-v1",
    rootBindingRef: "synthetic:original-root-binding",
    enrollmentRef: "synthetic:enrollment",
    state: "enrolled",
  } as const;
  const owner = bindInactiveTypedSidecarOwner({
    file,
    marker,
    checkCompatibility: async () => marker,
    assertCompatibilityCurrent: () => undefined,
    qualify: async () => {
      throw new Error("fixture never evaluates actions");
    },
  });
  const policy = createInactiveTypedSidecarStore(owner);
  const pendingMarker = { ...marker, state: "enrollment-pending" as const };
  const initializer = createInactiveTypedSidecarStore(
    bindInactiveTypedSidecarOwner({
      file,
      marker: pendingMarker,
      checkCompatibility: async () => pendingMarker,
      assertCompatibilityCurrent: () => undefined,
      qualify: async () => {
        throw new Error("not evaluated");
      },
    }),
  );
  const snapshot = await initializer.initializeFresh();
  const credentialFile = join(root, "credentials.json");
  const credentialOwner = new CredentialStore({ file: credentialFile });
  const issued = await credentialOwner.issue({
    principal: "synthetic-alice",
    permissions: ["permissions.grant", "inputs.answer"],
    scope: { workflows: "*", runs: "all" },
  });
  const checked = credentialOwner.current(issued.credential.id);
  if (!checked.ok) throw new Error("synthetic credential unavailable");
  const principal = checked.principal;
  let currentOverride: Principal | undefined;
  const resolver: ResourceResolver = {
    run: async () => ({ workflowId: "synthetic" }),
    inputRun: async () => "run",
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: () => true,
  };
  const authorizer = new Authorizer({
    ownership: new OwnershipStore(),
    resolver,
    currentPrincipal: () => {
      if (currentOverride) return currentOverride;
      const latest = credentialOwner.current(issued.credential.id);
      if (!latest.ok) throw authInvalid();
      return latest.principal;
    },
  });
  const command: CreateScopedRule = {
    rule: { ...ruleFixture(), ruleRevision: strictPermissionRuleRevision(ruleFixture()) },
    expectedRevision: snapshot.revision,
    approvalRecordRef: "synthetic:explicit-reviewed-scope",
  };
  // Protected synthetic review is captured independently, before any client command. It is not derived from an answer.
  const approved = structuredClone(command);
  const verifyApproval = vi.fn(
    async (candidate: CreateScopedRule, actor: { principalId: string; credentialId?: string }) => {
      expect(candidate).toEqual(approved);
      expect(actor).toEqual({ principalId: principal.id, credentialId: principal.credentialId });
      expect(await stores.events.readTypes("run", ["human.answered"])).toHaveLength(1);
      return { scopeEvidenceRef: "synthetic:explicit-scope-evidence" };
    },
  );
  const grant = authorizer.scopedRuleGrantAuthority(principal, {
    readAuthorityRevision: async () => "synthetic:current-authority",
    assertCommitCurrent: (candidate, actor, proof) => {
      expect(candidate).toEqual(approved);
      expect(actor).toEqual({ principalId: principal.id, credentialId: principal.credentialId });
      expect(proof).toEqual({
        authorityRevision: "synthetic:current-authority",
        scopeEvidenceRef: "synthetic:explicit-scope-evidence",
      });
      return undefined;
    },
    verifyApproval,
  });
  const port = new LiveHumanInput("boot");
  const abort = new AbortController();
  const order: string[] = [];
  let uncertainAppend = false;
  const emit = async (event: Omit<OrcaEventInput, "runId">) => {
    await stores.events.append({ ...event, runId: "run" } as OrcaEventInput);
    if (event.type === "human.answered") {
      order.push("record");
      if (uncertainAppend) throw new Error("lost answer acknowledgement");
    }
  };
  const live: LiveInputBinding = {
    identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
    signal: abort.signal,
    withOwnership: (write) => stores.leases.withOwnership(lease, write),
    emitOwned: emit,
  };
  let query!: HumanInputQuery;
  const delivered = askHumanInput({
    port,
    emit,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Synthetic read?",
    options: ["once", "deny"],
    live,
    onRequested: (q) => {
      query = q;
    },
  });
  void delivered.then(
    () => order.push("delivery"),
    () => undefined,
  );
  await vi.waitFor(() => expect(query).toBeDefined());
  const target = { ...live.identity, runId: "run", stepRunId: "step", requestId: query.requestId };
  await vi.waitFor(() => expect(port.inspect(target)).toBe("pending"));
  const writer = vi.fn(async () => {
    await policy.createScopedRule(command, grant);
    order.push("policy");
  });
  const liveAuthority = {
    actor: grant.actor,
    authorize: async () => {
      await grant.authorizeGrant();
    },
  };
  const answer = () => port.answer({ target, optionId: "once", standing: true }, liveAuthority, writer);
  return {
    root,
    file,
    stores,
    policy,
    owner,
    command,
    grant,
    principal,
    writer,
    port,
    target,
    delivered,
    order,
    answer,
    liveAuthority,
    loseGrant: () => {
      currentOverride = { ...principal, permissions: new Set(["inputs.answer"]) };
    },
    verifyApproval,
    revokeOriginal: () => new CredentialStore({ file: credentialFile }).revoke(issued.credential.id),
    uncertainAppend: () => {
      uncertainAppend = true;
    },
  };
}
describe("typed standing writes at the existing live-input boundary", () => {
  it("records the attributed answer, writes exact reviewed rule, then delivers once", async () => {
    const f = await fixture();
    await f.answer();
    expect(await f.delivered).toBe("once");
    expect(f.order).toEqual(["record", "policy", "delivery"]);
    const saved = (await f.policy.read()).document.scopedRules.records[0]!;
    expect(saved.rule).toEqual(f.command.rule);
    expect(saved.actor).toEqual(f.grant.actor);
    const restarted = fileStores(join(f.root, "store"));
    expect(await restarted.events.readTypes("run", ["human.answered"])).toMatchObject([
      { payload: { actor: f.grant.actor } },
    ]);
    await expect(f.answer()).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.writer).toHaveBeenCalledTimes(1);
  });
  it.each(["once", "deny"])("does not persist standing authority for %s", async (optionId) => {
    const f = await fixture();
    await f.port.answer({ target: f.target, optionId }, f.liveAuthority);
    expect(await f.delivered).toBe(optionId);
    expect(f.writer).not.toHaveBeenCalled();
    expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
  });
  it("lost original grant refuses before recording, without consuming an otherwise live callback", async () => {
    const f = await fixture();
    f.loseGrant();
    await expect(f.answer()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(await f.stores.events.readTypes("run", ["human.answered"])).toEqual([]);
    expect(f.writer).not.toHaveBeenCalled();
    f.port.close();
    await f.delivered;
  });
  it("write failure after record parks the callback, retains no rule and cannot be replayed", async () => {
    const f = await fixture();
    f.writer.mockImplementationOnce(async () => {
      throw new Error("synthetic write failure");
    });
    await expect(f.answer()).rejects.toMatchObject({ details: { answerRecorded: true } });
    await expect(f.delivered).rejects.toBeInstanceOf(HumanInputPending);
    expect(f.order).toEqual(["record"]);
    expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
    await expect(f.answer()).rejects.toMatchObject({ code: "RUN_STATE" });
  });
  it("uncertain answer append never writes policy or recreates a callback on restart", async () => {
    const f = await fixture();
    f.uncertainAppend();
    await expect(f.answer()).rejects.toThrow(/lost answer acknowledgement/);
    await expect(f.delivered).rejects.toThrow(/lost answer acknowledgement/);
    expect(f.writer).not.toHaveBeenCalled();
    expect((await f.policy.read()).document.scopedRules.records).toEqual([]);
    expect(await fileStores(join(f.root, "store")).events.readTypes("run", ["human.answered"])).toHaveLength(1);
    const restarted = new LiveHumanInput("next-boot");
    await expect(
      restarted.answer({ target: f.target, optionId: "once", standing: true }, f.liveAuthority, f.writer),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.writer).not.toHaveBeenCalled();
  });
  it("uncertain policy publication parks without delivery; restart inspects retained rule without replay", async () => {
    const f = await fixture();
    faults.publication = true;
    await expect(f.answer()).rejects.toMatchObject({ details: { answerRecorded: true } });
    await expect(f.delivered).rejects.toBeInstanceOf(HumanInputPending);
    expect(f.order).toEqual(["record"]);
    const restartedPolicy = createInactiveTypedSidecarStore(f.owner);
    expect((await restartedPolicy.read()).document.scopedRules.records).toHaveLength(1);
    const retained = await readFile(f.file, "utf8");
    await expect(f.answer()).rejects.toMatchObject({ code: "RUN_STATE" });
    const restarted = new LiveHumanInput("next-boot");
    await expect(
      restarted.answer({ target: f.target, optionId: "once", standing: true }, f.liveAuthority, f.writer),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.writer).toHaveBeenCalledTimes(1);
    expect(await readFile(f.file, "utf8")).toBe(retained);
  });
});

it("a separate credential-file revocation during the final policy read parks without publication or delivery", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  const verify = f.verifyApproval.getMockImplementation()!;
  f.verifyApproval.mockImplementationOnce(async (command, actor) => {
    const proof = await verify(command, actor);
    faults.readTarget = f.file;
    faults.afterRead = async () => {
      expect(await f.revokeOriginal()).toBe(true);
    };
    return proof;
  });
  await expect(f.answer()).rejects.toMatchObject({ details: { answerRecorded: true } });
  await expect(f.delivered).rejects.toBeInstanceOf(HumanInputPending);
  expect(f.order).toEqual(["record"]);
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(await f.stores.events.readTypes("run", ["human.answered"])).toHaveLength(1);
});

it("revocation after rename dispatch with lost acknowledgement remains uncertain and is never replayed", async () => {
  const f = await fixture();
  faults.afterDispatch = async () => {
    expect(await f.revokeOriginal()).toBe(true);
  };
  faults.publication = true;
  await expect(f.answer()).rejects.toMatchObject({ details: { answerRecorded: true } });
  await expect(f.delivered).rejects.toBeInstanceOf(HumanInputPending);
  const attempted = f.writer.mock.results[0]!;
  if (attempted.type !== "return") throw new Error("missing synthetic write attempt");
  await expect(attempted.value).rejects.toMatchObject({ details: { publication: "uncertain" } });
  expect((await f.policy.read()).document.scopedRules.records).toHaveLength(1);
  expect(f.order).toEqual(["record"]);
  await expect(f.answer()).rejects.toMatchObject({ code: "AUTH_INVALID" });
  expect(f.writer).toHaveBeenCalledTimes(1);
});
