/** Raw editor reads and configuration commits retain current authority on both real transports. */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOrcaConfig, sha256 } from "@orca/core";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { ConfigurationGenerations } from "../../engine/src/configuration-generation.js";
import { ConfigModel, ControlModel, ReadModel, startDaemon } from "@orca/daemon";
import {
  CredentialStore,
  MemoryAuditSink,
  OwnershipStore,
  orchestratorResolver,
  authForbidden,
  type Permission,
} from "../src/auth/index.js";
import { emptyFixture } from "./fixture.js";
import { writePrivateFile } from "../src/auth/credentials.js";

const SECRET = "legacy-config-secret-5bfe";
const text = `# Retain this comment\nagents: [{id: worker, command: synthetic, env: {API_TOKEN: ${SECRET}}}]\n`;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Reply = { ok: boolean; result?: unknown; error?: { code: string; message: string } };
function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
async function fixture(
  transport: "http" | "socket",
  permissions: readonly Permission[] = ["config.read", "config.write"],
) {
  const dir = await mkdtemp(join(tmpdir(), "orca-config-authority-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "orca.config.yaml"), text);
  const sidecar = '{"version":1,"agents":{}}\n';
  await writeFile(join(dir, "orca.permissions.json"), sidecar);
  const { orchestrator, stores } = emptyFixture();
  const loading = vi.fn(async () => ({ workflows: [], templates: [] }));
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: loading,
    admission: {
      validateStartRun: (opts, gen) => orchestrator.validateStartRun(opts, gen),
      startRun: (opts, gen) => orchestrator.startRun(opts, gen),
    },
  });
  await generations.initialize(
    parseOrcaConfig({ agents: [{ id: "worker", command: "synthetic", env: { API_TOKEN: SECRET } }] }),
    sha256(text),
  );
  const model = new ConfigModel({ configDir: dir, generations });
  const reads = new ReadModel({ orchestrator });
  const credentialFile = join(dir, "credentials.json");
  const credentials = new CredentialStore({ file: credentialFile });
  const issued = await credentials.issue({
    principal: "configuration-editor",
    permissions: [...permissions],
    scope: { workflows: "*", runs: "all" },
  });
  const audit = new MemoryAuditSink();
  const daemon = await startDaemon({
    config: model,
    reads,
    source: orchestrator,
    control: new ControlModel({ orchestrator, reads }),
    orcaVersion: "configuration-authority-test",
    capabilities: [],
    auth: {
      mode: "token",
      credentials,
      audit,
      ownership: new OwnershipStore(),
      resolver: orchestratorResolver(orchestrator),
    },
  });
  cleanups.push(() => daemon.close());
  let id = 0;
  const frames: Reply[] = [];
  let call: (method: string, params: unknown) => Promise<Reply>;
  if (transport === "http") {
    call = async (method, params) => {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
        body: JSON.stringify({ kind: "request", id: ++id, method, params }),
      });
      const reply = (await response.json()) as Reply;
      frames.push(reply);
      return reply;
    };
  } else {
    const socket = new WebSocket(daemon.socketUrl!, ["orca.v1"], {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    cleanups.push(async () => socket.close());
    const waiting = new Map<number, (reply: Reply) => void>();
    socket.on("message", (bytes: Buffer) => {
      const reply = JSON.parse(bytes.toString("utf8")) as Reply & { id?: number };
      frames.push(reply);
      if (reply.id !== undefined) waiting.get(reply.id)?.(reply);
    });
    socket.on("close", () => {
      for (const resolve of waiting.values())
        resolve({ ok: false, error: { code: "AUTH_INVALID", message: "invalid credentials" } });
    });
    call = async (method, params) => {
      const requestId = ++id;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Reply>((resolve, reject) => {
          waiting.set(requestId, resolve);
          timer = setTimeout(() => reject(new Error("configuration fixture response timed out")), 5000);
          socket.send(JSON.stringify({ kind: "request", id: requestId, method, params }));
        });
      } finally {
        clearTimeout(timer);
        waiting.delete(requestId);
      }
    };
  }
  return { dir, model, generations, loading, call, issued, credentials, credentialFile, audit, frames, sidecar };
}

describe.each(["http", "socket"] as const)("configuration authority over %s", (transport) => {
  it("requires raw-read authority for every config.set form before discovery or diagnostics", async () => {
    const f = await fixture(transport, ["config.write"]);
    for (const params of [
      { document: "config", expectedRevision: sha256(text), patch: [], validateOnly: true },
      { document: "config", expectedRevision: sha256(text), text, validateOnly: true },
      { document: "config", expectedRevision: sha256(text), edits: [], validateOnly: true },
      { document: "permissions", expectedRevision: sha256(f.sidecar), patch: [], validateOnly: true },
      { malformed: "private-diagnostics-canary" },
    ])
      expect(await f.call("config.set", params)).toMatchObject({
        ok: false,
        error: { code: "AUTH_FORBIDDEN", message: "not permitted" },
      });
    const hello = await f.call("hello", { client: "configuration-test", protocol: PROTOCOL_VERSION });
    expect(hello.ok).toBe(true);
    expect((hello.result as { methods: string[] }).methods).not.toContain("config.set");
    expect((hello.result as { methods: string[] }).methods).toContain("config.apply");
    expect(await readFile(join(f.dir, "orca.config.yaml"), "utf8")).toBe(text);
    expect(JSON.stringify(f.frames)).not.toContain(SECRET);
    expect(JSON.stringify(f.audit.records)).not.toMatch(/legacy-config-secret|private-diagnostics-canary/);
  });

  it.each(
    (["config", "permissions"] as const).flatMap((document) =>
      (["revoked", "reduced-grants"] as const).map((change) => ({ document, change })),
    ),
  )(
    "refuses a $document save after $change authority during its disk read, with no commit or acknowledgement",
    async ({ document, change }) => {
      const f = await fixture(transport);
      const entered = barrier(),
        resume = barrier(),
        finished = barrier();
      const read = f.model.read.bind(f.model);
      vi.spyOn(f.model, "read").mockImplementation(async (which) => {
        const value = await read(which);
        if (which === document) {
          entered.release();
          await resume.ready;
        }
        return value;
      });
      const set = f.model.set.bind(f.model);
      vi.spyOn(f.model, "set").mockImplementation(async (...args) => {
        try {
          return await set(...args);
        } finally {
          finished.release();
        }
      });
      const changed = vi.fn();
      f.model.onChange(changed);
      const pending = f.call("config.set", {
        document,
        expectedRevision: sha256(document === "config" ? text : f.sidecar),
        ...(document === "config"
          ? { patch: [{ path: "roles", value: {} }] }
          : { text: '{"version":1,"agents":{"worker":{"rules":[{"match":{"kind":"execute"},"decision":"allow"}]}}}' }),
      });
      await entered.ready;
      if (change === "revoked") await f.credentials.revoke(f.issued.credential.id);
      else {
        const records = JSON.parse(await readFile(f.credentialFile, "utf8")) as {
          credentials: { id: string; permissions: string[] }[];
        };
        records.credentials.find((record) => record.id === f.issued.credential.id)!.permissions = ["config.read"];
        writePrivateFile(f.credentialFile, JSON.stringify(records) + "\n");
      }
      resume.release();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: change === "revoked" ? "AUTH_INVALID" : "AUTH_FORBIDDEN" },
      });
      await finished.ready;
      expect(
        await readFile(join(f.dir, document === "config" ? "orca.config.yaml" : "orca.permissions.json"), "utf8"),
      ).toBe(document === "config" ? text : f.sidecar);
      expect(changed).not.toHaveBeenCalled();
      expect((await readdir(f.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(JSON.stringify(f.frames)).not.toContain(SECRET);
    },
  );

  it("withholds a raw read revoked while reading the sidecar", async () => {
    const f = await fixture(transport);
    const entered = barrier(),
      resume = barrier(),
      finished = barrier();
    const read = f.model.read.bind(f.model);
    vi.spyOn(f.model, "read").mockImplementation(async (document) => {
      const result = await read(document);
      if (document === "permissions") {
        entered.release();
        await resume.ready;
      }
      return result;
    });
    const get = f.model.get.bind(f.model);
    vi.spyOn(f.model, "get").mockImplementation(async (...args) => {
      try {
        return await get(...args);
      } finally {
        finished.release();
      }
    });
    const pending = f.call("config.get", {});
    await entered.ready;
    await f.credentials.revoke(f.issued.credential.id);
    resume.release();
    expect(await pending).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    await finished.ready;
    expect(JSON.stringify(f.frames)).not.toContain(SECRET);
  });

  it("rechecks Apply after candidate loading and refuses activation on revocation", async () => {
    const f = await fixture(transport);
    const current = f.generations.current;
    const candidate = text + "roles: {}\n";
    await writeFile(join(f.dir, "orca.config.yaml"), candidate);
    const entered = barrier(),
      resume = barrier(),
      finished = barrier();
    f.loading.mockImplementationOnce(async () => {
      entered.release();
      await resume.ready;
      return { workflows: [], templates: [] };
    });
    const apply = f.model.apply.bind(f.model);
    vi.spyOn(f.model, "apply").mockImplementation(async (...args) => {
      try {
        return await apply(...args);
      } finally {
        finished.release();
      }
    });
    const pending = f.call("config.apply", {
      expectedRevision: sha256(candidate),
      expectedGeneration: current.snapshot.id,
    });
    await entered.ready;
    await f.credentials.revoke(f.issued.credential.id);
    resume.release();
    expect(await pending).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    await finished.ready;
    expect(f.generations.current).toBe(current);
    expect(JSON.stringify(f.frames)).not.toContain(SECRET);
  });

  it("preserves untouched inline credentials on an authorized patch and keeps Save separate from Apply", async () => {
    const f = await fixture(transport);
    const current = f.generations.current;
    expect(
      await f.call("config.set", {
        document: "config",
        expectedRevision: sha256(text),
        patch: [{ path: "roles", value: {} }],
      }),
    ).toMatchObject({ ok: true, result: { written: true } });
    const saved = await readFile(join(f.dir, "orca.config.yaml"), "utf8");
    expect(saved).toContain(`API_TOKEN: ${SECRET}`);
    expect(saved).toContain("# Retain this comment");
    expect(f.generations.current).toBe(current);
    expect(f.audit.records).toMatchObject([
      { actor: { principal: "configuration-editor" }, operation: "config.set", outcome: "succeeded" },
    ]);
    expect(JSON.stringify(f.audit.records)).not.toContain(SECRET);
  });

  it("allows config.apply with only config.write because its result contains no editor bytes", async () => {
    const f = await fixture(transport, ["config.write"]);
    expect(
      await f.call("config.apply", {
        expectedRevision: sha256(text),
        expectedGeneration: f.generations.current.snapshot.id,
        validateOnly: true,
      }),
    ).toMatchObject({ ok: true, result: { outcome: "validated" } });
    expect(JSON.stringify(f.frames)).not.toContain(SECRET);
  });
});

it.each(["config", "permissions"] as const)(
  "checks %s authority after staging bytes and cleans up a refused replacement",
  async (document) => {
    const f = await fixture("http");
    const changed = vi.fn();
    f.model.onChange(changed);
    let staged = false;
    const authorize = async () => {
      if ((await readdir(f.dir)).some((name) => name.endsWith(".tmp"))) {
        staged = true;
        throw authForbidden();
      }
    };
    await expect(
      f.model.set(
        {
          document,
          expectedRevision: sha256(document === "config" ? text : f.sidecar),
          ...(document === "config"
            ? { patch: [{ path: "roles", value: {} }] }
            : {
                text: '{"version":1,"agents":{"worker":{"rules":[{"match":{"kind":"execute"},"decision":"allow"}]}}}',
              }),
        },
        authorize,
      ),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(staged).toBe(true);
    expect(
      await readFile(join(f.dir, document === "config" ? "orca.config.yaml" : "orca.permissions.json"), "utf8"),
    ).toBe(document === "config" ? text : f.sidecar);
    expect((await readdir(f.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  },
);
