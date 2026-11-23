/**
 * The trusted target check for plain-language rules (#701, first rollout). The judged lane may only allow a `read`
 * or `search` whose real targets ORCA itself has verified; this is that verification, and its result is what the
 * evaluation slot passes to `judgePermission` as `targetsVerified` (and as the locations the judge sees).
 *
 * A target is verified only when all of these hold, checked on the file system rather than on the text the agent
 * sent:
 * - the call is a `read` or `search` and names at least one location;
 * - the workspace is an absolute path that exists, and ORCA's protected paths are known (no list, no verification);
 * - every location exists and is a single regular file. A directory is refused, because verifying a directory does
 *   not verify what a recursive read or search under it would reach; a file with more than one hard link is refused,
 *   because another of its names may sit outside the workspace or under a protected path where no path check sees it;
 * - containment holds by file-system identity and by text, both: one of the file's real ancestors is the workspace
 *   itself (same device and inode), and the file's real path is the workspace's real path plus more segments,
 *   compared exactly. Case is never folded here: whether a file system ignores case is a property of the mount, not
 *   of the OS, so a target whose real path differs from the workspace's only by case is refused rather than guessed;
 * - no location is under a protected path for reading: `protectedPathFor` (the same check that denies ahead of every
 *   rule), and, on top of it, no real ancestor of the file is a no-access path by identity, and no real path matches
 *   one ignoring case. Protection over-matches on purpose; containment under-matches on purpose.
 *
 * Only "no such file" counts as absence. A permission, I/O or identity failure anywhere the check needs evidence (the
 * workspace, a target, any of its ancestors, an existing no-access path) refuses the call as `unverifiable`.
 *
 * The check runs at decision time, and that is its limit. The allow it can lead to is one-time and the slot re-checks
 * protected paths in the same turn it answers, but a file or link swapped after that, before the agent's own open,
 * is outside what any check on the request can see: that window closes only with ORCA-owned execution (#703), and is
 * why writes and commands stay with the person. Never throws.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { protectedPathFor, type ProtectedPaths } from "./permissions.js";

export type PlainRuleTargetRefusal =
  | "kind"
  | "no-location"
  | "too-many-locations"
  | "no-workspace"
  | "no-protected-paths"
  | "missing"
  | "outside-workspace"
  | "protected"
  | "not-a-file"
  | "linked-file"
  | "unverifiable";

export type PlainRuleTargetCheck =
  | {
      readonly targetsVerified: true;
      /** Each target's real path, relative to the workspace's real path, `/`-separated. Always files. */
      readonly locations: readonly string[];
    }
  | { readonly targetsVerified: false; readonly reason: PlainRuleTargetRefusal };

/** What the check reads from the file system. Injected only by tests, to stand in for file systems the host lacks. */
export interface PlainRuleTargetIo {
  /** The real path, every link followed, as the file system spells it. Throws when missing. */
  realpath(path: string): string;
  /** Throws when missing. `dev` and `ino` identify the file; `nlink` counts its hard links. */
  stat(path: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly nlink: bigint;
  };
}

const NODE_IO: PlainRuleTargetIo = {
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path, { bigint: true }),
};

const MAX_LOCATIONS = 32;

function segments(path: string, foldCase: boolean): string[] {
  return (foldCase ? path.toLowerCase() : path).split(sep === "\\" ? /[\\/]+/ : /\/+/).filter((s) => s !== "");
}

function within(inner: readonly string[], outer: readonly string[]): boolean {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i]);
}

/** Thrown when the file system could not answer: permission, I/O, or an identity it would not give. */
class Unverifiable extends Error {}

/** Only "no such file" is absence; every other failure leaves the question open. */
function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The real path of an existing file or directory; undefined only when it confirmably does not exist. */
function real(io: PlainRuleTargetIo, path: string): string | undefined {
  try {
    const resolved = io.realpath(path);
    io.stat(resolved);
    return resolved;
  } catch (error) {
    if (isAbsence(error)) return undefined;
    throw new Unverifiable();
  }
}

/** The identity of an existing file. Any failure, absence included, is unverifiable: the caller knows it exists. */
function identity(io: PlainRuleTargetIo, path: string): string {
  try {
    const s = io.stat(path);
    if (typeof s.dev !== "bigint" || typeof s.ino !== "bigint" || s.ino === 0n) throw new Unverifiable();
    return `${s.dev}:${s.ino}`;
  } catch {
    throw new Unverifiable();
  }
}

/** The identities of every real ancestor of `path`, nearest first, up to the file system root. All must answer. */
function ancestorIdentities(io: PlainRuleTargetIo, path: string): string[] {
  const ids: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    ids.push(identity(io, dir));
    if (dirname(dir) === dir) return ids;
  }
}

export function verifyPlainRuleTargets(input: {
  readonly kind: string | undefined;
  readonly locations: readonly string[] | undefined;
  readonly workspaceCwd: string | undefined;
  readonly protectedPaths: ProtectedPaths | undefined;
  /** Tests only. */
  readonly io?: PlainRuleTargetIo;
}): PlainRuleTargetCheck {
  const refuse = (reason: PlainRuleTargetRefusal): PlainRuleTargetCheck =>
    Object.freeze({ targetsVerified: false as const, reason });
  try {
    const { kind, locations, workspaceCwd, protectedPaths } = input;
    const io = input.io ?? NODE_IO;
    if (kind !== "read" && kind !== "search") return refuse("kind");
    if (!Array.isArray(locations) || locations.length === 0) return refuse("no-location");
    if (locations.length > MAX_LOCATIONS) return refuse("too-many-locations");
    if (typeof workspaceCwd !== "string" || !isAbsolute(workspaceCwd)) return refuse("no-workspace");
    if (!protectedPaths || !Array.isArray(protectedPaths.noAccess) || !Array.isArray(protectedPaths.readOnly))
      return refuse("no-protected-paths");
    const root = real(io, workspaceCwd);
    if (root === undefined || !io.stat(root).isDirectory()) return refuse("no-workspace");
    const rootId = identity(io, root);
    const rootSegments = segments(root, false);
    // No-access paths, by identity where they exist and by case-folded real path either way.
    const guardIds = new Set<string>();
    const guardSegments: string[][] = [];
    for (const guard of protectedPaths.noAccess) {
      if (typeof guard !== "string" || !isAbsolute(guard)) return refuse("no-protected-paths");
      const resolved = real(io, guard);
      // A guard that confirmably does not exist still guards by text; one the file system would not answer for
      // leaves the whole check unverified.
      if (resolved !== undefined) guardIds.add(identity(io, resolved));
      guardSegments.push(segments(resolved ?? guard, true));
    }
    const verified: string[] = [];
    for (const location of [...locations]) {
      if (typeof location !== "string" || location.length === 0 || location.includes("\0")) return refuse("missing");
      // Joined as text, not with `join`, so `sub/..` is resolved through any link in it, not folded lexically.
      const target = real(io, isAbsolute(location) ? location : `${workspaceCwd}${sep}${location}`);
      if (target === undefined) return refuse("missing");
      const targetSegments = segments(target, false);
      const ancestors = ancestorIdentities(io, target);
      if (!within(targetSegments, rootSegments)) return refuse("outside-workspace");
      if (targetSegments.length > rootSegments.length && !ancestors.includes(rootId)) {
        return refuse("outside-workspace");
      }
      const targetId = identity(io, target);
      if (
        protectedPathFor(target, "read", protectedPaths, workspaceCwd) !== undefined ||
        guardIds.has(targetId) ||
        ancestors.some((id) => guardIds.has(id)) ||
        guardSegments.some((guard) => within(segments(target, true), guard))
      ) {
        return refuse("protected");
      }
      const stats = io.stat(target);
      if (!stats.isFile()) return refuse("not-a-file");
      if (stats.nlink !== 1n) return refuse("linked-file");
      verified.push(relative(root, target).split(sep).join("/"));
    }
    return Object.freeze({ targetsVerified: true as const, locations: Object.freeze(verified) });
  } catch {
    // Unverifiable, or anything unexpected: never a verification.
    return refuse("unverifiable");
  }
}
