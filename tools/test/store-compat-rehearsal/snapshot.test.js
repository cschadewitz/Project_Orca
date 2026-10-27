/** The rehearsal's byte manifests: complete, link-refusing, and a copy that only ever creates. */
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compareSnapshots, copyToNew, snapshotRoots, SnapshotRefusal } from "../../store-compat-rehearsal/snapshot.js";

const posix = process.platform !== "win32";
const bases = [];
afterEach(async () => {
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});
async function tree() {
  const base = await mkdtemp(join(tmpdir(), "orca-rehearsal-snapshot-"));
  bases.push(base);
  const root = join(base, "workspace");
  await mkdir(join(root, ".orca", "runs"), { recursive: true });
  await writeFile(join(root, "orca.config.yaml"), "storeDir: .orca\n");
  await writeFile(join(root, ".orca", "runs", "run_a.jsonl"), '{"seq":0}\n');
  await writeFile(join(root, ".orca", ".hidden-key"), Buffer.alloc(32, 7), { mode: 0o600 });
  return { base, root };
}

it("records every directory and file, hidden ones included, with size, digest and permission bits", async () => {
  const { root } = await tree();
  const manifest = await snapshotRoots({ workspace: root });
  const entries = manifest.roots.workspace.entries;
  expect(entries.map((entry) => entry.path)).toEqual([
    ".orca",
    ".orca/.hidden-key",
    ".orca/runs",
    ".orca/runs/run_a.jsonl",
    "orca.config.yaml",
  ]);
  const key = entries.find((entry) => entry.path === ".orca/.hidden-key");
  expect(key).toMatchObject({ kind: "file", size: 32 });
  expect(key.sha256).toMatch(/^[0-9a-f]{64}$/);
  if (posix) expect(key.mode).toBe(0o600);
});

it("refuses links, overlapping roots and relative roots rather than describing something else", async () => {
  const { base, root } = await tree();
  await expect(snapshotRoots({ workspace: "relative/path" })).rejects.toMatchObject({ code: "ROOT_INVALID" });
  await expect(snapshotRoots({ workspace: root, store: join(root, ".orca") })).rejects.toMatchObject({
    code: "ROOT_OVERLAP",
  });
  if (posix) {
    await symlink(join(base, "elsewhere"), join(root, ".orca", "link"));
    await expect(snapshotRoots({ workspace: root })).rejects.toMatchObject({ code: "LINK_REFUSED" });
  }
});

it("compares content, kind and permission bits but not physical identity", async () => {
  const { base, root } = await tree();
  const copy = join(base, "copy");
  const original = await copyToNew(root, copy);
  expect(compareSnapshots(original, await snapshotRoots({ tree: copy })).equal).toBe(true);
  await writeFile(join(copy, ".orca", "runs", "run_a.jsonl"), '{"seq":0}\n{"seq":1}\n');
  await writeFile(join(copy, ".orca", "runs", "run_b.jsonl"), '{"seq":0}\n');
  await rename(join(copy, "orca.config.yaml"), join(base, "withheld.yaml"));
  if (posix) await chmod(join(copy, ".orca", ".hidden-key"), 0o644);
  const result = compareSnapshots(original, await snapshotRoots({ tree: copy }));
  expect(result.equal).toBe(false);
  expect(result.added).toEqual(["tree:.orca/runs/run_b.jsonl"]);
  expect(result.removed).toEqual(["tree:orca.config.yaml"]);
  expect(result.changed).toContainEqual({ path: "tree:.orca/runs/run_a.jsonl", fields: ["size", "sha256"] });
  if (posix) expect(result.changed).toContainEqual({ path: "tree:.orca/.hidden-key", fields: ["mode"] });
});

it("copies only to a destination that does not exist and never touches the source", async () => {
  const { base, root } = await tree();
  const before = await snapshotRoots({ workspace: root });
  const existing = join(base, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "keep"), "operator file");
  await expect(copyToNew(root, existing)).rejects.toBeInstanceOf(SnapshotRefusal);
  await expect(copyToNew(root, join(root, ".orca", "inside"))).rejects.toMatchObject({ code: "ROOT_OVERLAP" });
  expect(await readdir(existing)).toEqual(["keep"]);
  expect(await readFile(join(existing, "keep"), "utf8")).toBe("operator file");
  expect(compareSnapshots(before, await snapshotRoots({ workspace: root })).equal).toBe(true);
});
