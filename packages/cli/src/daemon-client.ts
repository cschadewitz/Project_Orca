/** The CLI's existing daemon reads and ping use the same local-token contract as the desktop app. */
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import { isLoopbackAddress, LOCAL_TOKEN_FILE, parseToken, readLocalToken } from "@orca/daemon";
import { ProtocolFault, ResponseMessageSchema } from "@orca/protocol";
import { loadConfig } from "./bootstrap.js";
import type { CommandContext } from "./commands/index.js";

/** A responding server's redirect is a refusal, never an offline-daemon fallback signal. */
export class DaemonRedirectError extends OrcaError {
  constructor(status: number) {
    // Do not include Location: it may contain a login token or point to an unrelated host.
    super("NOT_SUPPORTED", "daemon redirected the RPC request; refusing to follow it or run locally", { status });
  }
}

/** Resolve configuration without bootstrapping an engine or changing auth state. */
export async function localTokenFile(ctx: Pick<CommandContext, "cwd" | "configPath">): Promise<string> {
  if (process.env.ORCA_DAEMON_TOKEN_FILE) return resolve(process.env.ORCA_DAEMON_TOKEN_FILE);
  const { configDir } = await loadConfig(ctx.cwd, ctx.configPath);
  return resolve(configDir, "auth", LOCAL_TOKEN_FILE);
}

/** Credentials must never travel in URLs or follow a redirect to another server. */
function endpoint(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OrcaError("CONFIG_INVALID", "the daemon address must be an HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new OrcaError(
      "CONFIG_INVALID",
      "the daemon address must be an HTTP(S) URL without credentials, query or fragment",
    );
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/rpc`;
  return parsed;
}

/** No automatically discovered workspace token is sent to a remote address. */
async function tokenFor(ctx: Pick<CommandContext, "cwd" | "configPath">, url: URL): Promise<string | undefined> {
  const configured = process.env.ORCA_DAEMON_TOKEN;
  if (configured !== undefined) {
    if (!parseToken(configured)) throw new ProtocolFault("AUTH_INVALID", "ORCA_DAEMON_TOKEN is not a valid token");
    return configured;
  }
  if (process.env.ORCA_DAEMON_TOKEN_FILE) {
    const token = readLocalToken(await localTokenFile(ctx));
    if (!token) throw new ProtocolFault("AUTH_INVALID", "ORCA_DAEMON_TOKEN_FILE does not contain a readable token");
    return token;
  }
  return isLoopbackAddress(url.hostname) ? readLocalToken(await localTokenFile(ctx)) : undefined;
}

export function isAuthenticationFailure(error: unknown): error is ProtocolFault {
  return error instanceof ProtocolFault && ["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN"].includes(error.code);
}

/**
 * A daemon response, or undefined when no compatible daemon answers. Authentication denials
 * always propagate: they must never turn a refused daemon operation into an in-process one.
 * Re-read a local token once on AUTH_INVALID to recover from a daemon's startup rotation.
 */
export async function daemonCall(
  ctx: Pick<CommandContext, "cwd" | "configPath">,
  url: string,
  method: string,
  params: unknown,
): Promise<unknown | undefined> {
  const target = endpoint(url);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await tokenFor(ctx, target);
    if (token && target.protocol !== "https:" && !isLoopbackAddress(target.hostname))
      throw new OrcaError("CONFIG_INVALID", "a remote daemon requires HTTPS before a bearer token can be sent");
    let response: Response;
    try {
      response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
        signal: AbortSignal.timeout(2000),
        redirect: "manual",
      });
    } catch {
      return undefined;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new DaemonRedirectError(response.status);
    }
    const parsed = ResponseMessageSchema.safeParse(await response.json().catch(() => undefined));
    if (parsed.success && !parsed.data.ok) {
      const { code, message } = parsed.data.error;
      if (code === "AUTH_INVALID" && attempt === 0 && process.env.ORCA_DAEMON_TOKEN === undefined) continue;
      if (code === "AUTH_INVALID" || code === "AUTH_REQUIRED" || code === "AUTH_FORBIDDEN")
        throw new ProtocolFault(code, message);
      throw new OrcaError("NOT_SUPPORTED", `daemon refused '${method}': ${message}`, { code, method });
    }
    // A proxy may refuse before it can produce an ORCA envelope. That is still a refusal,
    // never permission to bypass the daemon by spawning an agent in this CLI process.
    if (response.status === 401) throw new ProtocolFault("AUTH_INVALID", "daemon authentication failed");
    if (response.status === 403) throw new ProtocolFault("AUTH_FORBIDDEN", "daemon access denied");
    if (!response.ok || !parsed.success) return undefined;
    return parsed.data.ok ? parsed.data.result : undefined;
  }
  return undefined;
}
