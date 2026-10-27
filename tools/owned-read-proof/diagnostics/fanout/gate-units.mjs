/** DIAGNOSTIC ONLY (#706 fan-out investigation). Exact syscall cost of managed-gate units.
 * The lifetime and build ports are marker no-ops, so only gate-owned observations remain.
 * Run under strace and count lines between the /MARK-* statx probes:
 *
 *   strace -f -qq -o units.trace node --import tsx gate-units.mjs
 *
 * Markers: resolve-begin/end (one resolveManagedRootBinding with the sidecar present),
 * inspect-begin/end (never-typed inspect), inspect2-begin/end (enrolled, bracketed inspect).
 */
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  resolveManagedRootBinding,
  createManagedTypedWorkspace,
} from "../../../../packages/cli/src/typed-workspace-gate.ts";

// Same depth as an observation root: /tmp/orca-connected-observation-XXXX/connected.
const base = join(fs.mkdtempSync("/tmp/orca-connected-observation-"), "connected");
fs.mkdirSync(base, { mode: 0o700 });
for (const path of ["workspace", "workspace/.orca", "workspace/.orca/workspace-identity", "control", "releases"])
  fs.mkdirSync(join(base, path), { mode: 0o700 });
const id = join(base, "workspace/.orca/workspace-identity/id");
const sidecar = join(base, "workspace/orca.permissions.json");
fs.writeFileSync(id, randomUUID() + "\n", { mode: 0o600 });
fs.writeFileSync(sidecar, "{}", { mode: 0o600 });
const roles = [
  { role: "config", path: join(base, "workspace") },
  { role: "sidecar", path: sidecar },
  { role: "store", path: join(base, "workspace/.orca") },
];
const mark = (name) => {
  try {
    fs.statSync("/MARK-" + name);
  } catch {
    // An absent marker path: the failed statx is the delimiter.
  }
};
const binding = resolveManagedRootBinding(roles, join(base, "control"), join(base, "releases"));
const digest = createHash("sha256").update(fs.readFileSync(id)).digest("hex");
fs.writeFileSync(join(base, "control/never-typed"), `${digest}\n${binding.rootBindingRef}\n`, { mode: 0o600 });
const managed = createManagedTypedWorkspace({
  binding,
  lifetime: { mode: "enrollment", assertCurrent: () => (mark("L"), undefined) },
  assertBuildCurrent: () => (mark("B"), undefined),
  qualify: async () => {
    throw Error("unused");
  },
});
mark("resolve-begin");
resolveManagedRootBinding(roles, join(base, "control"), join(base, "releases"));
mark("resolve-end");
mark("inspect-begin");
managed.inspect();
mark("inspect-end");
fs.unlinkSync(sidecar); // Fresh enrollment requires an absent sidecar; it then exists (typed v2).
await managed.enrollFresh();
mark("inspect2-begin");
managed.inspect();
mark("inspect2-end");
fs.rmSync(join(base, ".."), { recursive: true, force: true });
