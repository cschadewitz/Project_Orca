/**
 * `orca leases ...` - who is interpreting which run, and taking a run away from an interpreter
 * that is gone.
 *
 *   leases [--json]                      list the run leases on file, live and lapsed
 *   leases break <runId> [--force] [--keep]   free the run (and its subtree) for another interpreter
 *
 * Every process that drives a run holds a single-writer lease on it and heartbeats while it is
 * attached (see store/lease-store.ts): without one, an `orca acp` facade and an `orca resume`
 * over the same store would both reduce the log, both pick the next node, and both append their
 * own steps. A lease whose heartbeat has run out - or whose process is visibly gone - is
 * `lapsed` and the next `orca resume` takes it over on its own; `break --force` is only for a
 * lease that still looks live but is not, which is a holder in a container or on another host
 * that this process cannot probe.
 *
 * `break` takes the named run *and the descendants it will re-attach to*, because a resumed
 * parent drives its children; `--keep` limits it to the one run.
 */
import { OrcaError } from "@orca/core";
import { bootstrap } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

export async function leasesCommand(ctx: CommandContext): Promise<number> {
  const [sub = "list", ...args] = ctx.positionals;
  const app = await bootstrap({
    cwd: ctx.cwd,
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    logLevel: "warn",
  });
  const json = Boolean(ctx.flags.json);

  switch (sub) {
    case "list": {
      const leases = await app.orchestrator.listLeases();
      if (json) return (ctx.out(JSON.stringify(leases, null, 2)), 0);
      if (!leases.length) ctx.out("no run is leased");
      for (const l of leases)
        ctx.out(
          `${l.runId.padEnd(30)} ${(l.lapsed ? "lapsed" : "live").padEnd(7)} pid=${l.pid}@${l.host}  heartbeat=${l.renewedAt}${l.note ? `  ${l.note}` : ""}`,
        );
      return 0;
    }

    case "break": {
      const runId = args[0];
      if (!runId)
        throw new OrcaError("CONFIG_INVALID", "leases break needs a run id (orca leases break <runId> [--force])");
      const broken = await app.orchestrator.breakLease(runId, {
        force: Boolean(ctx.flags.force),
        ...(ctx.flags.keep ? { descendants: false } : {}),
      });
      if (json) return (ctx.out(JSON.stringify(broken, null, 2)), 0);
      for (const l of broken)
        ctx.out(`freed ${l.runId} (was held by pid ${l.pid} on ${l.host}, ${l.lapsed ? "lapsed" : "live"})`);
      // Breaking a live lease does not stop the other interpreter; it notices at its next
      // heartbeat and cancels itself, and until then it may still append.
      if (broken.some((l) => !l.lapsed))
        ctx.err(
          "note: a lease that was still live was broken; give its holder one heartbeat to notice before resuming the run",
        );
      return 0;
    }

    default:
      throw new OrcaError("CONFIG_INVALID", `unknown leases subcommand '${sub}' (list, break)`);
  }
}
