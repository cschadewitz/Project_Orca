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
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JUDGE_BUDGET_ANCHOR_FILENAME, JUDGE_BUDGET_FILENAME, judgeBudgetKey } from "@orca/agents";
import {
  describeJudgeBudgetUnavailable,
  judgeBudgetAnchorDir,
  judgeBudgetAnchorRoot,
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
      "/state/orca-judge-budget-anchors",
    );
    expect(judgeBudgetAnchorRoot({ platform: "linux", home: "/home/a", env: { XDG_STATE_HOME: "rel" } })).toBe(
      "/home/a/.local/state/orca-judge-budget-anchors",
    );
    expect(judgeBudgetAnchorRoot({ platform: "darwin", home: "/Users/a", env: {} })).toBe(
      "/Users/a/Library/Application Support/orca-judge-budget-anchors",
    );
    expect(judgeBudgetAnchorRoot({ platform: "win32", home: "C:\\Users\\a", env: {} })).toBeUndefined();
    expect(judgeBudgetAnchorDir(WORKSPACE.toUpperCase(), { platform: "linux", home: "/h", env: {} })).toBe(
      `/h/.local/state/orca-judge-budget-anchors/${WORKSPACE}`,
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
    expect(await q.budget.initialize()).toEqual({ status: "refused", reason: "write" });
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
});
