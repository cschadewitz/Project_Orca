/**
 * Authentication at the transport: who is on the other end of this HTTP request or socket
 * upgrade, decided before any body is read, any method is looked up or any notification is
 * sent.
 *
 * Two modes, both explicit - a daemon given neither does not start (`startDaemon`):
 *
 * - `token`: every `/rpc` request and every `/socket` upgrade carries a bearer credential
 *   (credentials.ts). In an `Authorization: Bearer` header, or - because a browser-style
 *   WebSocket client cannot set headers - as a `orca.bearer.<token>` subprotocol beside
 *   `orca.v1`. The daemon selects `orca.v1` and never echoes the bearer protocol back.
 * - `loopback-unauthenticated`: the pre-authentication daemon, kept for supervisors that have
 *   not migrated. Refused unless the daemon is bound to loopback, and every request is still
 *   held to the loopback, Host and Origin rules below. It speaks for `LOCAL_PRINCIPAL`.
 *
 * Whatever the mode:
 *
 * - **Credentials never travel in a URL.** A query string naming one is refused as
 *   `AUTH_INVALID`, and a URL is never logged.
 * - **Browsers are not local clients.** A request carrying an `Origin` not in `allowedOrigins`
 *   is refused, and on a loopback bind the `Host` must be a loopback name - which is what
 *   stops a web page from reaching the daemon by DNS rebinding.
 * - **Remote means a TLS-terminating proxy.** A non-loopback bind is refused at startup unless
 *   `trustedProxies` names the proxy in front of it; once it does, a request from any other
 *   peer is refused (no direct-backend bypass) and a proxied request must say it arrived over
 *   https. Forwarded headers are believed only from a trusted proxy and are only ever used for
 *   the audit log's client address and that https check - never for identity.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { ProtocolError } from "@orca/protocol";
import type { AuditSink } from "./audit.js";
import { CredentialStore, type CredentialCheck } from "./credentials.js";
import { authError, type AuthFailureCode } from "./errors.js";
import type { AdmissionSource, Authorizer, RequestMeta } from "./guard.js";
import type { OwnershipStore } from "./ownership.js";
import { LOCAL_PRINCIPAL, type Principal } from "./principal.js";
import type { ResourceResolver } from "./resources.js";

/** The subprotocol a socket client offers, and the daemon selects. */
export const SOCKET_PROTOCOL = "orca.v1";
/** The prefix of the subprotocol that carries a bearer token on a socket upgrade. */
export const SOCKET_BEARER_PREFIX = "orca.bearer.";
/**
 * The two as clients from before the rename to Orrery offer them: selected and read until 0.10.
 * A client that offers both names for one token is reading either kind of daemon, not two tokens.
 */
export const LEGACY_SOCKET_PROTOCOL = "orca.v1"; // rename-keep: pre-rename subprotocol
export const LEGACY_SOCKET_BEARER_PREFIX = "orca.bearer."; // rename-keep: pre-rename subprotocol

interface CommonAuthOptions {
  /** Browser origins allowed to call the daemon. Empty (the default): no browser may. */
  allowedOrigins?: readonly string[] | undefined;
  audit?: AuditSink | undefined;
}

export interface TokenAuthOptions extends CommonAuthOptions {
  mode: "token";
  credentials: CredentialStore;
  ownership: OwnershipStore;
  resolver: ResourceResolver;
  /** Where `runs.start` hears `run.created`; defaults to the daemon's engine feed. */
  admissions?: AdmissionSource | undefined;
  /** Peer addresses of TLS-terminating reverse proxies. Required for a non-loopback bind. */
  trustedProxies?: readonly string[] | undefined;
  /** How often an idle socket re-checks its credential. Default 5000 ms. */
  revalidateMs?: number | undefined;
}

export interface LoopbackAuthOptions extends CommonAuthOptions {
  mode: "loopback-unauthenticated";
}

export type DaemonAuthOptions = TokenAuthOptions | LoopbackAuthOptions;

export class DaemonSecurityError extends Error {
  override readonly name = "DaemonSecurityError";
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  return a === "::1" || a === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function normalizePeer(address: string | undefined): string | undefined {
  return address?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
}

/**
 * Refuse a deployment that would be unsafe before the port is ever opened. Called by
 * `startDaemon`; exported so a supervisor can check a configuration without starting one.
 */
export function validateDeployment(
  auth: DaemonAuthOptions | undefined,
  host: string,
): asserts auth is DaemonAuthOptions {
  if (!auth)
    throw new DaemonSecurityError(
      "no authentication policy: start the daemon with token authentication, or with the explicit loopback-unauthenticated compatibility mode on a loopback address",
    );
  for (const origin of auth.allowedOrigins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new DaemonSecurityError(`allowed origin '${origin}' is not an origin`);
    }
    if (parsed.origin !== origin) throw new DaemonSecurityError(`allowed origin '${origin}' is not an origin`);
  }
  const loopback = isLoopbackAddress(host);
  if (auth.mode === "loopback-unauthenticated") {
    if (!loopback)
      throw new DaemonSecurityError(
        `the unauthenticated compatibility mode is loopback-only, and '${host}' is not a loopback address`,
      );
    return;
  }
  if (auth.mode !== "token") throw new DaemonSecurityError("unknown authentication mode");
  if (!(auth.credentials instanceof CredentialStore) || !auth.ownership || !auth.resolver)
    throw new DaemonSecurityError("token authentication needs a credential store, an ownership store and a resolver");
  for (const proxy of auth.trustedProxies ?? [])
    if (!isIP(proxy)) throw new DaemonSecurityError(`trusted proxy '${proxy}' is not an IP address`);
  if (!loopback && !(auth.trustedProxies ?? []).length)
    throw new DaemonSecurityError(
      `'${host}' is not a loopback address: a remote daemon must sit behind a TLS-terminating proxy named in trustedProxies`,
    );
}

export type Admission =
  | { ok: true; principal: Principal; credentialId?: string | undefined; meta: RequestMeta }
  | { ok: false; status: 400 | 401 | 403; error: ProtocolError; meta: RequestMeta };

const URL_CREDENTIAL_KEYS = ["token", "access_token", "auth", "authorization", "bearer", "credential", "key"];

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

export class TransportGate {
  private readonly trusted: ReadonlySet<string>;
  private readonly origins: ReadonlySet<string>;
  private readonly loopbackBind: boolean;

  constructor(
    private readonly auth: DaemonAuthOptions,
    host: string,
    private readonly authorizer: Authorizer,
  ) {
    validateDeployment(auth, host);
    this.trusted = new Set(auth.mode === "token" ? (auth.trustedProxies ?? []) : []);
    this.origins = new Set(auth.allowedOrigins ?? []);
    this.loopbackBind = isLoopbackAddress(host);
  }

  get revalidateMs(): number {
    return this.auth.mode === "token" ? (this.auth.revalidateMs ?? 5000) : 5000;
  }

  /** Decide who this request is, or why it is refused. Reads headers only - never the body. */
  admit(req: IncomingMessage, transport: RequestMeta["transport"]): Admission {
    const peer = normalizePeer(req.socket.remoteAddress);
    const viaProxy = peer !== undefined && this.trusted.has(peer);
    const meta: RequestMeta = { transport, remote: peer };
    const refuse = (status: 400 | 401 | 403, code: AuthFailureCode, reason: string, credentialId?: string) => {
      this.authorizer.denyAuthentication(meta, code, reason, credentialId);
      return { ok: false as const, status, error: authError(code), meta };
    };

    if (this.trusted.size && !viaProxy) return refuse(403, "AUTH_FORBIDDEN", "direct-backend-bypass");
    if (viaProxy) {
      const proto = (header(req, "x-forwarded-proto") ?? "").split(",").pop()?.trim().toLowerCase();
      if (proto !== "https") return refuse(403, "AUTH_FORBIDDEN", "proxy-not-https");
      const forwardedFor = (header(req, "x-forwarded-for") ?? "").split(",").pop()?.trim();
      if (forwardedFor && isIP(forwardedFor)) meta.remote = forwardedFor;
    } else if (this.auth.mode === "loopback-unauthenticated" && !isLoopbackAddress(peer)) {
      return refuse(403, "AUTH_FORBIDDEN", "peer-not-loopback");
    }

    if (this.loopbackBind && !viaProxy) {
      let hostname: string;
      try {
        hostname = new URL(`http://${header(req, "host") ?? ""}`).hostname;
      } catch {
        return refuse(403, "AUTH_FORBIDDEN", "host-unparseable");
      }
      if (!isLoopbackAddress(hostname)) return refuse(403, "AUTH_FORBIDDEN", "host-not-loopback");
    }

    const origin = header(req, "origin");
    if (origin !== undefined && !this.origins.has(origin)) return refuse(403, "AUTH_FORBIDDEN", "origin-not-allowed");

    const query = new URL(req.url ?? "/", "http://daemon").searchParams;
    for (const key of query.keys())
      if (URL_CREDENTIAL_KEYS.includes(key.toLowerCase())) return refuse(401, "AUTH_INVALID", "credential-in-url");

    if (this.auth.mode === "loopback-unauthenticated") return { ok: true, principal: LOCAL_PRINCIPAL, meta };

    const presented = this.credentialOf(req, transport);
    if (presented === "malformed") return refuse(401, "AUTH_INVALID", "malformed");
    if (presented === undefined) return refuse(401, "AUTH_REQUIRED", "missing");
    const check = this.auth.credentials.authenticate(presented);
    if (!check.ok) return refuse(401, "AUTH_INVALID", check.reason, check.credentialId);
    return { ok: true, principal: check.principal, credentialId: check.principal.credentialId, meta };
  }

  /** Re-check a connection's credential; the loopback mode has none to lapse. */
  current(credentialId: string | undefined): CredentialCheck {
    if (this.auth.mode !== "token" || credentialId === undefined) return { ok: true, principal: LOCAL_PRINCIPAL };
    return this.auth.credentials.current(credentialId);
  }

  private credentialOf(req: IncomingMessage, transport: RequestMeta["transport"]): string | "malformed" | undefined {
    const found: string[] = [];
    const authorization = header(req, "authorization");
    if (authorization !== undefined) {
      const m = /^Bearer ([^\s,]+)$/.exec(authorization.trim());
      if (!m) return "malformed";
      found.push(m[1]!);
    }
    if (transport === "socket") {
      const offered = new Set<string>();
      for (const protocol of (header(req, "sec-websocket-protocol") ?? "").split(",")) {
        const p = protocol.trim();
        if (p.startsWith(SOCKET_BEARER_PREFIX)) offered.add(p.slice(SOCKET_BEARER_PREFIX.length));
        else if (p.startsWith(LEGACY_SOCKET_BEARER_PREFIX)) offered.add(p.slice(LEGACY_SOCKET_BEARER_PREFIX.length));
      }
      found.push(...offered);
    }
    if (found.length > 1) return "malformed";
    return found[0];
  }
}
