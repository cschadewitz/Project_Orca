/** The proposed telemetry grant and caller-scoped summary boundary, using exact #495 fixtures. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostResourceFixture,
  workstreamSummaryFixture,
  HOST_RESOURCE_LIMITS,
  PROTOCOL_VERSION,
  resourceWarnings,
} from "@orca/protocol";
import {
  HostResourceReadModel,
  methodsFor,
  type MethodContext,
  CredentialStore,
  PRESETS,
  LOCAL_PRINCIPAL,
  type Principal,
  type Permission,
  type HostResourceReadSource,
  type AuthorizedWorkstreamProjection,
} from "@orca/daemon";

const target = {
  workspaceId: "20000000-0000-4000-8000-000000000001",
  instanceId: hostResourceFixture().daemonInstanceId,
};
const request = { target };
const denied = hostResourceFixture().workstreams;
const fixtureKinds = [
  "healthy",
  "pressure",
  "partial",
  "stale",
  "tmpfs",
  "cgroup-cpu-unsupported",
  "cgroup-cpu-denied",
  "cgroup-memory-unsupported",
  "cgroup-memory-denied",
] as const;
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(permissions: Permission[] = ["host.telemetry.read", "runs.read"]) {
  let principal: Principal = {
    id: "caller",
    kind: "credential",
    credentialId: "test-id",
    permissions: new Set(permissions),
    scope: { runs: "owned", workflows: ["allowed"] },
  };
  let clock = 0;
  const snapshot = vi.fn(async () => JSON.stringify(hostResourceFixture()));
  const projection: AuthorizedWorkstreamProjection = {
    runIds: ["root", "child", "parked", "uncertain"],
    read: vi.fn(async () => JSON.stringify(workstreamSummaryFixture())),
    current: vi.fn(async () => true),
    publishable: vi.fn(() => true),
  };
  const source: HostResourceReadSource = { snapshot, workstreams: vi.fn(async () => projection) };
  const access = {
    current: () => principal,
    allowsRun: vi.fn(async (_p: Principal, _id: string) => true),
  };
  const model = new HostResourceReadModel(
    target,
    source,
    () => clock,
    () => Date.parse(hostResourceFixture().collectedAt) + clock,
  );
  return {
    model,
    source,
    projection,
    snapshot,
    access,
    read: (raw: unknown = request) => model.read(raw, access),
    setPrincipal: (p: Principal) => {
      principal = p;
    },
    principal: () => principal,
    advance: () => {
      clock += HOST_RESOURCE_LIMITS.refreshMs;
    },
    elapse: (ms: number) => {
      clock += ms;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("host telemetry policy (proposal)", () => {
  it("does not advertise an unregistered resource method supplied in another model's inventory", async () => {
    const context: MethodContext = {
      orcaVersion: "fixture",
      capabilities: ["operator.hostResources"],
      operatorReads: {
        methods: ["operator.hostResources"],
        model: async () => {
          throw new Error("must not run");
        },
      },
    };
    const table = methodsFor(context);
    expect(Object.keys(table)).not.toContain("operator.hostResources");
    const hello = (await table.hello!.handle({ client: "fixture", protocol: PROTOCOL_VERSION }, context)) as {
      capabilities: string[];
    };
    expect(hello.capabilities).not.toContain("operator.hostResources");
  });

  it("is absent from every preset and local compatibility, and requires an explicit grant", async () => {
    const store = new CredentialStore();
    for (const preset of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      const issued = await store.issue({ principal: preset, preset });
      const current = store.current(issued.credential.id);
      expect(current.ok && current.principal.permissions.has("host.telemetry.read")).toBe(false);
    }
    expect(LOCAL_PRINCIPAL.permissions.has("host.telemetry.read")).toBe(false);
    const explicit = await store.issue({
      principal: "narrow",
      permissions: ["host.telemetry.read"],
      scope: { runs: "owned", workflows: ["allowed"] },
    });
    expect(store.current(explicit.credential.id)).toMatchObject({ ok: true });
  });

  it("denies before invalid input diagnostics and before either source runs", async () => {
    const f = setup(["runs.read"]);
    await expect(f.read({ host: "SECRET" })).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.source.workstreams).not.toHaveBeenCalled();
    f.setPrincipal(LOCAL_PRINCIPAL);
    await expect(f.read()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it.each(["host", "path", "pid", "url", "mount", "refresh", "runId", "principal"])(
    "refuses arbitrary %s selectors before source work",
    async (selector) => {
      const f = setup();
      await expect(f.read({ ...request, [selector]: "SECRET" })).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
      expect(f.snapshot).not.toHaveBeenCalled();
    },
  );

  it.each(fixtureKinds)("preserves exact %s host metrics/warnings without run scope", async (kind) => {
    const f = setup(["host.telemetry.read"]);
    f.snapshot.mockResolvedValue(JSON.stringify(hostResourceFixture(kind)));
    expect(await f.read()).toEqual(hostResourceFixture(kind));
    expect(f.source.workstreams).not.toHaveBeenCalled();
    expect(f.access.allowsRun).not.toHaveBeenCalled();
  });

  it("discards supplied aggregate counts and never calls a summary source without runs.read", async () => {
    const f = setup(["host.telemetry.read"]);
    const snapshot = hostResourceFixture();
    snapshot.workstreams = workstreamSummaryFixture();
    if ("value" in snapshot.workstreams) snapshot.workstreams.value.scope = "authorized-aggregate";
    f.snapshot.mockResolvedValue(JSON.stringify(snapshot));
    expect((await f.read()).workstreams).toEqual(denied);
    expect(f.source.workstreams).not.toHaveBeenCalled();
  });

  it("uses unknown coverage, never fabricated emptiness, without a scoped index", async () => {
    const f = setup();
    delete f.source.workstreams;
    expect((await f.read()).workstreams).toEqual({
      status: "unavailable",
      source: "runtime-ownership",
      reason: "scope-unverified",
    });
  });

  it.each(["active", "empty", "partial", "denied"] as const)(
    "preserves the authorized %s shared summary",
    async (kind) => {
      const f = setup();
      f.projection.read = async () => JSON.stringify(workstreamSummaryFixture(kind));
      expect((await f.read()).workstreams).toEqual(workstreamSummaryFixture(kind));
      expect(f.access.allowsRun).toHaveBeenCalledTimes(8);
    },
  );

  it.each(["hidden", "missing"])(
    "refuses %s work before reading any summary, with the same public refusal",
    async (id) => {
      const f = setup();
      f.projection.runIds = [id];
      f.access.allowsRun.mockResolvedValue(false);
      await expect(f.read()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN", message: "not permitted" });
      expect(f.projection.read).not.toHaveBeenCalled();
      expect(f.projection.current).not.toHaveBeenCalled();
    },
  );

  it.each(["host", "enumerate", "summary", "revision", "resource", "final-resource"])(
    "discards results when credentials are revoked during the %s await",
    async (stage) => {
      const f = setup();
      const blocked = deferred<never>();
      const started = deferred<void>();
      const pause = () => {
        started.resolve();
        return blocked.promise;
      };
      if (stage === "host") f.source.snapshot = pause;
      if (stage === "enumerate") f.source.workstreams = pause;
      if (stage === "summary") f.projection.read = pause;
      if (stage === "revision") f.projection.current = pause;
      if (stage === "resource") f.access.allowsRun.mockImplementation(pause);
      if (stage === "final-resource") {
        let calls = 0;
        f.access.allowsRun.mockImplementation(async () => (++calls === 8 ? pause() : true));
      }
      const pending = f.read();
      const assertion = expect(pending).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      await started.promise;
      f.setPrincipal({ ...f.principal(), permissions: new Set() });
      blocked.resolve(undefined as never);
      await assertion;
    },
  );

  it.each(["scope", "identity", "credential"])("rejects %s replacement while the host read awaits", async (kind) => {
    const f = setup();
    f.snapshot.mockImplementation(async () => {
      const p = f.principal();
      f.setPrincipal(
        kind === "scope"
          ? { ...p, scope: { runs: "all", workflows: "*" } }
          : kind === "identity"
            ? { ...p, id: "owner" }
            : { ...p, credentialId: "different" },
      );
      return JSON.stringify(hostResourceFixture());
    });
    await expect(f.read()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("rechecks resource authority after summary read and rejects stale index evidence", async () => {
    const f = setup();
    f.projection.read = async () => {
      f.access.allowsRun.mockResolvedValue(false);
      return JSON.stringify(workstreamSummaryFixture());
    };
    await expect(f.read()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    const g = setup();
    g.projection.current = async () => false;
    await expect(g.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it.each(["ownership", "visibility", "lineage", "coverage"])(
    "fences %s changes during a later final check without changing the credential",
    async (kind) => {
      const f = setup();
      const owned = new Set(f.projection.runIds);
      let valid = true;
      f.projection.current = vi.fn(async () => true);
      f.projection.publishable = vi.fn(() => valid && f.projection.runIds.every((id) => owned.has(id)));
      let calls = 0;
      f.access.allowsRun.mockImplementation(async (_principal, id) => {
        if (++calls === 8) {
          if (kind === "ownership") owned.delete("root");
          else valid = false;
        }
        return owned.has(id);
      });
      await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
      expect(f.access.allowsRun).toHaveBeenCalledTimes(8);
      expect(f.projection.current).toHaveBeenCalledTimes(1);
      expect(f.projection.publishable).toHaveBeenCalledTimes(1);
      expect(f.principal().permissions.has("runs.read")).toBe(true);
    },
  );

  it("fails closed when a malformed fence returns a promise instead of synchronous authority", async () => {
    const f = setup();
    Object.assign(f.projection, { publishable: async () => true });
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("contains invalid fence rejections at read and serialization without a rejection handler", async () => {
    const execution = promisify(execFile)(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { HostResourceReadModel, resourceResponseForPublication } from ${JSON.stringify(
            new URL("../dist/operator-host-resources.js", import.meta.url).href,
          )};
          import { hostResourceFixture, workstreamSummaryFixture } from ${JSON.stringify(
            new URL("../../protocol/dist/index.js", import.meta.url).href,
          )};
          const marker = "SYNTHETIC_FENCE_PROVIDER_FAILURE";
          const host = hostResourceFixture();
          const target = { workspaceId: "20000000-0000-4000-8000-000000000001", instanceId: host.daemonInstanceId };
          const principal = { id: "caller", kind: "credential", credentialId: "synthetic",
            permissions: new Set(["host.telemetry.read", "runs.read"]), scope: { runs: "owned" } };
          for (const serialization of [false, true]) {
            for (const kind of ["false", "undefined", "non-boolean", "async-throw", "rejected", "eventual-true", "thenable", "then-getter", "constructor-getter", "catch-getter", "rejected-catch-getter", "throw"]) {
              let calls = 0;
              let getterCalls = 0;
              let resolve;
              const projection = {
                runIds: ["root", "child", "parked", "uncertain"],
                read: async () => JSON.stringify(workstreamSummaryFixture()), current: async () => true,
                publishable: () => {
                  if (++calls === 1 && serialization) return true;
                  if (kind === "false") return false;
                  if (kind === "undefined") return undefined;
                  if (kind === "non-boolean") return "true";
                  if (kind === "async-throw") return (async () => { throw new Error(marker); })();
                  if (kind === "rejected") return Promise.reject(new Error(marker));
                  if (kind === "eventual-true") return new Promise(r => { resolve = r; });
                  if (kind === "thenable") return { then: (_resolve, reject) => reject(new Error(marker)) };
                  if (kind === "then-getter") return { get then() { throw new Error(marker); } };
                  if (["constructor-getter", "catch-getter", "rejected-catch-getter"].includes(kind)) {
                    const promise = kind === "rejected-catch-getter" ? Promise.reject(new Error(marker)) : Promise.resolve(true);
                    Object.defineProperty(promise, kind === "constructor-getter" ? "constructor" : "catch", {
                      get() { ++getterCalls; throw new Error(marker); },
                    });
                    return promise;
                  }
                  throw new Error(marker);
                },
              };
              const model = new HostResourceReadModel(target, {
                snapshot: async () => JSON.stringify(host), workstreams: async () => projection,
              }, () => 0, () => Date.parse(host.collectedAt));
              const read = () => model.read({ target }, { current: () => principal, allowsRun: async () => true });
              const code = ["throw", "constructor-getter"].includes(kind) ? "NOT_SUPPORTED" : "RUN_STATE";
              if (serialization) {
                const result = await read();
                assert.equal(calls, 1);
                const response = resourceResponseForPublication({ kind: "response", id: 1, ok: true, result });
                assert.equal(response.ok, false);
                assert.equal(response.error.code, code);
                assert.ok(!JSON.stringify(response).includes(marker));
                assert.ok(!JSON.stringify(response).includes("activeRoots"));
              } else {
                await assert.rejects(read, error => error.code === code && !error.message.includes(marker));
              }
              assert.equal(calls, serialization ? 2 : 1);
              if (kind === "catch-getter" || kind === "rejected-catch-getter") assert.equal(getterCalls, 0);
              resolve?.(true);
              await new Promise(r => setImmediate(r));
            }
          }
          console.log("contained");
        `,
      ],
      { timeout: 10_000, maxBuffer: 16_384 },
    );
    const { stdout, stderr } = await execution;
    const evidence = JSON.stringify({
      executable: process.execPath,
      argv: execution.child.spawnargs,
      status: execution.child.exitCode,
      signal: execution.child.signalCode,
      stdout,
      stderr,
    });
    expect(execution.child.exitCode, evidence).toBe(0);
    expect(execution.child.signalCode, evidence).toBeNull();
    expect(stdout, evidence).toBe("contained\n");
    expect(stderr, evidence).toBe("");
  });

  it("checks the fence after the operation promise settles and sanitizes fence failures", async () => {
    const f = setup();
    f.projection.publishable = () => {
      throw new Error("SECRET ownership index");
    };
    await expect(f.read()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "Resource observation is unavailable; retry later",
    });
    const g = setup();
    let valid = true;
    let calls = 0;
    g.access.allowsRun.mockImplementation(async () => {
      if (++calls === 8)
        queueMicrotask(() => {
          valid = false;
        });
      return true;
    });
    g.projection.publishable = () => valid;
    await expect(g.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("rejects a provider without a synchronous publication fence before summary collection", async () => {
    const f = setup();
    Reflect.deleteProperty(f.projection, "publishable");
    await expect(f.read()).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
    expect(f.projection.read).not.toHaveBeenCalled();
  });

  it("composes a genuinely later summary through the final checks without renewing observations", async () => {
    const f = setup();
    const summary = workstreamSummaryFixture();
    if (!("value" in summary)) throw new Error();
    summary.observedAt = "2026-10-04T12:00:00.001Z";
    f.projection.read = async () => {
      f.elapse(1);
      return JSON.stringify(summary);
    };
    f.projection.current = async () => {
      f.elapse(5);
      return true;
    };
    const result = await f.read();
    expect(result.collectedAt).toBe("2026-10-04T12:00:00.006Z");
    expect(result.ageMs).toBe(6);
    expect(result.cpu).toMatchObject({ observedAt: hostResourceFixture().collectedAt, ageMs: 6 });
    expect(result.workstreams).toEqual({ ...summary, ageMs: 5 });
  });

  it("ages expiring host observations and warnings during summary composition", async () => {
    const f = setup();
    const host = hostResourceFixture("pressure");
    if (!("value" in host.cpu)) throw new Error();
    host.cpu = { ...host.cpu, ageMs: 14999 };
    f.snapshot.mockResolvedValue(JSON.stringify(host));
    f.projection.current = async () => {
      f.elapse(2);
      return true;
    };
    const result = await f.read();
    expect(result.cpu).toMatchObject({
      status: "stale",
      reason: "expired",
      ageMs: 15001,
      observedAt: host.collectedAt,
    });
    expect(result.warnings.map((warning) => warning.code)).not.toContain("cpu-pressure");
    expect(result.warnings.map((warning) => warning.code)).toContain("stale-data");
  });

  it("keeps future summary timestamps invalid rather than rewriting their observation time", async () => {
    const f = setup();
    const summary = workstreamSummaryFixture();
    if (!("value" in summary)) throw new Error();
    summary.observedAt = "2026-10-04T12:00:01.000Z";
    f.projection.read = async () => JSON.stringify(summary);
    await expect(f.read()).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
  });

  it.each(
    [
      "not-json",
      "null",
      JSON.stringify({ privatePath: "/SECRET" }),
      " ".repeat(32769),
      JSON.stringify({ ...hostResourceFixture(), warnings: [], cpu: { ...hostResourceFixture("pressure").cpu } }),
    ].map((raw, i) => [i, raw] as const),
  )("rejects malformed/oversized or contradictory host JSON case %i without its contents", async (_i, raw) => {
    const f = setup();
    f.snapshot.mockResolvedValue(raw);
    await expect(f.read()).rejects.toMatchObject({
      code: "PROTOCOL_MESSAGE",
      message: "Invalid or oversized resource observation",
    });
  });

  it.each(["aggregate", "count", "malformed", "oversized", "source"])("rejects %s workstream data", async (kind) => {
    const f = setup();
    const summary = workstreamSummaryFixture();
    if ("value" in summary) {
      if (kind === "aggregate") summary.value.scope = "authorized-aggregate";
      if (kind === "count") summary.value.activeRoots = 1001;
    }
    if (kind === "source") summary.source = "none";
    f.projection.read = async () =>
      kind === "malformed" ? "null" : kind === "oversized" ? " ".repeat(32769) : JSON.stringify(summary);
    await expect(f.read()).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
  });

  it.each([[Array<string>(1001).fill("run")], [["duplicate", "duplicate"]], [["x".repeat(257)]]])(
    "bounds authorized enumeration before reading counts",
    async (ids: string[]) => {
      const f = setup();
      f.projection.runIds = ids;
      await expect(f.read()).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
      expect(f.projection.read).not.toHaveBeenCalled();
    },
  );

  it("sanitizes source failures and still gives revocation priority on a rejected await", async () => {
    const f = setup();
    f.snapshot.mockRejectedValue(new Error("SECRET /private/path token"));
    await expect(f.read()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "Resource observation is unavailable; retry later",
    });
    f.advance();
    f.snapshot.mockImplementation(async () => {
      f.setPrincipal({ ...f.principal(), permissions: new Set() });
      throw new Error("SECRET");
    });
    await expect(f.read()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("rejects stale request and response targets before publishing", async () => {
    const f = setup();
    await expect(f.read({ target: { ...target, instanceId: crypto.randomUUID() } })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect(f.snapshot).not.toHaveBeenCalled();
    const host = hostResourceFixture();
    host.daemonInstanceId = crypto.randomUUID();
    f.snapshot.mockResolvedValue(JSON.stringify(host));
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it.each(["boot", "host", "rewind"])("rejects %s changes on the same daemon instance", async (kind) => {
    const f = setup(["host.telemetry.read"]);
    await f.read();
    f.advance();
    const snapshot = hostResourceFixture();
    if (kind === "host") snapshot.hostId = crypto.randomUUID();
    if (kind === "boot" && "value" in snapshot.bootId) snapshot.bootId.value = crypto.randomUUID();
    if (kind === "rewind") snapshot.sequence = 0;
    f.snapshot.mockResolvedValue(JSON.stringify(snapshot));
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it.each(["available", "stale"] as const)(
    "retains known boot provenance through an unavailable reading before a %s replacement",
    async (status) => {
      const f = setup(["host.telemetry.read"]);
      await f.read();
      f.advance();
      const missing = hostResourceFixture();
      missing.sequence = 2;
      missing.bootId = { status: "unavailable", source: "linux-boot-id", reason: "source-failed" };
      missing.warnings = resourceWarnings(missing);
      f.snapshot.mockResolvedValue(JSON.stringify(missing));
      expect((await f.read()).bootId).toEqual(missing.bootId);
      f.advance();
      const replacement = hostResourceFixture();
      replacement.sequence = 3;
      if (!("value" in replacement.bootId)) throw new Error();
      replacement.bootId.value = crypto.randomUUID();
      if (status === "stale") replacement.bootId = { ...replacement.bootId, status, reason: "source-failed" };
      replacement.warnings = resourceWarnings(replacement);
      f.snapshot.mockResolvedValue(JSON.stringify(replacement));
      await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
      f.advance();
      const sameBoot = hostResourceFixture();
      sameBoot.sequence = 3;
      f.snapshot.mockResolvedValue(JSON.stringify(sameBoot));
      await expect(f.read()).resolves.toEqual(sameBoot);
    },
  );

  it("bounds refresh and retains the occupied slot after a timeout with ignored cancellation", async () => {
    vi.useFakeTimers();
    const f = setup(["host.telemetry.read"]);
    const pendingSource = deferred<string>();
    f.snapshot.mockReturnValue(pendingSource.promise);
    const pending = expect(f.read()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    f.advance();
    await expect(f.read()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    pendingSource.resolve(JSON.stringify(hostResourceFixture()));
    await vi.advanceTimersByTimeAsync(0);
    f.snapshot.mockResolvedValue(JSON.stringify(hostResourceFixture()));
    await f.read();
    await expect(f.read()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(f.snapshot).toHaveBeenCalledTimes(2);
  });
});
