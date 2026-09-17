/**
 * CLI command implementations. Each command receives parsed positionals and
 * flags and an output sink; `main.ts` handles argument parsing and errors.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAcpSession } from "@orca/agents";
import { toMermaid, validateWorkflow, parseWorkflow, loadTemplates, loadWorkflows, OrcaError, type OrcaConfig, type RunState, consoleLogger } from "@orca/core";
import { readFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import { autoHumanInput } from "@orca/engine";
import { serveAcpFacade, inspectKeplerTask } from "@orca/integrations";
import { scriptedAgentSpec } from "@orca/testing";
import { bootstrap, loadConfig, type OrcaApp } from "../bootstrap.js";
import { formatEvent, formatPaused, formatPendingInput, formatRunState } from "../format.js";

export interface CommandContext {
  cwd: string;
  configPath?: string | undefined;
  flags: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  out: (line: string) => void;
  err: (line: string) => void;
}

function parseVars(values: string[] | undefined): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const kv of values ?? []) {
    const i = kv.indexOf("=");
    if (i < 0) throw new OrcaError("CONFIG_INVALID", `--var expects key=value, got '${kv}'`);
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    try {
      vars[k] = JSON.parse(v);
    } catch {
      vars[k] = v;
    }
  }
  return vars;
}

/** Print the final state of a followed run and turn it into an exit code: 0 success, 2 failed/rejected, 3 paused at a human gate. */
async function finish(app: OrcaApp, ctx: CommandContext, state: RunState): Promise<number> {
  ctx.out(formatRunState(state));
  if (state.run.status === "paused") {
    ctx.out("");
    ctx.out(formatPaused(state.run.id, await app.orchestrator.pendingInputs(state.run.id)));
    return 3;
  }
  return state.run.status === "completed" && state.run.outcome === "success" ? 0 : 2;
}

function attachEventPrinter(app: OrcaApp, ctx: CommandContext, quiet: boolean): () => void {
  if (quiet) return () => {};
  return app.orchestrator.subscribe((e) => ctx.err(formatEvent(e)));
}

export const commands: Record<string, { help: string; run: (ctx: CommandContext) => Promise<number> }> = {
  validate: {
    help: "validate [files...]  Validate workflow definitions (defaults to those in orca.config.yaml).",
    async run(ctx) {
      const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
      const templates = await loadTemplates(config.templates, configDir);
      const files = ctx.positionals;
      const workflows = files.length ? await loadWorkflows(files.map((f) => join(ctx.cwd, f)), configDir) : await loadWorkflows(config.workflows, configDir);
      let failed = 0;
      for (const def of workflows.list()) {
        const r = validateWorkflow(def, { hasTemplate: (id) => templates.has(id), hasWorkflow: (id) => workflows.has(id) });
        ctx.out(`${r.ok ? "OK  " : "FAIL"} ${def.id} (${Object.keys(def.nodes).length} nodes, ${def.edges.length} edges)`);
        for (const e of r.errors) ctx.out(`     error   ${e.path}: ${e.message}`);
        for (const w of r.warnings) ctx.out(`     warning ${w.path}: ${w.message}`);
        if (!r.ok) failed++;
        if (ctx.flags.mermaid) ctx.out("\n" + toMermaid(def, def.name) + "\n");
      }
      return failed ? 1 : 0;
    },
  },

  graph: {
    help: "graph <workflowId|file>  Print a workflow as a Mermaid flowchart.",
    async run(ctx) {
      const target = ctx.positionals[0];
      if (!target) throw new OrcaError("CONFIG_INVALID", "graph needs a workflow id or file");
      if (target.endsWith(".yaml") || target.endsWith(".yml") || target.endsWith(".json")) {
        const def = parseWorkflow(await readFile(join(ctx.cwd, target), "utf8"), target);
        ctx.out(toMermaid(def, def.name));
        return 0;
      }
      const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
      const def = (await loadWorkflows(config.workflows, configDir)).get(target);
      ctx.out(toMermaid(def, def.name));
      return 0;
    },
  },

  agents: {
    help: "agents  List configured hosts, agents and roles.",
    async run(ctx) {
      const { config } = await loadConfig(ctx.cwd, ctx.configPath);
      ctx.out("hosts:");
      for (const h of config.hosts) ctx.out(`  ${h.id.padEnd(14)} ${h.type}${h.type === "ssh" ? ` ${h.user ? h.user + "@" : ""}${h.host}${h.port ? ":" + h.port : ""}` : ""}`);
      ctx.out("agents:");
      for (const a of config.agents) ctx.out(`  ${a.id.padEnd(14)} host=${a.hostId.padEnd(10)} roles=[${a.roles.join(", ")}] ${a.command} ${a.args.join(" ")}`);
      if (Object.keys(config.roles).length) ctx.out("roles: " + Object.entries(config.roles).map(([r, a]) => `${r}→${a}`).join(", "));
      return 0;
    },
  },

  ping: {
    help: "ping <agentId>  Spawn the agent (locally or over SSH), complete the ACP handshake, and close.",
    async run(ctx) {
      const id = ctx.positionals[0];
      if (!id) throw new OrcaError("CONFIG_INVALID", "ping needs an agent id");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}), ephemeral: true, logger: consoleLogger("debug") });
      const { agent, host } = app.agents.resolve(id);
      const started = Date.now();
      const session = await openAcpSession({ host, agent, cwd: (ctx.flags.cwd as string | undefined) ?? host.spec.workspaceRoot ?? (host.spec.type === "local" ? ctx.cwd : "/tmp"), logger: app.logger });
      ctx.out(`OK ${agent.id} on ${host.id}: ACP session ${session.acpSessionId} in ${Date.now() - started}ms`);
      await session.close();
      return 0;
    },
  },

  run: {
    help: "run <workflowId> [--var k=v]... [--cwd dir] [--quiet]  Start a workflow run and follow it until it completes or pauses at a human gate.",
    async run(ctx) {
      const workflowId = ctx.positionals[0];
      if (!workflowId) throw new OrcaError("CONFIG_INVALID", "run needs a workflow id");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const workspace = ctx.flags.cwd ? { hostId: "local", cwd: String(ctx.flags.cwd) } : undefined;
        const state = await app.orchestrator.startAndRun({ workflowId, vars: parseVars(ctx.flags.var as string[] | undefined), ...(workspace ? { workspace } : {}) });
        return await finish(app, ctx, state);
      } finally {
        detach();
      }
    },
  },

  submit: {
    help: 'submit "<title>" [--body text | --body-file f] [--var k=v]  Submit a request to the program workflow and follow it.',
    async run(ctx) {
      const title = ctx.positionals.join(" ");
      if (!title) throw new OrcaError("CONFIG_INVALID", "submit needs a title");
      const body = ctx.flags["body-file"] ? await readFile(String(ctx.flags["body-file"]), "utf8") : String(ctx.flags.body ?? "");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const { request, state } = await app.program.submitAndRun({ title, body, vars: parseVars(ctx.flags.var as string[] | undefined) });
        ctx.out(`request ${request.id}: ${request.status}`);
        const code = await finish(app, ctx, state);
        const items = await app.orchestrator.stores.workItems.list((w) => w.requestId === request.id);
        if (items.length) {
          ctx.out("\nwork items:");
          for (const w of items) ctx.out(`  ${w.status.padEnd(12)} ${w.slug.padEnd(20)} ${w.title}${w.runId ? `  run=${w.runId}` : ""}`);
        }
        return code;
      } finally {
        detach();
      }
    },
  },

  runs: {
    help: "runs  List runs in the store.",
    async run(ctx) {
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      for (const r of await app.orchestrator.listRunSummaries()) {
        ctx.out(`${r.id}  ${r.workflowId.padEnd(24)} ${r.status.padEnd(10)} ${r.outcome ?? ""}  ${r.createdAt}${r.parentRunId ? `  parent=${r.parentRunId}` : ""}`);
      }
      return 0;
    },
  },

  status: {
    help: "status <runId>  Show a run's steps, artifacts and pending questions.",
    async run(ctx) {
      const runId = ctx.positionals[0];
      if (!runId) throw new OrcaError("CONFIG_INVALID", "status needs a run id");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      const state = await app.orchestrator.getState(runId);
      ctx.out(formatRunState(state));
      if (state.run.status === "paused") {
        ctx.out("");
        ctx.out(formatPaused(runId, await app.orchestrator.pendingInputs(runId)));
      }
      return 0;
    },
  },

  events: {
    help: "events <runId> [--json]  Print a run's event log.",
    async run(ctx) {
      const runId = ctx.positionals[0];
      if (!runId) throw new OrcaError("CONFIG_INVALID", "events needs a run id");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      for (const e of await app.orchestrator.events(runId)) ctx.out(ctx.flags.json ? JSON.stringify(e) : formatEvent(e));
      return 0;
    },
  },

  resume: {
    help: "resume <runId>  Resume an interrupted or paused run (and the parents waiting on it) from its event log.",
    async run(ctx) {
      const runId = ctx.positionals[0];
      if (!runId) throw new OrcaError("CONFIG_INVALID", "resume needs a run id");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        return await finish(app, ctx, await app.program.resume(runId));
      } finally {
        detach();
      }
    },
  },

  answer: {
    help: "answer [<requestId> <option> [--no-resume]]  Answer a paused run's question and resume it; without arguments, list open questions.",
    async run(ctx) {
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      const [requestId, ...rest] = ctx.positionals;
      if (!requestId) {
        const pending = await app.orchestrator.pendingInputs();
        if (!pending.length) ctx.out("no open questions");
        for (const h of pending) ctx.out(formatPendingInput(h));
        return 0;
      }
      const value = rest.join(" ");
      if (!value) throw new OrcaError("CONFIG_INVALID", "answer needs a request id and an answer (orca answer <requestId> <option>)");
      const request = await app.orchestrator.answer(requestId, value);
      ctx.out(`answered ${request.id} (run ${request.runId}): ${value}`);
      if (ctx.flags["no-resume"]) return 0;
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        return await finish(app, ctx, await app.program.resume(request.runId));
      } finally {
        detach();
      }
    },
  },

  acp: {
    help: "acp  Serve ORCA as an ACP agent on stdio (register this command in Kepler, Zed, T3 Code, ...).",
    async run(ctx) {
      // stdout is the protocol channel; all logging goes to stderr.
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}), logger: consoleLogger((ctx.flags["log-level"] as never) ?? "info") });
      await serveAcpFacade({ orchestrator: app.orchestrator, program: app.program });
      return 0;
    },
  },

  kepler: {
    help: "kepler [taskDir]  Inspect a Kepler task directory (worktrees, task context) as ORCA sees it.",
    async run(ctx) {
      const info = await inspectKeplerTask(ctx.positionals[0] ?? process.env.KEPLER_TASK_DIR ?? ctx.cwd);
      ctx.out(JSON.stringify(info, null, 2));
      return 0;
    },
  },

  demo: {
    help: "demo [--dir path] [--keep]  Run the program workflow end-to-end with scripted agents (no LLM needed).",
    async run(ctx) {
      const dir = ctx.flags.dir ? String(ctx.flags.dir) : await mkdtemp(join(tmpdir(), "orca-demo-"));
      await mkdir(dir, { recursive: true });
      // commands/ -> (src|dist) -> cli -> packages -> repo root
      const here = new URL(".", import.meta.url).pathname;
      const repoRoot = join(here, "..", "..", "..", "..");
      const playbook = {
        greeting: "Scripted demo agent reporting for duty.",
        kinds: {
          decomposition: [{ data: { items: [
            { slug: "schema", title: "Database schema", kind: "task", description: "Add users table", dependsOn: [] },
            { slug: "login-api", title: "Login API", kind: "feature", description: "POST /login", dependsOn: ["schema"] },
            { slug: "docs", title: "Docs", kind: "task", description: "Document auth", dependsOn: [] },
          ], rationale: "Vertical slices with one shared prerequisite." }, body: "Demo breakdown." }],
          spec: [{ data: { status: "ready", risk: "low" }, body: "# Spec\n\nDemo specification with enough prose to pass the design step's minimum body length validation rule." }],
          implementation: [{ data: { status: "done", branch: "orca/demo" }, body: "Demo implementation." }],
          "test-report": [{ data: { status: "done", passed: false, failures: 1 }, body: "First run fails." }, { data: { status: "done", passed: true, failures: 0 }, body: "All green." }],
          review: [{ data: { status: "done", verdict: "approve" }, body: "LGTM" }],
        },
      };
      const playbookFile = join(dir, "demo-playbook.yaml");
      const config: OrcaConfig = {
        version: 1,
        storeDir: join(dir, ".orca"),
        hosts: [{ id: "local", type: "local" }],
        agents: [scriptedAgentSpec({ playbookFile, stateFile: join(dir, ".orca-demo", "state.json"), promptLog: join(dir, ".orca-demo", "prompts.jsonl") })],
        roles: {},
        workflows: [join(repoRoot, "workflows", "*.yaml")],
        templates: [join(repoRoot, "templates", "**", "*.md")],
        program: { workflow: "program", itemWorkflow: "ai-sdlc" },
        workspace: { provider: "local", root: dir, hostId: "local" },
        humanInput: { mode: "auto", option: "approve" },
        plugins: [],
      };
      await writeFile(join(dir, "README.md"), "# ORCA demo workspace\n", "utf8");
      await writeFile(playbookFile, stringifyYaml(playbook), "utf8");
      // Every path in the config is absolute, so the demo workspace doubles as a
      // working ORCA setup: `orca --config <dir>/orca.config.yaml <cmd>` (or any
      // orca command run from <dir>) drives the same scripted agents afterwards.
      await writeFile(join(dir, "orca.config.yaml"), stringifyYaml(config), "utf8");
      const app = await bootstrap({ config, configDir: dir, cwd: dir, humanInput: autoHumanInput("approve"), logLevel: ctx.flags.quiet ? "warn" : "info" });
      ctx.err(`demo workspace: ${dir}`);
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const { request, state } = await app.program.submitAndRun({ title: "Add authentication", body: "Users must be able to log in with email and password." });
        ctx.out("");
        const code = await finish(app, ctx, state);
        const items = await app.orchestrator.stores.workItems.list((w) => w.requestId === request.id);
        ctx.out("\nwork items:");
        for (const w of items) ctx.out(`  ${w.status.padEnd(8)} ${w.slug.padEnd(12)} run=${w.runId ?? "-"}`);
        ctx.out(`\nartifacts and event logs are under ${join(dir, ".orca")}; inspect with: orca runs / orca status <runId> / orca events <runId>  (run from ${dir})`);
        ctx.out(`the workspace also holds a ready-to-use ${join(dir, "orca.config.yaml")} (scripted agents, playbook in demo-playbook.yaml); e.g.`);
        ctx.out(`  orca --config ${join(dir, "orca.config.yaml")} run ai-sdlc --var 'workItem={"slug":"x","title":"X"}'`);
        return code;
      } finally {
        detach();
      }
    },
  },
};
