/** Explicit OS-user admission for local CLI/stdio entry points, never network RPC. */
import { bindLocalAdmissionExecution } from "./admission-execution-authority.js";
import { createHash } from "node:crypto";
import { existsSync, constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { OrcaError, type OrcaConfig, type SubmissionAuthority } from "@orca/core";
import type { Orchestrator } from "@orca/engine";
import { workspaceIdentity } from "@orca/store";
import {
  Authorizer,
  CredentialStore,
  OwnershipStore,
  CREDENTIALS_FILE,
  LOCAL_TOKEN_FILE,
  OWNERSHIP_FILE,
  readLocalToken,
  submissionAuthority,
  directAdmissionAuthority,
  orchestratorResolver,
} from "@orca/daemon";
export async function localSubmissionAuthority(
  app: {
    config: OrcaConfig;
    configDir: string;
    orchestrator: Orchestrator;
  },
  mode: "request" | "direct" = "request",
): Promise<SubmissionAuthority> {
  const storeDir = resolve(app.configDir, app.config.storeDir);
  await mkdir(storeDir, { recursive: true });
  const workspaceId = await workspaceIdentity(storeDir);
  const authDir = join(app.configDir, "auth");
  const ownership = new OwnershipStore(join(authDir, OWNERSHIP_FILE));
  const tokenFile = join(authDir, LOCAL_TOKEN_FILE);
  const credentialsFile = join(authDir, CREDENTIALS_FILE);
  // A configured credential cannot silently fall back to standalone OS authority.
  if (existsSync(tokenFile) || existsSync(credentialsFile)) {
    const credentials = new CredentialStore({ file: credentialsFile });
    const token = readLocalToken(tokenFile);
    const authenticated = token ? credentials.authenticate(token) : undefined;
    if (!authenticated?.ok || !authenticated.principal.credentialId)
      throw new OrcaError("RUN_STATE", "a current local client credential is required");
    const principal = authenticated.principal;
    const credentialId = principal.credentialId!;
    const factory = mode === "request" ? submissionAuthority : directAdmissionAuthority;
    const authority = factory({
      workspaceId,
      actor: { principalId: principal.id, credentialId },
      authorizer: new Authorizer({ resolver: orchestratorResolver(app.orchestrator), ownership }),
      principal: async () => {
        const current = credentials.current(credentialId);
        if (!current.ok) throw new OrcaError("RUN_STATE", "local client authority is unavailable");
        return current.principal;
      },
    });
    const local: SubmissionAuthority = {
      ...authority,
      authorize: (command) =>
        authority.authorize(
          command as import("@orca/core").SubmissionCommand & import("@orca/core").DirectAdmissionCommand,
        ),
    };
    bindLocalAdmissionExecution(app.orchestrator, mode, local);
    return local;
  }
  const localUser = userInfo();
  const principalId = `os-user-${createHash("sha256")
    .update(JSON.stringify([localUser.uid, localUser.username]))
    .digest("hex")
    .slice(0, 32)}`;
  const verify = async () => {
    const current = userInfo();
    if (
      current.uid !== localUser.uid ||
      current.username !== localUser.username ||
      existsSync(tokenFile) ||
      existsSync(credentialsFile)
    )
      throw new OrcaError("RUN_STATE", "local process authority changed; restart the command");
    for (const dir of [app.configDir, storeDir]) {
      await access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
      const owner = await stat(dir);
      if (process.platform !== "win32" && owner.uid !== localUser.uid)
        throw new OrcaError("RUN_STATE", "local submission requires the workspace owner");
    }
  };
  await verify();
  const local: SubmissionAuthority = {
    workspaceId,
    actor: { principalId },
    authorize: verify,
    verifyRunAdmitted: async (runId) => {
      await verify();
      await ownership.verify(runId, principalId);
      await verify();
    },
    onRunAdmitted: async (runId) => {
      await verify();
      const existing = ownership.owner(runId);
      if (existing && existing !== principalId) throw new OrcaError("RUN_STATE", "run ownership changed");
      ownership.record(runId, principalId);
      await ownership.flush(runId);
      if (ownership.owner(runId) !== principalId)
        throw new OrcaError("STORE_WRITE", "Request ownership could not be persisted");
    },
  };
  bindLocalAdmissionExecution(app.orchestrator, mode, local);
  return local;
}

/** Reload configured credentials only for a new local submission/recovery intent.
 * Previously admitted execution retains its captured authority; this is not renewal.
 */
export function authorityForNewLocalIntent(
  app: Parameters<typeof localSubmissionAuthority>[0],
  initial: SubmissionAuthority,
): () => Promise<SubmissionAuthority> {
  return async () => {
    const current = await localSubmissionAuthority(app);
    if (current.workspaceId !== initial.workspaceId || current.actor.principalId !== initial.actor.principalId)
      throw new OrcaError("RUN_STATE", "local submission principal changed; restart the client");
    return current;
  };
}

export async function localDirectAdmissionAuthority(
  app: Parameters<typeof localSubmissionAuthority>[0],
): Promise<import("@orca/core").DirectAdmissionAuthority> {
  const authority = await localSubmissionAuthority(app, "direct");
  return { ...authority, authorize: (command) => authority.authorize({ title: "", body: "", ...command }) };
}
