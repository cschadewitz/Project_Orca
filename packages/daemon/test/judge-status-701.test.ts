/**
 * #701 `judge.status`: where the plain-language rule judge's setup stands, for the app's setup
 * checklist. Read-only: no key, no value, no budget created. Grants are the caller's own,
 * re-read at each call.
 */
import { afterEach, describe, expect, it } from "vitest";
import { plainRuleDisclosureQuery } from "@orca/agents/review-judge";
import { JudgeStatusResultSchema, PROTOCOL_VERSION } from "@orca/protocol";
import { ReadModel, startDaemon, type JudgeBudgetInspection, type SecretsSource } from "@orca/daemon";
import type { AgentHost } from "@orca/agents";
import { HostSpecSchema } from "@orca/core";
import { CredentialStore, OwnershipStore, UNRESTRICTED, orchestratorResolver } from "../src/auth/index.js";
import { judgeKeyStatus, judgeStatus } from "../src/judge-status.js";
import { emptyFixture } from "./fixture.js";

const destination = "https://judge.invalid/v1/messages";
const judge = { provider: { kind: "anthropic" }, destination, credential: "judge-key" };
const ready: JudgeBudgetInspection = {
  status: "eligible",
  storeDir: "/s",
  anchorDir: "/a",
  anchorCreated: true,
  budget: { state: "ready", day: "2026-11-24", initializedDay: "2026-11-24", firstDaySpent: true },
};

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("#701 judge.status model", () => {
  it("reports no judge, an invalid one, and a configured one without its key", () => {
    const budget = ready;
    expect(judgeStatus({ config: {}, auth: { mode: "loopback" }, budget, key: "present" })).toMatchObject({
      active: false,
      config: { state: "none" },
      auth: "loopback",
      grants: [],
    });
    const invalid = { review: { plainRules: { judge: { ...judge, destination: "http://plain.invalid" } } } };
    expect(judgeStatus({ config: invalid, auth: { mode: "loopback" }, budget, key: "present" }).config).toEqual({
      state: "invalid",
    });
    const status = judgeStatus({
      config: { review: { plainRules: { judge } } },
      auth: { mode: "loopback" },
      budget,
      key: "present",
    });
    expect(status.config).toEqual({
      state: "configured",
      provider: "anthropic",
      destination,
      credential: "judge-key",
      key: "present",
    });
    expect(JSON.stringify(status)).not.toContain("JUDGE_KEY");
    expect(JudgeStatusResultSchema.parse(status)).toEqual(status);
  });

  it("marks each kind enabled by its switch and granted by the caller's own credentials", async () => {
    const credentials = new CredentialStore();
    await credentials.issue({
      principal: "casey",
      preset: "owner",
      disclosures: [plainRuleDisclosureQuery(judge)!, plainRuleDisclosureQuery(judge, "mcp")!],
    });
    const config = { review: { plainRules: { judge, experimental: { kinds: { mcpCalls: true, edits: true } } } } };
    const status = judgeStatus({
      config,
      auth: { mode: "token", principal: "casey", principals: credentials.currentForPrincipal("casey") },
      budget: ready,
      key: "present",
    });
    expect(status.grants).toEqual([
      { kind: "reads", enabled: true, granted: true },
      { kind: "edits", enabled: true, granted: false },
      { kind: "mcpCalls", enabled: true, granted: true },
      { kind: "commands", enabled: false, granted: false },
    ]);
    // A grant for another destination is no grant for this one.
    const moved = { review: { plainRules: { judge: { ...judge, destination: "https://other.invalid/v1/messages" } } } };
    expect(
      judgeStatus({
        config: moved,
        auth: { mode: "token", principal: "casey", principals: credentials.currentForPrincipal("casey") },
        budget: ready,
        key: "present",
      }).grants[0],
    ).toEqual({ kind: "reads", enabled: true, granted: false });
  });

  it("names the budget's state, never its paths", () => {
    const at = (budget: JudgeBudgetInspection) =>
      judgeStatus({ config: {}, auth: { mode: "loopback" }, budget, key: "present" }).budget;
    expect(at({ status: "unavailable", reason: "platform" })).toEqual({ state: "unsupported", reason: "platform" });
    expect(at({ ...ready, budget: { state: "uninitialized" } })).toEqual({
      state: "uninitialized",
    });
    expect(at({ ...ready, budget: { state: "refused", reason: "anchor" } })).toEqual({
      state: "refused",
    });
    expect(at(ready)).toEqual({ state: "ready", firstDaySpent: true });
    expect(JSON.stringify(at(ready))).not.toContain("/s");
  });
});

describe("#701 judge key: usable, then present", () => {
  const local = [{ id: "local", type: "local" as const }];
  const with_ = (secrets: object, hosts: object[] = local) =>
    ({ review: { plainRules: { judge } }, secrets, hosts }) as never;
  const pinned = { host: "local", provider: "env", name: "JUDGE_KEY", destination };

  it("checks a usable environment key is set and non-empty, without keeping it", async () => {
    const config = with_({ "judge-key": pinned });
    expect(await judgeKeyStatus(config, { JUDGE_KEY: "sk-test" })).toBe("present");
    expect(await judgeKeyStatus(config, { JUDGE_KEY: "" })).toBe("missing");
    expect(await judgeKeyStatus(config, {})).toBe("missing");
  });

  it("does not call a set key usable when the runtime would refuse it", async () => {
    const env = { JUDGE_KEY: "sk-test" };
    // Not pinned, or pinned elsewhere.
    const { destination: _d, ...unpinned } = pinned;
    expect(await judgeKeyStatus(with_({ "judge-key": unpinned }), env)).toBe("destination-mismatch");
    expect(
      await judgeKeyStatus(
        with_({ "judge-key": { ...pinned, destination: "https://other.invalid/v1/messages" } }),
        env,
      ),
    ).toBe("destination-mismatch");
    // A file, another host, or a source another pinned reference shares.
    expect(
      await judgeKeyStatus(with_({ "judge-key": { host: "local", provider: "file", path: "/k", destination } }), env),
    ).toBe("unusable");
    const remote = with_({ "judge-key": { ...pinned, host: "box" } }, [
      ...local,
      { id: "box", type: "ssh", host: "box.invalid" },
    ]);
    expect(await judgeKeyStatus(remote, env)).toBe("unusable");
    // The same variable also delivered elsewhere, unpinned: the runtime refuses the shared source.
    const { destination: _p, ...plain } = pinned;
    expect(await judgeKeyStatus(with_({ "judge-key": pinned, alias: plain }), env)).toBe("unusable");
    expect(await judgeKeyStatus(with_({}), env)).toBe("not-found");
  });
});

describe("#701 judge.status over RPC", () => {
  const secrets = {
    "judge-key": { host: "local", provider: "env" as const, name: "JUDGE_STATUS_TEST_KEY", destination },
  };
  const hosts = [HostSpecSchema.parse({ id: "local", type: "local" })];
  async function setup(onBudget: () => Promise<void> | void = () => undefined) {
    const { orchestrator: orc } = emptyFixture();
    const credentials = new CredentialStore();
    const owner = await credentials.issue({
      principal: "casey",
      preset: "owner",
      disclosures: [plainRuleDisclosureQuery(judge)!],
    });
    const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
    // Reads config, but holds no grant for the judge's key reference.
    const reader = await credentials.issue({
      principal: "reader",
      permissions: ["config.read", "secrets.read"],
      scope: UNRESTRICTED,
    });
    let budgetReads = 0;
    const daemon = await startDaemon({
      capabilities: ["runs.read"],
      orcaVersion: "test",
      reads: new ReadModel({ orchestrator: orc }),
      source: orc,
      secretsSource: (): SecretsSource => ({
        secrets: () => secrets,
        hasHost: (id) => id === "local",
        host: () => ({ id: "local", spec: hosts[0] }) as unknown as AgentHost,
      }),
      judgeStatusSource: {
        config: () => ({ review: { plainRules: { judge } }, secrets, hosts }),
        budget: async () => {
          budgetReads++;
          await onBudget();
          return ready;
        },
      },
      auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver: orchestratorResolver(orc) },
    });
    closers.push(() => daemon.close());
    const call = async (token: string, method: string, params: unknown = {}) => {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
      });
      return (await response.json()) as { ok: boolean; result?: unknown; error?: { code: string } };
    };
    return { credentials, owner, viewer, reader, call, budgetReads: () => budgetReads };
  }

  it("answers an owner with its own grants and the key, and refuses a caller without config.read", async () => {
    process.env.JUDGE_STATUS_TEST_KEY = "sk-test";
    closers.push(() => void delete process.env.JUDGE_STATUS_TEST_KEY);
    const { owner, viewer, call } = await setup();
    const hello = (await call(owner.token, "hello", { client: "test", protocol: PROTOCOL_VERSION })) as {
      result: { methods: string[] };
    };
    expect(hello.result.methods).toContain("judge.status");
    const status = JudgeStatusResultSchema.parse((await call(owner.token, "judge.status")).result);
    expect(status).toMatchObject({
      auth: "token",
      principal: "casey",
      config: { state: "configured", key: "present" },
      budget: { state: "ready" },
    });
    expect(status.grants[0]).toEqual({ kind: "reads", enabled: true, granted: true });
    expect(await call(viewer.token, "judge.status")).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
    expect(await call(owner.token, "judge.status", { extra: 1 })).toMatchObject({ ok: false });
  });

  it("withholds the key from a config reader whose secrets grant does not name it, without probing", async () => {
    const { reader, call } = await setup();
    const status = JudgeStatusResultSchema.parse((await call(reader.token, "judge.status")).result);
    expect(status.config).toMatchObject({ state: "configured", key: "withheld" });
    expect(status.grants.every((g) => !g.granted)).toBe(true);
  });

  it("refuses a caller revoked while the status was being read, and one revoked before", async () => {
    const during: { revoke?: () => Promise<unknown> } = {};
    const made = await setup(async () => {
      await during.revoke?.();
    });
    during.revoke = () => made.credentials.revoke(made.owner.credential.id);
    expect(await made.call(made.owner.token, "judge.status")).toMatchObject({ ok: false });
    const reads = made.budgetReads();
    expect(await made.call(made.owner.token, "judge.status")).toMatchObject({ ok: false });
    expect(made.budgetReads()).toBe(reads);
  });
});
