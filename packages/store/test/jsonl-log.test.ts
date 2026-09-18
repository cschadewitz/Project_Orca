/** The on-disk sequencing both JSONL stores append through, and the lock file under it. */
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { consoleLogger, isOrcaError, type Logger } from "@orca/core";
import { JsonlLogDir, withFileLock } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "orca-log-"));
  dirs.push(d);
  return d;
}

function capture(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: consoleLogger("warn", {}, (l) => lines.push(l)), lines };
}

const Row = z.object({ seq: z.number(), n: z.number() });
const row = (n: number) => (seq: number) => ({ seq, n });

describe("JsonlLogDir", () => {
  it("assigns seq from the file, so two instances over one directory extend one log", async () => {
    const d = await tmp();
    const a = new JsonlLogDir(d);
    const b = new JsonlLogDir(d);
    await a.append("k", row(1));
    await b.append("k", row(2));
    await a.append("k", row(3));
    expect((await a.read("k", Row)).map((r) => [r.seq, r.n])).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(await b.read("k", Row)).toEqual(await a.read("k", Row));
  });

  it("keeps seq unique and gap-free while two instances append concurrently", async () => {
    const d = await tmp();
    const a = new JsonlLogDir(d);
    const b = new JsonlLogDir(d);
    const appends = Array.from({ length: 10 }, (_, i) => [a.append("k", row(i)), b.append("k", row(100 + i))]).flat();
    await Promise.all(appends);
    const seqs = (await a.read("k", Row)).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
    // Nothing but the log is left behind: no lock, no scratch files.
    expect(await readdir(d)).toEqual(["k.jsonl"]);
  });

  it("continues after the last record's seq rather than counting lines", async () => {
    const d = await tmp();
    // A log two pre-fix processes numbered 0, 1, 1: the next event must not be a third 1, nor 3.
    await writeFile(join(d, "k.jsonl"), '{"seq":0,"n":1}\n\n{"seq":1,"n":2}\n{"seq":1,"n":3}\n');
    expect((await new JsonlLogDir(d).append("k", row(4))).seq).toBe(2);
  });

  it("truncates a torn tail on the next append and skips it on reads until then", async () => {
    const d = await tmp();
    const { logger, lines } = capture();
    const logs = new JsonlLogDir(d, { logger });
    await logs.append("k", row(1));
    await logs.append("k", row(2));
    // The process died between writing part of the line and finishing it.
    await writeFile(join(d, "k.jsonl"), '{"seq":2,"n', { flag: "a" });

    expect((await new JsonlLogDir(d, { logger }).read("k", Row)).map((r) => r.seq)).toEqual([0, 1]);
    expect(lines.some((l) => l.includes("not JSON"))).toBe(true);

    // A fresh instance has no cache and repairs before it writes; the cached one sees the size change and does the same.
    expect((await new JsonlLogDir(d, { logger }).append("k", row(3))).seq).toBe(2);
    expect(lines.some((l) => l.includes("torn tail"))).toBe(true);
    expect((await logs.append("k", row(4))).seq).toBe(3);
    expect(await readFile(join(d, "k.jsonl"), "utf8")).toBe('{"seq":0,"n":1}\n{"seq":1,"n":2}\n{"seq":2,"n":3}\n{"seq":3,"n":4}\n');
  });

  it("skips a corrupt line in the middle with a warning, but a schema failure still throws", async () => {
    const d = await tmp();
    const { logger, lines } = capture();
    await writeFile(join(d, "k.jsonl"), '{"seq":0,"n":1}\nnot json\n{"seq":1,"n":2}\n');
    const logs = new JsonlLogDir(d, { logger });
    expect((await logs.read("k", Row)).map((r) => r.n)).toEqual([1, 2]);
    expect(lines).toHaveLength(1);
    expect(logs.parseLine("k", "still not json", Row)).toBeUndefined();
    expect(() => logs.parseLine("k", '{"seq":"x"}', Row)).toThrow();
    // Without a logger the corrupt line is still skipped, just silently.
    expect((await new JsonlLogDir(d).read("k", Row)).map((r) => r.n)).toEqual([1, 2]);
    await writeFile(join(d, "bad.jsonl"), '{"seq":0,"n":"x"}\n');
    await expect(logs.read("bad", Row)).rejects.toThrow();
  });

  it("lists logs only, not lock or scratch files", async () => {
    const d = await tmp();
    const logs = new JsonlLogDir(d);
    await logs.append("b", row(1));
    await logs.append("a", row(1));
    await writeFile(join(d, "a.jsonl.lock"), "{}");
    await writeFile(join(d, "a.jsonl.lock.1.x.tmp"), "{}");
    expect(await logs.keys()).toEqual(["a", "b"]);
    expect(await logs.read("missing", Row)).toEqual([]);
    expect(await logs.lines("missing")).toEqual([]);
  });

  it("waits for a live lock and gives up with STORE_LOCK_TIMEOUT", async () => {
    const d = await tmp();
    const { logger, lines } = capture();
    const logs = new JsonlLogDir(d, { logger, lock: { timeoutMs: 150 } });
    await writeFile(join(d, "k.jsonl.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(logs.append("k", row(1))).rejects.toSatisfy((e) => isOrcaError(e, "STORE_LOCK_TIMEOUT"));
    // A failed append does not wedge the queue for the key.
    await unlink(join(d, "k.jsonl.lock"));
    expect((await logs.append("k", row(1))).seq).toBe(0);
    expect(lines).toEqual([]);
  });

  it("breaks the lock of a dead process, and an old one, with a warning", async () => {
    const d = await tmp();
    const { logger, lines } = capture();
    const logs = new JsonlLogDir(d, { logger, lock: { staleMs: 1_000, timeoutMs: 150 } });
    // No process has this pid; kill(pid, 0) fails with ESRCH.
    await writeFile(join(d, "k.jsonl.lock"), JSON.stringify({ pid: 2 ** 31 - 1, at: Date.now() }));
    expect((await logs.append("k", row(1))).seq).toBe(0);
    await writeFile(join(d, "k.jsonl.lock"), JSON.stringify({ pid: process.pid, at: Date.now() - 5_000 }));
    expect((await logs.append("k", row(2))).seq).toBe(1);
    // Unreadable contents fall back to the file's age.
    await writeFile(join(d, "k.jsonl.lock"), "");
    await expect(logs.append("k", row(3))).rejects.toSatisfy((e) => isOrcaError(e, "STORE_LOCK_TIMEOUT"));
    expect(lines.filter((l) => l.includes("stale lock"))).toHaveLength(2);
    expect(await readdir(d)).toEqual(["k.jsonl", "k.jsonl.lock"]);
  });
});

describe("withFileLock", () => {
  it("runs critical sections one at a time and releases on both paths", async () => {
    const d = await tmp();
    const lock = join(d, "x.lock");
    let inside = 0;
    let overlaps = 0;
    const section = async (fail: boolean) =>
      withFileLock(lock, async () => {
        if (inside++ > 0) overlaps++;
        await new Promise((r) => setTimeout(r, 5));
        inside--;
        if (fail) throw new Error("boom");
        return "ok";
      });
    const results = await Promise.allSettled([section(false), section(true), section(false), section(false)]);
    expect(overlaps).toBe(0);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(await readdir(d)).toEqual([]);
  });

  it("does not remove a successor's lock when its own was broken as stale", async () => {
    const d = await tmp();
    const lock = join(d, "x.lock");
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const first = withFileLock(lock, () => held, { staleMs: 50 });
    // Wait until the first holder owns the lock, then let it go stale and take it over.
    await new Promise((r) => setTimeout(r, 80));
    const second = withFileLock(lock, () => new Promise<void>((r) => setTimeout(r, 40)), { staleMs: 50 });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await first;
    // The first holder's release found a lock that was not its own and left it for the second.
    expect(await readdir(d)).toEqual(["x.lock"]);
    await second;
    expect(await readdir(d)).toEqual([]);
  });
});
