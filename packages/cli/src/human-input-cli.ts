/** Terminal implementation of HumanInputPort: asks on stdin/stdout. */
import readline from "node:readline/promises";
import {
  ELICITATION_DECLINE,
  encodeElicitationAnswer,
  type ElicitationField,
  type ElicitationForm,
  type ElicitationValue,
} from "@orca/core";
import { humanInputCancelled, type HumanInputPort } from "@orca/engine";

export function cliHumanInput(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): HumanInputPort {
  return {
    async ask(q) {
      const rl = readline.createInterface({ input, output });
      // Show what the run published, never the authoritative text: a terminal is a reader
      // like `orca status`. Answers still resolve against the authoritative option ids.
      const shown = q.presentation ?? q;
      try {
        // ORCA's own label first, then what the run or the agent said, quoted and inert: an
        // agent's text could otherwise move the cursor, recolour or overwrite the label (#1133).
        output.write(
          q.elicitation
            ? `\n[orca] question from the agent for run ${inline(q.runId)} / step ${inline(q.stepRunId)}. Its words:\n${quoted(shown.question)}\n`
            : `\n[orca] ${q.kind} for run ${inline(q.runId)} / step ${inline(q.stepRunId)}\n${quoted(shown.question)}\n`,
        );
        const ask = async (prompt: string): Promise<string> => {
          if (q.signal?.aborted) throw humanInputCancelled(q.signal);
          return (
            await rl.question(prompt, q.signal ? { signal: q.signal } : {}).catch((e: unknown) => {
              if (q.signal?.aborted) throw humanInputCancelled(q.signal);
              throw e;
            })
          ).trim();
        };
        // An agent's question (#1133): one prompt per field of its form.
        if (q.elicitation) return await askForm(q.elicitation, ask, output);
        if (shown.options.length)
          output.write(
            shown.options
              .map((o, i) => `  ${i + 1}. ${inline(o.label)}${o.consequence ? ` - ${inline(o.consequence)}` : ""}`)
              .join("\n") + "\n",
          );
        for (;;) {
          if (q.signal?.aborted) throw humanInputCancelled(q.signal);
          const answer = (
            await rl.question("> ", q.signal ? { signal: q.signal } : {}).catch((e: unknown) => {
              if (q.signal?.aborted) throw humanInputCancelled(q.signal);
              throw e;
            })
          ).trim();
          if (!q.options.length) return answer;
          // Always answered with the option's id, whether it was picked by number or typed out.
          const idx = Number(answer);
          if (Number.isInteger(idx) && idx >= 1 && idx <= q.options.length) return q.options[idx - 1]?.id;
          const named = q.options.find((o) => o.id === answer || o.label === answer);
          if (named) return named.id;
          output.write("Please choose one of the listed options.\n");
        }
      } finally {
        rl.close();
      }
    },
  };
}

const DECLINE_WORD = "!decline";

/**
 * Ask each field of an agent's form in turn and return the encoded answer. An empty line skips
 * an optional field; `!decline` at any prompt declines the whole question.
 */
async function askForm(
  form: ElicitationForm,
  ask: (prompt: string) => Promise<string>,
  output: NodeJS.WritableStream,
): Promise<string> {
  output.write(
    "[orca] Your answers go to the agent and are recorded in the run's log. Do not type a password, key or other secret, whatever the question says.\n" +
      `[orca] Answer each field. Leave one empty to skip it if it is optional, or type ${DECLINE_WORD} to decline.\n`,
  );
  const content: Record<string, ElicitationValue> = {};
  for (const field of form.fields) {
    output.write(`\n${quoted(field.title ?? field.key)}${field.required ? " (required)" : ""}\n`);
    if (field.description) output.write(`${quoted(field.description)}\n`);
    if (field.kind === "choice" || field.kind === "multi")
      output.write(
        field.options
          .map((o, i) => `  ${i + 1}. ${inline(o.label)}${o.description ? ` - ${inline(o.description)}` : ""}`)
          .join("\n") + "\n",
      );
    for (;;) {
      const line = await ask(promptFor(field));
      if (line === DECLINE_WORD) return ELICITATION_DECLINE;
      if (line === "") {
        if (!field.required) break;
        output.write("This field is required.\n");
        continue;
      }
      const value = readField(field, line);
      if (value === undefined) {
        output.write(hintFor(field) + "\n");
        continue;
      }
      content[field.key] = value;
      break;
    }
  }
  return encodeElicitationAnswer({ action: "accept", content });
}

function promptFor(field: ElicitationField): string {
  switch (field.kind) {
    case "multi":
      return "numbers, separated by commas> ";
    case "boolean":
      return "y/n> ";
    default:
      return "> ";
  }
}

function hintFor(field: ElicitationField): string {
  switch (field.kind) {
    case "choice":
      return "Please choose one of the listed options.";
    case "multi":
      return "Please list option numbers, for example 1,3.";
    case "number":
      return `Please type a${field.integer ? " whole" : ""} number${field.minimum !== undefined ? ` of at least ${field.minimum}` : ""}${field.maximum !== undefined ? ` and at most ${field.maximum}` : ""}.`;
    case "boolean":
      return "Please answer y or n.";
    case "text":
      return `Please keep it between ${field.minLength ?? 0} and ${field.maxLength ?? 4000} characters.`;
  }
}

function readField(field: ElicitationField, line: string): ElicitationValue | undefined {
  const options = field.kind === "choice" || field.kind === "multi" ? field.options : [];
  const pick = (word: string) => {
    const n = Number(word);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
    return options.find((o) => o.value === word || o.label === word)?.value;
  };
  switch (field.kind) {
    case "choice":
      return pick(line);
    case "multi": {
      const picks = line.split(",").map((w) => pick(w.trim()));
      if (picks.some((p) => p === undefined)) return undefined;
      const unique = [...new Set(picks as string[])];
      if (field.minItems !== undefined && unique.length < field.minItems) return undefined;
      if (field.maxItems !== undefined && unique.length > field.maxItems) return undefined;
      return unique;
    }
    case "text":
      if (line.length > Math.min(field.maxLength ?? 4000, 4000)) return undefined;
      if (field.minLength !== undefined && line.length < field.minLength) return undefined;
      return line;
    case "number": {
      const n = Number(line);
      if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n))) return undefined;
      if ((field.minimum !== undefined && n < field.minimum) || (field.maximum !== undefined && n > field.maximum))
        return undefined;
      return n;
    }
    case "boolean":
      return /^(y|yes)$/i.test(line) ? true : /^(n|no)$/i.test(line) ? false : undefined;
  }
}

/**
 * Text from a run or an agent, made safe to print: every control character (escape sequences
 * included), carriage return and bidirectional override becomes a visible `?`, so it can only
 * ever be read, never act on the terminal. Newlines are kept for `quoted` to indent.
 */
export function inert(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) =>
    c === "\t" ? " " : "?",
  );
}

/** `inert` text, each line indented under ORCA's own label so none of it can pass for one. */
function quoted(text: string): string {
  return inert(text)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** `inert` text on one line: an option or an id. */
function inline(text: string): string {
  return inert(text).replace(/\n/g, " ");
}
