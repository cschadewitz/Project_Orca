/**
 * CLI command implementations. Each command receives parsed positionals and
 * flags and an output sink; `main.ts` handles argument parsing and errors.
 */
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { hostname, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { openAcpSession, permissionPolicyPath } from "@orca/agents";
import {
  AgentModel,
  ConfigModel,
  ControlModel,
  PlanControlModel,
  ReadModel,
  answerAndResume,
  startDaemon,
} from "@orca/daemon";
import {
  AGENTS_PING_METHOD,
  AGENT_METHODS,
  CONTROL_METHODS,
  HELLO_METHOD,
  PLAN_READ_METHODS,
  PROTOCOL_VERSION,
  READ_METHODS,
  SUBSCRIPTION_METHODS,
  AgentsPingResultSchema,
  ResponseMessageSchema,
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
import { PausingHumanInput, autoHumanInput } from "@orca/engine";
import { serveAcpFacade, inspectKeplerTask } from "@orca/integrations";
import { scriptedAgentSpec } from "@orca/testing";
import { bootstrap, loadConfig, type OrcaApp } from "../bootstrap.js";
import { formatEvent, formatPaused, formatPendingInput, formatRunState } from "../format.js";
import { claimsCommand } from "./claims.js";
import { leasesCommand } from "./leases.js";
import { planCommand } from "./plan.js";

/**
 * The release version, as `orca --version` and `hello.orcaVersion` report it.
 *
 * The **root** manifest, deliberately, and it is the only place either of them reads.
 * The repository releases in lockstep from that one version; the packages under
 * `packages/` all sit at `0.1.0` and never move (docs/RELEASING.md), so reading this
 * package's own manifest had a `v0.3.0` release announce `orca daemon 0.1.0` — a number
 * plausible enough to go unnoticed and wrong everywhere it is shown (#229).
 *
 * Two ways in, because this module is built twice. `tsc` leaves it at
 * `packages/cli/dist/commands/index.js`, four directories below the root manifest —
 * exactly where `packages/cli/src/commands/index.ts` is, so the one relative path means
 * the same thing under `tsx`. That is the fallback and it is what every ordinary `orca`
 * invocation takes.
 *
 * The desktop app instead bundles the whole CLI into one file
 * (`packages/app/scripts/build-daemon.js`) and ships it somewhere else entirely, so
 * `import.meta.url` becomes the bundle's own location and no relative path from it can
 * reach a manifest this repository controls: it found `packages/app/package.json` while
 * the bundle sat in `packages/app/dist/daemon/` and nothing at all once electron-builder
 * moved it to `resources/daemon/`, which crashed the daemon on startup. So the bundler
 * reads that same root manifest at build time and substitutes the version here; the
 * require never runs there, and there is still one source.
 *
 * `typeof` rather than a bare reference: in the `tsc` build the identifier is not declared
 * at all, and `typeof` is the one operator that does not throw on that.
 */
declare const __ORCA_VERSION__: string | undefined;
export const ORCA_VERSION =
  typeof __ORCA_VERSION__ === "string"
    ? __ORCA_VERSION__
    : (createRequire(import.meta.url)("../../../../package.json") as { version: string }).version;

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
  const host = (ctx.flags.host as string | undefined) ?? "127.0.0.1";
  const port = ctx.flags.port === undefined ? 6722 : Number(ctx.flags.port);
  return `http://${host}:${port}`;
}

/**
 * One request envelope to a daemon's `/rpc`, or `undefined` when nothing answered.
 *
 * Deliberately `fetch` and a short timeout rather than a client class: the CLI is not a
 * daemon client yet (roadmap item 1), this is the first call it makes, and inventing the
 * client for one method would be guessing at what the rest of them need. "Nothing answered"
 * covers a refused connection, a timeout and a body that is not a response envelope - every
 * one of them means "fall back and do it here".
 */
async function daemonCall(url: string, method: string, params: unknown): Promise<unknown | undefined> {
  const timeout = AbortSignal.timeout(2000);
  let body: string;
  try {
    const res = await fetch(`${url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
      signal: timeout,
    });
    if (!res.ok) return undefined;
    body = await res.text();
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = ResponseMessageSchema.safeParse(json);
  if (!parsed.success) return undefined;
  if (!parsed.data.ok) {
    const { code, message } = parsed.data.error;
    throw new OrcaError("NOT_SUPPORTED", `daemon refused '${method}': ${message}`, { code, method });
  }
  return parsed.data.result;
}

/**
 * `agents.ping` against a daemon, or `undefined` when there is none (or when the one there
 * is too old to have the method, which `hello.methods` says before the call is made).
 */
async function pingViaDaemon(
  url: string,
  agentId: string,
  cwd: string | undefined,
): Promise<{ ok: boolean; line: string } | undefined> {
  let hello: unknown;
  try {
    hello = await daemonCall(url, HELLO_METHOD, {
      client: `orca-cli/${ORCA_VERSION}`,
      protocol: PROTOCOL_VERSION,
    });
  } catch {
    // A daemon that refuses the handshake - an older protocol, most likely - is a daemon
    // this CLI cannot use. Falling back to the in-process handshake is strictly better than
    // failing: the person asked whether an agent answers, not whether a daemon is current.
    return undefined;
  }
  if (!hello) return undefined;
  const methods = (hello as { methods?: string[] }).methods ?? [];
  if (!methods.includes(AGENTS_PING_METHOD)) return undefined;
  const result = AgentsPingResultSchema.safeParse(
    await daemonCall(url, AGENTS_PING_METHOD, { agentId, ...(cwd ? { cwd } : {}) }),
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

interface Command {
  help: string;
  usage?: string;
  run: (ctx: CommandContext) => Promise<number>;
}
export const commands: Record<string, Command> = {
  validate: {
    help: "validate [files...]  Validate workflow definitions (defaults to those in orca.config.yaml).",
    async run(ctx) {
      const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
      const templates = await loadTemplates(config.templates, configDir);
      const files = ctx.positionals;
      const workflows = files.length
        ? await loadWorkflows(
            files.map((f) => join(ctx.cwd, f)),
            configDir,
          )
        : await loadWorkflows(config.workflows, configDir);
      let failed = 0;
      for (const def of workflows.list()) {
        const r = validateWorkflow(def, {
          hasTemplate: (id) => templates.has(id),
          hasWorkflow: (id) => workflows.has(id),
        });
        ctx.out(
          `${r.ok ? "OK  " : "FAIL"} ${def.id} (${Object.keys(def.nodes).length} nodes, ${def.edges.length} edges)`,
        );
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
      for (const h of config.hosts)
        ctx.out(
          `  ${h.id.padEnd(14)} ${h.type}${h.type === "ssh" ? ` ${h.user ? h.user + "@" : ""}${h.host}${h.port ? ":" + h.port : ""}` : ""}`,
        );
      ctx.out("agents:");
      for (const a of config.agents)
        ctx.out(
          `  ${a.id.padEnd(14)} host=${a.hostId.padEnd(10)} roles=[${a.roles.join(", ")}] ${a.command} ${a.args.join(" ")}`,
        );
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
      const viaDaemon = await pingViaDaemon(daemon, id, ctx.flags.cwd as string | undefined);
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
      "--var key=value may be repeated; values are parsed as JSON when possible.\n--cwd dir selects the run workspace. --quiet suppresses event output.\nExit: 0 success, 2 failure or cancellation, 3 paused for input.\n",
    help: "run <workflowId> [--var k=v]... [--cwd dir] [--quiet]  Start a workflow run and follow it until it completes or pauses at a human gate.",
    async run(ctx) {
      const workflowId = ctx.positionals[0];
      if (!workflowId) throw new OrcaError("CONFIG_INVALID", "run needs a workflow id");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const workspace = ctx.flags.cwd ? { hostId: "local", cwd: String(ctx.flags.cwd) } : undefined;
        const state = await app.orchestrator.startAndRun({
          workflowId,
          vars: parseVars(ctx.flags.var as string[] | undefined),
          ...(workspace ? { workspace } : {}),
        });
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
      const body = ctx.flags["body-file"]
        ? await readFile(String(ctx.flags["body-file"]), "utf8")
        : String(ctx.flags.body ?? "");
      const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}) });
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        const { request, state } = await app.program.submitAndRun({
          title,
          body,
          vars: parseVars(ctx.flags.var as string[] | undefined),
        });
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
      "Subcommands:\n  list\n  show|schedule|graph|risks|decisions|journal [key]\n  explain <slug> [key]\n  depend <slug> <ref> [key]\n  waive|satisfy <dependencyId> [key] [--rationale text]\n  decide <decisionKey> <option> [key] [--rationale text]\n  risk <riskKey> --status <status> [key]\n  dispatch [key] [--workflow id] [--quiet]\n--plan key overrides the positional plan. --json prints structured read results.\n",
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
        cwd: ctx.cwd,
        ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
        logger: consoleLogger((ctx.flags["log-level"] as never) ?? "info"),
      });
      await serveAcpFacade({ orchestrator: app.orchestrator, program: app.program });
      return 0;
    },
  },

  serve: {
    help: "serve [--host addr] [--port n] [--read-only]  Run the ORCA daemon (the desktop app's backend) over this workspace's store until interrupted. It drives runs by default - answering gates, resuming, cancelling and starting them - and --read-only serves projections alone. The port carries no authentication: any local process can call the control methods, and the per-run lease guards against a second writer, not against a caller. Default 127.0.0.1:6722.",
    async run(ctx) {
      const port = ctx.flags.port === undefined ? 6722 : Number(ctx.flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new OrcaError("CONFIG_INVALID", `--port must be a port number, got '${String(ctx.flags.port)}'`);
      }
      const readOnly = Boolean(ctx.flags["read-only"]);
      const app = await bootstrap({
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
      const daemon = await startDaemon({
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
          "runs.read",
          "runs.subscribe",
          ...(control ? (["runs.control"] as const) : []),
          ...(reads.plans ? (["plan.read"] as const) : []),
          ...(planControl ? (["plan.write"] as const) : []),
        ],
        reads,
        agents,
        config,
        ...(control ? { control } : {}),
        ...(planControl ? { planControl } : {}),
        source: app.orchestrator,
        // `plan.changed` is folded from this process's plan journal - the store's own
        // listener seam. A plan a CLI beside this daemon changes lands on the next read,
        // the same boundary the run feed has just above.
        planSource: app.orchestrator.stores.plan.journal,
      });
      ctx.out(
        `orca daemon ${ORCA_VERSION} listening on ${daemon.url} (protocol ${formatProtocolVersion(PROTOCOL_VERSION)})`,
      );
      ctx.out(`serving ${storeDir}: ${READ_METHODS.join(", ")}, ${AGENT_METHODS.join(", ")}`);
      if (reads.plans) ctx.out(`serving the plan: ${PLAN_READ_METHODS.join(", ")}`);
      if (control) {
        ctx.out(`driving runs: ${CONTROL_METHODS.join(", ")}`);
        // Said out loud because it is a real cost that was accepted, not an oversight. The
        // port is loopback and unauthenticated, so anything running as this user can answer
        // a gate, cancel a run or start one. The lease is a correctness guard against two
        // interpreters; it is not a permission check. Pass --read-only if that is not the
        // machine you want.
        ctx.out(
          "  no authentication on this port: any local process may call them. The per-run lease stops a second writer, not a caller.",
        );
      } else {
        ctx.out("read-only: no 'runs.control' capability, and the control methods are absent from this daemon");
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
      await daemon.close();
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
    usage:
      "--dir path retains the chosen workspace. --keep retains an automatically created workspace.\nWithout either option the temporary workspace is removed after the demo. --quiet suppresses events.\n",
    help: "demo [--dir path] [--keep]  Run the program workflow end-to-end with scripted agents (no LLM needed). Without --dir the workspace is a temp dir, removed afterwards unless --keep.",
    async run(ctx) {
      // A --dir workspace belongs to the user and always survives; a temp
      // workspace is removed after the run unless --keep asks for it.
      const dir = ctx.flags.dir ? String(ctx.flags.dir) : await mkdtemp(join(tmpdir(), "orca-demo-"));
      const keep = Boolean(ctx.flags.dir) || Boolean(ctx.flags.keep);
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
