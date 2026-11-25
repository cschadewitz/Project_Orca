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
  writeFileSync,
} from "node:fs";
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

/** The loopback port of the daemon whose command line names `workspace`, from /proc (Linux). verifyTarget still checks it. */
function discoverUrl(workspace) {
  if (process.platform !== "linux") return undefined;
  const listening = new Map();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(file)) continue;
    for (const row of readFileSync(file, "utf8").split("\n").slice(1)) {
      const cols = row.trim().split(/\s+/);
      if (cols[3] !== "0A") continue; // LISTEN
      const [address, port] = cols[1].split(":");
      if (!/^(0100007F|0+1000000|0+)$/i.test(address) && !address.endsWith("0100007F")) continue;
      listening.set(cols[9], Number.parseInt(port, 16));
    }
  }
  const config = workspace ? resolve(workspace, "orca.config.yaml") : undefined;
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let cmdline;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (!cmdline.some((part) => part.endsWith("orca-daemon.mjs") || part === "serve")) continue;
    if (config && !cmdline.some((part) => part === config || part.startsWith(`${workspace}`))) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && listening.has(inode)) {
        const at = cmdline.indexOf("--config");
        return { url: `http://127.0.0.1:${listening.get(inode)}`, config: at >= 0 ? cmdline[at + 1] : undefined };
      }
    }
  }
  return undefined;
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
  const url = loopbackUrl(
    args.url ??
      process.env.ORCA_DAEMON_URL ??
      discoverUrl(workspace)?.url ??
      fail("could not find the daemon for this workspace; pass --url http://127.0.0.1:<port>"),
  );
  const tokenFile = args["token-file"] ?? join(workspace, "auth", "local-client.token");
  const call = rpcClient(url, readFileSync(tokenFile, "utf8").trim());
  await verifyTarget(call, workspace);
  return { workspace, call };
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

async function prepare(call, workspace) {
  const files = assets();
  const current = await call("config.get");
  log(`workspace ${workspace}`);
  const edits = writeFiles(workspace, current.config, files);
  if (edits.length === 0) {
    log("config already has the demo agents, workflows and templates");
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

async function populate(call, workspace) {
  const marker = join(workspace, DIR, "seeded.json");
  if (existsSync(marker) && !args.force) {
    log(`already seeded (${marker}); pass --force to add another batch`);
    return;
  }
  const stamp = Date.now().toString(36).slice(-5);
  const submitted = [];
  const submit = async (label, params, extra = {}) => {
    const result = await call("requests.submit", {
      idempotencyKey: `demo-seed-${stamp}-${submitted.length}`,
      ...params,
    });
    const runId = runIdOf(result);
    submitted.push({ label, runId, requestId: result.requestId, state: result.state, ...extra });
    if (result.state === "recoverable-failure") log(`  ${label}: ${result.failure.code} ${result.failure.message}`);
    return runId;
  };

  // Plans that exist before this batch are never touched, whatever their key (see ownedPlan).
  const before = await call("plans.list", {});
  const existingPlans = new Set((before.plans ?? []).map((plan) => plan.id));
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
    await submit(
      program.title,
      {
        title: program.title,
        body: program.body,
        labels: ["program"],
        vars: { plan: program.plan, maxAutoApproveItems: 0 },
        overrides: { roles: { decomposer: program.planner, planner: program.planner } },
      },
      { program: program.plan },
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
 * that is new since the batch started, whose key is a fixture's, and whose every contributing
 * request is that fixture's program request from this batch. An older plan with the same key, a
 * plan another request joined, or one from a rejected submission is left alone.
 */
function ownedPlan(plan, existingPlans, submitted) {
  if (existingPlans.has(plan.id)) return undefined;
  const program = PROGRAMS.find((p) => p.plan === plan.key);
  const ours = submitted.find((s) => s.program === plan.key && s.state === "accepted")?.requestId;
  if (!program || !ours || plan.requestIds.length === 0 || plan.requestIds.some((id) => id !== ours)) return undefined;
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
  process.stderr.write(`[demo-seed] ${error.message}\n`);
  process.exit(1);
}
