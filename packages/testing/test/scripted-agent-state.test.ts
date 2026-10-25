/** Real ACP subprocesses share counters without losing entries or changing their commit boundary. */
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDeliverablesBlock } from "@orca/core";
import { LocalHost, openAcpSession, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import { scriptedAgentSpec, type PlaybookInput } from "@orca/testing";

let root: string;
let stateFile: string;
const sessions: AgentSession[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-scripted-state-"));
  stateFile = join(root, "absent-parent", "state.json");
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await rm(root, { recursive: true, force: true });
});

async function open(playbook: PlaybookInput, extra: Partial<OpenSessionOptions> = {}, persistent = true) {
  const session = await openAcpSession({
    host: new LocalHost({ id: "local", type: "local" }),
    agent: scriptedAgentSpec({
      playbookJson: playbook,
      ...(persistent ? { stateFile } : {}),
      permissions: { default: "ask", rules: [] },
    }),
    cwd: root,
    ...extra,
  });
  sessions.push(session);
  return session;
}
const prompt = (...items: [kind: string, path: string][]) =>
  renderDeliverablesBlock(items.map(([kind, path]) => ({ kind, path, required: true })));
const output = (name: string) => join(root, `${name}.md`);
const contents = (name: string) => readFile(output(name), "utf8");
const counts = async () => (JSON.parse(await readFile(stateFile, "utf8")) as { counts: Record<string, number> }).counts;
const sequence = { kinds: { "test-report": [{ content: "false:{n}" }, { content: "true:{n}" }] } };

function permissionGate() {
  let answer: ((value: string) => void) | undefined;
  return {
    askPermission: () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    reached: () => vi.waitFor(() => expect(answer).toBeDefined()),
    release: () => answer?.("allow"),
  };
}

// Permission requests are an actual awaited transport boundary after load/derive,
// so the first child holds an old snapshot while a separate child tries to commit.
describe("scripted shared state transactions", () => {
  it.each(["review", "test-report"])("serializes an awaited %s turn against another process", async (kind) => {
    const gate = permissionGate();
    const holder = await open({ default: { askPermission: true, content: "holder:{n}" } }, gate);
    const tester = await open(sequence);
    const first = holder.prompt(prompt([kind, output("holder")]));
    await gate.reached();
    let greeted = false;
    tester.onUpdate((event) => {
      if (event.summary.kind === "agent_message_chunk") greeted = true;
    });
    const second = tester.prompt(prompt(["test-report", output("test-1")]));
    let settled = false;
    void second.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let settledWhileHeld: boolean;
    try {
      await vi.waitFor(() => expect(greeted).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      settledWhileHeld = settled;
    } finally {
      gate.release();
    }
    await Promise.all([first, second]);
    expect(await contents("holder")).toBe("holder:1");
    expect(await contents("test-1")).toBe(kind === "review" ? "false:1" : "true:2");
    await tester.prompt(prompt(["test-report", output("test-2")]));
    expect(await contents("test-2")).toBe(kind === "review" ? "true:2" : "true:3");
    expect(await counts()).toEqual(kind === "review" ? { review: 1, "test-report": 2 } : { "test-report": 3 });
    expect(settledWhileHeld).toBe(false);
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes an absent state directory and keeps every same/different-kind increment across eight processes", async () => {
    const children = await Promise.all(
      Array.from({ length: 8 }, () => open({ default: { content: "{n}", delayMs: 30 } })),
    );
    await Promise.all(
      children.map((session, i) => session.prompt(prompt([i % 2 ? "review" : "test-report", output(String(i))]))),
    );
    for (const parity of [0, 1]) {
      const numbers = await Promise.all(
        children.filter((_, i) => i % 2 === parity).map((_, i) => contents(String(i * 2 + parity))),
      );
      expect(numbers.map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    }
    expect(await counts()).toEqual({ review: 4, "test-report": 4 });
  });

  it("rolls back the whole prompt's counters on a write error, releases the mutex and replays the entries", async () => {
    const session = await open({ default: { content: "{kind}:{n}" } });
    await expect(session.prompt(prompt(["spec", output("written")], ["review", root]))).rejects.toThrow();
    expect(await contents("written")).toBe("spec:1");
    await expect(stat(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    const retry = await open({ default: { content: "{kind}:{n}" } });
    await retry.prompt(prompt(["spec", output("retry")], ["review", output("review")]));
    expect(await contents("retry")).toBe("spec:1");
    expect(await contents("review")).toBe("review:1");
    expect(await counts()).toEqual({ spec: 1, review: 1 });
  });

  it("leaves an entry unconsumed when cancelled before its write and releases for a new process", async () => {
    const session = await open({
      configOptions: [{ type: "boolean", id: "marker", name: "Marker", currentValue: false }],
      default: { delayMs: 5000, setConfig: { configId: "marker", value: true } },
    });
    let sleeping = false;
    session.onUpdate((event) => {
      if (event.summary.kind === "config_option_update") sleeping = true;
    });
    const turn = session.prompt(prompt(["test-report", output("cancelled")]));
    await vi.waitFor(() => expect(sleeping).toBe(true));
    await session.cancel();
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    expect(await counts()).toEqual({});
    await expect(stat(output("cancelled"))).rejects.toMatchObject({ code: "ENOENT" });
    const retry = await open(sequence);
    await retry.prompt(prompt(["test-report", output("retry")]));
    expect(await contents("retry")).toBe("false:1");
  });

  it("commits earlier entries when cancellation skips the next deliverable", async () => {
    const session = await open({
      configOptions: [{ type: "boolean", id: "marker", name: "Marker", currentValue: false }],
      kinds: { review: [{ delayMs: 5000, setConfig: { configId: "marker", value: true } }] },
      default: { content: "{n}" },
    });
    let sleeping = false;
    session.onUpdate((event) => {
      if (event.summary.kind === "config_option_update") sleeping = true;
    });
    const turn = session.prompt(prompt(["spec", output("spec")], ["review", output("review")]));
    await vi.waitFor(() => expect(sleeping).toBe(true));
    await session.cancel();
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    expect(await counts()).toEqual({ spec: 1 });
    expect(await contents("spec")).toBe("1");
    await expect(stat(output("review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honours cancellation received while waiting for another process's transaction", async () => {
    const gate = permissionGate();
    const holder = await open({ default: { askPermission: true } }, gate);
    const waiter = await open(sequence);
    const first = holder.prompt(prompt(["review", output("holder")]));
    await gate.reached();
    let greeted = false;
    waiter.onUpdate(() => {
      greeted = true;
    });
    const second = waiter.prompt(prompt(["test-report", output("waiter")]));
    try {
      await vi.waitFor(() => expect(greeted).toBe(true));
      await waiter.cancel();
    } finally {
      gate.release();
    }
    await first;
    expect(await second).toMatchObject({ stopReason: "cancelled" });
    expect(await counts()).toEqual({ review: 1 });
    await expect(stat(output("waiter"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still consumes skipped, denied and completed entries returning cancelled", async () => {
    const session = await open(
      {
        kinds: { skipped: [{ skip: true }], denied: [{ askPermission: true }] },
        default: { content: "{n}", stopReason: "cancelled" },
      },
      { askPermission: async () => "deny" },
    );
    expect(
      await session.prompt(
        prompt(["skipped", output("skip")], ["denied", output("deny")], ["review", output("review")]),
      ),
    ).toMatchObject({ stopReason: "cancelled" });
    expect(await counts()).toEqual({ skipped: 1, denied: 1, review: 1 });
    await expect(stat(output("skip"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(output("deny"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await contents("review")).toBe("1");
  });

  it("still consumes an entry when cancellation arrives during its permission response", async () => {
    const gate = permissionGate();
    const session = await open({ default: { askPermission: true } }, gate);
    const turn = session.prompt(prompt(["review", output("review")]));
    await gate.reached();
    await session.cancel();
    await turn;
    expect(await counts()).toEqual({ review: 1 });
    await expect(stat(output("review"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases on a failed state save without reserving a counter", async () => {
    await mkdir(stateFile, { recursive: true });
    const session = await open({ default: { content: "{n}" } });
    await expect(session.prompt(prompt(["review", output("first")]))).rejects.toThrow();
    expect(await contents("first")).toBe("1");
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(stateFile, { recursive: true });
    await session.prompt(prompt(["review", output("retry")]));
    expect(await contents("retry")).toBe("1");
    expect(await counts()).toEqual({ review: 1 });
  });

  it("recovers the existing mutex after a hung holder process is terminated", async () => {
    const holder = await open({ default: { hang: true } });
    let hanging = false;
    holder.onUpdate((event) => {
      if (event.summary.text?.includes("Hanging on")) hanging = true;
    });
    const turn = holder.prompt(prompt(["test-report", output("hung")]));
    void turn.catch(() => undefined);
    await vi.waitFor(() => expect(hanging).toBe(true));
    expect((await stat(`${stateFile}.lock`)).isDirectory()).toBe(true);
    await holder.close();
    await expect(turn).rejects.toThrow();
    const retry = await open(sequence);
    await retry.prompt(prompt(["test-report", output("retry")]));
    expect(await contents("retry")).toBe("false:1");
    expect(await counts()).toEqual({ "test-report": 1 });
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the prior reset behavior without a state file", async () => {
    const session = await open(sequence, {}, false);
    await session.prompt(prompt(["test-report", output("first")]));
    await session.prompt(prompt(["test-report", output("second")]));
    expect(await contents("first")).toBe("false:1");
    expect(await contents("second")).toBe("false:1");
    await expect(stat(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create state or locks for a prompt without deliverables", async () => {
    const session = await open(sequence);
    await session.prompt("No deliverables here.");
    await expect(stat(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
