/** Executes against the reserved ACP wiring only; feature-only CI does not claim adapter acceptance. */
import * as acp from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrcaError } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import { ProgramService } from "@orca/engine";
import { OrcaAcpAgent } from "@orca/integrations";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
it.skipIf(process.env.ORCA_RETRY_INTEGRATION !== "1")(
  "ACP metadata keeps retries stable across new sessions and distinguishes intentional new work",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-acp-retry-"));
    try {
      const f = submissionFixture();
      const faults = {
        conflict: () => new OrcaError("RUN_STATE", "conflict"),
        limit: () => new OrcaError("RUN_STATE", "limit"),
      };
      const retries = new RegisteredRetryClaims(
        new FileRetryClaimStore({ storeDir: dir, execution: new FileExecutionStore(dir), faults }),
        faults,
      );
      const program = new ProgramService(f.orc, "program", undefined, {
        admissions: f.admissions,
        captureLaunch: f.capture,
        retries,
      });
      const agent = new OrcaAcpAgent({ orchestrator: f.orc, program, submissionAuthority: f.authority }).register(
        acp.agent({ name: "test" }),
      );
      await acp.client({ name: "test" }).connectWith(agent, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const submit = async (key: string) => {
          const { sessionId } = await ctx.request(acp.methods.agent.session.new, {
            cwd: process.cwd(),
            mcpServers: [],
          });
          await ctx.request(acp.methods.agent.session.prompt, {
            sessionId,
            _meta: { "orca/idempotencyKey": key },
            prompt: [{ type: "text", text: "Build it\nTask" }],
          });
        };
        await submit("one");
        await submit("one");
        expect(await f.stores.requests.list()).toHaveLength(1);
        expect(await f.orc.listRuns()).toHaveLength(1);
        await submit("two");
        expect(await f.stores.requests.list()).toHaveLength(2);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
