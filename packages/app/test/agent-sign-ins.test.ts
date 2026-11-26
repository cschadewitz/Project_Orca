/**
 * Agent sign-ins bound to the window that started them (#1236): the prompt reaches only that
 * window, only it can open the page and only for the attempt its prompt named, a second
 * sign-in for the same agent is refused, and the window leaving its page ends the sign-in.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentSignIns, type AgentSignInPrompt, type SignInSender } from "../src/main/agent-sign-ins.js";

let ids = 0;
function window() {
  const events = new EventEmitter();
  const received: AgentSignInPrompt[] = [];
  let destroyed = false;
  const sender = {
    id: ++ids,
    isDestroyed: () => destroyed,
    send: (_channel: string, view: AgentSignInPrompt) => received.push(view),
    on: (event: string, listener: (details?: unknown) => void) => events.on(event, listener),
    removeListener: (event: string, listener: (details?: unknown) => void) => events.removeListener(event, listener),
  } as SignInSender;
  return {
    sender,
    received,
    events,
    last: () => received.at(-1)!.attempt,
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

const PAGE = "https://auth.openai.com/codex/device";

describe("agent sign-ins", () => {
  it("shows the prompt only to the window that asked, and opens the page only for it", async () => {
    const broker = new AgentSignIns();
    const mine = window();
    const other = window();
    const attempt = pending();
    const running = broker.run(mine.sender, "lab", "codex", attempt.signIn);
    await attempt.shown;
    expect(mine.received).toEqual([
      { profileId: "lab", agent: "codex", attempt: expect.any(String), host: "auth.openai.com", code: "WXYZ-12345" },
    ]);
    expect(JSON.stringify(mine.received)).not.toContain("https://");
    expect(other.received).toEqual([]);
    expect(broker.url(mine.sender, "lab", "codex", mine.last())).toBe(PAGE);
    expect(() => broker.url(other.sender, "lab", "codex", mine.last())).toThrow(/not waiting for you/);
    attempt.finish();
    await running;
    expect(() => broker.url(mine.sender, "lab", "codex", mine.last())).toThrow(/not waiting for you/);
  });

  it("opens a page only for the attempt the prompt named, never a later one", async () => {
    const broker = new AgentSignIns();
    const mine = window();
    const first = pending();
    const one = broker.run(mine.sender, "lab", "codex", first.signIn);
    await first.shown;
    const stale = mine.last();
    first.finish();
    await one;
    const second = pending();
    const two = broker.run(mine.sender, "lab", "codex", second.signIn);
    await second.shown;
    expect(mine.last()).not.toBe(stale);
    // A click on the first prompt, from the same window, does not open the second sign-in.
    expect(() => broker.url(mine.sender, "lab", "codex", stale)).toThrow(/not waiting for you/);
    expect(broker.url(mine.sender, "lab", "codex", mine.last())).toBe(PAGE);
    second.finish();
    await two;
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
    expect(broker.url(first.sender, "lab", "codex", first.last())).toBe(PAGE);
    attempt.finish();
    await running;
  });

  it("ends the sign-in when the window that asked closes, crashes or leaves its page", async () => {
    const broker = new AgentSignIns();
    const ends: [string, unknown?][] = [
      ["destroyed"],
      ["render-process-gone"],
      ["did-navigate"],
      ["did-start-navigation", { isMainFrame: true, isSameDocument: false }],
    ];
    for (const [end, details] of ends) {
      const mine = window();
      const attempt = pending();
      const running = broker.run(mine.sender, "lab", "codex", attempt.signIn);
      await attempt.shown;
      mine.events.emit(end, details);
      await expect(running).rejects.toThrow(/cancelled/);
      expect(() => broker.url(mine.sender, "lab", "codex", mine.last())).toThrow(/not waiting for you/);
      for (const event of ["destroyed", "render-process-gone", "did-navigate", "did-start-navigation"])
        expect(mine.events.listenerCount(event)).toBe(0);
    }
  });

  it("keeps the sign-in through a navigation within the page or in a subframe", async () => {
    const broker = new AgentSignIns();
    const mine = window();
    const attempt = pending();
    const running = broker.run(mine.sender, "lab", "codex", attempt.signIn);
    await attempt.shown;
    mine.events.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    mine.events.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(broker.url(mine.sender, "lab", "codex", mine.last())).toBe(PAGE);
    attempt.finish();
    await running;
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
