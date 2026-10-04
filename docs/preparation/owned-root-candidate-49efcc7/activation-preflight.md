# Read-only activation preflight — 2026-10-04 06:10 UTC

This report is an inactive proposal for Cal's review. It was prepared on `agent-01` from runtime source `49efcc7236ac127c952bb1f7a50fc6ef72f7df84` and PR #480 handoff `cd179c7be21573b36b6bb435456435e29736f6af`. The candidate checkout is `/srv/dev/worktrees/Project_Orca-prepare-49efcc7-candidate-validation-81dde16f`. No backup, installation, live configuration write, daemon or tunnel restart, credential change, admission, reconciliation, or agent launch was performed. Commands below are **proposed only** and need one later, explicit approval after their guards are refreshed.

## Preflight conclusions

| Check | Result |
| --- | --- |
| Build identity | **PASS.** Candidate compiled manifest: 1,009 `packages/*/dist` files, SHA-256 `ffc4e42345db96f5103613ac3a82be16409770f9b6df1a14c755d1a00b6aaf5f`. Lockfile SHA-256 `0a840533d8974ad2397ad297dfeb7f60bf9ec088728e3fb6680e3d65b62be5a4`. Key compiled hashes: CLI `0978c7dd9f1a074827b69c2972d7824b0544f3c2db55fedcc040f7b5d3358bd1`, owned-root worktree `ef7861dfa9e894a04087fc78d1313b4054051c735d82b613e25cba338b2814a`, MCP transport `21634ac36203d939f27aea4ce0e51ab6d0c4007c5ea67544b1f027399aaa71c6`. No source code differs from 49efcc7 in the candidate's later documentation commits. |
| Current runtime | **PASS, change required.** `/home/casey/.local/share/orca-runtime/3702da5b38dc449280c2837366615de741e9c45c` is the installed source tree (commit `3702da5b38dc449280c2837366615de741e9c45c`), with 1,001 compiled files and manifest SHA-256 `f4b7ddcd744c986e6bd6595001e6b90016ff3e06967f180240c7034797b34726`. The old and candidate CLI main, daemon methods, and all compiled MCP integration files inspected are byte-identical, but 39 common compiled files differ and the candidate adds owned-root support. |
| Executables and launcher | **PASS with supervision condition.** Live daemon PID 1600541 was a foreground job in an SSH shell on pts/1, running Node `/home/casey/.local/share/mise/installs/node/24.21.0/bin/node` with old CLI, `--config /home/casey/.orca-codex-work/orca.yaml serve --host 127.0.0.1 --port 33871`. The agent executable `/home/casey/.local/share/orca-adapters/codex-acp-2.1.1/node_modules/.bin/codex-acp` exists and is executable. Its args array is empty; neither it nor the daemon/tunnel argv forces the old task checkout or branch. There is no ORCA service unit or pidfile. A human/activation runner must retain control of a persistent pts/1 shell for the new foreground daemon; `systemctl restart` is not a valid plan. |
| Endpoint and tunnel | **CONDITIONAL.** The tunnel remains a separate foreground job on pts/2, with the same loopback endpoint `http://127.0.0.1:33871`. Its private `mcp-client.cjs` wrapper pins the old CLI path. Candidate CLI main and MCP transport hashes equal the current ones, so the proposal leaves the tunnel and wrapper untouched and retains the old runtime. Require an authenticated, read-only hello through this existing tunnel after restart. Tunnel standalone relaunch cannot be guaranteed from public argv alone because its inherited private credential context was deliberately not inspected. If the tunnel drops, stop the switch and recover its existing session/credential context under separate review. |
| Live configuration and permissions | **PASS.** `orca.yaml` SHA-256 `130b0ab6874d7b1208aa5c76256a2ece125173aab226320018ba2493dd45991a`; current workspace is `local` at the fixed source checkout. Merging the proposed workspace block parses under the candidate schema and changes only normalized `workspace`; agents, hosts, roles, plugins, workflow path setting, store setting, and the agent policy remain identical. `codex-worker` is on built-in host `local`, has default deny and seven existing rules, and its args do not pin a checkout. Live `work.yaml` is `cal-codex-work` v2, SHA-256 `deabb7cfd89ce12385a587741df1d2fe057d997f1817902aa90094bf179d0823`. Proposed v3 is revision `sha256:1949ae4b2dd7ed5cc33368a9ab7bb71f1d968071c91bdd42abf12cea80d057e7`. |
| Task Git paths and capacity | **PASS.** Canonical task source and sole registered worktree: `/home/casey/.local/share/orca-worktrees/mac-beta-codex`; common Git directory: `/home/casey/.local/share/orca-worktrees/mac-beta-codex/.git`. Source HEAD and `cal/mac-beta-codex` are at pinned commit `8875f4585d7e5cd038ec974f5c6c270f8c5f01c3`; checkout is clean and the object is a commit. Proposed root directory `/home/casey/.local/share/orca-worktrees/cal-codex-roots` does not yet exist; its parent is owned by `casey`, mode 0700, with no symlink in the checked path. `/srv/dev` has 176 GiB and 12.4 million inodes free. `/` has 23 GiB free. `/tmp` has only about 15 MiB free and must not hold scratch or backups. Do not remove another job's files. |
| Authorized live reads | **PASS within scoped visibility.** At 05:54 UTC, authenticated discovery reported ORCA 0.6.0, protocol 2.0, principal `cal-codex-work`, owned-run scope, workflow scope `cal-codex-work`, and exactly six grants: `runs.read`, `artifacts.read`, `workflows.read`, `runs.start`, `runs.control`, `inputs.answer`. Local wrapper `--check` returned 0; private credential is owner-owned mode 0600, unrevoked, with expiry `2026-10-04T18:36:49.521Z`. A refreshed read at 06:18 UTC returned 13 owned runs: nine v2 (four succeeded, four failed, **one stale**) and four v1; no owned active/waiting v2 run. The stale v2 run is `run_101bba0f-bdb2-4d96-b568-6d2085ff2b05`, captured with generation `6fa7bc7e-3a22-4053-8b97-220750fa65c0`; a read-only input query for it returned no pending input. Current v2 catalog generation is `ca117a12-e5ba-417e-ac60-ac08287a4d71`. This credential cannot prove the state of runs owned by other principals. Recheck immediately before quiescence and before smoke; expiration blocks smoke rather than silently changing credentials. |
| Format and proposal | **PASS.** `work-v3.proposed.yaml` was formatted as YAML without changing its parsed definition (canonical semantic SHA-256 before/after `2ba8207671fea528be6ffe4a4dfab6868fe198b540e6fa363548e0f14977cdcc`). `mise exec -- pnpm run format:check` now passes for the whole repository. The published proposal validator passes and pins the v3 revision, source SHA, smoke workflow version, and stable key. |

Tool versions used here: Node 24.21.0, pnpm 12.4.2, Git 2.47.3, Python 3.13.5 with PyYAML 6.0.2, GNU tar 1.35, tunnel client 0.0.15. GNU tar archive/compare syntax also passed on one synthetic file in an agent-owned disk-backed candidate scratch directory, which was removed afterward; no live backup was made. The prior report records the pinned build and 71 targeted plus 13 compiled acceptance tests. None were rebuilt or rerun during this read-only preflight.

## Compatibility and hold points

Both releases declare protocol 2.0 and store epoch `operator-journals-v4`. Equal epochs do **not** prove reverse snapshot compatibility: the candidate can record v3 generations and owned-root receipts that the old binary may not restore. Existing v2 runs retain captured provider/workflow generations; the stale v2 run must be preserved, not cancelled or silently resumed. Root isolation requires the built-in local Linux host. The workflow's one-agent-per-run text does not enforce an independent-run capacity cap; the owner must hold all other admissions through the first smoke. The tunnel stays live and may reconnect as soon as the daemon restarts, so this hold is operational, not a server-enforced maintenance lock.

Activation is **conditional** on (1) a fresh read showing no active/waiting work in the authorized scope and an owner-side check for any other principals, (2) owner control of the pts/1 foreground daemon and a plan to keep that session open, (3) the same scoped credential still valid at smoke time, (4) no concurrent Git writes to the task source during the backup, and (5) agreement to retain the old runtime because the unchanged tunnel wrapper references it. If any condition fails, do not run the switch commands.

## Exact proposed commands — not executed

Run the shell phases as `casey` on `agent-01` only after Cal approves the complete sequence. Refresh the read API status and Git/config/hash guards immediately first. The process-match command is deliberately pinned to the observed PID; if it changed, it fails instead of terminating a different process. Do not use `/tmp` or a different checkout.

```bash
set -euo pipefail
umask 077
C=/srv/dev/worktrees/Project_Orca-prepare-49efcc7-candidate-validation-81dde16f
P="$C/docs/preparation/owned-root-candidate-49efcc7"
H=/home/casey/.orca-codex-work
S=/home/casey/.local/share/orca-worktrees/mac-beta-codex
R=/home/casey/.local/share/orca-runtime
NEW="$R/49efcc7236ac127c952bb1f7a50fc6ef72f7df84"
B=/srv/dev/.orca-activation-49efcc7-pre-switch-01
NODE=/home/casey/.local/share/mise/installs/node/24.21.0/bin/node
test "$(git -C "$S" rev-parse HEAD)" = 8875f4585d7e5cd038ec974f5c6c270f8c5f01c3
test -z "$(git -C "$S" status --porcelain=v1)"
test "$(sha256sum "$C/pnpm-lock.yaml" | cut -d' ' -f1)" = 0a840533d8974ad2397ad297dfeb7f60bf9ec088728e3fb6680e3d65b62be5a4
test "$(sha256sum "$H/orca.yaml" | cut -d' ' -f1)" = 130b0ab6874d7b1208aa5c76256a2ece125173aab226320018ba2493dd45991a
test "$(sha256sum "$H/work.yaml" | cut -d' ' -f1)" = deabb7cfd89ce12385a587741df1d2fe057d997f1817902aa90094bf179d0823
test "$(sha256sum "$P/orca-workspace.proposed.yaml" | cut -d' ' -f1)" = 6051a848e1e9643f2125f1a876b28128f23a84ac3f815cb030392b35b473fd63
test "$(sha256sum "$P/work-v3.proposed.yaml" | cut -d' ' -f1)" = a00b63c8f09594431858eca3adb89efe46b6d9227ed841fbb01abf01555f4737
test ! -e "$NEW" && test ! -L "$NEW"
test ! -e "$B" && test ! -L "$B"
```

After the operator freezes new admissions and refreshes the scoped run list, stop only the exact observed foreground daemon. Keep the existing tunnel and pts/2 session running. This reads `/proc/<pid>/cmdline` but **never** process environments.

```bash
python3 - <<'PY'
from pathlib import Path
import os, signal
pid = 1600541
argv = [x.decode() for x in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if x]
node = Path('/home/casey/.local/share/mise/installs/node/24.21.0/bin/node')
expected = [
    '/home/casey/.local/share/orca-runtime/3702da5b38dc449280c2837366615de741e9c45c/packages/cli/dist/main.js',
    '--config', '/home/casey/.orca-codex-work/orca.yaml',
    'serve', '--host', '127.0.0.1', '--port', '33871',
]
assert argv and Path(argv[0]).resolve() == node.resolve() and argv[1:] == expected
os.kill(pid, signal.SIGTERM)
PY
```

Wait for PID 1600541 to exit and port 33871 to close. If either remains, stop; do not take a purported consistent backup. With the daemon stopped and task Git writes held, create a new restricted backup containing the **entire** ORCA home (store, private/protected state, auth, configs, workflow and wrapper), the **entire** old runtime directory, the adapter dependency, and the **entire** task-source checkout including its Git common directory. The proposed root-worktree directory is absent before the first run. Keep the archive, Git inventory and checksum private; never attach them to the PR.

```bash
install -d -m 0700 "$B"
test "$(stat -c %a "$B")" = 700
git -C "$S" worktree list --porcelain > "$B/worktrees-before.txt"
git -C "$S" rev-parse HEAD > "$B/task-head-before.txt"
tar --acls --xattrs --numeric-owner -C /home/casey -cpf "$B/pre-switch.tar" \
  .orca-codex-work \
  .local/share/orca-runtime \
  .local/share/orca-adapters/codex-acp-2.1.1 \
  .local/share/orca-worktrees/mac-beta-codex
tar -C /home/casey --compare -f "$B/pre-switch.tar"
tar -tf "$B/pre-switch.tar" > "$B/archive-entries.txt"
sha256sum "$B/pre-switch.tar" > "$B/pre-switch.tar.sha256"
sha256sum -c "$B/pre-switch.tar.sha256"
test "$(git -C "$S" rev-parse HEAD)" = 8875f4585d7e5cd038ec974f5c6c270f8c5f01c3
test -z "$(git -C "$S" status --porcelain=v1)"
```

Then stage the new immutable runtime from the already-built candidate, excluding only Git metadata and candidate scratch/handoff files. Candidate `node_modules` symlinks were checked: 1,211 symlinks, none absolute or outside the candidate tree. Verify the copied compiled manifest before changing live configuration. Do not install dependencies or rebuild.

```bash
install -d -m 0700 "$NEW"
tar -C "$C" --exclude='./.git' --exclude='./.agents' --exclude='./.codex' \
  --exclude='./.candidate-*' \
  --exclude='./docs/preparation/owned-root-candidate-49efcc7' -cpf - . | tar -C "$NEW" -xpf -
test "$(sha256sum "$NEW/packages/cli/dist/main.js" | cut -d' ' -f1)" = 0978c7dd9f1a074827b69c2972d7824b0544f3c2db55fedcc040f7b5d3358bd1
test "$(sha256sum "$NEW/packages/engine/dist/workspace/owned-root-worktree.js" | cut -d' ' -f1)" = ef7861dfa9e894a04087fc78d1313b4054051c735d82b613e25cba338b2814a
test "$(cd "$NEW" && find packages -type f -path '*/dist/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)" = ffc4e42345db96f5103613ac3a82be16409770f9b6df1a14c755d1a00b6aaf5f
```

Stage and atomically replace only `orca.yaml`'s workspace value and the v3 workflow file. The code checks the old bytes and the reviewed proposal bytes before writing. It emits no private configuration or credential values. The installed agent, role, permissions, hosts, workflow path setting, store setting, and tunnel wrapper remain untouched. If either replacement fails, keep the daemon down and use the pre-admission rollback path below.

```bash
python3 - <<'PY'
from pathlib import Path
import hashlib, json, os, yaml
home = Path('/home/casey/.orca-codex-work')
proposal = Path('/srv/dev/worktrees/Project_Orca-prepare-49efcc7-candidate-validation-81dde16f/docs/preparation/owned-root-candidate-49efcc7')
def checked(path, expected):
    data = path.read_bytes()
    assert hashlib.sha256(data).hexdigest() == expected, f'changed input: {path.name}'
    return data
old_config = checked(home / 'orca.yaml', '130b0ab6874d7b1208aa5c76256a2ece125173aab226320018ba2493dd45991a')
checked(home / 'work.yaml', 'deabb7cfd89ce12385a587741df1d2fe057d997f1817902aa90094bf179d0823')
workspace = yaml.safe_load(checked(proposal / 'orca-workspace.proposed.yaml', '6051a848e1e9643f2125f1a876b28128f23a84ac3f815cb030392b35b473fd63'))['workspace']
new_workflow = checked(proposal / 'work-v3.proposed.yaml', 'a00b63c8f09594431858eca3adb89efe46b6d9227ed841fbb01abf01555f4737')
config = json.loads(old_config)
assert config['workspace'] == {'provider': 'local', 'root': '/home/casey/.local/share/orca-worktrees/mac-beta-codex', 'hostId': 'local'}
config['workspace'] = workspace
outputs = {home / 'orca.yaml': (json.dumps(config, indent=2) + '\n').encode(), home / 'work.yaml': new_workflow}
for dst, body in outputs.items():
    tmp = dst.with_name(dst.name + '.activate-49efcc7.tmp')
    with tmp.open('xb') as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
for dst in outputs:
    os.replace(dst.with_name(dst.name + '.activate-49efcc7.tmp'), dst)
    assert (dst.stat().st_mode & 0o777) == 0o600
PY
install -d -m 0700 /home/casey/.local/share/orca-worktrees/cal-codex-roots
```

From the **existing persistent pts/1 SSH shell**, run the new daemon in the foreground, with the same config path, loopback address and port. Do not replace this with a transient background command or change the tunnel's pts/2 session.

```bash
/home/casey/.local/share/mise/installs/node/24.21.0/bin/node \
  /home/casey/.local/share/orca-runtime/49efcc7236ac127c952bb1f7a50fc6ef72f7df84/packages/cli/dist/main.js \
  --config /home/casey/.orca-codex-work/orca.yaml serve --host 127.0.0.1 --port 33871
```

Before admitting any run, use the existing authorized tunnel read APIs to discover the **post-restart** target, verify principal and the same six grants, list the catalog and confirm `cal-codex-work` v3 at revision `sha256:1949ae4b2dd7ed5cc33368a9ab7bb71f1d968071c91bdd42abf12cea80d057e7` with a new configuration generation, and reread owned runs. The target and generation must come from these fresh calls, not the pre-switch `d83be3ee-3bc1-4b03-82ff-df8883d7acd9` / `ca117a12-e5ba-417e-ac60-ac08287a4d71` snapshot. Verify local credential wrapper `--check` still returns 0 without printing its output:

```bash
/home/casey/.local/share/mise/installs/node/24.21.0/bin/node \
  /home/casey/.orca-codex-work/mcp-client.cjs --check >/dev/null 2>&1
```

If read-only hello or any guard fails, do not admit a run.

The **one** later smoke uses the `vars` from `first-smoke-inputs.json`, `workflowId: cal-codex-work`, `workflowVersion: "3"`, and stable idempotency key `cal-codex-work-owned-root-smoke-49efcc7-16e4019d-e620-41c4-99a3-9e1880cc73c7`. The exact authorized API sequence is `discover_orca({})`, `list_workflows({target: freshTarget, workflowId: "cal-codex-work", limit: 100})`, then `preflight_launch({purpose: "workflow", target: freshTarget, workflowId: "cal-codex-work", workflowVersion: "3", vars: firstSmoke.vars})`. Require `validation.ok`, v3, the revision above, and `expectedConfigGeneration` equal to the fresh catalog generation. Only then call `start_workflow({target: freshTarget, command: {workflowId: "cal-codex-work", workflowVersion: "3", vars: firstSmoke.vars, expectedWorkflowRevision: preflight.expectedWorkflowRevision, expectedConfigGeneration: preflight.expectedConfigGeneration}, retry: {idempotencyKey: "cal-codex-work-owned-root-smoke-49efcc7-16e4019d-e620-41c4-99a3-9e1880cc73c7"}})` **once**. The target and generation are intentionally bound at activation because they cannot be known before restart. If the response is uncertain, inspect the same admission/key before any retry; do not create a new key or launch a second run. Confirm its owned root, recorded branch, pinned HEAD, no source changes, and two required report artifacts. This task uses only Git/shell checks; fresh worktrees do not inherit `node_modules`, and installs are forbidden. No such preflight or admission has been made here.

## Rollback boundary

Before **any new admission**, if candidate startup or read-only verification fails, keep the tunnel unchanged, stop the exact new daemon, preserve its failed state in a private same-filesystem quarantine, restore the entire pre-switch ORCA home from the verified archive while offline, verify the old config/workflow hashes and task Git inventory, and run the old foreground daemon command in pts/1. Retain the new runtime and quarantine for diagnosis. A pointer-only binary downgrade is not the rollback. The proposed old command is:

```bash
test ! -e /home/casey/.orca-codex-work.failed-49efcc7-pre-admission-01
mv /home/casey/.orca-codex-work /home/casey/.orca-codex-work.failed-49efcc7-pre-admission-01
tar -C /home/casey -xpf /srv/dev/.orca-activation-49efcc7-pre-switch-01/pre-switch.tar .orca-codex-work
test "$(sha256sum /home/casey/.orca-codex-work/orca.yaml | cut -d' ' -f1)" = 130b0ab6874d7b1208aa5c76256a2ece125173aab226320018ba2493dd45991a
test "$(sha256sum /home/casey/.orca-codex-work/work.yaml | cut -d' ' -f1)" = deabb7cfd89ce12385a587741df1d2fe057d997f1817902aa90094bf179d0823
cmp /srv/dev/.orca-activation-49efcc7-pre-switch-01/worktrees-before.txt <(git -C /home/casey/.local/share/orca-worktrees/mac-beta-codex worktree list --porcelain)
/home/casey/.local/share/mise/installs/node/24.21.0/bin/node \
  /home/casey/.local/share/orca-runtime/3702da5b38dc449280c2837366615de741e9c45c/packages/cli/dist/main.js \
  --config /home/casey/.orca-codex-work/orca.yaml serve --host 127.0.0.1 --port 33871
```

After **any new admission or other new protected-state/Git write**, do not restore the old archive over live state or restart the old binary. Freeze admissions, take a separate restricted post-change snapshot, and preserve the new run, branch, worktree, receipt/ready marker, captured generation, private inputs, auth and audit state. Use compatible candidate recovery or a separately reviewed migration/reconciliation plan. An old snapshot alone would discard new work; removing a root or forcing a binary downgrade would make recovery harder.
