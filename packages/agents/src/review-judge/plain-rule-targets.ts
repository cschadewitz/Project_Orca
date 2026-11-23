/**
 * The trusted target check for plain-language rules (#701, first rollout). The judged lane may only allow a `read`
 * or `search` whose real targets ORCA itself has verified; this is that verification, and its result is what the
 * evaluation slot passes to `judgePermission` as `targetsVerified` (and as the locations the judge sees).
 *
 * A target is verified only when all of these hold, checked on the file system rather than on the text the agent
 * sent:
 * - the call is a `read` or `search` and names at least one location;
 * - the workspace is an absolute path that exists, and ORCA's protected paths are known (no list, no verification);
 * - every location exists, and its real path (every symlink followed, `..` taken from where a link leads) is the
 *   workspace's real path or below it, segment by segment;
 * - no location falls under a protected path for reading (`protectedPathFor`, the same check that denies ahead of
 *   every rule).
 *
 * The check runs at decision time. The allow it can lead to is one-time and the slot re-checks protected paths in the
 * same turn it answers, but a link swapped after that, before the agent's own open, is outside what a check on the
 * request can see: that window closes only with ORCA-owned execution (#703), and is why writes and commands stay
 * with the person. Never throws.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { protectedPathFor, type ProtectedPaths } from "../permissions.js";

export type PlainRuleTargetRefusal =
  | "kind"
  | "no-location"
  | "too-many-locations"
  | "no-workspace"
  | "no-protected-paths"
  | "missing"
  | "outside-workspace"
  | "protected";

export type PlainRuleTargetCheck =
  | {
      readonly targetsVerified: true;
      /** Each target's real path, relative to the workspace's real path, `/`-separated. */
      readonly locations: readonly string[];
    }
  | { readonly targetsVerified: false; readonly reason: PlainRuleTargetRefusal };

const MAX_LOCATIONS = 32;
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

function segments(path: string): string[] {
  return (FOLD_CASE ? path.toLowerCase() : path).split(sep === "\\" ? /[\\/]+/ : /\/+/).filter((s) => s !== "");
}

function within(inner: readonly string[], outer: readonly string[]): boolean {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i]);
}

/** The real path of an existing file or directory, or undefined. */
function real(path: string): string | undefined {
  try {
    const resolved = realpathSync.native(path);
    statSync(resolved);
    return resolved;
  } catch {
    return undefined;
  }
}

export function verifyPlainRuleTargets(input: {
  readonly kind: string | undefined;
  readonly locations: readonly string[] | undefined;
  readonly workspaceCwd: string | undefined;
  readonly protectedPaths: ProtectedPaths | undefined;
}): PlainRuleTargetCheck {
  const refuse = (reason: PlainRuleTargetRefusal): PlainRuleTargetCheck =>
    Object.freeze({ targetsVerified: false as const, reason });
  try {
    const { kind, locations, workspaceCwd, protectedPaths } = input;
    if (kind !== "read" && kind !== "search") return refuse("kind");
    if (!Array.isArray(locations) || locations.length === 0) return refuse("no-location");
    if (locations.length > MAX_LOCATIONS) return refuse("too-many-locations");
    if (typeof workspaceCwd !== "string" || !isAbsolute(workspaceCwd)) return refuse("no-workspace");
    if (!protectedPaths || !Array.isArray(protectedPaths.noAccess) || !Array.isArray(protectedPaths.readOnly))
      return refuse("no-protected-paths");
    const root = real(workspaceCwd);
    if (root === undefined) return refuse("no-workspace");
    const rootSegments = segments(root);
    const verified: string[] = [];
    for (const location of [...locations]) {
      if (typeof location !== "string" || location.length === 0 || location.includes("\0")) return refuse("missing");
      // Joined as text, not with `join`, so `sub/..` is resolved through any link in it, not folded lexically.
      const target = real(isAbsolute(location) ? location : `${workspaceCwd}${sep}${location}`);
      if (target === undefined) return refuse("missing");
      if (!within(segments(target), rootSegments)) return refuse("outside-workspace");
      if (protectedPathFor(target, "read", protectedPaths, workspaceCwd) !== undefined) return refuse("protected");
      verified.push(relative(root, target).split(sep).join("/") || ".");
    }
    return Object.freeze({ targetsVerified: true as const, locations: Object.freeze(verified) });
  } catch {
    return refuse("missing");
  }
}
