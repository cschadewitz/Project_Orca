/** Local credential administration: only explicit issue/rotate output contains a bearer token. */
import { assertNoUnownedFirstRunMutation } from "@orca/protocol/first-run-fence";
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import {
  openAuthDirectory,
  PRESETS,
  PRESET_NAMES,
  type CredentialInfo,
  type PresetName,
  type ResourceScope,
} from "@orca/daemon";
import { loadConfig } from "../bootstrap.js";
import type { CommandContext } from "./index.js";

function expiry(ctx: CommandContext): Date | undefined {
  const value = ctx.flags["expires-at"] as string | undefined;
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
    throw new OrcaError("CONFIG_INVALID", "--expires-at must be a future ISO date/time");
  return date;
}

function credentialId(value: string | undefined, sub: string): string {
  if (!value || !/^[A-Za-z0-9_-]{12}$/.test(value))
    throw new OrcaError("CONFIG_INVALID", `auth ${sub} needs a credential id from auth list`);
  return value;
}

function showIssued(ctx: CommandContext, issued: { token: string; credential: CredentialInfo }): void {
  if (ctx.flags.json) ctx.out(JSON.stringify(issued, null, 2));
  else {
    ctx.out(`credential ${issued.credential.id} for ${issued.credential.principal}`);
    ctx.out(issued.token);
    ctx.err("Store this token securely; it is shown only on issue or rotate.");
  }
}

export async function authCommand(ctx: CommandContext): Promise<number> {
  const [sub = "list", value, ...extra] = ctx.positionals;
  if (!["issue", "list", "rotate", "revoke"].includes(sub))
    throw new OrcaError("CONFIG_INVALID", "auth expects issue, list, rotate or revoke");
  if (extra.length || (sub === "list" && value !== undefined))
    throw new OrcaError("CONFIG_INVALID", `unexpected arguments for auth ${sub}`);
  const { configDir } = await loadConfig(ctx.cwd, ctx.configPath);
  assertNoUnownedFirstRunMutation(resolve(configDir));
  const auth = openAuthDirectory(resolve(configDir, "auth"));
  switch (sub) {
    case "issue": {
      if (!value) throw new OrcaError("CONFIG_INVALID", "auth issue needs a principal name");
      const preset = (ctx.flags.preset as PresetName | undefined) ?? "client";
      if (!PRESET_NAMES.includes(preset))
        throw new OrcaError("CONFIG_INVALID", `--preset must be one of ${PRESET_NAMES.join(", ")}`);
      const runs = (ctx.flags["runs-scope"] as ResourceScope["runs"] | undefined) ?? PRESETS[preset].scope.runs;
      if (runs !== "all" && runs !== "owned")
        throw new OrcaError("CONFIG_INVALID", "--runs-scope must be all or owned");
      const workflowIds = ctx.flags["workflow-scope"] as string[] | undefined;
      if (workflowIds?.some((id) => !id || id === "*"))
        throw new OrcaError("CONFIG_INVALID", "--workflow-scope requires workflow ids; omit it for all workflows");
      const issued = await auth.credentials.issue({
        principal: value,
        preset,
        scope: { workflows: workflowIds ? [...new Set(workflowIds)] : PRESETS[preset].scope.workflows, runs },
        label: ctx.flags.label as string | undefined,
        expiresAt: expiry(ctx),
      });
      showIssued(ctx, issued);
      return 0;
    }
    case "list": {
      const credentials = auth.credentials.list();
      if (ctx.flags.json) ctx.out(JSON.stringify(credentials, null, 2));
      else if (!credentials.length) ctx.out("no credentials issued");
      else
        for (const c of credentials) {
          const state = c.revokedAt
            ? "revoked"
            : c.expiresAt && Date.parse(c.expiresAt) <= Date.now()
              ? "expired"
              : "active";
          ctx.out(
            `${c.id} ${c.principal} ${state} workflows=${c.scope.workflows === "*" ? "*" : c.scope.workflows.join(",")} runs=${c.scope.runs}${c.expiresAt ? ` expires=${c.expiresAt}` : ""}${c.label ? ` label=${c.label}` : ""}`,
          );
        }
      return 0;
    }
    case "rotate": {
      const id = credentialId(value, sub);
      const current = auth.credentials.list().find((credential) => credential.id === id);
      // Only startup can atomically publish a matching bootstrap credential and token file.
      // A separate rotate then file write could overwrite a concurrent startup's fresh token.
      if (current?.bootstrap)
        throw new OrcaError("CONFIG_INVALID", "restart orca serve to rotate its local bootstrap credential");
      const issued = await auth.credentials.rotate(id, {
        expiresAt: expiry(ctx) ?? (current?.expiresAt ? new Date(current.expiresAt) : undefined),
      });
      showIssued(ctx, issued);
      return 0;
    }
    case "revoke": {
      const id = credentialId(value, sub);
      if (!(await auth.credentials.revoke(id))) throw new OrcaError("CONFIG_INVALID", "no live credential has that id");
      ctx.out(ctx.flags.json ? JSON.stringify({ id, revoked: true }) : `revoked ${id}`);
      return 0;
    }
    default:
      return 1;
  }
}
