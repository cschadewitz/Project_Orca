/**
 * `humanInput.mode: cli` - the terminal prompt. Driven over a pair of in-memory
 * streams instead of a TTY, so the retry loop, the "1." shorthand and the
 * cancellation paths are all reachable from a test.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { toGateOption } from "@orca/core";
import type { HumanInputQuery } from "@orca/engine";
import { cliHumanInput } from "../src/human-input-cli.js";

/**
 * The prompt is a loop: it writes `> `, waits for one line, and may write `> `
 * again. `answers` is fed one line per prompt, so a test never races ahead of
 * the readline interface.
 */
function streams(answers: string[] = []) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  const queue = [...answers];
  output.on("data", (c: Buffer) => {
    const s = c.toString();
    written.push(s);
    if (s.endsWith("> ") && queue.length) input.write(queue.shift() + "\n");
  });
  return { input, output, text: () => written.join("") };
}

const query = (over: Partial<HumanInputQuery> = {}): HumanInputQuery => ({
  runId: "run_1",
  stepRunId: "step_gate",
  requestId: "hi_1",
  kind: "decision",
  question: "Ship it?",
  options: ["ship", "hold"].map(toGateOption),
  context: {},
  ...over,
});

describe("cliHumanInput", () => {
  it("prints the question with numbered options and accepts the number", async () => {
    const { input, output, text } = streams(["2"]);
    expect(await cliHumanInput(input, output).ask(query())).toBe("hold");
    expect(text()).toContain("[orca] decision for run run_1 / step step_gate\nShip it?\n");
    expect(text()).toContain("  1. ship\n  2. hold\n");
  });

  it("accepts the option's own name, and trims what was typed", async () => {
    const { input, output } = streams(["  ship  "]);
    expect(await cliHumanInput(input, output).ask(query())).toBe("ship");
  });

  it("re-asks until the answer is one of the options", async () => {
    // maybe: not an option; 0 and 3: out of range either way; 1.5: not an integer.
    const { input, output, text } = streams(["maybe", "0", "3", "1.5", "1"]);
    expect(await cliHumanInput(input, output).ask(query())).toBe("ship");
    expect(text().match(/Please choose one of the listed options\./g)).toHaveLength(4);
  });

  it("takes free text when the question has no options", async () => {
    const { input, output, text } = streams(["because I said so"]);
    expect(await cliHumanInput(input, output).ask(query({ kind: "question", options: [] }))).toBe("because I said so");
    expect(text()).not.toContain("  1. ");
  });

  it("rejects with CANCELLED when the run is cancelled before the prompt", async () => {
    const { input, output } = streams();
    const signal = AbortSignal.abort("run cancelled");
    await expect(cliHumanInput(input, output).ask(query({ signal }))).rejects.toMatchObject({
      code: "CANCELLED",
      message: "run cancelled",
    });
  });

  it("rejects with CANCELLED when the run is cancelled while waiting for an answer", async () => {
    const { input, output } = streams();
    const ac = new AbortController();
    const answer = cliHumanInput(input, output).ask(query({ signal: ac.signal }));
    const rejects = expect(answer).rejects.toMatchObject({ code: "CANCELLED" });
    ac.abort("run cancelled");
    await rejects;
  });
});
