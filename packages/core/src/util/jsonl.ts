/**
 * Newline-delimited JSON files. Every JSONL reader/writer in the repo goes
 * through here so blank-line, CRLF and missing-file handling stay consistent
 * between the event log, the artifact index and the test fixtures.
 */
import { appendFile, readFile } from "node:fs/promises";

/** Anything with a zod-style `parse`; a zod schema fits as-is. */
export interface JsonlParser<T> {
  parse(raw: unknown): T;
}

/** Accept any JSON value unchanged, for logs no schema describes. */
export const anyJson: JsonlParser<unknown> = { parse: (raw) => raw };

/**
 * Parse JSONL text into records. Whitespace-only lines are skipped and a
 * trailing `\r` is tolerated so CRLF files read the same as LF ones.
 */
export function parseJsonl<T>(text: string, parser: JsonlParser<T>): T[] {
  const out: T[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    out.push(parser.parse(JSON.parse(line)));
  }
  return out;
}

/** Read and parse a JSONL file. A missing file reads as empty. */
export async function readJsonl<T>(file: string, parser: JsonlParser<T>): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return parseJsonl(text, parser);
}

/** Append one record as a single line. The parent directory must exist. */
export function appendJsonl(file: string, value: unknown): Promise<void> {
  return appendFile(file, JSON.stringify(value) + "\n", "utf8");
}
