/**
 * `search` (#255) against a fixture store: what it matches, what a hit carries, how it stops,
 * and what a caller who may not see a run or read artifacts gets back - once through the
 * read model and once over `dispatch`, the way a client reaches it.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import { SearchResultSchema, READ_METHODS, SEARCH_METHOD, type SearchParams, type SearchResult } from "@orca/protocol";
import { ReadModel, dispatch, methods, type MethodContext } from "@orca/daemon";
import { eventText, excerpt, searchStore } from "../src/search-model.js";
import {
  Authorizer,
  MemoryAuditSink,
  OwnershipStore,
  bindPrincipal,
  orchestratorResolver,
  type Principal,
  type ResourceResolver,
} from "../src/auth/index.js";
import { artifactFixture, STEP_MS, type Fixture } from "./fixture.js";

let f: Fixture;
let reads: ReadModel;

const params = (query: string, more: Partial<SearchParams> = {}): SearchParams => ({ query, limit: 20, ...more });

beforeAll(async () => {
  f = await artifactFixture();
  const append = async (e: Parameters<typeof f.stores.events.append>[0]) => {
    f.clock.advance(STEP_MS);
    await f.stores.events.append(e);
  };
  // The second attempt at `spec` failed with words worth finding; its stepRunId is an id, not text.
  await append({
    type: "step.failed",
    runId: "run-art",
    payload: {
      stepRunId: "s-spec-2",
      error: { code: "AGENT", message: "Upstream refused the Connection" },
      willRetry: true,
    },
  });
  // A newer run, with a secret among its launch inputs and an artifact that quotes it.
  await append({
    type: "run.created",
    runId: "run-new",
    payload: { workflowId: "sdlc", workflowVersion: "2", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
  });
  await append({
    type: "run.failed",
    runId: "run-new",
    payload: { error: { code: "X", message: "connection reset" } },
  });
  await f.stores.execution.putInputs({
    runId: "run-new",
    workflowId: "sdlc",
    workflowVersion: "2",
    vars: {},
    sensitiveNames: ["token"],
    secrets: ["hunter2-secret"],
  });
  await f.stores.artifacts.put(
    {
      id: "art-notes",
      kind: "notes",
      name: "notes",
      path: "/w/notes.md",
      mediaType: "text/markdown",
      contentHash: "sha256:notes",
      size: 64,
      version: 1,
      producedBy: { runId: "run-new", stepRunId: "s-n", agentId: "claude" },
      parents: [],
      data: {},
      createdAt: f.clock.isoNow(),
    },
    "Deploy notes: the token is hunter2-secret, and the connection is pooled.\n",
  );
  reads = new ReadModel({ orchestrator: f.orchestrator });
});

describe("search over the store", () => {
  it("matches event text case-insensitively, newest run first, and places each hit", async () => {
    const r = SearchResultSchema.parse(await reads.search(params("CONNECTION", { kinds: ["event"] })));
    expect(r.truncated).toBeUndefined();
    expect(r.hits.map((h) => [h.runId, h.kind])).toEqual([
      ["run-new", "event"],
      ["run-art", "event"],
    ]);
    const failed = r.hits[1]!;
    expect(failed).toMatchObject({ kind: "event", type: "step.failed", step: { nodeId: "spec", attempt: 2 } });
    expect(failed.excerpt).toContain("Upstream refused the Connection");
    expect(r.hits[0]).not.toHaveProperty("step");
  });

  it("matches text artifacts by content, never binary ones, and redacts before matching", async () => {
    const spec = await reads.search(params("spec v2", { kinds: ["artifact"] }));
    expect(spec.hits).toEqual([
      expect.objectContaining({
        kind: "artifact",
        runId: "run-art",
        artifactId: "art-spec-v2",
        name: "spec",
        version: 2,
      }),
    ]);
    expect((await reads.search(params("PNG", { kinds: ["artifact"] }))).hits).toEqual([]);
    // The secret is not findable, and the excerpt of another match does not show it.
    expect((await reads.search(params("hunter2"))).hits).toEqual([]);
    const pooled = await reads.search(params("pooled", { kinds: ["artifact"] }));
    expect(pooled.hits).toHaveLength(1);
    expect(pooled.hits[0]!.excerpt).not.toContain("hunter2");
  });

  it("does not match identifiers", async () => {
    expect((await reads.search(params("s-spec-2"))).hits).toEqual([]);
    expect(eventText({ stepRunId: "x", artifactIds: ["y"], error: { message: "z" } })).toBe("z");
  });

  it("scopes to one run", async () => {
    const r = await reads.search(params("connection", { runId: "run-art" }));
    expect(new Set(r.hits.map((h) => h.runId))).toEqual(new Set(["run-art"]));
    expect(r.scannedRuns).toBe(1);
  });

  it("stops at the limit and says so", async () => {
    const r = await reads.search(params("connection", { limit: 1 }));
    expect(r.hits).toHaveLength(1);
    expect(r.truncated).toBe("limit");
  });

  it("stops at the deadline and keeps what it found", async () => {
    let t = 0;
    const r = await searchStore(
      {
        orc: f.orchestrator,
        isoNow: () => f.asOf,
        publicName: async (a) => a.name,
        artifactText: (a) => f.stores.artifacts.content(a.id),
        // Each look at the clock is a second later: the first run read is past a 1.5 s deadline.
        now: () => (t += 1000),
        deadlineMs: 1500,
      },
      params("connection"),
    );
    expect(r.truncated).toBe("deadline");
    expect(r.scannedRuns).toBeLessThanOrEqual(1);
  });

  it("reads only what the caller's scope allows", async () => {
    const r = await reads.search(params("connection", { runId: "run-art" }), { runs: "named", artifacts: false });
    expect(new Set(r.hits.map((h) => h.runId))).toEqual(new Set(["run-art"]));
    expect(r.hits.every((h) => h.kind === "event")).toBe(true);
    // A caller limited to some runs never walks the store, even if a guard forgot to stop it.
    await expect(reads.search(params("connection"), { runs: "named", artifacts: true })).rejects.toThrow(/named run/);
    // Without artifacts.read, an artifact's body is never read for a match.
    expect((await reads.search(params("spec v2"), { runs: "all", artifacts: false })).hits).toEqual([]);
  });

  it("never opens an artifact body that artifacts.get would withhold", async () => {
    // A protected store refuses a legacy-sensitive run's first-event read with RUN_STATE.
    const readRange = f.stores.events.readRange.bind(f.stores.events);
    const gate = vi.spyOn(f.stores.events, "readRange").mockImplementation(async (runId, range) => {
      if (runId === "run-new" && range?.limit === 1 && !range.match)
        throw new OrcaError("RUN_STATE", "legacy sensitive execution requires explicit migration");
      return readRange(runId, range);
    });
    const body = vi.spyOn(f.stores.artifacts, "content");
    try {
      const r = await reads.search(params("pooled", { kinds: ["artifact"] }));
      expect(r.hits).toEqual([]);
      await expect(reads.artifactsGet({ artifactId: "art-notes", maxBytes: 256_000 })).rejects.toMatchObject({
        code: "RUN_STATE",
      });
      expect(body.mock.calls.map(([id]) => id)).not.toContain("art-notes");
    } finally {
      gate.mockRestore();
      body.mockRestore();
    }
    // Readable again, the same artifact is found: the refusal, not the search, hid it.
    expect((await reads.search(params("pooled", { kinds: ["artifact"] }))).hits).toHaveLength(1);
  });

  it("cuts a long excerpt around the match on one line", () => {
    const text = `${"a".repeat(200)}\nNEEDLE\n${"b".repeat(200)}`;
    const cut = excerpt(text, text.indexOf("NEEDLE"), 6);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toContain(" NEEDLE ");
    expect(cut.length).toBeLessThan(200);
  });
});

describe("search over dispatch", () => {
  const ctx = (): MethodContext => ({ orcaVersion: "search-test", capabilities: ["runs.read"], reads });
  const call = (p: unknown) =>
    dispatch(JSON.stringify({ kind: "request", id: 1, method: SEARCH_METHOD, params: p }), methods, ctx());

  it("is a read method a read-only daemon answers", () => {
    expect(READ_METHODS).toContain(SEARCH_METHOD);
  });

  it("answers within the schema and refuses a query too short to scan", async () => {
    const ok = await call({ query: "  connection " });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(SearchResultSchema.parse(ok.result).hits.length).toBeGreaterThan(0);
    const short = await call({ query: " c " });
    expect(short.ok).toBe(false);
  });
});

describe("search through the guard", () => {
  const resolver: ResourceResolver = {
    run: async (runId) =>
      runId === "run-art" ? { workflowId: "gated" } : runId === "run-new" ? { workflowId: "secret" } : undefined,
    inputRun: async () => undefined,
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: (id) => ["gated", "secret"].includes(id),
  };
  const meta = { transport: "http" as const };
  const who = (permissions: readonly string[], workflows: "*" | string[]): Principal => ({
    id: "p",
    kind: "credential",
    credentialId: "cred-p",
    permissions: new Set(permissions) as never,
    scope: { workflows, runs: "all" },
  });
  const guarded = () =>
    new Authorizer({ resolver, ownership: new OwnershipStore(), audit: new MemoryAuditSink() }).guard({
      [SEARCH_METHOD]: methods[SEARCH_METHOD]!,
    });
  const ask = (p: Principal, query: Record<string, unknown>) =>
    guarded()[SEARCH_METHOD]!.handle(
      { limit: 20, ...query },
      bindPrincipal({ orcaVersion: "t", capabilities: ["runs.read"], reads }, p, meta),
    ) as Promise<SearchResult>;

  it("refuses a restricted caller's search across the store without reading any run", async () => {
    const opened = vi.spyOn(f.orchestrator, "eventsRange");
    const facts = vi.spyOn(resolver, "run");
    await expect(ask(who(["runs.read"], ["gated"]), { query: "connection" })).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
    expect(opened).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
    opened.mockRestore();
    facts.mockRestore();
  });

  it("searches a restricted caller's named run alone, and reads no artifact without artifacts.read", async () => {
    const opened = vi.spyOn(f.orchestrator, "eventsRange");
    const facts = vi.spyOn(resolver, "run");
    const listed = vi.spyOn(f.stores.artifacts, "list");
    const r = await ask(who(["runs.read"], ["gated"]), { query: "connection", runId: "run-art" });
    expect(opened.mock.calls.map((c) => c[0])).toEqual(["run-art"]);
    expect(facts.mock.calls.map((c) => c[0])).toEqual(["run-art"]);
    expect(listed).not.toHaveBeenCalled();
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.runId === "run-art" && h.kind === "event")).toBe(true);
    opened.mockRestore();
    facts.mockRestore();
    listed.mockRestore();
  });

  it("answers a hidden named run as one with no matches", async () => {
    expect(
      await ask(who(["runs.read", "artifacts.read"], ["gated"]), { query: "connection", runId: "run-new" }),
    ).toMatchObject({ hits: [], scannedRuns: 0 });
  });

  it("shows artifact hits to a caller with artifacts.read", async () => {
    const r = await ask(who(["runs.read", "artifacts.read"], "*"), { query: "pooled" });
    expect(r.hits).toEqual([expect.objectContaining({ kind: "artifact", runId: "run-new", name: "notes" })]);
  });

  it("refuses a caller without runs.read", async () => {
    await expect(ask(who(["artifacts.read"], "*"), { query: "connection" })).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
  });
});

// Last, because it adds a run to the shared store.
describe("search through the guard with the production resolver", () => {
  const meta = { transport: "http" as const };
  const restricted: Principal = {
    id: "p",
    kind: "credential",
    credentialId: "cred-p",
    permissions: new Set(["runs.read", "artifacts.read"]) as never,
    scope: { workflows: ["sdlc"], runs: "all" },
  };
  const ask = (query: Record<string, unknown>, principal: Principal = restricted) =>
    new Authorizer({
      resolver: orchestratorResolver(f.orchestrator),
      ownership: new OwnershipStore(),
      audit: new MemoryAuditSink(),
    })
      .guard({ [SEARCH_METHOD]: methods[SEARCH_METHOD]! })
      [SEARCH_METHOD]!.handle(
        { limit: 20, ...query },
        bindPrincipal({ orcaVersion: "t", capabilities: ["runs.read"], reads }, principal, meta),
      ) as Promise<SearchResult>;
  const stable = ({ asOf: _asOf, ...rest }: SearchResult) => rest;

  it("gives a restricted caller the same answer and progress whatever hidden runs hold", async () => {
    const before = await ask({ query: "connection", runId: "run-art" });
    expect(before.hits.length).toBeGreaterThan(0);

    // Unrelated hidden work, full of matches, newer than everything the caller can see.
    await f.stores.events.append({
      type: "run.created",
      runId: "run-hidden",
      payload: { workflowId: "ops", workflowVersion: "1", workspace: { hostId: "local", cwd: "/h" }, vars: {} },
    });
    for (let i = 0; i < 50; i++)
      await f.stores.events.append({
        type: "run.failed",
        runId: "run-hidden",
        payload: { error: { code: "X", message: `hidden connection ${i}` } },
      });

    const opened = vi.spyOn(f.orchestrator, "eventsRange");
    const after = await ask({ query: "connection", runId: "run-art" });
    expect(opened.mock.calls.map((c) => c[0])).not.toContain("run-hidden");
    opened.mockRestore();
    expect(stable(after)).toEqual(stable(before));

    // Named, the hidden run answers as one with no matches.
    expect(await ask({ query: "connection", runId: "run-hidden" })).toMatchObject({ hits: [], scannedRuns: 0 });
    // An unrestricted caller still searches the whole store, newest first.
    const everyone = await ask({ query: "connection" }, { ...restricted, scope: { workflows: "*", runs: "all" } });
    expect(everyone.hits[0]?.runId).toBe("run-hidden");
  });
});
