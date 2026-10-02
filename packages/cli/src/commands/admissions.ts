/** Local recovery keeps the original workspace/OS-user authority instead of impersonating a daemon owner. */
import { OrcaError } from "@orca/core";
import { bootstrap } from "../bootstrap.js";
import { localSubmissionAuthority } from "../local-submission-authority.js";
import type { CommandContext } from "./index.js";

export async function admissionsCommand(ctx: CommandContext): Promise<number> {
  const [action = "list", id, ...extra] = ctx.positionals;
  if (
    !(["list", "inspect", "reconcile"] as string[]).includes(action) ||
    extra.length ||
    (action === "list" ? id !== undefined : !id)
  )
    throw new OrcaError("CONFIG_INVALID", "admissions expects list, inspect <admissionId>, or reconcile <admissionId>");
  const app = await bootstrap({
    submissionAuthority: localSubmissionAuthority,
    cwd: ctx.cwd,
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
  });
  const service = app.program.submissions;
  const authority = app.submissionAuthority;
  if (!service || !authority) throw new OrcaError("NOT_SUPPORTED", "local admission recovery is unavailable");
  if (action === "list") {
    const admissions = await service.list(authority);
    ctx.out(JSON.stringify({ admissions }, null, 2));
    return 0;
  }
  const result = action === "inspect" ? await service.inspect(id!, authority) : await service.reconcile(id!, authority);
  ctx.out(JSON.stringify(result, null, 2));
  if (action === "reconcile" && result.state === "accepted")
    ctx.err(`Admission is durable; execution was not started. Continue explicitly with: orca resume ${result.runId}`);
  return result.state === "recoverable-failure" ? 1 : 0;
}
