/**
 * `secrets.list` and `secrets.check` (#336, part B2): what a principal may know about the
 * secret references this daemon is configured with, and whether one is available on its own
 * host now. Nothing here reads a value: a local check asks whether a variable is set or a
 * file is readable and non-empty, and an SSH check runs one `test`-style command on that host
 * with tracing and stderr switched off. There is no fallback to any other host.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { OrcaError, type SecretsConfig } from "@orca/core";
import { secretHostBinding, type AgentHost } from "@orca/agents";
import type { SecretReferenceView, SecretsCheckResult, SecretsListResult } from "@orca/protocol";
import { holds, type Principal } from "./auth/principal.js";

/** The live catalog and its hosts: the current configuration generation's registry. */
export interface SecretsSource {
  secrets(): SecretsConfig;
  hasHost(id: string): boolean;
  host(id: string): AgentHost;
}

const CHECK_TIMEOUT_MS = 15_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class SecretsReadModel {
  constructor(private readonly source: () => SecretsSource) {}

  /** The references `principal` may see: all with `*`, else those its grant names as bound now. */
  private visible(principal: Principal): [string, SecretsConfig[string]][] {
    const registry = this.source();
    const grant = principal.secrets;
    return Object.entries(registry.secrets()).filter(([id, ref]) => {
      if (grant === "*") return true;
      if (!grant || !registry.hasHost(ref.host)) return false;
      const binding = secretHostBinding(registry.host(ref.host).spec);
      return grant.some(
        (g) => g.secret === id && g.provider === ref.provider && g.host === ref.host && g.binding === binding,
      );
    });
  }

  list(principal: Principal): SecretsListResult {
    const sources = holds(principal, "config.read");
    const secrets: SecretReferenceView[] = this.visible(principal)
      .map(([id, ref]) => ({
        id,
        host: ref.host,
        provider: ref.provider,
        ...(ref.description !== undefined ? { description: ref.description } : {}),
        ...(sources ? (ref.provider === "env" ? { name: ref.name } : { path: ref.path }) : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { secrets };
  }

  async check(principal: Principal, id: string): Promise<SecretsCheckResult> {
    const found = this.visible(principal).find(([candidate]) => candidate === id);
    if (!found)
      throw new OrcaError("CONFIG_INVALID", `no secret reference '${id}'`, { secret: id, reason: "not-found" });
    const [, ref] = found;
    const registry = this.source();
    const result = (available: boolean, reason?: SecretsCheckResult["reason"]): SecretsCheckResult => ({
      id,
      host: ref.host,
      available,
      ...(reason ? { reason } : {}),
    });
    if (!registry.hasHost(ref.host)) return result(false, "unknown-host");
    const host = registry.host(ref.host);
    if (host.spec.type === "local") {
      if (ref.provider === "env") {
        const value = process.env[ref.name];
        return value !== undefined && value !== "" ? result(true) : result(false, "missing");
      }
      try {
        await access(ref.path, constants.R_OK);
        const info = await stat(ref.path);
        return info.isFile() && info.size > 0 ? result(true) : result(false, "missing");
      } catch {
        return result(false, "missing");
      }
    }
    // One command on the bound host. The value never reaches an argument or the output: an
    // env value is only counted, and stderr and tracing are off before anything expands it.
    const test =
      ref.provider === "env"
        ? `__orca_n=$(printenv ${ref.name} | wc -c) && [ "$__orca_n" -gt 1 ]`
        : `test -f ${shellQuote(ref.path)} && test -r ${shellQuote(ref.path)} && test -s ${shellQuote(ref.path)}`;
    try {
      const { code } = await host.exec(`set +xv; exec 2>/dev/null; if ${test}; then exit 0; else exit 3; fi`, {
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      if (code === 0) return result(true);
      if (code === 3) return result(false, "missing");
      return result(false, "unreachable");
    } catch {
      return result(false, "unreachable");
    }
  }
}
