/** Disposable managed/persistence integration probe; changes only this child's umask. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strictPermissionRuleRevision, type ScopedRuleGrantAuthority } from "@orca/agents";
import { ruleFixture } from "../../agents/test/strict-permission-fixtures.js";
import { createManagedTypedWorkspace, resolveManagedRootBinding } from "../src/typed-workspace-gate.js";

const [base, requested] = process.argv.slice(2);
if (!base || !requested || !/^[0-7]{3}$/.test(requested)) throw new Error("invalid disposable probe input");
const ambient = process.umask(Number.parseInt(requested, 8));
const config = join(base, "workspace"),
  control = join(base, "control"),
  releases = join(base, "releases");
const storeDir = join(config, ".orca"),
  sidecar = join(config, "orca.permissions.json");
for (const directory of [config, control, releases, storeDir, join(storeDir, "workspace-identity")])
  await mkdir(directory, { mode: 0o700 });
const identity = randomUUID() + "\n",
  identityPath = join(storeDir, "workspace-identity", "id");
await writeFile(identityPath, identity, { mode: 0o600 });
const binding = resolveManagedRootBinding(
  [
    { role: "config", path: config },
    { role: "sidecar", path: sidecar },
    { role: "store", path: storeDir },
  ],
  control,
  releases,
);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
await writeFile(join(control, "never-typed"), `${hash(identity)}\n${binding.rootBindingRef}\n`, { mode: 0o600 });
const temporaryModes: string[] = [];
const observeOwnership = () => {
  const temporary = `${sidecar}.${process.pid}.tmp`;
  if (existsSync(temporary)) temporaryModes.push((statSync(temporary).mode & 0o777).toString(8));
  return undefined;
};
const owner = createManagedTypedWorkspace({
  binding,
  lifetime: { mode: "enrollment", assertCurrent: observeOwnership },
  assertBuildCurrent: () => undefined,
  qualify: async () => {
    throw new Error("no production qualifier in probe");
  },
});
async function metadata(path: string) {
  const observed = await stat(path);
  return {
    mode: (observed.mode & 0o777).toString(8),
    uidMatches: observed.uid === process.getuid?.(),
    nlink: observed.nlink,
    size: observed.size,
    regular: observed.isFile(),
  };
}
const phases: { phase: string; metadata: Awaited<ReturnType<typeof metadata>> }[] = [];
try {
  const store = await owner.enrollFresh();
  phases.push({ phase: "initialized", metadata: await metadata(sidecar) });
  const external = await readFile(join(control, "enrolled.json"));
  const initial = await store.read(),
    rule = ruleFixture();
  const authority: ScopedRuleGrantAuthority = {
    actor: { principalId: "synthetic:principal" },
    authorizeGrant: async () => "synthetic:authority",
    verifyApproval: async () => ({ scopeEvidenceRef: "synthetic:scope" }),
    assertCommitCurrent: () => undefined,
  };
  const saved = await store.createScopedRule(
    {
      rule: { ...rule, ruleRevision: strictPermissionRuleRevision(rule) },
      expectedRevision: initial.revision,
      approvalRecordRef: "synthetic:approved",
    },
    authority,
  );
  phases.push({ phase: "created", metadata: await metadata(sidecar) });
  const revoked = await store.revokeScopedRule(
    {
      ruleId: saved.rule.ruleId,
      ruleRevision: saved.rule.ruleRevision,
      expectedRevision: saved.revision,
      approvalRecordRef: "synthetic:revoked",
    },
    authority,
  );
  phases.push({ phase: "revoked", metadata: await metadata(sidecar) });
  process.stdout.write(
    JSON.stringify({
      outcome: "saved",
      requested,
      phases,
      temporaryModes,
      identity: await metadata(identityPath),
      control: await metadata(join(control, "enrolled.json")),
      status: revoked.rule.status,
      enrolled: owner.inspect().state,
      revisionsChanged: initial.revision !== saved.revision && saved.revision !== revoked.revision,
      externalUnchanged: hash(external) === hash(await readFile(join(control, "enrolled.json"))),
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      outcome: "refused",
      requested,
      phases,
      temporaryModes,
      identity: await metadata(identityPath),
      control: await metadata(join(control, "intent.json")),
      sidecar: await metadata(sidecar),
      reason: error instanceof Error ? error.message : "unknown",
    }),
  );
} finally {
  process.umask(ambient);
}
