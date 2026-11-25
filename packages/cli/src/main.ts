#!/usr/bin/env node
/** `orca` command line. */
import { parseArgs } from "node:util";
import { consoleLogger, describeError, isOrcaError, type Logger } from "@orca/core";
import { isProtocolFault } from "@orca/protocol";
import { commands, ORCA_VERSION } from "./commands/index.js";
import { assertClosedUpdateCommand, enterCommandUpdateBootstrap } from "./update-bootstrap.js";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const USAGE = `orca - orchestration for coding agents

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

const OPTIONS = {
  config: { type: "string" },
  endpoint: { type: "string" },
  "token-env": { type: "string" },
  cwd: { type: "string" },
  var: { type: "string", multiple: true },
  "var-json": { type: "string", multiple: true },
  "workflow-version": { type: "string" },
  "expected-workflow-revision": { type: "string" },
  "trusted-proxy": { type: "string", multiple: true },
  "allow-origin": { type: "string", multiple: true },
  "unauthenticated-loopback": { type: "boolean" },
  preset: { type: "string" },
  label: { type: "string" },
  "workflow-scope": { type: "string", multiple: true },
  secret: { type: "string", multiple: true },
  "mcp-server": { type: "string", multiple: true },
  skill: { type: "string", multiple: true },
  "judge-disclosure": { type: "boolean" },
  "judge-disclosure-kind": { type: "string", multiple: true },
  "host-key": { type: "string", multiple: true },
  "jump-host-key": { type: "string", multiple: true },
  issue: { type: "boolean" },
  "runs-scope": { type: "string" },
  "expires-at": { type: "string" },
  agent: { type: "string", multiple: true },
  model: { type: "string", multiple: true },
  "item-workflow": { type: "string" },
  "template-pack": { type: "string" },
  body: { type: "string" },
  "body-file": { type: "string" },
  "idempotency-key": { type: "string" },
  dir: { type: "string" },
  "log-level": { type: "string" },
  note: { type: "string" },
  checkpoint: { type: "string" },
  plan: { type: "string" },
  status: { type: "string" },
  rationale: { type: "string" },
  workflow: { type: "string" },
  run: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "ssh-port": { type: "string" },
  identity: { type: "string" },
  confirm: { type: "string" },
  json: { type: "boolean" },
  force: { type: "boolean" },
  quiet: { type: "boolean" },
  mermaid: { type: "boolean" },
  keep: { type: "boolean" },
  "run-again": { type: "boolean" },
  abandon: { type: "boolean" },
  "no-resume": { type: "boolean" },
  "read-only": { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
} as const;

/**
 * `orca auth rotate|revoke <id>` with an id that starts with `-` (ids issued before
 * 0.8.0 could): the parser would read it as an unknown option, so move it behind a `--`.
 * The walk follows the parser: declared options are skipped with their values, and only
 * when the first two positionals are `auth` and `rotate`/`revoke` is the next token that
 * is not a declared option, and has the exact credential-id shape, moved. Anything else,
 * and argv that already has a `--`, is left alone. An old id that is itself a declared
 * option name (such as `--expires-at`) still needs the explicit `orca auth revoke -- <id>`.
 */
export function credentialIdLast(argv: string[]): string[] {
  if (argv.includes("--")) return argv;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = [arg.slice(2).split("=")[0]!, arg.includes("=")];
      const declared = (OPTIONS as Record<string, { type: string }>)[name];
      if (declared) {
        if (declared.type === "string" && !inline) i++; // its value, whatever it looks like
        continue;
      }
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      if (positionals.length > 2) return argv;
      continue;
    }
    // Not a declared option: the id we are looking for, or something the parser will refuse.
    const command = positionals[0] === "auth" && (positionals[1] === "rotate" || positionals[1] === "revoke");
    if (!command || positionals.length !== 2 || !/^-[A-Za-z0-9_-]{11}$/.test(arg)) return argv;
    return [...argv.slice(0, i), ...argv.slice(i + 1), "--", arg];
  }
  return argv;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: credentialIdLast(argv),
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
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
      if (name && !commands[name]) {
        process.stderr.write(`unknown command '${name}'\n\n${USAGE}`);
        return 1;
      }
      process.stdout.write(
        name
          ? `usage: orca ${commands[name]!.help}\n\n${commands[name]!.usage ?? ""}\nGlobal options: --config <file>, --cwd <dir>, --help\n`
          : USAGE,
      );
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
    assertClosedUpdateCommand(name, values);
    await enterCommandUpdateBootstrap([
      values.cwd ?? process.cwd(),
      ...(values.config ? [dirname(resolve(values.config))] : []),
      ...(values.dir ? [resolve(values.dir)] : []),
      resolve(homedir(), ".orca"),
    ]);
    return await command.run({
      cwd: values.cwd ?? process.cwd(),
      configPath: values.config,
      flags: values,
      positionals: rest,
      out: (l) => process.stdout.write(l + "\n"),
      err: (l) => process.stderr.write(l + "\n"),
    });
  } catch (e) {
    if (isOrcaError(e) || isProtocolFault(e)) {
      process.stderr.write(`error [${e.code}]: ${e.message}\n`);
      if (e.details) process.stderr.write(JSON.stringify(e.details, null, 2) + "\n");
    } else process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
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
