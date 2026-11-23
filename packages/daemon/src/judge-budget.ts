/**
 * The daemon's qualified judge budget (#701, item 2 of the activation plan): the one place that may present the
 * plain-rule judge's daily budget as durable.
 *
 * `daemonJudgeBudget` (`@orca/agents`, #1029) keeps the count at `<store>/review-judge/budget.json` and a high-water
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
 * - **Unchanged since.** Before every reservation the store directory, the anchor directory and their `review-judge`
 *   subdirectories must still be the same directories (device and inode), not links. Anything else refuses the call.
 *
 * Not covered, and documented as such: rolling back both the store and the anchor to the same earlier pair (for
 * example restoring a whole disk or home directory from an image or snapshot that holds both). This is the same
 * boundary as #1029's coordinated rollback. The two may share a file system.
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
  type JudgeBudget,
  type JudgeBudgetInitResult,
  type JudgeBudgetIo,
} from "@orca/agents";
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
      readonly budget: JudgeBudget & { readonly initialize: () => Promise<JudgeBudgetInitResult> };
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

/** A `review-judge` subdirectory: absent, or a plain directory. Never a link or a file. */
async function subdirectoryIntact(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
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

/**
 * The daemon's budget, qualified: `durable` only when every prerequisite above holds. Never throws. Also the place
 * the owner's `orca judge budget init` gets the budget it initializes, so both use the same files.
 */
export async function qualifiedJudgeBudget(options: QualifiedJudgeBudgetOptions): Promise<QualifiedJudgeBudget> {
  const unavailable = (reason: JudgeBudgetUnavailableReason): QualifiedJudgeBudget =>
    Object.freeze({ status: "unavailable", reason });
  const platform = options.platform ?? process.platform;
  if (!JUDGE_BUDGET_PLATFORMS.includes(platform)) return unavailable("platform");
  if (!WORKSPACE_ID.test(options.workspaceId)) return unavailable("workspace");
  const chosen = options.anchorDir ?? judgeBudgetAnchorDir(options.workspaceId, options);
  if (!chosen) return unavailable("anchor");

  // The store: an existing plain directory, at its real path.
  const givenStore = resolve(options.storeDir);
  if (!(await plainDirectory(givenStore))) return unavailable("store");
  let storeDir: string;
  try {
    storeDir = await realpath(givenStore);
  } catch {
    return unavailable("store");
  }

  // The anchor: created owner-only if missing, then a plain private directory of this user's, at its real path.
  const givenAnchor = resolve(chosen);
  // Inside the store or a restore target, as spelled or through a link above it: refused before anything is created.
  const spelled = await realAsFarAsExists(givenAnchor);
  if (
    spelled === undefined ||
    [givenAnchor, spelled].some(
      (path) => supportedRestoreRoots(storeDir).some((root) => within(root, path)) || within(path, storeDir),
    )
  )
    return unavailable("not-separate");
  try {
    await mkdir(givenAnchor, { recursive: true, mode: 0o700 });
  } catch {
    return unavailable("anchor");
  }
  if (!(await plainDirectory(givenAnchor, true))) return unavailable("anchor");
  let anchorDir: string;
  try {
    anchorDir = await realpath(givenAnchor);
  } catch {
    return unavailable("anchor");
  }

  // Physically separate: by real path, and by device and inode all the way up.
  let storeLine: Identity[];
  let anchorLine: Identity[];
  try {
    [storeLine, anchorLine] = await Promise.all([lineage(storeDir), lineage(anchorDir)]);
  } catch {
    return unavailable("not-separate");
  }
  const storeId = storeLine[0]!;
  const anchorId = anchorLine[0]!;
  if (
    supportedRestoreRoots(storeDir).some((root) => within(root, anchorDir)) ||
    within(anchorDir, storeDir) ||
    anchorLine.some((id) => same(id, storeId)) ||
    storeLine.some((id) => same(id, anchorId))
  )
    return unavailable("not-separate");

  let inner: ReturnType<typeof daemonJudgeBudget>;
  try {
    inner = daemonJudgeBudget(
      { stateDir: storeDir, anchorDir },
      {
        ...(options.now ? { now: options.now } : {}),
        ...(options.io ? { io: options.io } : {}),
        ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
      },
    );
  } catch {
    return unavailable("not-separate");
  }

  // Before every use: still the same two directories, and their budget subdirectories are not links.
  const intact = async (): Promise<boolean> => {
    const [store, anchor] = await Promise.all([plainDirectory(storeDir), plainDirectory(anchorDir, true)]);
    if (!store || !anchor || !same(store, storeId) || !same(anchor, anchorId)) return false;
    const subdirectories = await Promise.all([
      subdirectoryIntact(dirname(join(storeDir, JUDGE_BUDGET_FILENAME))),
      subdirectoryIntact(dirname(join(anchorDir, JUDGE_BUDGET_ANCHOR_FILENAME))),
    ]);
    return subdirectories.every(Boolean);
  };

  const budget = Object.freeze({
    durable: true as const,
    reserve: async (key: string, limit: number): Promise<boolean> => {
      try {
        return (await intact()) && (await inner.reserve(key, limit));
      } catch {
        return false;
      }
    },
    initialize: async (): Promise<JudgeBudgetInitResult> => {
      try {
        if (!(await intact())) return { status: "refused", reason: "write" };
        return await inner.initialize();
      } catch {
        return { status: "refused", reason: "write" };
      }
    },
  });
  return Object.freeze({ status: "durable", budget, storeDir, anchorDir });
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
