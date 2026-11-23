/**
 * Secret references (#336): an environment value that names a credential instead of holding it.
 *
 * `secrets:` in `orca.config.yaml` says where each credential lives, on which host:
 *
 *   secrets:
 *     github-token: { host: local, provider: env, name: GITHUB_TOKEN }
 *     db-password:  { host: build-box, provider: file, path: /etc/orca/db-password }
 *
 * and an agent's `env`, or an MCP server's `env`, refers to one by id:
 *
 *   env: { GITHUB_TOKEN: { secret: github-token } }
 *
 * The value is read on the bound host immediately before the process that needs it starts,
 * and is never written to config, drafts, provenance, events or logs. A reference bound to
 * another host than the one the session runs on is refused, with no fallback to a value
 * found anywhere else. This module is the node-free half: schemas and static checks.
 */
import { z } from "zod";

const SecretIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "secret ids use letters, digits, '.', '_' and '-'");

export const SecretRefSchema = z.object({ secret: SecretIdSchema }).strict();
export type SecretRef = z.infer<typeof SecretRefSchema>;

/** An environment value: a literal (legacy, stored in config as written) or a reference. */
export const EnvValueSchema = z.union([z.string(), SecretRefSchema]);
export type EnvValue = z.infer<typeof EnvValueSchema>;
export const EnvSchema = z.record(z.string(), EnvValueSchema);
export type Env = z.infer<typeof EnvSchema>;

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "object" && value !== null && typeof (value as SecretRef).secret === "string";
}

const envSource = {
  provider: z.literal("env"),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name"),
};
const fileSource = {
  provider: z.literal("file"),
  path: z.string().refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), "must be an absolute path"),
};
const binding = {
  /** The one host this secret is read on. A session on any other host cannot use it. */
  host: z.string().min(1),
  description: z.string().optional(),
  /**
   * Pins the value to one network destination that ORCA itself sends it to (#701: a review
   * judge's bring-your-own-key). A pinned secret is never delivered to an agent or MCP server
   * process, and an unpinned one is never sent to a judge: neither use falls back to the other.
   * Only `provider: env` may be pinned for now.
   */
  destination: z.string().min(1).optional(),
};

/** Where a secret's value is read, on its host. Only metadata: never the value. */
export const SecretSourceSchema = z.discriminatedUnion("provider", [
  /** A variable in the environment of the host: the daemon's own on a local host, the login shell's over SSH. */
  z.object(envSource).strict(),
  /** A file on the host, read whole; one trailing newline is dropped. The path must be absolute. */
  z.object(fileSource).strict(),
]);
export type SecretSource = z.infer<typeof SecretSourceSchema>;

export const SecretDefinitionSchema = z.discriminatedUnion("provider", [
  z.object({ ...binding, ...envSource }).strict(),
  z.object({ ...binding, ...fileSource }).strict(),
]);
export type SecretDefinition = z.infer<typeof SecretDefinitionSchema>;

/** The source half of a definition, which is all a host needs to read it. */
export function secretSource(def: SecretDefinition): SecretSource {
  return def.provider === "env" ? { provider: "env", name: def.name } : { provider: "file", path: def.path };
}

export const SecretsConfigSchema = z.record(SecretIdSchema, SecretDefinitionSchema);
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

/**
 * Which environment and filesystem a host reads from. Every local host is the daemon's own
 * machine, so all local host ids are one realm; each other host is its own. Given no host
 * types, every host is assumed to share one realm: more sources then count as the same, never
 * fewer.
 */
export type SecretRealm = (hostId: string) => string;
export const ONE_REALM: SecretRealm = () => "*";
export function hostRealms(hosts: readonly { id: string; type?: string }[]): SecretRealm {
  const local = new Set(hosts.filter((h) => h.type === "local").map((h) => h.id));
  const known = new Set(hosts.filter((h) => h.type !== undefined).map((h) => h.id));
  return (hostId) => (local.has(hostId) || !known.has(hostId) ? "local" : `host:${hostId}`);
}

/**
 * What identifies where a value is read: the realm, the provider and the variable or path.
 * Compared case-insensitively and with the path's `.`/`..` segments and repeated separators
 * folded, so more definitions count as the same source rather than fewer.
 */
export function secretSourceKey(def: SecretDefinition, realm: SecretRealm = ONE_REALM): string {
  const where =
    def.provider === "env"
      ? def.name
      : def.path
          .replace(/\\/g, "/")
          .split("/")
          .reduce<string[]>((parts, part, i) => {
            if (part === "" && i > 0) return parts;
            if (part === ".") return parts;
            if (part === "..") return parts.length > 1 ? parts.slice(0, -1) : parts;
            return [...parts, part];
          }, [])
          .join("/");
  return JSON.stringify([realm(def.host), def.provider, where.toLowerCase()]);
}

/**
 * True when secret `id` is read from the same source, in the same realm, as a secret pinned to
 * a destination (#701) other than its own pin, or when it is unpinned and any secret from its
 * source is pinned. A pin then cannot be side-stepped by declaring the same variable twice,
 * under another id or another local host id.
 */
export function sharesPinnedSource(
  secrets: SecretsConfig | undefined,
  id: string,
  realm: SecretRealm = ONE_REALM,
): boolean {
  const catalog = secrets ?? {};
  const def = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
  if (def === undefined) return false;
  const key = secretSourceKey(def, realm);
  return Object.entries(catalog).some(
    ([other, d]) =>
      other !== id &&
      secretSourceKey(d, realm) === key &&
      (d.destination !== undefined || def.destination !== undefined) &&
      d.destination !== def.destination,
  );
}

/** The variable names of every pinned secret: withheld from every agent on the daemon's machine. */
export function pinnedEnvNames(secrets: SecretsConfig | undefined): string[] {
  return Object.values(secrets ?? {}).flatMap((d) =>
    d.destination !== undefined && d.provider === "env" ? [d.name] : [],
  );
}

/** Every reference in an env map, with the variable it fills. */
export function secretRefs(env: Env): { name: string; ref: SecretRef }[] {
  return Object.entries(env).flatMap(([name, value]) => (isSecretRef(value) ? [{ name, ref: value }] : []));
}

/** The literal half of an env map. */
export function literalEnv(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export interface SecretIssue {
  path: string;
  message: string;
}

/**
 * Static checks: every reference names a configured secret, every secret is bound to a
 * configured host, and an agent only refers to secrets bound to the host it runs on.
 */
export function validateSecretReferences(config: {
  secrets?: SecretsConfig | undefined;
  hosts: { id: string; type?: string }[];
  agents: { id: string; hostId: string; env: Env; mcpServers: { name: string; env: Env }[] }[];
  capabilities?: { mcpServers: Record<string, { env: Env }> } | undefined;
}): SecretIssue[] {
  const issues: SecretIssue[] = [];
  const secrets = config.secrets ?? {};
  const hosts = new Set(config.hosts.map((h) => h.id));
  const realm = hostRealms(config.hosts);
  for (const [id, def] of Object.entries(secrets))
    if (def.destination !== undefined && realm(def.host) !== "local")
      issues.push({
        path: `secrets.${id}.host`,
        message: `secret '${id}' is pinned to a destination, so it must be bound to a local host: ORCA's own connection reads it on the daemon's machine`,
      });
  for (const [id, def] of Object.entries(secrets))
    if (def.destination !== undefined && def.provider !== "env")
      issues.push({
        path: `secrets.${id}.provider`,
        message: `secret '${id}' is pinned to a destination, which needs provider 'env': a file path cannot yet be bound to the file a read opens`,
      });
  for (const id of Object.keys(secrets))
    if (sharesPinnedSource(secrets, id, realm))
      issues.push({
        path: `secrets.${id}`,
        message: `secret '${id}' is read from the same source as a secret pinned to another destination. A pinned value has one id and one destination`,
      });
  for (const [id, def] of Object.entries(secrets))
    if (!hosts.has(def.host))
      issues.push({
        path: `secrets.${id}.host`,
        message: `secret '${id}' is bound to host '${def.host}', which is not configured`,
      });
  const check = (env: Env, path: string, hostId: string | undefined) => {
    for (const { name, ref } of secretRefs(env)) {
      const def = secrets[ref.secret];
      if (!def) issues.push({ path: `${path}.${name}`, message: `no secret '${ref.secret}' is defined in secrets` });
      else if (def.destination !== undefined)
        issues.push({
          path: `${path}.${name}`,
          message: `secret '${ref.secret}' is pinned to destination '${def.destination}', which only ORCA's own connection to it may use. An agent or MCP server cannot refer to it`,
        });
      else if (hostId !== undefined && def.host !== hostId)
        issues.push({
          path: `${path}.${name}`,
          message: `secret '${ref.secret}' is bound to host '${def.host}', but this agent runs on '${hostId}'. A secret is only ever read on its own host`,
        });
    }
  };
  config.agents.forEach((agent, i) => {
    check(agent.env, `agents[${i}].env`, agent.hostId);
    agent.mcpServers.forEach((server, j) => check(server.env, `agents[${i}].mcpServers[${j}].env`, agent.hostId));
  });
  // A catalog server runs wherever the agent given it runs; the host check happens then.
  for (const [id, server] of Object.entries(config.capabilities?.mcpServers ?? {}))
    check(server.env, `capabilities.mcpServers.${id}.env`, undefined);
  return issues;
}

/**
 * Replace every occurrence of a resolved secret value in strings, object keys included, with
 * `[REDACTED]`. Defense in depth for values ORCA itself read: it does not catch encodings,
 * transformations or fragments of a value.
 */
/**
 * A value and the encodings a transport may carry it in: base64 (an SSH host reports what it
 * read that way), unpadded, and base64url. Redacting only the raw value would let an encoded
 * copy through a diagnostic.
 */
function encodedForms(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const bare = b64.replace(/=+$/, "");
  return [value, b64, bare, bare.replace(/\+/g, "-").replace(/\//g, "_")].filter((v) => v.length > 0);
}

export function redactSecretValues<T>(value: T, secrets: readonly string[]): T {
  const needles = [...new Set(secrets.filter((s) => s.length > 0).flatMap(encodedForms))].sort(
    (a, b) => b.length - a.length,
  );
  if (!needles.length) return value;
  const text = (input: string) => needles.reduce((out, needle) => out.split(needle).join("[REDACTED]"), input);
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype)
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [text(k), visit(v)]));
    return input;
  };
  return visit(value) as T;
}
