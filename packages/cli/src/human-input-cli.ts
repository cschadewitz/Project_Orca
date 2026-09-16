/** Terminal implementation of HumanInputPort: asks on stdin/stdout. */
import readline from "node:readline/promises";
import { humanInputCancelled, type HumanInputPort } from "@orca/engine";

export function cliHumanInput(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): HumanInputPort {
  return {
    async ask(q) {
      const rl = readline.createInterface({ input, output });
      try {
        output.write(`\n[orca] ${q.kind} for run ${q.runId} / step ${q.stepRunId}\n${q.question}\n`);
        if (q.options.length) output.write(q.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n") + "\n");
        for (;;) {
          if (q.signal?.aborted) throw humanInputCancelled(q.signal);
          const answer = (await rl.question("> ", q.signal ? { signal: q.signal } : {}).catch((e: unknown) => {
            if (q.signal?.aborted) throw humanInputCancelled(q.signal);
            throw e;
          })).trim();
          if (!q.options.length) return answer;
          const idx = Number(answer);
          if (Number.isInteger(idx) && idx >= 1 && idx <= q.options.length) return q.options[idx - 1];
          if (q.options.includes(answer)) return answer;
          output.write("Please choose one of the listed options.\n");
        }
      } finally {
        rl.close();
      }
    },
  };
}
