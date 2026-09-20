/**
 * The main process's half of `orca://` (#165): what a command line carries, and the queue
 * that holds a URL until there is a window to give it to.
 *
 * The three deliveries — a cold start's `argv`, macOS's `open-url`, a second launch's
 * `second-instance` — differ only in where the string comes from, so what is worth testing
 * is that they all end at one queue, and that a link is delivered exactly once.
 */
import { describe, expect, it } from "vitest";
import { DeepLinkQueue, ORCA_SCHEME, protocolClientArgs, urlFromArgv } from "../src/main/deep-link.js";

describe("urlFromArgv", () => {
  it("finds the URL wherever the platform put it on the command line", () => {
    expect(urlFromArgv(["/usr/bin/orca", "--no-sandbox", "orca://run/run_1"])).toBe("orca://run/run_1");
    expect(urlFromArgv(["/usr/bin/orca", "orca://run/run_1", "--other"])).toBe("orca://run/run_1");
  });

  it("is case-insensitive about the scheme, because a URL scheme is", () => {
    expect(urlFromArgv(["app", "ORCA://run/run_1"])).toBe("ORCA://run/run_1");
  });

  it("finds nothing in an ordinary launch", () => {
    expect(urlFromArgv(["/usr/bin/orca", "--enable-logging"])).toBeUndefined();
    expect(urlFromArgv([])).toBeUndefined();
  });

  it("is not fooled by another app's scheme", () => {
    expect(urlFromArgv(["app", "https://example.test/orca://run/x"])).toBeUndefined();
  });
});

describe("protocolClientArgs", () => {
  it("passes the entry point in development, where the executable is Electron itself", () => {
    expect(protocolClientArgs(false, ["/path/to/electron", "/repo/packages/app"])).toEqual(["/repo/packages/app"]);
  });

  it("passes nothing for a packaged app, which is its own executable", () => {
    expect(protocolClientArgs(true, ["/Applications/ORCA.app", "ignored"])).toBeUndefined();
  });

  it("passes nothing when there is no entry point to name", () => {
    expect(protocolClientArgs(false, ["/path/to/electron"])).toBeUndefined();
  });
});

describe("DeepLinkQueue", () => {
  const url = `${ORCA_SCHEME}://run/run_1`;

  it("holds a cold start's URL until a window asks for it", () => {
    const queue = new DeepLinkQueue();
    queue.offer(url);
    expect(queue.take()).toBe(url);
  });

  it("delivers a link once: a reload must not drag a person back where they came from", () => {
    const queue = new DeepLinkQueue();
    queue.offer(url);
    queue.take();
    expect(queue.take()).toBeUndefined();
  });

  it("pushes to a listening window rather than queueing behind it", () => {
    const queue = new DeepLinkQueue();
    const seen: string[] = [];
    queue.subscribe((u) => seen.push(u));
    queue.offer(url);

    expect(seen).toEqual([url]);
    // Nothing is waiting: it was delivered, not stored.
    expect(queue.take()).toBeUndefined();
  });

  it("keeps the last of two links that arrive before a window exists", () => {
    const queue = new DeepLinkQueue();
    queue.offer(`${ORCA_SCHEME}://run/run_1`);
    queue.offer(`${ORCA_SCHEME}://run/run_2`);
    // A person clicked twice; the second is the one they meant.
    expect(queue.take()).toBe(`${ORCA_SCHEME}://run/run_2`);
  });

  it("ignores anything that is not this app's scheme", () => {
    const queue = new DeepLinkQueue();
    queue.offer("https://example.test/");
    queue.offer(undefined);
    expect(queue.take()).toBeUndefined();
  });

  it("holds again once the last window has unsubscribed", () => {
    const queue = new DeepLinkQueue();
    const unsubscribe = queue.subscribe(() => {});
    unsubscribe();
    queue.offer(url);
    expect(queue.take()).toBe(url);
  });
});
