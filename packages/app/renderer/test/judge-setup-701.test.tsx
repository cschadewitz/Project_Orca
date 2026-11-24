// @vitest-environment happy-dom
/**
 * The judge setup checklist (#701): `judge.status` as the steps an owner takes before
 * plain-language rules can be judged. The model half asserts each step's state and command;
 * the screen half that the section is offered only by a daemon that lists `judge.status`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { JudgeStatusResultSchema, type JudgeStatusResult } from "@orca/protocol";
import { JudgeSetup } from "../src/config/judge-setup.js";
import { judgeSetupSteps } from "../src/config/judge-setup-model.js";
import { AS_OF, HELLO } from "./fixtures.js";
import { harness, installBridge } from "./harness.js";

const destination = "https://judge.invalid/v1/messages";
const configured = { state: "configured", provider: "anthropic", destination, credential: "judge-key" } as const;
const status = (over: Partial<JudgeStatusResult> = {}): JudgeStatusResult =>
  JudgeStatusResultSchema.parse({
    active: false,
    config: { ...configured, key: "present" },
    auth: "token",
    principal: "casey",
    grants: [
      { kind: "reads", enabled: true, granted: true },
      { kind: "edits", enabled: false, granted: false },
      { kind: "mcpCalls", enabled: false, granted: false },
      { kind: "commands", enabled: false, granted: false },
    ],
    budget: { state: "ready", firstDaySpent: false },
    ...over,
  });
const byId = (s: JudgeStatusResult) => Object.fromEntries(judgeSetupSteps(s).map((step) => [step.id, step]));

describe("#701 judge setup steps", () => {
  it("is all done when the judge, key, grant and budget are in place", () => {
    expect(judgeSetupSteps(status()).map((s) => [s.id, s.state])).toEqual([
      ["config", "done"],
      ["key", "done"],
      ["grant", "done"],
      ["budget", "done"],
    ]);
  });

  it("asks for judge settings, without key or grant steps, when none are configured", () => {
    const steps = byId(status({ config: { state: "none" }, grants: [] }));
    expect(steps.config).toMatchObject({ state: "todo" });
    expect(steps.key).toBeUndefined();
    expect(steps.grant).toBeUndefined();
    expect(byId(status({ config: { state: "invalid" }, grants: [] })).config).toMatchObject({ state: "todo" });
  });

  it("says what is wrong with the key, never its value", () => {
    expect(byId(status({ config: { ...configured, key: "missing" } })).key).toMatchObject({ state: "todo" });
    expect(byId(status({ config: { ...configured, key: "not-found" } })).key!.detail).toContain("judge-key");
    expect(byId(status({ config: { ...configured, key: "not-local" } })).key).toMatchObject({ state: "blocked" });
  });

  it("names the owner command for exactly the missing grants, kinds included", () => {
    const steps = byId(
      status({
        grants: [
          { kind: "reads", enabled: true, granted: false },
          { kind: "edits", enabled: true, granted: true },
          { kind: "mcpCalls", enabled: true, granted: false },
          { kind: "commands", enabled: false, granted: false },
        ],
      }),
    );
    expect(steps.grant).toMatchObject({
      state: "todo",
      command: "orca auth issue casey --preset owner --judge-disclosure --judge-disclosure-kind mcp-calls",
    });
    expect(byId(status({ principal: "it's me" })).grant!.command).toBeUndefined();
    const quoted = byId(status({ principal: "it's me", grants: [{ kind: "reads", enabled: true, granted: false }] }))
      .grant!.command;
    expect(quoted).toBe(`orca auth issue 'it'\\''s me' --preset owner --judge-disclosure`);
  });

  it("says loopback mode keeps no grants", () => {
    expect(byId(status({ auth: "loopback", principal: undefined })).grant).toMatchObject({ state: "blocked" });
  });

  it("names the budget command for each state", () => {
    expect(byId(status({ budget: { state: "uninitialized" } })).budget).toMatchObject({
      state: "todo",
      command: "orca judge budget init",
    });
    expect(byId(status({ budget: { state: "refused" } })).budget).toMatchObject({
      state: "todo",
      command: "orca judge budget reset",
    });
    expect(byId(status({ budget: { state: "unsupported", reason: "platform" } })).budget).toMatchObject({
      state: "blocked",
    });
    expect(byId(status({ budget: { state: "ready", firstDaySpent: true } })).budget!.detail).toContain("tomorrow");
  });
});

describe("#701 judge setup on the Config surface", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    cleanup();
    for (const restore of restores.splice(0)) restore();
  });

  function show(methods: readonly string[], answer?: JudgeStatusResult) {
    const fake = installBridge({
      connection: {
        state: "live",
        since: AS_OF,
        orcaVersion: HELLO.orcaVersion,
        capabilities: HELLO.capabilities,
        methods: [...methods],
      },
    });
    restores.push(fake.install());
    let reads = 0;
    if (answer)
      (fake.bridge.config as { judgeStatus?: unknown }).judgeStatus = async () => {
        reads++;
        return { ok: true, result: answer };
      };
    const { Providers } = harness();
    render(
      <Providers>
        <JudgeSetup />
      </Providers>,
    );
    return { reads: () => reads };
  }

  it("lists the steps, with the owner command for one still to do", async () => {
    const read = show([...(HELLO.methods ?? []), "judge.status"], status({ budget: { state: "uninitialized" } }));
    await waitFor(() => expect(screen.getByText("orca judge budget init")).toBeTruthy());
    expect(screen.getByLabelText("Judge setup steps").querySelectorAll("[data-judge-step]").length).toBe(4);
    expect(screen.getByText("inactive")).toBeTruthy();
    expect(read.reads()).toBeGreaterThan(0);
  });

  it("is not offered by a daemon that does not list judge.status", () => {
    const read = show(HELLO.methods ?? [], status());
    expect(screen.queryByLabelText("Plain-language rule judge")).toBeNull();
    expect(read.reads()).toBe(0);
  });
});
