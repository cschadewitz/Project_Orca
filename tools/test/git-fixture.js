/** A throwaway Git repository for the CI selector tests, which commit to it dozens of times each. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../ci-shadow/git.js";

/**
 * `prefix` names the temporary directory and `message` is the commit message of every
 * `save()`. The helpers go through the selector's own `git`, so a fixture reads Git exactly
 * as the code under test does.
 */
export function createGitFixture({ prefix, message }) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const command = (...args) => git(directory, args).toString().trim();
  command("init", "-q");
  command("config", "user.name", "CI fixture");
  command("config", "user.email", "ci@example.invalid");
  // After a commit Git starts `git maintenance run --auto` as a second process. Nothing here
  // lives long enough to need repacking, so it would only be a spawn per save().
  command("config", "maintenance.auto", "false");
  command("config", "gc.auto", "0");
  return {
    directory,
    command,
    write(path, content) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    },
    /** Commit everything in the work tree and return the new HEAD. */
    save() {
      command("add", "-A");
      command("commit", "-qm", message);
      return command("rev-parse", "HEAD");
    },
    /** Return the work tree to `base` (detached) and drop whatever a scenario left untracked. */
    reset(base) {
      command("checkout", "-q", "--detach", base);
      command("clean", "-fdq");
    },
    remove() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
