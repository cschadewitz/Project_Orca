# Narrow Windows first-run support

This delta starts at PR #605 `e1bb345716758176456f5f4bd996ef2168b6dce5`.
It supplies successful Windows first-run provisioning, sample admission and reopen
for canonical drive paths on local fixed NTFS with safe ancestry and a prepared
Git project owned by the current token SID. It does not close all M21 acceptance.

The Windows picker selects a parent. The review shows the exact prospective new
child, parent and project; only confirmation creates that child with a protected
current-user/SYSTEM DACL. Creation is exclusive and does not adopt or alter an
existing directory ACL. Prepared projects are observed and left unchanged.
UNC/device aliases, reparses, hard-linked assets, unsafe ACLs, changed physical
identities and uncertified legacy Windows receipts refuse.

The dedicated first-run addon reuses diagnostics' handle-relative NTFS traversal,
token/DACL checks and private creation primitives. Its write filename inventory
contains only first-run assets, selection receipts and ownership evidence. It
flushes writes and replaces selection receipts through a held parent handle.
The loader uses fixed Electron resources or daemon-bundle-relative locations;
there is no environment-selected addon or Electron repository fallback.
Diagnostics and credential/capture exports are not activated by this path.

Existing receipt versions and string fields remain intact. Windows principals
use `win32:sid:`, volumes use `win32:ntfs:` plus native serial/GUID, and files use
`win32:file:` plus full native file ID. POSIX numeric strings and code paths remain
unchanged. Windows boot observations use the existing native kernel boot GUID and
a hash of the locally read MachineGuid. A native exclusive lock pins the reviewed
workspace and ancestry. Once writer admission retains it, ordinary release,
server closure and garbage collection cannot release it; process teardown can.
Short recovery locks remain releasable.

## Focused evidence

[Allowlisted evidence](evidence/m21-windows-first-run.json) records the final
source-built Windows x64 native and Electron checks. Seven real native cases pass:
creation/receipt recreation, reviewed-parent replacement, sample hardlink/reparse
and content refusal, inherited non-private ACL/namespace refusal, workspace
replacement/legacy receipt refusal, temporary duplicate fencing, and a separate
process retaining ownership through release and GC until process exit.

Six mounted first-run UI checks and sixteen native packaging checks pass. The
real Electron 44.4.5 probe passes reviewed creation, owned authenticated connection,
exactly one agent-free harmless sample, duplicate daemon refusal and restart/reopen
with the same successful run, byte-identical selection receipt and unchanged Git
project. It copies the installed Electron distribution into its disposable fixture
and substitutes only the native directory picker. No identity, auth, RPC, secure
storage or admission response is substituted.

MSVC `/W4 /WX` native compilation, strict GCC syntax, affected TypeScript builds,
renderer typecheck, source lint, daemon bundle and renderer build pass. Full CI,
package installation and broad suite reruns were not performed. This Windows host
has no installed Ubuntu Node runtime, so POSIX runtime regression tests remain for
the parent combined-candidate validation; the existing POSIX branches are preserved.
Packaged/signing, arm64 execution, second-user attacks and power-loss/manual crash
proof remain outside this source-built x64 evidence.

Run the native fixture and focused Electron scripts after building affected source
and native modules. `ORCA_WINDOWS_TEST_PARENT` is a test-only fixture location,
defaulting to Temp. When managed Temp ancestry is unsafe, explicitly select another
verified safe parent for new disposable fixtures. Do not repair its ACLs. This host
used new fixtures directly under Documents; existing permissions were unchanged.

```powershell
$env:ORCA_WINDOWS_TEST_PARENT = '<verified safe fixture parent>'
node node_modules/vitest/vitest.mjs run packages/app/test/first-run-windows.test.ts --maxWorkers=1
node packages/app/test/milestone21/windows-first-run.mjs
```
