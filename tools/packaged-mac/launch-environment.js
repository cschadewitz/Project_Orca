/** Explicit minimal app environment for the future #388 harness; never inherit tooling state. */
import { posix } from "node:path";
import { SYSTEM_PATH } from "./executor-preflight.js";

export class LaunchEnvironmentError extends Error {
  constructor(code) {
    super(`Packaged Mac environment refused [${code}]`);
    this.code = code;
  }
}

function absoluteDirectory(value) {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    value.isWellFormed() &&
    value.startsWith("/") &&
    value !== "/" &&
    posix.normalize(value) === value &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    !value.endsWith("/")
  );
}

/**
 * accountHome must be the existing disposable OS account's actual home, not a substitute
 * for an account/VM boundary. temporaryDirectory must be independently verified owned
 * scratch. Syntax checks here establish neither filesystem ownership nor OS isolation.
 * No ambient environment is read, spread, changed or retained, including process.env.
 */
export function createMacAppEnvironment(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((key) => !["accountHome", "temporaryDirectory", "locale"].includes(key))
  ) {
    throw new LaunchEnvironmentError("INPUT");
  }
  const { accountHome, temporaryDirectory, locale = "en_US.UTF-8" } = input;
  if (!absoluteDirectory(accountHome) || !absoluteDirectory(temporaryDirectory)) {
    throw new LaunchEnvironmentError("DIRECTORY_SYNTAX");
  }
  if (temporaryDirectory === accountHome || accountHome.startsWith(`${temporaryDirectory}/`)) {
    throw new LaunchEnvironmentError("SCRATCH_BOUNDARY");
  }
  if (typeof locale !== "string" || !/^(?:C|[a-z]{2}_[A-Z]{2}\.UTF-8)$/.test(locale)) {
    throw new LaunchEnvironmentError("LOCALE");
  }
  return Object.freeze({
    HOME: accountHome,
    TMPDIR: temporaryDirectory,
    PATH: SYSTEM_PATH,
    LANG: locale,
    LC_CTYPE: locale,
  });
}
