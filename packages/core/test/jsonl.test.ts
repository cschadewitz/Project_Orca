import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  anyJson,
  appendJsonl,
  parseJsonl,
  parseJsonlLine,
  readJsonl,
  readJsonlLines,
  splitJsonlLines,
} from "@orca/core";

const Row = z.object({ n: z.number() });

describe("jsonl", () => {
  it("skips blank and whitespace-only lines and tolerates CRLF", () => {
    expect(parseJsonl('{"n":1}\r\n\n   \n{"n":2}\r\n', Row)).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("exposes the raw lines with the same blank-line handling", async () => {
    expect(splitJsonlLines('{"n":1}\r\n\n   \n{"n":2}\r\n')).toEqual(['{"n":1}', '{"n":2}']);
    const file = join(await mkdtemp(join(tmpdir(), "orca-jsonl-")), "rows.jsonl");
    expect(await readJsonlLines(file)).toEqual([]);
    await appendJsonl(file, { n: 1 });
    expect(await readJsonlLines(file)).toEqual(['{"n":1}']);
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
  it("skips lines that are not JSON only when asked, and never hides a schema failure", async () => {
    const corrupt: string[] = [];
    const onCorrupt = (line: string) => corrupt.push(line);
    expect(() => parseJsonl('{"n":1}\n{"n":', Row)).toThrow();
    expect(parseJsonl('{"n":1}\n{"n":\n{"n":2}\n', Row, { onCorrupt })).toEqual([{ n: 1 }, { n: 2 }]);
    expect(corrupt).toEqual(['{"n":']);
    expect(parseJsonlLine("nope", Row, { onCorrupt })).toBeUndefined();
    expect(() => parseJsonlLine('{"n":"x"}', Row, { onCorrupt })).toThrow();
    const file = join(await mkdtemp(join(tmpdir(), "orca-jsonl-")), "rows.jsonl");
    await writeFile(file, '{"n":1}\n{"n"');
    await expect(readJsonl(file, Row)).rejects.toThrow();
    expect(await readJsonl(file, Row, { onCorrupt })).toEqual([{ n: 1 }]);
    expect(corrupt).toHaveLength(3);
  });
  it("still surfaces read errors other than a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-jsonl-"));
    // A directory read is a real I/O failure on supported platforms. A child under a
    // regular file reports ENOENT on Windows, so that path tests missing-file handling.
    await expect(readJsonl(dir, Row)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
