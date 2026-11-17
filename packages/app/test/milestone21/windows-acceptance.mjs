/**
 * Scoped, real Windows/Electron M21 acceptance. Run only after this checkout's build:
 *   node packages/app/test/milestone21/windows-acceptance.mjs
 * Optional independent refusal probe:
 *   node packages/app/test/milestone21/windows-acceptance.mjs --first-run-refusal-only
 *
 * This script neither builds nor installs. It opens the production renderer/preload and
 * lets the production app own its source-bundled daemon. No RPC result, UID, authority,
 * native secure-storage function or agent transport is substituted. A manual gate parks
 * each admitted workflow before its agent node, whose executable deliberately does not
 * exist. Only explicit synthetic fixture inputs are used for template preview.
 *
 * Receipt allowlist: phase/check booleans, public IDs, digests, RPC method names. No trace,
 * screenshot, video, source, command params, paths, tokens, errors or protected journal.
 * The unsupported Windows first-run ownership refusal is reported separately and never
 * establishes positive first-run acceptance. Diagnostics/native addons are not enabled.
 */
/* global window, document, getComputedStyle, requestAnimationFrame */
import { _electron as electron } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { PROTOCOL_VERSION, ResponseMessageSchema, RunsGetResultSchema } from "@orca/protocol";

const appDir = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const repo = resolve(appDir, "../..");
const requireFromApp = createRequire(join(appDir, "package.json"));
const electronExecutable = join(dirname(requireFromApp.resolve("electron")), "dist/electron.exe");
const { parse: parseYaml, stringify: stringifyYaml } = requireFromApp("yaml");
const execute = promisify(execFile);
const cli = join(repo, "packages/cli/dist/main.js");
const bundle = join(appDir, "dist/daemon/orca-daemon.mjs");
const clientModule = join(appDir, "dist/client/daemon-client.js");
const receiptFile = join(repo, "test-results/milestone21/windows-acceptance.json");
const REFUSAL_ONLY = process.argv.includes("--first-run-refusal-only");
const TIMEOUT = 30_000;
const DIRECT = "m21-typed-task";
const PROGRAM = "m21-request-program";
const ITEM = "m21-item";
const TEMPLATE = "m21/task";
const STRICT = `strict/${TEMPLATE}`;
const COMMENT = "# M21 comment must survive structured edits";
const PARTIAL = "common/m21-check";
const DIRECT_METHOD = "operator.admitRun";
const REQUEST_METHOD = "operator.submitRequest";
const METHODS = [
  "hello",
  "operator.discover",
  "operator.page",
  "operator.preflight",
  DIRECT_METHOD,
  REQUEST_METHOD,
  "operator.admission",
  "operator.reconcileAdmission",
  "config.get",
  "config.set",
  "config.apply",
  "templates.get",
  "templates.validate",
  "templates.preview",
  "templates.variant",
  "templates.save",
  "templates.publish",
  "templates.history",
  "runs.admit",
  "requests.submit",
  "admissions.get",
  "runs.list",
  "inputs.list",
  "runs.get",
  "runs.events",
  "launches.recover",
];
const RPC_ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_FORBIDDEN",
  "PROTOCOL_METHOD",
  "PROTOCOL_MESSAGE",
  "CONFIG_INVALID",
  "CONFIG_STALE",
  "WORKFLOW_INVALID",
  "WORKFLOW_NOT_FOUND",
  "WORKFLOW_INPUT_INVALID",
  "RUN_NOT_FOUND",
  "RUN_STATE",
  "STORE_IO",
  "INTERNAL",
];
const receipt = {
  windows: process.platform === "win32",
  accepted: false,
  firstRunAccepted: false,
  phases: {},
  checks: {},
  ids: {},
  hashes: {},
  methods: {},
};
let currentPhase = "prerequisites";
let currentOperation = "prerequisites";
let fixture;
let app;
let nativeMainPid;
let nativeMainCreated;
let page;
let bundledChildren = [];
let cliChild;
let fixtureCleaned = false;
let rendererErrors = 0;

class SafeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function check(condition, code) {
  receipt.checks[code] = Boolean(condition);
  if (!condition) throw new SafeFailure(code);
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function bounded(action, milliseconds = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      action,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new SafeFailure("phase-timeout")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function phase(name, action) {
  currentPhase = name;
  currentOperation = name;
  await bounded(
    action(),
    [
      "config-form",
      "config-restart-and-role-apply",
      "templates",
      "guided-request",
      "keyboard-axe-geometry",
      "restart-persistence",
    ].includes(name)
      ? 60_000
      : TIMEOUT,
  );
  receipt.phases[name] = true;
  process.stdout.write(`${JSON.stringify({ phase: name, passed: true })}\n`);
}
async function waitUntil(action, milliseconds = TIMEOUT) {
  const end = Date.now() + milliseconds;
  do {
    if (await action()) return;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < end);
  throw new SafeFailure("condition-timeout");
}
function environment() {
  // Inherited ORCA/Git overrides and provider credential variables cannot redirect this fixture.
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !/^(ORCA_|GIT_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_|OPENAI_|AZURE_OPENAI_|GOOGLE_API_|GEMINI_|CODEX_API_|CLAUDE_)/i.test(
          key,
        ),
    ),
  );
}
async function git(cwd, ...args) {
  const operation = args.find((arg) => ["init", "add", "commit", "rev-parse", "status"].includes(arg)) ?? "command";
  try {
    return (
      await execute("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", cwd, ...args], {
        env: {
          ...environment(),
          // Actual empty files avoid Windows device-path parsing and global hooks/signers.
          GIT_CONFIG_GLOBAL: join(fixture.root, "git-empty.config"),
          GIT_CONFIG_SYSTEM: join(fixture.root, "git-empty.config"),
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  } catch (error) {
    // Classify bounded stderr privately. Never retain the text, command, cwd or stack.
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    const category =
      error.syscall === "spawn" && ["EPERM", "EACCES"].includes(error.code)
        ? "spawn-permission"
        : error.killed
          ? "timeout"
          : /detected dubious ownership/i.test(stderr)
            ? "ownership"
            : /unable to read config file|bad config line|could not read config/i.test(stderr)
              ? "configuration"
              : /unable to auto-detect email address|please tell me who you are|empty ident name/i.test(stderr)
                ? "identity"
                : /gpg failed|failed to sign|signing failed/i.test(stderr)
                  ? "signing"
                  : /permission denied|access is denied/i.test(stderr)
                    ? "permission"
                    : /unknown option|usage: git/i.test(stderr)
                      ? "arguments"
                      : "unclassified";
    const code = Number.isInteger(error.code)
      ? error.code
      : ["ENOENT", "EPERM", "EACCES", "ETIMEDOUT"].includes(error.code)
        ? error.code
        : "UNKNOWN";
    receipt.failure = { stage: `fixture-git-${operation}`, category, code };
    throw new SafeFailure(`fixture-git-${operation}-${category}`);
  }
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  try {
    await bounded(exited, 5000);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(exited, 10_000);
  }
}

/** Real compiled first-run class, genuine Windows getuid absence; injected picker only. */
async function firstRunRefusal() {
  const { FirstRunSetup } = await import(pathToFileURL(join(appDir, "dist/main/first-run/setup.js")).href);
  let projectPicked = false;
  let workspacePicked = false;
  let connected = false;
  const selection = join(fixture.profile, "first-run/selection.json");
  const setup = new FirstRunSetup({
    home: fixture.root,
    receiptPath: selection,
    choose: async (kind) => {
      if (kind === "project") projectPicked = true;
      else workspacePicked = true;
      return kind === "project" ? fixture.project : fixture.workspace;
    },
    prepareConnection: async () => {
      connected = true;
      throw new SafeFailure("unexpected-first-run-connect");
    },
    current: () => false,
  });
  let refused = false;
  try {
    await setup.choose(() => {});
  } catch (error) {
    // A selection refusal reaches the screen as it is, with no generic wrapper around it.
    refused =
      error instanceof Error &&
      error.name === "FirstRunRefusal" &&
      error.message.startsWith("Choose owned writable directories with verifiable identity:");
  }
  check(typeof process.getuid !== "function", "windows-posix-owner-unavailable");
  check(refused && projectPicked && !workspacePicked && !connected, "first-run-unsupported-refusal");
  check(!existsSync(selection), "first-run-refusal-no-selection-write");
  check((await setup.status()).state === "selection-required", "first-run-refusal-selection-required");
  receipt.checks["first-run-positive-acceptance-unproven"] = true;
}

async function makeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orca-m21-windows-")));
  const project = join(root, "project"),
    workspace = join(root, "workspace"),
    profile = join(root, "profile");
  await Promise.all([mkdir(project), mkdir(workspace), mkdir(profile)]);
  fixture = { root, project, workspace, profile };
  await writeFile(join(root, "git-empty.config"), "");
  await writeFile(join(project, ".gitignore"), ".orca/\nauth/\n.orca-template-history.json\n");
  await writeFile(join(project, "README.txt"), "Disposable M21 acceptance project. No agents may execute.\n");
  await git(project, "init", "--initial-branch=m21-acceptance");
  await git(project, "add", ".gitignore", "README.txt");
  await git(
    project,
    "-c",
    "user.name=Calcifer Schadewitz",
    "-c",
    "user.email=schadewitzcalcifer@gmail.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Synthetic acceptance fixture",
  );
  receipt.hashes.baseCommit = await git(project, "rev-parse", "HEAD");
}
function parkedWorkflow(id, name, fields) {
  return {
    id,
    name,
    version: "1",
    start: "start",
    inputSchema: { unknown: "reject", fields },
    nodes: {
      start: { type: "start" },
      hold: {
        type: "gate",
        question: "M21 acceptance stops before agent execution",
        options: [{ id: "keep-parked", label: "Keep parked" }],
      },
      task: { type: "agent", agent: { role: "builder" }, template: TEMPLATE },
      done: { type: "end", outcome: "success" },
    },
    edges: [
      { from: "start", to: "hold" },
      { from: "hold", to: "task" },
      { from: "task", to: "done" },
    ],
  };
}
async function writeAssets() {
  await Promise.all([mkdir(join(fixture.workspace, "workflows")), mkdir(join(fixture.workspace, "templates"))]);
  const direct = parkedWorkflow(DIRECT, "M21 typed task", {
    task: { type: "string", required: true },
    count: { type: "integer", required: true, minimum: 1 },
    enabled: { type: "boolean", default: false },
  });
  const program = parkedWorkflow(PROGRAM, "M21 Request program", {
    request: {
      type: "object",
      required: true,
      properties: { title: { type: "string", required: true }, body: { type: "string", required: true } },
    },
    itemWorkflow: { type: "string", required: true },
  });
  const item = {
    id: ITEM,
    name: "M21 item",
    version: "1",
    start: "start",
    nodes: { start: { type: "start" }, done: { type: "end" } },
    edges: [{ from: "start", to: "done" }],
  };
  for (const workflow of [direct, program, item])
    await writeFile(join(fixture.workspace, "workflows", `${workflow.id}.yaml`), stringifyYaml(workflow));
  const template = (id, prefix) =>
    `---\n# M21 template comment\nid: ${id}\nversion: "1"\nrequires: [intent]\nx-fixture: retained-metadata\n---\n${prefix} {{task}}\n{{> ${PARTIAL}}}\nIntent: {{artifacts.intent.content}}\n`;
  await writeFile(join(fixture.workspace, "templates/base.md"), template(TEMPLATE, "Base"));
  await writeFile(join(fixture.workspace, "templates/strict.md"), template(STRICT, "Strict"));
  await writeFile(
    join(fixture.workspace, "templates/partial.md"),
    `---\nid: ${PARTIAL}\n---\nExact partial {{marker}}\n`,
  );
  const config = {
    version: 1,
    storeDir: ".orca",
    hosts: [{ id: "local", type: "local" }],
    agents: ["worker-a", "worker-b"].map((id) => ({
      id,
      command: join(fixture.root, "agent-must-not-start.exe"),
      hostId: "local",
      roles: ["builder"],
      models: [{ id: `${id}-model`, name: `${id}-model` }],
      defaultModel: `${id}-model`,
      turnTimeoutMs: 1000,
      cancelGraceMs: 100,
    })),
    roles: { builder: "worker-a" },
    workflows: ["workflows/*.yaml"],
    templates: ["templates/*.md"],
    program: { workflow: PROGRAM, itemWorkflow: ITEM },
    workspace: { provider: "local", root: fixture.project, hostId: "local" },
    humanInput: { mode: "pause" },
    plugins: [],
  };
  await writeFile(join(fixture.workspace, "orca.config.yaml"), `${COMMENT}\n${stringifyYaml(config)}`);
}

let nextRpc = 1;
async function rpc(method, params = {}) {
  const methodLabel = METHODS.includes(method) ? method : "other";
  const token = (await readFile(join(fixture.workspace, "auth/local-client.token"), "utf8")).trim();
  const response = await fetch(`${fixture.url}/rpc`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: "request", id: nextRpc++, method, params }),
  });
  if (!response.ok) {
    receipt.checks[`fixture-rpc-failure-method-${methodLabel}`] = true;
    throw new SafeFailure("fixture-rpc-http-refused");
  }
  const envelope = ResponseMessageSchema.parse(await response.json());
  if (!envelope.ok) {
    const code = RPC_ERROR_CODES.includes(envelope.error.code) ? envelope.error.code : "OTHER";
    receipt.checks[`fixture-rpc-failure-method-${methodLabel}`] = true;
    receipt.checks[`fixture-rpc-failure-code-${code}`] = true;
    throw new SafeFailure("fixture-rpc-refused");
  }
  return envelope.result;
}
async function cliBootstrap() {
  const child = spawn(
    process.execPath,
    [cli, "--config", join(fixture.workspace, "orca.config.yaml"), "serve", "--port", "0"],
    {
      cwd: fixture.workspace,
      env: environment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  cliChild = child;
  const url = await bounded(
    new Promise((ready, refused) => {
      let pending = "";
      child.stdout.on("data", (bytes) => {
        pending = (pending + bytes.toString()).slice(-8192);
        const match = /orca daemon \S+ listening on (http:\/\/127\.0\.0\.1:\d+)\s/.exec(pending);
        if (match) ready(match[1]);
      });
      child.stderr.on("data", () => {}); // drain; raw output never enters evidence
      child.once("error", () => refused(new SafeFailure("fixture-cli-spawn-refused")));
      child.once("exit", () => refused(new SafeFailure("fixture-cli-exited-before-ready")));
    }),
  );
  fixture.url = url;
  const hello = await rpc("hello", { client: "orca-m21-windows/0", protocol: PROTOCOL_VERSION });
  const discovery = await rpc("operator.discover");
  check(discovery.authentication === "credential", "fixture-cli-authenticated");
  check(
    hello.methods.includes("config.apply") &&
      hello.methods.includes("templates.publish") &&
      hello.methods.includes("operator.preflight"),
    "fixture-cli-supported-methods",
  );
  await stopChild(child);
  cliChild = undefined;
}

const psLiteral = (text) => `'${text.replaceAll("'", "''")}'`;
/** Capture only direct descendants with this exact bundle/workspace. No PID-wide tree kill. */
async function ownedChildren(parentPid, known = []) {
  const selector = known.length
    ? known.map((child) => `ProcessId = ${child.pid}`).join(" OR ")
    : `ParentProcessId = ${parentPid}`;
  const command = `$ErrorActionPreference = 'Stop'; $items = @(Get-CimInstance Win32_Process -Filter ${psLiteral(selector)} | Where-Object { $_.ParentProcessId -eq ${parentPid} -and $_.CommandLine.Contains(${psLiteral(bundle)}) -and $_.CommandLine.Contains(${psLiteral(fixture.workspace)}) } | ForEach-Object { @{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToUniversalTime().Ticks.ToString() } }); ConvertTo-Json -Compress -InputObject $items`;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  const parsed = JSON.parse(stdout);
  check(
    Array.isArray(parsed) &&
      parsed.every((child) => Number.isInteger(child.pid) && child.pid > 0 && /^[0-9]+$/.test(child.created)),
    "owned-child-observation-valid",
  );
  return parsed;
}
async function waitChildrenGone(parentPid, known, force) {
  try {
    await waitUntil(async () => (await ownedChildren(parentPid, known)).length === 0, 10_000);
    return;
  } catch {
    if (!force) throw new SafeFailure("bundled-child-did-not-exit");
  }
  // A still-running child is eligible only while its exact creation identity remains.
  for (const child of known) {
    const current = await ownedChildren(parentPid, [child]);
    if (!current.some((candidate) => candidate.pid === child.pid && candidate.created === child.created)) continue;
    const command = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; if ($p -and $p.ParentProcessId -eq ${parentPid} -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq ${psLiteral(child.created)} -and $p.CommandLine.Contains(${psLiteral(bundle)}) -and $p.CommandLine.Contains(${psLiteral(fixture.workspace)})) { Stop-Process -Id ${child.pid} -Force }`;
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
    });
  }
  await waitUntil(async () => (await ownedChildren(parentPid, known)).length === 0, 10_000);
}
async function captureNativeMainIdentity() {
  check(Number.isInteger(nativeMainPid) && nativeMainPid > 0, "native-main-identity-pid-valid");
  const command = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${nativeMainPid}'; if (-not $p -or $p.ExecutablePath -ne ${psLiteral(electronExecutable)} -or -not $p.CommandLine.Contains(${psLiteral(`--user-data-dir=${fixture.profile}`)}) -or -not $p.CommandLine.Contains(${psLiteral(appDir)})) { throw 'identity-refused' }; $p.CreationDate.ToUniversalTime().Ticks.ToString()`;
  try {
    const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
    });
    const created = result.stdout.trim();
    check(/^[0-9]+$/.test(created), "native-main-creation-identity-observed");
    nativeMainCreated = created;
  } catch {
    throw new SafeFailure("native-main-creation-identity-refused");
  }
}
async function confirmOwnedIntentAbandonment() {
  check(
    (await app.evaluate(() => process.pid)) === nativeMainPid && /^[0-9]+$/.test(nativeMainCreated ?? ""),
    "request-native-intent-owner-current",
  );
  const scriptFile = join(fixture.root, "confirm-owned-intent.ps1");
  await writeFile(
    scriptFile,
    String.raw`param([int]$OwnedPid, [string]$ExpectedCreationTicks)
$ErrorActionPreference = 'Stop'
$flags = [ordered]@{
  identityVerified = $false; assembliesLoaded = $false; dialogFound = $false
  dialogUnique = $false; buttonsExact = $false; invokeSupported = $false
  invoked = $false; dialogGone = $false
}
try {
  function Assert-OwnedProcess {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnedPid"
    if (-not $p -or $p.CreationDate.ToUniversalTime().Ticks.ToString() -ne $ExpectedCreationTicks) { throw 'identity-refused' }
  }
  Assert-OwnedProcess
  $flags.identityVerified = $true
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $flags.assembliesLoaded = $true
  $owned = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnedPid)
  $question = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Abandon this launch intent?')
  function Find-OwnedDialogs {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $owned)
    $found = @()
    foreach ($win in $windows) {
      if ($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $question).Count -gt 0) { $found += $win }
    }
    return ,$found
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
    Assert-OwnedProcess
    $dialogs = Find-OwnedDialogs
    if ($dialogs.Count -gt 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  $flags.dialogFound = $dialogs.Count -gt 0
  if ($dialogs.Count -ne 1) { throw 'dialog-missing-or-ambiguous' }
  $flags.dialogUnique = $true
  $buttonType = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $buttons = $dialogs[0].FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonType)
  $keep = @($buttons | Where-Object { $_.Current.Name -ceq 'Keep retained intent' })
  $abandon = @($buttons | Where-Object { $_.Current.Name -ceq 'Abandon intent' })
  if ($keep.Count -ne 1 -or $abandon.Count -ne 1) { throw 'buttons-not-exact' }
  $flags.buttonsExact = $true
  $pattern = $null
  if (-not $abandon[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'invoke-unavailable' }
  $flags.invokeSupported = $true
  Assert-OwnedProcess
  ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
  $flags.invoked = $true
  do {
    Assert-OwnedProcess
    $dialogs = Find-OwnedDialogs
    if ($dialogs.Count -eq 0) { $flags.dialogGone = $true; break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
} catch {
  # Fixed boolean flags only; neither native UI text nor exception details are emitted.
}
$flags | ConvertTo-Json -Compress
`,
  );
  let flags;
  try {
    // The policy applies to this helper process only; no host policy is changed.
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptFile,
        String(nativeMainPid),
        nativeMainCreated,
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4096,
      },
    );
    flags = JSON.parse(stdout);
  } catch {
    throw new SafeFailure("request-native-intent-confirmation-unavailable");
  }
  const names = [
    "identityVerified",
    "assembliesLoaded",
    "dialogFound",
    "dialogUnique",
    "buttonsExact",
    "invokeSupported",
    "invoked",
    "dialogGone",
  ];
  for (const name of names) receipt.checks[`request-native-intent-${name}`] = flags?.[name] === true;
  check(
    names.every((name) => flags?.[name] === true),
    "request-native-intent-confirmation-complete",
  );
  currentOperation = "request-new-work-reset";
  let reset;
  try {
    await waitUntil(async () => {
      reset = await guided().evaluate((root, originalAdmissionId) => {
        const recovery = [...root.querySelectorAll("button")].find(
          (button) => button.textContent.trim() === "Recover original launch",
        );
        const taskPath = [...root.querySelectorAll(".orca-field__path")].find(
          (path) => path.textContent === "vars.task",
        );
        const task = taskPath?.closest(".orca-field")?.querySelector("input");
        return {
          retainedIntentCleared: recovery === undefined,
          originalReceiptCleared: !root.textContent.includes(originalAdmissionId),
          typedTaskEditable: Boolean(task && !task.disabled),
        };
      }, receipt.ids.directAdmissionId);
      return reset.retainedIntentCleared && reset.originalReceiptCleared && reset.typedTaskEditable;
    }, 10_000);
  } catch {
    for (const name of ["retainedIntentCleared", "originalReceiptCleared", "typedTaskEditable"])
      receipt.checks[`request-new-work-${name}`] = reset?.[name] === true;
    throw new SafeFailure("request-new-work-state-not-cleared");
  }
  for (const name of ["retainedIntentCleared", "originalReceiptCleared", "typedTaskEditable"])
    check(reset[name], `request-new-work-${name}`);
}
async function observeClient(application) {
  await application.evaluate(
    ({ app }, { modulePath, methods }) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(process.getBuiltinModule("path").join(app.getAppPath(), "package.json"));
      const { DaemonClient } = require(modulePath);
      const observation = { methods: {}, receipts: [], preflight: [] };
      globalThis.m21Observation = observation;
      const original = DaemonClient.prototype.call;
      DaemonClient.prototype.call = async function (...args) {
        const method = args[0];
        if (methods.includes(method)) observation.methods[method] = (observation.methods[method] ?? 0) + 1;
        const result = await original.apply(this, args);
        const admissionMethods = [
          "operator.admitRun",
          "operator.submitRequest",
          "operator.admission",
          "operator.reconcileAdmission",
        ];
        const admission = admissionMethods.includes(method) && result?.state === "resolved" ? result.result : undefined;
        if (admission?.state === "accepted")
          observation.receipts.push({
            method,
            admissionId: admission.admissionId,
            runId: admission.runId,
            ...(typeof admission.requestId === "string" ? { requestId: admission.requestId } : {}),
          });
        if (method === "operator.preflight") {
          const params = args[1] ?? {};
          const vars = params.vars ?? {};
          const fields = result?.inputSchema?.fields ?? {};
          const errors = result?.validation?.errors ?? [];
          const paths = [
            "vars.task",
            "vars.count",
            "vars.enabled",
            "vars.request",
            "vars.request.title",
            "vars.request.body",
            "vars.itemWorkflow",
            "overrides.roles.builder",
            "overrides.model.worker-b",
            "overrides.itemWorkflow",
            "overrides.templatePack",
          ];
          observation.preflight.push({
            valid: result?.validation?.ok === true,
            fixtureDirect: params.workflowId === "m21-typed-task" && Object.hasOwn(vars, "task"),
            fixtureRequest: params.workflowId === "m21-request-program" && params.request !== undefined,
            errorsPresent: errors.length > 0,
            errorPaths: Object.fromEntries(paths.map((path) => [path, errors.some((issue) => issue.path === path)])),
            otherErrorPath: errors.some((issue) => !paths.includes(issue.path)),
            types: {
              taskString: typeof vars.task === "string",
              countInteger: Number.isInteger(vars.count),
              enabledBoolean: typeof vars.enabled === "boolean",
              requestTitleString: typeof params.request?.title === "string",
              requestBodyString: typeof params.request?.body === "string",
              declaredTaskString: fields.task?.type === "string",
              declaredCountInteger: fields.count?.type === "integer",
              declaredEnabledBoolean: fields.enabled?.type === "boolean",
              declaredRequestObject: fields.request?.type === "object",
            },
            exactGuards:
              result?.workflowId === params.workflowId &&
              result?.workflowVersion === params.workflowVersion &&
              result?.expectedWorkflowRevision === params.expectedWorkflowRevision &&
              result?.expectedConfigGeneration === params.expectedConfigGeneration &&
              result?.target?.workspaceId === params.target?.workspaceId &&
              result?.target?.instanceId === params.target?.instanceId,
            requestOverridesResolved:
              result?.selections?.some(
                (selection) =>
                  selection.nodeId === "task" &&
                  selection.agent?.value === "worker-b" &&
                  selection.agent?.source === "run.overrides.roles" &&
                  selection.model?.value === "worker-b-model" &&
                  selection.model?.source === "run.overrides.model" &&
                  selection.template?.value === "strict/m21/task" &&
                  selection.template?.source === "run.overrides.templatePack",
              ) === true &&
              result?.itemWorkflow?.value === "m21-item" &&
              result?.templatePack?.value === "strict",
          });
        }
        return result;
      };
    },
    { modulePath: clientModule, methods: METHODS },
  );
}
async function observation() {
  return app.evaluate(() => globalThis.m21Observation);
}
async function mergeMethods() {
  const observed = await observation();
  for (const [method, count] of Object.entries(observed.methods))
    if (METHODS.includes(method)) receipt.methods[method] = (receipt.methods[method] ?? 0) + count;
}
async function launchApp(restart = false) {
  app = await electron.launch({
    executablePath: electronExecutable,
    args: [`--user-data-dir=${fixture.profile}`, appDir],
    cwd: fixture.workspace,
    env: { ...environment(), ORCA_WORKSPACE: fixture.workspace },
    timeout: TIMEOUT,
  });
  nativeMainPid = app.process().pid;
  const native = await app.evaluate(async ({ app, safeStorage }) => {
    await app.whenReady();
    return {
      profile: app.getPath("userData"),
      available: safeStorage.isEncryptionAvailable(),
      ready: app.isReady(),
      pid: process.pid,
      electron: process.versions.electron,
    };
  });
  const actual = statSync(native.profile, { bigint: true }),
    expected = statSync(fixture.profile, { bigint: true });
  check(native.ready && native.available, restart ? "restart-native-storage-available" : "native-storage-available");
  check(native.electron === "44.4.5", "pinned-electron-runtime");
  check(Number.isInteger(native.pid) && native.pid > 0, "native-main-process-observed");
  nativeMainPid = native.pid;
  check(
    realpathSync.native(native.profile) === realpathSync.native(fixture.profile) &&
      actual.ino > 0n &&
      actual.ino === expected.ino &&
      actual.dev === expected.dev,
    restart ? "restart-same-physical-profile" : "isolated-physical-profile",
  );
  await captureNativeMainIdentity();
  bundledChildren = await ownedChildren(nativeMainPid);
  // Startup runs concurrently with the window; capture again after the live handshake.
  page = await app.firstWindow({ timeout: TIMEOUT });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", () => {
    rendererErrors++;
    receipt.checks["renderer-no-page-errors"] = false;
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => window.orca?.connection.read().state === "live" && window.orca.daemonConnection.read().identity !== undefined,
  );
  const target = await page.evaluate(() => window.orca.daemonConnection.read());
  check(
    target.source === "bundled" && !target.environmentOverride,
    restart ? "restart-source-bundled-daemon" : "source-bundled-daemon",
  );
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(target.url), "bundled-loopback-endpoint");
  fixture.url = target.url;
  fixture.target = target.identity;
  bundledChildren = await ownedChildren(nativeMainPid);
  check(bundledChildren.length === 1, "one-exact-owned-bundled-child");
  const discovery = await rpc("operator.discover");
  check(
    discovery.authentication === "credential",
    restart ? "restart-authenticated-daemon" : "bundled-daemon-authenticated",
  );
  receipt.ids.workspaceId = discovery.target.workspaceId;
  await observeClient(app);
  check(rendererErrors === 0, "renderer-no-page-errors");
}
async function closeApp(requireGraceful = false) {
  if (!app) return;
  const closing = app;
  app = undefined;
  const child = closing.process(),
    parentPid = nativeMainPid;
  const descendants = bundledChildren.length ? bundledChildren : await ownedChildren(parentPid);
  const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;
  let graceful = true;
  try {
    await bounded(closing.close(), 15_000);
  } catch {
    graceful = false;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (exited) await bounded(exited, 10_000);
  await waitChildrenGone(parentPid, descendants, !graceful);
  bundledChildren = [];
  nativeMainPid = undefined;
  nativeMainCreated = undefined;
  if (requireGraceful) check(graceful, "graceful-app-restart-exit");
}

// PrimaryPane also carries data-surface for density. Pin the actual mounted editor,
// whose one direct body owns scrolling while its save bar stays outside that body.
const CONFIG_SURFACE = '.orca-config[data-surface="config"]';
const surface = () => page.locator(CONFIG_SURFACE);
const studio = () => page.getByLabel("Template studio", { exact: true });
const guided = () => page.getByRole("region", { name: "Guided launch", exact: true });
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const field = (path) =>
  surface()
    .locator(".orca-field")
    .filter({ has: page.locator(".orca-field__path").filter({ hasText: new RegExp(`^${escapeRegex(path)}$`) }) })
    .locator("input, select, textarea")
    .first();
async function navigate(label) {
  await page.getByRole("navigation", { name: "Surfaces" }).getByRole("button", { name: label, exact: true }).click();
}
async function choose(scope, label, item, keyboard = false, operation, exactMenuLabel = false) {
  if (operation) currentOperation = `${operation}-open-menu`;
  const trigger = scope.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  await trigger.click();
  if (operation) currentOperation = `${operation}-find-option`;
  // Retained-launch hints are part of the accessible name. The Menu primitive exposes
  // its exact label separately, so selection never guesses or reads an operation hint.
  const option = exactMenuLabel
    ? page
        .getByRole("menu", { name: label, exact: true })
        .locator(`[role="menuitem"][data-orca-menu-label=${JSON.stringify(item)}]`)
    : page.getByRole("menuitem", { name: item, exact: true });
  if (operation) {
    await option.waitFor();
    check((await option.count()) === 1, `${operation}-option-unique`);
    check((await option.getAttribute("aria-disabled")) !== "true", `${operation}-option-enabled`);
  }
  if (keyboard) {
    await option.focus();
    if (operation) currentOperation = `${operation}-keyboard-choose`;
    await page.keyboard.press("Enter");
  } else await option.click();
  if (operation) receipt.checks[`${operation}-completed`] = true;
}
async function pressTwice(locator) {
  // Both DOM clicks occur in the same renderer task. Production pending guards own deduplication.
  await locator.evaluate((button) => {
    button.click();
    button.click();
  });
}
async function configForm() {
  await navigate("Config");
  await field("roles.builder").waitFor();
  const before = await rpc("config.get");
  check(before.formSchema !== undefined, "mounted-rich-config-form");
  const sourceBefore = await readFile(join(fixture.workspace, "orca.config.yaml"), "utf8");
  await choose(surface(), "Add hosts entry", "local");
  await field("hosts[1].id").fill("m21-local");
  await surface().getByRole("button", { name: "Add agents entry", exact: true }).click();
  await field("agents[2].id").fill("m21-config-agent");
  await field("agents[2].command").fill(join(fixture.root, "agent-must-not-start.exe"));
  await field("agents[2].hostId").selectOption("m21-local");
  await surface()
    .getByLabel(/New roles key/)
    .fill("observer");
  await surface().getByRole("button", { name: "Add roles key", exact: true }).click();
  await field("roles.observer").selectOption("m21-config-agent");
  check((await field("roles.observer").inputValue()) === "m21-config-agent", "config-new-reference-selectors");
  const reviewGroup = surface().getByRole("region", { name: "Configuration review and activation" });
  await pressTwice(reviewGroup.getByRole("button", { name: "Validate and review", exact: true }));
  await reviewGroup.getByRole("heading", { name: "Review configuration changes", exact: true }).waitFor();
  check(
    (await readFile(join(fixture.workspace, "orca.config.yaml"), "utf8")) === sourceBefore,
    "config-validate-writes-nothing",
  );
  await field("hosts[1].id").fill("");
  check(
    await reviewGroup.getByRole("button", { name: "Save reviewed changes", exact: true }).isDisabled(),
    "config-edit-invalidates-review",
  );
  await reviewGroup.getByRole("button", { name: "Validate and review", exact: true }).click();
  await field("hosts[1].id").locator("..").locator(".orca-field__error").waitFor();
  check(
    await reviewGroup.getByRole("button", { name: "Save reviewed changes", exact: true }).isDisabled(),
    "config-invalid-cannot-save",
  );
  await field("hosts[1].id").fill("m21-local");
  await reviewGroup.getByRole("button", { name: "Validate and review", exact: true }).click();
  await waitUntil(
    async () => !(await reviewGroup.getByRole("button", { name: "Save reviewed changes", exact: true }).isDisabled()),
  );
  await field("roles.builder").focus();
  await page.keyboard.press("Control+s");
  await reviewGroup.getByRole("button", { name: "Apply saved configuration", exact: true }).waitFor();
  const saved = await rpc("config.get");
  check(
    saved.config.revision !== before.config.revision &&
      saved.generation.activeGeneration === before.generation.activeGeneration &&
      saved.generation.activeRevision === before.config.revision &&
      saved.generation.state === "restart-required",
    "config-save-separate-from-apply",
  );
  const source = await readFile(join(fixture.workspace, "orca.config.yaml"), "utf8");
  const parsed = parseYaml(source);
  check(source.includes(COMMENT), "config-preserves-comments");
  check(
    parsed.hosts[1].id === "m21-local" &&
      parsed.agents[2].hostId === "m21-local" &&
      parsed.roles.observer === "m21-config-agent" &&
      parsed.roles.builder === "worker-a",
    "config-structured-source-persisted",
  );
  check(
    !Object.hasOwn(parsed.agents[2], "env") && !Object.hasOwn(parsed.agents[2], "permissions"),
    "config-absent-defaults-stay-absent",
  );
  const applyCount = (await observation()).methods["config.apply"] ?? 0;
  await pressTwice(reviewGroup.getByRole("button", { name: "Apply saved configuration", exact: true }));
  await waitUntil(async () => ((await observation()).methods["config.apply"] ?? 0) > applyCount);
  await reviewGroup.getByText("Apply outcome: restart-required.", { exact: true }).waitFor();
  const refused = await rpc("config.get");
  check(
    refused.generation.state === "restart-required" &&
      refused.generation.activeGeneration === before.generation.activeGeneration &&
      refused.generation.restartRequired.includes("hosts") &&
      refused.generation.restartRequired.includes("agents"),
    "config-host-agent-apply-requires-restart",
  );
  fixture.structuralSource = digest(source);
}
async function configRestartAndRoleApply() {
  await mergeMethods();
  await closeApp(true);
  await launchApp(true);
  await navigate("Config");
  await field("roles.observer").waitFor();
  check(
    (await field("roles.observer").inputValue()) === "m21-config-agent" &&
      (await field("agents[2].hostId").inputValue()) === "m21-local",
    "config-restart-adopts-new-host-agent-role",
  );
  const before = await rpc("config.get");
  check(
    before.config.revision === fixture.structuralSource &&
      before.generation.state === "active" &&
      before.generation.activeRevision === fixture.structuralSource,
    "config-restart-activates-structural-save",
  );
  await field("roles.builder").selectOption("worker-b");
  const reviewGroup = surface().getByRole("region", { name: "Configuration review and activation" });
  await reviewGroup.getByRole("button", { name: "Validate and review", exact: true }).click();
  await waitUntil(
    async () => !(await reviewGroup.getByRole("button", { name: "Save reviewed changes", exact: true }).isDisabled()),
  );
  await pressTwice(reviewGroup.getByRole("button", { name: "Save reviewed changes", exact: true }));
  await reviewGroup.getByRole("button", { name: "Apply saved configuration", exact: true }).waitFor();
  const saved = await rpc("config.get");
  check(
    saved.generation.state === "pending" && saved.generation.activeGeneration === before.generation.activeGeneration,
    "config-role-save-remains-unapplied",
  );
  await pressTwice(reviewGroup.getByRole("button", { name: "Apply saved configuration", exact: true }));
  await waitUntil(async () => (await rpc("config.get")).generation.state === "active");
  const applied = await rpc("config.get");
  check(
    applied.generation.activeGeneration !== before.generation.activeGeneration &&
      applied.generation.activeRevision === saved.config.revision,
    "config-role-apply-activates-exact-save",
  );
  const source = await readFile(join(fixture.workspace, "orca.config.yaml"), "utf8");
  check(
    source.includes(COMMENT) && parseYaml(source).roles.builder === "worker-b",
    "config-role-save-preserves-comment",
  );
  receipt.hashes.configSource = digest(source);
  receipt.ids.configGeneration = applied.generation.activeGeneration;
  await navigate("Runs");
  await navigate("Config");
  check((await field("roles.builder").inputValue()) === "worker-b", "config-navigation-keeps-saved-values");
}

async function templates() {
  await surface().getByRole("button", { name: "Templates", exact: true }).click();
  await studio().getByRole("heading", { name: "Templates and packs", exact: true }).waitFor();
  let catalog = await rpc("templates.get");
  const base = catalog.assets.find((asset) => asset.id === TEMPLATE);
  const strict = catalog.assets.find((asset) => asset.id === STRICT);
  check(Boolean(base && strict), "template-base-and-strict-catalog");
  currentOperation = "template-select-base";
  await studio()
    .getByLabel(/^Template\s*template\.id/)
    .selectOption(base.key);
  currentOperation = "template-pack-fixture";
  await studio()
    .getByLabel(/^Pack\s*templatePack/)
    .fill("strict");
  await studio()
    .getByLabel(/^Preview fixtures\s*fixtures/)
    .fill(
      JSON.stringify({
        values: { task: "Synthetic task", marker: "Synthetic partial" },
        artifacts: { intent: "Synthetic intent" },
      }),
    );
  currentOperation = "template-preview-prompt";
  await studio().getByRole("button", { name: "Preview prompt", exact: true }).click();
  await waitUntil(
    async () =>
      (await studio().getByLabel("Rendered prompt", { exact: true }).textContent())?.includes(
        "Strict Synthetic task",
      ) === true,
  );
  const preview = await studio().getByLabel("Rendered prompt", { exact: true }).textContent();
  check(
    preview.includes("Exact partial Synthetic partial") && preview.includes("Synthetic intent"),
    "template-explicit-fixtures-and-exact-partial",
  );
  receipt.hashes.strictFixturePreview = digest(preview);
  await studio()
    .getByLabel(/^Template\s*template\.id/)
    .selectOption(strict.key);
  const sourceField = studio().getByLabel(/^Template source\s*template\.markdown/);
  const originalSource = await sourceField.inputValue();
  const editedSource = originalSource.replace("Strict {{task}}", "Strict reviewed {{task}}");
  check(editedSource !== originalSource, "template-fixture-edit-is-substantive");
  await sourceField.fill(editedSource);
  await navigate("Runs");
  await navigate("Config");
  await surface().getByRole("button", { name: "Templates", exact: true }).click();
  await studio()
    .getByLabel(/^Template\s*template\.id/)
    .selectOption(strict.key);
  check(
    (await studio()
      .getByLabel(/^Template source\s*template\.markdown/)
      .inputValue()) === editedSource,
    "template-navigation-retains-draft",
  );
  await pressTwice(studio().getByRole("button", { name: "Validate and review", exact: true }));
  await studio().getByLabel("Template change review", { exact: true }).waitFor();
  check((await rpc("templates.get")).catalogRevision === catalog.catalogRevision, "template-validation-writes-nothing");
  await studio().getByRole("button", { name: "Save reviewed source", exact: true }).click();
  await waitUntil(
    async () =>
      !(await studio().getByRole("button", { name: "Review saved catalog for Apply", exact: true }).isDisabled()),
  );
  const saved = await rpc("templates.get");
  check(
    saved.catalogRevision !== catalog.catalogRevision && saved.generation === catalog.generation,
    "template-save-separate-from-apply",
  );
  check(
    (await readFile(join(fixture.workspace, "templates/strict.md"), "utf8")) === editedSource &&
      editedSource.includes("# M21 template comment") &&
      editedSource.includes("x-fixture: retained-metadata"),
    "template-source-comments-and-metadata-persist",
  );
  await studio().getByRole("button", { name: "Review saved catalog for Apply", exact: true }).click();
  await waitUntil(
    async () =>
      !(await studio().getByRole("button", { name: "Apply reviewed template catalog", exact: true }).isDisabled()),
  );
  await pressTwice(studio().getByRole("button", { name: "Apply reviewed template catalog", exact: true }));
  await waitUntil(async () => (await rpc("templates.get")).generation !== saved.generation);
  catalog = await rpc("templates.get");
  check(catalog.catalogRevision === saved.catalogRevision, "template-apply-exact-saved-catalog");
  await studio()
    .getByLabel(/^History template\s*history\.template/)
    .selectOption(strict.key);
  await studio().getByRole("button", { name: "Read revision history", exact: true }).click();
  await studio()
    .getByText(/; active generation /)
    .waitFor();
  const history = await rpc("templates.history", { target: fixture.target, key: strict.key });
  check(
    history.entries.some((entry) => entry.revision === digest(editedSource) && entry.generation === catalog.generation),
    "template-history-records-applied-source-digest",
  );
  receipt.hashes.strictSource = digest(editedSource);
  receipt.ids.templateGeneration = catalog.generation;
  fixture.strictKey = strict.key;
}

async function setTheme(theme) {
  await surface().getByRole("button", { name: "Form", exact: true }).click();
  await choose(surface().getByRole("region", { name: "App preferences", exact: true }), "Theme", theme, true);
  await page.waitForFunction((selected) => document.documentElement.dataset.theme === selected, theme);
}
async function audit(label, selector) {
  const root = page.locator(selector);
  const scrollBody = surface().locator(":scope > .orca-config__body");
  check((await root.count()) === 1 && (await root.isVisible()), `audit-root-unique-${label}`);
  check((await scrollBody.count()) === 1 && (await scrollBody.isVisible()), `audit-scroll-owner-unique-${label}`);
  const result = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  check(result.violations.length === 0, `axe-${label}`);
  const geometry = await root.evaluate((root) => {
    const controls = [...root.querySelectorAll("input, select, textarea, .orca-draftbar")].filter(
      (control) => control.getClientRects().length > 0,
    );
    const fits = controls.every((control) => {
      const box = control.getBoundingClientRect();
      return box.left >= -1 && box.right <= window.innerWidth + 1;
    });
    return { controlsFit: fits, documentFits: document.documentElement.scrollWidth <= window.innerWidth + 1 };
  });
  check(geometry.controlsFit && geometry.documentFits, `geometry-${label}`);
  const scrolling = await scrollBody.evaluate(async (body) => {
    body.scrollTop = body.scrollHeight;
    await new Promise((done) => requestAnimationFrame(done));
    const last = body.lastElementChild,
      outer = body.getBoundingClientRect(),
      inner = last.getBoundingClientRect();
    return {
      bounded: getComputedStyle(body).overflowY === "auto",
      endReachable: inner.bottom <= outer.bottom + 2,
      canScroll: body.scrollHeight > body.clientHeight,
    };
  });
  check(scrolling.bounded && scrolling.endReachable && scrolling.canScroll, `scroll-${label}`);
}
async function geometryAndAxe() {
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    for (const narrow of [false, true]) {
      await app.evaluate(
        ({ BrowserWindow }, { narrow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.setContentSize(narrow ? 900 : 1300, 800);
          win.webContents.setZoomFactor(narrow ? 2 : 1);
        },
        { narrow },
      );
      await page.waitForFunction((isNarrow) => (isNarrow ? window.innerWidth < 600 : window.innerWidth > 1000), narrow);
      const size = narrow ? "narrow-200pct" : "wide";
      await audit(`config-${theme}-${size}`, CONFIG_SURFACE);
      await surface().getByRole("button", { name: "Templates", exact: true }).click();
      await studio().getByRole("heading", { name: "Templates and packs", exact: true }).waitFor();
      await audit(`templates-${theme}-${size}`, '[aria-label="Template studio"]');
      await surface().getByRole("button", { name: "Form", exact: true }).click();
      await surface().getByRole("button", { name: "Launch work", exact: true }).click();
      await guided().getByRole("button", { name: "Preview launch", exact: true }).waitFor();
      await audit(`launch-${theme}-${size}`, '[aria-label="Guided launch"]');
      await guided().getByRole("button", { name: "Close", exact: true }).click();
    }
  }
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomFactor(1);
    win.setContentSize(1300, 800);
  });
}
async function openLaunch(operation = "launch") {
  currentOperation = `${operation}-entry-config-navigation`;
  await navigate("Config");
  currentOperation = `${operation}-entry-open`;
  await surface().getByRole("button", { name: "Launch work", exact: true }).click();
  currentOperation = `${operation}-entry-preview-mounted`;
  await guided().getByRole("button", { name: "Preview launch", exact: true }).waitFor();
  currentOperation = currentPhase;
}
async function chooseWorkflow(id, operation) {
  const label = id === DIRECT ? "M21 typed task (1)" : "M21 Request program (1)";
  await choose(guided(), "Workflow", label, true, operation);
}
async function confirmPermission() {
  await guided().getByRole("checkbox").check();
}
async function diagnoseLaunchPreview(mode) {
  // Classify only fixed controller messages and explicit fixture declaration paths/types.
  // Raw DOM text, RPC input values, errors and unknown paths never leave their owner.
  try {
    const messages = await guided().evaluate((root) => {
      const text = root.closest('[aria-label="Launch work workspace"]')?.textContent ?? "";
      const known = {
        "context-reading": "Reading the current authorized connection. Your original draft is retained.",
        "context-changed": "Configuration or connection changed. Review the draft again.",
        "target-changed":
          "Target changed. Return to the original target to recover pending work, or explicitly review this draft for the new target.",
        "guard-changed": "The workflow, target or active configuration changed. Refresh and review again.",
        "inputs-refused": "Inputs could not be validated. Your draft is retained.",
        "command-unavailable": "Validation is unavailable or the command is invalid. Your draft is retained.",
        "authority-refused":
          "Current authorization refused the launch operation. Your draft and any retained intent are preserved.",
        "guard-stale":
          "The target, workflow or active configuration is stale. Your draft and any retained intent are preserved.",
        "runtime-inputs-refused":
          "The runtime refused input validation. Your draft and any retained intent are preserved.",
        "port-unavailable": "The launch operation is unavailable. Your draft and any retained intent are preserved.",
        "context-unavailable":
          "Guided launch could not verify this target. Check connection, configuration and checkout, then read again. Your original draft is retained.",
        checking: "Validating inputs and the active configuration.",
        review: "Review the exact target, workflow and inputs before launching.",
        "new-work-selected": "New work selected. Review before launching; previous work was not cancelled.",
        "new-work-abandon-refused": "The original intent could not be abandoned. Recover it before starting new work.",
        "new-work-target-changed": "Return to the original target before abandoning this intent.",
        "new-work-unresolved":
          "The original launch acknowledgement and intent handle are unresolved. Recover or inspect its protected main-owned intent before starting new work.",
        admitted: "Work admitted. Execution is not yet confirmed complete.",
      };
      return Object.fromEntries(Object.entries(known).map(([name, message]) => [name, text.includes(message)]));
    });
    for (const [name, present] of Object.entries(messages))
      receipt.checks[`diagnostic-${mode}-message-${name}`] = present;
    const observed = await observation();
    const record = observed.preflight.findLast((entry) =>
      mode === "direct" ? entry.fixtureDirect : entry.fixtureRequest,
    );
    receipt.checks[`diagnostic-${mode}-preflight-observed`] = record !== undefined;
    if (record) {
      for (const name of ["valid", "errorsPresent", "otherErrorPath", "exactGuards"])
        receipt.checks[`diagnostic-${mode}-preflight-${name}`] = record[name];
      for (const [path, present] of Object.entries(record.errorPaths))
        receipt.checks[`diagnostic-${mode}-preflight-error-${path}`] = present;
      for (const [name, matches] of Object.entries(record.types))
        receipt.checks[`diagnostic-${mode}-preflight-type-${name}`] = matches;
    }
  } catch {
    receipt.checks[`diagnostic-${mode}-capture-available`] = false;
  }
}
async function diagnoseRequestControls() {
  try {
    const flags = await page.evaluate(() => {
      const config = document.querySelector('.orca-config[data-surface="config"]');
      const root = config?.querySelector('[aria-label="Guided launch"]');
      const flags = { "config-mounted": config !== null, "guided-mounted": root !== undefined && root !== null };
      const visible = (element) => Boolean(element?.getClientRects().length);
      const status = (name, element) => {
        flags[`${name}-mounted`] = element !== undefined && element !== null;
        flags[`${name}-visible`] = visible(element);
        flags[`${name}-enabled`] = Boolean(
          element && !element.disabled && element.getAttribute("aria-disabled") !== "true",
        );
      };
      const button = (owner, label) =>
        [...(owner?.querySelectorAll("button") ?? [])].find(
          (element) => element.getAttribute("aria-label") === label || element.textContent.trim() === label,
        );
      const field = (path) => {
        const marker = [...(root?.querySelectorAll(".orca-field__path") ?? [])].find(
          (element) => element.textContent === path,
        );
        return marker?.closest(".orca-field")?.querySelector("input, textarea");
      };
      status("launch-entry", button(config, "Launch work"));
      for (const [name, label] of [
        ["new-work", "Start explicit new work"],
        ["preview", "Preview launch"],
        ["mode", "Launch mode"],
        ["workflow", "Workflow"],
        ["agent-override", "Agent for builder"],
        ["model-override", "Model for worker-b"],
        ["item-override", "Item workflow"],
        ["pack-override", "Template pack"],
      ])
        status(name, button(root, label));
      for (const [name, path] of [
        ["title", "title"],
        ["body", "body"],
        ["direct-task", "vars.task"],
        ["item-input", "vars.itemWorkflow"],
      ])
        status(name, field(path));
      const mode = button(root, "Launch mode"),
        workflow = button(root, "Workflow");
      flags["direct-mode-selected"] = mode?.textContent.trim() === "Start a workflow";
      flags["request-mode-selected"] = mode?.textContent.trim() === "Submit a Request";
      flags["direct-workflow-selected"] = workflow?.textContent.trim() === "M21 typed task (1)";
      flags["request-workflow-selected"] = workflow?.textContent.trim() === "M21 Request program (1)";
      for (const [name, label] of [
        ["request-mode-option", "Submit a Request"],
        ["request-workflow-option", "M21 Request program (1)"],
      ]) {
        const option = [...document.querySelectorAll('[role="menuitem"]')].find(
          (element) =>
            element.querySelector("[data-orca-menu-label]")?.textContent === label ||
            element.textContent.trim() === label,
        );
        status(name, option);
      }
      return flags;
    });
    for (const [name, present] of Object.entries(flags)) receipt.checks[`diagnostic-request-control-${name}`] = present;
  } catch {
    receipt.checks["diagnostic-request-controls-available"] = false;
  }
}
async function previewLaunch(mode) {
  const preview = guided().getByRole("button", { name: "Preview launch", exact: true });
  currentOperation = `${mode}-preview-context`;
  try {
    // Navigation deliberately refreshes authority. DOM click ignores a disabled button;
    // wait for the production current-context gate before exercising repeated clicks.
    await waitUntil(async () => !(await preview.isDisabled()), 10_000);
  } catch {
    receipt.checks["preview-current-context-ready"] = false;
    await diagnoseLaunchPreview(mode);
    throw new SafeFailure("preview-current-context-ready");
  }
  check(true, "preview-current-context-ready");
  currentOperation = `${mode}-preview-review`;
  try {
    await pressTwice(preview);
    await guided()
      .getByText("Review the exact target, workflow and inputs before launching.", { exact: true })
      .waitFor();
  } catch (error) {
    await diagnoseLaunchPreview(mode);
    throw error;
  }
  currentOperation = currentPhase;
}
async function admitted(method, previous) {
  await waitUntil(
    async () => (await observation()).receipts.filter((entry) => entry.method === method).length > previous,
  );
  const observed = await observation();
  const receipts = observed.receipts.filter((entry) => entry.method === method);
  check(receipts.length === previous + 1, `${method === DIRECT_METHOD ? "direct" : "request"}-single-admission`);
  const result = receipts.at(-1);
  const mode = method === DIRECT_METHOD ? "direct" : "request";
  receipt.ids[method === DIRECT_METHOD ? "directRunId" : "requestRunId"] = result.runId;
  receipt.ids[method === DIRECT_METHOD ? "directAdmissionId" : "requestAdmissionId"] = result.admissionId;
  if (result.requestId) receipt.ids.requestId = result.requestId;
  let run;
  currentOperation = `${mode}-admitted-gate-read`;
  await waitUntil(async () => {
    const parsed = RunsGetResultSchema.safeParse(await rpc("runs.get", { runId: result.runId }));
    check(parsed.success, "admitted-run-contract-valid");
    run = parsed.data;
    check(!run.steps.some((step) => step.nodeId === "task"), `${mode}-agent-step-not-scheduled`);
    return run.steps.some(
      (step) => step.nodeId === "hold" && step.status === "waiting" && step.waitingOn === "human-input",
    );
  });
  check(
    run.run.id === result.runId &&
      run.steps.some(
        (step) => step.nodeId === "hold" && step.nodeType === "gate" && step.waitingOn === "human-input",
      ) &&
      !run.steps.some((step) => step.agentId !== undefined || step.agentSessionId !== undefined),
    `${mode}-parked-before-agent`,
  );
  // Read only the settled public event log in this disposable store. Protected inputs
  // and executable-generation material are never opened or returned by this check.
  const events = (await readFile(join(fixture.workspace, ".orca/runs", `${result.runId}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const created = events.find((event) => event.type === "run.created");
  const hold = events.find((event) => event.type === "step.scheduled" && event.payload.nodeId === "hold");
  check(
    created?.runId === result.runId &&
      created.payload.workflowId === (method === DIRECT_METHOD ? DIRECT : PROGRAM) &&
      hold !== undefined &&
      events.some((event) => event.type === "human.requested" && event.payload.stepRunId === hold.payload.stepRunId) &&
      !events.some((event) => event.type === "step.scheduled" && event.payload.nodeId === "task") &&
      !events.some((event) => event.type.startsWith("agent.")),
    `${mode}-public-events-confirm-gate-before-agent`,
  );
  if (method === REQUEST_METHOD) {
    const provenance = created?.payload?.provenance;
    check(
      provenance?.itemWorkflow?.value === ITEM &&
        provenance?.itemWorkflow?.source === "run.overrides.itemWorkflow" &&
        provenance?.templatePack?.value === "strict",
      "request-persisted-item-workflow-provenance",
    );
    check(
      provenance?.selections?.some(
        (selection) =>
          selection.nodeId === "task" &&
          selection.agent.value === "worker-b" &&
          selection.model?.value === "worker-b-model" &&
          selection.template?.value === STRICT,
      ) === true,
      "request-persisted-resolved-selections",
    );
  }
  check((await git(fixture.project, "status", "--porcelain")) === "", "prepared-project-unchanged");
  currentOperation = currentPhase;
  return result;
}
async function guidedDirect() {
  await openLaunch();
  await guided().getByRole("button", { name: "Start explicit new work", exact: true }).click();
  await chooseWorkflow(DIRECT);
  await guided()
    .getByLabel(/^task\s*vars\.task/)
    .fill("Synthetic typed task");
  await guided()
    .getByLabel(/^count\s*vars\.count/)
    .fill("not-an-integer");
  check(
    await guided().getByRole("button", { name: "Preview launch", exact: true }).isDisabled(),
    "direct-invalid-typed-input-blocks-preview",
  );
  await guided()
    .getByLabel(/^count\s*vars\.count/)
    .fill("2");
  await guided()
    .getByLabel(/^enabled\s*vars\.enabled/)
    .fill("true");
  await guided().getByRole("button", { name: "Close", exact: true }).click();
  check(
    await surface()
      .getByRole("button", { name: "Launch work", exact: true })
      .evaluate((button) => button === document.activeElement),
    "launch-close-restores-entry-focus",
  );
  await openLaunch();
  check(
    (await guided()
      .getByLabel(/^task\s*vars\.task/)
      .inputValue()) === "Synthetic typed task",
    "launch-close-retains-typed-draft",
  );
  await previewLaunch("direct");
  check(
    await guided().getByRole("button", { name: "Launch", exact: true }).isDisabled(),
    "launch-permission-review-required",
  );
  await audit("direct-review", '[aria-label="Guided launch"]');
  await confirmPermission();
  const before = (await observation()).receipts.filter((entry) => entry.method === DIRECT_METHOD).length;
  await pressTwice(guided().getByRole("button", { name: "Launch", exact: true }));
  await admitted(DIRECT_METHOD, before);
}
async function guidedRequest() {
  try {
    await openLaunch("request");
    currentOperation = "request-start-new-work";
    await guided().getByRole("button", { name: "Start explicit new work", exact: true }).click();
    receipt.checks["request-start-new-work-clicked"] = true;
    currentOperation = "request-native-intent-confirmation";
    await confirmOwnedIntentAbandonment();
    await choose(guided(), "Launch mode", "Submit a Request", true, "request-mode-select");
    await chooseWorkflow(PROGRAM, "request-workflow-select");
    for (const name of ["task", "count", "enabled"]) {
      currentOperation = `request-omit-undeclared-${name}`;
      await guided()
        .getByRole("button", { name: `Omit undeclared input ${name}`, exact: true })
        .click();
    }
    currentOperation = "request-title-input";
    await guided()
      .getByLabel(/^Request title\s*title/)
      .fill("M21 synthetic Request");
    currentOperation = "request-body-input";
    await guided()
      .getByLabel(/^Request body\s*body/)
      .fill("Synthetic descriptor body. No agent execution.");
    await choose(guided(), "Agent for builder", "worker-b", true, "request-agent-override");
    await choose(guided(), "Model for worker-b", "worker-b-model", true, "request-model-override");
    await choose(guided(), "Item workflow", ITEM, true, "request-item-override");
    await choose(guided(), "Template pack", "strict", true, "request-pack-override");
    currentOperation = "request-service-input-check";
    check(
      (await guided()
        .getByLabel(/^request\s*vars\.request/)
        .count()) === 0,
      "request-service-owned-input-not-editable",
    );
    await previewLaunch("request");
    currentOperation = "request-preflight-check";
    const observed = await observation();
    check(
      observed.preflight.at(-1)?.valid === true && observed.preflight.at(-1)?.requestOverridesResolved === true,
      "request-real-preflight-resolves-descriptor-and-overrides",
    );
    currentOperation = "request-agent-provenance-check";
    check(
      await guided()
        .getByText("task: agent worker-b (run.overrides.roles); role builder.", { exact: true })
        .isVisible(),
      "request-mounted-agent-provenance",
    );
    currentOperation = "request-model-provenance-check";
    check(
      await guided().getByText("task: model worker-b-model (run.overrides.model).", { exact: true }).isVisible(),
      "request-mounted-model-provenance",
    );
    currentOperation = "request-review-audit";
    await audit("request-review", '[aria-label="Guided launch"]');
    currentOperation = "request-permission-confirm";
    await confirmPermission();
    const before = observed.receipts.filter((entry) => entry.method === REQUEST_METHOD).length;
    currentOperation = "request-submit";
    await pressTwice(guided().getByRole("button", { name: "Launch", exact: true }));
    await admitted(REQUEST_METHOD, before);
  } catch (error) {
    await diagnoseRequestControls();
    await diagnoseLaunchPreview("request");
    throw error;
  }
}
async function diagnoseRestartRecovery() {
  try {
    const flags = await page.evaluate(
      ({ expectedLabel, admissionId, requestId }) => {
        const config = document.querySelector('.orca-config[data-surface="config"]');
        const root = config?.querySelector('[aria-label="Guided launch"]');
        const workspace = config?.querySelector('[aria-label="Launch work workspace"]');
        const runs = document.querySelector('main[data-surface="runs"]');
        const flags = {
          "guided-mounted": Boolean(root),
          "original-request-selected-in-runs": Boolean(runs?.textContent.includes(requestId)),
        };
        const button = (owner, label) =>
          [...(owner?.querySelectorAll("button") ?? [])].find(
            (element) => element.getAttribute("aria-label") === label || element.textContent.trim() === label,
          );
        for (const [name, owner, label] of [
          ["retained-menu-trigger", workspace, "Protected launch to restore"],
          ["restore", root, "Restore protected launch"],
          ["recover", root, "Recover original launch"],
        ]) {
          const element = button(owner, label);
          flags[`${name}-mounted`] = Boolean(element);
          flags[`${name}-enabled`] = Boolean(
            element && !element.disabled && element.getAttribute("aria-disabled") !== "true",
          );
        }
        const menu = workspace?.querySelector('[role="menu"][aria-label="Protected launch to restore"]');
        const options = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
        const requested = options.filter((element) => element.getAttribute("data-orca-menu-label") === expectedLabel);
        flags["retained-menu-mounted"] = Boolean(menu);
        flags["retained-options-present"] = options.length > 0;
        flags["retained-options-single"] = options.length === 1;
        flags["retained-request-label-present"] = requested.length > 0;
        flags["retained-request-label-unique"] = requested.length === 1;
        flags["retained-request-label-enabled"] =
          requested.length === 1 && requested[0].getAttribute("aria-disabled") !== "true";
        flags["accepted-receipt-mounted"] = Boolean(root?.textContent.includes(`Admission ${admissionId} / accepted`));
        const text = workspace?.textContent ?? "";
        const known = {
          "restore-refused": "The protected launch intent could not be restored.",
          "restore-empty": "No protected launch was found. Your current draft is retained.",
          "scope-refused": "The saved intent belongs to another target or principal.",
          "target-review-required":
            "Review the original authorized target before recovering the exact protected launch.",
          "authority-refused":
            "Current authorization refused the launch operation. Your draft and any retained intent are preserved.",
          "operation-unavailable":
            "The launch operation is unavailable. Your draft and any retained intent are preserved.",
          "context-changed": "Configuration or connection changed. Review the draft again.",
          "restore-reading": "Reading the protected launch. Editing is paused until the read finishes.",
        };
        for (const [name, message] of Object.entries(known)) flags[`message-${name}`] = text.includes(message);
        return flags;
      },
      {
        expectedLabel: `${PROGRAM} (request)`,
        admissionId: receipt.ids.requestAdmissionId,
        requestId: receipt.ids.requestId,
      },
    );
    for (const [name, present] of Object.entries(flags)) receipt.checks[`diagnostic-restart-${name}`] = present;
  } catch {
    receipt.checks["diagnostic-restart-capture-available"] = false;
  }
}
async function restartChecks() {
  try {
    currentOperation = "restart-count-original-runs";
    const before = await rpc("runs.list", { offset: 0, limit: 100 });
    check(before.runs.length === 2, "exactly-two-synthetic-admitted-runs");
    currentOperation = "restart-close-original-app";
    await mergeMethods();
    await closeApp(true);
    currentOperation = "restart-launch-source-bundled-app";
    await launchApp(true);
    currentOperation = "restart-read-original-runs";
    const after = await rpc("runs.list", { offset: 0, limit: 100 });
    check(
      after.runs.length === 2 &&
        after.runs.some((run) => run.id === receipt.ids.directRunId) &&
        after.runs.some((run) => run.id === receipt.ids.requestRunId),
      "restart-keeps-original-runs",
    );
    currentOperation = "restart-config-form";
    await navigate("Config");
    await field("roles.builder").waitFor();
    check(
      (await field("roles.builder").inputValue()) === "worker-b" &&
        (await field("roles.observer").inputValue()) === "m21-config-agent",
      "restart-config-form-persistence",
    );
    const config = await rpc("config.get");
    check(
      config.config.revision === receipt.hashes.configSource && config.generation.state === "active",
      "restart-saved-config-active",
    );
    currentOperation = "restart-template-source";
    await surface().getByRole("button", { name: "Templates", exact: true }).click();
    await studio()
      .getByLabel(/^Template\s*template\.id/)
      .selectOption(fixture.strictKey);
    check(
      digest(
        await studio()
          .getByLabel(/^Template source\s*template\.markdown/)
          .inputValue(),
      ) === receipt.hashes.strictSource,
      "restart-template-source-persistence",
    );
    currentOperation = "restart-template-history";
    await studio()
      .getByLabel(/^History template\s*history\.template/)
      .selectOption(fixture.strictKey);
    await studio().getByRole("button", { name: "Read revision history", exact: true }).click();
    await studio()
      .getByText(/; active generation /)
      .waitFor();
    const history = await rpc("templates.history", { target: fixture.target, key: fixture.strictKey });
    check(
      history.entries.some(
        (entry) =>
          entry.revision === receipt.hashes.strictSource && entry.generation === receipt.ids.templateGeneration,
      ),
      "restart-template-history-persistence",
    );
    currentOperation = "restart-return-config-form";
    await surface().getByRole("button", { name: "Form", exact: true }).click();
    await openLaunch("restart");
    await choose(
      page.getByLabel("Launch work workspace", { exact: true }),
      "Protected launch to restore",
      `${PROGRAM} (request)`,
      true,
      "restart-retained-request-select",
      true,
    );
    currentOperation = "restart-restore-click";
    await guided().getByRole("button", { name: "Restore protected launch", exact: true }).click();
    const recover = guided().getByRole("button", { name: "Recover original launch", exact: true });
    currentOperation = "restart-recover-ready";
    await recover.waitFor();
    await waitUntil(async () => !(await recover.isDisabled()), 10_000);
    check(true, "restart-recovery-control-ready");
    currentOperation = "restart-recover-click";
    await pressTwice(recover);
    currentOperation = "restart-recover-accepted-receipt";
    await waitUntil(
      async () =>
        (await observation()).receipts.some(
          (entry) =>
            ["operator.admission", "operator.reconcileAdmission"].includes(entry.method) &&
            entry.admissionId === receipt.ids.requestAdmissionId &&
            entry.runId === receipt.ids.requestRunId &&
            entry.requestId === receipt.ids.requestId,
        ),
      10_000,
    );
    currentOperation = "restart-recover-mounted-original-work";
    // Accepted recovery navigates to Runs. Its selected detail and exact Request crumb
    // prove the original work is mounted after the real server receipt arrives.
    await waitUntil(
      async () =>
        page.evaluate(
          ({ requestId }) => {
            const runs = document.querySelector('main[data-surface="runs"]');
            const selectedSurface = document.querySelector(
              'nav[aria-label="Surfaces"] button[aria-current="page"] .orca-nav__label',
            );
            const selectedTitle = runs?.querySelector(".orca-runs__detail .orca-inspector__title");
            return Boolean(
              selectedSurface?.textContent === "Runs" &&
              selectedTitle?.textContent === "M21 synthetic Request" &&
              runs?.textContent.includes(requestId),
            );
          },
          { requestId: receipt.ids.requestId },
        ),
      10_000,
    );
    check(true, "restart-mounted-original-work-recovered");
    const recovered = await observation();
    check(
      recovered.receipts.some(
        (entry) =>
          ["operator.admission", "operator.reconcileAdmission"].includes(entry.method) &&
          entry.admissionId === receipt.ids.requestAdmissionId &&
          entry.runId === receipt.ids.requestRunId &&
          entry.requestId === receipt.ids.requestId,
      ),
      "restart-real-server-recovery-original-receipt",
    );
    check(
      (recovered.methods[DIRECT_METHOD] ?? 0) === 0 &&
        (recovered.methods[REQUEST_METHOD] ?? 0) === 0 &&
        (recovered.methods["runs.admit"] ?? 0) === 0 &&
        (recovered.methods["requests.submit"] ?? 0) === 0,
      "restart-recovery-submits-no-new-work",
    );
    check(
      (await rpc("runs.list", { offset: 0, limit: 100 })).runs.length === 2,
      "restart-restore-reuses-original-admission",
    );
    currentOperation = "restart-protected-journal-check";
    const journal = await readFile(join(fixture.profile, "admission-intents.enc"));
    check(
      journal.length > 0 && !journal.includes(Buffer.from("Synthetic descriptor body")),
      "native-protected-journal-withholds-fixture-text",
    );
    receipt.hashes.protectedJournal = digest(journal);
    await mergeMethods();
    currentOperation = currentPhase;
  } catch (error) {
    await diagnoseRestartRecovery();
    throw error;
  }
}
async function cleanup() {
  await stopChild(cliChild);
  cliChild = undefined;
  await closeApp();
  if (fixture) {
    const canonical = await realpath(fixture.root);
    const temporary = await realpath(tmpdir());
    check(
      dirname(canonical) === temporary && /^orca-m21-windows-[A-Za-z0-9]+$/.test(basename(canonical)),
      "cleanup-exact-disposable-root",
    );
    await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fixtureCleaned = true;
  }
  receipt.checks["cleanup-awaited-owned-exits"] = true;
  receipt.checks["cleanup-profile-and-fixture-removed"] = fixtureCleaned;
}

try {
  await phase("prerequisites", async () => {
    check(process.platform === "win32", "windows-required");
    for (const artifact of [
      cli,
      bundle,
      clientModule,
      join(appDir, "dist/main/index.js"),
      join(appDir, "dist/preload/index.cjs"),
      join(appDir, "dist/renderer/index.html"),
      join(appDir, "dist/main/first-run/setup.js"),
      electronExecutable,
    ])
      check(existsSync(artifact), "built-artifacts-present");
    await makeFixture();
  });
  await phase("unsupported-first-run-refusal", firstRunRefusal);
  if (!REFUSAL_ONLY) {
    await phase("synthetic-assets", writeAssets);
    await phase("authenticated-cli-fixture", cliBootstrap);
    await phase("source-bundled-electron", () => launchApp());
    await phase("config-form", configForm);
    await phase("config-restart-and-role-apply", configRestartAndRoleApply);
    await phase("templates", templates);
    await phase("keyboard-axe-geometry", geometryAndAxe);
    await phase("guided-direct", guidedDirect);
    await phase("guided-request", guidedRequest);
    await phase("restart-persistence", restartChecks);
    check(receipt.checks["renderer-no-page-errors"] === true, "renderer-no-page-errors");
    check(!existsSync(join(fixture.root, "agent-must-not-start.exe")), "no-agent-executable-provisioned");
    check((await git(fixture.project, "status", "--porcelain")) === "", "prepared-project-unchanged");
    receipt.accepted = true;
  }
} catch (error) {
  receipt.accepted = false;
  receipt.phases[currentPhase] = false;
  receipt.checks[error instanceof SafeFailure ? error.code : "unexpected-phase-refusal"] = false;
  receipt.checks[`failure-operation-${currentOperation}`] = false;
  if (!(error instanceof SafeFailure)) {
    const message = error instanceof Error ? error.message : "";
    const category = /strict mode violation/.test(message)
      ? "locator-strict"
      : /Timeout|timeout/.test(message)
        ? "locator-timeout"
        : /Target.*closed|has been closed/.test(message)
          ? "application-closed"
          : "unexpected-action";
    receipt.checks[`failure-category-${category}`] = false;
  }
  if (app) {
    try {
      await mergeMethods();
    } catch {
      /* Missing observer is already an acceptance failure. */
    }
  }
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch {
    receipt.accepted = false;
    receipt.checks["cleanup-complete"] = false;
    process.exitCode = 1;
  }
  await mkdir(dirname(receiptFile), { recursive: true });
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
