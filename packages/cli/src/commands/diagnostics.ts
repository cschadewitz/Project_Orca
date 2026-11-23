/**
 * `orca diagnostics ...` - the diagnostics ORCA keeps when an agent opts in (#1000).
 *
 *   diagnostics tool-calls runs                         runs that have tool-call records
 *   diagnostics tool-calls export <runId> [sessionId]   every record, one JSON object per line
 *   diagnostics tool-calls delete <runId> [sessionId]   remove a run's (or one session's) records
 *   diagnostics tool-calls prune                        remove every record past its retention
 *
 * Tool-call records are what an agent's native pre-tool hook reported about each call it
 * decided, kept only for agents with `diagnostics.toolCalls: keep`, redacted of secret values
 * and kept `diagnostics.retainDays` days. They are diagnostics, not an audit record.
 */
import { OrcaError } from "@orca/core";
import { bootstrap } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

const USAGE = "diagnostics tool-calls (runs | export <runId> [sessionId] | delete <runId> [sessionId] | prune)";

export async function diagnosticsCommand(ctx: CommandContext): Promise<number> {
  const [area, sub, runId, sessionId] = ctx.positionals;
  if (area !== "tool-calls") throw new OrcaError("CONFIG_INVALID", `usage: orca ${USAGE}`);
  const app = await bootstrap({
    cwd: ctx.cwd,
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    logLevel: "warn",
  });
  const store = app.orchestrator.stores.toolTelemetry;
  if (!store) throw new OrcaError("NOT_SUPPORTED", "this store keeps no tool-call diagnostics");
  const json = Boolean(ctx.flags.json);
  const scope = () => {
    if (!runId) throw new OrcaError("CONFIG_INVALID", `${sub} needs a run id (orca ${USAGE})`);
    return { runId, ...(sessionId ? { sessionId } : {}) };
  };

  switch (sub) {
    case "runs": {
      const runs = await store.runs();
      if (json) return (ctx.out(JSON.stringify(runs)), 0);
      if (!runs.length) ctx.out("no run has tool-call records");
      for (const id of runs) ctx.out(id);
      return 0;
    }
    case "export": {
      for (const record of await store.list(scope())) ctx.out(JSON.stringify(record));
      return 0;
    }
    case "delete": {
      const removed = await store.delete(scope());
      if (json) return (ctx.out(JSON.stringify({ removed })), 0);
      ctx.out(`removed ${removed} tool-call record${removed === 1 ? "" : "s"}`);
      return 0;
    }
    case "prune": {
      const removed = await store.prune(new Date());
      if (json) return (ctx.out(JSON.stringify({ removed })), 0);
      ctx.out(`removed ${removed} expired tool-call record${removed === 1 ? "" : "s"}`);
      return 0;
    }
    default:
      throw new OrcaError("CONFIG_INVALID", `unknown diagnostics subcommand '${sub ?? ""}' (orca ${USAGE})`);
  }
}
