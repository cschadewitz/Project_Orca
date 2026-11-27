/**
 * An agent's question (#1133) at the terminal prompt: one prompt per field of its form, the
 * answer encoded as the form's content, `!decline` declining the whole question.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ELICITATION_DECLINE, parseElicitationAnswer, type ElicitationForm } from "@orca/core";
import type { HumanInputQuery } from "@orca/engine";
import { cliHumanInput } from "../src/human-input-cli.js";

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

const form: ElicitationForm = {
  message: "Which database?",
  fields: [
    {
      key: "db",
      kind: "choice",
      title: "Database",
      required: true,
      options: [
        { value: "pg", label: "Postgres", description: "Relational" },
        { value: "sqlite", label: "SQLite" },
      ],
    },
    {
      key: "extras",
      kind: "multi",
      required: false,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    { key: "note", kind: "text", required: false },
    { key: "replicas", kind: "number", integer: true, minimum: 1, required: false },
    { key: "backups", kind: "boolean", required: false },
  ],
};

const query = (): HumanInputQuery => ({
  runId: "run_1",
  stepRunId: "step_1",
  requestId: "hi_1",
  kind: "question",
  question: form.message,
  options: [],
  elicitation: form,
  context: { elicitation: form },
});

describe("cliHumanInput, an agent's question", () => {
  it("asks each field and answers with the form's content", async () => {
    // Required field left empty first, then a pick by number; the number is re-asked until whole.
    const { input, output, text } = streams(["", "1", "2,1", "with pgvector", "1.5", "2", "y"]);
    const answer = await cliHumanInput(input, output).ask(query());
    expect(parseElicitationAnswer(form, answer!)).toEqual({
      action: "accept",
      content: { db: "pg", extras: ["b", "a"], note: "with pgvector", replicas: 2, backups: true },
    });
    expect(text()).toContain("  Database (required)\n  1. Postgres - Relational\n  2. SQLite\n");
    expect(text()).toContain("This field is required.");
    expect(text()).toContain("Please type a whole number of at least 1.");
  });

  it("skips optional fields left empty", async () => {
    const { input, output } = streams(["SQLite", "", "", "", ""]);
    const answer = await cliHumanInput(input, output).ask(query());
    expect(parseElicitationAnswer(form, answer!)).toEqual({ action: "accept", content: { db: "sqlite" } });
  });

  it("declines the whole question on !decline", async () => {
    const { input, output } = streams(["!decline"]);
    expect(await cliHumanInput(input, output).ask(query())).toBe(ELICITATION_DECLINE);
  });

  it("labels the question as the agent's and warns before any input", async () => {
    const { input, output, text } = streams(["!decline"]);
    await cliHumanInput(input, output).ask(query());
    const shown = text();
    const warning = shown.indexOf("Your answers go to the agent and are recorded in the run's log.");
    expect(shown).toContain(
      "[orca] question from the agent for run run_1 / step step_1. Its words:\n  Which database?\n",
    );
    expect(warning).toBeGreaterThan(0);
    expect(shown).toContain("Do not type a password, key or other secret, whatever the question says.");
    expect(warning).toBeLessThan(shown.indexOf("> "));
  });

  it("prints the agent's text inert: no escape sequence, carriage return or override reaches the terminal", async () => {
    const hostile: ElicitationForm = {
      message: "Pick\u001b[2J\u001b]0;owned\u0007 one\r[orca] fake label\nsecond line",
      fields: [
        {
          key: "k",
          kind: "choice",
          title: "T\u001b[31mred",
          description: "D\u202eesrever",
          required: false,
          options: [{ value: "v", label: "L\u009b1m\nx", description: "\u0008back" }],
        },
      ],
    };
    const { input, output, text } = streams(["!decline"]);
    await cliHumanInput(input, output).ask({ ...query(), question: hostile.message, elicitation: hostile });
    const shown = text();
    // eslint-disable-next-line no-control-regex
    expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
    expect(shown).toContain("  Pick?[2J?]0;owned? one?[orca] fake label\n  second line\n");
    expect(shown).toContain("  T?[31mred");
    expect(shown).toContain("  D?esrever");
    expect(shown).toContain("  1. L?1m x - ?back");
  });
});
