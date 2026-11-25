/**
 * #701 item 2: the daemon's qualified judge budget. Durable only on Linux and macOS, with an anchor directory ORCA
 * chose, physically separate from the store (real paths, and device and inode up to the root), outside every
 * supported restore, and unchanged before each reservation. Real temporary directories; no network.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JUDGE_BUDGET_ANCHOR_FILENAME,
  JUDGE_BUDGET_FILENAME,
  judgeBudgetKey,
  type JudgeBudgetIo,
} from "@orca/agents/judge-budget";
import {
  describeJudgeBudgetUnavailable,
  judgeBudgetAnchorDir,
  judgeBudgetAnchorRoot,
  existingJudgeBudget,
  inspectJudgeBudget,
  qualifiedJudgeBudget,
  supportedRestoreRoots,
  type QualifiedJudgeBudget,
} from "../src/judge-budget.js";

const WORKSPACE = "0b8f6c1e-6f6e-4a8e-9d0e-3c3f8b7a2d11";
const KEY = judgeBudgetKey("https://judge.example/v1/messages", "secret:judge-key");
const DAY1 = Date.parse("2026-11-22T10:00:00Z");
const DAY2 = Date.parse("2026-11-23T10:00:00Z");
const DAY3 = Date.parse("2026-11-24T10:00:00Z");

describe("#701 judge budget: where the anchor lives", () => {
  it("Linux uses $XDG_STATE_HOME, else ~/.local/state; macOS uses Application Support; Windows has none", () => {
    expect(judgeBudgetAnchorRoot({ platform: "linux", home: "/home/a", env: { XDG_STATE_HOME: "/state" } })).toBe(
      "/state/orca-judge-budget-anchors", // rename-keep: persisted name kept on purpose
    );
    expect(judgeBudgetAnchorRoot({ platform: "linux", home: "/home/a", env: { XDG_STATE_HOME: "rel" } })).toBe(
      "/home/a/.local/state/orca-judge-budget-anchors", // rename-keep: persisted name kept on purpose
    );
    expect(judgeBudgetAnchorRoot({ platform: "darwin", home: "/Users/a", env: {} })).toBe(
      "/Users/a/Library/Application Support/orca-judge-budget-anchors", // rename-keep: persisted name kept on purpose
    );
    expect(judgeBudgetAnchorRoot({ platform: "win32", home: "C:\\Users\\a", env: {} })).toBeUndefined();
    expect(judgeBudgetAnchorDir(WORKSPACE.toUpperCase(), { platform: "linux", home: "/h", env: {} })).toBe(
      `/h/.local/state/orca-judge-budget-anchors/${WORKSPACE}`, // rename-keep: persisted name kept on purpose
    );
    expect(judgeBudgetAnchorDir("../x", { platform: "linux", home: "/h", env: {} })).toBeUndefined();
  });

  it("every supported restore writes in the store or the store converted beside it", () => {
    expect(supportedRestoreRoots("/w/.orca")).toEqual(["/w/.orca", "/w/.orca-sqlite"]);
  });

  it("Windows, and any other platform, is unavailable: the judge stays off there", async () => {
    for (const platform of ["win32", "freebsd", "aix"] as const) {
      const result = await qualifiedJudgeBudget({ storeDir: tmpdir(), workspaceId: WORKSPACE, platform });
      expect(result).toEqual({ status: "unavailable", reason: "platform" });
    }
    expect(describeJudgeBudgetUnavailable("platform")).toMatch(/Windows is not supported/);
  });
});

describe.skipIf(process.platform === "win32")("#701 judge budget: qualified on this machine", () => {
  let root: string;
  let storeDir: string;
  let anchorDir: string;
  let now: number;
  const clock = () => now;
  const platform = process.platform;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orca-701-qualified-"));
    storeDir = join(root, "workspace", ".orca");
    anchorDir = join(root, "state", "anchors", WORKSPACE);
    mkdirSync(storeDir, { recursive: true });
    now = DAY1;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const qualify = (options: { anchorDir?: string; storeDir?: string } = {}) =>
    qualifiedJudgeBudget({
      storeDir: options.storeDir ?? storeDir,
      workspaceId: WORKSPACE,
      anchorDir: options.anchorDir ?? anchorDir,
      platform,
      now: clock,
    });
  const durable = async (options?: { anchorDir?: string; storeDir?: string }) => {
    const result = await qualify(options);
    if (result.status !== "durable") throw new Error(`expected durable, got ${JSON.stringify(result)}`);
    return result;
  };
  const refused = (result: QualifiedJudgeBudget, reason: string) =>
    expect(result).toEqual({ status: "unavailable", reason });

  it("session preparation creates no budget state: only an initialized, ready budget is handed out", async () => {
    const existing = () => existingJudgeBudget({ storeDir, workspaceId: WORKSPACE, anchorDir, platform, now: clock });
    const snapshot = () => [existsSync(anchorDir), readdirSync(storeDir).sort()];
    const before = snapshot();
    // Nothing created yet: not ready, and still nothing on disk (no anchor directory, no budget file, no lock).
    refused(await existing(), "not-ready");
    expect(snapshot()).toEqual(before);
    expect(existsSync(anchorDir)).toBe(false);
    // The owner's explicit step creates it; preparation then gets it, still without creating anything more.
    const q = await durable();
    expect(await q.budget.initialize()).toMatchObject({ status: "initialized" });
    const initialized = [readdirSync(anchorDir).sort(), readdirSync(storeDir).sort()];
    const ready = await existing();
    expect(ready.status).toBe("durable");
    expect([readdirSync(anchorDir).sort(), readdirSync(storeDir).sort()]).toEqual(initialized);
  });

  it("separate private directories are durable: initialize spends the day, the next day is counted", async () => {
    const q = await durable();
    expect(q.budget.durable).toBe(true);
    expect(q.anchorDir).toBe(realpathSync(anchorDir));
    expect(await q.budget.reserve(KEY, 2)).toBe(false); // nothing initialized yet
    expect(await q.budget.initialize()).toEqual({ status: "initialized", day: "2026-11-22" });
    expect(await q.budget.reserve(KEY, 2)).toBe(false); // the day initialized counts as spent
    now = DAY2;
    expect(await q.budget.reserve(KEY, 2)).toBe(true);
    // A restart: a new qualified budget over the same files keeps the count.
    expect(await (await durable()).budget.reserve(KEY, 2)).toBe(true);
    expect(await (await durable()).budget.reserve(KEY, 2)).toBe(false);
    expect(readFileSync(join(anchorDir, JUDGE_BUDGET_ANCHOR_FILENAME), "utf8")).toContain('"sequence":2');
  });

  it("the anchor directory is created owner-only", async () => {
    await durable();
    expect(statSync(anchorDir).mode & 0o777).toBe(0o700);
  });

  it("an anchor inside the store, or inside the store converted beside it, is refused before anything is created", async () => {
    refused(await qualify({ anchorDir: join(storeDir, "anchor") }), "not-separate");
    refused(await qualify({ anchorDir: `${storeDir}-sqlite/anchor` }), "not-separate");
    refused(await qualify({ anchorDir: storeDir }), "not-separate");
    expect(existsSync(join(storeDir, "anchor"))).toBe(false);
    expect(existsSync(`${storeDir}-sqlite`)).toBe(false);
  });

  it("a store inside the anchor is refused", async () => {
    const outer = join(root, "outer");
    mkdirSync(join(outer, "store"), { recursive: true });
    refused(await qualify({ anchorDir: outer, storeDir: join(outer, "store") }), "not-separate");
  });

  it("a link that leads the anchor into the store is refused, through the real path, before anything is created", async () => {
    mkdirSync(join(storeDir, "inside"));
    symlinkSync(join(storeDir, "inside"), join(root, "alias"));
    refused(await qualify({ anchorDir: join(root, "alias", "anchor") }), "not-separate");
    expect(existsSync(join(storeDir, "inside", "anchor"))).toBe(false);
  });

  it("a store reached through a link is compared at its real path", async () => {
    symlinkSync(join(root, "workspace"), join(root, "ws-alias"));
    const q = await durable({ storeDir: join(root, "ws-alias", ".orca") });
    expect(q.storeDir).toBe(realpathSync(storeDir));
    refused(
      await qualify({ storeDir: join(root, "ws-alias", ".orca"), anchorDir: join(root, "workspace", ".orca", "a") }),
      "not-separate",
    );
  });

  it("an anchor that is a link, a file, or open to others is refused", async () => {
    mkdirSync(join(root, "real-anchor"), { mode: 0o700 });
    symlinkSync(join(root, "real-anchor"), join(root, "link-anchor"));
    refused(await qualify({ anchorDir: join(root, "link-anchor") }), "anchor");
    mkdirSync(join(root, "open-anchor"));
    chmodSync(join(root, "open-anchor"), 0o755);
    refused(await qualify({ anchorDir: join(root, "open-anchor") }), "anchor");
  });

  it("a missing or linked store is refused", async () => {
    refused(await qualify({ storeDir: join(root, "nowhere") }), "store");
    symlinkSync(storeDir, join(root, "store-link"));
    refused(await qualify({ storeDir: join(root, "store-link") }), "store");
  });

  it("a workspace identity that is not one is refused", async () => {
    const result = await qualifiedJudgeBudget({ storeDir, workspaceId: "../../etc", platform });
    refused(result, "workspace");
  });

  it("restoring the store from a backup cannot hand back spent budget; only an explicit reset starts again, spent", async () => {
    const q = await durable();
    await q.budget.initialize();
    now = DAY2;
    expect(await q.budget.reserve(KEY, 3)).toBe(true);
    // A whole-store backup after one call.
    cpSync(storeDir, join(root, "backup"), { recursive: true });
    expect(await q.budget.reserve(KEY, 3)).toBe(true);
    expect(await q.budget.reserve(KEY, 3)).toBe(true);
    expect(await q.budget.reserve(KEY, 3)).toBe(false); // spent
    // Restore the store as it was (a new directory in its place), and restart.
    renameSync(storeDir, join(root, "replaced"));
    cpSync(join(root, "backup"), storeDir, { recursive: true });
    expect(await q.budget.reserve(KEY, 3)).toBe(false); // the old object: the store is another directory now
    const restarted = await durable();
    expect(await restarted.budget.reserve(KEY, 3)).toBe(false); // the anchor is ahead: refused, not two calls back
    // The budget file alone, restored in place: refused the same way.
    rmSync(storeDir, { recursive: true });
    renameSync(join(root, "replaced"), storeDir);
    cpSync(join(root, "backup", JUDGE_BUDGET_FILENAME), join(storeDir, JUDGE_BUDGET_FILENAME));
    expect(await (await durable()).budget.reserve(KEY, 3)).toBe(false);
    // The owner's reset: a new budget whose first day is spent.
    rmSync(join(storeDir, JUDGE_BUDGET_FILENAME));
    const reset = await durable();
    expect(await reset.budget.initialize()).toEqual({ status: "initialized", day: "2026-11-23" });
    expect(await reset.budget.reserve(KEY, 3)).toBe(false);
    now = DAY3;
    expect(await reset.budget.reserve(KEY, 3)).toBe(true);
  });

  it("an anchor directory swapped after construction refuses every call", async () => {
    const q = await durable();
    await q.budget.initialize();
    now = DAY2;
    expect(await q.budget.reserve(KEY, 5)).toBe(true);
    renameSync(anchorDir, `${anchorDir}.old`);
    cpSync(`${anchorDir}.old`, anchorDir, { recursive: true });
    chmodSync(anchorDir, 0o700);
    expect(await q.budget.reserve(KEY, 5)).toBe(false);
    expect(await q.budget.replace()).toEqual({ status: "refused", reason: "storage" });
  });

  it("a budget subdirectory replaced by a link refuses every call", async () => {
    const q = await durable();
    await q.budget.initialize();
    now = DAY2;
    const sub = join(storeDir, "review-judge");
    renameSync(sub, join(root, "moved"));
    symlinkSync(join(root, "moved"), sub);
    expect(await q.budget.reserve(KEY, 5)).toBe(false);
  });

  it("the anchor's ledger folder turned into a link into the converted store refuses, and the ledger is left as it was", async () => {
    const q = await durable();
    await q.budget.initialize();
    now = DAY2;
    expect(await q.budget.reserve(KEY, 5)).toBe(true);
    const converted = `${storeDir}-sqlite`;
    mkdirSync(converted);
    const sub = join(anchorDir, "review-judge");
    renameSync(sub, join(converted, "review-judge"));
    symlinkSync(join(converted, "review-judge"), sub);
    const before = readFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "utf8");
    expect(await q.budget.reserve(KEY, 5)).toBe(false);
    expect(readFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "utf8")).toBe(before);
  });

  it("an anchor reached through a link into the converted store is refused by its real path", async () => {
    mkdirSync(`${storeDir}-sqlite`);
    symlinkSync(`${storeDir}-sqlite`, join(root, "conv-alias"));
    refused(await qualify({ anchorDir: join(root, "conv-alias", "anchor") }), "not-separate");
    expect(existsSync(join(`${storeDir}-sqlite`, "anchor"))).toBe(false);
  });

  it("the storage check runs inside the lock, just before the rename: a swap mid-commit refuses and keeps the old ledger", async () => {
    await (await durable()).budget.initialize();
    now = DAY2;
    const sub = join(anchorDir, "review-judge");
    const io: JudgeBudgetIo = {
      writeSynced: async (path, text) => {
        writeFileSync(path, text, { flag: "wx", mode: 0o600 });
        if (path.startsWith(join(storeDir, "review-judge"))) {
          // Between the write and the rename, the anchor's ledger folder becomes a link into the store.
          mkdirSync(join(storeDir, "elsewhere"));
          renameSync(sub, join(storeDir, "elsewhere", "review-judge"));
          symlinkSync(join(storeDir, "elsewhere", "review-judge"), sub);
        }
      },
      rename: async (from, to) => renameSync(from, to),
      syncDirectory: async () => {},
    };
    const before = readFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "utf8");
    const q = await qualifiedJudgeBudget({ storeDir, workspaceId: WORKSPACE, anchorDir, platform, now: clock, io });
    expect(q.status).toBe("durable");
    if (q.status !== "durable") return;
    expect(await q.budget.reserve(KEY, 5)).toBe(false);
    expect(readFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "utf8")).toBe(before);
  });

  it("replace is locked and guarded: before the rename nothing changes; after it, the outcome is reported uncertain", async () => {
    const q = await durable();
    await q.budget.initialize();
    now = DAY2;
    expect(await q.budget.reserve(KEY, 5)).toBe(true);
    const before = readFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "utf8");
    const failing = (failOn: "budget" | "anchor"): JudgeBudgetIo => ({
      writeSynced: async (path, text) => writeFileSync(path, text, { flag: "wx", mode: 0o600 }),
      rename: async (from, to) => {
        if (to.endsWith(failOn === "budget" ? "budget.json" : "budget-anchor.json")) throw new Error("disk full");
        renameSync(from, to);
      },
      syncDirectory: async () => {},
    });
    const withIo = async (io: JudgeBudgetIo) => {
      const r = await qualifiedJudgeBudget({ storeDir, workspaceId: WORKSPACE, anchorDir, platform, now: clock, io });
      if (r.status !== "durable") throw new Error("expected durable");
      return r.budget;
    };
    // The budget's own rename fails: reported as a change that may have begun, never as nothing changed.
    expect(await (await withIo(failing("budget"))).replace()).toEqual({ status: "uncertain" });
    expect(readFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "utf8")).toBe(before);
    // A clock that cannot be read: refused before anything, the old budget still counting.
    now = Number.NaN;
    expect(await q.budget.replace()).toEqual({ status: "refused", reason: "clock" });
    now = DAY2;
    expect(readFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "utf8")).toBe(before);
    expect(await q.budget.reserve(KEY, 5)).toBe(true);
    // The anchor's commit fails after the budget was replaced: uncertain, and calls are refused until a reset succeeds.
    expect(await (await withIo(failing("anchor"))).replace()).toEqual({ status: "uncertain" });
    expect(await q.budget.reserve(KEY, 5)).toBe(false);
    expect(await q.budget.replace()).toEqual({ status: "initialized", day: "2026-11-23" });
    expect(await q.budget.reserve(KEY, 5)).toBe(false); // the replacement's first day is spent
    now = DAY3;
    expect(await q.budget.reserve(KEY, 5)).toBe(true);
  });

  it("inspection is read-only and tells uninitialized, ready and refused apart", async () => {
    const inspect = () => inspectJudgeBudget({ storeDir, workspaceId: WORKSPACE, anchorDir, platform, now: clock });
    expect(await inspect()).toMatchObject({
      status: "eligible",
      anchorCreated: false,
      budget: { state: "uninitialized" },
    });
    expect(existsSync(anchorDir)).toBe(false);
    expect(existsSync(join(storeDir, "review-judge"))).toBe(false);
    refused(
      (await inspectJudgeBudget({
        storeDir,
        workspaceId: WORKSPACE,
        anchorDir: join(storeDir, "a"),
        platform,
      })) as QualifiedJudgeBudget,
      "not-separate",
    );
    const q = await durable();
    expect(await inspect()).toMatchObject({ anchorCreated: true, budget: { state: "uninitialized" } });
    await q.budget.initialize();
    const listing = () => [readdirSync(join(storeDir, "review-judge")), readdirSync(join(anchorDir, "review-judge"))];
    const files = listing();
    expect(await inspect()).toMatchObject({
      budget: { state: "ready", initializedDay: "2026-11-22", day: "2026-11-22" },
    });
    expect(listing()).toEqual(files); // no lock or temporary file left
    rmSync(join(anchorDir, JUDGE_BUDGET_ANCHOR_FILENAME));
    expect(await inspect()).toMatchObject({ budget: { state: "refused" } });
    writeFileSync(join(storeDir, JUDGE_BUDGET_FILENAME), "{");
    expect(await inspect()).toMatchObject({ budget: { state: "refused" } });
  });
});
