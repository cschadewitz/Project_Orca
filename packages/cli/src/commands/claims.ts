/**
 * `orca claims ...` - who owns which work item, and taking an item away from a run that died.
 *
 *   claims [--run <runId>] [--json]           list held claims with the owning run's status
 *   claims release <workItemId> [--force]     free the item; refused while its owner could still resume
 *
 * A claim is never released automatically (see store/claim-store.ts): a finished run keeps
 * its items so they are not dispatched twice, and a claim outlives the process that took it.
 * When a run is gone for good - cancelled, its log rolled back, its workflow deleted - a fresh
 * dispatcher over the same items reports every one of them as `claimed`; this is the way out.
 */
import { OrcaError } from "@orca/core";
import { bootstrap } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

export async function claimsCommand(ctx: CommandContext): Promise<number> {
  const [sub = "list", ...args] = ctx.positionals;
  const app = await bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}), logLevel: "warn" });
  const json = Boolean(ctx.flags.json);

  switch (sub) {
    case "list": {
      const claims = await app.orchestrator.listClaims(ctx.flags.run as string | undefined);
      if (json) return (ctx.out(JSON.stringify(claims, null, 2)), 0);
      if (!claims.length) ctx.out(ctx.flags.run ? `run ${String(ctx.flags.run)} holds no claims` : "no claims held");
      for (const c of claims) {
        const item = await app.orchestrator.stores.workItems.get(c.workItemId);
        ctx.out(`${c.workItemId.padEnd(28)} run=${c.runId}  owner=${c.owner.padEnd(9)} branch=${c.branch}${item ? `  item=${item.status}` : ""}  ${c.at}`);
      }
      return 0;
    }

    case "release": {
      const workItemId = args[0];
      if (!workItemId) throw new OrcaError("CONFIG_INVALID", "claims release needs a work item id (orca claims release <workItemId> [--force])");
      const released = await app.orchestrator.releaseClaim(workItemId, { force: Boolean(ctx.flags.force) });
      if (json) return (ctx.out(JSON.stringify(released, null, 2)), 0);
      ctx.out(`released ${workItemId} from run ${released.runId} (${released.owner}, branch ${released.branch})`);
      // The claim decides who may launch the item; its status is projected from the owning
      // run's log, and a dead run's log never moves on. Say so rather than let the operator
      // wonder why `orca plan dispatch` still does not offer the item.
      const item = await app.orchestrator.stores.workItems.get(workItemId);
      if (item?.status === "in-progress") ctx.err(`note: ${workItemId} is still in-progress${item.runId ? ` (run ${item.runId})` : ""}; the plan scheduler treats it as running until that status changes`);
      return 0;
    }

    default:
      throw new OrcaError("CONFIG_INVALID", `unknown claims subcommand '${sub}' (list, release)`);
  }
}
