/**
 * CLI command implementations. Each command receives parsed positionals and
 * flags and an output sink; `main.ts` handles argument parsing and errors.
 */
import { assertNoUnownedFirstRunMutation } from "@orca/protocol/first-run-fence";
import { firstRunRequiresExplicitContinuationRecovery } from "../first-run-recovery-fence.js";
import {
  assertClosedUpdateCommand,
  isClosedUpdateBootstrap,
  configuredUpdateAdmissionOpen,
  configuredUpdateExistingWorkOpen,
  closedUpdateStartupReceipt,
} from "../update-bootstrap.js";
import { mcpCommand } from "./mcp.js";
import { AdmissionRetryModel, ContinuationAdmissionModel, neverAttached } from "@orca/daemon";
import { admissionRetryOptions } from "./admission-retry.js";

import { admissionsCommand } from "./admissions.js";
import { revisionsCommand } from "./revisions.js";
import { FileContinuationLocatorStore, workspaceIdentity } from "@orca/store";
import {
  localSubmissionAuthority,
  localDirectAdmissionAuthority,
  authorityForNewLocalIntent,
} from "../local-submission-authority.js";
import { releaseAssets } from "../bootstrap.js";

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { openAcpSession, permissionPolicyPath } from "@orca/agents";
import {
  AgentModel,
  ConfigModel,
  ControlModel,
  PlanControlModel,
  ReadModel,
  answerAndResume,
  startDaemon,
  createDaemonIdentity,
  daemonExecutionRuntime,
  bootstrapLocalOwner,
  openAuthDirectory,
  orchestratorResolver,
  validateDeployment,
  WorkflowInputsModel,
  orchestratorDefinitionResolver,
} from "@orca/daemon";
import {
  AGENTS_LIST_METHOD,
  AGENTS_PING_METHOD,
  AGENT_METHODS,
  CONTROL_METHODS,
  HELLO_METHOD,
  PLAN_READ_METHODS,
  PROTOCOL_VERSION,
  helloOffer,
  READ_METHODS,
  SUBSCRIPTION_METHODS,
  AgentsPingResultSchema,
  formatProtocolVersion,
  isProtocolFault,
} from "@orca/protocol";
import {
  succeeded,
  toMermaid,
  validateWorkflow,
  parseWorkflow,
  loadTemplates,
  loadWorkflows,
  OrcaError,
  type OrcaConfig,
  type RunState,
  consoleLogger,
} from "@orca/core";
import { readFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import {
  PausingHumanInput,
  PlanService,
  autoHumanInput,
  builtinExecutors,
  createRevisionRuntime,
  createRevisionInputServices,
  readAdmissionExecutionStatus,
} from "@orca/engine";
import { AgentRegistry } from "@orca/agents";
import { RequestSubmissionModel } from "@orca/daemon";
import { serveAcpFacade, inspectKeplerTask } from "@orca/integrations";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec } from "@orca/testing";
import type { InstalledPluginRelease } from "../plugin-release.js";
import { bootstrap, loadConfig, loadPlugins, type OrcaApp } from "../bootstrap.js";
import { formatEvent, formatPaused, formatPendingInput, formatRunState, stepAgents } from "../format.js";
import { daemonCall, DaemonRedirectError, isAuthenticationFailure } from "../daemon-client.js";
import { parseVars, workflowGuards } from "./launch-options.js";
import { authCommand } from "./auth.js";
import { claimsCommand } from "./claims.js";
import { leasesCommand } from "./leases.js";
import { storeCommand } from "./store.js";
import { planCommand } from "./plan.js";
import { requireTemplatePack, selectionOverrides } from "./selection.js";

import { readOrcaVersion } from "../version.js";
export const ORCA_VERSION = readOrcaVersion();

export interface CommandContext {
  cwd: string;
  configPath?: string | undefined;
  flags: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Print the final state of a followed run and turn it into an exit code: 0 success, 2 failed/rejected, 3 paused at a human gate. */
export async function finish(app: OrcaApp, ctx: CommandContext, state: RunState): Promise<number> {
  ctx.out(formatRunState(state));
  if (state.run.status === "paused") {
    ctx.out("");
    ctx.out(formatPaused(state.run.id, await app.orchestrator.pendingInputs(state.run.id)));
    return 3;
  }
  return succeeded(state) ? 0 : 2;
}

export function attachEventPrinter(app: OrcaApp, ctx: CommandContext, quiet: boolean): () => void {
  if (quiet) return () => {};
  return app.orchestrator.subscribe((e) => ctx.err(formatEvent(e)));
}

/** Where `orca serve` is expected to be listening: the same defaults `serve` binds to. */
function daemonAddress(ctx: CommandContext): string {
  if (process.env.ORCA_DAEMON_URL && ctx.flags.host === undefined && ctx.flags.port === undefined)
    return process.env.ORCA_DAEMON_URL;
  const host = (ctx.flags.host as string | undefined) ?? "127.0.0.1";
  const port = ctx.flags.port === undefined ? 6722 : Number(ctx.flags.port);
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

/**
 * `agents.ping` against a daemon, or `undefined` when none answers. An answered handshake
 * with ping omitted is not permission to run locally: auth filters its method inventory.
 */
async function pingViaDaemon(
  ctx: CommandContext,
  url: string,
  agentId: string,
  cwd: string | undefined,
): Promise<{ ok: boolean; line: string } | undefined> {
  let hello: unknown;
  try {
    hello = await daemonCall(ctx, url, HELLO_METHOD, {
      client: `orca-cli/${ORCA_VERSION}`,
      // The client offer (#880), not this build's daemon version: a shipped daemon on an
      // earlier minor of the same major refuses a newer-minor offer.
      ...helloOffer(),
    });
  } catch (e) {
    if (
      e instanceof DaemonRedirectError ||
      isAuthenticationFailure(e) ||
      (e instanceof OrcaError && e.code === "CONFIG_INVALID")
    )
      throw e;
    // A daemon that refuses the handshake - an older protocol, most likely - is a daemon
    // this CLI cannot use. Falling back to the in-process handshake is strictly better than
    // failing: the person asked whether an agent answers, not whether a daemon is current.
    return undefined;
  }
  if (!hello) return undefined;
  const methods = (hello as { methods?: string[] }).methods ?? [];
  if (!methods.includes(AGENTS_PING_METHOD))
    throw new OrcaError("NOT_SUPPORTED", "the daemon does not offer agents.ping to this client");
  const result = AgentsPingResultSchema.safeParse(
    await daemonCall(ctx, url, AGENTS_PING_METHOD, { agentId, ...(cwd ? { cwd } : {}) }),
  );
  if (!result.success) return undefined;
  const { agent, ok, roundTripMs, error } = result.data;
  return {
    ok,
    line: ok
      ? `OK ${agent.id} on ${agent.hostId}: ACP handshake in ${roundTripMs ?? 0}ms, recorded by the daemon at ${url} (state ${agent.state})`
      : `FAIL ${agent.id} on ${agent.hostId}: ${error?.message ?? "handshake failed"}, recorded by the daemon at ${url} (state ${agent.state})`,
  };
}

/**
 * Model ids a running daemon has discovered per agent, from `agents.list`, or `undefined`
 * when no daemon answers. An agent is in the map only when its view carries a `models` list;
 * the rest have not been probed.
 */
async function discoveredModels(ctx: CommandContext, url: string): Promise<Map<string, string[]> | undefined> {
  let hello: unknown;
  try {
    hello = await daemonCall(ctx, url, HELLO_METHOD, {
      client: `orca-cli/${ORCA_VERSION}`,
      // The client offer (#880), not this build's daemon version: a shipped daemon on an
      // earlier minor of the same major refuses a newer-minor offer.
      ...helloOffer(),
    });
  } catch (e) {
    if (
      e instanceof DaemonRedirectError ||
      isAuthenticationFailure(e) ||
      (e instanceof OrcaError && e.code === "CONFIG_INVALID")
    )
      throw e;
    return undefined;
  }
  const methods = (hello as { methods?: string[] } | undefined)?.methods ?? [];
  if (!methods.includes(AGENTS_LIST_METHOD)) return undefined;
  let result: unknown;
  try {
    result = await daemonCall(ctx, url, AGENTS_LIST_METHOD, {});
  } catch (e) {
    if (
      e instanceof DaemonRedirectError ||
      isAuthenticationFailure(e) ||
      (e instanceof OrcaError && e.code === "CONFIG_INVALID")
    )
      throw e;
    return undefined;
  }
  const agents = (result as { agents?: unknown } | undefined)?.agents;
  if (!Array.isArray(agents)) return undefined;
  const map = new Map<string, string[]>();
  for (const a of agents as { id?: unknown; models?: unknown }[]) {
    if (typeof a.id !== "string" || !Array.isArray(a.models)) continue;
    map.set(
      a.id,
      (a.models as unknown[]).flatMap((m) =>
        typeof m === "string"
          ? [m]
          : m && typeof (m as { id?: unknown }).id === "string"
            ? [(m as { id: string }).id]
            : [],
      ),
    );
  }
  return map;
}

interface Command {
  help: string;
  usage?: string;
  run: (ctx: CommandContext) => Promise<number>;
}
export const commands: Record<string, Command> = {
  mcp: {
    help: "mcp [--endpoint <url>] [--token-env <name>]",
    usage: "Authenticated MCP over stdio. Requires an explicitly supplied daemon credential; does not start a daemon.",
    async run(ctx) {
      const ended = new Promise<void>((resolve) => process.stdin.once("end", resolve));
      const handle = await mcpCommand({
        ...(typeof ctx.flags.endpoint === "string" ? { endpoint: ctx.flags.endpoint } : {}),
        ...(typeof ctx.flags["token-env"] === "string" ? { tokenEnv: ctx.flags["token-env"] } : {}),
      });
      await ended;
      await handle.close();
      return 0;
    },
  },
  auth: {
    help: "auth [issue <principal>|list|rotate <credentialId>|revoke <credentialId>]  Manage this workspace's daemon credentials.",
    usage:
      "issue defaults to --preset client (owner, operator, viewer also supported).\n--workflow-scope id may be repeated; --runs-scope all|owned selects run scope.\n--label text names a credential; --expires-at ISO sets an expiry for issue or rotate.\n--json prints structured results. Only issue and rotate print a token, once. Restart serve to rotate its local bootstrap credential.\nLocal clients use ORCA_DAEMON_TOKEN, ORCA_DAEMON_TOKEN_FILE, or auth/local-client.token beside the workspace config.\n",
    run: authCommand,
  },

  validate: {
    help: "validate [files...] [--template-pack name]  Validate workflow definitions (defaults to those in orca.config.yaml); with a template pack, report which templates it overrides and which it inherits.",
    async run(ctx) {
      const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
      const assets = await releaseAssets(config);
      const templates = await loadTemplates(assets.templates, configDir);
      const files = ctx.positionals;
      const workflows = files.length
        ? await loadWorkflows(
            files.map((f) => (isAbsolute(f) ? f : join(ctx.cwd, f))),
            configDir,
          )
        : await loadWorkflows(assets.workflows, configDir);
      // Explicit files are the validation targets. Plugins may add workflows to the registry
      // so references resolve, but those additions must not change which files were requested.
      const selectedWorkflows = files.length ? workflows.list() : undefined;
      // The plugins are loaded for their node validators (#308): a `custom:*` node's fields are
      // checked here, by the executor that will run it, rather than when a run reaches it. The
      // stores are in memory because nothing runs; the config's agents are what a plugin's
      // `register` may consult, not what this command checks (a file is validated against its
      // own selectors, so `hasAgent` is deliberately absent).
      const executors = builtinExecutors();
      await loadPlugins(
        config,
        configDir,
        {
          executors,
          templates,
          workflows,
          agents: AgentRegistry.fromConfig(config),
          plan: new PlanService({ stores: memoryStores() }),
          setHumanInput() {},
          setWorkspaceProvider() {},
        },
        consoleLogger((ctx.flags["log-level"] as never) ?? "warn"),
      );
      const definitions = selectedWorkflows ?? workflows.list();
      let failed = 0;
      for (const def of definitions) {
        const r = validateWorkflow(def, {
          hasTemplate: (id) => templates.has(id),
          hasWorkflow: (id) => workflows.has(id),
          validateCustomNode: (n) => executors.validateNode(n),
        });
        ctx.out(
          `${r.ok ? "OK  " : "FAIL"} ${def.id} (${Object.keys(def.nodes).length} nodes, ${def.edges.length} edges)`,
        );
        for (const e of r.errors) ctx.out(`     error   ${e.path}: ${e.message}`);
        for (const w of r.warnings) ctx.out(`     warning ${w.path}: ${w.message}`);
        if (!r.ok) failed++;
        if (ctx.flags.mermaid) ctx.out("\n" + toMermaid(def, def.name) + "\n");
      }
      const pack = ctx.flags["template-pack"] as string | undefined;
      if (pack !== undefined) {
        // Throws TEMPLATE_NOT_FOUND for a pack that overrides nothing (#191).
        const overridden = requireTemplatePack(templates, pack);
        const used = new Set(
          definitions
            .flatMap((def) => Object.values(def.nodes))
            .flatMap((n) => {
              const t = (n as { template?: unknown }).template;
              return typeof t === "string" ? [t] : [];
            }),
        );
        const inherited = [...used].filter((id) => !overridden.includes(id)).sort();
        ctx.out(`template pack ${pack}:`);
        ctx.out(`  overrides ${overridden.join(", ")}`);
        ctx.out(`  inherits  ${inherited.length ? inherited.join(", ") : "nothing the validated workflows use"}`);
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
    help: "agents [--host addr] [--port n]  List configured hosts, agents, their models and roles.",
    async run(ctx) {
      const { config } = await loadConfig(ctx.cwd, ctx.configPath);
      // Discovered models come from a running daemon only; this command never spawns an agent.
      const discovered = await discoveredModels(ctx, daemonAddress(ctx));
      ctx.out("hosts:");
      for (const h of config.hosts)
        ctx.out(
          `  ${h.id.padEnd(14)} ${h.type}${h.type === "ssh" ? ` ${h.user ? h.user + "@" : ""}${h.host}${h.port ? ":" + h.port : ""}` : ""}`,
        );
      ctx.out("agents:");
      for (const a of config.agents) {
        ctx.out(
          `  ${a.id.padEnd(14)} host=${a.hostId.padEnd(10)} roles=[${a.roles.join(", ")}] ${a.command} ${a.args.join(" ")}`,
        );
        const declared = a.models ?? [];
        ctx.out(
          `    models declared: ${
            declared.length
              ? declared.map((m) => `${m.id}${m.id === a.defaultModel ? " (default)" : ""}`).join(", ")
              : "none"
          }`,
        );
        const found = discovered?.get(a.id);
        ctx.out(`    models discovered: ${found ? found.join(", ") || "none" : "not probed"}`);
      }
      if (Object.keys(config.roles).length)
        ctx.out(
          "roles: " +
            Object.entries(config.roles)
              .map(([r, a]) => `${r}→${a}`)
              .join(", "),
        );
      return 0;
    },
  },

  ping: {
    help: "ping <agentId> [--host addr] [--port n]  Handshake with an agent. A daemon answering on the address does it and records the result, so the Agents surface updates; otherwise this process does it and records nothing.",
    async run(ctx) {
      const id = ctx.positionals[0];
      if (!id) throw new OrcaError("CONFIG_INVALID", "ping needs an agent id");

      // Ask the daemon first, when there is one. Health is held in memory per process
      // (`AgentHealthTracker`), so a handshake here would prove the agent is up and leave
      // the daemon - and every screen reading from it - still saying `unknown`. Going
      // through `agents.ping` puts the result where the surfaces can see it (#225).
      const daemon = daemonAddress(ctx);
      const viaDaemon = await pingViaDaemon(ctx, daemon, id, ctx.flags.cwd as string | undefined);
      if (viaDaemon) {
        ctx.out(viaDaemon.line);
        return viaDaemon.ok ? 0 : 1;
      }

      const app = await bootstrap({
        cwd: ctx.cwd,
        ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
        ephemeral: true,
        logger: consoleLogger("debug"),
      });
      const { agent, host } = app.agents.resolve(id);
      const started = Date.now();
      const session = await openAcpSession({
        host,
        agent,
        cwd:
          (ctx.flags.cwd as string | undefined) ??
          host.spec.workspaceRoot ??
          (host.spec.type === "local" ? ctx.cwd : "/tmp"),
        logger: app.logger,
      });
      ctx.out(`OK ${agent.id} on ${host.id}: ACP session ${session.acpSessionId} in ${Date.now() - started}ms`);
      // Said plainly, because the difference matters to whoever is looking at a screen: this
      // handshake happened in a process that is about to exit, so nothing durable and
      // nothing any daemon can see has changed (#225).
      ctx.out(`  recorded nothing: no daemon answered on ${daemon}, and agent health lives in the daemon's memory`);
      await session.close();
      return 0;
    },
  },

  run: {
    usage:
      "--var key=value may be repeated; values are parsed as JSON when possible, otherwise kept as strings.\n--var-json key=JSON requires valid JSON and overrides --var for the same key. Quote JSON strings to keep numeric-looking text as a string.\n--workflow-version and --expected-workflow-revision pin the version and revision returned by preflight.\n--agent role=agentId and --model agentId=modelId may be repeated; --model modelId alone when the run uses exactly one agent.\n--template-pack name renders prompts from that template pack.\n--cwd dir selects the run workspace. --quiet suppresses event output.\nExit: 0 success, 2 failure or cancellation, 3 paused for input.\n",
    help: "run <workflowId> [--var k=v]... [--agent role=id]... [--model [agent=]model]... [--cwd dir] [--quiet]  Start a workflow run and follow it until it completes or pauses at a human gate.",
    async run(ctx) {
      const workflowId = ctx.positionals[0];
      if (!workflowId) throw new OrcaError("CONFIG_INVALID", "run needs a workflow id");
      const vars = parseVars(ctx.flags.var as string[] | undefined, ctx.flags["var-json"] as string[] | undefined);
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      app.workflows.get(workflowId);
      const overrides = selectionOverrides(ctx, {
        agents: app.agents,
        workflows: app.workflows,
        templates: app.templates,
        config: app.config,
        workflowIds: [workflowId],
      });
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const workspace = ctx.flags.cwd ? { hostId: "local", cwd: String(ctx.flags.cwd) } : undefined;
        if (app.directAdmissions && !workspace && !overrides) {
          const retry = admissionRetryOptions(ctx.flags["idempotency-key"] as string | undefined);
          if (ctx.flags["idempotency-key"] === undefined) ctx.err(`Retry key: ${retry.idempotencyKey}`);
          const authority = await localDirectAdmissionAuthority(app);
          const response = await app.directAdmissions.admitRun(
            { workflowId, vars, ...workflowGuards(ctx) },
            retry,
            authority,
          );
          if (response.state !== "resolved" || response.result.state !== "accepted")
            throw new OrcaError("RUN_STATE", "Run admission requires reconciliation", { ...response });
          await authority.authorize({ workflowId });
          return await finish(app, ctx, await app.orchestrator.run(response.result.runId));
        }
        if (ctx.flags["idempotency-key"] !== undefined)
          throw new OrcaError(
            "NOT_SUPPORTED",
            "Keyed direct admission does not support explicit workspace or selection overrides",
          );
        const state = await app.orchestrator.startAndRun({
          workflowId,
          vars,
          ...workflowGuards(ctx),
          ...(workspace ? { workspace } : {}),
          ...(overrides ? { overrides } : {}),
        });
        return await finish(app, ctx, state);
      } finally {
        detach();
      }
    },
  },

  admissions: {
    help: "admissions [list|inspect <id>|reconcile <id>]  Inspect or recover original local Request admissions without starting execution.",
    run: admissionsCommand,
  },

  revisions: {
    help: "revisions <discover <runId>|inspect|submit|replace>  Inspect or record explicit corrective input through an authenticated daemon.",
    usage:
      "--endpoint <url> (or ORCA_DAEMON_URL) selects the daemon; --token-env <name> defaults to ORCA_DAEMON_TOKEN.\ninspect reads a PendingRevisionTarget JSON file; submit reads a RevisionCommand; replace reads a ReplacePendingRevisionCommand via --body-file <file>.\nsubmit and replace require an explicit --idempotency-key retained for that exact intent. No credentials are discovered or saved. Execution continuation is separate.\n",
    run: revisionsCommand,
  },

  submit: {
    help: 'submit "<title>" [--body text | --body-file f] [--var k=v] [--item-workflow id] [--agent role=id]... [--model [agent=]model]...  Submit a request to the program workflow and follow it.',
    async run(ctx) {
      const title = ctx.positionals.join(" ");
      if (!title) throw new OrcaError("CONFIG_INVALID", "submit needs a title");
      const body = ctx.flags["body-file"]
        ? await readFile(String(ctx.flags["body-file"]), "utf8")
        : String(ctx.flags.body ?? "");
      const vars = parseVars(ctx.flags.var as string[] | undefined, ctx.flags["var-json"] as string[] | undefined);
      const app = await bootstrap({
        submissionAuthority: localSubmissionAuthority,
        cwd: ctx.cwd,
        ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
      });
      const overrides = selectionOverrides(ctx, {
        agents: app.agents,
        workflows: app.workflows,
        templates: app.templates,
        config: app.config,
        workflowIds: [app.config.program.workflow, app.config.program.itemWorkflow],
      });
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const retry = admissionRetryOptions(ctx.flags["idempotency-key"] as string | undefined);
        if (ctx.flags["idempotency-key"] === undefined) ctx.err(`Retry key: ${retry.idempotencyKey}\n`);
        const admitted = await app.program.submit(
          {
            title,
            body,
            vars,
            ...workflowGuards(ctx),
            ...(overrides ? { overrides } : {}),
          },
          retry,
        );
        ctx.out(
          `request ${admitted.request.id}; run ${admitted.runId}${admitted.admissionId ? `; admission ${admitted.admissionId}` : ""}`,
        );
        const state = await app.program.runSubmitted(admitted);
        const request = (await app.program.settle(state)) ?? admitted.request;
        ctx.out(`request ${request.id}: ${request.status}`);
        const code = await finish(app, ctx, state);
        const items = await app.orchestrator.stores.workItems.list((w) => w.requestId === request.id);
        if (items.length) {
          ctx.out("\nwork items:");
          for (const w of items)
            ctx.out(`  ${w.status.padEnd(12)} ${w.slug.padEnd(20)} ${w.title}${w.runId ? `  run=${w.runId}` : ""}`);
        }
        return code;
      } finally {
        detach();
      }
    },
  },

  plan: {
    usage:
      "Subcommands:\n  list\n  show|schedule|graph|risks|decisions|journal [key]\n  explain <slug> [key]\n  depend <slug> <ref> [key]\n  waive|satisfy <dependencyId> [key] [--rationale text]\n  decide <decisionKey> <option> [key] [--rationale text]\n  risk <riskKey> --status <status> [key]\n  dispatch [key] [--workflow id] [--item-workflow id] [--agent role=id]... [--model [agent=]model]... [--quiet]\n    --workflow picks the program workflow (default plan-resume; it must contain a custom:plan-dispatch node);\n    --item-workflow picks the workflow each dispatched item runs (default program.itemWorkflow).\n--plan key overrides the positional plan. --json prints structured read results.\n",
    help: "plan [list|show|schedule|explain|graph|risks|decisions|journal|depend|waive|satisfy|decide|risk|dispatch] ...  Inspect and steer the long-term plan (see docs/PLANNING.md).",
    run: planCommand,
  },

  claims: {
    help: "claims [list [--run <runId>] | release <workItemId> [--force]]  Show who owns which work item; free a dead run's claim so another dispatcher may launch it.",
    run: claimsCommand,
  },

  leases: {
    help: "leases [list | break <runId> [--force] [--keep]]  Show who is interpreting which run; free a run whose interpreter is gone.",
    run: leasesCommand,
  },

  store: {
    help: "store [format | carry-forward | sqlite import|backup <file>|restore <file>|verify]  Show the store's format; convert an older-format store once, with every other ORCA stopped; build, back up, restore or check the SQLite metadata.",
    run: storeCommand,
  },

  runs: {
    help: "runs  List runs in the store.",
    async run(ctx) {
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      for (const r of await app.orchestrator.listRunSummaries()) {
        ctx.out(
          `${r.id}  ${r.workflowId.padEnd(24)} ${r.status.padEnd(10)} ${r.outcome ?? ""}  ${r.createdAt}${r.parentRunId ? `  parent=${r.parentRunId}` : ""}`,
        );
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
      ctx.out(formatRunState(state, stepAgents(await app.orchestrator.events(runId))));
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
      for (const e of await app.orchestrator.events(runId))
        ctx.out(ctx.flags.json ? JSON.stringify(e) : formatEvent(e));
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
    help: "answer [<requestId> <option> [--note text] [--no-resume]]  Answer a paused run's question and resume it; --note records why in the run's log; without arguments, list open questions.",
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
      if (!value)
        throw new OrcaError(
          "CONFIG_INVALID",
          "answer needs a request id and an answer (orca answer <requestId> <option>)",
        );
      const resume = !ctx.flags["no-resume"];
      // Why, beside what. It goes onto `human.answered` with the answer (#238), so a person
      // reading the run later sees the reasoning where the decision is, rather than in
      // whichever terminal it was typed into. The run itself branches on the option alone.
      const note = ctx.flags.note as string | undefined;
      const detach = resume ? attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet)) : () => {};
      try {
        // The same function the daemon's `inputs.answer` calls (`@orca/daemon`): answer,
        // then continue, with the refusals classified in one place. The continuation is
        // `ProgramService.resume` here so a finished program run still settles onto its
        // Request; the daemon passes the plain orchestrator resume, because mirroring a
        // program run onto a Request is `ProgramService`'s job and not a daemon's.
        const { request, state } = await answerAndResume(app.orchestrator, {
          requestId,
          answer: value,
          ...(note ? { note } : {}),
          resume,
          resumeWith: (id) => app.program.resume(id),
        });
        ctx.out(`answered ${request.id} (run ${request.runId}): ${value}`);
        return state ? await finish(app, ctx, state) : 0;
      } catch (e) {
        // The shared function refuses with the wire's precise codes (`INPUT_ANSWERED`,
        // `INPUT_OPTION_UNKNOWN`, ...). `main.ts` renders an `OrcaError`, so re-raise as one
        // rather than showing a person a stack trace for something they simply got wrong.
        if (isProtocolFault(e)) throw new OrcaError("RUN_STATE", e.message, { code: e.code, ...(e.details ?? {}) });
        throw e;
      } finally {
        detach();
      }
    },
  },

  acp: {
    help: "acp  Serve ORCA as an ACP agent on stdio (register this command in Kepler, Zed, ...).",
    async run(ctx) {
      // stdout is the protocol channel; all logging goes to stderr.
      const app = await bootstrap({
        submissionAuthority: localSubmissionAuthority,
        cwd: ctx.cwd,
        ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
        logger: consoleLogger((ctx.flags["log-level"] as never) ?? "info"),
      });
      await serveAcpFacade({
        orchestrator: app.orchestrator,
        program: app.program,
        ...(app.submissionAuthority
          ? {
              submissionAuthority: app.submissionAuthority,
              authorityForNewIntent: authorityForNewLocalIntent(app, app.submissionAuthority),
            }
          : {}),
      });
      return 0;
    },
  },

  serve: {
    help: "serve [--host addr] [--port n] [--read-only] [--unauthenticated-loopback]  Run the authenticated ORCA daemon until interrupted. Default 127.0.0.1:6722; --read-only omits run controls.",
    usage:
      "Token authentication is on by default; the local credential is stored in auth/local-client.token beside the workspace config.\n--unauthenticated-loopback explicitly permits unauthenticated local access.\nRemote binds require --trusted-proxy IP (repeatable) behind a TLS-terminating proxy.\n--allow-origin origin permits a browser origin (repeatable; none by default).\n",
    run: (ctx) => serveDaemon(ctx),
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
    usage:
      "--dir path retains the chosen workspace. --keep retains an automatically created workspace.\nWithout either option the temporary workspace is removed after the demo. --quiet suppresses events.\n",
    help: "demo [--dir path] [--keep]  Run the program workflow end-to-end with scripted agents (no LLM needed). Without --dir the workspace is a temp dir, removed afterwards unless --keep.",
    async run(ctx) {
      // A --dir workspace belongs to the user and always survives; a temp
      // workspace is removed after the run unless --keep asks for it.
      const dir = ctx.flags.dir ? String(ctx.flags.dir) : await mkdtemp(join(tmpdir(), "orca-demo-"));
      const keep = Boolean(ctx.flags.dir) || Boolean(ctx.flags.keep);
      assertNoUnownedFirstRunMutation(resolvePath(dir));
      await mkdir(dir, { recursive: true });
      // commands/ -> (src|dist) -> cli -> packages -> repo root
      const here = fileURLToPath(new URL(".", import.meta.url));
      const repoRoot = join(here, "..", "..", "..", "..");
      const playbook = {
        greeting: "Scripted demo agent reporting for duty.",
        kinds: {
          decomposition: [
            {
              data: {
                items: [
                  {
                    slug: "schema",
                    title: "Database schema",
                    kind: "task",
                    description: "Add users table",
                    estimate: "S",
                    dependsOn: [],
                    risks: ["migration-downtime"],
                  },
                  {
                    slug: "login-api",
                    title: "Login API",
                    kind: "feature",
                    description: "POST /login",
                    estimate: "M",
                    priority: "high",
                    dependsOn: ["schema", "decision:session-store"],
                  },
                  {
                    slug: "docs",
                    title: "Docs",
                    kind: "task",
                    description: "Document auth",
                    estimate: "XS",
                    dependsOn: ["informs:login-api@spec"],
                  },
                ],
                risks: [
                  {
                    key: "migration-downtime",
                    title: "Schema migration locks the users table",
                    category: "operational",
                    likelihood: 2,
                    impact: 4,
                    mitigation: "Run the migration online",
                    affects: ["schema"],
                  },
                ],
                decisions: [
                  {
                    key: "session-store",
                    title: "Where do sessions live?",
                    question: "Signed cookies or a server-side store?",
                    options: [
                      { key: "cookie", name: "Signed cookie" },
                      { key: "redis", name: "Redis session store" },
                    ],
                    blocks: ["login-api"],
                  },
                ],
                rationale: "Vertical slices with one shared prerequisite and one architectural decision.",
              },
              body: "Demo breakdown.",
            },
          ],
          "risk-register": [
            {
              data: {
                status: "done",
                risks: [
                  {
                    key: "token-leak",
                    title: "Tokens logged in plaintext",
                    category: "security",
                    likelihood: 2,
                    impact: 5,
                    mitigation: "Redact in logger",
                    affects: ["login-api"],
                  },
                ],
                summary: "Two open risks, none critical.",
              },
              body: "Risk narrative.",
            },
          ],
          "decision-matrix": [
            {
              data: {
                key: "session-store",
                title: "Where do sessions live?",
                scale: 10,
                criteria: [
                  { key: "simplicity", name: "Simplicity", weight: 3 },
                  { key: "revocation", name: "Revocation support", weight: 1 },
                ],
                options: [
                  { key: "cookie", name: "Signed cookie", scores: { simplicity: 9, revocation: 3 } },
                  { key: "redis", name: "Redis", scores: { simplicity: 5, revocation: 9 } },
                ],
                rationale: "Simplicity wins for v1.",
              },
              body: "Matrix reasoning.",
            },
          ],
          spec: [
            {
              data: { status: "ready", risk: "low" },
              body: "# Spec\n\nDemo specification with enough prose to pass the design step's minimum body length validation rule.",
            },
          ],
          implementation: [{ data: { status: "done", branch: "orca/demo" }, body: "Demo implementation." }],
          "test-report": [
            { data: { status: "done", passed: false, failures: 1 }, body: "First run fails." },
            { data: { status: "done", passed: true, failures: 0 }, body: "All green." },
          ],
          review: [{ data: { status: "done", verdict: "approve" }, body: "LGTM" }],
        },
      };
      const playbookFile = join(dir, "demo-playbook.yaml");
      const config: OrcaConfig = {
        version: 1,
        storeDir: join(dir, ".orca"),
        hosts: [{ id: "local", type: "local" }],
        agents: [
          scriptedAgentSpec({
            playbookFile,
            stateFile: join(dir, ".orca-demo", "state.json"),
            promptLog: join(dir, ".orca-demo", "prompts.jsonl"),
          }),
        ],
        roles: {},
        workflows: [join(repoRoot, "workflows", "*.yaml").replaceAll("\\", "/")],
        templates: [join(repoRoot, "templates", "**", "*.md").replaceAll("\\", "/")],
        program: { workflow: "program", itemWorkflow: "ai-sdlc" },
        planning: { plan: "demo", planName: "Demo plan", policy: {}, riskMatrix: {} },
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
      const app = await bootstrap({
        submissionAuthority: localSubmissionAuthority,
        config,
        configDir: dir,
        cwd: dir,
        humanInput: autoHumanInput("approve"),
        logLevel: ctx.flags.quiet ? "warn" : "info",
      });
      ctx.err(`demo workspace: ${dir}`);
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const { request, state } = await app.program.submitAndRun({
          title: "Add authentication",
          body: "Users must be able to log in with email and password.",
        });
        ctx.out("");
        const code = await finish(app, ctx, state);
        const items = await app.orchestrator.stores.workItems.list((w) => w.requestId === request.id);
        ctx.out("\nwork items:");
        for (const w of items) ctx.out(`  ${w.status.padEnd(8)} ${w.slug.padEnd(12)} run=${w.runId ?? "-"}`);
        const plan = await app.plan.getPlan("demo");
        if (plan) {
          const snap = await app.plan.snapshot(plan.id);
          ctx.out(
            `\nplan '${plan.key}': ${snap.dependencies.length} dependencies, ${snap.risks.length} risks, ${snap.decisions.length} decisions (${snap.decisions
              .filter((d) => d.status === "decided")
              .map((d) => `${d.key}=${d.chosen}`)
              .join(", ")})`,
          );
          for (const line of await app.plan.explain(plan.id, "login-api")) ctx.out(`  ${line}`);
        }
        if (keep) {
          ctx.out(
            `\nartifacts and event logs are under ${join(dir, ".orca")}; inspect with: orca runs / orca status <runId> / orca events <runId> / orca plan show demo / orca plan journal demo  (run from ${dir})`,
          );
          ctx.out(
            `the workspace also holds a ready-to-use ${join(dir, "orca.config.yaml")} (scripted agents, playbook in demo-playbook.yaml); e.g.`,
          );
          ctx.out(
            `  orca --config ${join(dir, "orca.config.yaml")} run ai-sdlc --var 'workItem={"slug":"x","title":"X"}'`,
          );
        } else {
          ctx.out(`\nremoving demo workspace ${dir} (pass --keep or --dir <path> to inspect it afterwards)`);
        }
        return code;
      } finally {
        detach();
        if (!keep) await rm(dir, { recursive: true, force: true });
      }
    },
  },
};

/** Trusted operator composition only; no CLI flag, config, RPC or environment supplies this reference. */
export async function serveWithInstalledPluginRelease(
  ctx: CommandContext,
  installedPluginRelease: InstalledPluginRelease,
): Promise<number> {
  if (!installedPluginRelease || ctx.flags["unauthenticated-loopback"])
    throw new OrcaError("CONFIG_INVALID", "Installed plugin serve requires authenticated trusted composition");
  // Snapshot the caller's reference and command context before asynchronous startup.
  return serveDaemon(
    { ...ctx, flags: { ...ctx.flags }, positionals: [...ctx.positionals] },
    Object.freeze({ ...installedPluginRelease }),
  );
}

async function serveDaemon(ctx: CommandContext, installedPluginRelease?: InstalledPluginRelease): Promise<number> {
  assertClosedUpdateCommand("serve", ctx.flags);
  const port = ctx.flags.port === undefined ? 6722 : Number(ctx.flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new OrcaError("CONFIG_INVALID", `--port must be a port number, got '${String(ctx.flags.port)}'`);
  }
  const readOnly = Boolean(ctx.flags["read-only"]);
  let revisionRuntime: ReturnType<typeof createRevisionRuntime> | undefined;
  const executionBinding: { current?: ReturnType<typeof daemonExecutionRuntime> } = {};
  const app = await bootstrap({
    ...(installedPluginRelease ? { installedPluginRelease } : {}),
    ...(!readOnly && !ctx.flags["unauthenticated-loopback"]
      ? {
          revisionRuntime: (stores) => {
            revisionRuntime = createRevisionRuntime({
              stores,
              authorizeExecution: async (runId) => {
                const current = executionBinding.current;
                if (!current) throw new OrcaError("RUN_STATE", "Revision execution authority is unavailable");
                await current.authorizeExecution(runId);
              },
            });
            return revisionRuntime.runtime;
          },
        }
      : {}),
    cwd: ctx.cwd,
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    // Every gate parks to the log, whatever `humanInput.mode` says in the config. A
    // daemon that prompted on a terminal nobody is watching, or auto-answered on a
    // person's behalf, would fail worse than pausing does: parked, the question is on
    // `inputs.list` and `inputs.answer` settles it, from this process or the next one.
    ...(readOnly ? {} : { humanInput: new PausingHumanInput() }),
    // A stable holder, so a run this daemon is already driving is re-acquired rather
    // than blocked on, and so a lease in `orca leases list` names a process to go and
    // look at instead of an opaque id.
    lease: { holder: `orca-serve@${hostname()}:${process.pid}` },
  });
  const storeDir = resolvePath(app.configDir, app.config.storeDir);
  // The plan travels with the read model (#169): `bootstrap` always builds a
  // `PlanService`, so a daemon over a real workspace answers the nine plan reads too.
  const reads = new ReadModel({ orchestrator: app.orchestrator, plan: app.plan });
  // Agents regardless of `--read-only`: listing health reads memory, and a ping spawns
  // an agent, shakes hands and closes without touching a run, a lease or a log.
  const agents = new AgentModel({ orchestrator: app.orchestrator, reads });
  // The two configuration documents, `--read-only` or not: `config.get` is a read, and
  // `config.set` is kept out by being in the control half of the table (#174, #266).
  const config = new ConfigModel({
    generations: app.generations,
    configDir: app.configDir,
    ...(app.configFile ? { configFile: app.configFile } : {}),
    permissionsFile: permissionPolicyPath(app.configDir),
  });
  const control = readOnly
    ? undefined
    : new ControlModel({
        orchestrator: app.orchestrator,
        reads,
        permissionsFile: permissionPolicyPath(app.configDir),
        // So an "always" answer's sidecar write pushes `config.changed` like any other.
        config,
      });
  // The plan's writes ride the same switch: `--read-only` omits them with the run
  // controls, and they are present together or not at all.
  const planControl =
    readOnly || !reads.plans
      ? undefined
      : new PlanControlModel({
          plan: app.plan,
          orchestrator: app.orchestrator,
          plans: reads.plans,
          reads,
        });
  const authDir = ctx.flags["unauthenticated-loopback"]
    ? undefined
    : openAuthDirectory(resolvePath(app.configDir, "auth"));
  const auth = authDir
    ? {
        mode: "token" as const,
        credentials: authDir.credentials,
        ownership: authDir.ownership,
        resolver: orchestratorResolver(app.orchestrator),
        audit: authDir.audit,
        trustedProxies: ctx.flags["trusted-proxy"] as string[] | undefined,
        allowedOrigins: ctx.flags["allow-origin"] as string[] | undefined,
      }
    : {
        mode: "loopback-unauthenticated" as const,
        allowedOrigins: ctx.flags["allow-origin"] as string[] | undefined,
      };
  // Refuse an unsafe bind before rotating the credential local clients already use.
  validateDeployment(auth, (ctx.flags.host as string | undefined) ?? "127.0.0.1");
  const workspaceId = await workspaceIdentity(storeDir);
  const identity = createDaemonIdentity(workspaceId);
  const liveRuntime =
    !readOnly && authDir
      ? daemonExecutionRuntime({
          instanceId: identity.instanceId,
          workspaceId,
          orchestrator: app.orchestrator,
          credentials: authDir.credentials,
          ownership: authDir.ownership,
        })
      : undefined;
  if (liveRuntime) {
    executionBinding.current = liveRuntime;
    app.orchestrator.liveInput = liveRuntime;
    app.orchestrator.runtimeActivity = liveRuntime.activity;
    app.orchestrator.admissionExecution = {
      authorize: (policy) => liveRuntime.authorizeAdmissionExecution(policy),
    };
  }
  const requestSubmissions =
    !readOnly && authDir && app.program.submissions
      ? new RequestSubmissionModel({
          runtimeActivity: liveRuntime?.activity,
          orchestrator: app.orchestrator,
          service: app.program.submissions,
          shouldDispatch: (id) => neverAttached(app.orchestrator, id),
          checkResumeAuthority: async (id, authority) => liveRuntime?.checkResumeAuthority(id, authority),
          execute: async (id, authority) => {
            const state = liveRuntime
              ? await liveRuntime.withResumeAuthority(id, authority, () => app.orchestrator.run(id))
              : await app.orchestrator.run(id);
            await app.program.settle(state);
          },
          executionFailed: (id) => app.logger.error("Request execution requires recovery", { runId: id }),
        })
      : undefined;
  const admissionRetries =
    !readOnly && authDir && app.retryClaims && app.directAdmissions && app.program.submissions
      ? new AdmissionRetryModel({
          runtimeActivity: liveRuntime?.activity,
          claims: app.retryClaims,
          direct: app.directAdmissions,
          requests: app.program.submissions,
          orchestrator: app.orchestrator,
          checkResumeAuthority: async (id, authority) => liveRuntime?.checkResumeAuthority(id, authority),
          execute: async (id, authority) => {
            if (liveRuntime) await liveRuntime.withResumeAuthority(id, authority, () => app.orchestrator.run(id));
            else await app.orchestrator.run(id);
          },
          executionFailed: (id) => app.logger.error("Run admission requires recovery", { runId: id }),
        })
      : undefined;
  const continuationAdmissions =
    !readOnly && liveRuntime && app.retryClaims && app.retryClaimStore
      ? new ContinuationAdmissionModel({
          runtimeActivity: liveRuntime.activity,
          claims: app.retryClaims,
          orchestrator: app.orchestrator,
          locators: new FileContinuationLocatorStore({
            storeDir,
            execution: app.orchestrator.stores.execution,
            retries: app.retryClaimStore,
          }),
          executionRuntime: liveRuntime,
        })
      : undefined;
  const revisionServices =
    revisionRuntime && app.retryClaims && liveRuntime
      ? createRevisionInputServices({
          journal: revisionRuntime.journal,
          readJournal: revisionRuntime.readJournal,
          retries: revisionRuntime.fenceRetries(app.retryClaims),
          assertRetryFence: revisionRuntime.assertRetryFence,
          stale: () => new OrcaError("REVISION_STALE", "Revision destination is no longer available"),
        })
      : undefined;
  if (revisionServices && app.retryClaims) revisionServices.register(app.retryClaims);
  const daemon = await startDaemon({
    runtimeIdle: liveRuntime,
    admissionExecutionSource: async (runId) => {
      const status = await readAdmissionExecutionStatus(app.orchestrator.stores, runId);
      switch (status.state) {
        case "ordinary":
          return undefined;
        case "ready":
          return { state: "pending" };
        case "started":
          return { state: "started" };
        case "unknown":
          return { state: "uncertain", reason: "legacy-evidence" };
        case "blocked":
          return { state: "uncertain", reason: "evidence-unavailable" };
      }
    },
    ...(revisionServices && revisionRuntime
      ? { revisionSources: { services: revisionServices, readBoundaries: revisionRuntime.readBoundaries } }
      : {}),
    operatorSources: {
      ...(liveRuntime
        ? {
            liveState: (target) => liveRuntime.port.inspect(target),
            liveRevision: () => liveRuntime.port.observationRevision,
          }
        : {}),
      events: app.orchestrator.stores.events,
      leases: app.orchestrator.stores.leases,
      generations: app.generations,
      documents: {
        events: app.orchestrator.stores.events,
        requests: app.orchestrator.stores.requests,
        items: app.orchestrator.stores.workItems,
      },
      definitionFor: (id, version, stored) => app.orchestrator.definitionFor(id, version, stored),
      configStatus: () => config.operatorStatus(),
      artifactRun: async (id) => (await app.orchestrator.stores.artifacts.get(id))?.producedBy.runId,
      artifact: (_runId, artifactId, maxBytes) => reads.artifactsGet({ artifactId, maxBytes }),
    },

    admissionRetries,
    continuationAdmissions,
    requestSubmissions,
    submissionWorkspaceId: workspaceId,
    identity,
    liveInputs: liveRuntime?.port,
    workspaceId,
    auth,
    maintenanceToken: process.env.ORCA_MAINTENANCE_TOKEN,
    admissionFile: process.env.ORCA_ADMISSION_FILE,
    newAdmissionOpen: configuredUpdateAdmissionOpen,
    existingWorkOpen: configuredUpdateExistingWorkOpen,
    host: ctx.flags.host as string | undefined,
    port,
    orcaVersion: ORCA_VERSION,
    storeDir,
    // With control on - the default - this process is one of the store's writers. It
    // takes each run's single-writer lease before it appends, exactly as a CLI does, and
    // refuses a run another live process holds (ADR 0008, #101). `--read-only` gives
    // back the daemon v0.3.0 shipped: projections and nothing else.
    //
    // `runs.subscribe` is a read either way: the socket fans out this process's own
    // event store, so a client sees what runs *this* daemon drives or observes. A run
    // appended by a separate CLI process lands in that store's files, not in this
    // orchestrator's listeners, and still shows up on the next read - which is a
    // property of an in-memory listener list, not of the store (#196 made the store
    // multi-process safe). `plan.changed` has the same boundary, for the same reason.
    //
    // Derived, never asserted: `plan.read` is exactly "this read model has a plan" and
    // `plan.write` exactly "a PlanControlModel was built", which are the same two facts
    // `methodsFor` puts the plan methods in the table on. Hardcoding them meant a daemon
    // over a store with no plan advertised a capability whose nine methods `hello` did
    // not list, and a client hid nothing on the strength of it.
    capabilities: [
      ...(admissionRetries ? (["runs.admit", "admissions.get", "admissions.reconcile"] as const) : []),
      "runs.read",
      "runs.subscribe",
      "workflows.validateInputs",
      ...(control ? (["runs.control"] as const) : []),
      ...(reads.plans ? (["plan.read"] as const) : []),
      ...(planControl ? (["plan.write"] as const) : []),
    ],
    reads,
    ...(isClosedUpdateBootstrap() ? {} : { agents }),
    config,
    workflowInputs: new WorkflowInputsModel({ resolve: orchestratorDefinitionResolver(app.orchestrator) }),
    ...(control ? { control } : {}),
    ...(planControl ? { planControl } : {}),
    source: app.orchestrator,
    // `plan.changed` is folded from this process's plan journal - the store's own
    // listener seam. A plan a CLI beside this daemon changes lands on the next read,
    // the same boundary the run feed has just above.
    planSource: app.orchestrator.stores.plan.journal,
  });
  try {
    if (authDir && !isClosedUpdateBootstrap()) await bootstrapLocalOwner(authDir);
  } catch (error) {
    liveRuntime?.close();
    await daemon.close();
    throw error;
  }
  let recoveringContinuations: Promise<void> | undefined;
  const recoverContinuations = () => {
    if (!daemon.recoverContinuations || recoveringContinuations) return;
    recoveringContinuations = daemon
      .recoverContinuations()
      .catch(() => app.logger.warn("Continuation recovery requires explicit attention"))
      .finally(() => {
        recoveringContinuations = undefined;
      });
  };
  const explicitRecovery = isClosedUpdateBootstrap() || firstRunRequiresExplicitContinuationRecovery(app.configDir);
  if (!explicitRecovery) recoverContinuations();
  const continuationTimer =
    daemon.recoverContinuations && !explicitRecovery ? setInterval(recoverContinuations, 5_000) : undefined;
  continuationTimer?.unref();
  ctx.out(
    `orca daemon ${ORCA_VERSION} listening on ${daemon.url} (protocol ${formatProtocolVersion(PROTOCOL_VERSION)})`,
  );
  ctx.out(`serving ${storeDir}: ${READ_METHODS.join(", ")}, ${AGENT_METHODS.join(", ")}`);
  if (reads.plans) ctx.out(`serving the plan: ${PLAN_READ_METHODS.join(", ")}`);
  if (control) {
    ctx.out(`driving runs: ${CONTROL_METHODS.join(", ")}`);
  } else {
    ctx.out("read-only: no 'runs.control' capability, and the control methods are absent from this daemon");
  }
  ctx.out(
    authDir
      ? `authentication: token; local token file: ${authDir.tokenFile}`
      : "authentication: explicit unauthenticated loopback compatibility mode; any local process may call this daemon",
  );
  if (isClosedUpdateBootstrap()) {
    const receipt = await closedUpdateStartupReceipt(
      app.configDir,
      storeDir,
      { ...identity, processId: process.pid },
      () => app.closedWorkState(),
    );
    ctx.out("closed update validation: " + JSON.stringify(receipt));
  }
  if (daemon.socketUrl) ctx.out(`notifications on ${daemon.socketUrl}: ${SUBSCRIPTION_METHODS.join(", ")}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  if (continuationTimer) clearInterval(continuationTimer);
  await recoveringContinuations;
  liveRuntime?.close();
  await daemon.close();
  await continuationAdmissions?.drain();
  return 0;
}
