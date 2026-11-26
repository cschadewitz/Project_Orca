/**
 * Agent sign-ins bound to the window that started them (#1236): the prompt reaches only that
 * window, only it can open the page, a second sign-in for the same agent is refused, and the
 * window going away ends the sign-in.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentSignIns, type AgentSignInPrompt, type SignInSender } from "../src/main/agent-sign-ins.js";

let ids = 0;
function window() {
  const events = new EventEmitter();
  const received: AgentSignInPrompt[] = [];
  let destroyed = false;
  const sender: SignInSender = {
    id: ++ids,
    isDestroyed: () => destroyed,
    send: (_channel, view) => received.push(view),
    once: (event, listener) => events.once(event, listener),
    removeListener: (event, listener) => events.removeListener(event, listener),
  };
  return {
    sender,
    received,
    events,
    destroy: () => {
      destroyed = true;
      events.emit("destroyed");
    },
  };
}

/** A sign-in that prompts, then waits until finished or cancelled. */
function pending() {
  let finish: () => void = () => {};
  let prompted: () => void = () => {};
  const shown = new Promise<void>((resolve) => (prompted = resolve));
  const signIn = (onPrompt: (prompt: { url?: string; code?: string }) => void, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      finish = resolve;
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      onPrompt({ url: "https://auth.openai.com/codex/device", code: "WXYZ-12345" });
      prompted();
    });
  return { signIn, shown, finish: () => finish() };
}

describe("agent sign-ins", () => {
  it("shows the prompt only to the window that asked, and opens the page only for it", async () => {
    const broker = new AgentSignIns();
    const mine = window();
    const other = window();
    const attempt = pending();
    const running = broker.run(mine.sender, "lab", "codex", attempt.signIn);
    await attempt.shown;
    expect(mine.received).toEqual([{ profileId: "lab", agent: "codex", host: "auth.openai.com", code: "WXYZ-12345" }]);
    expect(JSON.stringify(mine.received)).not.toContain("https://");
    expect(other.received).toEqual([]);
    expect(broker.url(mine.sender, "lab", "codex")).toBe("https://auth.openai.com/codex/device");
    expect(() => broker.url(other.sender, "lab", "codex")).toThrow(/not waiting for you/);
    attempt.finish();
    await running;
    expect(() => broker.url(mine.sender, "lab", "codex")).toThrow(/not waiting for you/);
  });

  it("refuses a second sign-in for the same agent while one waits, without touching the first", async () => {
    const broker = new AgentSignIns();
    const first = window();
    const second = window();
    const attempt = pending();
    const running = broker.run(first.sender, "lab", "codex", attempt.signIn);
    await attempt.shown;
    let started = false;
    await expect(
      broker.run(second.sender, "lab", "codex", async () => {
        started = true;
      }),
    ).rejects.toThrow(/already waiting/);
    expect(started).toBe(false);
    expect(second.received).toEqual([]);
    // The refused attempt cleaned up nothing of the first.
    expect(broker.url(first.sender, "lab", "codex")).toBe("https://auth.openai.com/codex/device");
    attempt.finish();
    await running;
    // Once it ended, another may start; a different agent or machine never waited on it.
    const next = pending();
    const again = broker.run(second.sender, "lab", "codex", next.signIn);
    await next.shown;
    next.finish();
    await again;
  });

  it("ends the sign-in when the window that asked closes or navigates", async () => {
    const broker = new AgentSignIns();
    for (const end of ["destroyed", "did-navigate", "render-process-gone"] as const) {
      const mine = window();
      const attempt = pending();
      const running = broker.run(mine.sender, "lab", "codex", attempt.signIn);
      await attempt.shown;
      mine.events.emit(end);
      await expect(running).rejects.toThrow(/cancelled/);
      expect(() => broker.url(mine.sender, "lab", "codex")).toThrow(/not waiting for you/);
      expect(mine.events.listenerCount(end)).toBe(0);
    }
  });

  it("refuses a window that has already closed, and ends every sign-in on quit", async () => {
    const broker = new AgentSignIns();
    const gone = window();
    gone.destroy();
    await expect(broker.run(gone.sender, "lab", "codex", async () => {})).rejects.toThrow(/closed/);
    const mine = window();
    const attempt = pending();
    const running = broker.run(mine.sender, "lab", "codex", attempt.signIn);
    await attempt.shown;
    broker.close();
    await expect(running).rejects.toThrow(/cancelled/);
  });
});
