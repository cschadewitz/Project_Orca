/**
 * A binary artifact round-trips (#226). `ArtifactStore` content used to be a `string`, so a
 * PNG went in, was decoded as UTF-8, and came back with every byte that is not valid UTF-8
 * replaced by U+FFFD. Both stores are held to the same three promises here: bytes come back
 * byte-exact, the hash over a text body is the hash it always was, and an index written
 * before any of this still loads.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendJsonl, sha256, type Artifact } from "@orca/core";
import { FileArtifactStore, InMemoryArtifactStore, type ArtifactStore } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "orca-bin-"));
  dirs.push(d);
  return d;
}

/** A PNG signature, an IHDR-ish chunk, and a run of bytes no UTF-8 decoder can keep. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0xc0,
  0x80, 0x00, 0x0a, 0x7f,
]);

const TEXT = "# Spec\n\nAn em dash — and a résumé, so this is not ASCII.\n";

function artifact(over: Partial<Artifact> & Pick<Artifact, "id" | "contentHash" | "size">): Artifact {
  return {
    kind: "generic",
    name: "thing",
    mediaType: "text/markdown",
    version: 1,
    producedBy: { runId: "run_1" },
    parents: [],
    data: {},
    createdAt: "2026-03-01T09:00:00.000Z",
    ...over,
  };
}

describe("artifact stores carry bytes", () => {
  for (const [name, make] of [
    ["memory", async (): Promise<ArtifactStore> => new InMemoryArtifactStore()],
    ["file", async (): Promise<ArtifactStore> => new FileArtifactStore(await dir())],
  ] as const) {
    it(`${name}: a binary body round-trips byte for byte`, async () => {
      const store = await make();
      const a = artifact({
        id: "art_png",
        name: "screenshot",
        mediaType: "image/png",
        contentHash: sha256(PNG),
        size: PNG.length,
      });
      await store.put(a, PNG);
      const back = Buffer.from(await store.bytes("art_png"));
      expect(back).toEqual(PNG);
      expect(sha256(back)).toBe(a.contentHash);
      // The bytes the store holds are its own: mutating what was put does not reach them.
      PNG[0] = 0x00;
      expect(Buffer.from(await store.bytes("art_png"))[0]).toBe(0x89);
      PNG[0] = 0x89;
    });

    it(`${name}: a text body is unchanged, and hashes as it always did`, async () => {
      const store = await make();
      const a = artifact({ id: "art_text", contentHash: sha256(TEXT), size: Buffer.byteLength(TEXT) });
      await store.put(a, TEXT);
      expect(await store.content("art_text")).toBe(TEXT);
      // Hashing a string in Node hashes its UTF-8 bytes, so a blob written either way is the
      // same blob under the same name: nothing in an existing store has to be rehashed.
      expect(sha256(Buffer.from(TEXT, "utf8"))).toBe(a.contentHash);
      expect(Buffer.from(await store.bytes("art_text"))).toEqual(Buffer.from(TEXT, "utf8"));
    });

    it(`${name}: a body the index has never had is ARTIFACT_MISSING either way`, async () => {
      const store = await make();
      await expect(store.content("art_nope")).rejects.toThrow(/not in store/);
      await expect(store.bytes("art_nope")).rejects.toThrow(/not in store/);
    });
  }

  it("the file store writes the blob raw, so a PNG on disk is a PNG", async () => {
    const d = await dir();
    const store = new FileArtifactStore(d);
    const a = artifact({ id: "art_png", mediaType: "image/png", contentHash: sha256(PNG), size: PNG.length });
    await store.put(a, PNG);
    expect(await readFile(join(d, "artifacts", "blobs", a.contentHash))).toEqual(PNG);
  });

  /**
   * The index is the compatibility surface, and #226 adds nothing to it: `mediaType` and
   * `size` already said what a body is and how big it is. An index written by an older ORCA
   * therefore loads unchanged, and its blobs - UTF-8 bytes under the hash of those bytes -
   * read back through both `content` and `bytes`.
   */
  it("an index written before this still loads, and its bodies still read", async () => {
    const d = await dir();
    const hash = sha256(TEXT);
    await mkdir(join(d, "artifacts", "blobs"), { recursive: true });
    await writeFile(join(d, "artifacts", "blobs", hash), TEXT, "utf8");
    // Exactly the row an older store appended: no field this change would have added, and a
    // `size` that is the old character count rather than the byte count.
    await appendJsonl(join(d, "artifacts", "index.jsonl"), {
      id: "art_old",
      kind: "spec",
      name: "spec",
      mediaType: "text/markdown",
      contentHash: hash,
      size: TEXT.length,
      version: 1,
      producedBy: { runId: "run_old" },
      parents: [],
      data: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const store = new FileArtifactStore(d);
    expect((await store.get("art_old"))?.size).toBe(TEXT.length);
    expect(await store.content("art_old")).toBe(TEXT);
    expect(Buffer.from(await store.bytes("art_old"))).toEqual(Buffer.from(TEXT, "utf8"));
    expect((await store.list({ runId: "run_old" })).map((x) => x.id)).toEqual(["art_old"]);
  });
});
