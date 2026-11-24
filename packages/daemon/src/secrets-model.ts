/**
 * `secrets.list` and `secrets.check` (#336, part B2): what a principal may know about the
 * secret references this daemon is configured with, and whether one is present on its own
 * host now. Nothing here reads a value: a local check asks whether a variable is set or a
 * file is readable and non-empty, and an SSH check runs one quiet predicate on that host.
 * Present is not valid or deliverable: the value may still be wrong, not UTF-8 text, or
 * refused by the use decision. There is no fallback to any other host.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { OrcaError, secretSource, type SecretsConfig } from "@orca/core";
import { secretHostBinding, secretSourceBinding, type AgentHost } from "@orca/agents";
import type { SecretReferenceView, SecretsCheckResult, SecretsListResult } from "@orca/protocol";
import { holds, type Principal } from "./auth/principal.js";

/** The live catalog and its hosts: the current configuration generation's registry. */
export interface SecretsSource {
  secrets(): SecretsConfig;
  hasHost(id: string): boolean;
  host(id: string): AgentHost;
}

const CHECK_TIMEOUT_MS = 15_000;
/**
 * Remote checks in flight at once, across every caller. Each is one SSH process; a check
 * past this is answered `busy` without starting one.
 */
export const MAX_REMOTE_CHECKS = 4;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class SecretsReadModel {
  private remoteChecks = 0;
  constructor(
    private readonly source: () => SecretsSource,
    private readonly maxRemoteChecks = MAX_REMOTE_CHECKS,
  ) {}

  /** Whether `principal` may see reference `id` now: `secrets.read`, and a grant naming it as bound now. */
  sees(principal: Principal, id: string): boolean {
    return holds(principal, "secrets.read") && this.visible(principal).some(([candidate]) => candidate === id);
  }

  /** The references `principal` may see: all with `*`, else those its grant names as bound now. */
  private visible(principal: Principal): [string, SecretsConfig[string]][] {
    const registry = this.source();
    const grant = principal.secrets;
    return Object.entries(registry.secrets()).filter(([id, ref]) => {
      if (grant === "*") return true;
      if (!grant || !registry.hasHost(ref.host)) return false;
      const binding = secretHostBinding(registry.host(ref.host).spec);
      return grant.some(
        (g) =>
          g.secret === id &&
          g.provider === ref.provider &&
          g.host === ref.host &&
          g.binding === binding &&
          // A judge grant (#701) shows its secret only while it is pinned to the granted
          // destination and read from the granted source.
          g.destination === ref.destination &&
          g.source === (ref.destination !== undefined ? secretSourceBinding(secretSource(ref)) : undefined),
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
    // One command on the bound host, and metadata only even there: an env check asks a child
    // shell (which sees exported variables only, as delivery does) whether `${NAME:+x}` is
    // non-empty, so the value is never expanded, printed or piped anywhere; a file check
    // only tests it. Tracing and stderr go off first, and if either cannot, the probe stops
    // with its own status and the reference is reported unavailable.
    const test =
      ref.provider === "env"
        ? `sh -c ${shellQuote(`[ -n "\${${ref.name}:+x}" ]`)}`
        : `test -f ${shellQuote(ref.path)} && test -r ${shellQuote(ref.path)} && test -s ${shellQuote(ref.path)}`;
    // Only the exit status is wanted, so only a host that can give it alone is asked: its
    // output is never read or buffered. One with no such path is not probed at all.
    if (!host.execStatus) return result(false, "unreachable");
    if (this.remoteChecks >= this.maxRemoteChecks) return result(false, "busy");
    this.remoteChecks++;
    try {
      const code = await host.execStatus(
        `{ set +xv && exec 2>/dev/null; } || exit 4; if ${test}; then exit 0; else exit 3; fi`,
        { timeoutMs: CHECK_TIMEOUT_MS },
      );
      if (code === 0) return result(true);
      if (code === 3) return result(false, "missing");
      return result(false, "unreachable");
    } catch {
      return result(false, "unreachable");
    } finally {
      this.remoteChecks--;
    }
  }
}
