/**
 * `orca judge budget ...` - the owner's steps for the plain-language rule judge's daily budget (#701).
 *
 *   judge budget status   whether this machine can keep the budget durably, and where
 *   judge budget init     create the budget; the day it is created counts as fully spent
 *   judge budget reset    replace a budget that was refused (for example after the store was restored from a backup);
 *                         the new one also starts with that day fully spent
 *
 * The budget lives in the store (`<store>/review-judge/budget.json`) and its anchor in a per-user directory outside
 * it (`qualifiedJudgeBudget` in `@orca/daemon`), so restoring the store cannot hand back budget already spent. A
 * budget is never created or replaced by the daemon on its own: only these explicit steps do it. Windows is not
 * supported: the judge stays unavailable there.
 */
import { lstat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OrcaError } from "@orca/core";
import { JUDGE_BUDGET_FILENAME } from "@orca/agents";
import { describeJudgeBudgetUnavailable, qualifiedJudgeBudget } from "@orca/daemon";
import { assertNoUnownedFirstRunMutation } from "@orca/protocol/first-run-fence";
import { workspaceIdentity } from "@orca/store";
import { loadConfig } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

export async function judgeCommand(ctx: CommandContext): Promise<number> {
  const [area, sub = "status"] = ctx.positionals;
  if (area !== "budget") throw new OrcaError("CONFIG_INVALID", "usage: orca judge budget [status | init | reset]");
  if (sub !== "status" && sub !== "init" && sub !== "reset")
    throw new OrcaError("CONFIG_INVALID", `unknown judge budget step '${sub}': use status, init or reset`);
  const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
  const storeDir = resolve(configDir, config.storeDir);
  try {
    if (!(await lstat(storeDir)).isDirectory()) throw new Error("not a directory");
  } catch {
    ctx.err(`There is no store at ${storeDir} yet. Start ORCA once in this workspace, then run this again.`);
    return 1;
  }
  if (sub !== "status")
    try {
      assertNoUnownedFirstRunMutation(storeDir);
    } catch {
      ctx.err(
        "This store belongs to the desktop app's workspace, so the command line does not change it. Nothing was changed.",
      );
      return 1;
    }
  const qualified = await qualifiedJudgeBudget({ storeDir, workspaceId: await workspaceIdentity(storeDir) });
  if (qualified.status !== "durable") {
    ctx.err(describeJudgeBudgetUnavailable(qualified.reason));
    return 1;
  }
  ctx.out(`budget  ${join(qualified.storeDir, JUDGE_BUDGET_FILENAME)}`);
  ctx.out(`anchor  ${qualified.anchorDir}`);
  if (sub === "status") {
    ctx.out("durable yes: restoring the store cannot roll the budget back");
    return 0;
  }
  if (sub === "reset") await rm(join(qualified.storeDir, JUDGE_BUDGET_FILENAME), { force: true });
  const result = await qualified.budget.initialize();
  if (result.status === "initialized") {
    ctx.out(
      `${sub === "reset" ? "replaced" : "created"} for ${result.day} (UTC). That day counts as fully spent, so the judge's first calls are allowed from the next UTC day.`,
    );
    return 0;
  }
  ctx.err(
    result.reason === "exists"
      ? "A budget already exists, so nothing was changed. Use `orca judge budget reset` only if the judge reports the budget as refused."
      : result.reason === "clock"
        ? "The system clock could not be read, so nothing was changed."
        : "The budget could not be written, so nothing was changed.",
  );
  return 1;
}
