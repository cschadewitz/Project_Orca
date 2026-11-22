/**
 * Native NTFS acceptance for store carryover's private copies (#897), run by
 * `.github/workflows/windows-store-carryover.yml` (bundled by
 * `packages/app/scripts/build-store-carryover-probe.js`) on a Windows runner AS A STANDARD USER.
 *
 * Bundled (esbuild, `__ORCA_FIRST_RUN_BUNDLED__`) beside the packaged first-run boundary, as the
 * desktop app's daemon is. It builds a store the way the app does (private directories from the
 * boundary, files inheriting their owner-only DACL), gives one source file an explicit ACE for
 * Everyone, carries the store forward with `windowsPrivateCopy`, and then reads every published
 * entry's security descriptor back with PowerShell:
 *
 * - owner is this user, and every ACE names only this user or SYSTEM;
 * - every copied file and nested directory carries ONLY inherited ACEs: its DACL was assigned by
 *   the kernel from the owner-only parent when the object was created, and nothing copied from
 *   the source (the Everyone ACE must not appear) or set afterwards;
 * - the directories the boundary created are protected (no inheritance from outside).
 *
 * Then a second store whose existing `format-backups` grants Everyone must be refused
 * (BACKUPS_UNSAFE) with no marker written. Prints one JSON result; exits non-zero on failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, lstatSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { windowsDirectory, windowsPrivateChild } from "@orca/protocol/first-run-fence";
import { carryStoreForward, readStoreFormat, STORE_FORMAT_BACKUP_DIR, STORE_FORMAT_EPOCH } from "@orca/store";
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
  const list = join(profile, "orca-probe-paths.txt");
  writeFileSync(list, paths.join("\r\n"));
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    // Windows PowerShell cannot load its own modules with PowerShell 7's PSModulePath, which the
    // runner's pwsh step passes down.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")),
      PROBE_PATHS: list,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(text) as Descriptor[];
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
const outcome = await carryStoreForward(store, { appVersion: "0.0.0-probe", privacy: windowsPrivateCopy });
check(outcome.status === "carried", `carryover outcome ${JSON.stringify(outcome)}`);
check((await readStoreFormat(store))?.epoch === STORE_FORMAT_EPOCH, "marker not stamped");
const backup = "backup" in outcome ? outcome.backup : "";
const root = join(store, STORE_FORMAT_BACKUP_DIR);
const entries = descriptors([root, backup, ...walk(backup)]);
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
  if (entry.path === root || entry.path === backup) check(entry.protected, `${where}: DACL not protected`);
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
const refusal = await carryStoreForward(shared, { appVersion: "0.0.0-probe", privacy: windowsPrivateCopy }).then(
  () => undefined,
  (error: { details?: { reason?: string } }) => error.details?.reason,
);
check(refusal === "BACKUPS_UNSAFE", `shared backups folder: ${refusal ?? "carried"}`);
check((await readStoreFormat(shared)) === undefined, "shared backups folder: marker written");

if (elevated) failures.push("probe ran elevated; it must run as a standard user");
process.stdout.write(JSON.stringify({ user: me, elevated, checked: entries.length, failures }, null, 2) + "\n");
process.exitCode = failures.length ? 1 : 0;
