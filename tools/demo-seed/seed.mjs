#!/usr/bin/env node
// Fill an ORCA workspace with demo data, through its running daemon: agents with scripted
// behaviours, extra workflows and prompt templates, a capability catalog and secret references,
// then dozens of runs in every state, four programs with plans, risks and decisions, and
// answered and unanswered gates. Made for a fresh install that is about to be swept for visual
// bugs, so it also includes long, unbroken and non-Latin names on purpose.
//
// Everything goes through the daemon's own requests (`config.set`, `config.apply`,
// `requests.submit`, `inputs.answer`, `runs.cancel`, `decisions.decide`, `risks.update`), so the
// store holds real runs and events. The agents are ORCA's scripted ACP agent (no model, no
// network), bundled into one file by build.mjs. The files the config points at go into
// `<workspace>/demo-seed/`; nothing else in the workspace is touched.
//
// Usage (see README.md):
//   node seed.mjs [--workspace <dir>] [--url <daemon url>] [--token-file <file>]
//                 [--scale <n>] [--agent-node <path>] [--phase prepare|populate|all] [--force]
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  closeSync,
  constants,
  openSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AGENTS,
  BASE_PLAYBOOK,
  BEHAVIOURS,
  BROKEN_AGENTS,
  CAPABILITIES,
  PROGRAMS,
  SECRETS,
  SKILLS,
  TEMPLATES,
  WORK,
  WORKFLOW_RUNS,
} from "./data.mjs";
import { strictCopy, WORKFLOWS } from "./workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const log = (message) => process.stdout.write(`[demo-seed] ${message}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const DIR = "demo-seed";

// ---------------------------------------------------------------- arguments

const { values: args } = parseArgs({
  options: {
    workspace: { type: "string" },
    url: { type: "string" },
    "token-file": { type: "string" },
    scale: { type: "string", default: "1" },
    "agent-node": { type: "string" },
    phase: { type: "string", default: "all" },
    settle: { type: "string", default: "150" },
    "config-out": { type: "string" },
    force: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (args.help) {
  process.stdout.write(readFileSync(join(here, "README.md"), "utf8"));
  process.exit(0);
}
const scale = Math.max(1, Number.parseInt(args.scale, 10) || 1);
if (!["prepare", "populate", "all"].includes(args.phase)) throw new Error(`--phase must be prepare, populate or all`);

// ---------------------------------------------------------------- assets

/** Packed (dist/orca-demo-seed/) holds assets/ and scripted-agent.mjs beside this file; the repo does not. */
function assets() {
  const packed = existsSync(join(here, "assets"));
  const root = packed ? join(here, "assets") : resolve(here, "..", "..");
  const agent = packed ? join(here, "scripted-agent.mjs") : join(here, "dist", "orca-demo-seed", "scripted-agent.mjs");
  if (!existsSync(agent)) throw new Error(`no scripted agent bundle at ${agent}; run: node tools/demo-seed/build.mjs`);
  return { workflows: join(root, "workflows"), templates: join(root, "templates"), agent };
}

// ---------------------------------------------------------------- the daemon

/**
 * A loopback listener address from /proc/net/tcp{,6}, in its own address family, or undefined
 * for any other address (a wildcard or another interface): the URL must reach the very socket
 * that was found, never another one on the same port.
 */
function loopbackHost(file, address) {
  if (file.endsWith("tcp")) return address.toUpperCase() === "0100007F" ? "127.0.0.1" : undefined;
  const hex = address.toUpperCase();
  if (hex === "00000000000000000000000001000000") return "[::1]";
  if (hex === "0000000000000000FFFF00000100007F") return "127.0.0.1"; // ::ffff:127.0.0.1
  return undefined;
}

/** The value after `flag` in a command line, if any. */
function argument(cmdline, flag) {
  const at = cmdline.indexOf(flag);
  return at >= 0 ? cmdline[at + 1] : undefined;
}

/** A path's real form, or undefined when it does not resolve. */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The RPC URL of the one daemon serving `workspace`, found in /proc (Linux) before any request is
 * made, so the bearer token only ever goes to that daemon's own socket. The daemon must run as
 * this user, its command line must name exactly this workspace's config (`--config`, or `--cwd`
 * without one) and `--port`, and that port must be a loopback listener of the same process. Two
 * such daemons, or anything less exact, is refused: pass --url then. Undefined when none runs.
 */
function discoverUrl(workspace) {
  if (process.platform !== "linux") return undefined;
  const config = realpathSync(join(workspace, "orca.config.yaml"));
  const uid = process.getuid?.();
  const listening = new Map(); // socket inode -> { host, port }
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(file)) continue;
    for (const row of readFileSync(file, "utf8").split("\n").slice(1)) {
      const cols = row.trim().split(/\s+/);
      if (cols[3] !== "0A" || !cols[1] || !cols[9]) continue; // LISTEN
      const [address = "", port = ""] = cols[1].split(":");
      const host = loopbackHost(file, address);
      if (host) listening.set(cols[9], { host, port: Number.parseInt(port, 16) });
    }
  }
  const matches = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let cmdline;
    let status;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      continue;
    }
    const serve = cmdline.indexOf("serve");
    if (serve < 0 || !cmdline.slice(0, serve).some((part) => part.endsWith("orca-daemon.mjs"))) continue;
    if (uid !== undefined && Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
    const named = argument(cmdline, "--config");
    const cwd = argument(cmdline, "--cwd");
    const served = named ? real(resolve(cwd ?? "/", named)) : cwd && real(join(cwd, "orca.config.yaml"));
    if (served !== config) continue;
    matches.push({ pid, host: argument(cmdline, "--host"), port: Number(argument(cmdline, "--port")) });
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1)
    fail(`more than one daemon serves this workspace (pids ${matches.map((m) => m.pid).join(", ")}); pass --url`);
  const [{ pid, host, port }] = matches;
  const sockets = new Set();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      const inode = /^socket:\[(\d+)\]$/.exec(safeLink(`/proc/${pid}/fd/${fd}`) ?? "")?.[1];
      if (inode) sockets.add(inode);
    }
  } catch {
    fail(`cannot read the sockets of daemon ${pid}; pass --url`);
  }
  const own = [...sockets].map((inode) => listening.get(inode)).filter((l) => l && l.port === port);
  if (own.length !== 1 || (host && !sameHost(host, own[0].host)))
    fail(`daemon ${pid} does not hold exactly one loopback listener on its --port ${port}; pass --url`);
  return `http://${own[0].host}:${own[0].port}`;
}

/** A link's target, or undefined. */
function safeLink(path) {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Whether the daemon's --host names the address family of the listener found. */
function sameHost(named, found) {
  const host = named.replace(/^\[|\]$/g, "");
  if (found === "[::1]") return host === "::1" || host === "localhost";
  return host === "127.0.0.1" || host === "localhost";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Only a daemon on this machine's loopback interface: the seed sends the workspace's local
 * bearer token with every request, and that token is for the local daemon alone.
 */
function loopbackUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password)
    throw new Error(`refusing ${raw}: the seed only talks to a daemon on http://127.0.0.1, localhost or [::1]`);
  return url.origin;
}

/** An RPC caller for `url` with `token`. Redirects are refused, so the token never follows one. */
function rpcClient(url, token) {
  let id = 0;
  return async function call(method, params = {}) {
    const response = await fetch(`${url}/rpc`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "request", id: ++id, method, params }),
    });
    const message = await response.json().catch(() => undefined);
    if (!message?.ok) {
      const error = message?.error ?? { code: `HTTP_${response.status}`, message: response.statusText };
      throw Object.assign(new Error(`${method}: ${error.code}: ${error.message}`), { code: error.code });
    }
    return message.result;
  };
}

/**
 * Refuse unless the daemon at the end of `call` serves exactly `workspace`'s config: the files
 * the seed writes and the config, runs and plans it changes must be one workspace, the one the
 * person named. Checked before either phase changes anything.
 */
async function verifyTarget(call, workspace) {
  const expected = realpathSync(join(workspace, "orca.config.yaml"));
  const served = (await call("config.get")).config?.path;
  let actual;
  try {
    actual = served ? realpathSync(served) : undefined;
  } catch {
    actual = undefined;
  }
  if (actual !== expected)
    throw new Error(
      `refusing: the daemon serves ${served ?? "an unknown config"}, not ${expected}; point --url at the daemon for --workspace`,
    );
}

/** The selected workspace, its daemon and a caller for it, verified before anything is written. */
async function connect() {
  if (!args.workspace) throw new Error("--workspace <app workspace folder> is required");
  const workspace = realpathSync(resolve(args.workspace));
  const tokenFile = args["token-file"] ?? join(workspace, "auth", "local-client.token");
  const token = readFileSync(tokenFile, "utf8").trim();
  const named = args.url ?? process.env.ORCA_DAEMON_URL;
  const url = loopbackUrl(
    named ??
      discoverUrl(workspace) ??
      fail("could not find the daemon for this workspace; pass --url http://127.0.0.1:<port>"),
  );
  const call = rpcClient(url, token);
  await verifyTarget(call, workspace);
  log(`daemon ${url}`);
  return { workspace, call };
}

/** An error's message, with the network cause fetch hides behind "fetch failed". */
function describe(error) {
  const cause = error?.cause;
  return `${error?.message ?? error}${cause ? ` (${cause.code ?? cause.message ?? cause})` : ""}`;
}

function fail(message) {
  throw new Error(message);
}

// ---------------------------------------------------------------- prepare

function plannerAgents() {
  return PROGRAMS.map((program) => {
    const decision = program.decomposition.decisions[0];
    return {
      id: program.planner,
      name: program.plannerName,
      roles: [],
      kinds: {
        decomposition: [{ data: program.decomposition, body: `${program.title}: breakdown.` }],
        "risk-register": [
          { data: { status: "done", risks: [], summary: program.decomposition.rationale }, body: "Risk narrative." },
        ],
        ...(decision
          ? {
              "decision-matrix": [
                {
                  data: {
                    key: decision.key,
                    title: decision.title,
                    scale: 10,
                    criteria: [
                      { key: "fit", name: "Fit", weight: 2 },
                      { key: "cost", name: "Running cost", weight: 3 },
                    ],
                    options: decision.options.map((option, i) => ({
                      key: option.key,
                      name: option.name,
                      scores: { fit: 9 - i * 2, cost: 3 + i * 2 },
                    })),
                    rationale: "Scored by the planner; a person decides.",
                  },
                  body: "Matrix reasoning.",
                },
              ],
            }
          : {}),
      },
    };
  });
}

/** Write `<workspace>/demo-seed/` and return the config edits that point at it. */
function writeFiles(workspace, config, files) {
  const base = join(workspace, DIR);
  for (const sub of ["playbooks", "state", "workflows", "templates", "skills"])
    mkdirSync(join(base, sub), { recursive: true });

  const agentFile = join(base, "scripted-agent.mjs");
  cpSync(files.agent, agentFile);

  for (const workflow of WORKFLOWS) writeFileSync(join(base, "workflows", `${workflow.id}.yaml`), json(workflow));
  for (const name of ["ai-sdlc.yaml", "program.yaml", "plan-resume.yaml"])
    cpSync(join(files.workflows, name), join(base, "workflows", name));
  writeFileSync(
    join(base, "workflows", "ai-sdlc-strict.yaml"),
    strictCopy(readFileSync(join(files.workflows, "ai-sdlc.yaml"), "utf8")),
  );

  cpSync(files.templates, join(base, "templates"), { recursive: true });
  for (const [id, name, body] of TEMPLATES) {
    const file = join(base, "templates", `${id}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\nid: ${id}\nname: ${JSON.stringify(name)}\n---\n${body}\n`);
  }
  for (const [id, text] of Object.entries(SKILLS)) {
    mkdirSync(join(base, "skills", id), { recursive: true });
    writeFileSync(join(base, "skills", id, "SKILL.md"), text);
  }

  // The node that runs the agents: this one unless told otherwise. ORCA's own Electron binary
  // works too when it is told to behave as Node.
  const node = args["agent-node"] ? resolve(args["agent-node"]) : process.execPath;
  const electron = !/(^|[\\/])node(\.exe)?$/i.test(node);
  const spec = (agent) => {
    const playbook = join(base, "playbooks", `${agent.id}.json`);
    writeFileSync(
      playbook,
      json({
        ...BASE_PLAYBOOK,
        kinds: { ...BASE_PLAYBOOK.kinds, ...agent.kinds },
        ...(agent.configOptions ? { configOptions: agent.configOptions } : {}),
      }),
    );
    return {
      id: agent.id,
      name: agent.name,
      command: node,
      args: [
        agentFile,
        "--playbook",
        playbook,
        // A state file lets a playbook step through its entries across turns (the picky
        // reviewer asks for changes once, then approves). Concurrent sessions of one agent
        // share it, so only the agent that needs it gets one.
        ...(agent.stateful ? ["--state", join(base, "state", `${agent.id}.json`)] : []),
        "--log",
        join(base, "state", `${agent.id}-prompts.jsonl`),
      ],
      ...(electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
      roles: agent.roles ?? [],
    };
  };

  const plain = config.parsed ?? {};
  const has = (list, id) => (list ?? []).some((entry) => entry.id === id);
  const edits = [];
  const agents = [...AGENTS, ...plannerAgents()].map(spec);
  agents.push(...BROKEN_AGENTS.map((agent) => ({ ...agent, roles: [] })));
  let at = (plain.agents ?? []).length;
  for (const agent of agents) {
    if (has(plain.agents, agent.id)) continue;
    if (!plain.agents) {
      edits.push({ kind: "set", path: ["agents"], value: [agent] });
      plain.agents = [agent];
      at = 1;
      continue;
    }
    edits.push({ kind: "insert", path: ["agents"], index: at++, value: agent });
  }
  const addGlob = (key, glob) => {
    const list = plain[key];
    if (list?.includes(glob)) return;
    if (!list) edits.push({ kind: "set", path: [key], value: [glob] });
    else edits.push({ kind: "insert", path: [key], index: list.length, value: glob });
  };
  // The first-run workflow stays; the seed's copies of the repo's workflows sit beside it.
  addGlob("workflows", `${DIR}/workflows/*.yaml`);
  addGlob("templates", `${DIR}/templates/**/*.md`);
  if (!plain.capabilities) edits.push({ kind: "set", path: ["capabilities"], value: CAPABILITIES });
  if (!plain.secrets) edits.push({ kind: "set", path: ["secrets"], value: SECRETS });
  if (!plain.program)
    edits.push({ kind: "set", path: ["program"], value: { workflow: "program", itemWorkflow: "ai-sdlc" } });
  if (!plain.planning)
    edits.push({
      kind: "set",
      path: ["planning"],
      value: { plan: "roadmap", planName: "Product roadmap", policy: { strategy: "critical-path", concurrency: 3 } },
    });
  if (plain.humanInput?.mode !== "pause") edits.push({ kind: "set", path: ["humanInput"], value: { mode: "pause" } });
  return edits;
}

/**
 * A new file only this user can read, for the whole workspace config (which may hold values the
 * person would not share): created exclusively, so an existing file or a link at the path is
 * refused, never followed or overwritten.
 */
function privateNewFile(path) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  try {
    return openSync(resolve(path), flags, 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`--config-out ${path} already exists; name a new file`, { cause: error });
    throw error;
  }
}

async function prepare(call, workspace) {
  const files = assets();
  const current = await call("config.get");
  log(`workspace ${workspace}`);
  // Claimed before anything is written, so a refused path leaves the workspace as it was.
  const configOut = args["config-out"] ? privateNewFile(args["config-out"]) : undefined;
  const edits = writeFiles(workspace, current.config, files);
  if (edits.length === 0) {
    if (configOut !== undefined) closeSync(configOut);
    log("config already has the demo agents, workflows and templates");
  } else if (configOut !== undefined) {
    // Leave the write to the person (or a test) in the app's own Config > Raw editor: the
    // desktop app binds a config saved there for reopening, and refuses one saved elsewhere.
    try {
      writeFileSync(configOut, json(applyEdits(structuredClone(current.config.parsed ?? {}), edits)));
    } finally {
      closeSync(configOut);
    }
    log(`config: ${edits.length} edits written to ${args["config-out"]}; paste it into Config > Raw and save`);
    return { workspace, restart: true };
  } else {
    // Structured edits keep the file's comments and layout; the daemon refuses them where it
    // cannot (the first-run config is flow-style JSON), and then the seed writes the whole
    // document instead, as the Raw YAML editor would.
    const set = await call("config.set", {
      document: "config",
      expectedRevision: current.config.revision,
      edits,
    }).catch((error) => {
      if (error.code !== "CONFIG_INVALID") throw error;
      log("structured edits refused; writing the whole document");
      return call("config.set", {
        document: "config",
        expectedRevision: current.config.revision,
        text: json(applyEdits(structuredClone(current.config.parsed ?? {}), edits)),
      });
    });
    log(`config: ${edits.length} edits written`);
    const generation = set.generation ?? (await call("config.get")).generation;
    if (generation) {
      const applied = await call("config.apply", {
        expectedRevision: set.document.revision,
        expectedGeneration: generation.activeGeneration,
      });
      log(`config.apply: ${applied.outcome}`);
      for (const error of applied.validation.errors) log(`  ${error.path}: ${error.message}`);
      if (applied.outcome === "invalid") throw new Error("the daemon refused the seeded config");
      if (applied.outcome === "restart-required") return { workspace, restart: true };
    }
  }
  const agents = await call("agents.list");
  const ids = new Set((agents.agents ?? agents).map((agent) => agent.id));
  return { workspace, restart: !ids.has("atlas") };
}

/** The same edits, applied to a plain object (for the whole-document fallback). */
function applyEdits(doc, edits) {
  for (const edit of edits) {
    const parent = edit.path.slice(0, -1).reduce((node, key) => node[key], doc);
    const key = edit.path.at(-1);
    if (edit.kind === "set") parent[key] = edit.value;
    else if (edit.kind === "insert") parent[key].splice(edit.index, 0, edit.value);
  }
  return doc;
}

// ---------------------------------------------------------------- populate

const slugify = (text) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "item";

const runIdOf = (result) => result?.runId ?? result?.run?.id;

/**
 * `STORE_LOCK_TIMEOUT` is the store saying another writer holds the admission catalog: nothing
 * was admitted, and the same request with the same idempotency key is safe to send again. The
 * daemon's own background writes can hold it past the short wait, above all on Windows, where a
 * replace that meets another open handle retries (#1284). Bounded: about 3 s, then the error.
 */
async function retryContended(send, delays = [100, 200, 400, 800, 1600]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (error?.code !== "STORE_LOCK_TIMEOUT" || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function populate(call, workspace) {
  const marker = join(workspace, DIR, "seeded.json");
  if (existsSync(marker) && !args.force) {
    log(`already seeded (${marker}); pass --force to add another batch`);
    return;
  }
  // One stamp per invocation: in work-item slugs, and in every plan key this batch creates, so
  // its programs never join a plan that already exists (another seed's, or anyone's).
  const stamp = `${Date.now().toString(36).slice(-5)}${randomBytes(2).toString("hex")}`;
  const submitted = [];
  const submit = async (label, params, extra = {}) => {
    const request = { idempotencyKey: `demo-seed-${stamp}-${submitted.length}`, ...params };
    const result = await retryContended(() => call("requests.submit", request));
    const runId = runIdOf(result);
    submitted.push({ label, runId, requestId: result.requestId, state: result.state, ...extra });
    if (result.state === "recoverable-failure") log(`  ${label}: ${result.failure.code} ${result.failure.message}`);
    return runId;
  };

  // Plans that exist before this batch are never touched, whatever their key (see ownedPlan).
  const before = await call("plans.list", {});
  const existingPlans = new Set((before.plans ?? []).map((plan) => plan.id));
  const existingKeys = new Set((before.plans ?? []).map((plan) => plan.key));
  log(
    `submitting ${WORK.length * scale} work items, ${WORKFLOW_RUNS.length * scale} workflow runs, ${PROGRAMS.length} programs`,
  );
  const cancels = [];
  for (let batch = 0; batch < scale; batch++) {
    const suffix = batch === 0 ? "" : ` (batch ${batch + 1})`;
    for (const [title, description, behaviour, labels] of WORK) {
      const how = BEHAVIOURS[behaviour];
      const slug = `${slugify(title)}-${stamp}${batch}`;
      const runId = await submit(
        `${title}${suffix}`,
        {
          title: `${title}${suffix}`,
          body: description,
          labels,
          workflowId: "ai-sdlc",
          vars: { workItem: { slug, title: `${title}${suffix}`, description } },
          ...(Object.keys(how.roles).length ? { overrides: { roles: how.roles } } : {}),
        },
        { behaviour },
      );
      if (how.cancelAfterMs && runId) cancels.push({ runId, at: Date.now() + how.cancelAfterMs });
    }
    for (const [workflowId, title, how] of WORKFLOW_RUNS) {
      const slug = `${slugify(title)}-${stamp}${batch}`;
      await submit(
        `${title}${suffix}`,
        {
          title: `${title}${suffix}`,
          body: `Seeded run of ${workflowId}.`,
          workflowId,
          vars: workflowId.startsWith("ai-sdlc")
            ? { workItem: { slug, title: `${title}${suffix}`, description: "Seeded." } }
            : { topic: { slug, title: `${title}${suffix}` } },
          ...(how.roles ? { overrides: { roles: how.roles } } : {}),
        },
        { workflowId },
      );
    }
  }
  for (const program of PROGRAMS) {
    const planKey = `${program.plan}-${stamp}`;
    if (existingKeys.has(planKey)) {
      log(`skipping ${program.title}: a plan ${planKey} already exists`);
      continue;
    }
    await submit(
      program.title,
      {
        title: program.title,
        body: program.body,
        labels: ["program"],
        vars: { plan: planKey, maxAutoApproveItems: 0 },
        overrides: { roles: { decomposer: program.planner, planner: program.planner } },
      },
      { program: program.plan, planKey },
    );
  }
  log(`submitted ${submitted.length} requests (${submitted.filter((s) => s.runId).length} with a run)`);

  // Settle: cancel what should be cancelled, answer the gates that should be answered, decide
  // and update the plans, until everything that will be answered has been.
  const byRun = new Map(submitted.filter((s) => s.runId).map((s) => [s.runId, s]));
  const answered = new Set();
  const planned = new Set();
  const deadline = Date.now() + Number(args.settle) * 1000;
  while (Date.now() < deadline) {
    for (const cancel of cancels.filter((c) => !c.done && c.at <= Date.now())) {
      cancel.done = true;
      await call("runs.cancel", {
        runId: cancel.runId,
        reason: "Superseded: sessions stay in signed cookies for v1.",
      }).then(
        () => log(`cancelled ${byRun.get(cancel.runId)?.label}`),
        (error) => log(`cancel failed: ${error.message}`),
      );
    }
    const inputs = await call("inputs.list", {}).catch(() => ({ inputs: [] }));
    for (const input of inputs.inputs ?? inputs) {
      if (answered.has(input.id) || !["gate", "decision"].includes(input.kind)) continue;
      const seeded = byRun.get(input.runId);
      const option = answerFor(seeded, input);
      if (!option) continue;
      answered.add(input.id);
      await call("inputs.answer", {
        requestId: input.id,
        runId: input.runId,
        optionId: option,
        note: "Answered by the demo seed.",
      }).then(
        () => log(`answered ${option}: ${seeded?.label ?? input.runName} (${input.nodeId ?? input.question})`),
        (error) => log(`answer failed: ${error.message}`),
      );
    }
    const plans = await call("plans.list", {}).catch(() => ({ plans: [] }));
    for (const plan of plans.plans ?? []) {
      const program = ownedPlan(plan, existingPlans, submitted);
      if (!program || planned.has(plan.id)) continue;
      const decisions = await call("decisions.list", { planId: plan.id }).catch(() => ({ decisions: [] }));
      if (program.decomposition.decisions.length && !(decisions.decisions ?? []).length) continue; // not registered yet
      planned.add(plan.id);
      if (program.decide)
        await call("decisions.decide", { planId: plan.id, ...program.decide }).then(
          () => log(`decided ${program.decide.key} = ${program.decide.option} in ${plan.key}`),
          (error) => log(`decide failed: ${error.message}`),
        );
      for (const update of program.riskUpdates)
        await call("risks.update", { planId: plan.id, ...update }).then(
          () => log(`risk ${update.key} -> ${update.status} in ${plan.key}`),
          (error) => log(`risk update failed: ${error.message}`),
        );
    }
    const pendingCancels = cancels.some((c) => !c.done);
    // Plans this batch cannot own never count, so the loop ends on the settle deadline then.
    const plansDone = planned.size === PROGRAMS.length;
    if (!pendingCancels && plansDone && answered.size >= expectedAnswers()) break;
    await sleep(5000);
  }

  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, json({ at: new Date().toISOString(), stamp, scale, submitted }));
  const runs = await call("runs.list", {}).catch(() => undefined);
  const list = runs?.runs ?? [];
  const counts = {};
  for (const run of list) counts[run.status] = (counts[run.status] ?? 0) + 1;
  log(`runs in the store: ${list.length} ${JSON.stringify(counts)}`);
  const files = countFiles(join(workspace, ".orca")) + countFiles(join(workspace, "auth"));
  log(
    `files under .orca and auth: ${files}${files > 6000 ? " (the desktop app checks at most 8192 when it reopens a workspace)" : ""}`,
  );
  log("done; runs keep moving for a minute or two (the slow and stuck ones never finish)");

  function expectedAnswers() {
    let n = 0;
    for (const s of submitted) {
      if (s.behaviour && BEHAVIOURS[s.behaviour].answer) n++;
      if (s.program && PROGRAMS.find((p) => p.plan === s.program)?.approve) n++;
      if (s.workflowId === "parallel-audit") n++;
      if (s.workflowId === "approval-chain") n += s.label.startsWith("Production") ? 1 : 0;
    }
    return n;
  }
}

/**
 * The fixture program for `plan` when this invocation made the plan, else undefined: a plan
 * that is new since the batch started, whose key is one this batch submitted (`<fixture>-<stamp>`),
 * and whose every contributing request is that accepted program request. Any other plan, one
 * another request joined, or one from a rejected submission is left alone.
 */
function ownedPlan(plan, existingPlans, submitted) {
  if (existingPlans.has(plan.id)) return undefined;
  const ours = submitted.find((s) => s.planKey === plan.key && s.state === "accepted");
  const program = ours && PROGRAMS.find((p) => p.plan === ours.program);
  if (!program || plan.requestIds.length === 0 || plan.requestIds.some((id) => id !== ours.requestId)) return undefined;
  return program;
}

/** Which option the seed picks for a gate, or undefined to leave it waiting. */
function answerFor(seeded, input) {
  if (!seeded) return undefined;
  if (seeded.behaviour) return BEHAVIOURS[seeded.behaviour].answer;
  if (seeded.program) return PROGRAMS.find((p) => p.plan === seeded.program)?.approve ? "approve" : undefined;
  if (seeded.workflowId === "parallel-audit") return "approve";
  // The first approval of "Production access…" goes through; it then waits on security.
  if (seeded.workflowId === "approval-chain" && seeded.label.startsWith("Production") && input.nodeId === "manager")
    return "approve";
  return undefined;
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    n += entry.isDirectory() ? 1 + countFiles(join(dir, entry.name)) : 1;
  return n;
}

// ---------------------------------------------------------------- main

try {
  const { workspace, call } = await connect();
  if (args.phase !== "populate") {
    const prepared = await prepare(call, workspace);
    if (prepared.restart) {
      log("the daemon has not loaded the demo agents yet: restart it (quit and reopen ORCA), then run");
      log(`  node ${process.argv[1]} --phase populate --workspace ${workspace}`);
      process.exit(args.phase === "all" ? 2 : 0);
    }
  }
  if (args.phase !== "prepare") await populate(call, workspace);
} catch (error) {
  process.stderr.write(`[demo-seed] ${describe(error)}\n`);
  process.exit(1);
}
