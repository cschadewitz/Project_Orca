/**
 * Unsafe deployments fail closed: no policy, the unauthenticated mode off loopback, a remote
 * bind with no TLS-terminating proxy. Behind a proxy, only that proxy may connect, it must say
 * the request was https, and forwarded headers from anyone else are ignored.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "@orca/daemon";
import {
  CredentialStore,
  DaemonSecurityError,
  MemoryAuditSink,
  OwnershipStore,
  validateDeployment,
  type ResourceResolver,
  type TokenAuthOptions,
} from "../src/auth/index.js";

const resolver: ResourceResolver = {
  run: async () => undefined,
  inputRun: async () => undefined,
  artifactRun: async () => undefined,
  claimRun: async () => undefined,
  workflowExists: () => false,
};
const token = (extra: Partial<TokenAuthOptions> = {}): TokenAuthOptions => ({
  mode: "token",
  credentials: new CredentialStore(),
  ownership: new OwnershipStore(),
  resolver,
  ...extra,
});

describe("validateDeployment", () => {
  it("refuses to start without a policy", async () => {
    expect(() => validateDeployment(undefined, "127.0.0.1")).toThrow(DaemonSecurityError);
    await expect(startDaemon({ orcaVersion: "0", capabilities: [] })).rejects.toThrow(DaemonSecurityError);
  });

  it("keeps the unauthenticated mode on loopback", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"])
      expect(() => validateDeployment({ mode: "loopback-unauthenticated" }, host)).not.toThrow();
    for (const host of ["0.0.0.0", "::", "192.168.1.10"])
      expect(() => validateDeployment({ mode: "loopback-unauthenticated" }, host)).toThrow(/loopback-only/);
  });

  it("needs a TLS-terminating proxy for a remote bind, and well-formed settings", () => {
    expect(() => validateDeployment(token(), "0.0.0.0")).toThrow(/trustedProxies/);
    expect(() => validateDeployment(token({ trustedProxies: ["10.0.0.5"] }), "0.0.0.0")).not.toThrow();
    expect(() => validateDeployment(token({ trustedProxies: ["proxy.internal"] }), "0.0.0.0")).toThrow(/IP/);
    expect(() => validateDeployment(token({ allowedOrigins: ["https://ok.example/path"] }), "127.0.0.1")).toThrow(
      /origin/,
    );
    expect(() => validateDeployment(token({ allowedOrigins: ["https://ok.example"] }), "127.0.0.1")).not.toThrow();
  });
});

describe("behind a trusted proxy", () => {
  let daemon: DaemonHandle | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  const hello = (headers: Record<string, string>) =>
    fetch(`${daemon!.url}/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "request",
        id: 1,
        method: "hello",
        params: { client: "t", protocol: { major: 1, minor: 0 } },
      }),
    });

  it("refuses a request that bypasses the proxy", async () => {
    const credentials = new CredentialStore();
    const { token: t } = credentials.issue({ principal: "o", preset: "owner" });
    daemon = await startDaemon({
      orcaVersion: "0",
      capabilities: [],
      auth: token({ credentials, trustedProxies: ["10.9.9.9"] }),
    });
    const res = await hello({ authorization: `Bearer ${t}`, "x-forwarded-proto": "https" });
    expect(res.status).toBe(403);
  });

  it("requires https from the proxy, and records the client it forwarded", async () => {
    const credentials = new CredentialStore();
    const audit = new MemoryAuditSink();
    const { token: t } = credentials.issue({ principal: "o", preset: "owner" });
    daemon = await startDaemon({
      orcaVersion: "0",
      capabilities: [],
      auth: token({ credentials, audit, trustedProxies: ["127.0.0.1"] }),
    });
    expect((await hello({ authorization: `Bearer ${t}` })).status).toBe(403);
    expect((await hello({ authorization: `Bearer ${t}`, "x-forwarded-proto": "http" })).status).toBe(403);
    const ok = await hello({ authorization: `Bearer ${t}`, "x-forwarded-proto": "https" });
    expect(ok.status).toBe(200);
    await hello({ "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.1, 203.0.113.9" });
    expect(audit.records.at(-1)).toMatchObject({ reason: "missing", remote: "203.0.113.9" });
  });

  it("ignores forwarded headers from a peer that is not a trusted proxy", async () => {
    const audit = new MemoryAuditSink();
    daemon = await startDaemon({ orcaVersion: "0", capabilities: [], auth: token({ audit }) });
    await hello({ "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" });
    expect(audit.records.at(-1)).toMatchObject({ reason: "missing", remote: "127.0.0.1" });
  });
});
