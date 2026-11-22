/**
 * Native NTFS acceptance for store carryover's private copies (#897), run by
 * `.github/workflows/windows-store-carryover.yml` (bundled by
 * `packages/app/scripts/build-store-carryover-probe.js`) on a Windows runner AS A STANDARD USER.
 *
 * Bundled (esbuild, `__ORCA_FIRST_RUN_BUNDLED__`) beside the packaged first-run boundary, as the
 * desktop app's daemon is. It builds a store the way the app does (private directories from the
 * boundary, files inheriting their owner-only DACL) and gives one source file an explicit ACE for
 * Everyone. Carrying it forward must first be refused (UNDURABLE) with only the two empty backup
 * slots created, because they do not yet predate the current boot (#910). With the slots' creation
 * time set a day back, as after a restart, it must carry: the backup archived into slot 1, the
 * marker naming it, and Windows' own `Expand-Archive` restoring the store's files byte for byte.
 * The private-copy path itself is then exercised directly: the backup is staged and published with `windowsPrivateCopy` (no
 * marker), and every published entry's security descriptor is read back with PowerShell:
 *
 * - owner is this user, and every ACE names only this user or SYSTEM;
 * - every copied file carries ONLY inherited ACEs: its DACL was assigned by
 *   the kernel from the owner-only parent when the file was created, and nothing copied from
 *   the source (the Everyone ACE must not appear) or set afterwards;
 * - every directory was created by the boundary with a protected owner-only DACL.
 *
 * Then staging into a second store whose existing `format-backups` grants Everyone must be
 * refused (BACKUPS_UNSAFE). Prints one JSON result; exits non-zero on failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, lstatSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { windowsDirectory, windowsPrivateChild } from "@orca/protocol/first-run-fence";
import {
  CarryoverRefused,
  carryStoreForward,
  readStoreFormat,
  stageCarryover,
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_BACKUP_MANIFEST,
  STORE_FORMAT_BACKUP_SLOTS,
  STORE_FORMAT_EPOCH,
} from "@orca/store";
import { windowsPrivateCopy } from "../src/store-privacy.js";

const SYSTEM = "S-1-5-18";
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const me = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" })
  .trim()
  .split(",")[1]!
  .replace(/"/g, "");
/** This user's own profile from the registry: the process inherits the launcher's USERPROFILE. */
const profile = (() => {
  const text = execFileSync(
    "reg",
    ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${me}`, "/v", "ProfileImagePath"],
    { encoding: "utf8" },
  );
  const match = /ProfileImagePath\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(text);
  if (!match) throw new Error(`no profile for ${me}`);
  return match[1]!.trim().replace(/%SystemDrive%/i, process.env.SystemDrive ?? "C:");
})();
const elevated = (() => {
  try {
    execFileSync("net", ["session"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Descriptor {
  path: string;
  owner: string;
  protected: boolean;
  rules: { sid: string; inherited: boolean; type: string }[];
}
function descriptors(paths: string[]): Descriptor[] {
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.SecurityIdentifier]
$out = foreach ($p in (Get-Content -LiteralPath $env:PROBE_PATHS)) {
  $acl = Get-Acl -LiteralPath $p
  [pscustomobject]@{
    path = [string]$p
    owner = $acl.GetOwner($sid).Value
    protected = $acl.AreAccessRulesProtected
    rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {
      [pscustomobject]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = "$($_.AccessControlType)" } })
  }
}
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress`;
  const text = powershell(script, paths);
  return JSON.parse(text) as Descriptor[];
}
/** Windows PowerShell, with `paths` listed in the file $env:PROBE_PATHS names. */
function powershell(script: string, paths: string[]): string {
  const list = join(profile, "orca-probe-paths.txt");
  writeFileSync(list, paths.join("\r\n"));
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    // Windows PowerShell cannot load its own modules with PowerShell 7's PSModulePath, which the
    // runner's pwsh step passes down.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")),
      PROBE_PATHS: list,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}
const walk = (root: string): string[] =>
  readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return lstatSync(path).isDirectory() ? [path, ...walk(path)] : [path];
  });

/** A store as the app lays it out: boundary-created private directories, inheriting files. */
function appStore(name: string): string {
  const workspace = join(profile, name);
  rmSync(workspace, { recursive: true, force: true });
  windowsPrivateChild(workspace);
  const store = join(workspace, ".orca");
  windowsPrivateChild(store);
  windowsPrivateChild(join(store, "private-execution"));
  writeFileSync(join(store, "private-execution", "payload"), "opaque");
  mkdirSync(join(store, "runs"));
  writeFileSync(
    join(store, "runs", "run_old.jsonl"),
    JSON.stringify({
      id: "evt_0",
      seq: 0,
      runId: "run_old",
      at: "2026-01-02T03:04:00.000Z",
      type: "run.created",
      payload: { workflowId: "review", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    }) + "\n",
  );
  writeFileSync(join(store, ".workspace-identified"), "1\n");
  return store;
}
const grantEveryone = (path: string) => execFileSync("icacls", [path, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });

/** Which existing ancestor the boundary refuses, when it refuses one: printed, then rethrown. */
function diagnose(error: unknown, path: string): never {
  const chain: string[] = [];
  for (let p = path; ;) {
    chain.unshift(p);
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  const report = chain.map((p) => {
    if (!existsSync(p)) return { path: p, exists: false };
    try {
      windowsDirectory(p, "parent");
      return { path: p, parent: "ok" };
    } catch {
      return { path: p, parent: "refused", owner: owner(p) };
    }
  });
  process.stderr.write(JSON.stringify({ home: profile, user: me, report }, null, 2) + "\n");
  throw error;
}
function owner(path: string): string {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Acl -LiteralPath '${path}').Sddl`],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "unreadable";
  }
}
const safely = (name: string) => {
  try {
    return appStore(name);
  } catch (error) {
    return diagnose(error, join(profile, name));
  }
};

const store = safely("orca-carryover-probe");
// A source file readable by Everyone: its copy must not carry that ACE.
grantEveryone(join(store, "runs", "run_old.jsonl"));
const root = join(store, STORE_FORMAT_BACKUP_DIR);
// Before its backup slots predate the current boot, carryover fails closed (UNDURABLE) having
// created only the two empty slots (#910): nothing is copied and no marker is written.
const carry = () =>
  carryStoreForward(store, { appVersion: "0.0.0-probe", privacy: windowsPrivateCopy }).then(
    (outcome) => outcome,
    (error: { details?: { reason?: string }; message?: string }) => error.details?.reason ?? error.message ?? "failed",
  );
const undurable = await carry();
check(undurable === "UNDURABLE", `carry-forward with new slots: ${JSON.stringify(undurable)}`);
check((await readStoreFormat(store)) === undefined, "carry-forward with new slots: marker written");
const slots = STORE_FORMAT_BACKUP_SLOTS.map((name) => join(root, name));
check(
  JSON.stringify(readdirSync(root).sort()) === JSON.stringify([...STORE_FORMAT_BACKUP_SLOTS].sort()),
  `carry-forward with new slots: backups folder holds ${readdirSync(root).join(", ")}`,
);
// Stand in for a restart: date the slots' creation a day back, as a slot made before this boot.
powershell(
  `foreach ($p in (Get-Content -LiteralPath $env:PROBE_PATHS)) { (Get-Item -LiteralPath $p).CreationTime = (Get-Date).AddDays(-1) }`,
  slots,
);
const carried = await carry();
check(
  typeof carried === "object" && carried.status === "carried" && carried.backup === slots[0],
  `carry-forward with aged slots: ${JSON.stringify(carried)}`,
);
check(
  (await readStoreFormat(store))?.backup === slots[0],
  "carry-forward with aged slots: marker does not name slot 1",
);
// Windows' own Expand-Archive restores the backup, byte for byte.
const restored = join(profile, "orca-carryover-probe-restored");
rmSync(restored, { recursive: true, force: true });
powershell(`Expand-Archive -LiteralPath '${slots[0]}' -DestinationPath '${restored}'`, []);
for (const file of [".workspace-identified", "private-execution/payload", "runs/run_old.jsonl"])
  check(
    existsSync(join(restored, file)) && readFileSync(join(restored, file)).equals(readFileSync(join(store, file))),
    `Expand-Archive: ${file} differs from the store`,
  );
check(existsSync(join(restored, STORE_FORMAT_BACKUP_MANIFEST)), "Expand-Archive: no backup manifest");
const staged = await stageCarryover(store, "unmarked", STORE_FORMAT_EPOCH, new Date(), { privacy: windowsPrivateCopy });
const backup = await staged.commit();
const entries = descriptors([root, ...slots, backup, ...walk(backup)]);
for (const entry of entries) {
  const where = entry.path.slice(store.length);
  check(entry.owner === me, `${where}: owner ${entry.owner}, expected ${me}`);
  for (const rule of entry.rules) {
    check([me, SYSTEM].includes(rule.sid), `${where}: ACE for ${rule.sid}`);
    check(rule.type === "Allow", `${where}: ${rule.type} ACE`);
  }
  check(
    entry.rules.some((rule) => rule.sid === me),
    `${where}: no ACE for this user`,
  );
  // Directories come from the boundary's create-only private mkdir (explicit, protected DACL);
  // files are created new inside them and must carry only what the kernel inherited at creation.
  if (lstatSync(entry.path).isDirectory()) check(entry.protected, `${where}: DACL not protected`);
  else
    check(
      entry.rules.every((rule) => rule.inherited),
      `${where}: explicit ACE (not assigned at creation)`,
    );
}

// An existing backups folder that others can read is refused before anything is copied.
const shared = safely("orca-carryover-probe-shared");
mkdirSync(join(shared, STORE_FORMAT_BACKUP_DIR));
grantEveryone(join(shared, STORE_FORMAT_BACKUP_DIR));
const refusal = await stageCarryover(shared, "unmarked", STORE_FORMAT_EPOCH, new Date(), {
  privacy: windowsPrivateCopy,
}).then(
  () => undefined,
  (error: unknown) => (error instanceof CarryoverRefused ? error.failure : String(error)),
);
check(refusal === "BACKUPS_UNSAFE", `shared backups folder: ${refusal ?? "staged"}`);
check(
  readdirSync(join(shared, STORE_FORMAT_BACKUP_DIR)).length === 0,
  "shared backups folder: something was copied into it",
);

if (elevated) failures.push("probe ran elevated; it must run as a standard user");
process.stdout.write(JSON.stringify({ user: me, elevated, checked: entries.length, failures }, null, 2) + "\n");
process.exitCode = failures.length ? 1 : 0;
