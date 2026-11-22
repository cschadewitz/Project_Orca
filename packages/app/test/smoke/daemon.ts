/**
 * The daemon the smoke test points the app at: a real `orca demo` store, served by a real
 * `orca serve`, over HTTP, on a port nothing else is using.
 *
 * It runs the *built* CLI (`packages/cli/dist/main.js`) rather than the sources through
 * tsx, for the same reason the smoke test runs the built app: what ships is what is being
 * smoke-tested. `pnpm run build` is a prerequisite of both.
 *
 * ## Why `orca demo` is not enough on its own (#167)
 *
 * `orca demo` drives the program workflow **to completion** with scripted agents, and a
 * finished workspace is the wrong fixture for an accessibility audit. Measured against the
 * store it leaves behind:
 *
 * - `inputs.list` answers `{ inputs: [], waiting: 0 }` — every gate was auto-approved, so
 *   the Attention surface renders its empty state. An empty state is not an audit of a
 *   `GateCard`: the card carries the question, the consequence clauses, the digit keys and
 *   the destructive-option rule, and none of that is on the page when nothing is waiting.
 * - every run is `succeeded`, so the run tree has one status in it and the greyscale check
 *   has nothing to tell apart.
 * - `agents.list` answers one agent on one host, so the Agents surface renders one group
 *   heading. That is a real card and a real audit, but it never exercises a second group.
 *
 * Fixing that is this fixture's business and **not `orca demo`'s** — the demo is a person's
 * first look at ORCA and has its own users, and a demo that parked on a gate or left a
 * failed run behind would be a worse demo to make a better test. So the fixture takes the
 * finished workspace and adds three things to it, through the daemon's own public surface:
 *
 * 1. a **second host** with an agent on it, so Agents has two groups (config, below);
 * 2. a **failed run**, so Attention's third tier and the run tree's `failed` status exist;
 * 3. a **parked gate**, so Attention's tier 2 renders a real `GateCard`.
 *
 * 2 and 3 are two tiny workflows written into the workspace and started over the wire with
 * `runs.start`. Nothing is written into the store by hand: a fixture that forged event-log
 * lines would be asserting against a shape the daemon does not produce.
 *
 * The gate parks because `orca serve` installs `PausingHumanInput` whatever the config's
 * `humanInput` says (packages/cli/src/commands/index.ts) — unless `--read-only`, which this
 * fixture must not pass and which would take `runs.start` away with it. So a gate with no
 * `autoApproveWhen` lands on `inputs.list` and stays there until somebody answers it.
 *
 * A separate local scripted agent is configured for the final live-input smoke. It is
 * started lazily, after the visual audits, so those audits still have one parked gate and
 * the same waiting/failed/succeeded runs. Its callback is cancelled without an approval;
 * no fixture contacts an external agent or service.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { PROTOCOL_VERSION, InputsListResultSchema, type OpenInputView } from "@orca/protocol";

const run = promisify(execFile);

/** Repo root, from this file: packages/app/test/smoke → up four. */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = join(repoRoot, "packages", "cli", "dist", "main.js");

/**
 * `yaml`, resolved from the CLI whose config file this reads rather than added as a
 * dependency of `@orca/app`.
 *
 * The app may import only `@orca/protocol` and `@orca/design` from the workspace (ADR
 * 0008) and that rule is worth keeping true of its `package.json` as well as its imports —
 * so rather than give the app a parser for a file only its test fixture reads, the fixture
 * borrows the one the CLI already installs to read the very same file. `createRequire`
 * anchored at `packages/cli/package.json` resolves exactly what `orca serve` would.
 */
const requireFromCli = createRequire(join(repoRoot, "packages", "cli", "package.json"));
const { parse: parseYaml } = requireFromCli("yaml") as { parse: (text: string) => unknown };

/**
 * What the fixture adds, named once so the spec asserts against these strings rather than
 * against a copy of them. A surface that stops rendering one of these is a red test with
 * the missing text in the message.
 */
export const FIXTURE = {
  /** The second host, so `groupByHost` has two groups to draw and `transportLabel` two answers. */
  host: { id: "builder-2", agentId: "remote-builder", agentName: "Remote builder" },
  /**
   * The parked gate: its workflow, the question on the card and the option a card must not
   * make easy.
   *
   * **Assert on `question`, `destructiveOption` and `safeOption` — not on `title`.** The
   * question and the option labels travel on the wire (`OpenInputView`); a workflow's `name`
   * and a node's `name` do not, so `title` is only what the YAML below is called and is
   * invisible to every surface. A run started by `runs.start` has no work item and no
   * request behind it, so the daemon falls back to the workflow id for its display name:
   * `workflowId` is the run name a card and a row show, and `smoke-gate` is what a reader of
   * a failed screenshot will see.
   */
  gate: {
    workflowId: "smoke-gate",
    title: "Approve the release",
    question: "Publish orca-daemon 0.4.0 to the internal registry?",
    destructiveOption: "Publish",
    safeOption: "Hold for review",
  },
  /**
   * The failed run, for Attention's third tier and for a second status in the tree. `title`
   * is the workflow's `name` and, as above, is not on screen anywhere — the row reads
   * `smoke-failure`.
   */
  failure: { workflowId: "smoke-failure", title: "Nightly regression suite" },
  /** Started only by the live-input smoke, after the existing visual audits finish. */
  live: {
    workflowId: "smoke-live-permission",
    agentId: "smoke-permission-agent",
    subject: "smoke-live-permission.md",
  },
} as const;

export interface Daemon {
  /** What to put in `ORCA_DAEMON_URL`. */
  url: string;
  /** The workspace the demo wrote, `.orca` store and all. */
  dir: string;
  /** The fixture-only credential path; the token stays in its private file. */
  tokenFile: string;
  /** Authenticated fixture calls; credentials never enter the renderer. */
  rpc: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  /** A real ACP callback, with cancellation awaited through its original interpreter. */
  startLivePermission: () => Promise<{ input: OpenInputView; cancel: () => Promise<void> }>;
  stop: () => Promise<void>;
}

/** A port the OS just told us was free. Racy in principle; a single smoke run never loses. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("could not take a port")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/** One request over `/rpc`, answered or thrown. The fixture speaks the wire, like any client. */
async function rpc(
  url: string,
  tokenFile: string,
  method: string,
  params: unknown = {},
): Promise<Record<string, unknown>> {
  const token = (await readFile(tokenFile, "utf8")).trim();
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: "request", id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(`${method} answered HTTP ${res.status}`);
  const body = (await res.json()) as { ok?: boolean; result?: Record<string, unknown>; error?: unknown };
  if (body.ok !== true) throw new Error(`${method} refused: ${JSON.stringify(body.error)}`);
  return body.result ?? {};
}

let nextId = 1;

/** Poll `hello` until the daemon answers it, or give up — a failed handshake is the test's news, not a hang. */
async function waitForHello(url: string, tokenFile: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await rpc(url, tokenFile, "hello", { client: "orca-smoke/0", protocol: PROTOCOL_VERSION });
      return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`daemon at ${url} never answered hello`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Poll until `check` is happy, or say what it was still waiting for. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`the smoke fixture waited for ${what} and it never arrived`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * The durable-gate and failure workflows, as YAML rather than objects here: they are
 * loaded by the same glob and validated by the same schema as any workflow a person writes,
 * so a change to the workflow model breaks this fixture visibly instead of silently.
 *
 * Neither has an `agent` node. A fixture that needed an agent to park a gate would need the
 * scripted agent's playbook to have an entry left, which couples the shape of the Attention
 * surface's fixture to the contents of the demo's script.
 */
const GATE_WORKFLOW = `# Written by packages/app/test/smoke/daemon.ts. Not a workflow anybody ships.
id: ${FIXTURE.gate.workflowId}
name: "${FIXTURE.gate.title}"
version: "1"
start: start
nodes:
  start: { type: start }

  # No autoApproveWhen, so 'orca serve' parks it on inputs.list and leaves it there.
  release:
    type: gate
    name: "${FIXTURE.gate.title}"
    question: "${FIXTURE.gate.question}"
    options:
      - id: hold
        label: "${FIXTURE.gate.safeOption}"
        consequence: "Nothing is published and the run stays parked."
      - id: publish
        label: "${FIXTURE.gate.destructiveOption}"
        consequence: "Publishes to the internal registry. This cannot be undone."
        destructive: true

  published: { type: end, outcome: success }
  held: { type: end, outcome: success, message: "Held." }

edges:
  - { from: start, to: release }
  - { from: release, to: published, when: "choice == 'publish'" }
  - { from: release, to: held }
`;

const FAILURE_WORKFLOW = `# Written by packages/app/test/smoke/daemon.ts. Not a workflow anybody ships.
id: ${FIXTURE.failure.workflowId}
name: "${FIXTURE.failure.title}"
version: "1"
start: start
nodes:
  start: { type: start }
  failed:
    type: end
    outcome: failure
    message: "The regression suite exhausted its attempts."
edges:
  - { from: start, to: failed }
`;

const LIVE_WORKFLOW = `# Disposable permission callback, never an external agent or API.
id: ${FIXTURE.live.workflowId}
name: Live permission smoke
version: "1"
start: start
nodes:
  start: { type: start }
  write:
    type: agent
    agent: ${FIXTURE.live.agentId}
    prompt: "Write the smoke note only if its permission callback is approved."
    produces:
      - { kind: smoke-note, path: "${FIXTURE.live.subject}" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: write }
  - { from: write, to: done }
`;

/**
 * The config `orca serve` is given: the demo's, plus a second host and the fixture's
 * workflows.
 *
 * Written as JSON beside the demo's YAML rather than over it. What makes that work is the
 * extension, not the name: `loadConfig` parses with `JSON.parse` when the path ends in
 * `.json` and with the YAML parser otherwise, and `--config` is explicit here, so this file
 * deliberately is *not* one of `CONFIG_FILENAMES` and nothing will discover it by accident.
 * The demo's own file is left exactly as `orca demo` wrote it, so the sentence it prints —
 * "the workspace also holds a ready-to-use orca.config.yaml" — stays true of a workspace a
 * person inspects after a failed smoke run.
 */
async function writeSmokeConfig(dir: string): Promise<string> {
  const demo = parseYaml(await readFile(join(dir, "orca.config.yaml"), "utf8")) as {
    hosts: unknown[];
    agents: unknown[];
    workflows: string[];
  } & Record<string, unknown>;

  const workflowDir = join(dir, "smoke-workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(join(workflowDir, "gate.yaml"), GATE_WORKFLOW, "utf8");
  await writeFile(join(workflowDir, "failure.yaml"), FAILURE_WORKFLOW, "utf8");
  await writeFile(join(workflowDir, "live-input.yaml"), LIVE_WORKFLOW, "utf8");

  const config = {
    ...demo,
    /* An ssh host, and one that cannot resolve. Nothing in this test pings — `agents.list`
       reports the handshake health this process has *recorded*, which for an agent nobody
       has pinged is `unknown` — so an unreachable host costs nothing and buys the second
       group heading, the `ssh` branch of `transportLabel` and a second `AgentCard`. */
    hosts: [...demo.hosts, { id: FIXTURE.host.id, type: "ssh", host: "builder-2.invalid", user: "orca" }],
    /* Appended, not prepended: role resolution falls back to the first agent listing a
       role, and the demo's scripted agent lists them all. Coming second leaves every run
       the demo already recorded — and anything a person starts afterwards — on the agent
       that can actually answer. */
    agents: [
      ...demo.agents,
      {
        id: FIXTURE.host.agentId,
        name: FIXTURE.host.agentName,
        command: "claude-code-acp",
        hostId: FIXTURE.host.id,
        roles: ["reviewer"],
      },
      {
        id: FIXTURE.live.agentId,
        name: "Live permission fixture",
        command: process.execPath,
        args: [join(repoRoot, "packages/testing/dist/scripted-agent/main.js")],
        // This takes precedence over inherited playbook paths and test settings.
        env: {
          ORCA_PLAYBOOK_JSON: JSON.stringify({
            default: { askPermission: true, permissionPath: FIXTURE.live.subject },
          }),
        },
        hostId: "local",
        roles: [],
        permissions: { default: "ask", rules: [] },
        // A hard outer bound if the test fails before it can cancel the owning run.
        turnTimeoutMs: 60_000,
        cancelGraceMs: 500,
      },
    ],
    workflows: [...demo.workflows, join(workflowDir, "*.yaml").replaceAll("\\", "/")],
  };

  const path = join(dir, "orca.smoke.config.json");
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

/**
 * Start the two fixture runs and wait until the store shows what the surfaces need.
 *
 * `runs.start` awaits the run, so the failure has already failed and the gate has already
 * parked by the time each call answers — the polls after them are about the *projections*
 * catching up, which is the thing a client can actually observe.
 */
async function seedAttention(url: string, tokenFile: string): Promise<void> {
  await rpc(url, tokenFile, "runs.start", { workflowId: FIXTURE.failure.workflowId, vars: {} });
  await until("the failed run to reach runs.list", async () => {
    const result = (await rpc(url, tokenFile, "runs.list", { status: ["failed"] })) as { runs?: unknown[] };
    return (result.runs?.length ?? 0) > 0;
  });

  await rpc(url, tokenFile, "runs.start", { workflowId: FIXTURE.gate.workflowId, vars: {} });
  await until("the gate to park on inputs.list", async () => {
    const result = (await rpc(url, tokenFile, "inputs.list")) as { waiting?: number };
    return (result.waiting ?? 0) > 0;
  });
}

/** Build a demo workspace, add what an audit needs to it, and serve it. Call `stop` however the test ends. */
export async function startDemoDaemon(): Promise<Daemon> {
  const dir = await mkdtemp(join(tmpdir(), "orca-smoke-"));
  /* `--keep` because the point is the store it leaves behind; without it demo cleans up.
     (`--dir` already implies it, but saying so is what stops the next reader deleting it.)

     `orca demo` exits non-zero if the program run did not succeed, so `execFile` rejects and
     the smoke test never reaches the window — and it rejects with a `Command failed` whose
     output Node truncates to a couple of lines. The demo's own stdout is where it says what
     went wrong, so it is re-thrown here with the whole thing attached: a broken demo should
     be readable off a red CI run rather than reproducible only on a laptop. */
  try {
    await run(process.execPath, [cli, "demo", "--dir", dir, "--keep"], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
    throw new Error(`\`orca demo\` failed, so there is no store to smoke-test\n${stdout}${stderr}`, { cause: e });
  }
  const configPath = await writeSmokeConfig(dir);
  const tokenFile = join(dir, "auth", "local-client.token");

  // #566: ordinary startup refuses a pre-0.7 store unchanged; the supported upgrade is one
  // explicit `orca store carry-forward`, then the daemon opens the converted store.
  const orca = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, "--config", configPath, ...args], { cwd: dir, timeout: 120_000 });
  const refused = await orca("runs").then(
    () => undefined,
    (error: { stderr?: string }) => error.stderr ?? "",
  );
  if (refused === undefined || !refused.includes("CARRYOVER_REQUIRED"))
    throw new Error(`startup did not refuse the old store before carry-forward: ${refused ?? "it opened"}`);
  const carried = await orca("store", "carry-forward");
  if (!carried.stdout.startsWith("carried ")) throw new Error(`carry-forward did not convert: ${carried.stdout}`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serve: ChildProcess = spawn(process.execPath, [cli, "--config", configPath, "serve", "--port", String(port)], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  serve.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
  serve.stderr?.on("data", (d: Buffer) => log.push(d.toString()));

  try {
    await waitForHello(url, tokenFile);
    await seedAttention(url, tokenFile);
  } catch (e) {
    serve.kill("SIGKILL");
    throw new Error(`the smoke test's daemon never came up\ndaemon output:\n${log.join("")}`, { cause: e });
  }

  return {
    url,
    dir,
    tokenFile,
    rpc: (method, params) => rpc(url, tokenFile, method, params),
    startLivePermission: async () => {
      // runs.start keeps its response open while the original interpreter owns the
      // callback. Start it concurrently, then observe only the public read model.
      let startFailure: Error | undefined;
      const started = rpc(url, tokenFile, "runs.start", { workflowId: FIXTURE.live.workflowId, vars: {} }).catch(
        (error: unknown) => {
          startFailure = error instanceof Error ? error : new Error("the live smoke run failed", { cause: error });
        },
      );
      let input: OpenInputView | undefined;
      await until("the scripted agent's live permission", async () => {
        if (startFailure) throw startFailure;
        const snapshot = InputsListResultSchema.parse(await rpc(url, tokenFile, "inputs.list"));
        // Repeated live smokes may leave an expired callback in the public list.
        input = snapshot.inputs.find(
          (candidate) => candidate.agent?.id === FIXTURE.live.agentId && candidate.live?.state === "pending",
        );
        return input?.live?.state === "pending";
      });
      if (!input) throw new Error("the scripted agent's live permission disappeared");
      const runId = input.runId;
      return {
        input,
        cancel: async () => {
          await rpc(url, tokenFile, "runs.cancel", { runId, reason: "End the disposable live-permission smoke" });
          await started;
          if (startFailure) throw startFailure;
        },
      };
    },
    stop: async () => {
      const exited = serve.exitCode === null && serve.signalCode === null ? once(serve, "exit") : undefined;
      serve.kill("SIGTERM");
      await exited;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The absolute directory `orca demo` ran in when a store fixture was made. Every path the
 * demo recorded starts with it; see `packages/app/test/fixtures/store-v0.6.0/README.md`.
 */
export const STORE_FIXTURE_ROOT = "/tmp/ORCA_FIXTURE_ROOT";

/** What a store fixture daemon adds to the usual handle: the runs the old release wrote. */
export interface StoreFixtureDaemon extends Omit<Daemon, "startLivePermission"> {
  /** The daemon's own console output so far, for a failure message. */
  log: () => string;
}

/**
 * Copy `fixture` (an old release's `.orca`) into a fresh workspace, rewriting the demo's
 * recorded root to that workspace, and serve it with the CLI built from this checkout.
 *
 * Nothing is migrated or seeded here: whatever the current daemon does with an old store on
 * startup is what is being tested (#863). The config is written fresh because the old
 * release's config named its own checkout's scripted agent and workflows.
 */
export async function startStoreFixtureDaemon(fixture: string): Promise<StoreFixtureDaemon> {
  const dir = await mkdtemp(join(tmpdir(), "orca-upgrade-"));
  const storeDir = join(dir, ".orca");
  await cp(fixture, storeDir, { recursive: true });

  const escaped = JSON.stringify(dir).slice(1, -1);
  for (const entry of await readdir(storeDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, "utf8");
    if (!text.includes(STORE_FIXTURE_ROOT)) continue;
    const root = /\.jsonl?$/.test(entry.name) ? escaped : dir;
    await writeFile(path, text.replaceAll(STORE_FIXTURE_ROOT, root), "utf8");
  }

  const forward = (path: string) => path.replaceAll("\\", "/");
  const config = {
    version: 1,
    storeDir,
    hosts: [{ id: "local", type: "local" }],
    agents: [
      {
        id: "scripted",
        name: "Scripted test agent",
        command: process.execPath,
        args: [join(repoRoot, "packages/testing/dist/scripted-agent/main.js")],
        hostId: "local",
        roles: ["planner", "designer", "builder", "tester", "reviewer", "deployer", "decomposer"],
      },
    ],
    workflows: [forward(join(repoRoot, "workflows", "*.yaml"))],
    templates: [forward(join(repoRoot, "templates", "**", "*.md"))],
    program: { workflow: "program", itemWorkflow: "ai-sdlc" },
    planning: { plan: "demo", planName: "Demo plan" },
    workspace: { provider: "local", root: dir, hostId: "local" },
  };
  const configPath = join(dir, "orca.upgrade.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const tokenFile = join(dir, "auth", "local-client.token");

  // #566: ordinary startup refuses a pre-0.7 store unchanged; the supported upgrade is one
  // explicit `orca store carry-forward`, then the daemon opens the converted store.
  const orca = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, "--config", configPath, ...args], { cwd: dir, timeout: 120_000 });
  const refused = await orca("runs").then(
    () => undefined,
    (error: { stderr?: string }) => error.stderr ?? "",
  );
  if (refused === undefined || !refused.includes("CARRYOVER_REQUIRED"))
    throw new Error(`startup did not refuse the old store before carry-forward: ${refused ?? "it opened"}`);
  const carried = await orca("store", "carry-forward");
  if (!carried.stdout.startsWith("carried ")) throw new Error(`carry-forward did not convert: ${carried.stdout}`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serve: ChildProcess = spawn(process.execPath, [cli, "--config", configPath, "serve", "--port", String(port)], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  serve.stdout?.on("data", (d: Buffer) => output.push(d.toString()));
  serve.stderr?.on("data", (d: Buffer) => output.push(d.toString()));

  const stop = async () => {
    const exited = serve.exitCode === null && serve.signalCode === null ? once(serve, "exit") : undefined;
    serve.kill("SIGTERM");
    await exited;
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await waitForHello(url, tokenFile);
  } catch (e) {
    await stop();
    throw new Error(`the current daemon did not come up on the old store\ndaemon output:\n${output.join("")}`, {
      cause: e,
    });
  }

  return {
    url,
    dir,
    tokenFile,
    rpc: (method, params) => rpc(url, tokenFile, method, params),
    log: () => output.join(""),
    stop,
  };
}
