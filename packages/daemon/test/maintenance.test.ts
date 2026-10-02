import { expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import { z } from "zod";
it("closes admission atomically and guards both active operations and token ownership", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const daemon = await startDaemon({
    orcaVersion: "0.6.0",
    capabilities: [],
    auth: { mode: "loopback-unauthenticated" },
    // Any inventoried method will do; an un-inventoried one is refused before admission (#328).
    methods: {
      "agents.list": {
        params: z.object({}),
        handle: () => {
          entered();
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      },
    },
  });
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(daemon.url + "/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as { ok: boolean; result: { ready: boolean; active: string[] } };
  };
  try {
    const work = call("agents.list");
    await running;
    expect((await call("maintenance", { action: "prepare", token: "a" })).result).toEqual({
      ready: false,
      active: ["agents.list"],
    });
    finish();
    await work;
    expect((await call("maintenance", { action: "prepare", token: "a" })).result.ready).toBe(true);
    expect((await call("agents.list")).ok).toBe(false);
    expect((await call("maintenance", { action: "resume", token: "b" })).ok).toBe(false);
    expect((await call("maintenance", { action: "resume", token: "a" })).ok).toBe(true);
  } finally {
    await daemon.close();
  }
});
it("starts closed for activation health checks", async () => {
  const daemon = await startDaemon({
    orcaVersion: "0.6.0",
    capabilities: [],
    maintenanceToken: "recovery",
    auth: { mode: "loopback-unauthenticated" },
  });
  try {
    const response = await fetch(daemon.url + "/rpc", {
      method: "POST",
      body: JSON.stringify({
        kind: "request",
        id: 1,
        method: "hello",
        params: { client: "test", protocol: { major: 1, minor: 0 } },
      }),
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { orcaVersion: "0.6.0", methods: ["hello", "maintenance"] },
    });
  } finally {
    await daemon.close();
  }
});

it("keeps durable admission closed across daemon restarts and resume requests", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-"));
  const admissionFile = join(dir, "activation.json");
  const options = {
    orcaVersion: "0.6.0",
    capabilities: [],
    admissionFile,
    auth: { mode: "loopback-unauthenticated" as const },
    methods: {
      "agents.list": { params: z.object({}), handle: () => "accepted" },
    },
  };
  let daemon = await startDaemon(options);
  const call = async (method = "agents.list", params = {}) => {
    const response = await fetch(daemon.url + "/rpc", {
      method: "POST",
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as { ok: boolean };
  };
  try {
    expect((await call()).ok).toBe(true);
    await writeFile(admissionFile, "{}");
    expect((await call()).ok).toBe(false);
    await daemon.close();
    daemon = await startDaemon(options);
    expect((await call()).ok).toBe(false);
    await call("maintenance", { action: "resume", token: "test" });
    expect((await call()).ok).toBe(false);
    await rm(admissionFile);
    expect((await call()).ok).toBe(true);
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});
