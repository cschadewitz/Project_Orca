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
 * Split JSONL text into its non-blank lines, trimmed. Whitespace-only lines
 * are skipped and a trailing `\r` is tolerated so CRLF files read the same as
 * LF ones. Use this when a caller wants to inspect the raw line before paying
 * for `JSON.parse`.
 */
export function splitJsonlLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** Parse JSONL text into records, with the same line handling as {@link splitJsonlLines}. */
export function parseJsonl<T>(text: string, parser: JsonlParser<T>): T[] {
  return splitJsonlLines(text).map((line) => parser.parse(JSON.parse(line)));
}

/** Read a JSONL file's non-blank lines without parsing them. A missing file reads as empty. */
export async function readJsonlLines(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return splitJsonlLines(text);
}

/** Read and parse a JSONL file. A missing file reads as empty. */
export async function readJsonl<T>(file: string, parser: JsonlParser<T>): Promise<T[]> {
  return (await readJsonlLines(file)).map((line) => parser.parse(JSON.parse(line)));
}

/** Append one record as a single line. The parent directory must exist. */
export function appendJsonl(file: string, value: unknown): Promise<void> {
  return appendFile(file, JSON.stringify(value) + "\n", "utf8");
}
