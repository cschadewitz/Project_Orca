/** The store conformance suite (#338) against the two backends ORCA ships. */
import { describe, expect, it } from "vitest";
import { asVersionedDocumentStore, queryDocuments, InMemoryDocumentStore } from "@orca/store";
import { fileBackend, memoryBackend } from "./backend.js";
import { plainDocumentStore, runStoreConformance } from "./store-conformance.js";

runStoreConformance(memoryBackend);
runStoreConformance(fileBackend);

describe("compatibility adapters for existing DocumentStore consumers", () => {
  type D = { id: string; kind: string };
  const docs: D[] = ["c", "a", "b", "d"].map((id, i) => ({ id, kind: i % 2 ? "x" : "y" }));

  it("a plain store gets the same query answers through the adapter as a native one", async () => {
    const plain = plainDocumentStore<D>();
    const native = new InMemoryDocumentStore<D>();
    await plain.putMany(docs);
    await native.putMany(docs);
    for (const q of [{}, { limit: 2 }, { limit: 2, after: "b" }, { where: { kind: "x" } }]) {
      expect(await queryDocuments(plain, q)).toEqual(await queryDocuments(native, q));
    }
  });

  it("a plain store is refused versioned access rather than given a racy emulation", () => {
    expect(() => asVersionedDocumentStore(plainDocumentStore<D>())).toThrow(
      expect.objectContaining({ code: "NOT_SUPPORTED", details: { capability: "document.versioned" } }),
    );
  });
});
