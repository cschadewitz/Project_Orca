/**
 * The reusable store conformance suite (#338): every guarantee of the seven store seams that
 * `docs/contracts/store-contracts-v1.md` promises, run against one backend. Call
 * `runStoreConformance(backend)` from a test file; `store-conformance.test.ts` runs it for the
 * memory and file backends.
 *
 * A capability the backend's matrix marks unsupported is tested too: the gate must say
 * `NOT_SUPPORTED` rather than hand back something weaker. Some cases pin guarantees that
 * shipped earlier (gap-free append ordering #97, single-writer leases and fencing #101/#267,
 * document lost-update protection #196/#197); they are here so a new backend inherits them,
 * not because this suite introduced them.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isOrcaError,
  parseWorkflow,
  PlanSchema,
  sha256,
  type Artifact,
  type OrcaEventInput,
  type WorkflowDefinition,
} from "@orca/core";
import {
  asVersionedDocumentStore,
  FileArtifactStore,
  queryDocuments,
  requireStoreCapability,
  runUnitOfWork,
  STORE_CAPABILITIES,
  STORE_CONTRACT_VERSIONS,
  STORE_SEAMS,
  type DocumentStore,
  type WorkItemClaim,
} from "@orca/store";
import type { BackendInstance, ConformanceBackend } from "./backend.js";

const DocSchema = z.object({
  id: z.string(),
  owner: z.string(),
  n: z.number(),
  /** Filled on parse: a write without it and the read after it must still agree on the version. */
  tags: z.array(z.string()).default([]),
});
type Doc = z.infer<typeof DocSchema>;
const doc = (id: string, owner = "a", n = 0): Doc => ({ id, owner, n, tags: [] });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const runCreated = (runId: string): OrcaEventInput => ({
  type: "run.created",
  runId,
  payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
});

const artifact = (id: string, content: string | Uint8Array, over: Partial<Artifact> = {}): Artifact => ({
  id,
  kind: "spec",
  name: id,
  mediaType: "text/plain",
  contentHash: sha256(content),
  size: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength,
  version: 1,
  producedBy: { runId: "run_1" },
  parents: [],
  data: {},
  createdAt: "t",
  ...over,
});

const claim = (workItemId: string, runId: string, branch = "b"): WorkItemClaim => ({
  workItemId,
  runId,
  branch,
  at: "2026-01-01T00:00:00.000Z",
});

const workflow = (version: string, name = "flow"): WorkflowDefinition =>
  parseWorkflow(`
id: flow
name: ${name}
version: "${version}"
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges: [{ from: s, to: e }]
`);

const plan = PlanSchema.parse({ id: "plan_1", key: "p", name: "P", createdAt: "t", updatedAt: "t" });

export function runStoreConformance(backend: ConformanceBackend): void {
  const caps = backend.capabilities.capabilities;
  const open: BackendInstance[] = [];
  const create = async () => {
    const instance = await backend.create();
    open.push(instance);
    return instance;
  };

  describe(`store conformance: ${backend.name}`, () => {
    afterEach(async () => {
      for (const instance of open.splice(0)) await instance.dispose();
    });

    // ------------------------------------------------------------ capabilities
    describe("capability matrix", () => {
      it("declares a contract version for every seam and a value for every capability", () => {
        expect(Object.keys(backend.capabilities.contracts).sort()).toEqual([...STORE_SEAMS].sort());
        expect(backend.capabilities.contracts).toEqual(STORE_CONTRACT_VERSIONS);
        expect(Object.keys(backend.capabilities.capabilities).sort()).toEqual([...STORE_CAPABILITIES].sort());
      });

      it("the stores it opens carry the same matrix", async () => {
        const b = await create();
        expect(b.stores().capabilities).toEqual(backend.capabilities);
      });

      it("refuses every unsupported capability explicitly", () => {
        for (const capability of STORE_CAPABILITIES) {
          if (caps[capability]) expect(() => requireStoreCapability(backend.capabilities, capability)).not.toThrow();
          else {
            let error: unknown;
            try {
              requireStoreCapability(backend.capabilities, capability);
            } catch (e) {
              error = e;
            }
            expect(isOrcaError(error, "NOT_SUPPORTED")).toBe(true);
            expect((error as { details?: unknown }).details).toEqual({ capability, backend: backend.name });
          }
        }
      });

      it("the optional event-store methods exist exactly when the matrix says so", async () => {
        const events = (await create()).stores().events;
        expect(typeof events.appendDurableUnique === "function").toBe(caps["event.durableUnique"]);
        expect(typeof events.readObservation === "function").toBe(caps["event.observation"]);
      });
    });

    // ------------------------------------------------------------ unit of work
    describe("metadata unit of work", () => {
      if (caps["metadata.unitOfWork"]) {
        it("commits every collection together, or none when the work throws", async () => {
          const stores = (await create()).stores();
          const failure = new Error("abort");
          await expect(
            runUnitOfWork(stores, async (tx) => {
              await tx.plans.put(plan);
              await tx.decisions.put({ ...plan, id: "d" } as never);
              throw failure;
            }),
          ).rejects.toBe(failure);
          expect(await stores.plan.plans.get(plan.id)).toBeUndefined();
          await runUnitOfWork(stores, async (tx) => tx.plans.put(plan));
          expect(await stores.plan.plans.get(plan.id)).toEqual(plan);
        });
      } else {
        it("is refused with NOT_SUPPORTED rather than run without atomicity", async () => {
          const stores = (await create()).stores();
          let ran = false;
          const error = await rejection(
            runUnitOfWork(stores, async () => {
              ran = true;
            }),
          );
          expect(ran).toBe(false);
          expect(isOrcaError(error, "NOT_SUPPORTED")).toBe(true);
          expect((error as { details?: unknown }).details).toEqual({
            capability: "metadata.unitOfWork",
            backend: backend.name,
          });
        });
      }
    });

    // --------------------------------------------------------------- documents
    describe("document seam", () => {
      const collection = async () => {
        const b = await create();
        return { b, a: b.collection("docs", DocSchema), other: () => b.collection("docs", DocSchema) };
      };

      it("creates, reads, replaces, lists and deletes", async () => {
        const { a } = await collection();
        expect(await a.get("x")).toBeUndefined();
        await a.put(doc("x", "a", 1));
        await a.put(doc("y", "b", 2));
        expect(await a.get("x")).toEqual(doc("x", "a", 1));
        await a.put(doc("x", "a", 3));
        expect((await a.get("x"))?.n).toBe(3);
        expect((await a.list((d) => d.owner === "b")).map((d) => d.id)).toEqual(["y"]);
        await a.delete("x");
        await a.delete("never-existed");
        expect(await a.get("x")).toBeUndefined();
        expect((await a.list()).map((d) => d.id)).toEqual(["y"]);
      });

      it("an acknowledged write is visible through another handle", async () => {
        const { a, other } = await collection();
        await a.putMany([doc("p"), doc("q")]);
        expect((await other().list()).map((d) => d.id).sort()).toEqual(["p", "q"]);
      });

      if (caps["document.versioned"]) {
        it("versions follow content: stable across handles, new on change, blind to key order", async () => {
          const { a, other } = await collection();
          const v = asVersionedDocumentStore(a);
          await a.put(doc("x", "a", 1));
          const first = await v.getVersioned("x");
          expect(first?.version).toMatch(/\S/);
          expect((await asVersionedDocumentStore(other()).getVersioned("x"))?.version).toBe(first?.version);
          await a.put({ tags: [], n: 1, owner: "a", id: "x" });
          expect((await v.getVersioned("x"))?.version).toBe(first?.version);
          await a.put(doc("x", "a", 2));
          expect((await v.getVersioned("x"))?.version).not.toBe(first?.version);
          expect(await v.getVersioned("missing")).toBeUndefined();
          // A write that leaves a defaulted field out reports the version its next read will see.
          const written = await v.putIfVersion({ id: "y", owner: "a", n: 1 } as Doc, null);
          expect(written.ok && written.version).toBe(
            (await asVersionedDocumentStore(other()).getVersioned("y"))?.version,
          );
        });

        it("create-if-absent succeeds once; a second create sees the winner", async () => {
          const { a } = await collection();
          const v = asVersionedDocumentStore(a);
          const created = await v.putIfVersion(doc("x", "first"), null);
          expect(created).toEqual({ ok: true, version: expect.any(String) });
          const again = await v.putIfVersion(doc("x", "second"), null);
          expect(again.ok).toBe(false);
          if (!again.ok)
            expect(again.current).toEqual({
              doc: doc("x", "first"),
              version: (created as { version: string }).version,
            });
          expect((await a.get("x"))?.owner).toBe("first");
        });

        it("two concurrent compare-and-swaps on one version: exactly one succeeds", async () => {
          const { a, other } = await collection();
          await a.put(doc("x", "base"));
          const base = (await asVersionedDocumentStore(a).getVersioned("x"))!.version;
          const writers = [a, other(), other(), a].map(asVersionedDocumentStore);
          const results = await Promise.all(writers.map((w, i) => w.putIfVersion(doc("x", `w${i}`), base)));
          const winners = results.flatMap((r, i) => (r.ok ? [i] : []));
          expect(winners).toHaveLength(1);
          const stored = await other().get("x");
          expect(stored?.owner).toBe(`w${winners[0]}`);
          for (const r of results) if (!r.ok) expect(r.current?.doc).toEqual(stored);
        });

        it("a stale version cannot update or delete; the current one can", async () => {
          const { a } = await collection();
          const v = asVersionedDocumentStore(a);
          const v1 = await v.putIfVersion(doc("x", "a", 1), null);
          const v2 = await v.putIfVersion(doc("x", "a", 2), (v1 as { version: string }).version);
          expect(v2.ok).toBe(true);
          const staleUpdate = await v.putIfVersion(doc("x", "a", 9), (v1 as { version: string }).version);
          expect(staleUpdate.ok).toBe(false);
          const staleDelete = await v.deleteIfVersion("x", (v1 as { version: string }).version);
          expect(staleDelete.ok).toBe(false);
          expect((await a.get("x"))?.n).toBe(2);
          expect(await v.deleteIfVersion("x", (v2 as { version: string }).version)).toEqual({
            ok: true,
            version: undefined,
          });
          expect(await a.get("x")).toBeUndefined();
          // Deleting what is already gone is a conflict that reports absence, not an error.
          expect(await v.deleteIfVersion("x", (v2 as { version: string }).version)).toEqual({
            ok: false,
            current: undefined,
          });
        });

        it("a duplicate conditional request is detectable and a rebased retry succeeds", async () => {
          const { a } = await collection();
          const v = asVersionedDocumentStore(a);
          const base = (await v.putIfVersion(doc("x", "a", 1), null)) as { version: string };
          const write = doc("x", "a", 2);
          const applied = (await v.putIfVersion(write, base.version)) as { ok: true; version: string };
          // The same request delivered twice: it loses, and what it loses to is its own write.
          const duplicate = await v.putIfVersion(write, base.version);
          expect(duplicate.ok).toBe(false);
          if (!duplicate.ok) expect(duplicate.current?.version).toBe(applied.version);
          // A writer that lost rebases on the reported current version and retries.
          const lost = await v.putIfVersion(doc("x", "b", 3), base.version);
          expect(lost.ok).toBe(false);
          if (!lost.ok) expect((await v.putIfVersion(doc("x", "b", 3), lost.current!.version)).ok).toBe(true);
          expect((await a.get("x"))?.owner).toBe("b");
        });

        it("put, CAS and delete queued together on one handle resolve in call order", async () => {
          const { a, other } = await collection();
          const v = asVersionedDocumentStore(a);
          await a.putMany([doc("x", "a", 0), doc("y", "a", 0)]);
          const x0 = (await v.getVersioned("x"))!.version;
          const y0 = (await v.getVersioned("y"))!.version;
          const results = await Promise.all([
            a.put(doc("x", "a", 1)),
            v.putIfVersion(doc("x", "a", 2), x0),
            v.deleteIfVersion("y", y0),
            a.put(doc("y", "b", 5)),
            v.putIfVersion(doc("y", "c", 6), y0),
            a.delete("x"),
          ]);
          // The CAS on x expected x@0 but follows put(x@1) in call order, so it loses to it.
          expect(results[1]).toMatchObject({ ok: false, current: { doc: doc("x", "a", 1) } });
          expect(results[2]).toEqual({ ok: true, version: undefined });
          // y was deleted then re-put: the stale y0 no longer matches.
          expect(results[4]).toMatchObject({ ok: false, current: { doc: doc("y", "b", 5) } });
          const reader = asVersionedDocumentStore(other());
          expect(await reader.getVersioned("x")).toBeUndefined();
          expect((await reader.getVersioned("y"))?.doc).toEqual(doc("y", "b", 5));
        });

        it("unconditional writes from several handles are never lost (#196)", async () => {
          const { a, other } = await collection();
          const handles = [a, other(), other()];
          await Promise.all(
            Array.from({ length: 30 }, (_, i) => handles[i % 3]!.put(doc(`d${String(i).padStart(2, "0")}`))),
          );
          expect((await other().list()).length).toBe(30);
        });
      } else {
        it("versioned access is refused with NOT_SUPPORTED", async () => {
          const { a } = await collection();
          expect(() => asVersionedDocumentStore(a)).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
        });
      }

      it("typed queries filter on fields and paginate deterministically by id", async () => {
        const { a, other } = await collection();
        const ids = ["k", "b", "B", "a10", "a2", "z", "m", "é"];
        await a.putMany(ids.map((id, i) => doc(id, i % 2 ? "odd" : "even", i)));
        const sorted = [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
        const walked: string[] = [];
        let after: string | undefined;
        for (let pages = 0; pages < 10; pages++) {
          const page = await queryDocuments(other(), { limit: 3, ...(after ? { after } : {}) });
          walked.push(...page.items.map((d) => d.id));
          if (!page.next) break;
          after = page.next;
        }
        expect(walked).toEqual(sorted);
        const odd = await queryDocuments(a, { where: { owner: "odd" } });
        expect(odd.items.map((d) => d.id)).toEqual(sorted.filter((id) => ids.indexOf(id) % 2 === 1));
        expect(odd.next).toBeUndefined();
        expect((await queryDocuments(a, { where: { owner: "even", n: 2 } })).items.map((d) => d.id)).toEqual(["B"]);
        expect(await queryDocuments(a, { after: "\u{10ffff}" })).toEqual({ items: [] });
        await expect(queryDocuments(a, { limit: 0 })).rejects.toThrow(RangeError);
      });

      if (caps["document.batchAtomic"]) {
        it("a batch is all-or-nothing to a concurrent reader", async () => {
          const { a, other } = await collection();
          const reader = other();
          const seen = new Set<number>();
          let done = false;
          const watching = (async () => {
            while (!done) {
              seen.add((await reader.list()).length);
              await new Promise((r) => setImmediate(r));
            }
          })();
          await a.putMany(Array.from({ length: 40 }, (_, i) => doc(`b${i}`)));
          done = true;
          await watching;
          seen.add((await reader.list()).length);
          for (const n of seen) expect([0, 40]).toContain(n);
          expect(seen.has(40)).toBe(true);
        });
      }
    });

    // ------------------------------------------------------------------ events
    describe("event seam", () => {
      it("sequences each run gap-free from 0 under concurrent appends from several handles (#97)", async () => {
        const b = await create();
        const handles = [b.stores().events, b.stores().events];
        const appended = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            handles[i % 2]!.append(
              i % 3 === 0 ? runCreated(`run_${i % 2}`) : { type: "run.started", runId: `run_${i % 2}`, payload: {} },
            ),
          ),
        );
        for (const runId of ["run_0", "run_1"]) {
          const log = await b.stores().events.read(runId);
          expect(log.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
          expect(new Set(log.map((e) => e.id)).size).toBe(6);
          expect(await b.stores().events.lastSeq(runId)).toBe(5);
        }
        expect(new Set(appended.map((e) => e.id)).size).toBe(12);
        expect((await b.stores().events.listRuns()).sort()).toEqual(["run_0", "run_1"]);
      });

      it("an unknown run is empty, not an error", async () => {
        const events = (await create()).stores().events;
        expect(await events.read("run_none")).toEqual([]);
        expect(await events.lastSeq("run_none")).toBeUndefined();
        expect(await events.readRange("run_none", { limit: 5 })).toEqual([]);
      });

      it("pages forward and backward deterministically, filtering before the limit", async () => {
        const events = (await create()).stores().events;
        await events.append(runCreated("run_p"));
        for (let i = 0; i < 9; i++) await events.append({ type: "run.started", runId: "run_p", payload: {} });
        const all = await events.read("run_p");
        const forward: number[] = [];
        let after = -1;
        for (;;) {
          const page = await events.readRange("run_p", { after, limit: 4 });
          if (page.length === 0) break;
          forward.push(...page.map((e) => e.seq));
          after = page[page.length - 1]!.seq;
        }
        expect(forward).toEqual(all.map((e) => e.seq));
        expect((await events.readRange("run_p", { before: 10, limit: 3 })).map((e) => e.seq)).toEqual([7, 8, 9]);
        expect((await events.readRange("run_p", { before: 2, limit: 3 })).map((e) => e.seq)).toEqual([0, 1]);
        expect((await events.readRange("run_p", { types: ["run.created"], limit: 1 })).map((e) => e.seq)).toEqual([0]);
        expect((await events.readTypes("run_p", ["run.created"])).map((e) => e.seq)).toEqual([0]);
      });

      it("notifies subscribers only once the event is readable through another handle", async () => {
        const b = await create();
        const writer = b.stores().events;
        const observed: Promise<boolean>[] = [];
        const stop = writer.subscribe(
          (e) =>
            observed.push(
              b
                .stores()
                .events.read(e.runId)
                .then((log) => log.some((x) => x.id === e.id)),
            ),
          { runId: "run_s" },
        );
        await writer.append(runCreated("run_s"));
        await writer.append({ type: "run.started", runId: "run_s", payload: {} });
        stop();
        await writer.append({ type: "run.started", runId: "run_s", payload: {} });
        expect(await Promise.all(observed)).toEqual([true, true]);
      });
    });

    // ---------------------------------------------------------------- journal
    describe("plan journal seam", () => {
      it("sequences each plan gap-free under concurrent appends from several handles", async () => {
        const b = await create();
        const handles = [b.stores().plan.journal, b.stores().plan.journal];
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            handles[i % 2]!.append({
              type: "request.linked",
              planId: `plan_${i % 2}`,
              origin: { kind: "api" },
              payload: { requestId: `req_${i}` },
            }),
          ),
        );
        for (const planId of ["plan_0", "plan_1"])
          expect((await b.stores().plan.journal.read(planId)).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
        expect((await b.stores().plan.journal.listPlans()).sort()).toEqual(["plan_0", "plan_1"]);
        expect(await b.stores().plan.journal.read("plan_none")).toEqual([]);
      });
    });

    // --------------------------------------------------------------- artifacts
    describe("artifact seam", () => {
      it("round-trips text and binary bodies and queries the index", async () => {
        const b = await create();
        const store = b.stores().artifacts;
        const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]);
        await store.put(artifact("art_t", "hello"), "hello");
        await store.put(artifact("art_b", png, { kind: "image", producedBy: { runId: "run_2" } }), png);
        const reader = b.stores().artifacts;
        expect(await reader.content("art_t")).toBe("hello");
        expect(Buffer.from(await reader.bytes("art_b")).equals(Buffer.from(png))).toBe(true);
        expect((await reader.list({ kind: "image" })).map((a) => a.id)).toEqual(["art_b"]);
        expect((await reader.list({ runId: "run_1" })).map((a) => a.id)).toEqual(["art_t"]);
        expect((await reader.list({ name: "art_t" })).map((a) => a.id)).toEqual(["art_t"]);
      });

      it("a missing artifact is ARTIFACT_MISSING", async () => {
        const store = (await create()).stores().artifacts;
        expect(await store.get("art_none")).toBeUndefined();
        expect(isOrcaError(await rejection(store.content("art_none")), "ARTIFACT_MISSING")).toBe(true);
      });

      it("a re-put of the same artifact is idempotent; identical bodies share one blob", async () => {
        const store = (await create()).stores().artifacts;
        await store.put(artifact("art_1", "same"), "same");
        await store.put(artifact("art_1", "same"), "same");
        await store.put(artifact("art_2", "same"), "same");
        expect((await store.list()).map((a) => a.id).sort()).toEqual(["art_1", "art_2"]);
        expect(await store.content("art_2")).toBe("same");
      });

      if (caps["artifact.verifiedContent"]) {
        it("refuses a body that does not match its content hash, indexing nothing", async () => {
          const store = (await create()).stores().artifacts;
          const error = await rejection(store.put(artifact("art_x", "claimed"), "actual"));
          expect(isOrcaError(error, "ARTIFACT_INVALID")).toBe(true);
          expect(await store.get("art_x")).toBeUndefined();
          expect(await store.list()).toEqual([]);
        });
      }

      if (caps["artifact.orphanInventory"]) {
        it("a blob whose metadata write failed stays invisible, is inventoried, and a retry adopts it", async () => {
          const b = await create();
          const dir = b.dir!;
          const store = new FileArtifactStore(dir);
          // Make the index append fail after the blob is published: its file is a directory.
          const index = join(dir, "artifacts", "index.jsonl");
          await mkdir(index, { recursive: true });
          await expect(store.put(artifact("art_lost", "orphan"), "orphan")).rejects.toThrow();
          await rm(index, { recursive: true });
          await store.put(artifact("art_ok", "kept"), "kept");
          expect(await store.get("art_lost")).toBeUndefined();
          expect((await store.list()).map((a) => a.id)).toEqual(["art_ok"]);
          expect(await store.unreferencedBlobs()).toEqual([sha256("orphan")]);
          await store.put(artifact("art_lost", "orphan"), "orphan");
          expect(await store.content("art_lost")).toBe("orphan");
          expect(await store.unreferencedBlobs()).toEqual([]);
        });
      }
    });

    // ------------------------------------------------------------------ claims
    describe("claim seam", () => {
      it("exactly one of several concurrent claimants wins, and every one is told who", async () => {
        const b = await create();
        const handles = [b.stores().claims, b.stores().claims];
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => handles[i % 2]!.claim(claim("wi_1", `run_${i}`))),
        );
        const winner = results[0]!.runId;
        for (const r of results) expect(r.runId).toBe(winner);
        expect((await b.stores().claims.get("wi_1"))?.runId).toBe(winner);
      });

      it("a retried claim by the same owner is idempotent", async () => {
        const claims = (await create()).stores().claims;
        const first = await claims.claim(claim("wi_1", "run_a"));
        expect(await claims.claim(claim("wi_1", "run_a"))).toEqual(first);
        expect(await claims.list()).toHaveLength(1);
      });

      it("a non-owner cannot release; the owner can, and the item is free again", async () => {
        const claims = (await create()).stores().claims;
        await claims.claim(claim("wi_1", "run_a"));
        let fenced = false;
        await claims.release("wi_1", "run_b", async () => {
          fenced = true;
        });
        expect(fenced).toBe(false);
        expect((await claims.get("wi_1"))?.runId).toBe("run_a");
        await claims.release("wi_1", "run_a");
        expect(await claims.get("wi_1")).toBeUndefined();
        expect((await claims.claim(claim("wi_1", "run_b"))).runId).toBe("run_b");
      });
    });

    // ------------------------------------------------------------------ leases
    describe("lease seam", () => {
      it("exactly one of several concurrent holders acquires (#101)", async () => {
        const b = await create();
        const handles = [b.stores().leases, b.stores().leases];
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => handles[i % 2]!.acquire({ resource: "run:r", holder: `h${i}` })),
        );
        const winner = results[0]!.holder;
        for (const r of results) expect(r.holder).toBe(winner);
      });

      it("the same holder re-acquires by refreshing, not by conflicting", async () => {
        const b = await create();
        const leases = b.stores().leases;
        const first = await leases.acquire({ resource: "run:r", holder: "h" });
        b.clock.advance(1_000);
        const again = await leases.acquire({ resource: "run:r", holder: "h" });
        expect(again.holder).toBe("h");
        expect(again.acquiredAt).toBe(first.acquiredAt);
        expect(Date.parse(again.renewedAt)).toBeGreaterThan(Date.parse(first.renewedAt));
      });

      it("a lapsed holder is taken over and fenced out of every write (#267)", async () => {
        const b = await create();
        const leases = b.stores().leases;
        const stale = await leases.acquire({ resource: "run:r", holder: "old", ttlMs: 1_000 });
        expect((await leases.acquire({ resource: "run:r", holder: "new" })).holder).toBe("old");
        b.clock.advance(1_000);
        const successor = await b.stores().leases.acquire({ resource: "run:r", holder: "new" });
        expect(successor.holder).toBe("new");
        let wrote = false;
        const error = await rejection(
          leases.withOwnership(stale, async () => {
            wrote = true;
          }),
        );
        expect(wrote).toBe(false);
        expect(isOrcaError(error, "RUN_LEASED")).toBe(true);
        expect(await leases.renew(stale)).toBeUndefined();
        await leases.release(stale);
        expect((await leases.get("run:r"))?.holder).toBe("new");
        expect(await leases.withOwnership(successor, async () => "written")).toBe("written");
      });

      it("force release removes whatever holds the resource", async () => {
        const leases = (await create()).stores().leases;
        await leases.acquire({ resource: "run:r", holder: "h" });
        expect((await leases.forceRelease("run:r"))?.holder).toBe("h");
        expect(await leases.get("run:r")).toBeUndefined();
        expect(await leases.forceRelease("run:r")).toBeUndefined();
      });
    });

    // -------------------------------------------------------- workflow versions
    describe("workflow-version seam", () => {
      it("the first definition written for a version wins, even under concurrent writers", async () => {
        const b = await create();
        const handles = [b.stores().workflows, b.stores().workflows];
        const wrote = await Promise.all(handles.map((h, i) => h.put(workflow("1", `writer${i}`))));
        expect(wrote.filter(Boolean)).toHaveLength(1);
        const kept = await b.stores().workflows.get("flow", "1");
        expect(kept?.name).toBe(`writer${wrote.indexOf(true)}`);
        expect(await b.stores().workflows.put(workflow("1", "late"))).toBe(false);
      });

      it("lists versions in a stable order and isolates readers from each other", async () => {
        const store = (await create()).stores().workflows;
        for (const v of ["2", "10", "1"]) await store.put(workflow(v));
        expect(await store.versions("flow")).toEqual(["1", "10", "2"]);
        expect(await store.versions("other")).toEqual([]);
        expect(await store.get("flow", "9")).toBeUndefined();
        const read = (await store.get("flow", "1"))!;
        read.name = "mutated";
        expect((await store.get("flow", "1"))?.name).toBe("flow");
      });
    });
  });
}

/** Documents a plain `DocumentStore` (no versioning) must still serve through the adapter. */
export function plainDocumentStore<T extends { id: string }>(): DocumentStore<T> {
  const docs = new Map<string, T>();
  return {
    get: async (id) => docs.get(id),
    put: async (d) => void docs.set(d.id, d),
    putMany: async (ds) => ds.forEach((d) => docs.set(d.id, d)),
    delete: async (id) => void docs.delete(id),
    list: async (p) => [...docs.values()].filter((d) => !p || p(d)),
  };
}
