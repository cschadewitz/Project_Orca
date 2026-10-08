/** Typed Request retry conflicts over the real ACP wire, without keys/payloads or extra store effects. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admissionRetryFaults, OrcaError } from "@orca/core";
import { ProgramService } from "@orca/engine";
import { fileStores } from "@orca/store";
import { serveAcpFacade } from "@orca/integrations";
import { FixtureLifetime } from "../../cli/test/fixture-lifetime.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { FileAdmissionStore } from "../../engine/src/program/submission-store.js";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";

let lifetime: FixtureLifetime;
beforeEach(() => {
  lifetime = new FixtureLifetime();
});
afterEach(async () => {
  try {
    await lifetime.close();
  } finally {
    vi.restoreAllMocks();
  }
});

interface Frame {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function fixture() {
  return lifetime.run(async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-acp-conflict-wire-"));
    lifetime.root(() => rm(dir, { recursive: true, force: true }));
    const stores = fileStores(dir);
    const admissions = new FileAdmissionStore(dir);
    const f = submissionFixture(stores, admissions, { nativeCorrelation: true });
    await f.ready();
    const retries = new RegisteredRetryClaims(
      new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults: admissionRetryFaults }),
      admissionRetryFaults,
    );
    const program = new ProgramService(f.orc, "program", undefined, {
      admissions,
      captureLaunch: f.capture,
      retries,
    });
    const stdin = new PassThrough(),
      stdout = new PassThrough();
    const frames: Frame[] = [];
    const waiting = new Map<number, (frame: Frame) => void>();
    let buffer = "",
      id = 0;
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      expect(Buffer.byteLength(buffer)).toBeLessThanOrEqual(64 * 1024);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        if (frame.id !== undefined) waiting.get(frame.id)?.(frame);
      }
    });
    const served = serveAcpFacade(
      { orchestrator: f.orc, program, submissionAuthority: f.authority },
      { stdin, stdout },
    );
    lifetime.own(async () => {
      stdin.end();
      await served;
      stdout.destroy();
    });
    const wire = (method: string, params: object) =>
      lifetime.run(async () => {
        const requestId = ++id;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await new Promise<Frame>((resolve, reject) => {
            waiting.set(requestId, resolve);
            timer = setTimeout(() => reject(new Error(`ACP ${method} exceeded the 5s fixture bound`)), 5000);
            stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
          });
        } finally {
          clearTimeout(timer);
          waiting.delete(requestId);
        }
      });
    expect(
      await wire("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
    ).not.toHaveProperty("error");
    const session = async () => {
      const reply = await wire("session/new", { cwd: dir, mcpServers: [] });
      expect(reply).not.toHaveProperty("error");
      return (reply.result as { sessionId: string }).sessionId;
    };
    const prompt = (sessionId: string, text: string) =>
      wire("session/prompt", {
        sessionId,
        _meta: { "orca/idempotencyKey": "PRIVATE_ORIGINAL_RETRY_KEY" },
        prompt: [{ type: "text", text }],
      });
    const snapshot = async () => {
      // Read our trusted disposable stores, never a refused caller projection.
      const runs = (await stores.events.listRuns()).sort();
      const events = (await Promise.all(runs.map((runId) => stores.events.read(runId)))).flat();
      const digests: Record<string, string> = {};
      const visit = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) await visit(file);
          else if (entry.isFile())
            digests[relative(dir, file)] = createHash("sha256")
              .update(await readFile(file))
              .digest("hex");
        }
      };
      await visit(dir);
      return {
        runs,
        requests: (await stores.requests.list()).map((r) => r.id).sort(),
        admissions: (await admissions.records.list()).map((r) => r.id).sort(),
        eventCount: events.length,
        corrections: events.filter((event) => event.type === "revision.recorded").length,
        answers: events.filter((event) => event.type === "human.answered").length,
        digests,
      };
    };
    return { f, program, prompt, session, frames, snapshot };
  });
}

it("changed Request payload retains RETRY_CONFLICT in ACP error data and leaves the original admission, run and protected records unchanged", async () => {
  const f = await fixture();
  const original = "Build it\nPRIVATE_ORIGINAL_BODY";
  expect(await f.prompt(await f.session(), original)).toMatchObject({ result: { stopReason: "end_turn" } });
  const before = await f.snapshot();
  expect(before.requests).toHaveLength(1);
  expect(before.runs).toHaveLength(1);
  expect(before.admissions).toHaveLength(1);
  const offset = f.frames.length;
  const error = await f.prompt(await f.session(), "Build it\nPRIVATE_CHANGED_BODY");
  expect(error.error).toEqual({
    code: -32603,
    message: "Internal error",
    data: {
      code: "RETRY_CONFLICT",
      details: "Retry key is already bound to a different command",
    },
  });
  expect(error).not.toHaveProperty("result");
  expect(JSON.stringify(f.frames.slice(offset))).not.toMatch(
    /PRIVATE_ORIGINAL_RETRY_KEY|PRIVATE_ORIGINAL_BODY|PRIVATE_CHANGED_BODY/,
  );
  expect(await f.snapshot()).toEqual(before); // Includes retry catalog and every protected-file digest.
  expect(await f.prompt(await f.session(), original)).toMatchObject({ result: { stopReason: "end_turn" } });
  const replay = await f.snapshot();
  expect(replay.requests).toEqual(before.requests);
  expect(replay.runs).toEqual(before.runs);
  expect(replay.admissions).toEqual(before.admissions);
  expect(replay.eventCount).toBe(before.eventCount);
});

it("uses the canonical safe conflict reason instead of forwarding a thrown protected message or details", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  vi.spyOn(f.program.submissions!, "submit").mockRejectedValueOnce(
    new OrcaError("RETRY_CONFLICT", "PRIVATE_ERROR_MESSAGE", {
      idempotencyKey: "PRIVATE_ORIGINAL_RETRY_KEY",
      payload: "PRIVATE_ERROR_PAYLOAD",
    }),
  );
  const error = await f.prompt(await f.session(), "Build it\nPRIVATE_CHANGED_BODY");
  expect(error.error).toEqual({
    code: -32603,
    message: "Internal error",
    data: {
      code: "RETRY_CONFLICT",
      details: admissionRetryFaults.conflict().message,
    },
  });
  expect(JSON.stringify(error)).not.toContain("PRIVATE_");
  expect(await f.snapshot()).toEqual(before);
});

it("preserves the unsupported keyed direct-launch policy and other domain-error envelopes", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  const sessionId = await f.session();
  const direct = await f.prompt(sessionId, "/run program");
  expect(direct.error).toEqual({
    code: -32602,
    message: "Invalid params",
    data: {
      reason: "Keyed ACP direct launch with session workspace/selection is unsupported; use runs.admit",
    },
  });
  expect(await f.snapshot()).toEqual(before);
  vi.spyOn(f.program.submissions!, "submit").mockRejectedValueOnce(
    new OrcaError("WORKFLOW_NOT_FOUND", "Fixture workflow is unavailable"),
  );
  expect((await f.prompt(sessionId, "Build it")).error).toEqual({
    code: -32603,
    message: "Internal error",
    data: { details: "Fixture workflow is unavailable" },
  });
  expect(await f.snapshot()).toEqual(before);
});
