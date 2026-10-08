/** Captured CLI output and diagnostics shared by contract and process acceptance. */
import { stat } from "node:fs/promises";
import { expect } from "vitest";
import { join } from "node:path";
import { fileStores } from "@orca/store";
import { commands, type CommandContext } from "../src/commands/index.js";

export function ctx(
  cwd: string,
  positionals: string[],
  flags: CommandContext["flags"] = {},
  configPath?: string,
): CommandContext & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    cwd,
    configPath,
    flags: { quiet: true, ...flags },
    positionals,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    lines,
    errs,
  };
}

/** The temp workspace the demo announces on stderr when run without --dir. */
export function announcedDir(c: { errs: string[] }): string {
  const line = c.errs.find((l) => l.startsWith("demo workspace: "));
  expect(line).toBeDefined();
  return line!.slice("demo workspace: ".length);
}

export const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Keep the command's captured diagnostics when its workflow returns a failure code. */
export async function successfulDemo(c: ReturnType<typeof ctx>): Promise<void> {
  const code = await commands.demo!.run(c);
  const diagnostics = [...c.lines, ...c.errs];
  if (code !== 0) {
    const line = c.errs.find((value) => value.startsWith("demo workspace: "));
    const directory = line?.slice("demo workspace: ".length);
    if (directory && (await exists(join(directory, ".orca")))) {
      const stores = fileStores(join(directory, ".orca"));
      for (const runId of await stores.events.listRuns()) {
        try {
          const failures = await stores.events.readTypes(runId, ["run.failed", "step.failed", "run.completed"]);
          diagnostics.push(JSON.stringify({ runId, failures }));
        } catch {
          diagnostics.push(`Failure history unavailable for ${runId}`);
        }
      }
    }
  }
  expect(code, diagnostics.join("\n")).toBe(0);
}
