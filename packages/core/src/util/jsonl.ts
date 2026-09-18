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

export interface JsonlReadOptions {
  /**
   * Called with a line that is not JSON - typically the torn tail a process
   * left behind when it died mid-append - and the line is skipped. Without a
   * handler the read throws, as `JSON.parse` would. Only malformed JSON goes
   * here: a well-formed record the parser rejects still throws, because that
   * is a schema problem, not a damaged file.
   */
  onCorrupt?: (line: string, error: unknown) => void;
}

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

/** Parse one line as produced by {@link splitJsonlLines}; `undefined` when it is corrupt and `onCorrupt` absorbed it. */
export function parseJsonlLine<T>(line: string, parser: JsonlParser<T>, options?: JsonlReadOptions): T | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    if (!options?.onCorrupt) throw e;
    options.onCorrupt(line, e);
    return undefined;
  }
  return parser.parse(raw);
}

/** Parse JSONL text into records, with the same line handling as {@link splitJsonlLines}. */
export function parseJsonl<T>(text: string, parser: JsonlParser<T>, options?: JsonlReadOptions): T[] {
  const out: T[] = [];
  for (const line of splitJsonlLines(text)) {
    const record = parseJsonlLine(line, parser, options);
    if (record !== undefined) out.push(record);
  }
  return out;
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
export async function readJsonl<T>(file: string, parser: JsonlParser<T>, options?: JsonlReadOptions): Promise<T[]> {
  const out: T[] = [];
  for (const line of await readJsonlLines(file)) {
    const record = parseJsonlLine(line, parser, options);
    if (record !== undefined) out.push(record);
  }
  return out;
}

/**
 * Append one record as a single line. The parent directory must exist.
 *
 * This is a plain `O_APPEND` write, which keeps *one* process's lines whole
 * and in order but says nothing about two processes appending to the same
 * file: Node may issue several `write(2)` calls for one line, and the kernel
 * only positions each call atomically. Callers that share a file across
 * processes serialise their appends themselves - the store's `JsonlLogDir`
 * takes a lock file around every append for exactly that reason.
 */
export function appendJsonl(file: string, value: unknown): Promise<void> {
  return appendFile(file, JSON.stringify(value) + "\n", "utf8");
}
