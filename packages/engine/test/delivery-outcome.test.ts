/** The shipped SDLC must consume the deploy report's status, independently of interpreter completion. */
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { parseDeliverablesBlock, serializeFrontMatter, succeeded } from "@orca/core";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it.each(["done", "blocked", "unknown"])("reports deploy status %s truthfully", async (delivery) => {
  const h = await harness(
    {},
    {
      sessionFactory: async ({ host, agent, cwd }) => ({
        id: "fake",
        acpSessionId: "fake",
        agentId: agent.id,
        hostId: host.id,
        cwd,
        closed: Promise.resolve(),
        configOptions: [],
        setConfigOption: async () => [],
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => {},
        async prompt(input) {
          const text =
            typeof input === "string" ? input : input.map((b) => (b.type === "text" ? b.text : "")).join("\n");
          for (const d of parseDeliverablesBlock(text)) {
            const data =
              d.kind === "deploy-report"
                ? { status: delivery, pullRequest: "", ci: "not-configured" }
                : { status: "done", risk: "low", branch: "test", passed: true, verdict: "approve" };
            await host.fs.writeFile(
              d.path,
              serializeFrontMatter({
                data,
                body: "A deterministic fixture report with enough useful text to meet the shipped minimum body length validation rule.",
              }),
            );
          }
          return { stopReason: "end_turn", durationMs: 0 };
        },
      }),
    },
  );
  dirs.push(h.dir);
  const state = await h.orchestrator.startAndRun({
    workflowId: "ai-sdlc",
    vars: { workItem: { slug: "delivery", title: "Delivery", description: "Produce the requested change" } },
  });
  expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
  expect(succeeded(state)).toBe(delivery === "done");
  expect(state.run.outcome).toBe(delivery === "done" ? "success" : "failure");
  const final = state.steps[state.stepOrder.at(-1)!]!;
  expect(final.nodeId).toBe(delivery === "done" ? "done" : "delivery-blocked");
  expect(Object.values(state.artifacts).find((a) => a.name === "deployReport")?.data.status).toBe(delivery);
});
