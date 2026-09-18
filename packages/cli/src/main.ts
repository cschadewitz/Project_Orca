#!/usr/bin/env node
/** `orca` command line. */
import { parseArgs } from "node:util";
import { isOrcaError } from "@orca/core";
import { commands } from "./commands/index.js";

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
      plan: { type: "string" },
      status: { type: "string" },
      rationale: { type: "string" },
      workflow: { type: "string" },
      run: { type: "string" },
      json: { type: "boolean" },
      force: { type: "boolean" },
      quiet: { type: "boolean" },
      mermaid: { type: "boolean" },
      keep: { type: "boolean" },
      "no-resume": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [name, ...rest] = positionals;
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
      flags: values as Record<string, string | boolean | string[] | undefined>,
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

const invokedDirectly = process.argv[1] && /main\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) main().then((code) => process.exit(code));
