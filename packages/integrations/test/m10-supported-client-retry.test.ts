/** Supported-client fresh intent versus replay; real stores/transports, synthetic work, no native keychain claim. */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { openAuthDirectory, bootstrapLocalOwner } from "@orca/daemon";
import { OperatorDiscoverySchema, RunsAdmitResultSchema } from "@orca/protocol";
import { DaemonClient } from "../../app/src/client/daemon-client.js";
import {
  AdmissionIntents,
  AdmissionIntentController,
  type IntentEncryption,
} from "../../app/src/main/admission-intents.js";
import {
  ProductionFixture,
  accepted,
  authenticationRefused,
  refused,
  root,
  transports,
} from "./mcp-operator-production-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Independent trusted store counts. No denied projection is used as a no-mutation oracle. */
async function counters(dir: string) {
  const stores = fileStores(join(dir, "state"));
  const runs = await stores.events.listRuns();
  let claims = 0;
  try {
    claims = (
      JSON.parse(await readFile(join(dir, "state/admission-retries/catalog.json"), "utf8")) as { total: number }
    ).total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const events = (await Promise.all(runs.map((runId) => stores.events.read(runId)))).flat();
  return {
    requests: (await stores.requests.list()).map((request) => request.id).sort(),
    runs: runs.sort(),
    claims,
    created: events.filter((event) => event.type === "run.created").length,
    started: events.filter((event) => event.type === "run.started").length,
    answered: events.filter((event) => event.type === "human.answered").length,
    revisions: events.filter((event) => event.type === "revision.recorded").length,
  };
}

describe.each(transports)("#331 supported MCP intent via %s", (transport) => {
  it.each(["operator.submitRequest", "operator.admitRun"] as const)(
    "%s replays on a new client, allocates an explicit fresh key, and rechecks current authority",
    async (method) => {
      const f = await ProductionFixture.create();
      cleanups.push(() => f.close());
      const issued = await f.issue({ principal: "synthetic-retry-client", preset: "owner" });
      const peer = await f.connect(transport, issued.token);
      const request = method === "operator.submitRequest";
      const command = {
        ...(await f.guards(peer, "gate", request ? "request" : "workflow")),
        vars: {},
        ...(request ? { title: "Synthetic intent", body: "PRIVATE_INTENT_BODY" } : {}),
      };
      const params = { target: peer.target, command, retry: { idempotencyKey: "M10_PRIVATE_ORIGINAL_KEY" } };
      const first = accepted(await f.mutation(peer, method, params));
      await f.readyStatus(peer, first.result.runId, "waiting");
      const before = await counters(f.dir);
      const reconnected = await f.connect(transport, issued.token);
      expect(accepted(await f.mutation(reconnected, method, params))).toEqual({ ...first, replayed: true });
      expect(await counters(f.dir)).toEqual(before);
      const fresh = accepted(
        await f.mutation(reconnected, method, { ...params, retry: { idempotencyKey: "M10_PRIVATE_FRESH_KEY" } }),
      );
      expect(fresh.replayed).toBe(false);
      expect(fresh.operationId).not.toBe(first.operationId);
      expect(fresh.result.admissionId).not.toBe(first.result.admissionId);
      expect(fresh.result.runId).not.toBe(first.result.runId);
      if (request) {
        expect(fresh.result).toHaveProperty("requestId");
        expect(first.result).toHaveProperty("requestId");
        if (!("requestId" in fresh.result) || !("requestId" in first.result))
          throw new Error("Missing Request receipt");
        expect(fresh.result.requestId).not.toBe(first.result.requestId);
      } else expect(fresh.result).not.toHaveProperty("requestId");
      await f.readyStatus(reconnected, fresh.result.runId, "waiting");
      const after = await counters(f.dir);
      expect(after.claims).toBe(before.claims + 1);
      expect(after.runs).toHaveLength(before.runs.length + 1);
      expect(after.requests).toHaveLength(before.requests.length + (request ? 1 : 0));
      const alias = request ? "submit_request" : "start_workflow";
      const conflict = await refused(
        reconnected,
        alias,
        {
          ...params,
          command: { ...command, ...(request ? { body: "PRIVATE_CHANGED_BODY" } : { vars: { topic: "changed" } }) },
        },
        "RETRY_CONFLICT",
      );
      expect(conflict).not.toMatch(/PRIVATE_CHANGED_BODY|M10_PRIVATE_ORIGINAL_KEY/);
      expect(await counters(f.dir)).toEqual(after);
      await f.revoke(issued.credential.id);
      await authenticationRefused(reconnected, alias, params);
      expect(await counters(f.dir)).toEqual(after);
      expect(JSON.stringify(await f.audit())).not.toMatch(/PRIVATE_INTENT_BODY|PRIVATE_CHANGED_BODY|M10_PRIVATE_/);
    },
  );
});

it.each(["submit", "run"])(
  "#331 actual CLI %s retains a key across processes; changed payload and revoked authority allocate nothing",
  async (operation) => {
    const dir = await mkdtemp(join(tmpdir(), "orca-m10-cli-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, "orca.config.yaml"),
      "storeDir: state\nworkflows: [program.yaml]\ntemplates: []\nprogram: {workflow: program}\n",
    );
    await writeFile(
      join(dir, "program.yaml"),
      "id: program\nname: Program\nversion: '1'\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
    );
    const auth = openAuthDirectory(join(dir, "auth"));
    const owner = await bootstrapLocalOwner(auth);
    const invoke = (key: string, changed = false) => {
      const result = spawnSync(
        process.execPath,
        [
          join(root, "packages/cli/dist/main.js"),
          operation,
          operation === "submit" ? "Synthetic intent" : "program",
          "--idempotency-key",
          key,
          "--quiet",
          ...(operation === "submit"
            ? ["--body", changed ? "CHANGED_CLI_BODY" : "PRIVATE_CLI_BODY"]
            : changed
              ? ["--var", "topic=changed"]
              : []),
        ],
        {
          cwd: dir,
          env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 32_768,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    };
    expect(invoke("CLI_PRIVATE_ORIGINAL_KEY").status).toBe(0);
    const before = await counters(dir);
    expect(before.requests).toHaveLength(operation === "submit" ? 1 : 0);
    expect(before.runs).toHaveLength(1);
    expect(invoke("CLI_PRIVATE_ORIGINAL_KEY").status).toBe(0);
    expect(await counters(dir)).toEqual(before);
    const conflict = invoke("CLI_PRIVATE_ORIGINAL_KEY", true);
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("RETRY_CONFLICT");
    expect(conflict.stderr).not.toMatch(/CHANGED_CLI_BODY|CLI_PRIVATE_ORIGINAL_KEY/);
    expect(await counters(dir)).toEqual(before);
    expect(invoke("CLI_PRIVATE_NEW_KEY").status).toBe(0);
    const fresh = await counters(dir);
    expect(fresh.runs).toHaveLength(2);
    expect(fresh.claims).toBe(before.claims + 1);
    expect(fresh.requests).toHaveLength(operation === "submit" ? 2 : 0);
    await auth.credentials.revoke(owner.credentialId);
    expect(invoke("CLI_PRIVATE_ORIGINAL_KEY").status).not.toBe(0);
    expect(await counters(dir)).toEqual(fresh);
  },
);

it("#331 app intent controller and real DaemonClient preserve identity across reconstruction/rotation, then explicitly abandon before fresh admission", async () => {
  const f = await ProductionFixture.create();
  cleanups.push(() => f.close());
  let issued = await f.issue({ principal: "synthetic-app-client", preset: "owner" });
  const path = join(f.dir, "synthetic-app-intents.enc");
  const key = randomBytes(32);
  // Fixture encryption exercises the protected journal API; Electron safeStorage remains a separate native gate.
  const encryption: IntentEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "synthetic-aes-gcm",
    encryptString: (text) => {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const journal = () => new AdmissionIntents(path, encryption);
  const controller = () =>
    new AdmissionIntentController(journal(), async () => {
      const token = issued.token;
      const client = new DaemonClient(f.endpoint, fetch, {
        requireAuthentication: true,
        auth: { read: () => token, refresh: () => false },
      });
      const found = await client.call("operator.discover", {}, OperatorDiscoverySchema);
      expect(found.operations).toContain("runs.admit");
      return {
        scope: { target: f.endpoint, principalId: found.principalId, workspaceId: found.target.workspaceId },
        assertCurrent() {
          if (issued.token !== token) throw new Error("Synthetic connection changed");
        },
        admit: (params) => client.call("runs.admit", params, RunsAdmitResultSchema),
      };
    });
  const initial = await controller().start("gate");
  const observer = await f.connect("http");
  const scope = {
    target: f.endpoint,
    principalId: "synthetic-app-client",
    workspaceId: observer.target.workspaceId,
  };
  const originalIntent = journal().retain(scope, "gate");
  await f.readyStatus(observer, initial.runId, "waiting");
  const before = await counters(f.dir);
  const retained = (await controller().list())[0]!;
  expect(await controller().start("gate")).toEqual(initial);
  expect(await counters(f.dir)).toEqual(before);
  await f.revoke(issued.credential.id);
  await expect(controller().start("gate")).rejects.toThrow("AUTH_INVALID");
  expect(await counters(f.dir)).toEqual(before);
  issued = await f.issue({ principal: "synthetic-app-client", preset: "owner" });
  expect(await controller().start("gate")).toEqual(initial);
  expect(journal().retain(scope, "gate").idempotencyKey).toBe(originalIntent.idempotencyKey);
  expect(await counters(f.dir)).toEqual(before);
  const c = controller();
  expect(await c.abandon(retained.id, async () => false)).toEqual({ abandoned: false });
  expect(await controller().start("gate")).toEqual(initial);
  expect(await c.abandon(retained.id, async () => true)).toEqual({ abandoned: true });
  expect(await counters(f.dir)).toEqual(before); // Abandon changes the app journal only.
  const fresh = await controller().start("gate");
  expect(fresh.runId).not.toBe(initial.runId);
  const freshIntent = journal().retain(scope, "gate");
  expect(freshIntent.idempotencyKey).not.toBe(originalIntent.idempotencyKey);
  await f.readyStatus(observer, fresh.runId, "waiting");
  const after = await counters(f.dir);
  expect(after.runs).toHaveLength(before.runs.length + 1);
  expect(after.claims).toBe(before.claims + 1);
  expect(after.requests).toEqual([]);
  const bytes = (await readFile(path)).toString("utf8");
  for (const secret of [scope.principalId, originalIntent.idempotencyKey, freshIntent.idempotencyKey])
    expect(bytes).not.toContain(secret);
});
