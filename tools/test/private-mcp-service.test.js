/** Synthetic policy, launcher, and unit-template checks for private MCP supervision. */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_PERMISSIONS,
  SCOPED_PERMISSIONS,
  readPrivateFile,
  validateCredential,
  validateDiscovery,
  validateProfile,
} from "../deploy/private-mcp-service/credential-policy.js";
import { childEnvironment, launch } from "../deploy/private-mcp-service/launch-mcp.js";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const credentialId = "AbCdEfGhIjKl";
const secret = "A".repeat(43);
const token = `orca1.${credentialId}.${secret}`;
const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
const scope = { workflows: ["approved-root"], runs: "all" };
function profile() {
  return {
    version: 1,
    review: { approvedBy: "reviewer", approvedAt: "2026-10-01T00:00:00.000Z", reference: "approval-123" },
    policy: "scoped-six",
    principal: "cal-operator",
    credentialId,
    permissions: [...SCOPED_PERMISSIONS],
    scope: structuredClone(scope),
    endpoint: "http://127.0.0.1:33871/rpc",
    target: structuredClone(target),
    runtime: {
      node: "/opt/node/bin/node",
      cliEntry: "/opt/orca/packages/cli/dist/main.js",
      workspaceDir: "/opt/workspace",
      orcaVersion: "0.6.0",
      commit: "3702da5b38dc449280c2837366615de741e9c45c",
    },
    childEnvironment: { HTTPS_PROXY: "http://proxy.example:8080", NODE_EXTRA_CA_CERTS: "/opt/ca.pem" },
  };
}
function record(p = profile()) {
  return {
    id: credentialId,
    principal: p.principal,
    permissions: p.permissions,
    scope: p.scope,
    secretSha256: createHash("sha256").update(secret).digest("hex"),
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}
function store(row) {
  return JSON.stringify({ version: 1, credentials: [row] });
}
function discovery(p = profile()) {
  return {
    authentication: "credential",
    principalId: p.principal,
    orcaVersion: "0.6.0",
    target: p.target,
    scope: { ...p.scope, permissions: p.permissions },
  };
}
function files(p = profile(), row = record(p)) {
  const dir = mkdtempSync(join(tmpdir(), "orca-service-"));
  dirs.push(dir);
  const paths = { profile: join(dir, "profile.json"), token: join(dir, "token"), store: join(dir, "credentials.json") };
  for (const [path, contents] of [
    [paths.profile, JSON.stringify(p)],
    [paths.token, `${token}\n`],
    [paths.store, store(row)],
  ])
    writeFileSync(path, contents, { mode: 0o600 });
  return paths;
}

describe("reviewed credential policy", () => {
  it("accepts exactly the reviewed scoped grant and matching finite credential", () => {
    const p = validateProfile(profile());
    expect(validateCredential(p, `${token}\n`, store(record(p)))).toBe(token);
    expect(validateDiscovery(p, discovery(p))).toBeTruthy();
  });
  it("requires explicit review, fixed endpoint and workspace identity", () => {
    for (const change of [
      (p) => {
        delete p.review;
      },
      (p) => {
        p.review.approvedAt = "2099-01-01T00:00:00.000Z";
      },
      (p) => {
        p.endpoint = "http://0.0.0.0:33871/rpc";
      },
      (p) => {
        p.target.instanceId = "unknown";
      },
      (p) => {
        p.principal = "owner";
      },
    ]) {
      const p = profile();
      change(p);
      expect(() => validateProfile(p)).toThrow();
    }
  });
  it("rejects broader grants and requires an explicit workspace-plan choice", () => {
    const p = profile();
    p.permissions.push("plan.read");
    expect(() => validateProfile(p)).toThrow();
    p.policy = "workspace-plan-eight";
    p.permissions = [...PLAN_PERMISSIONS];
    expect(() => validateProfile(p)).toThrow();
    p.scope = { workflows: "*", runs: "all" };
    expect(validateProfile(p)).toBe(p);
    expect(() => validateCredential(p, token, store({ ...record(p), permissions: SCOPED_PERMISSIONS }))).toThrow();
  });
  it("rejects bootstrap, revocation, wrong principal, grants, scope, token, and expiry", () => {
    const p = profile();
    for (const patch of [
      { bootstrap: true },
      { revokedAt: "2026-10-02T00:00:00.000Z" },
      { principal: "owner" },
      { permissions: [...p.permissions, "config.read"] },
      { scope: { workflows: "*", runs: "all" } },
      { expiresAt: "2020-01-01T00:00:00.000Z" },
    ])
      expect(() => validateCredential(p, token, store({ ...record(p), ...patch }))).toThrow();
    expect(() => validateCredential(p, `orca1.${credentialId}.${"B".repeat(43)}`, store(record(p)))).toThrow();
    expect(() => validateCredential(p, "owner-token", store(record(p)))).toThrow();
  });
  it("rejects a changed authenticated target or grant", () => {
    const p = profile();
    expect(() =>
      validateDiscovery(p, {
        ...discovery(p),
        target: { ...target, instanceId: "33333333-3333-4333-8333-333333333333" },
      }),
    ).toThrow();
    expect(() =>
      validateDiscovery(p, { ...discovery(p), scope: { ...scope, permissions: [...p.permissions, "plan.read"] } }),
    ).toThrow();
  });
  it("checks regular files, private mode, owner and symlink safety without exposing contents", () => {
    const paths = files();
    expect(readPrivateFile(paths.token)).toBe(`${token}\n`);
    chmodSync(paths.token, 0o644);
    expect(() => readPrivateFile(paths.token)).toThrow(/file-security/);
    chmodSync(paths.token, 0o600);
    const uid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
    expect(() => readPrivateFile(paths.token)).toThrow(/file-security/);
    uid.mockRestore();
    const link = join(resolve(paths.token, ".."), "link");
    symlinkSync(paths.token, link);
    expect(() => readPrivateFile(link)).toThrow(/file-security/);
    const hardlink = join(resolve(paths.token, ".."), "hardlink");
    linkSync(paths.token, hardlink);
    expect(() => readPrivateFile(paths.token)).toThrow(/file-security/);
    expect(() => readPrivateFile(join(resolve(paths.token, ".."), "absent"))).toThrow(/file-security/);
    expect(() => readPrivateFile(paths.profile, 4)).toThrow(/file-security/);
    for (const error of [() => readPrivateFile(link), () => validateCredential(profile(), "bad", store(record()))]) {
      try {
        error();
      } catch (caught) {
        expect(caught.message).not.toContain(secret);
        expect(caught.message).not.toContain(paths.token);
      }
    }
  });
});

describe("guarded launcher", () => {
  it("probes authenticated discovery before stdio and keeps control-plane secrets out of the child", async () => {
    const p = profile();
    const paths = files(p);
    const output = new PassThrough();
    let bytes = "";
    output.on("data", (chunk) => {
      bytes += chunk.toString();
    });
    const spawnMock = vi.fn((_binary, _args, options) => {
      expect(options.env).toEqual(childEnvironment(p, token));
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      expect(options.env.CONTROL_PLANE_API_KEY).toBeUndefined();
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn(() => {
        child.killed = true;
        child.emit("exit", null, "SIGTERM");
      });
      queueMicrotask(() => {
        child.stdout.end('{"jsonrpc":"2.0"}\n');
        child.stderr.end(`secret ${secret}\n`);
        child.emit("exit", 7, null);
      });
      return child;
    });
    const fetcher = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe(`Bearer ${token}`);
      return {
        ok: true,
        json: async () => ({ kind: "response", id: "service-preflight", ok: true, result: discovery(p) }),
      };
    });
    expect(await launch(paths, { fetcher, spawn: spawnMock, stdout: output })).toBe(7);
    expect(bytes).toBe('{"jsonrpc":"2.0"}\n');
    expect(spawnMock).toHaveBeenCalledOnce();
  });
  it("refuses failed discovery before spawn and forwards termination to child", async () => {
    const p = profile();
    const paths = files(p);
    const spawnMock = vi.fn();
    await expect(launch(paths, { fetcher: async () => ({ ok: false }), spawn: spawnMock })).rejects.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    });
    spawnMock.mockReturnValue(child);
    const running = launch(paths, {
      fetcher: async () => ({
        ok: true,
        json: async () => ({ kind: "response", id: "service-preflight", ok: true, result: discovery(p) }),
      }),
      spawn: spawnMock,
      stdout: new PassThrough(),
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    process.emit("SIGTERM");
    expect(await running).toBe(143);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("uses no ambient credentials even if they exist in the parent", () => {
    const env = childEnvironment(profile(), token);
    expect(Object.keys(env).sort()).toEqual(["HTTPS_PROXY", "LANG", "NODE_EXTRA_CA_CERTS", "ORCA_MCP_TOKEN"].sort());
  });
});

it("service templates pin one local daemon and one downstream tunnel with bounded restarts", () => {
  const base = "tools/deploy/private-mcp-service";
  const daemon = readFileSync(join(base, "orca-daemon.service.template"), "utf8");
  const tunnel = readFileSync(join(base, "orca-tunnel.service.template"), "utf8");
  const yaml = readFileSync(join(base, "tunnel-profile.yaml.template"), "utf8");
  for (const unit of [daemon, tunnel]) {
    expect(unit).toMatch(/Restart=on-failure/);
    expect(unit).toMatch(/StartLimitBurst=6/);
    expect(unit).toMatch(/TimeoutStopSec=30s/);
  }
  expect(daemon).toMatch(/serve --host 127\.0\.0\.1 --port 33871/);
  expect(tunnel).toMatch(/Requires=orca-daemon\.service/);
  expect(daemon).not.toMatch(/PartOf=orca-tunnel|Requires=orca-tunnel/);
  expect(yaml).toMatch(/api_key: file:/);
  expect(yaml).toMatch(/listen_addr: 127\.0\.0\.1:/);
  expect(yaml.match(/- channel: main/g)).toHaveLength(1);
  expect(yaml).not.toMatch(/server_urls:|harpoon:/);
});
