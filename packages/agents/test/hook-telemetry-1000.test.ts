/**
 * The hook telemetry spool (#1000): ORCA makes it, the hook only appends to it, and ORCA
 * reads it back as untrusted input.
 */
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_TELEMETRY_LINE_LIMIT, type HookTelemetryLine } from "@orca/core";
import {
  HOOK_TELEMETRY_SPOOL_LIMIT,
  openHookTelemetrySpool,
  parseHookTelemetryLine,
  recordHookTelemetry,
  sweepHookTelemetrySpools,
  type HookTelemetryDrainReport,
  type ProtectedPaths,
} from "@orca/agents";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const posix = process.platform !== "win32";
const guarded = new Map<string, ProtectedPaths>();

/** A spool directory as ORCA keeps one: owner-only, inside an agent-denied path. */
async function tmp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orca-spool-"));
  dirs.push(root);
  const dir = join(root, "private-execution", "tool-hooks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  guarded.set(dir, { readOnly: [root], noAccess: [join(root, "private-execution")] });
  return dir;
}
const protectedPaths = (dir: string) => guarded.get(dir)!;
/** A target with no identity ORCA recorded: no file can match it. */
const at = (file: string) => ({ file, dev: "0", ino: "0" });

const line = (over: Partial<HookTelemetryLine> = {}): HookTelemetryLine => ({
  v: 1,
  at: "2026-11-23T10:00:00.000Z",
  tool: "Bash",
  title: "npm test",
  input: { command: "npm test" },
  decision: "allow",
  latencyMs: 4,
  ...over,
});

async function collecting(dir: string, onReport?: (r: HookTelemetryDrainReport) => void) {
  const spool = await openHookTelemetrySpool({ dir, protectedPaths: protectedPaths(dir), onReport });
  const got: HookTelemetryLine[] = [];
  spool.attach(async (lines) => {
    got.push(...lines);
  });
  return { spool, got };
}

describe("hook telemetry spool", () => {
  it("is made empty and owner-only by ORCA, and hands the hook's lines over in order", async () => {
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    expect(spool.file.startsWith(dir)).toBe(true);
    const made = await stat(spool.file);
    expect(made.size).toBe(0);
    if (posix) expect(made.mode & 0o077).toBe(0);
    expect(recordHookTelemetry(spool.target, line({ tool: "Bash" }))).toBe(true);
    expect(recordHookTelemetry(spool.target, line({ tool: "Edit", decision: "deny", rule: "deny-edit" }))).toBe(true);
    expect(await spool.drain()).toEqual({ accepted: 2, rejected: 0, dropped: 0 });
    expect(got.map((l) => [l.tool, l.decision])).toEqual([
      ["Bash", "allow"],
      ["Edit", "deny"],
    ]);
    // A second drain reads only what came after.
    recordHookTelemetry(spool.target, line({ tool: "Read" }));
    expect(await spool.drain()).toEqual({ accepted: 1, rejected: 0, dropped: 0 });
    expect(got.map((l) => l.tool)).toEqual(["Bash", "Edit", "Read"]);
  });

  it("hook side: never creates a spool, never follows a link, never throws", async () => {
    const dir = await tmp();
    const missing = join(dir, "missing.spool");
    expect(recordHookTelemetry(at(missing), line())).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    const target = join(dir, "target");
    await writeFile(target, "");
    const link = join(dir, "link.spool");
    await symlink(target, link);
    if (process.platform !== "win32") {
      expect(recordHookTelemetry(at(link), line())).toBe(false);
      expect((await stat(target)).size).toBe(0);
    }
    expect(recordHookTelemetry(at(dir), line())).toBe(false);
    // A line that cannot be encoded is skipped, not thrown.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(recordHookTelemetry(at(target), line({ input: cyclic }))).toBe(false);
  });

  it("hook side: skips a line over the line limit, and stops at the spool limit", async () => {
    const dir = await tmp();
    const { spool } = await collecting(dir);
    expect(recordHookTelemetry(spool.target, line({ title: "x".repeat(HOOK_TELEMETRY_LINE_LIMIT) }))).toBe(false);
    expect((await stat(spool.file)).size).toBe(0);
    await writeFile(spool.file, Buffer.alloc(HOOK_TELEMETRY_SPOOL_LIMIT - 10, 0x0a));
    expect(recordHookTelemetry(spool.target, line())).toBe(false);
    expect((await stat(spool.file)).size).toBe(HOOK_TELEMETRY_SPOOL_LIMIT - 10);
  });

  it("drops every line that is not a valid v1 line, and counts it", async () => {
    const dir = await tmp();
    const reports: HookTelemetryDrainReport[] = [];
    const { spool, got } = await collecting(dir, (r) => reports.push(r));
    const bad = [
      "not json",
      JSON.stringify({ ...line(), v: 2 }),
      // Where a record belongs is ORCA's to say: a line that tries is not a line.
      JSON.stringify({ ...line(), runId: "run_other", sessionId: "sess_other" }),
      JSON.stringify({ ...line(), decision: "approve" }),
      JSON.stringify({ ...line(), latencyMs: -1 }),
      JSON.stringify({ ...line(), at: "yesterday" }),
      JSON.stringify({ ...line(), tool: "" }),
      JSON.stringify(line({ title: "y".repeat(HOOK_TELEMETRY_LINE_LIMIT) })),
    ];
    await appendFile(spool.file, `${bad.join("\n")}\n${JSON.stringify(line({ tool: "Good" }))}\n`);
    expect(await spool.drain()).toEqual({ accepted: 1, rejected: bad.length, dropped: 0 });
    expect(got.map((l) => l.tool)).toEqual(["Good"]);
    expect(reports).toEqual([{ accepted: 1, rejected: bad.length, dropped: 0 }]);
    for (const text of bad) expect(parseHookTelemetryLine(text)).toBeUndefined();
  });

  it("holds a partial last line until it ends, and rejects it if the session ends first", async () => {
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    const text = JSON.stringify(line({ tool: "Split" }));
    await appendFile(spool.file, text.slice(0, 20));
    expect(await spool.drain()).toEqual({ accepted: 0, rejected: 0, dropped: 0 });
    await appendFile(spool.file, `${text.slice(20)}\n${text.slice(0, 10)}`);
    expect(await spool.drain()).toEqual({ accepted: 1, rejected: 0, dropped: 0 });
    expect(got.map((l) => l.tool)).toEqual(["Split"]);
    expect(await spool.finish()).toEqual({ accepted: 0, rejected: 1, dropped: 0 });
  });

  it("rejects a line that runs on past the line limit, without losing the lines after it", async () => {
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    await appendFile(spool.file, "z".repeat(HOOK_TELEMETRY_LINE_LIMIT * 2));
    expect(await spool.drain()).toEqual({ accepted: 0, rejected: 1, dropped: 0 });
    await appendFile(spool.file, `${"z".repeat(100)}\n${JSON.stringify(line({ tool: "After" }))}\n`);
    expect(await spool.drain()).toEqual({ accepted: 1, rejected: 0, dropped: 0 });
    expect(got.map((l) => l.tool)).toEqual(["After"]);
  });

  it("stops reading a spool that is no longer the file ORCA made", async () => {
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    recordHookTelemetry(spool.target, line());
    const other = join(dir, "other");
    await writeFile(other, `${JSON.stringify(line({ tool: "Forged" }))}\n`);
    await rename(other, spool.file);
    const report = await spool.drain();
    expect(report.refused).toMatch(/not the file ORCA made/);
    expect(got).toEqual([]);
    // Refused for good, and not removed: it is not ORCA's file.
    expect((await spool.drain()).refused).toBeDefined();
    await spool.finish();
    expect((await lstat(spool.file)).isFile()).toBe(true);
  });

  it("refuses a spool replaced by a link", async () => {
    if (process.platform === "win32") return;
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    const target = join(dir, "target");
    await writeFile(target, `${JSON.stringify(line())}\n`);
    await rm(spool.file);
    await symlink(target, spool.file);
    expect((await spool.drain()).refused).toBeDefined();
    expect(got).toEqual([]);
  });

  it("drops lines when no consumer is attached or the consumer fails, and never throws", async () => {
    const dir = await tmp();
    const spool = await openHookTelemetrySpool({ dir, protectedPaths: protectedPaths(dir) });
    recordHookTelemetry(spool.target, line());
    expect(await spool.drain()).toEqual({ accepted: 0, rejected: 0, dropped: 1 });
    spool.attach(async () => {
      throw new Error("store is full");
    });
    recordHookTelemetry(spool.target, line());
    expect(await spool.drain()).toEqual({ accepted: 0, rejected: 0, dropped: 1 });
  });

  it("finish drains once more, removes the spool, and is idempotent", async () => {
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    recordHookTelemetry(spool.target, line({ tool: "Last" }));
    const [a, b] = await Promise.all([spool.finish(), spool.finish()]);
    expect(a).toEqual({ accepted: 1, rejected: 0, dropped: 0 });
    expect(b).toBe(a);
    expect(got.map((l) => l.tool)).toEqual(["Last"]);
    expect(await readdir(dir)).toEqual([]);
    // After finish, the hook's writes go nowhere and nothing reads.
    expect(recordHookTelemetry(spool.target, line())).toBe(false);
    expect(await spool.drain()).toBe(a);
  });

  it("goes only in an owner-only directory agents may not access", async () => {
    const dir = await tmp();
    const root = join(dir, "..", "..");
    // Somewhere an agent may read: the store itself is only read-only to agents.
    const open = join(root, "visible");
    await mkdir(open, { mode: 0o700 });
    await expect(openHookTelemetrySpool({ dir: open, protectedPaths: protectedPaths(dir) })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    if (posix) {
      await chmod(dir, 0o755);
      await expect(openHookTelemetrySpool({ dir, protectedPaths: protectedPaths(dir) })).rejects.toThrow(
        /open to group or others/,
      );
      await chmod(dir, 0o700);
    }
    const linked = join(root, "private-execution", "linked");
    await symlink(open, linked);
    await expect(openHookTelemetrySpool({ dir: linked, protectedPaths: protectedPaths(dir) })).rejects.toThrow();
    expect(await readdir(open)).toEqual([]);
  });

  it("stops reading a spool that is opened up to others or given a second name", async () => {
    if (!posix) return;
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    recordHookTelemetry(spool.target, line());
    await chmod(spool.file, 0o644);
    expect((await spool.drain()).refused).toMatch(/open to group or others/);
    const other = await collecting(dir);
    recordHookTelemetry(other.spool.target, line());
    await link(other.spool.file, join(dir, "alias"));
    expect((await other.spool.drain()).refused).toMatch(/another name/);
    expect([...got, ...other.got]).toEqual([]);
  });

  it("after a crash, discards spools whose process is gone, and leaves live ones", async () => {
    const dir = await tmp();
    const live = await collecting(dir);
    const dead = join(dir, "tool-calls-999999-00000000-0000-4000-8000-000000000000.spool");
    const otherLive = join(dir, "tool-calls-424242-00000000-0000-4000-8000-000000000001.spool");
    const mine = join(dir, `tool-calls-${process.pid}-00000000-0000-4000-8000-000000000002.spool`);
    const unrelated = join(dir, "context.json");
    for (const f of [dead, otherLive, mine, unrelated]) await writeFile(f, "x\n", { mode: 0o600 });
    const removed = await sweepHookTelemetrySpools({
      dir,
      protectedPaths: protectedPaths(dir),
      alive: (pid) => pid === 424242,
    });
    expect(removed).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(
      [live.spool.file.slice(dir.length + 1), otherLive.slice(dir.length + 1), "context.json"].sort(),
    );
    // A finished spool is no longer live, and is gone anyway.
    await live.spool.finish();
    expect(await sweepHookTelemetrySpools({ dir, protectedPaths: protectedPaths(dir), alive: () => true })).toBe(0);
  });

  it("hook side: writes only to the very file ORCA made, owner-only, with one name, without blocking", async () => {
    const dir = await tmp();
    const { spool, got } = await collecting(dir);
    // Replaced by another file at the same path.
    const other = join(dir, "other");
    await writeFile(other, "", { mode: 0o600 });
    const saved = join(dir, "saved");
    await rename(spool.file, saved);
    await rename(other, spool.file);
    expect(recordHookTelemetry(spool.target, line())).toBe(false);
    expect((await stat(spool.file)).size).toBe(0);
    await rename(saved, spool.file);
    expect(recordHookTelemetry(spool.target, line())).toBe(true);
    if (posix) {
      await chmod(spool.file, 0o644);
      expect(recordHookTelemetry(spool.target, line())).toBe(false);
      await chmod(spool.file, 0o600);
      await link(spool.file, join(dir, "alias"));
      expect(recordHookTelemetry(spool.target, line())).toBe(false);
      await rm(join(dir, "alias"));
      // A FIFO in the spool's place: the hook neither waits on it nor writes to it.
      const { execFileSync } = await import("node:child_process");
      const fifo = join(dir, "fifo");
      execFileSync("mkfifo", [fifo]);
      const started = Date.now();
      expect(recordHookTelemetry({ ...spool.target, file: fifo }, line())).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    expect(await spool.drain()).toEqual({ accepted: 1, rejected: 0, dropped: 0 });
    expect(got).toHaveLength(1);
  });

  it("drain does not wait on a FIFO put in the spool's place", async () => {
    if (!posix) return;
    const dir = await tmp();
    const { spool } = await collecting(dir);
    await rm(spool.file);
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [spool.file]);
    const report = await spool.drain();
    expect(report.refused).toMatch(/not the file ORCA made/);
  });
});
