/**
 * The capability set each agent gets at its own scope (#335), for `config.get` (the active
 * configuration) and a `config.set` validation (a candidate), so the app can preview what an
 * edit changes before it is saved and applied. Static: no skill content is read and no host
 * is contacted. Only identities and sources leave here, never a definition.
 */
import { OrcaConfigSchema, resolveCapabilities } from "@orca/core";
import type { ConfigEffectiveCapabilities } from "@orca/protocol";

/** `undefined` when the value is not a valid configuration: there is no set to report. */
export function effectiveCapabilities(raw: unknown): ConfigEffectiveCapabilities | undefined {
  const parsed = OrcaConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) return undefined;
  const agents: ConfigEffectiveCapabilities["agents"] = {};
  for (const agent of parsed.data.agents) {
    const { manifest, errors, warnings } = resolveCapabilities({ catalog: parsed.data.capabilities, agent });
    Object.defineProperty(agents, agent.id, {
      enumerable: true,
      value: {
        mcpServers: manifest.mcpServers.map(({ id, source, catalog }) => ({ id, source, catalog })),
        skills: manifest.skills.map(({ id, source, version, digest }) => ({
          id,
          source,
          ...(version === undefined ? {} : { version }),
          ...(digest === undefined ? {} : { digest }),
        })),
        errors,
        warnings,
      },
    });
  }
  return { agents };
}
