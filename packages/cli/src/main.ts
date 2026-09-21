#!/usr/bin/env node
/** `orca` command line. */
import { parseArgs } from "node:util";
import { consoleLogger, describeError, isOrcaError, type Logger } from "@orca/core";
import { commands, ORCA_VERSION } from "./commands/index.js";

const USAGE = `orca - Orchestration Runtime for Coding Agents

usage: orca <command> [options]

commands:
${Object.values(commands)
  .map((c) => "  " + c.help)
  .join("\n")}

global options:
  --config <file>    orca.config.yaml to use (default: nearest one upwards from cwd)
  --cwd <dir>        working directory (default: process cwd)
  --help             show this help
  --version          print the ORCA version and exit
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      config: { type: "string" },
      cwd: { type: "string" },
      var: { type: "string", multiple: true },
      body: { type: "string" },
      "body-file": { type: "string" },
      dir: { type: "string" },
      "log-level": { type: "string" },
      note: { type: "string" },
      plan: { type: "string" },
      status: { type: "string" },
      rationale: { type: "string" },
      workflow: { type: "string" },
      run: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      json: { type: "boolean" },
      force: { type: "boolean" },
      quiet: { type: "boolean" },
      mermaid: { type: "boolean" },
      keep: { type: "boolean" },
      "no-resume": { type: "boolean" },
      "read-only": { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  const [name, ...rest] = positionals;
  // Before the command lookup and before `--help`: `orca --version` is a question about the
  // installation, not about a command, and it was answered with the usage text and exit 1
  // until now — `strict: false` made an undeclared `--version` a flag nobody read (#229).
  // Only bare, though: with a command named, the flag is that command's to interpret.
  if (values.version && !name) {
    process.stdout.write(ORCA_VERSION + "\n");
    return 0;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!name) {
    process.stderr.write(USAGE);
    return 1;
  }
  const command = commands[name];
  if (!command) {
    process.stderr.write(`unknown command '${name}'\n\n${USAGE}`);
    return 1;
  }
  try {
    return await command.run({
      cwd: (values.cwd as string | undefined) ?? process.cwd(),
      configPath: values.config as string | undefined,
      flags: values,
      positionals: rest,
      out: (l) => process.stdout.write(l + "\n"),
      err: (l) => process.stderr.write(l + "\n"),
    });
  } catch (e) {
    if (isOrcaError(e)) {
      process.stderr.write(`error [${e.code}]: ${e.message}\n`);
      if (e.details) process.stderr.write(JSON.stringify(e.details, null, 2) + "\n");
    } else process.stderr.write(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 1;
  }
}

/**
 * Catch what escapes a command: a rejection nobody observed, or a throw off a callback.
 * Node's default for either is to kill the process, which for `orca serve` means one run's
 * failed append lapses the lease of every other run it drives (#268). So the daemon logs and
 * keeps serving, while a one-shot command logs and exits non-zero, its result no longer
 * being something to trust. Installed once, by the entry point, for every command alike.
 */
export function installProcessErrorHandlers(options: {
  /** True for `orca serve`: log and carry on rather than exiting. */
  keepRunning: boolean;
  logger?: Logger;
  exit?: (code: number) => void;
}): void {
  const logger = options.logger ?? consoleLogger("info", { component: "cli" });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const report = (what: string, e: unknown): void => {
    logger.error(what, { error: describeError(e), ...(options.keepRunning ? { serving: true } : {}) });
    if (!options.keepRunning) exit(1);
  };
  process.on("unhandledRejection", (reason: unknown) => report("unhandled rejection", reason));
  process.on("uncaughtException", (e: unknown) => report("uncaught exception", e));
}

const invokedDirectly = process.argv[1] && /main\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  // Before the parse, because a handler installed after the thing it would have caught is
  // no handler at all. `serve` anywhere in the arguments is the daemon: mistaking a flag's
  // value for it only means logging and carrying on, which is the safer way to be wrong.
  installProcessErrorHandlers({ keepRunning: process.argv.slice(2).includes("serve") });
  void main().then((code) => process.exit(code));
}
