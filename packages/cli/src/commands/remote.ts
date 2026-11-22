/**
 * `orca remote enroll <id>` (#883): the one deliberate step that lets this daemon delegate
 * steps to a configured remote. It connects once (the only connect that may pin the remote's
 * host keys on first use), checks the credential there, and records what it proved; every
 * later delegation trusts only that record.
 */
import { assertNoUnownedFirstRunMutation } from "@orca/protocol/first-run-fence";
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import { enrollRemote, readRemoteCredential, remoteFiles, remoteProfile } from "@orca/daemon";
import { loadConfig } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

export async function remoteCommand(ctx: CommandContext): Promise<number> {
  const [sub, id, ...extra] = ctx.positionals;
  if (sub !== "enroll") throw new OrcaError("CONFIG_INVALID", "remote expects enroll <id>");
  if (!id || extra.length) throw new OrcaError("CONFIG_INVALID", "remote enroll needs one remote id from remotes:");
  const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
  assertNoUnownedFirstRunMutation(resolve(configDir));
  const remote = config.remotes.find((r) => r.id === id);
  if (!remote) throw new OrcaError("CONFIG_INVALID", `no remotes[] entry has id ${id}`);
  const profile = remoteProfile(remote);
  const files = remoteFiles(configDir, remote);
  const token = readRemoteCredential(remote, files.credentialFile);
  const record = await enrollRemote({
    remote,
    profile,
    knownHostsFile: files.knownHostsFile,
    file: files.enrollmentFile,
    token,
    hostKeys: (ctx.flags["host-key"] as string[] | undefined) ?? [],
    jumpHostKeys: (ctx.flags["jump-host-key"] as string[] | undefined) ?? [],
  });
  if (ctx.flags.json) ctx.out(JSON.stringify(record, null, 2));
  else {
    ctx.out(`enrolled remote ${id}: workspace ${record.workspaceId}, principal ${record.principalId}`);
    ctx.out(`host keys pinned in ${files.knownHostsFile}`);
  }
  return 0;
}
