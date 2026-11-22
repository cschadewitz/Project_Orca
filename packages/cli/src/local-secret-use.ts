/**
 * The secret use decision for an orchestrator this process runs locally (#336): `orca run`,
 * `submit`, `resume`, `answer` and the rest, in a fresh process or after a restart. It is
 * the daemon's decision, made from the same files: the root run's durable owner (the
 * ownership file every admission writes) and that owner's credentials as they are now.
 *
 * Which authority applies is decided at each decision, not at startup:
 * - With a credentials or local token file, the owner's current credentials decide, exactly
 *   as in `orca serve`.
 * - Without either (standalone mode), the verified OS user owns the config directory and the
 *   secrets it declares outright, so runs it owns may use every reference. That ends the
 *   moment a credentials file appears.
 *
 * Every decision is appended to `auth/audit.jsonl`. A run with no recorded owner, such as a
 * direct `orca run` with `--cwd` or selection overrides (which bypasses admission), is
 * refused: that path does not support secret references.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  AUDIT_FILE,
  CREDENTIALS_FILE,
  CredentialStore,
  FileAuditSink,
  LOCAL_TOKEN_FILE,
  OWNERSHIP_FILE,
  OwnershipStore,
  RunAccess,
  UNRESTRICTED,
  orchestratorResolver,
  secretUseAuthority,
  type AuditSink,
  type Principal,
  type ResolverSource,
  type SecretUseCheck,
} from "@orca/daemon";

/** The standalone principal id of an OS user (`local-submission-authority.ts` records it). */
export function osUserPrincipalId(user: { uid: number; username: string } = userInfo()): string {
  return `os-user-${createHash("sha256")
    .update(JSON.stringify([user.uid, user.username]))
    .digest("hex")
    .slice(0, 32)}`;
}

export function localSecretUse(app: {
  configDir: string;
  storeDir: string;
  orchestrator: ResolverSource;
}): SecretUseCheck {
  const authDir = join(app.configDir, "auth");
  const credentialsFile = join(authDir, CREDENTIALS_FILE);
  const tokenFile = join(authDir, LOCAL_TOKEN_FILE);
  const ownership = new OwnershipStore(join(authDir, OWNERSHIP_FILE));
  const credentials = new CredentialStore({ file: credentialsFile });
  const runs = new RunAccess(orchestratorResolver(app.orchestrator), ownership);
  const configured = () => existsSync(tokenFile) || existsSync(credentialsFile);
  let sink: AuditSink | undefined;
  const audit: AuditSink = {
    record(entry) {
      try {
        if (!sink) {
          mkdirSync(authDir, { recursive: true, mode: 0o700 });
          sink = new FileAuditSink(join(authDir, AUDIT_FILE));
        }
        sink.record(entry);
      } catch (e) {
        process.stderr.write(`orca: audit log write failed: ${(e as Error).message}\n`);
      }
    },
  };
  const localUser = userInfo();
  const osPrincipal = osUserPrincipalId(localUser);
  /** Standalone mode's grant: the same OS user, owning both directories, with no credentials. */
  const standalone = (id: string): Principal[] => {
    if (id !== osPrincipal || configured()) return [];
    const current = userInfo();
    if (current.uid !== localUser.uid || current.username !== localUser.username) return [];
    if (process.platform !== "win32")
      for (const dir of [app.configDir, resolve(app.storeDir)])
        if (statSync(dir, { throwIfNoEntry: false })?.uid !== localUser.uid) return [];
    return [{ id, kind: "local", permissions: new Set(["secrets.use"]), scope: UNRESTRICTED, secrets: "*" }];
  };
  return secretUseAuthority({
    root: (runId) => runs.root(runId),
    owner: (root) => ownership.owner(root),
    verifyOwner: (root, principalId) => ownership.verify(root, principalId),
    principals: (id) => (configured() ? credentials.currentForPrincipal(id) : standalone(id)),
    audit,
  });
}
