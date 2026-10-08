/** Real client/schema/journal composition over synthetic HTTP and a temporary prepared Git checkout. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorMutationContracts, type ConfigGetResult } from "@orca/protocol";
import { CONFIG_GET } from "../renderer/test/fixtures-config.js";
import type { LaunchReview } from "../src/configuration-launch-contract.js";
import type { DaemonTargetSnapshot } from "../src/daemon-connection.js";
import { DaemonClient } from "../src/client/daemon-client.js";
import { AdmissionIntents, type IntentEncryption } from "../src/main/admission-intents.js";
import { GuidedLaunchAdapter } from "../src/main/guided-launch-adapter.js";
import { observePreparedCheckout } from "../src/main/guided-checkout.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orca-launch-adapter-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "prepared");
  writeFileSync(join(dir, "source.txt"), "small source\n");
  git("add", "source.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "fixture",
  );
  let target: DaemonTargetSnapshot = {
    epoch: 1,
    source: "bundled",
    url: "http://localhost:7331",
    environmentOverride: false,
    identity: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
    },
  };
  const workspace = { path: dir, readOnly: false, source: "default" as const };
  let generation = "generation-1",
    token = "alice",
    lose = false,
    failure = false,
    unavailable = false,
    rotateOnConfigRead = false;
  const calls: { method: string; params: Record<string, unknown>; token: string }[] = [];
  const operationId = "retry_33333333-3333-4333-8333-333333333333";
  const config: ConfigGetResult = {
    ...structuredClone(CONFIG_GET),
    config: {
      ...CONFIG_GET.config,
      path: join(dir, "orca.config.yaml"),
      parsed: { workspace: { provider: "local", root: ".", hostId: "local" } },
    },
    generation: {
      savedRevision: CONFIG_GET.config.revision,
      activeRevision: CONFIG_GET.config.revision,
      activeGeneration: generation,
      state: "active",
      restartRequired: [],
    },
  };
  const fetcher: typeof fetch = async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
    const request = JSON.parse(init.body) as { id: number; method: string; params: Record<string, unknown> };
    const credential = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    calls.push({ ...request, token: credential });
    const identity = target.identity!;
    let result: unknown;
    if (request.method === "operator.discover")
      result = {
        target: identity,
        protocol: { major: 1, minor: 0 },
        orcaVersion: "fixture",
        principalId: credential,
        authentication: "credential",
        scope: { runs: "owned", workflows: "*", permissions: [] },
        operations: [
          "operator.admitRun",
          "operator.submitRequest",
          "operator.admission",
          "operator.reconcileAdmission",
        ],
        collections: [],
        asOf: "2026-10-08T00:00:00Z",
      };
    else if (request.method === "operator.config") {
      if (unavailable) throw new Error("private config transport needle");
      result = {
        target: identity,
        activeGeneration: generation,
        activeRevision: CONFIG_GET.config.revision,
        savedRevision: CONFIG_GET.config.revision,
        state: "active",
        asOf: "2026-10-08T00:00:00Z",
      };
    } else if (request.method === "config.get") {
      if (rotateOnConfigRead) token = "bob";
      result = { ...config, generation: { ...config.generation, activeGeneration: generation } };
    } else if (request.method === "workflows.list")
      result = {
        workflows: [{ id: "safe-fixture", name: "Safe fixture", version: "1", nodeCount: 2 }],
        asOf: "2026-10-08T00:00:00Z",
      };
    else if (request.method === "workflows.get")
      result = {
        workflow: {
          id: "safe-fixture",
          name: "Safe fixture",
          version: "1",
          start: "start",
          nodes: [],
          edges: [],
          inputSchema: {
            fields: {
              task: { type: "string", required: true },
              count: { type: "integer" },
              enabled: { type: "boolean" },
              nullable: { type: "string", nullable: true },
            },
          },
        },
        asOf: "2026-10-08T00:00:00Z",
      };
    else if (request.method === "operator.preflight")
      result = {
        target: identity,
        workflowId: "safe-fixture",
        workflowVersion: "1",
        expectedWorkflowRevision: "digest-1",
        expectedConfigGeneration: generation,
        validation: { ok: true, errors: [], warnings: [] },
        asOf: "2026-10-08T00:00:00Z",
      };
    else {
      const method = request.method as keyof typeof OperatorMutationContracts;
      const contract = OperatorMutationContracts[method];
      contract.params.parse(request.params);
      if (lose) {
        lose = false;
        throw new Error("lost response with private transport needle");
      }
      const command = request.params.command as { title?: string } | undefined;
      const mode = command?.title ? "request" : "direct";
      result = {
        state: "resolved",
        operationId,
        replayed: request.method.includes("Admission"),
        result: failure
          ? {
              state: "recoverable-failure",
              admissionId: "admission-1",
              ...(mode === "request" ? { requestId: "request-1" } : {}),
              failure: { code: "RUN_STATE", recovery: "reconcile" },
            }
          : {
              state: "accepted",
              admissionId: "admission-1",
              ...(mode === "request" ? { requestId: "request-1" } : {}),
              runId: "run-1",
            },
      };
    }
    return new Response(JSON.stringify({ kind: "response", id: request.id, ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new DaemonClient(target.url, fetcher, {
    auth: { read: () => token, refresh: () => false },
    requireAuthentication: true,
  });
  const key = randomBytes(32);
  const encryption: IntentEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const journalPath = join(dir, "intent.enc");
  const journal = new AdmissionIntents(journalPath, encryption);
  const make = () =>
    new GuidedLaunchAdapter(new AdmissionIntents(journalPath, encryption), () => {
      const epoch = target.epoch;
      return {
        client,
        target,
        workspace,
        assertCurrent: () => {
          if (target.epoch !== epoch) throw new Error("stale target");
        },
      };
    });
  const adapter = make();
  const review = async (mode: "direct" | "request" = "direct"): Promise<LaunchReview> => {
    const observed = await adapter.preflight({
      target: target.identity!,
      purpose: mode === "direct" ? "workflow" : "request",
      workflowId: "safe-fixture",
      vars: { task: "private task needle", count: 0, enabled: false, nullable: null },
    });
    const params = {
      workflowId: "safe-fixture",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: generation,
      vars: { task: "private task needle", count: 0, enabled: false, nullable: null },
    };
    return {
      target: { ...target.identity!, epoch: target.epoch },
      draftSequence: 1,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
      expectedWorkflowRevision: params.expectedWorkflowRevision,
      expectedConfigGeneration: generation,
      checkout: observed.checkout,
      command:
        mode === "direct"
          ? { mode, params }
          : { mode, params: { ...params, title: "Task", body: "private body needle" } },
    };
  };
  return {
    adapter,
    journal,
    journalPath,
    make,
    review,
    calls,
    config,
    workspace,
    git,
    dir,
    target: () => target,
    rotate: () => {
      rotateOnConfigRead = true;
    },
    token: (next: string) => {
      token = next;
    },
    generation: () => {
      generation = "generation-2";
    },
    lose: () => {
      lose = true;
    },
    fail: () => {
      failure = true;
    },
    unavailable: () => {
      unavailable = true;
    },
    reconnect: () => {
      target = {
        ...target,
        epoch: target.epoch + 1,
        identity: { ...target.identity!, instanceId: "44444444-4444-4444-8444-444444444444" },
      };
    },
  };
}
describe("production guided launch composition", () => {
  it.each(["direct", "request"] as const)(
    "retains exact %s command before guarded send and pins the discovered credential",
    async (mode) => {
      const f = fixture();
      const review = await f.review(mode);
      f.rotate();
      const submitted = await f.adapter.controller.submit(review);
      const sent = f.calls.find(
        (call) => call.method === (mode === "direct" ? "operator.admitRun" : "operator.submitRequest"),
      )!;
      expect(sent.token).toBe("alice");
      expect(sent.params.command).toEqual(review.command.params);
      expect(sent.params.target).toEqual(
        review.target && { workspaceId: review.target.workspaceId, instanceId: review.target.instanceId },
      );
      expect(sent.params.retry).toEqual({ idempotencyKey: expect.any(String) });
      expect(submitted.response).toMatchObject({
        kind: "retry",
        receipt: { state: "resolved", operationId: expect.any(String), result: { runId: "run-1" } },
      });
      expect(readFileSync(f.journalPath).toString()).not.toContain("private task needle");
    },
  );
  it("resolves only the exact protected review and recovers its original key after reconnect/generation movement", async () => {
    const f = fixture();
    const review = await f.review();
    f.lose();
    await expect(f.adapter.controller.submit(review)).rejects.toThrow("lost response");
    const oldSend = f.calls.find((call) => call.method === "operator.admitRun")!;
    f.reconnect();
    f.generation();
    const restarted = f.make();
    const intent = await restarted.resolve(review);
    expect(intent).toBeDefined();
    await expect(restarted.controller.recover(intent!.intentId, "inspect")).rejects.toThrow();
    expect(f.calls.filter((call) => call.method === "operator.admitRun")).toHaveLength(1);
    expect(await restarted.resolve({ ...review, draftSequence: 9 })).toBeUndefined();
    await restarted.controller.recover(intent!.intentId, "reconcile");
    const sends = f.calls.filter((call) => call.method === "operator.admitRun");
    expect(sends[1]!.params.command).toEqual(oldSend.params.command);
    expect(sends[1]!.params.retry).toEqual(oldSend.params.retry);
    expect(sends[1]!.params.target).not.toEqual(oldSend.params.target);
    f.token("another-principal");
    expect(await restarted.resolve(review)).toBeUndefined();
    await expect(restarted.load(intent!.intentId)).rejects.toThrow();
  });
  it("refuses a preview made for another verified principal before retaining or sending", async () => {
    const f = fixture();
    const review = await f.review();
    f.token("changed-principal");
    await expect(f.adapter.controller.submit(review)).rejects.toThrow("cannot verify");
    expect(f.calls.some((call) => call.method === "operator.admitRun")).toBe(false);
    expect(
      f.journal.guidedList({
        target: `bundled:${f.dir}`,
        principalId: "changed-principal",
        workspaceId: review.target.workspaceId,
      }),
    ).toEqual([]);
  });
  it("refuses changed tracked checkout evidence or stale generation before any mutation", async () => {
    const f = fixture();
    const review = await f.review();
    writeFileSync(join(f.dir, "source.txt"), "changed\n");
    await expect(f.adapter.controller.submit(review)).rejects.toThrow("cannot verify");
    expect(f.calls.some((call) => call.method === "operator.admitRun")).toBe(false);
    const current = await f.review();
    f.generation();
    await expect(f.adapter.controller.submit(current)).rejects.toThrow();
  });
  it("preserves recoverable failure and restores exact protected commands even when launch configuration reads are unavailable", async () => {
    const f = fixture();
    const review = await f.review();
    f.fail();
    const submitted = await f.adapter.controller.submit(review);
    expect(submitted.response).toMatchObject({
      receipt: { result: { state: "recoverable-failure", failure: { message: expect.any(String) } } },
    });
    f.unavailable();
    const snapshot = await f.adapter.snapshot();
    expect(snapshot.workflows).toEqual([]);
    expect(snapshot.checkout.state).toBe("unavailable");
    expect((await f.adapter.load(submitted.intent.intentId)).review).toEqual(review);
  });
  it("observes the configured relative root and ignores ambient Git routing without inventing an untracked-file policy", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "personal-untracked.txt"), "not traversed\n");
    vi.stubEnv("GIT_DIR", "/missing/ambient-git-dir");
    const evidence = await observePreparedCheckout(
      f.config,
      f.target(),
      { ...f.workspace, path: "/different/app/store" },
      "generation-1",
      { endpointId: `bundled:${f.dir}`, principalId: "alice" },
    );
    expect(evidence).toMatchObject({ state: "verified", cwd: f.dir, branch: "prepared" });
    expect(
      await observePreparedCheckout(f.config, { ...f.target(), source: "saved" }, f.workspace, "generation-1", {
        endpointId: `bundled:${f.dir}`,
        principalId: "alice",
      }),
    ).toMatchObject({ state: "unavailable" });
  });
});
