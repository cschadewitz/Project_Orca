# First successful coding job: coordinator fixture

`beta-first-job-v1` is original, synthetic code written for
[#420](https://github.com/cschadewitz/Project_Orca/issues/420), under ORCA's repository
license. It contains no copied project, personal data, credentials, dependencies or
real remote. The sole bug is a shipping threshold comparison. See the
[acceptance checklist](../../docs/preparation/beta-first-job/acceptance.md) before
using this with a tester.

## Offline first

Prerequisites for the **coordinator**: already available Node.js >=22 and Git >=2.28.
Missing tools are a blocker; these scripts never install anything. From the ORCA
checkout root:

```sh
node examples/beta-first-job/fixture.js validate
node --test examples/beta-first-job/fixture.test.js
```

`validate` creates two private temporary roots, initializes two local Git repositories,
checks that each has exactly one failing assertion, applies the
[reference patch](../../docs/preparation/beta-first-job/reference.patch), and requires
five passing assertions. It compares initial/final file hashes, local baseline commit
and diff across both attempts. Exit 0 means this offline validation passed; any missing
prerequisite, timeout or mismatch exits nonzero. It does not run ORCA, an ACP scripted
agent or a real provider. “Scripted” here means the coordinator applies the known patch.

JSON stdout records both attempts, runtime/OS/architecture, exit codes, exact test
output, hashes and diff. A full copy is retained at the printed `evidence` path.
Each root also retains `evidence/initial.json` and `evidence/fix.diff`. These paths
are local coordinator evidence; sanitize absolute paths before sharing them.

## Initialize and repeat

```sh
node examples/beta-first-job/fixture.js init
```

The JSON output gives canonical `root` and `workspace` paths:

```text
<run-root>/owner.json
<run-root>/Sample α/              select ONLY this as the agent workspace
  .git/                          local synthetic baseline, no remotes
  README.md                      task and policy
  shipping.js                   only permitted code edit
  shipping.test.js               five immutable checks
<run-root>/Other β/sentinel.txt   must remain unchanged
<run-root>/hooks/                 empty; no user Git hooks invoked
<run-root>/evidence/              coordinator records, outside the task
```

Only the three template files are copied into the repository. Their JavaScript uses
CommonJS without a package manifest; run the initialized copy outside ORCA's ESM
package, not the template files in this checkout. Do not select the ORCA
checkout or `<run-root>` as the agent workspace, or attach the reference patch, this
coordinator directory or its documentation as agent context. The patch remains in the
ORCA checkout; the baseline history contains only broken code. This separation avoids
accidental answer disclosure; it is not an OS access-control sandbox. The approved
provider's file-access policy must bound access to the selected workspace.

The initializer creates a local baseline commit with a synthetic `.invalid` identity,
fixed date, disabled signing and an empty hooks/template directory. It neither reads
user Git configuration nor sets remotes. The **agent** must not commit anything.
No provider credentials or configuration are needed by any local fixture check.

Use the printed path, including spaces and Unicode, when running the check manually:

```sh
cd '<workspace printed by init>'
node shipping.test.js
```

Initially this exits 1 with exactly:

```text
PASS zero subtotal
PASS below threshold
FAIL exact threshold: expected 0, got 499
PASS above threshold
PASS large subtotal
4 passed; 1 failed
```

After the one-character fix (`>` becomes `>=` in `shipping.js`), it exits 0,
replaces the `FAIL` line with `PASS exact threshold`, and ends `5 passed; 0 failed`.
The coordinator checks the result from the ORCA checkout:

```sh
node examples/beta-first-job/fixture.js verify '<run-root printed by init>'
```

`verify` requires the exact reference source bytes, unchanged README/tests/sentinel,
no additional workspace files, no symlink substitution, no remotes, no new commits,
no staged changes and no file mode changes before executing tests.
It prints measured output and file hashes; it does not certify agent identity, ORCA
terminal status, permission behavior or containment of all runtime state. An equivalent
but differently formatted fix needs manual review and does not pass this exact oracle.
ORCA runtime state must use the separately agreed isolated store/profile; if the
supported route requires extra workspace files, reconcile that with #386/#388 before
execution, rather than silently weakening the oracle.

To reset, stop the old run and preserve its evidence, then run:

```sh
node examples/beta-first-job/fixture.js reset
```

This creates a **new** root with identical broken files and a clean baseline; it never
resets, deletes or overwrites the previous workspace. Re-select the new `workspace`.
It accepts no target argument. After all owned processes have stopped, the coordinator
may remove only individually reviewed temporary roots named in these records. No
recursive deletion or automated cleanup command is included.

The [recorded validation](../../docs/preparation/beta-first-job/validation.md) lists
measured results and the integration work still unexecuted.
