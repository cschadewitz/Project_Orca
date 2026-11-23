/**
 * `orca remote enroll <id>` (#883): the one deliberate step that lets this daemon delegate
 * steps to a configured remote. It connects once (the only connect that may pin the remote's
 * host keys on first use), checks the credential there, and records what it proved; every
 * later delegation trusts only that record.
 *
 * With no saved credential, or with `--issue`, the remote's ORCA CLI issues one over the same
 * verified ssh (#883 part 4): a client credential for this workspace's own principal, scoped
 * to the workflows this config's agents delegate to that remote.
 */
import { assertNoUnownedFirstRunMutation } from "@orca/protocol/first-run-fence";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import { enrollRemote, readRemoteCredential, remoteFiles, remoteProfile } from "@orca/daemon";
import { workspaceIdentity } from "@orca/store";
import { loadConfig } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

export async function remoteEnrollCommand(ctx: CommandContext): Promise<number> {
  const [, id, ...extra] = ctx.positionals;
  if (!id || extra.length) throw new OrcaError("CONFIG_INVALID", "remote enroll needs one remote id from remotes:");
  const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
  assertNoUnownedFirstRunMutation(resolve(configDir));
  const remote = config.remotes.find((r) => r.id === id);
  if (!remote) throw new OrcaError("CONFIG_INVALID", `no remotes[] entry has id ${id}`);
  const profile = remoteProfile(remote);
  const files = remoteFiles(configDir, remote);
  const issue = ctx.flags.issue === true || !existsSync(files.credentialFile);
  const workflows = [
    ...new Set(
      config.agents.flatMap((a) =>
        a.type === "orca-daemon" && a.profile === id && a.workflow !== undefined ? [a.workflow] : [],
      ),
    ),
  ].sort();
  const record = await enrollRemote({
    remote,
    profile,
    knownHostsFile: files.knownHostsFile,
    file: files.enrollmentFile,
    ...(issue
      ? {
          issue: {
            principal: `delegate-${await workspaceIdentity(resolve(configDir, config.storeDir))}`,
            workflows,
            credentialFile: files.credentialFile,
          },
        }
      : { token: readRemoteCredential(remote, files.credentialFile) }),
    hostKeys: (ctx.flags["host-key"] as string[] | undefined) ?? [],
    jumpHostKeys: (ctx.flags["jump-host-key"] as string[] | undefined) ?? [],
    warn: (message) => ctx.err(message),
  });
  if (ctx.flags.json) ctx.out(JSON.stringify(record, null, 2));
  else {
    ctx.out(`enrolled remote ${id}: workspace ${record.workspaceId}, principal ${record.principalId}`);
    if (record.issued)
      ctx.out(
        `issued credential ${record.credentialId} there (workflows ${workflows.join(", ")}), saved to ${files.credentialFile}`,
      );
    ctx.out(`host keys pinned in ${files.knownHostsFile}`);
  }
  return 0;
}
