/**
 * The `claude-sdk-hook` acceptance path (#1128) sends every allowed MCP call through the relay's
 * own check, a person's one-time allow included, and a deny made before the handoff stops the
 * call there. A fake MCP tool is used: the relay's check runs, and no server is started.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeSdkHook } from "../guard-qualification/paths.js";
import { createWorld } from "../guard-qualification/world.js";

const fake = { tool: "mcp", server: "fake", name: "echo", input: { text: "hello" } };
const denyFake = [{ match: { kind: "other", titlePattern: "^fake: echo$" }, decision: "deny" }];

let world;
beforeEach(async () => {
  world = await createWorld({}, claudeSdkHook);
});
afterEach(async () => {
  await world.dispose();
});

describe("claude-sdk-hook: the MCP relay's check (#1128)", () => {
  it("hands a person's one-time allow to the relay, which dispatches the call", async () => {
    world.answers.push("allow");
    const got = await claudeSdkHook.decide(world, fake);
    // The relay served the call as the person's one-time answer, not as a standing allow.
    expect(got).toMatchObject({ outcome: "ask", detail: "mcp:ask:allow_once", relay: "dispatched" });
    expect(world.asked).toHaveLength(1);
  });

  it("stops a one-time allow at the handoff once the policy denies the call", async () => {
    world.answers.push("allow");
    const got = await claudeSdkHook.decide(world, fake, { beforeHandoff: () => world.setSidecarRules(denyFake) });
    expect(got).toMatchObject({ outcome: "deny", detail: "mcp:recheck:denied", relay: "refused" });
    expect(world.asked).toHaveLength(1);
  });

  it("dispatches a call a rule allows, and stops it at the handoff once the rule is gone", async () => {
    await world.answerAlways(fake);
    expect(await claudeSdkHook.decide(world, fake)).toMatchObject({ outcome: "allow", relay: "dispatched" });
    const got = await claudeSdkHook.decide(world, fake, { beforeHandoff: () => world.revokeAll() });
    // Nobody was asked about it, so the relay does not serve a call the policy now asks about.
    expect(got).toMatchObject({ outcome: "deny", detail: "mcp:recheck:asks", relay: "refused" });
    expect(world.asked).toHaveLength(0);
  });
});
