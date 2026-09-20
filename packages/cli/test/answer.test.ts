/** `orca run` parks at a gate and exits; `orca answer` (a separate bootstrap, like another process) resumes it. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commands, type CommandContext } from "../src/commands/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ctx(
  cwd: string,
  positionals: string[],
  flags: CommandContext["flags"] = {},
): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return { cwd, flags: { quiet: true, ...flags }, positionals, out: (l) => lines.push(l), err: () => {}, lines };
}

describe("orca answer", () => {
  it("answers a paused run from a fresh process and follows it to completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-answer-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: [gated.yaml]\ntemplates: []\n", "utf8");
    await writeFile(
      join(dir, "gated.yaml"),
      `
id: gated
name: gated
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  shipped: { type: end }
  held: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: shipped, when: "choice == 'ship'" }
  - { from: gate, to: held }
`,
      "utf8",
    );

    // Default humanInput mode is `pause`: the run parks and the command exits with 3 and a hint.
    const run = ctx(dir, ["gated"]);
    expect(await commands.run!.run(run)).toBe(3);
    const text = run.lines.join("\n");
    expect(text).toMatch(/status=paused/);
    expect(text).toMatch(/orca answer hi_\S+ <ship\|hold>/);
    const runId = /^run (run_\S+)/m.exec(text)![1]!;

    const list = ctx(dir, []);
    expect(await commands.answer!.run(list)).toBe(0);
    expect(list.lines).toHaveLength(1);
    const requestId = list.lines[0]!.split(/\s+/)[0]!;
    expect(list.lines[0]).toContain(`run=${runId}`);

    await expect(commands.answer!.run(ctx(dir, [requestId, "maybe"]))).rejects.toThrow(/not one of/);

    const answer = ctx(dir, [requestId, "ship"]);
    expect(await commands.answer!.run(answer)).toBe(0);
    expect(answer.lines[0]).toBe(`answered ${requestId} (run ${runId}): ship`);
    expect(answer.lines.join("\n")).toMatch(/status=completed\/success/);

    const status = ctx(dir, [runId]);
    expect(await commands.status!.run(status)).toBe(0);
    expect(status.lines.join("\n")).toMatch(/completed +gate +gate +attempt=2 choice=ship/);

    const nothing = ctx(dir, []);
    await commands.answer!.run(nothing);
    expect(nothing.lines).toEqual(["no open questions"]);
  });

  it("puts `--note` in the run's log beside the answer (#238)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-answer-note-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: [gated.yaml]\ntemplates: []\n", "utf8");
    await writeFile(
      join(dir, "gated.yaml"),
      `
id: gated
name: gated
start: s
nodes:
  s: { type: start }
  gate:
    type: gate
    question: "Ship it?"
    options:
      - { id: ship, label: "Ship it", consequence: "The release goes out." }
      - hold
  shipped: { type: end }
  held: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: shipped, when: "choice == 'ship'" }
  - { from: gate, to: held }
`,
      "utf8",
    );
    const run = ctx(dir, ["gated"]);
    expect(await commands.run!.run(run)).toBe(3);
    const requestId = /(hi_\S+)/.exec(run.lines.join("\n"))![1]!;

    const answer = ctx(dir, [requestId, "ship"], { quiet: true, note: "the staging soak is green again" });
    expect(await commands.answer!.run(answer)).toBe(0);

    // `events` is the whole of the claim: the note is in the run's log, not in a logger.
    const events = ctx(dir, [/(run_\S+)/.exec(run.lines.join("\n"))![1]!], { quiet: true, json: true });
    expect(await commands.events!.run(events)).toBe(0);
    const answered = events.lines
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> })
      .find((e) => e.type === "human.answered")!;
    expect(answered.payload).toMatchObject({ answer: "ship", note: "the staging soak is green again" });
  });
});
