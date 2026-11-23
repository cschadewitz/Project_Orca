/**
 * #701: the owner-authoritative source of plain-rule judge disclosure grants. A grant is an explicit
 * entry on one of the run's root owner's current credentials, naming exactly the query a prepared
 * judge asks for; revoking, expiring or reissuing without it stops the next send.
 */
import { describe, expect, it } from "vitest";
import { plainRuleDisclosureQuery, type PlainRuleDisclosureQuery } from "@orca/agents";
import { CredentialStore } from "../src/auth/credentials.js";
import { DisclosureGrantSchema, PRESETS } from "../src/auth/principal.js";
import { bindJudgeDisclosure, NO_EXPIRY } from "../src/auth/judge-disclosure.js";
import type { AuditRecord } from "../src/auth/audit.js";

const config = {
  provider: { kind: "anthropic" },
  destination: "https://judge.invalid/v1/messages",
  credential: "judge-key",
};
const query = plainRuleDisclosureQuery(config)!;
const signal = new AbortController().signal;

function setup(opts: { owner?: string; workflowId?: string } = {}) {
  let clock = Date.parse("2026-11-23T10:00:00Z");
  const store = new CredentialStore({ now: () => new Date(clock) });
  const audit: AuditRecord[] = [];
  const bind = (runId = "run-1") =>
    bindJudgeDisclosure(
      {
        root: async (id) => ({ rootRunId: id, workflowId: opts.workflowId ?? "w" }),
        owner: () => opts.owner ?? "casey",
        verifyOwner: async () => {},
        principals: (id) => store.currentForPrincipal(id),
        audit: { record: (r) => void audit.push(r) },
      },
      runId,
    );
  return { store, audit, bind, advance: (ms: number) => (clock += ms) };
}

const issue = (store: CredentialStore, extra: Record<string, unknown> = {}) =>
  store.issue({ principal: "casey", preset: "owner", disclosures: [query], ...extra });

describe("#701 judge disclosure grants", () => {
  it("derives the query from the judge config, as preparation asks it", () => {
    expect(query).toMatchObject({
      purpose: "review-judge",
      destination: config.destination,
      requestSchema: "orca-plain-rule-request/v1",
    });
    expect(query.providerVersion).toMatch(/^plain-rule-provider\/v1:sha256:[0-9a-f]{64}$/);
    // A different provider or model is a different disclosure.
    const other = plainRuleDisclosureQuery({ ...config, provider: { kind: "openai-compatible", model: "m" } })!;
    expect(other.providerVersion).not.toBe(query.providerVersion);
    expect(plainRuleDisclosureQuery({ ...config, provider: { kind: "nope" } })).toBeUndefined();
    expect(plainRuleDisclosureQuery({})).toBeUndefined();
  });

  it("only an explicit, exact entry is a grant: no wildcard, and no preset includes one", () => {
    expect(DisclosureGrantSchema.safeParse("*").success).toBe(false);
    expect(DisclosureGrantSchema.safeParse([{ ...query, extra: 1 }]).success).toBe(false);
    expect(DisclosureGrantSchema.safeParse([{ ...query, providerVersion: "v1" }]).success).toBe(false);
    for (const preset of Object.values(PRESETS)) expect(preset).not.toHaveProperty("disclosures");
  });

  it("finds a current grant of the run's root owner, and nothing for another query", async () => {
    const { store, bind, audit } = setup();
    await store.issue({ principal: "casey", preset: "owner" });
    const none = await bind();
    expect(await none.find(query, signal)).toBeNull();
    expect(audit.at(-1)).toMatchObject({ event: "judge.disclosure", outcome: "denied" });

    await issue(store);
    const service = await bind();
    const grant = await service.find(query, signal);
    expect(grant).toMatchObject({ ...query, expiresAt: NO_EXPIRY });
    expect(grant!.grantRef).toMatch(/^disclosure:[0-9a-f]{32}$/);
    expect(audit.at(-1)).toMatchObject({
      event: "judge.disclosure",
      outcome: "succeeded",
      actor: { principal: "casey" },
    });
    for (const changed of [
      { ...query, destination: "https://other.invalid/v1/messages" },
      { ...query, providerVersion: `plain-rule-provider/v1:sha256:${"0".repeat(64)}` },
      { ...query, requestSchema: "other" },
      { ...query, purpose: "agent" },
    ])
      expect(await service.find(changed as PlainRuleDisclosureQuery, signal)).toBeNull();
    expect(service.currentNow(grant!.grantRef)).toEqual({ revision: grant!.revision, expiresAt: NO_EXPIRY });
    expect(await service.current(grant!.grantRef, signal)).toEqual(service.currentNow(grant!.grantRef));
  });

  it("stops at once when the credential is revoked, expires, or is reissued without the entry", async () => {
    const { store, bind, advance } = setup();
    const { credential } = await issue(store);
    const service = await bind();
    const grant = (await service.find(query, signal))!;
    await store.revoke(credential.id);
    expect(service.currentNow(grant.grantRef)).toBeNull();
    expect(await service.current(grant.grantRef, signal)).toBeNull();

    const timed = await issue(store, { ttlMs: 60_000 });
    const g2 = (await service.find(query, signal))!;
    expect(g2.expiresAt).toBe(timed.credential.expiresAt);
    advance(60_000);
    expect(service.currentNow(g2.grantRef)).toBeNull();

    await store.issue({ principal: "casey", preset: "owner" });
    expect(await service.find(query, signal)).toBeNull();
  });

  it("a rotated credential is a new grant: the old reference stops, a new find covers it", async () => {
    const { store, bind } = setup();
    const { credential } = await issue(store);
    const service = await bind();
    const before = (await service.find(query, signal))!;
    await store.rotate(credential.id);
    expect(service.currentNow(before.grantRef)).toBeNull();
    const after = (await service.find(query, signal))!;
    expect(after.grantRef).not.toBe(before.grantRef);
  });

  it("counts only the owner's credentials whose workflow scope includes the run's root workflow", async () => {
    const { store, bind } = setup({ workflowId: "release::step" });
    await store.issue({
      principal: "casey",
      permissions: ["runs.read"],
      scope: { workflows: ["other"], runs: "owned" },
      disclosures: [query],
    });
    expect(await (await bind()).find(query, signal)).toBeNull();
    await store.issue({
      principal: "casey",
      permissions: ["runs.read"],
      scope: { workflows: ["release"], runs: "owned" },
      disclosures: [query],
    });
    expect(await (await bind()).find(query, signal)).not.toBeNull();
    // Another principal's grant never counts.
    const { store: s2, bind: b2 } = setup({ owner: "someone-else" });
    await issue(s2);
    expect(await (await b2()).find(query, signal)).toBeNull();
  });

  it("refuses to bind without a run root or a durable owner", async () => {
    const base = {
      root: async (id: string) => ({ rootRunId: id, workflowId: "w" }),
      owner: () => "casey",
      verifyOwner: async () => {},
      principals: () => [],
    };
    await expect(bindJudgeDisclosure({ ...base, root: async () => undefined }, "r")).rejects.toThrow(/not granted/);
    await expect(bindJudgeDisclosure({ ...base, owner: () => undefined }, "r")).rejects.toThrow(/not granted/);
    await expect(
      bindJudgeDisclosure(
        {
          ...base,
          verifyOwner: async () => {
            throw new Error("pending");
          },
        },
        "r",
      ),
    ).rejects.toThrow(/not granted/);
  });

  it("carries the grant through rotation and keeps it in the credentials file", async () => {
    const { store } = setup();
    const { credential } = await issue(store);
    expect(credential.disclosures).toEqual([query]);
    const rotated = await store.rotate(credential.id);
    expect(rotated.credential.disclosures).toEqual([query]);
  });
});
