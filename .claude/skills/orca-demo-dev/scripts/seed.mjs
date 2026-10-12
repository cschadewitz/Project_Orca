// Populate a demo workspace so every surface has something on it: runs in each state, gates
// waiting for a person, a failure with retries, a second request's plan, and more agents.
//
// Everything goes through the daemon's own write methods (`requests.submit`, `runs.cancel`),
// so the store holds real runs and real events rather than hand-made files: the screens show
// exactly what they would show for the same work done for real.
//
// Two halves, because a running daemon does not pick up new agents:
//
// - `prepareSeedConfig(dir)` runs before the daemon starts. It adds four scripted agents with
//   their own playbooks and sets `humanInput: { mode: pause }`, so a gate waits for an answer
//   instead of being approved automatically.
// - `seed(...)` runs once the daemon is listening, and submits the work.
//
// `start.mjs --seed` does both. Run alone (`node seed.mjs [--dir <path>]`), this script seeds a
// daemon that is already running on a prepared workspace, and says so if it is not prepared.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWorkspace, say, YAML } from "./workspace.mjs";

const log = (message) => say(`[seed] ${message}`);

/** The extra agents: who they are, and how each one's playbook differs from the demo's. */
const AGENTS = [
  {
    id: "scripted-slow",
    name: "Slow builder",
    /** Builds for 25 minutes: the run stays `running` long enough to look at. */
    kinds: {
      plan: [{ data: { status: "ready" }, body: "Plan: add a token bucket in front of POST /login." }],
      implementation: [
        {
          say: "Building the change. This one takes a while.",
          delayMs: 25 * 60 * 1000,
          data: { status: "done", branch: "orca/slow" },
          body: "Slow implementation.",
        },
      ],
    },
  },
  {
    id: "scripted-flaky",
    name: "Flaky tester",
    /** Every test run fails, so the build loop spends its three attempts and the run fails. */
    kinds: {
      "test-report": [
        {
          say: "Running the suite.",
          data: { status: "done", passed: false, failures: 2 },
          body: "2 failures:\n\n- checkout.spec.ts > applies the discount code\n- checkout.spec.ts > totals a mixed-currency cart",
        },
      ],
    },
  },
  {
    id: "scripted-risky",
    name: "Cautious designer",
    /** A high-risk spec: the spec gate only asks a person when risk is high. */
    kinds: {
      spec: [
        {
          data: { status: "ready", risk: "high" },
          body: "# Spec\n\nRotate the API signing keys without downtime: publish the new key, dual-sign for one day, then retire the old key. Every client that pins a key breaks if this goes wrong, which is why the risk is high.",
        },
      ],
    },
  },
  {
    id: "scripted-planner",
    name: "Billing planner",
    /** A second request's breakdown, so the plan holds more than the demo's three items. */
    kinds: {
      decomposition: [
        {
          data: {
            items: [
              {
                slug: "invoice-model",
                title: "Invoice data model",
                kind: "task",
                description: "Normalise invoices and line items",
                estimate: "M",
                dependsOn: [],
                risks: ["pii-in-exports"],
              },
              {
                slug: "csv-export",
                title: "CSV export",
                kind: "feature",
                description: "Download invoices as CSV",
                estimate: "S",
                priority: "high",
                dependsOn: ["invoice-model"],
              },
              {
                slug: "pdf-export",
                title: "PDF export",
                kind: "feature",
                description: "Render invoices as PDF",
                estimate: "L",
                dependsOn: ["invoice-model", "decision:pdf-engine"],
              },
              {
                slug: "export-api",
                title: "Export API",
                kind: "feature",
                description: "GET /invoices/export?format=",
                estimate: "M",
                dependsOn: ["csv-export"],
                risks: ["large-exports-timeout"],
              },
              {
                slug: "billing-docs",
                title: "Billing export docs",
                kind: "task",
                description: "Document the export formats",
                estimate: "XS",
                dependsOn: ["informs:export-api@spec"],
              },
            ],
            risks: [
              {
                key: "pii-in-exports",
                title: "Exports carry customer PII off-platform",
                category: "security",
                likelihood: 3,
                impact: 4,
                mitigation: "Redact by default; full export needs an admin role",
                affects: ["invoice-model", "csv-export"],
              },
              {
                key: "large-exports-timeout",
                title: "Large accounts time out exporting a year of invoices",
                category: "operational",
                likelihood: 4,
                impact: 3,
                mitigation: "Stream the response and page by month",
                affects: ["export-api"],
              },
            ],
            decisions: [
              {
                key: "pdf-engine",
                title: "How are PDFs rendered?",
                question: "Headless Chrome or a PDF library?",
                options: [
                  { key: "chrome", name: "Headless Chrome" },
                  { key: "pdfkit", name: "PDFKit" },
                ],
                blocks: ["pdf-export"],
              },
            ],
            rationale: "The model first, then one slice per format, with the API on the slice that ships first.",
          },
          body: "Billing export breakdown.",
        },
      ],
      "risk-register": [
        {
          data: {
            status: "done",
            risks: [
              {
                key: "currency-rounding",
                title: "Totals round differently from the ledger",
                category: "quality",
                likelihood: 2,
                impact: 3,
                mitigation: "Compute totals from integer minor units",
                affects: ["csv-export", "pdf-export"],
              },
            ],
            summary: "Three open risks; PII handling is the one to watch.",
          },
          body: "Risk narrative for billing export.",
        },
      ],
      "decision-matrix": [
        {
          data: {
            key: "pdf-engine",
            title: "How are PDFs rendered?",
            scale: 10,
            criteria: [
              { key: "fidelity", name: "Layout fidelity", weight: 2 },
              { key: "ops", name: "Operational cost", weight: 3 },
            ],
            options: [
              { key: "chrome", name: "Headless Chrome", scores: { fidelity: 9, ops: 3 } },
              { key: "pdfkit", name: "PDFKit", scores: { fidelity: 6, ops: 8 } },
            ],
            rationale: "Running Chrome in production costs more than the layout is worth.",
          },
          body: "Matrix reasoning.",
        },
      ],
    },
  },
];

/** What gets submitted, and what each one is for on screen. */
const WORK = [
  {
    title: "Export invoices as CSV",
    item: { slug: "seed-csv", title: "Export invoices as CSV", description: "A CSV download on the invoices page" },
    roles: {},
    shows: "a run that succeeds",
  },
  {
    title: "Rate-limit the login endpoint",
    item: { slug: "seed-rate-limit", title: "Rate-limit the login endpoint", description: "A token bucket per IP" },
    roles: { builder: "scripted-slow" },
    shows: "a run that is still running (its build step takes 25 minutes)",
  },
  {
    title: "Rotate the API signing keys",
    item: { slug: "seed-keys", title: "Rotate the API signing keys", description: "Dual-sign, then retire" },
    roles: { designer: "scripted-risky" },
    shows: "a run waiting at the spec gate for your answer",
  },
  {
    title: "Fix the flaky checkout test",
    item: { slug: "seed-checkout", title: "Fix the flaky checkout test", description: "Two assertions fail" },
    roles: { tester: "scripted-flaky" },
    shows: "a run that fails after three build attempts",
  },
  {
    title: "Move sessions to Redis",
    item: { slug: "seed-sessions", title: "Move sessions to Redis", description: "Server-side session store" },
    roles: { builder: "scripted-slow" },
    cancelAfterMs: 8000,
    shows: "a run that is cancelled mid-build",
  },
];

const PROGRAM = {
  title: "Billing export",
  body: "Customers need their invoices out of the product: CSV now, PDF after, and an API for both.",
  /* Zero means every breakdown is "too big to approve automatically", so the plan gate asks. */
  vars: { maxAutoApproveItems: 0 },
  roles: { decomposer: "scripted-planner", planner: "scripted-planner" },
  shows: "a program request waiting at the plan gate, with five more work items in the plan",
};

/**
 * Make the workspace's config ready to seed: the extra agents and their playbooks, and gates
 * that wait. Idempotent. Returns whether the config changed, which means a running daemon is
 * not using it yet.
 */
export function prepareSeedConfig(dir) {
  const configFile = join(dir, "orca.config.yaml");
  const config = YAML.parseDocument(readFileSync(configFile, "utf8"));
  const plain = config.toJS();
  const base = plain.agents.find((agent) => agent.id === "scripted");
  if (!base) throw new Error(`no 'scripted' agent in ${configFile}; is this a demo workspace?`);
  const basePlaybook = YAML.parse(readFileSync(join(dir, "demo-playbook.yaml"), "utf8"));
  let changed = false;

  mkdirSync(join(dir, ".orca-demo"), { recursive: true });
  for (const spec of AGENTS) {
    const playbookFile = join(dir, `${spec.id}-playbook.yaml`);
    const playbook = { ...basePlaybook, kinds: { ...basePlaybook.kinds, ...spec.kinds } };
    writeFileSync(playbookFile, YAML.stringify(playbook));
    if (plain.agents.some((agent) => agent.id === spec.id)) continue;
    /* The demo agent's command, with this agent's playbook, state and prompt log. */
    const args = [...base.args];
    const swap = (flag, value) => {
      const at = args.indexOf(flag);
      if (at >= 0) args[at + 1] = value;
    };
    swap("--playbook", playbookFile);
    swap("--state", join(dir, ".orca-demo", `${spec.id}-state.json`));
    swap("--log", join(dir, ".orca-demo", `${spec.id}-prompts.jsonl`));
    /* No roles: these agents are only ever chosen by a request's role overrides, so the
       demo's own work keeps going to `scripted`. */
    config.addIn(["agents"], config.createNode({ ...base, id: spec.id, name: spec.name, args, roles: [] }));
    changed = true;
  }
  if (plain.humanInput?.mode !== "pause") {
    config.set("humanInput", config.createNode({ mode: "pause" }));
    changed = true;
  }
  if (changed) writeFileSync(configFile, config.toString());
  return changed;
}

/** One call to the daemon's RPC endpoint, as `packages/cli/src/daemon-client.ts` makes it. */
async function call(url, token, method, params) {
  const response = await fetch(`${url.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: "request", id: 1, method, params }),
  });
  const message = await response.json().catch(() => undefined);
  if (!message?.ok) {
    const error = message?.error ?? { code: `HTTP_${response.status}`, message: response.statusText };
    throw new Error(`${method}: ${error.code}: ${error.message}`);
  }
  return message.result;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Submit the seed work to a running daemon, once per workspace: the work items and the plan's
 * slugs are fixed, so a second batch would collide with the first. `--fresh --seed` reseeds.
 */
export async function seed({ dir, url }) {
  const marker = join(dir, ".orca-demo", "seeded");
  if (existsSync(marker)) {
    log("this workspace is already seeded; start with --fresh --seed for a new one");
    return;
  }
  const token = readFileSync(join(dir, "auth", "local-client.token"), "utf8").trim();
  const stamp = Date.now().toString(36);
  const runIdOf = (result) => result?.runId ?? result?.run?.id;

  for (const [index, work] of WORK.entries()) {
    const result = await call(url, token, "requests.submit", {
      idempotencyKey: `seed-${stamp}-${index}`,
      title: work.title,
      body: work.item.description,
      workflowId: "ai-sdlc",
      vars: { workItem: work.item },
      ...(Object.keys(work.roles).length > 0 ? { overrides: { roles: work.roles } } : {}),
    });
    const runId = runIdOf(result);
    log(`${work.title}: ${work.shows}${runId ? ` (${runId})` : ` (${result?.state ?? "submitted"})`}`);
    if (work.cancelAfterMs !== undefined && runId) {
      await sleep(work.cancelAfterMs);
      await call(url, token, "runs.cancel", { runId, reason: "Superseded: sessions stay in signed cookies for v1." });
      log(`${work.title}: cancelled`);
    }
  }

  const program = await call(url, token, "requests.submit", {
    idempotencyKey: `seed-${stamp}-program`,
    title: PROGRAM.title,
    body: PROGRAM.body,
    vars: PROGRAM.vars,
    overrides: { roles: PROGRAM.roles },
  });
  log(`${PROGRAM.title}: ${PROGRAM.shows}${runIdOf(program) ? ` (${runIdOf(program)})` : ""}`);
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  log("submitted; the runs settle over the next minute or so");
}

// ---------- standalone ----------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--dir");
  const dir = resolve(at >= 0 ? process.argv[at + 1] : defaultWorkspace());
  if (!existsSync(join(dir, "orca.config.yaml"))) {
    console.error(`[seed] no demo workspace at ${dir}; start one with start.mjs --seed`);
    process.exit(1);
  }
  if (prepareSeedConfig(dir)) {
    log("added the seed agents and paused gates to the config; the running daemon has not loaded them");
    log("restart with: node .claude/skills/orca-demo-dev/scripts/start.mjs --seed");
    process.exit(1);
  }
  const url = process.env.ORCA_DAEMON_URL ?? "http://127.0.0.1:6722";
  await seed({ dir, url }).catch((error) => {
    console.error(`[seed] ${error.message}`);
    process.exit(1);
  });
}
