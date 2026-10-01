/**
 * Main-process credentials shared by HTTP and WebSocket clients. A token is never put in a
 * URL or exposed through the renderer bridge. Automatic discovery is loopback-only; remote
 * connections require an explicitly supplied token/file and TLS.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DaemonTokenSource {
  read(): string | undefined;
  /** Re-read a local file once after refusal. Explicit environment tokens do not rotate. */
  refresh(): boolean;
}

export function isLoopbackDaemon(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Config-directory discovery only: parsing configuration or reading stores is the daemon's. */
export function localDaemonTokenFile(workspace: string): string {
  let dir = resolve(workspace);
  for (;;) {
    for (const name of ["orca.config.yaml", "orca.config.yml", "orca.config.json"]) {
      try {
        if (statSync(join(dir, name)).isFile()) return join(dir, "auth", "local-client.token");
      } catch {
        // No configuration at this level; the CLI uses the same upward search.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return join(resolve(workspace), "auth", "local-client.token");
    dir = parent;
  }
}

/** Refuse credentials in URLs, redirects (at the caller), and plaintext remote transport. */
export function assertCredentialDestination(url: string, token: string | undefined): void {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Daemon URLs must not contain credentials, query parameters or fragments");
  }
  if (token && !isLoopbackDaemon(url) && parsed.protocol !== "https:" && parsed.protocol !== "wss:") {
    throw new Error("Authenticated remote daemon connections require HTTPS");
  }
}

export class LocalDaemonToken implements DaemonTokenSource {
  private loaded = false;
  private token: string | undefined;
  private readonly explicit: string | undefined;
  private readonly file: string | undefined;

  constructor(options: { url: string; workspace?: string; tokenFile?: string; env?: NodeJS.ProcessEnv }) {
    const env = options.env ?? process.env;
    this.explicit = env.ORCA_DAEMON_TOKEN;
    this.file =
      options.tokenFile ??
      env.ORCA_DAEMON_TOKEN_FILE ??
      (options.workspace && isLoopbackDaemon(options.url) ? localDaemonTokenFile(options.workspace) : undefined);
  }

  read(): string | undefined {
    if (this.loaded) return this.token;
    const text = this.explicit ?? this.readFile();
    const token = text?.trim();
    // Header/subprotocol-safe, without echoing malformed secret material in any error.
    if (token && !/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error("Invalid daemon credential");
    this.token = token || undefined;
    this.loaded = this.token !== undefined;
    return this.token;
  }

  refresh(): boolean {
    if (this.explicit !== undefined || this.file === undefined) return false;
    this.loaded = false;
    this.read();
    return true;
  }

  private readFile(): string | undefined {
    if (!this.file) return undefined;
    try {
      return readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read daemon credential file", { cause: error });
    }
  }
}

export function authenticationCode(error: unknown): "AUTH_REQUIRED" | "AUTH_INVALID" | "AUTH_FORBIDDEN" | undefined {
  if (typeof error !== "object" || error === null || !("error" in error)) return undefined;
  const detail = error.error;
  if (typeof detail !== "object" || detail === null || !("code" in detail)) return undefined;
  return detail.code === "AUTH_REQUIRED" || detail.code === "AUTH_INVALID" || detail.code === "AUTH_FORBIDDEN"
    ? detail.code
    : undefined;
}
