/**
 * The local bootstrap path: how a client on the daemon's own machine gets a credential
 * without anyone copying a token around.
 *
 * At startup the daemon issues a fresh `owner` credential, revokes the one it issued last
 * time, and writes the token to `<authDir>/local-client.token`, readable by its owner alone.
 * A local client - the CLI, the desktop app's main process, an update supervisor - running as
 * the same user reads that file and sends the token. A process running as another user
 * cannot, which is the boundary loopback alone never gave. A client that is refused after
 * the daemon restarts re-reads the file once; that is the rotation working.
 *
 * Everything in the directory is the daemon's: the credentials file (hashes only), the
 * ownership map, the audit log and the token. It is created `0700` with a `.gitignore` of `*`
 * so a workspace under version control does not pick any of it up.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileAuditSink } from "./audit.js";
import { CredentialStore, parseToken } from "./credentials.js";
import { OwnershipStore } from "./ownership.js";

export const LOCAL_TOKEN_FILE = "local-client.token";
export const CREDENTIALS_FILE = "credentials.json";
export const OWNERSHIP_FILE = "ownership.json";
export const AUDIT_FILE = "audit.jsonl";
/** The principal the bootstrap credential speaks for. */
export const LOCAL_OWNER = "local-owner";

export interface AuthDirectory {
  dir: string;
  credentials: CredentialStore;
  ownership: OwnershipStore;
  audit: FileAuditSink;
  tokenFile: string;
}

/** Open (creating if needed) the daemon's auth directory and the three stores in it. */
export function openAuthDirectory(dir: string): AuthDirectory {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n", { mode: 0o600 });
  return {
    dir,
    credentials: new CredentialStore({ file: join(dir, CREDENTIALS_FILE) }),
    ownership: new OwnershipStore(join(dir, OWNERSHIP_FILE)),
    audit: new FileAuditSink(join(dir, AUDIT_FILE)),
    tokenFile: join(dir, LOCAL_TOKEN_FILE),
  };
}

/**
 * Issue this start's local owner credential and write its token file. Every earlier
 * bootstrap credential is revoked first, so at most one is ever live.
 */
export async function bootstrapLocalOwner(
  auth: Pick<AuthDirectory, "credentials" | "tokenFile">,
): Promise<{ credentialId: string }> {
  return auth.credentials.bootstrap(
    {
      principal: LOCAL_OWNER,
      label: "local client bootstrap",
      preset: "owner",
    },
    auth.tokenFile,
  );
}

/**
 * Read a local client token: the client half of the bootstrap path. `undefined` when the
 * file is absent or does not hold a token - never the file's contents in an error.
 */
export function readLocalToken(tokenFile: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(tokenFile, "utf8");
  } catch {
    return undefined;
  }
  const token = text.trim();
  return parseToken(token) ? token : undefined;
}
