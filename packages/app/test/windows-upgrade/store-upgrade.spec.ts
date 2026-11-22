/**
 * The release candidate's native upgrade check on Windows (#566): the signed installer of
 * the current Latest release, then the signed installer of the candidate over it, on a store
 * the previous release wrote. `release-upgrade-check.yml` runs it on a GitHub-hosted Windows
 * runner for every final draft, after its signed installer is attached, and records a pass in
 * the draft; `Release (publish final)` refuses a draft without that record.
 *
 * Before this runs, the workflow verifies both installers' signatures and fills
 * `ORCA_UPGRADE_WORKSPACE` with `orca demo`, run by the previous release's own CLI (built
 * from its tag): runs, a plan, decisions and protected run records, encrypted under the
 * store's private execution key, as a person upgrading has on disk.
 *
 * What it shows, in order:
 *
 * - the previous release installs and its app opens the workspace;
 * - the candidate installs over it, and its app opens the same store in place: the store is
 *   stamped with the format and the candidate's version (an unmarked store from a release
 *   before #896 acquires the marker; a marked one keeps its format), no format backup is made,
 *   and every run is still there;
 * - the previous release's daemon still reads the stamped store (a rollback after an update);
 * - the candidate refuses a store stamped by a newer format, and changes nothing in it.
 *
 * A candidate that changes the store format fails here on purpose: ordinary startup refuses
 * an older format until the automatic desktop carryover (#897) lands, and this check then has
 * to prove that path instead.
 */
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; release-upgrade-check.yml sets it`);
  return value;
}

const FROM = required("ORCA_UPGRADE_FROM");
const FROM_INSTALLER = required("ORCA_UPGRADE_FROM_INSTALLER");
const FROM_EPOCH = required("ORCA_UPGRADE_FROM_EPOCH");
const TO = required("ORCA_UPGRADE_TO");
const TO_INSTALLER = required("ORCA_UPGRADE_TO_INSTALLER");
const WORKSPACE = required("ORCA_UPGRADE_WORKSPACE");
const STORE = join(WORKSPACE, ".orca");

interface ConnectionWindow {
  orca: { connection: { read(): { state: string } } };
}

/** Run the installer silently and wait for it, as the per-user NSIS installer allows. */
async function install(installer: string): Promise<void> {
  const { stdout } = await execute("powershell", [
    "-NoProfile",
    "-Command",
    `$p = Start-Process -FilePath '${installer.replaceAll("'", "''")}' -ArgumentList '/S' -Wait -PassThru; $p.ExitCode`,
  ]);
  expect(stdout.trim(), `${installer} exit code`).toBe("0");
}

/** The per-user ORCA install as Apps & features shows it: its version and its executable. */
async function installed(): Promise<{ version: string; exe: string }> {
  const { stdout } = await execute("powershell", [
    "-NoProfile",
    "-Command",
    "$e = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | " +
      "Where-Object DisplayName -like 'ORCA*' | Select-Object -First 1; " +
      // electron-builder writes no InstallLocation; DisplayIcon is "<install dir>\ORCA.exe,0".
      "\"$($e.DisplayVersion)`n$(($e.DisplayIcon -replace ',\\d+$', '').Trim('\"'))\"",
  ]);
  const [version = "", exe = ""] = stdout.trim().split(/\r?\n/);
  return { version: version.trim(), exe: exe.trim() };
}

/** The installed build's bundled daemon, which is the whole CLI. */
const bundleOf = (exe: string) => join(dirname(exe), "resources", "daemon", "orca-daemon.mjs");

/** `orca <args>` through an installed build's own Electron, run as Node, in `cwd`. */
async function cli(
  exe: string,
  bundle: string,
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(exe, [bundle, "--cwd", cwd, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number>((resolve) => child.once("exit", (c) => resolve(c ?? -1)));
  return { code, stdout, stderr };
}

/** The run ids `orca runs` lists, sorted. */
async function runIds(exe: string, bundle: string): Promise<string[]> {
  const result = await cli(exe, bundle, WORKSPACE, ["runs"]);
  expect(result.code, `orca runs: ${result.stderr}`).toBe(0);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((id) => id.startsWith("run_"))
    .sort();
}

interface Launched {
  child: ChildProcess;
  browser: Browser;
  page: Page;
  exited: Promise<void>;
}

let port = 9351;

/**
 * The installed app on the workspace, started as a person would and driven over the
 * renderer's DevTools protocol (not Playwright's Electron launcher, whose inspector session
 * outlives the app), until its connection to the bundled daemon is live.
 */
async function launch(exe: string, label: string): Promise<Launched> {
  const profile = await mkdtemp(join(tmpdir(), `orca-upgrade-${label}-`));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.ORCA_WORKSPACE = WORKSPACE;
  for (const key of ["ELECTRON_RUN_AS_NODE", "ORCA_DAEMON_URL", "ORCA_UPDATE_URL", "ORCA_UPDATE_TOKEN_FILE"])
    delete env[key];
  const debugPort = port++;
  const child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${label}] ${chunk.toString()}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[${label}] ${chunk.toString()}`));
  let browser: Browser | undefined;
  await expect
    .poll(
      async () => {
        expect(child.exitCode, "the app exited during startup").toBeNull();
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`).catch(() => undefined);
        return browser !== undefined;
      },
      { timeout: 60_000, message: "the app's DevTools endpoint answers" },
    )
    .toBe(true);
  const context = browser!.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 60_000 }));
  await page.waitForFunction(
    () => (window as unknown as ConnectionWindow).orca?.connection.read().state === "live",
    undefined,
    { timeout: 90_000 },
  );
  return { child, browser: browser!, page, exited };
}

/** Close the window (the app quits with its last window), or end the process if it will not. */
async function stop({ child, browser, page, exited }: Launched): Promise<void> {
  if (child.exitCode === null) await page.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  const settled = await Promise.race([
    exited.then(() => true),
    new Promise<false>((r) => setTimeout(r, 20_000, false)),
  ]);
  if (!settled) {
    child.kill();
    await exited;
  }
}

/** Every file under `root` with its SHA-256, so a refusal can be shown to change nothing. */
async function digestTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        out[relative(root, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  };
  await walk(root);
  return out;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

interface Marker {
  format: number;
  epoch: string;
  writtenBy: string;
  updatedAt?: string;
}
const readMarker = async (store: string) =>
  JSON.parse(await readFile(join(store, "store-format.json"), "utf8")) as Marker;

test.describe.configure({ mode: "serial" });

let fromRuns: string[] = [];
let fromBundle = "";
/** The marker the previous release left, if it is a release that writes one (0.7.1 and later). */
let fromMarker: Marker | undefined;

test(`the previous release (${FROM}) installs and opens the workspace it wrote`, async () => {
  test.setTimeout(300_000);
  await install(FROM_INSTALLER);
  const { version, exe } = await installed();
  expect(version).toBe(FROM);
  fromRuns = await runIds(exe, bundleOf(exe));
  expect(fromRuns.length, "the demo recorded runs").toBeGreaterThan(0);
  const app = await launch(exe, FROM);
  await stop(app);
  // Two baselines: a release before #896 (0.7.0) leaves the store unmarked; a later one stamps
  // its own format and version. Either way nothing else about the store differs.
  fromMarker = (await exists(join(STORE, "store-format.json"))) ? await readMarker(STORE) : undefined;
  if (fromMarker) expect(fromMarker).toMatchObject({ format: 1, epoch: FROM_EPOCH, writtenBy: FROM });
  // Kept for the rollback check: installing the candidate replaces it.
  fromBundle = join(await mkdtemp(join(tmpdir(), "orca-upgrade-from-")), "orca-daemon.mjs");
  await copyFile(bundleOf(exe), fromBundle);
});

test(`the candidate (${TO}) installs over it and opens the same store in place`, async () => {
  test.setTimeout(300_000);
  await install(TO_INSTALLER);
  const { version, exe } = await installed();
  expect(version).toBe(TO);
  const format = await cli(exe, bundleOf(exe), WORKSPACE, ["store", "format"]);
  const epoch = /^this ORCA\s+(\S+)/m.exec(format.stdout)?.[1];
  expect(
    epoch,
    `the candidate's store format is the previous release's (${FROM_EPOCH}); a format change needs #897 and a new check`,
  ).toBe(FROM_EPOCH);
  expect(format.code, `orca store format: ${format.stdout}${format.stderr}`).toBe(0);

  const app = await launch(exe, TO);
  await stop(app);
  // An unmarked store acquires the marker; a marked one keeps its format (and any backup it
  // names) and records the candidate as its last writer. Neither is converted or copied.
  const marker = await readMarker(STORE);
  expect(marker).toMatchObject({ format: 1, epoch: FROM_EPOCH, writtenBy: TO });
  if (fromMarker) expect(marker).toEqual({ ...fromMarker, writtenBy: TO, updatedAt: marker.updatedAt });
  expect(await exists(join(STORE, "format-backups")), "opening in place makes no format backup").toBe(false);
  expect(await runIds(exe, bundleOf(exe))).toEqual(fromRuns);
  const again = await cli(exe, bundleOf(exe), WORKSPACE, ["store", "format"]);
  expect(again.code).toBe(0);
  expect(again.stdout).toMatch(/^on startup\s+opens in place/m);
});

test("a marked store of the same format opens in place again, unchanged", async () => {
  // What every upgrade after the first meets: a store already stamped by this format.
  test.setTimeout(300_000);
  const { exe } = await installed();
  const before = await readFile(join(STORE, "store-format.json"), "utf8");
  const app = await launch(exe, `${TO}-again`);
  await stop(app);
  expect(await readFile(join(STORE, "store-format.json"), "utf8")).toBe(before);
  expect(await exists(join(STORE, "format-backups"))).toBe(false);
  expect(await runIds(exe, bundleOf(exe))).toEqual(fromRuns);
});

test(`the previous release's daemon still reads the stamped store`, async () => {
  const { exe } = await installed();
  const before = await readFile(join(STORE, "store-format.json"), "utf8");
  expect(await runIds(exe, fromBundle)).toEqual(fromRuns);
  expect(await readFile(join(STORE, "store-format.json"), "utf8")).toBe(before);
});

test("the candidate refuses a store stamped by a newer format and changes nothing", async () => {
  const { exe } = await installed();
  const copy = await mkdtemp(join(tmpdir(), "orca-upgrade-newer-"));
  await mkdir(join(copy, ".orca"));
  await cp(STORE, join(copy, ".orca"), { recursive: true });
  const marker = await readMarker(join(copy, ".orca"));
  await writeFile(
    join(copy, ".orca", "store-format.json"),
    JSON.stringify({ ...marker, epoch: "upgrade-check-future-v1", writtenBy: "99.0.0" }, null, 2) + "\n",
  );
  const before = await digestTree(join(copy, ".orca"));
  const result = await cli(exe, bundleOf(exe), copy, ["runs"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("error [STORE_FORMAT]");
  expect(result.stderr).toContain('"reason": "NEWER"');
  expect(await digestTree(join(copy, ".orca"))).toEqual(before);
});
