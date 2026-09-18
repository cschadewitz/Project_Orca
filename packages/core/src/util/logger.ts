/** Minimal structured logger interface; the CLI wires a console implementation. */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function consoleLogger(
  min: LogLevel = "info",
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stderr.write(l + "\n"),
): Logger {
  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[min]) return;
    const merged = { ...base, ...(fields ?? {}) };
    const extra = Object.keys(merged).length ? " " + JSON.stringify(merged) : "";
    sink(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`);
  };
  return {
    log,
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (fields) => consoleLogger(min, { ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = {
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
