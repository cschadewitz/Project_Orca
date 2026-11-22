/** windows-launch-check.js (#889): the DevTools evaluation and polling it relies on. */
import { describe, expect, it } from "vitest";
import { evaluate, until } from "../deploy/windows-launch-check.js";

class FakeSocket extends EventTarget {
  static answer = undefined;
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(text) {
    this.sent.push(JSON.parse(text));
    FakeSocket.last = this;
    const message = new Event("message");
    message.data = JSON.stringify({ id: 1, ...FakeSocket.answer });
    queueMicrotask(() => this.dispatchEvent(message));
  }
  close() {
    this.closed = true;
  }
}

describe("evaluate", () => {
  it("asks Runtime.evaluate by value and returns the value", async () => {
    FakeSocket.answer = { result: { result: { type: "string", value: "live" } } };
    expect(await evaluate("ws://x", "window.orca?.connection.read().state ?? null", FakeSocket)).toBe("live");
    expect(FakeSocket.last.sent).toEqual([
      {
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: "window.orca?.connection.read().state ?? null", returnByValue: true },
      },
    ]);
    expect(FakeSocket.last.closed).toBe(true);
  });

  it("rejects a thrown expression", async () => {
    FakeSocket.answer = { result: { exceptionDetails: { text: "Uncaught" } } };
    await expect(evaluate("ws://x", "boom()", FakeSocket)).rejects.toThrow(/Uncaught/);
  });
});

describe("until", () => {
  it("returns the first truthy value, tolerating errors before it", async () => {
    let calls = 0;
    const value = await until(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("not yet");
        return calls === 3 ? "live" : undefined;
      },
      1_000,
      "never",
      1,
    );
    expect([value, calls]).toEqual(["live", 3]);
  });

  it("names the last error when it gives up", async () => {
    await expect(until(async () => Promise.reject(new Error("refused")), 5, "no window", 1)).rejects.toThrow(
      "no window (last error: refused)",
    );
  });
});
