/** Regression at the real validation/write boundary: syntactically valid YAML can still merge list values. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigModel } from "../src/config-model.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(text: string) {
  const dir = await mkdtemp(join(tmpdir(), "orca-collection-regression-"));
  dirs.push(dir);
  const file = join(dir, "orca.config.yaml");
  await writeFile(file, text, "utf8");
  const model = new ConfigModel({ configDir: dir, configFile: file });
  return { file, model, revision: (await model.get()).config.revision };
}

it.each(["", " # retained EOF comment"])(
  "writes the intended EOF move/append without merged workflow values (%s)",
  async (comment) => {
    const { file, model, revision } = await fixture(`workflows:\n  - a\n  - b${comment}`);
    const preview = await model.set({
      document: "config",
      expectedRevision: revision,
      edits: [{ kind: "move", path: ["workflows"], from: 1, to: 0 }],
      validateOnly: true,
    });
    expect(preview.validation?.errors).toEqual([]);
    expect(preview.document.parsed).toEqual({ workflows: ["b", "a"] });
    const saved = await model.set({
      document: "config",
      expectedRevision: revision,
      edits: [{ kind: "move", path: ["workflows"], from: 1, to: 0 }],
    });
    expect(parse(await readFile(file, "utf8"))).toEqual({ workflows: ["b", "a"] });
    await model.set({
      document: "config",
      expectedRevision: saved.document.revision,
      edits: [{ kind: "insert", path: ["workflows"], index: 2, value: "c" }],
    });
    expect(parse(await readFile(file, "utf8"))).toEqual({ workflows: ["b", "a", "c"] });
  },
);

it("validates and saves last-record deletion as an explicit empty mapping", async () => {
  const { file, model, revision } = await fixture(
    "roles: # collection\n  # lead\n  builder: a\n# sibling\nstoreDir: custom\n",
  );
  const params = {
    document: "config" as const,
    expectedRevision: revision,
    edits: [{ kind: "remove" as const, path: ["roles", "builder"] }],
  };
  const preview = await model.set({ ...params, validateOnly: true });
  expect(preview.validation?.errors).toEqual([]);
  expect(preview.document.parsed).toEqual({ roles: {}, storeDir: "custom" });
  await model.set(params);
  const text = await readFile(file, "utf8");
  expect(parse(text)).toEqual({ roles: {}, storeDir: "custom" });
  for (const comment of ["# collection", "# lead", "# sibling"]) expect(text).toContain(comment);
});
