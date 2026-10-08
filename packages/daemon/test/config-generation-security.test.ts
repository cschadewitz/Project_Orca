/** Integration-only transport checks, carried in the reserved-path patch. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, it } from "vitest";
import { parseOrcaConfig } from "@orca/core";
import { ConfigurationGenerations } from "../../engine/src/configuration-generation.js";
import { ConfigModel, ControlModel, ReadModel, startDaemon } from "@orca/daemon";
import { CredentialStore, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";
import { emptyFixture } from "./fixture.js";
import { PROTOCOL_VERSION } from "@orca/protocol";

for (const readOnly of [false, true])
  it(`config.apply transport authorization and discovery, readOnly=${readOnly}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-generation-security-"));
    const { orchestrator: orc, stores } = emptyFixture();
    const generations = new ConfigurationGenerations({
      store: stores.execution,
      workflows: stores.workflows,
      loadAssets: async () => ({ workflows: [], templates: [] }),
      admission: {
        validateStartRun: (opts, gen) => orc.validateStartRun(opts, gen),
        startRun: (opts, gen) => orc.startRun(opts, gen),
      },
    });
    await generations.initialize(parseOrcaConfig({}), "");
    orc.generations = generations;
    const model = new ConfigModel({ configDir: dir, generations });
    const reads = new ReadModel({ orchestrator: orc });
    const credentials = new CredentialStore();
    const owner = await credentials.issue({ principal: "owner", preset: "owner" });
    const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
    const daemon = await startDaemon({
      capabilities: ["runs.read", "runs.subscribe", ...(readOnly ? [] : ["runs.control" as const])],
      orcaVersion: "test",
      reads,
      config: model,
      source: orc,
      ...(readOnly ? {} : { control: new ControlModel({ orchestrator: orc, reads }) }),
      auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver: orchestratorResolver(orc) },
    });
    const call = async (token: string, method: string, params: unknown) => {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
      });
      return response.json() as Promise<{
        ok: boolean;
        result?: { methods: string[]; outcome?: string };
        error?: { code: string };
      }>;
    };
    const socket = new WebSocket(daemon.socketUrl!, ["orca.v1"], {
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const advertised = await call(owner.token, "hello", { client: "test", protocol: PROTOCOL_VERSION });
      expect(advertised.result?.methods.includes("config.apply")).toBe(!readOnly);
      if (!readOnly) {
        // A bad shape cannot disclose validation details before the config.write check.
        expect(await call(viewer.token, "config.apply", { secret: "canary" })).toMatchObject({
          ok: false,
          error: { code: "AUTH_FORBIDDEN" },
        });
        const answer = new Promise<unknown>((resolve) =>
          socket.once("message", (bytes) =>
            resolve(
              JSON.parse(
                (Array.isArray(bytes)
                  ? Buffer.concat(bytes)
                  : Buffer.isBuffer(bytes)
                    ? bytes
                    : Buffer.from(bytes)
                ).toString("utf8"),
              ),
            ),
          ),
        );
        socket.send(JSON.stringify({ kind: "request", id: 1, method: "config.apply", params: { secret: "canary" } }));
        expect(await answer).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
        const generation = generations.current.snapshot.id;
        expect(
          await call(owner.token, "config.apply", {
            expectedRevision: "",
            expectedGeneration: generation,
            validateOnly: true,
          }),
        ).toMatchObject({ ok: true, result: { outcome: "validated" } });
        expect(generations.current.snapshot.id).toBe(generation);
      }
    } finally {
      socket.close();
      await daemon.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
