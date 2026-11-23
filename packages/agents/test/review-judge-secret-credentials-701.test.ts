/**
 * #701 bring-your-own-key through #336 secret references. The real `secretJudgeCredentials` service drives the
 * unchanged judge connection and endpoint adapter against a deterministic fake endpoint. The value is generated per
 * run and set in this process's environment only for the test; no network, real key, model or paid call is used.
 */
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrcaError,
  validateSecretReferences,
  type ApprovedJudgePayloadV1,
  type HostSpec,
  type JudgeRequestV1,
  type SecretsConfig,
} from "@orca/core";
import { LOCAL_ADVICE_SCHEMA, LOCAL_EVIDENCE_SCHEMA } from "../src/review-judge/adapter.js";
import {
  ENDPOINT_FRAME_FIELDS,
  JUDGE_DISCLOSURE_PURPOSE,
  prepareJudgeConnection,
  REQUIRED_SENDER_CAPABILITIES,
  type JudgeConnectionDescriptor,
  type JudgeDisclosureGrantService,
  type JudgeDisclosureQuery,
  type JudgeEndpointSender,
} from "../src/review-judge/connection.js";
import {
  createEndpointReviewJudge,
  ENDPOINT_REQUEST_SCHEMA,
  ENDPOINT_RESPONSE_SCHEMA,
} from "../src/review-judge/endpoint.js";
import {
  JUDGE_SECRET_CREDENTIAL_KIND,
  judgeSecretRef,
  JudgeSecretRefused,
  secretJudgeCredentials,
  type JudgeSecretCredential,
  type SecretJudgeCredentialOptions,
} from "../src/review-judge/secret-credentials.js";
import { planSessionSecrets, secretHostBinding, secretSourceBinding, type SecretUse } from "../src/secrets.js";
import type { AgentHost } from "../src/host.js";

const DESTINATION = "https://judge.invalid/v0";
const OTHER = "https://other-judge.invalid/v0";
const local: { id: string; spec: HostSpec } = { id: "local", spec: { type: "local" } as HostSpec };
const remote: { id: string; spec: HostSpec } = {
  id: "box",
  spec: { type: "ssh", host: "box.invalid", sshArgs: [], sshBinary: "ssh", remoteShell: "sh" } as unknown as HostSpec,
};

/** The service with a dispatch-time check that always grants, unless a test passes its own. */
const make = (
  opts: Omit<SecretJudgeCredentialOptions, "authorizedNow"> &
    Partial<Pick<SecretJudgeCredentialOptions, "authorizedNow">>,
) => secretJudgeCredentials({ authorizedNow: () => true, ...opts });

const envVars: string[] = [];
function freshEnvSecret() {
  const name = `ORCA_TEST_JUDGE_KEY_${randomUUID().replace(/-/g, "_").toUpperCase()}`;
  const value = `judge-key-${randomUUID()}`;
  process.env[name] = value;
  envVars.push(name);
  return { name, value };
}
afterEach(() => {
  for (const name of envVars.splice(0)) delete process.env[name];
  vi.restoreAllMocks();
});

const descriptor = (secret = "judge-key", destination = DESTINATION): JudgeConnectionDescriptor => ({
  methodVersion: "fake-endpoint-method/v1",
  modelVersion: "fake-model/v1",
  promptVersion: "fake-prompt/v1",
  configVersion: "fake-config/v1",
  destination,
  destinationPolicyRef: "disclosure:fake/v1",
  projectionPolicyRevision: "projection/v1",
  credentialRef: judgeSecretRef(secret),
  limits: {
    maxPending: 2,
    maxCalls: 10,
    maxRequestBytes: 1024,
    maxResponseBytes: 512,
    maxTimeoutMs: 1000,
    maxCostUnitsPerCall: 1,
    maxTotalCostUnits: 10,
  },
});

function grants(): JudgeDisclosureGrantService {
  return {
    find: async (query: JudgeDisclosureQuery) => ({
      ...query,
      grantRef: `grant:${query.destination}`,
      revision: "r1",
      fields: [...ENDPOINT_FRAME_FIELDS],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    current: async () => ({ revision: "r1", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  };
}

/** Deterministic fake endpoint: authenticates with the revealed value, then answers `fit` for the frame. */
function sender(expected: () => string, destination = DESTINATION) {
  const seen: unknown[] = [];
  const send = vi.fn(async (delivery: Parameters<JudgeEndpointSender["send"]>[0]) => {
    const credential = delivery.credential as JudgeSecretCredential;
    seen.push(credential);
    if (credential.kind !== JUDGE_SECRET_CREDENTIAL_KIND || credential.destination !== destination)
      throw new Error("wrong credential");
    if (credential.reveal() !== expected()) throw new Error("unauthenticated");
    const sent = JSON.parse(delivery.frame) as Record<string, string>;
    if (sent.schema !== ENDPOINT_REQUEST_SCHEMA) throw new Error("schema");
    return JSON.stringify({
      schema: ENDPOINT_RESPONSE_SCHEMA,
      requestId: sent.requestId,
      model: sent.model,
      adviceSchema: LOCAL_ADVICE_SCHEMA,
      recommendation: "allow",
      rationaleCode: "fixture-match",
      uncertainty: false,
    });
  });
  const value: JudgeEndpointSender = {
    version: "fake-sender/v1",
    destination,
    capabilities: [...REQUIRED_SENDER_CAPABILITIES],
    send,
  };
  return { sender: value, send, seen };
}

function request(judgeConfigRef: string, d = descriptor()) {
  const req: JudgeRequestV1 = {
    version: 1,
    reviewId: "review:1",
    actionBindingRef: "action:1",
    authority: {
      capturedGeneration: "g1",
      currentPolicyRevision: "p1",
      authorityRevision: "a1",
      revocationEpoch: "r1",
      leaseEpoch: "l1",
    },
    coverageId: "coverage:1",
    delegation: { ruleId: "rule:1", ruleRevision: "rr1" },
    requirement: "required",
    projectionPolicyRevision: d.projectionPolicyRevision,
    destinationPolicyRef: d.destinationPolicyRef,
    judgeConfigRef,
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
    approvedProjection: {
      kind: "parsed-json",
      codecVersion: LOCAL_EVIDENCE_SCHEMA,
      privateRef: "protected:x",
      bindingRef: "projection:1",
    },
  };
  const payload: ApprovedJudgePayloadV1 = {
    version: 1,
    bindingRef: "projection:1",
    schemaVersion: LOCAL_EVIDENCE_SCHEMA,
    content: JSON.stringify({
      schema: LOCAL_EVIDENCE_SCHEMA,
      applicability: "matches",
      context: "complete",
      injection: "absent",
    }),
  };
  return { req, payload };
}

function harness(
  options: {
    catalog?: () => SecretsConfig;
    host?: { id: string; spec: HostSpec };
    authorize?: (uses: SecretUse[]) => Promise<void>;
    destination?: string;
  } = {},
) {
  const env = freshEnvSecret();
  let catalog: SecretsConfig = {
    "judge-key": { host: "local", provider: "env", name: env.name, destination: DESTINATION },
  };
  const uses: SecretUse[][] = [];
  const nowUses: SecretUse[][] = [];
  let granted = true;
  const authorize = vi.fn(options.authorize ?? (async (u: SecretUse[]) => void uses.push(u)));
  const credentials = make({
    secrets: options.catalog ?? (() => catalog),
    host: options.host ?? local,
    authorize,
    authorizedNow: (u) => (nowUses.push(u), granted),
    agentId: "agent-a",
  });
  const s = sender(() => process.env[env.name]!, options.destination ?? DESTINATION);
  const prepare = (d = descriptor()) =>
    prepareJudgeConnection(d, { grants: grants(), credentials, sender: s.sender }, new AbortController().signal);
  return {
    env,
    uses,
    nowUses,
    setGranted: (value: boolean) => (granted = value),
    authorize,
    credentials,
    send: s.send,
    seen: s.seen,
    prepare,
    setCatalog: (next: SecretsConfig) => (catalog = next),
  };
}

async function assess(h: ReturnType<typeof harness>) {
  const connection = await h.prepare();
  if (connection.status !== "prepared") throw new Error(`expected prepared, got ${connection.reason}`);
  const judge = createEndpointReviewJudge({
    manifest: connection.manifest,
    transport: connection.transport,
    limits: connection.limits,
  });
  const { req, payload } = request(connection.configRef);
  return { result: await judge.assess(req, payload, new AbortController().signal), connection };
}

describe("#701 BYOK through a pinned #336 secret reference", () => {
  it("judges end to end with the value read at use, after the run's use check", async () => {
    const h = harness();
    const { result, connection } = await assess(h);
    expect(result).toMatchObject({ execution: "evaluated", result: "fit", judgeVersion: connection.configRef });
    const judgeUse = {
      secret: "judge-key",
      provider: "env",
      hostId: "local",
      hostBinding: secretHostBinding(local.spec),
      agentId: "agent-a",
      purpose: "review-judge",
      destination: DESTINATION,
      sourceBinding: secretSourceBinding({ provider: "env", name: h.env.name }),
    };
    // The awaited check before the read, and the synchronous one at the hand-off, both for this purpose and destination.
    expect(h.uses).toEqual([[judgeUse]]);
    expect(h.nowUses).toEqual([[judgeUse]]);
    // The value is absent from everything the caller can see or serialize.
    const visible = JSON.stringify([connection, result, connection.refusals()]) + inspect(connection, { depth: 9 });
    expect(visible).not.toContain(h.env.value);
  });

  it("asks the use check and reads the value again at every use, so rotation and revocation take effect", async () => {
    const h = harness();
    const connection = await h.prepare();
    if (connection.status !== "prepared") throw new Error(connection.reason);
    const judge = createEndpointReviewJudge({
      manifest: connection.manifest,
      transport: connection.transport,
      limits: connection.limits,
    });
    const run = () => {
      const { req, payload } = request(connection.configRef);
      return judge.assess(req, payload, new AbortController().signal);
    };
    expect(await run()).toMatchObject({ result: "fit" });
    process.env[h.env.name] = `rotated-${randomUUID()}`;
    expect(await run()).toMatchObject({ result: "fit" });
    expect(h.authorize).toHaveBeenCalledTimes(2);
    h.setGranted(false);
    expect(await run()).toMatchObject({ execution: "unavailable", result: "indeterminate" });
    h.setGranted(true);
    h.authorize.mockImplementation(async () => {
      throw new OrcaError("CONFIG_INVALID", "not granted");
    });
    expect(await run()).toMatchObject({ execution: "unavailable", result: "indeterminate" });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("hands the sender a handle that does not serialize or print the value and stops revealing it after the use", async () => {
    const h = harness();
    await assess(h);
    const credential = h.seen[0] as JudgeSecretCredential;
    expect(JSON.stringify(credential)).not.toContain(h.env.value);
    expect((credential as unknown as { toString(): string }).toString()).not.toContain(h.env.value);
    expect(inspect(credential, { depth: 9, showHidden: true })).not.toContain(h.env.value);
    expect(() => credential.reveal()).toThrow(JudgeSecretRefused);
  });

  it("refuses a file-backed key: a path cannot yet be bound to the file a read opens", async () => {
    const read = vi.fn(async () => "value");
    const catalog: SecretsConfig = {
      "judge-key": { host: "local", provider: "file", path: "/etc/orca/judge-key", destination: DESTINATION },
    };
    const credentials = make({ secrets: () => catalog, host: local, authorize: async () => {}, agentId: "a", read });
    expect(await credentials.describe(judgeSecretRef("judge-key"), new AbortController().signal)).toMatchObject({
      available: false,
    });
    await expect(
      credentials.withCredential(
        judgeSecretRef("judge-key"),
        { purpose: JUDGE_DISCLOSURE_PURPOSE, destination: DESTINATION, grantRef: "grant:1" },
        new AbortController().signal,
        async () => 1,
      ),
    ).rejects.toMatchObject({ code: "file-unsupported" });
    expect(read).not.toHaveBeenCalled();
    expect(
      validateSecretReferences({ secrets: catalog, hosts: [{ id: "local" }], agents: [] }).map((i) => i.path),
    ).toEqual(["secrets.judge-key.provider"]);
  });
});

describe("#701 BYOK refusals: no fallback to another value, host or destination", () => {
  const unavailable = async (h: ReturnType<typeof harness>, d = descriptor()) => {
    const connection = await h.prepare(d);
    return connection.status === "unavailable" ? connection.reason : "prepared";
  };

  it("refuses an undefined reference and a reference that is not a secret reference", async () => {
    const h = harness();
    expect(await unavailable(h, descriptor("no-such-key"))).toBe("credential-binding-missing");
    expect(
      await unavailable(h, { ...descriptor(), credentialRef: { kind: "credential-ref/v0", id: "judge-key" } }),
    ).toBe("credential-binding-missing");
  });

  it("refuses an unpinned secret, one pinned elsewhere, and one bound to another host", async () => {
    const h = harness();
    h.setCatalog({ "judge-key": { host: "local", provider: "env", name: h.env.name } });
    expect(await unavailable(h)).toBe("credential-destination-mismatch");
    h.setCatalog({ "judge-key": { host: "local", provider: "env", name: h.env.name, destination: OTHER } });
    expect(await unavailable(h)).toBe("credential-destination-mismatch");
    h.setCatalog({ "judge-key": { host: "box", provider: "env", name: h.env.name, destination: DESTINATION } });
    expect(await unavailable(h)).toBe("credential-unavailable");
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("refuses on a host that is not the daemon's own machine", async () => {
    const h = harness({ host: remote, catalog: () => ({}) });
    const credentials = make({
      secrets: () => ({ "judge-key": { host: "box", provider: "env", name: "X", destination: DESTINATION } }),
      host: remote,
      authorize: h.authorize,
      agentId: "agent-a",
    });
    expect(await credentials.describe(judgeSecretRef("judge-key"), new AbortController().signal)).toMatchObject({
      available: false,
    });
    await expect(
      credentials.withCredential(
        judgeSecretRef("judge-key"),
        { purpose: JUDGE_DISCLOSURE_PURPOSE, destination: DESTINATION, grantRef: "g" },
        new AbortController().signal,
        async () => "sent",
      ),
    ).rejects.toMatchObject({ code: "unsupported-host" });
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("stops at use when the reference is re-pinned or re-bound after preparation", async () => {
    const h = harness();
    const connection = await h.prepare();
    if (connection.status !== "prepared") throw new Error(connection.reason);
    const judge = createEndpointReviewJudge({
      manifest: connection.manifest,
      transport: connection.transport,
      limits: connection.limits,
    });
    h.setCatalog({ "judge-key": { host: "local", provider: "env", name: h.env.name, destination: OTHER } });
    const { req, payload } = request(connection.configRef);
    expect(await judge.assess(req, payload, new AbortController().signal)).toMatchObject({
      execution: "unavailable",
    });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("refuses a use for another purpose, destination or without a grant, before the use check", async () => {
    const h = harness();
    const signal = new AbortController().signal;
    const ref = judgeSecretRef("judge-key");
    const consume = vi.fn(async () => "sent");
    const attempt = (use: Record<string, unknown>) =>
      h.credentials.withCredential(ref, use as never, signal, consume).catch((e: JudgeSecretRefused) => e.code);
    expect(await attempt({ purpose: "other", destination: DESTINATION, grantRef: "g" })).toBe("wrong-purpose");
    expect(await attempt({ purpose: JUDGE_DISCLOSURE_PURPOSE, destination: OTHER, grantRef: "g" })).toBe(
      "wrong-destination",
    );
    expect(await attempt({ purpose: JUDGE_DISCLOSURE_PURPOSE, destination: DESTINATION, grantRef: "" })).toBe(
      "wrong-purpose",
    );
    expect(h.authorize).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuses a missing value without naming it, and an unauthorized use without reading it", async () => {
    const read = vi.fn(async () => "never");
    const credentials = make({
      secrets: () => ({ "judge-key": { host: "local", provider: "env", name: "X", destination: DESTINATION } }),
      host: local,
      authorize: async () => {
        throw new Error("denied");
      },
      agentId: "agent-a",
      read,
    });
    const use = { purpose: JUDGE_DISCLOSURE_PURPOSE, destination: DESTINATION, grantRef: "g" } as const;
    await expect(
      credentials.withCredential(judgeSecretRef("judge-key"), use, new AbortController().signal, async () => 1),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(read).not.toHaveBeenCalled();

    const name = `ORCA_TEST_UNSET_${randomUUID().replace(/-/g, "_")}`;
    const missing = make({
      secrets: () => ({ "judge-key": { host: "local", provider: "env", name, destination: DESTINATION } }),
      host: local,
      authorize: async () => {},
      agentId: "agent-a",
    });
    await expect(
      missing.withCredential(judgeSecretRef("judge-key"), use, new AbortController().signal, async () => 1),
    ).rejects.toMatchObject({ code: "missing", message: "judge credential refused: missing" });
  });

  it("refuses a cancelled use before reading, and discards a value read after cancellation", async () => {
    const controller = new AbortController();
    const consume = vi.fn(async () => 1);
    const credentials = make({
      secrets: () => ({ "judge-key": { host: "local", provider: "env", name: "X", destination: DESTINATION } }),
      host: local,
      authorize: async () => {},
      agentId: "agent-a",
      read: async () => {
        controller.abort();
        return "late";
      },
    });
    const use = { purpose: JUDGE_DISCLOSURE_PURPOSE, destination: DESTINATION, grantRef: "g" } as const;
    await expect(
      credentials.withCredential(judgeSecretRef("judge-key"), use, controller.signal, consume),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("#701 revalidation at delivery", () => {
  const use = { purpose: JUDGE_DISCLOSURE_PURPOSE, destination: DESTINATION, grantRef: "g" } as const;
  const pinned: SecretsConfig = {
    "judge-key": { host: "local", provider: "env", name: "X", destination: DESTINATION },
  };

  it("refuses when the catalog changes while the value is read: re-pinned, re-sourced or removed", async () => {
    const changes: SecretsConfig[] = [
      { "judge-key": { host: "local", provider: "env", name: "X", destination: OTHER } },
      { "judge-key": { host: "local", provider: "env", name: "Y", destination: DESTINATION } },
      { "judge-key": { host: "local", provider: "file", path: "/k", destination: DESTINATION } },
      {},
    ];
    for (const next of changes) {
      let catalog = pinned;
      const consume = vi.fn(async () => 1);
      const authorize = vi.fn(async () => {});
      const credentials = make({
        secrets: () => catalog,
        host: local,
        authorize,
        agentId: "agent-a",
        read: async () => {
          catalog = next;
          return "value";
        },
      });
      const code = await credentials
        .withCredential(judgeSecretRef("judge-key"), use, new AbortController().signal, consume)
        .catch((e: JudgeSecretRefused) => e.code);
      expect(["reconfigured", "wrong-destination", "undefined", "file-unsupported"]).toContain(code);
      expect(consume).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses when the grant is revoked while the value is read", async () => {
    let granted = true;
    const consume = vi.fn(async () => 1);
    const credentials = make({
      secrets: () => pinned,
      host: local,
      authorize: async () => {},
      authorizedNow: () => granted,
      agentId: "agent-a",
      read: async () => {
        granted = false;
        return "value";
      },
    });
    await expect(
      credentials.withCredential(judgeSecretRef("judge-key"), use, new AbortController().signal, consume),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(consume).not.toHaveBeenCalled();
  });

  it("awaits the caller's last check before its own synchronous checks, and hands off in that turn", async () => {
    const order: string[] = [];
    const credentials = make({
      secrets: () => (order.push("catalog"), pinned),
      host: local,
      authorize: async () => void order.push("authorize"),
      authorizedNow: () => (order.push("authorizedNow"), true),
      agentId: "agent-a",
      read: async () => (order.push("read"), "value"),
    });
    await credentials.withCredential(
      judgeSecretRef("judge-key"),
      use,
      new AbortController().signal,
      async () => void order.push("consume"),
      async () => void order.push("beforeHandoff"),
    );
    expect(order).toEqual(["catalog", "authorize", "read", "beforeHandoff", "catalog", "authorizedNow", "consume"]);
  });

  it("refuses when the catalog, the grant or the call changes during the caller's last check", async () => {
    const cases: [string, (s: { catalog: SecretsConfig; granted: boolean; controller: AbortController }) => void][] = [
      ["reconfigured", (s) => (s.catalog = { "judge-key": { ...pinned["judge-key"]!, name: "Y" } as never })],
      ["wrong-destination", (s) => (s.catalog = { "judge-key": { ...pinned["judge-key"]!, destination: OTHER } })],
      ["unauthorized", (s) => (s.granted = false)],
      ["cancelled", (s) => s.controller.abort()],
    ];
    for (const [code, change] of cases) {
      const state = { catalog: pinned, granted: true, controller: new AbortController() };
      const consume = vi.fn(async () => 1);
      const credentials = make({
        secrets: () => state.catalog,
        host: local,
        authorize: async () => {},
        authorizedNow: () => state.granted,
        agentId: "agent-a",
        read: async () => "value",
      });
      await expect(
        credentials.withCredential(judgeSecretRef("judge-key"), use, state.controller.signal, consume, async () =>
          change(state),
        ),
      ).rejects.toMatchObject({ code });
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("through the connection, reads the disclosure grant last and still stops a re-pin made during that read", async () => {
    const h = harness();
    const connection = await prepareJudgeConnection(
      descriptor(),
      {
        grants: {
          ...grants(),
          current: async () => {
            h.setCatalog({
              "judge-key": { host: "local", provider: "env", name: `${h.env.name}_OTHER`, destination: DESTINATION },
            });
            return { revision: "r1", expiresAt: new Date(Date.now() + 60_000).toISOString() };
          },
        },
        credentials: h.credentials,
        sender: sender(() => process.env[h.env.name]!).sender,
      },
      new AbortController().signal,
    );
    if (connection.status !== "prepared") throw new Error(connection.reason);
    const judge = createEndpointReviewJudge({
      manifest: connection.manifest,
      transport: connection.transport,
      limits: connection.limits,
    });
    const { req, payload } = request(connection.configRef);
    expect(await judge.assess(req, payload, new AbortController().signal)).toMatchObject({
      execution: "unavailable",
    });
    expect(h.nowUses).toEqual([]);
  });

  it("ends the lease the moment the use is cancelled, while the sender still holds the handle", async () => {
    const controller = new AbortController();
    const credentials = make({
      secrets: () => pinned,
      host: local,
      authorize: async () => {},
      agentId: "agent-a",
      read: async () => "value",
    });
    let release!: () => void;
    const seen: string[] = [];
    const pending = credentials.withCredential(
      judgeSecretRef("judge-key"),
      use,
      controller.signal,
      async (credential) => {
        const handle = credential as JudgeSecretCredential;
        seen.push(handle.reveal());
        await new Promise<void>((resolve) => (release = resolve));
        try {
          seen.push(handle.reveal());
        } catch (error) {
          seen.push((error as JudgeSecretRefused).code);
        }
      },
    );
    await vi.waitFor(() => expect(seen).toEqual(["value"]));
    controller.abort();
    release();
    await pending;
    expect(seen).toEqual(["value", "cancelled"]);
  });
});

describe("#701 a second declaration of the same source cannot side-step a pin", () => {
  const aliased: SecretsConfig = {
    "judge-key": { host: "local", provider: "env", name: "JUDGE_KEY", destination: DESTINATION },
    plain: { host: "local", provider: "env", name: "judge_key" },
  };
  const otherPin: SecretsConfig = {
    "judge-key": { host: "local", provider: "env", name: "JUDGE_KEY", destination: DESTINATION },
    "judge-key-2": { host: "local", provider: "env", name: "Judge_Key", destination: OTHER },
  };

  it("is a config error", () => {
    const check = (secrets: SecretsConfig) =>
      validateSecretReferences({ secrets, hosts: [{ id: "local" }], agents: [] }).map((i) => i.path);
    expect(check(aliased)).toEqual(["secrets.judge-key", "secrets.plain"]);
    expect(check(otherPin)).toEqual(["secrets.judge-key", "secrets.judge-key-2"]);
    expect(
      check({
        a: { host: "local", provider: "env", name: "K", destination: DESTINATION },
        b: { host: "local", provider: "env", name: "K", destination: DESTINATION },
      }),
    ).toEqual([]);
  });

  it("is refused for the judge and for an agent at use", async () => {
    for (const catalog of [aliased, otherPin]) {
      const credentials = make({
        secrets: () => catalog,
        host: local,
        authorize: async () => {},
        agentId: "agent-a",
        read: async () => "value",
      });
      expect(await credentials.describe(judgeSecretRef("judge-key"), new AbortController().signal)).toMatchObject({
        available: false,
      });
      await expect(
        credentials.withCredential(
          judgeSecretRef("judge-key"),
          { purpose: JUDGE_DISCLOSURE_PURPOSE, destination: DESTINATION, grantRef: "g" },
          new AbortController().signal,
          async () => 1,
        ),
      ).rejects.toMatchObject({ code: "aliased-source" });
    }
    const host = { id: "local", spec: local.spec, deliversSecrets: true } as unknown as AgentHost;
    const agent = { id: "a", env: { K: { secret: "plain" } }, mcpServers: [] } as never;
    expect(() => planSessionSecrets(host, agent, aliased)).toThrow(OrcaError);
  });
});

describe("#701 every local host id is one realm: the daemon's environment", () => {
  const twoLocals = [
    { id: "local", type: "local" },
    { id: "local-2", type: "local" },
    { id: "box", type: "ssh" },
  ];

  it("finds an alias under another local host id, but not on a remote host", () => {
    const check = (secrets: SecretsConfig) =>
      validateSecretReferences({ secrets, hosts: twoLocals, agents: [] }).map((i) => i.path);
    expect(
      check({
        "judge-key": { host: "local", provider: "env", name: "JUDGE_KEY", destination: DESTINATION },
        plain: { host: "local-2", provider: "env", name: "JUDGE_KEY" },
      }),
    ).toEqual(["secrets.judge-key", "secrets.plain"]);
    expect(
      check({
        "judge-key": { host: "local", provider: "env", name: "JUDGE_KEY", destination: DESTINATION },
        remote: { host: "box", provider: "env", name: "JUDGE_KEY" },
      }),
    ).toEqual([]);
  });

  it("refuses a pin on a remote host", () => {
    const issues = validateSecretReferences({
      secrets: { k: { host: "box", provider: "env", name: "K", destination: DESTINATION } },
      hosts: twoLocals,
      agents: [],
    });
    expect(issues.map((i) => i.path)).toEqual(["secrets.k.host"]);
  });

  it("withholds a pinned variable from agents on every local host id, and not on a remote one", () => {
    const catalog: SecretsConfig = {
      "judge-key": { host: "local", provider: "env", name: "JUDGE_KEY", destination: DESTINATION },
    };
    const agent = { id: "a", env: {}, mcpServers: [] } as never;
    const on = (id: string, spec: HostSpec) =>
      planSessionSecrets({ id, spec, deliversSecrets: true } as unknown as AgentHost, agent, catalog).withheldEnv;
    expect(on("local-2", local.spec)).toContain("JUDGE_KEY");
    expect(on("box", remote.spec)).not.toContain("JUDGE_KEY");
  });
});

describe("#701 a pinned secret never reaches an agent or MCP server", () => {
  const catalog: SecretsConfig = {
    "judge-key": { host: "local", provider: "env", name: "JUDGE_KEY", destination: DESTINATION },
  };

  it("is a config error for an agent or MCP server to refer to it", () => {
    const issues = validateSecretReferences({
      secrets: catalog,
      hosts: [{ id: "local" }],
      agents: [
        {
          id: "a",
          hostId: "local",
          env: { K: { secret: "judge-key" } },
          mcpServers: [{ name: "m", env: { K: { secret: "judge-key" } } }],
        },
      ],
      capabilities: { mcpServers: { c: { env: { K: { secret: "judge-key" } } } } },
    });
    expect(issues.map((i) => i.path)).toEqual([
      "agents[0].env.K",
      "agents[0].mcpServers[0].env.K",
      "capabilities.mcpServers.c.env.K",
    ]);
    expect(issues[0]!.message).toContain("pinned to destination");
  });

  it("is refused at session open even if the config check was skipped", () => {
    const host = { id: "local", spec: local.spec, deliversSecrets: true } as unknown as AgentHost;
    const agent = { id: "a", env: { K: { secret: "judge-key" } }, mcpServers: [] } as never;
    let error: unknown;
    try {
      planSessionSecrets(host, agent, catalog);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OrcaError);
    expect((error as OrcaError).details).toMatchObject({ secret: "judge-key", reason: "unsupported" });
  });
});
