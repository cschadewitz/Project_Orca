/**
 * Claude's permission mode pinned to Manual (`claude-mode.ts`). The real adapter's behaviour
 * (it starts in `auto`, and the pin moves it to `default`) is observed in
 * `packages/cli/test/claude-hook-acceptance-704.test.ts`; this covers the guard's own logic.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionConfigOption } from "@orca/core";
import { claudeModePin, guardClaudeSession, pinClaudeMode, type AgentSession } from "../src/index.js";

const MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

function fakeSession(start: string | undefined, opts: { modes?: string[]; sticky?: boolean } = {}) {
  let mode = start;
  const options = (): SessionConfigOption[] =>
    mode === undefined
      ? []
      : [
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: mode,
            options: (opts.modes ?? MODES).map((value) => ({ value, name: value })),
          },
        ];
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const, durationMs: 1 }));
  const setConfigOption = vi.fn(async (_id: string, value: string | boolean) => {
    if (!opts.sticky) mode = String(value);
    return options();
  });
  const close = vi.fn(async () => undefined);
  const session = {
    agentId: "claude",
    get configOptions() {
      return options();
    },
    prompt,
    setConfigOption,
    close,
  } as unknown as AgentSession;
  return { session, prompt, setConfigOption, close, drift: (to: string) => (mode = to) };
}

const claudeInfo = { name: "@agentclientprotocol/claude-agent-acp", version: "0.109.1" };

describe("pinClaudeMode", () => {
  it("leaves a session already in Manual alone", async () => {
    const s = fakeSession("default");
    await pinClaudeMode(s.session);
    expect(s.setConfigOption).not.toHaveBeenCalled();
  });

  it.each(["auto", "acceptEdits", "bypassPermissions", "plan"])("switches a session in %s to Manual", async (m) => {
    const s = fakeSession(m);
    await pinClaudeMode(s.session);
    expect(s.setConfigOption).toHaveBeenCalledWith("mode", "default");
  });

  it("refuses a session with no mode, without Manual on offer, or that will not switch", async () => {
    await expect(pinClaudeMode(fakeSession(undefined).session)).rejects.toThrow(/reports no permission mode/);
    await expect(pinClaudeMode(fakeSession("auto", { modes: ["auto"] }).session)).rejects.toThrow(
      /does not offer mode 'default'/,
    );
    await expect(pinClaudeMode(fakeSession("auto", { sticky: true }).session)).rejects.toThrow(/stayed in mode 'auto'/);
  });
});

describe("guardClaudeSession", () => {
  it("refuses switching out of Manual and passes other options through", async () => {
    const s = fakeSession("default");
    const g = guardClaudeSession(s.session);
    await expect(g.setConfigOption("mode", "auto")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(g.setConfigOption("mode", "bypassPermissions")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(s.setConfigOption).not.toHaveBeenCalled();
    await g.setConfigOption("mode", "default");
    await g.setConfigOption("model", "opus");
    expect(s.setConfigOption).toHaveBeenCalledWith("model", "opus");
  });

  it("switches a session that left Manual back before a prompt, or refuses the prompt", async () => {
    const s = fakeSession("default");
    const g = guardClaudeSession(s.session);
    s.drift("acceptEdits");
    await g.prompt("hi");
    expect(s.setConfigOption).toHaveBeenCalledWith("mode", "default");
    expect(s.prompt).toHaveBeenCalledOnce();

    const stuck = fakeSession("default", { sticky: true });
    const gs = guardClaudeSession(stuck.session);
    stuck.drift("auto");
    await expect(gs.prompt("hi")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(stuck.prompt).not.toHaveBeenCalled();
  });
});

describe("claudeModePin", () => {
  it("pins a session whose agent said it is the Claude adapter, and passes the inner meta through", async () => {
    const pin = claudeModePin();
    const inner = vi.fn(async () => ({ claudeCode: { options: {} } }));
    expect(await pin.sessionMeta(inner)(claudeInfo, vi.fn(), 1)).toEqual({ claudeCode: { options: {} } });
    const s = fakeSession("auto");
    const g = await pin.guard(s.session);
    expect(g.configOptions.find((o) => o.id === "mode")?.currentValue).toBe("default");
    await expect(g.setConfigOption("mode", "auto")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("leaves another agent's session as it is", async () => {
    const pin = claudeModePin();
    expect(await pin.sessionMeta()({ name: "codex-acp", version: "1" }, vi.fn(), 1)).toBeUndefined();
    const s = fakeSession("auto");
    expect(await pin.guard(s.session)).toBe(s.session);
    expect(s.setConfigOption).not.toHaveBeenCalled();
  });

  it("closes a Claude session it cannot pin, and refuses it", async () => {
    const pin = claudeModePin();
    await pin.sessionMeta()(claudeInfo, vi.fn(), 1);
    const s = fakeSession("auto", { sticky: true });
    await expect(pin.guard(s.session)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(s.close).toHaveBeenCalledOnce();
  });
});
