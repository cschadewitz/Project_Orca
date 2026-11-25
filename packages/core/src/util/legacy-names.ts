/**
 * Reading the names from before the rename to Orrery (0.9), for one release.
 *
 * The rule is write the new name, read both: environment variables and file names from before
 * the rename keep working through 0.9, each with a warning on stderr, and 0.10 removes these
 * reads. Nothing here ever writes an old name.
 *
 * The old names are marked `rename-keep` so the codemod leaves them alone. Until it runs, the
 * old and new names are the same string and every function here does nothing.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The prefix of every environment variable ORCA reads. */
export const ENV_PREFIX = "ORCA_";
/** The prefix before the rename. Read until 0.10, never written. */
export const LEGACY_ENV_PREFIX = "ORCA_"; // rename-keep: the pre-rename env prefix, read for one release

const stderrWarn = (message: string): void => void process.stderr.write(`${message}\n`);
const warned = new Set<string>();

/** Warn once per process for `key`. */
function warnOnce(key: string, message: string, warn: (message: string) => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** Forget which warnings were given, so a test can see them again. */
export function resetLegacyNameWarnings(): void {
  warned.clear();
}

/**
 * Move every `legacyPrefix*` variable in `env` whose `prefix*` counterpart is unset across to
 * that counterpart, warning once per name. The legacy variable is removed: a launch variable the
 * caller deletes after reading it so that no child inherits it (`ORCA_FIRST_RUN_LAUNCH`, the store
 * switch request) must not come back from its old name in the next process. A legacy variable
 * whose counterpart is already set is left alone; the new name wins. Returns the names set.
 */
export function adoptEnvPrefix(
  env: NodeJS.ProcessEnv,
  legacyPrefix: string,
  prefix: string,
  warn: (message: string) => void = stderrWarn,
): string[] {
  const adopted: string[] = [];
  if (legacyPrefix === prefix) return adopted;
  for (const legacy of Object.keys(env)) {
    if (!legacy.startsWith(legacyPrefix)) continue;
    const value = env[legacy];
    const name = prefix + legacy.slice(legacyPrefix.length);
    if (value === undefined || env[name] !== undefined) continue;
    env[name] = value;
    delete env[legacy];
    adopted.push(name);
    warnOnce(`env:${legacy}`, `warning: ${legacy} is deprecated, set ${name} instead (read until 0.10)`, warn);
  }
  return adopted;
}

/**
 * Adopt the environment variables from before the rename (`ORCA_*` into `ORRERY_*`). Every entry
 * point calls it first, before anything reads the environment: the CLI (and so `serve`), the
 * desktop app's main process, and scripts that read the product's variables. Idempotent.
 */
export function adoptLegacyEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = stderrWarn,
): string[] {
  return adoptEnvPrefix(env, LEGACY_ENV_PREFIX, ENV_PREFIX, warn);
}

/**
 * The file to read for `name` in `dir`: `name` when it exists, otherwise `legacyName` when that
 * exists (with a warning, once), otherwise `name`. Writers always write `name`.
 */
export function legacyFallbackPath(
  dir: string,
  name: string,
  legacyName: string,
  warn: (message: string) => void = stderrWarn,
): string {
  const path = join(dir, name);
  if (name === legacyName || existsSync(path)) return path;
  const legacy = join(dir, legacyName);
  if (!existsSync(legacy)) return path;
  warnOnce(`file:${legacy}`, `warning: reading ${legacy}; rename it to ${name} (the old name is read until 0.10)`, warn);
  return legacy;
}
