// @vitest-environment happy-dom
/**
 * The judge setup checklist (#701): `judge.status` as the steps an owner takes before
 * plain-language rules can be judged. The model half asserts each step's state and command;
 * the screen half that the section is offered only by a daemon that lists `judge.status`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { JudgeStatusResultSchema, type JudgeKeyState, type JudgeStatusResult } from "@orca/protocol";
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

  it("says what is wrong with the key, never its value, and tells presence from usability", () => {
    const key = (k: JudgeKeyState) => byId(status({ config: { ...configured, key: k } })).key!;
    expect(key("missing")).toMatchObject({ state: "todo" });
    expect(key("not-found").detail).toContain("judge-key");
    expect(key("destination-mismatch")).toMatchObject({ state: "todo" });
    expect(key("unusable")).toMatchObject({ state: "todo" });
    expect(key("withheld")).toMatchObject({ state: "blocked" });
    expect(key("present")).toMatchObject({ state: "done" });
  });

  it("gives guidance, not a copyable owner command, for the missing grants", () => {
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
    expect(steps.grant).toMatchObject({ state: "todo" });
    expect(steps.grant!.command).toBeUndefined();
    expect(steps.grant!.detail).toContain("--judge-disclosure");
    expect(steps.grant!.detail).toContain("mcp-calls");
    expect(steps.grant!.detail).not.toContain("--preset");
    expect(steps.grant!.detail).not.toContain("casey");
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

  it("clears on a daemon switch and drops a reply for the daemon it left, whatever the order", async () => {
    const fake = installBridge({
      connection: {
        state: "live",
        since: AS_OF,
        orcaVersion: HELLO.orcaVersion,
        capabilities: HELLO.capabilities,
        methods: [...(HELLO.methods ?? []), "judge.status"],
      },
    });
    restores.push(fake.install());
    let target = { epoch: 1, identity: { workspaceId: "w1", instanceId: "i1" } };
    const listeners = new Set<() => void>();
    (fake.bridge as { daemonConnection?: unknown }).daemonConnection = {
      read: () => target,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const replies: ((value: unknown) => void)[] = [];
    (fake.bridge.config as { judgeStatus?: unknown }).judgeStatus = () =>
      new Promise((resolve) => replies.push(resolve));
    const { Providers } = harness();
    render(
      <Providers>
        <JudgeSetup />
      </Providers>,
    );
    await waitFor(() => expect(replies.length).toBe(1));
    // The first daemon answers: casey's grants are shown.
    await act(async () => replies[0]!({ ok: true, result: status({ budget: { state: "uninitialized" } }) }));
    await waitFor(() => expect(screen.getByText("orca judge budget init")).toBeTruthy());

    // Switch daemons: what was shown goes at once, before the new read answers.
    target = { epoch: 2, identity: { workspaceId: "w2", instanceId: "i2" } };
    act(() => listeners.forEach((listener) => listener()));
    await waitFor(() => expect(replies.length).toBe(2));
    expect(screen.queryByText("orca judge budget init")).toBeNull();

    // The new daemon refuses the read: the first daemon's status is not shown again.
    await act(async () => replies[1]!({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "no" } }));
    expect(screen.getByText("The judge's setup could not be read.")).toBeTruthy();
    expect(screen.queryByText("orca judge budget init")).toBeNull();
  });

  it("drops a reply that arrives after a switch, even if it is the newer request's twin", async () => {
    const fake = installBridge({
      connection: {
        state: "live",
        since: AS_OF,
        orcaVersion: HELLO.orcaVersion,
        capabilities: HELLO.capabilities,
        methods: [...(HELLO.methods ?? []), "judge.status"],
      },
    });
    restores.push(fake.install());
    let target = { epoch: 1, identity: { workspaceId: "w1", instanceId: "i1" } };
    const listeners = new Set<() => void>();
    (fake.bridge as { daemonConnection?: unknown }).daemonConnection = {
      read: () => target,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const replies: ((value: unknown) => void)[] = [];
    (fake.bridge.config as { judgeStatus?: unknown }).judgeStatus = () =>
      new Promise((resolve) => replies.push(resolve));
    const { Providers } = harness();
    render(
      <Providers>
        <JudgeSetup />
      </Providers>,
    );
    await waitFor(() => expect(replies.length).toBe(1));
    target = { epoch: 2, identity: { workspaceId: "w2", instanceId: "i2" } };
    act(() => listeners.forEach((listener) => listener()));
    await waitFor(() => expect(replies.length).toBe(2));
    // Out of order: the new daemon answers first, then the old one's reply arrives late.
    await act(async () => replies[1]!({ ok: true, result: status({ budget: { state: "refused" } }) }));
    await waitFor(() => expect(screen.getByText("orca judge budget reset")).toBeTruthy());
    await act(async () => replies[0]!({ ok: true, result: status({ budget: { state: "uninitialized" } }) }));
    expect(screen.getByText("orca judge budget reset")).toBeTruthy();
    expect(screen.queryByText("orca judge budget init")).toBeNull();
  });

  it("is not offered by a daemon that does not list judge.status", () => {
    const read = show(HELLO.methods ?? [], status());
    expect(screen.queryByLabelText("Plain-language rule judge")).toBeNull();
    expect(read.reads()).toBe(0);
  });
});
