import * as acp from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { ProgramService } from "@orca/engine";
import { OrcaAcpAgent } from "@orca/integrations";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";

it("ACP Request prompts use shared admission, publish IDs and retain the streaming completion contract", async () => {
  const f = submissionFixture();
  const program = new ProgramService(f.orc, "program", undefined, {
    admissions: f.admissions,
    captureLaunch: f.capture,
  });
  const agent = new OrcaAcpAgent({ orchestrator: f.orc, program, submissionAuthority: f.authority }).register(
    acp.agent({ name: "orca-test" }),
  );
  const messages: string[] = [];
  await acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text")
        messages.push(params.update.content.text);
    })
    .connectWith(agent, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Build it\nTask" }],
      });
      const [admission] = await program.submissions!.list(f.authority);
      expect(admission?.state).toBe("accepted");
      if (!admission || admission.state !== "accepted") throw new Error("not accepted");
      expect(messages.join("")).toContain(`admission ${admission.admissionId}: accepted`);
      expect(await f.stores.requests.get(admission.requestId)).toMatchObject({
        source: { kind: "acp-session", sessionId },
        status: "completed",
        programRunId: admission.runId,
      });
      expect(f.owners.get(admission.runId)).toBe("owner");
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/run program" }],
      });
      expect(await program.submissions!.list(f.authority)).toHaveLength(1);
      expect(await f.orc.listRuns()).toHaveLength(2);
    });
});

it("ACP does not execute when authority is revoked during the accepted-record write", async () => {
  const f = submissionFixture();
  const program = new ProgramService(f.orc, "program", undefined, {
    admissions: f.admissions,
    captureLaunch: f.capture,
  });
  const put = f.admissions.records.put.bind(f.admissions.records);
  vi.spyOn(f.admissions.records, "put").mockImplementation(async (record) => {
    await put(record);
    if (record.state === "accepted")
      vi.mocked(f.authority.authorize).mockRejectedValue(new Error("revoked after acceptance"));
  });
  const run = vi.spyOn(f.orc, "run");
  const agent = new OrcaAcpAgent({ orchestrator: f.orc, program, submissionAuthority: f.authority }).register(
    acp.agent({ name: "orca-test" }),
  );
  await acp.client({ name: "test" }).connectWith(agent, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    await expect(
      ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Build it" }] }),
    ).rejects.toThrow();
  });
  expect(run).not.toHaveBeenCalled();
  const [record] = await f.admissions.records.list();
  expect(record?.state).toBe("accepted");
  expect((await f.stores.events.read(record!.runId!)).map((event) => event.type)).toEqual(["run.created"]);
});

it("ACP recovery discovers and reconciles the original admission without starting execution", async () => {
  const f = submissionFixture();
  const program = new ProgramService(f.orc, "program", undefined, {
    admissions: f.admissions,
    captureLaunch: f.capture,
  });
  const refresh = vi.fn(async () => f.authority);
  const agent = new OrcaAcpAgent({ orchestrator: f.orc, program, authorityForNewIntent: refresh }).register(
    acp.agent({ name: "orca-test" }),
  );
  vi.spyOn(f.orc, "startRun").mockRejectedValueOnce(new Error("interrupted"));
  const messages: string[] = [];
  await acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text")
        messages.push(params.update.content.text);
    })
    .connectWith(agent, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
      const prompt = (text: string) =>
        ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
      await prompt("Build it");
      const [record] = await f.admissions.records.list();
      expect(record!.state).toBe("recoverable-failure");
      const before = refresh.mock.calls.length;
      await prompt("/admissions list unexpected");
      expect(refresh).toHaveBeenCalledTimes(before);
      await prompt("/admissions list");
      await prompt(`/admissions inspect ${record!.id}`);
      await prompt(`/admissions reconcile ${record!.id}`);
      const [accepted] = await program.submissions!.list(f.authority);
      expect(accepted!.state).toBe("accepted");
      if (!accepted || accepted.state !== "accepted") throw new Error("not accepted");
      expect((await f.orc.getState(accepted.runId)).run.status).toBe("created");
      await prompt(`/admissions reconcile ${record!.id}`);
      expect(await f.orc.listRuns()).toEqual([accepted.runId]);
      expect(messages.join("")).toContain(`orca resume ${accepted.runId}`);
    });
});

it("ACP refreshes a submission authority once per new prompt and retains it through execution", async () => {
  const f = submissionFixture();
  const program = new ProgramService(f.orc, "program", undefined, {
    admissions: f.admissions,
    captureLaunch: f.capture,
  });
  let current = f.authority;
  const refresh = vi.fn(async () => current);
  const agent = new OrcaAcpAgent({ orchestrator: f.orc, program, authorityForNewIntent: refresh }).register(
    acp.agent({ name: "orca-test" }),
  );
  await acp.client({ name: "test" }).connectWith(agent, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "First" }] });
    expect(refresh).toHaveBeenCalledTimes(1);
    current = {
      ...f.authority,
      actor: { ...f.authority.actor, credentialId: "new-credential" },
      authorize: vi.fn(async () => {}),
    };
    vi.mocked(f.authority.authorize).mockRejectedValue(new Error("old credential revoked"));
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Second" }] });
    expect(refresh).toHaveBeenCalledTimes(2);
    const records = await f.admissions.records.list();
    expect(records).toHaveLength(2);
    const created = await Promise.all(records.map(async (record) => (await f.stores.events.read(record.runId!))[0]));
    expect(created.map((event) => event!.type === "run.created" && event.payload.actor?.credentialId).sort()).toEqual([
      "credential-test",
      "new-credential",
    ]);
  });
});
