import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { anyJson, appendJsonl, parseJsonl, readJsonl } from "@orca/core";

const Row = z.object({ n: z.number() });

describe("jsonl", () => {
  it("skips blank and whitespace-only lines and tolerates CRLF", () => {
    expect(parseJsonl('{"n":1}\r\n\n   \n{"n":2}\r\n', Row)).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("runs every line through the parser", () => {
    expect(() => parseJsonl('{"n":"x"}', Row)).toThrow();
    expect(parseJsonl('{"a":1}\n"s"\n', anyJson)).toEqual([{ a: 1 }, "s"]);
  });
  it("reads a missing file as empty and round-trips appends", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "orca-jsonl-")), "rows.jsonl");
    expect(await readJsonl(file, Row)).toEqual([]);
    await appendJsonl(file, { n: 1 });
    await appendJsonl(file, { n: 2 });
    expect(await readJsonl(file, Row)).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("still surfaces read errors other than a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-jsonl-"));
    await writeFile(join(dir, "f"), "");
    await expect(readJsonl(join(dir, "f", "child.jsonl"), Row)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
