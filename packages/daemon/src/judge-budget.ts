/**
 * The daemon's qualified judge budget (#701, item 2 of the activation plan): the one place that may present the
 * plain-rule judge's daily budget as durable.
 *
 * `daemonJudgeBudget` (`@orca/agents/judge-budget`, #1029) keeps the count at `<store>/review-judge/budget.json` and a high-water
 * mark at `<anchor>/review-judge/budget-anchor.json`, so restoring the store from a backup cannot hand back budget
 * that was already spent. On its own it reports `durable: false`, because it only checks that the two paths are spelled
 * apart. This module enforces what that primitive cannot, at construction, and again before every reservation:
 *
 * - **A supported platform.** Linux and macOS only. Windows (and anything else) is `unavailable`: Node cannot sync a
 *   directory there, so the replacement protocol is not verified, and the judge stays off on Windows.
 * - **A per-machine anchor directory that ORCA chose,** never a configured path: a per-user state directory outside
 *   every workspace, one directory per workspace identity (`judgeBudgetAnchorDir`). It is created owner-only (0700),
 *   and refused if it is a link, not a directory, not the daemon user's, or open to anyone else.
 * - **Physically separate directories.** Both are resolved to their real paths, and the file-system identity (device
 *   and inode) of every directory from each up to the root is compared: neither directory may be, or be inside, the
 *   other. A symbolic link, a bind mount or a second name for the same directory therefore cannot place the anchor
 *   inside the store, or the store inside the anchor.
 * - **Outside every supported restore.** Every restore ORCA supports writes only inside the store or a store it
 *   creates beside it (`supportedRestoreRoots`): carry-forward and its format backups (`<store>/format-backups/`), the
 *   SQLite switch back, `orca store sqlite restore` (`<store>/metadata.sqlite`), workspace identity repair, and
 *   `orca store sqlite convert`, which copies the store into `<store>-sqlite`. The anchor must lie outside all of them.
 *   Restoring any of them therefore cannot restore the anchor, and a budget rolled back with the store is refused
 *   until the owner initializes it again, which spends that day.
 * - **Checked where the ledger is written.** The budget primitive runs the storage check (`ledgerSeparated`) before it
 *   creates a directory, once it holds the budget lock, and again just before each rename. The check looks at the
 *   actual parents of both ledger files (`review-judge`): plain directories at their real paths, the store and anchor
 *   directories still the ones qualified, and by device and inode no supported restore root, `<store>-sqlite`
 *   included, above the anchor's ledger, and no anchor above the store's. Anything else refuses the operation and
 *   leaves the ledger as it was.
 * - **Read-only status.** `inspectJudgeBudget` runs the same checks without creating the anchor directory or taking
 *   the lock, and reports whether the budget is uninitialized, ready, or refused.
 *
 * What `durable` claims, and its scope. A budget file put back by any restore ORCA supports, or by copying an older
 * store or budget file into place, is refused, and so is a clock moved back before a day the anchor records. This
 * holds for the supported topology: the store and the anchor directory are ordinary local directories, the anchor
 * directory is the one ORCA chose under the user's own state directory, and nothing other than ORCA rearranges their
 * directories while the daemon runs. The storage check is a check at points in time (before the directories are
 * created, once the lock is held, just before each rename), not a hold on the directories: Node cannot open a
 * directory and write relative to it. So it does not claim to defend against a process of the same user swapping a
 * ledger directory for a link, or mounting something over it, in the instant between the last check and the rename,
 * nor against mounts added above either directory while the daemon runs; such a process can rewrite the files
 * directly anyway. Also not covered: rolling back both the store and the anchor to the same earlier pair (for example
 * restoring a whole disk or home directory from an image or snapshot that holds both), the same boundary as #1029's
 * coordinated rollback. The two may share a file system.
 *
 * Nothing here turns the judge on. Activation (item 3a) prepares the judge with this budget and refuses unless it is
 * `durable`.
 */
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  daemonJudgeBudget,
  JUDGE_BUDGET_ANCHOR_FILENAME,
  JUDGE_BUDGET_FILENAME,
  type FileJudgeBudget,
  type JudgeBudget,
  type JudgeBudgetIo,
  type JudgeBudgetState,
} from "@orca/agents/judge-budget";
import { CONVERTED_STORE_SUFFIX } from "@orca/store";

/** The platforms whose replacement protocol (write, sync, rename, sync the directory) is verified. */
export const JUDGE_BUDGET_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(["linux", "darwin"]);

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANCHORS = "orca-judge-budget-anchors";

export type JudgeBudgetUnavailableReason =
  /** Not Linux or macOS: the replacement protocol is not verified there (Windows). */
  | "platform"
  /** The workspace identity is not one. */
  | "workspace"
  /** The store directory is missing, a link, or not a directory. */
  | "store"
  /** The anchor directory could not be created, or is a link, not a directory, not this user's, or not private. */
  | "anchor"
  /** The anchor is, or is inside, the store or a supported restore's target, or the store is inside the anchor. */
  | "not-separate";

export type QualifiedJudgeBudget =
  | {
      readonly status: "durable";
      /** Reports `durable: true`. */
      readonly budget: JudgeBudget & Pick<FileJudgeBudget, "initialize" | "replace">;
      readonly storeDir: string;
      readonly anchorDir: string;
    }
  | { readonly status: "unavailable"; readonly reason: JudgeBudgetUnavailableReason };

export interface JudgeBudgetEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Where ORCA keeps the budget anchors on this machine for this user: `$XDG_STATE_HOME` (or `~/.local/state`) on Linux,
 * `~/Library/Application Support` on macOS, then `orca-judge-budget-anchors`. `undefined` on any other platform.
 */
export function judgeBudgetAnchorRoot(environment: JudgeBudgetEnvironment = {}): string | undefined {
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();
  const env = environment.env ?? process.env;
  if (!JUDGE_BUDGET_PLATFORMS.includes(platform) || !isAbsolute(home)) return undefined;
  if (platform === "darwin") return join(home, "Library", "Application Support", ANCHORS);
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), ANCHORS);
}

/** The anchor directory for one workspace: `<root>/<workspace id>`. */
export function judgeBudgetAnchorDir(
  workspaceId: string,
  environment: JudgeBudgetEnvironment = {},
): string | undefined {
  const root = judgeBudgetAnchorRoot(environment);
  return root && WORKSPACE_ID.test(workspaceId) ? join(root, workspaceId.toLowerCase()) : undefined;
}

/**
 * The directories a supported restore or conversion writes in, for a store at `storeDir` (a real path). The anchor
 * must be outside every one of them. Keep this list in step with `@orca/store`'s restore and convert operations.
 */
export function supportedRestoreRoots(storeDir: string): readonly string[] {
  return [storeDir, `${storeDir}${CONVERTED_STORE_SUFFIX}`];
}

const within = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

/** The identities of `path` (a real path) and every directory above it, up to the root. */
async function lineage(path: string): Promise<Identity[]> {
  const out: Identity[] = [];
  for (let at = path; ; at = dirname(at)) {
    const info = await stat(at, { bigint: true });
    out.push({ dev: info.dev, ino: info.ino });
    if (dirname(at) === at) return out;
  }
}

/** `path` with its deepest existing ancestor resolved to its real path, or `undefined` if that cannot be read. */
async function realAsFarAsExists(path: string): Promise<string | undefined> {
  const rest: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) return undefined;
      rest.push(basename(at));
    }
  }
}

/** A plain directory (not a link): its identity, or `undefined`. With `own`, also this user's and owner-only. */
async function plainDirectory(path: string, own = false): Promise<Identity | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory()) return undefined;
    if (own) {
      const uid = process.getuid?.();
      if (uid === undefined || info.uid !== BigInt(uid) || (info.mode & 0o077n) !== 0n) return undefined;
    }
    return { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

const LEDGER_DIR = dirname(JUDGE_BUDGET_FILENAME);
if (LEDGER_DIR !== dirname(JUDGE_BUDGET_ANCHOR_FILENAME))
  throw new Error("the budget and its anchor share a subdirectory name");

/**
 * Where a ledger file's parent is, for a directory at a real path: its `review-judge` subdirectory when that is a
 * plain directory at exactly that real path, the directory itself while the subdirectory does not exist yet, and
 * `undefined` for anything else (a link, a file, another real path, unreadable).
 */
async function ledgerParent(dir: string): Promise<string | undefined> {
  const sub = join(dir, LEDGER_DIR);
  try {
    const info = await lstat(sub);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return (await realpath(sub)) === sub ? sub : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? dir : undefined;
  }
}

/** The nearest existing directory at or above `path` (a path with real existing ancestors). */
async function nearestExisting(path: string): Promise<string> {
  for (let at = path; ; at = dirname(at)) {
    try {
      await stat(at);
      return at;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw error;
    }
  }
}

interface Storage {
  /** The store's real path. */
  readonly storeDir: string;
  /** The anchor directory's real path (or, while it does not exist, its path through its real existing ancestors). */
  readonly anchorDir: string;
  readonly storeId: Identity;
  /** `undefined` while the anchor directory does not exist (read-only inspection). */
  readonly anchorId: Identity | undefined;
}

/**
 * The storage check, at construction and inside every locked budget operation: the store and anchor directories are
 * still the ones qualified; each ledger's actual parent (`review-judge`, or the directory while that is missing) is
 * a plain directory at its real path; no directory from the anchor's ledger parent up to the root is the store, the
 * store converted beside it, or any other supported restore root (by device and inode, and by real path); and no
 * directory from the store's ledger parent up to the root is the anchor directory. Never throws.
 */
async function ledgerSeparated(storage: Storage): Promise<boolean> {
  try {
    const { storeDir, anchorDir, storeId, anchorId } = storage;
    const store = await plainDirectory(storeDir);
    if (!store || !same(store, storeId)) return false;
    if (anchorId) {
      const anchor = await plainDirectory(anchorDir, true);
      if (!anchor || !same(anchor, anchorId)) return false;
    } else {
      try {
        await lstat(anchorDir);
        return false; // Appeared since: inspect again.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    const storeLedger = await ledgerParent(storeDir);
    const anchorLedger = anchorId ? await ledgerParent(anchorDir) : anchorDir;
    if (storeLedger === undefined || anchorLedger === undefined) return false;
    const roots = supportedRestoreRoots(storeDir);
    if (roots.some((root) => within(root, anchorLedger)) || within(anchorLedger, storeDir)) return false;
    const rootIds: Identity[] = [];
    for (const root of roots)
      try {
        const info = await stat(root, { bigint: true });
        rootIds.push({ dev: info.dev, ino: info.ino });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    const [storeLine, anchorLine] = await Promise.all([
      lineage(storeLedger),
      lineage(anchorId ? anchorLedger : await nearestExisting(anchorLedger)),
    ]);
    if (anchorLine.some((id) => rootIds.some((root) => same(id, root)))) return false;
    if (anchorId && storeLine.some((id) => same(id, anchorId))) return false;
    return true;
  } catch {
    return false;
  }
}

export interface QualifiedJudgeBudgetOptions extends JudgeBudgetEnvironment {
  /** The store directory (`config.storeDir`, resolved). */
  readonly storeDir: string;
  /** The store's workspace identity (`workspaceIdentity(storeDir)`). */
  readonly workspaceId: string;
  /** Tests only: an anchor directory instead of the per-user one. It must still pass every check. */
  readonly anchorDir?: string;
  /** Tests only. */
  readonly now?: () => number;
  /** Tests only. */
  readonly io?: JudgeBudgetIo;
  readonly lockTimeoutMs?: number;
}

type Located =
  | { readonly ok: true; readonly storage: Storage }
  | { readonly ok: false; readonly reason: JudgeBudgetUnavailableReason };

/** Find and check the two directories. Creates the anchor directory only with `create`. */
async function locate(options: QualifiedJudgeBudgetOptions, create: boolean): Promise<Located> {
  const refuse = (reason: JudgeBudgetUnavailableReason): Located => ({ ok: false, reason });
  const platform = options.platform ?? process.platform;
  if (!JUDGE_BUDGET_PLATFORMS.includes(platform)) return refuse("platform");
  if (!WORKSPACE_ID.test(options.workspaceId)) return refuse("workspace");
  const chosen = options.anchorDir ?? judgeBudgetAnchorDir(options.workspaceId, options);
  if (!chosen) return refuse("anchor");

  // The store: an existing plain directory, at its real path.
  const givenStore = resolve(options.storeDir);
  const storeId = await plainDirectory(givenStore);
  if (!storeId) return refuse("store");
  let storeDir: string;
  try {
    storeDir = await realpath(givenStore);
  } catch {
    return refuse("store");
  }

  // Inside the store or a restore target, as spelled or through a link above it: refused before anything is created.
  const givenAnchor = resolve(chosen);
  const spelled = await realAsFarAsExists(givenAnchor);
  if (
    spelled === undefined ||
    [givenAnchor, spelled].some(
      (path) => supportedRestoreRoots(storeDir).some((root) => within(root, path)) || within(path, storeDir),
    )
  )
    return refuse("not-separate");

  let exists = true;
  try {
    await lstat(givenAnchor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("anchor");
    exists = false;
  }
  if (!exists && create)
    try {
      await mkdir(givenAnchor, { recursive: true, mode: 0o700 });
      exists = true;
    } catch {
      return refuse("anchor");
    }
  let storage: Storage;
  if (exists) {
    const anchorId = await plainDirectory(givenAnchor, true);
    if (!anchorId) return refuse("anchor");
    let anchorDir: string;
    try {
      anchorDir = await realpath(givenAnchor);
    } catch {
      return refuse("anchor");
    }
    storage = { storeDir, anchorDir, storeId, anchorId };
  } else storage = { storeDir, anchorDir: spelled, storeId, anchorId: undefined };

  return (await ledgerSeparated(storage)) ? { ok: true, storage } : refuse("not-separate");
}

/**
 * The daemon's budget, qualified: `durable` only when every prerequisite above holds, and every locked budget
 * operation checks the storage again (`ledgerSeparated`). Creates the anchor directory if it is missing, nothing
 * else. Never throws. The owner's `orca judge budget init` and `reset` use it, so they and the daemon share the files.
 */
export async function qualifiedJudgeBudget(options: QualifiedJudgeBudgetOptions): Promise<QualifiedJudgeBudget> {
  const located = await locate(options, true);
  if (!located.ok) return Object.freeze({ status: "unavailable", reason: located.reason });
  const { storage } = located;
  let inner: FileJudgeBudget;
  try {
    inner = daemonJudgeBudget(
      { stateDir: storage.storeDir, anchorDir: storage.anchorDir },
      {
        check: () => ledgerSeparated(storage),
        ...(options.now ? { now: options.now } : {}),
        ...(options.io ? { io: options.io } : {}),
        ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
      },
    );
  } catch {
    return Object.freeze({ status: "unavailable", reason: "not-separate" });
  }
  const budget = Object.freeze({
    durable: true as const,
    reserve: inner.reserve,
    initialize: inner.initialize,
    replace: inner.replace,
  });
  return Object.freeze({ status: "durable", budget, storeDir: storage.storeDir, anchorDir: storage.anchorDir });
}

export type JudgeBudgetInspection =
  | {
      readonly status: "eligible";
      readonly storeDir: string;
      readonly anchorDir: string;
      /** Whether the anchor directory exists yet (`init` creates it). */
      readonly anchorCreated: boolean;
      readonly budget: JudgeBudgetState;
    }
  | { readonly status: "unavailable"; readonly reason: JudgeBudgetUnavailableReason };

/**
 * Read-only: whether this machine can keep the budget durably, and what the budget's files say. Creates nothing,
 * takes no lock. `ready` is the state a reservation would accept; `refused` needs `orca judge budget reset`.
 */
export async function inspectJudgeBudget(options: QualifiedJudgeBudgetOptions): Promise<JudgeBudgetInspection> {
  const located = await locate(options, false);
  if (!located.ok) return Object.freeze({ status: "unavailable", reason: located.reason });
  const { storage } = located;
  const base = { status: "eligible" as const, storeDir: storage.storeDir, anchorDir: storage.anchorDir };
  if (!storage.anchorId) {
    // No anchor yet: a budget file without one is refused; none at all is uninitialized.
    let budgetExists = true;
    try {
      await lstat(join(storage.storeDir, JUDGE_BUDGET_FILENAME));
    } catch (error) {
      budgetExists = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    return Object.freeze({
      ...base,
      anchorCreated: false,
      budget: budgetExists ? ({ state: "refused", reason: "anchor" } as const) : ({ state: "uninitialized" } as const),
    });
  }
  const budget = await daemonJudgeBudget(
    { stateDir: storage.storeDir, anchorDir: storage.anchorDir },
    { check: () => ledgerSeparated(storage), ...(options.now ? { now: options.now } : {}) },
  ).inspect();
  return Object.freeze({ ...base, anchorCreated: true, budget });
}

/** Plain words for an unavailable budget, for the owner's command line. */
export function describeJudgeBudgetUnavailable(reason: JudgeBudgetUnavailableReason): string {
  switch (reason) {
    case "platform":
      return "The plain-language rule judge's budget cannot be kept durably on this platform, so the judge is not available here. It is supported on Linux and macOS; Windows is not supported yet.";
    case "workspace":
      return "This store has no valid workspace identity, so the judge's budget has nowhere to keep its anchor.";
    case "store":
      return "The store directory is missing, is a link, or is not a directory, so the judge's budget cannot be kept there.";
    case "anchor":
      return "ORCA could not create or trust the per-user directory that holds the judge budget's anchor. It must be a plain directory owned by you and open to no one else.";
    case "not-separate":
      return "The judge budget's anchor directory is inside the store (or the store is inside it), so restoring the store could roll the budget back. The anchor must be outside the store.";
  }
}
