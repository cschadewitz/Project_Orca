/** Fixed-format parsers. They never retain source text or paths in errors. */
export class SourceError extends Error {
  constructor(public readonly reason: "invalid-source" | "unsupported-source" | "scope-unverified") {
    super(reason);
  }
}
export function natural(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new SourceError("invalid-source");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new SourceError("invalid-source");
  return n;
}
export function safe(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SourceError("invalid-source");
  return value;
}
export function cpuCounters(text: string) {
  const lines = text.trim().split("\n");
  const fields = lines
    .find((l) => l.startsWith("cpu "))
    ?.trim()
    .split(/\s+/)
    .slice(1);
  if (!fields || fields.length < 8) throw new SourceError("invalid-source");
  // guest and guest_nice are already included in user and nice.
  const values = fields.slice(0, 8).map(natural);
  const logicalCores = lines.filter((l) => /^cpu\d+\s/.test(l)).length;
  if (logicalCores === 0) throw new SourceError("invalid-source");
  return { total: safe(values.reduce((a, b) => a + b, 0)), idle: safe(values[3]! + values[4]!), logicalCores };
}
function meminfoValue(text: string, key: string): number {
  const matches = text.split("\n").filter((line) => line.startsWith(`${key}:`));
  if (matches.length !== 1) throw new SourceError("invalid-source");
  const match = /^\w+:\s+(\d+) kB$/.exec(matches[0]!.trim());
  return safe(natural(match?.[1]) * 1024);
}
export function availableMemory(text: string) {
  const totalBytes = meminfoValue(text, "MemTotal"),
    availableBytes = meminfoValue(text, "MemAvailable"),
    freeBytes = meminfoValue(text, "MemFree");
  if (freeBytes > totalBytes || availableBytes > totalBytes) throw new SourceError("invalid-source");
  return { totalBytes, availableBytes, freeBytes };
}
export function swapMemory(text: string) {
  const totalBytes = meminfoValue(text, "SwapTotal"),
    free = meminfoValue(text, "SwapFree");
  if (free > totalBytes) throw new SourceError("invalid-source");
  return { totalBytes, usedBytes: totalBytes - free };
}
export function memoryCounters(text: string) {
  return { memory: availableMemory(text), swap: swapMemory(text) };
}
export function swapCounters(text: string) {
  const read = (key: string) => natural(new RegExp(`^${key} (\\d+)$`, "m").exec(text)?.[1]);
  return { input: read("pswpin"), output: read("pswpout") };
}
export function cpusetCount(text: string): number {
  const ranges = text
    .trim()
    .split(",")
    .map((part) => {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!match) throw new SourceError("invalid-source");
      const start = natural(match[1]),
        end = natural(match[2] ?? match[1]);
      if (end < start) throw new SourceError("invalid-source");
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i]!.start <= ranges[i - 1]!.end) throw new SourceError("invalid-source");
  return safe(ranges.reduce((sum, r) => sum + r.end - r.start + 1, 0));
}
export function quota(text: string): number | null {
  const [amount, period, extra] = text.trim().split(/\s+/);
  const p = natural(period);
  if (p === 0 || extra !== undefined) throw new SourceError("invalid-source");
  if (amount === "max") return null;
  const q = natural(amount);
  if (q === 0) throw new SourceError("invalid-source");
  return q / p;
}
