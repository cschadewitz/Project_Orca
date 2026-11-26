/**
 * The feature flag registry (docs/WORKSTREAMS.md, #1239). Unfinished work with no target release
 * lands on main behind a flag here instead of waiting on a long-lived branch: it ships as dead
 * code in whatever release comes next, and a short promotion pull request turns it on in the
 * release that wants it. One list, so what is dark in a build is answered in one place.
 *
 * Stages:
 * - `incubating`: off in every build. Only a developer or a test turns it on, through the
 *   `ORCA_INCUBATING` environment variable (`all`, or flag names separated by commas). Never
 *   settable from app configuration, so it is off for anyone who does not launch the process
 *   with that override. That is a default, not an authorization boundary: whoever controls the
 *   process environment can reach incubating code.
 * - `experimental`: off unless the owner opts in (the caller passes the opt-in it read, such as a
 *   config switch), or `ORCA_EXPERIMENTAL` names it. `ORCA_EXPERIMENTAL` takes names only:
 *   `all` is reserved to the incubating test switch, so no setting opts into experiments added
 *   after it was written.
 * - `stable`: on. The flag and its checks are removed in the next minor.
 *
 * Dependency-free on purpose: CI reads this file directly (`.github/workflows/incubating.yml`).
 */

export type FeatureStage = "incubating" | "experimental" | "stable";

export interface FeatureFlag {
  /** kebab-case, unique. */
  readonly name: string;
  readonly stage: FeatureStage;
  /** The workstream's tracking issue. */
  readonly issue: number;
  /** One line: what turning it on does. */
  readonly summary: string;
}

/**
 * Every flag, in name order. A new workstream adds its flag here as `incubating` with its first
 * pull request; promotion moves it to `experimental` or `stable` in the release that ships it.
 */
export const FEATURES: readonly FeatureFlag[] = [];

export interface FeatureContext {
  /** Defaults to `process.env` where there is one. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Owner opt-ins for `experimental` flags, by name, as the caller read them. */
  readonly optIns?: Readonly<Record<string, boolean | undefined>>;
}

const named = (value: string | undefined, name: string, all: boolean): boolean =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === name || (all && part === "all"));

/** A registry over `flags`: `FEATURES` for the product, a fixture list in tests. */
export function featureRegistry(flags: readonly FeatureFlag[]) {
  const byName = new Map<string, FeatureFlag>();
  for (const flag of flags) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(flag.name))
      throw new Error(`feature flag "${flag.name}" is not kebab-case`);
    if (byName.has(flag.name)) throw new Error(`feature flag "${flag.name}" is listed twice`);
    if (!Number.isInteger(flag.issue) || flag.issue <= 0)
      throw new Error(`feature flag "${flag.name}" names no tracking issue`);
    byName.set(flag.name, flag);
  }
  const get = (name: string): FeatureFlag => {
    const flag = byName.get(name);
    if (!flag) throw new Error(`unknown feature flag "${name}"; add it to FEATURES (packages/core/src/features.ts)`);
    return flag;
  };
  return {
    flags,
    get,
    /** Whether `name` is on here. An unknown name throws, so a typo fails loudly. */
    enabled: (name: string, context: FeatureContext = {}): boolean => {
      const flag = get(name);
      const env = context.env ?? (typeof process === "undefined" ? {} : process.env);
      if (flag.stage === "stable") return true;
      if (flag.stage === "experimental")
        return context.optIns?.[name] === true || named(env.ORCA_EXPERIMENTAL, name, false);
      return named(env.ORCA_INCUBATING, name, true);
    },
    /** The flags at a stage, in name order. */
    atStage: (stage: FeatureStage): FeatureFlag[] => {
      return flags.filter((flag) => flag.stage === stage).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

const registry = featureRegistry(FEATURES);

/** Whether the product feature `name` is on (see the stages above). */
export const featureEnabled = registry.enabled;
/** The product's flags at a stage. */
export const featuresAt = registry.atStage;
