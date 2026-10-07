/** Failure-only restart evidence; never retain URLs, headers, bodies, messages, paths or owner identities. */
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ProductionFixture } from "./mcp-operator-production-fixture.js";

const names = ["AbortError", "TimeoutError", "TypeError", "Error", "OTHER"] as const;
const codes = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "OTHER",
] as const;
const Cause = z.strictObject({ name: z.enum(names), code: z.enum(codes) });
const Observation = z.strictObject({
  request: z.number().int().min(1).max(64),
  outcome: z.enum(["started", "headers", "error"]),
  elapsedMs: z.number().int().min(0).max(3_600_000),
  status: z.number().int().min(100).max(599).optional(),
  causes: z.array(Cause).max(6).optional(),
});
const prefix = "ORCA_TEST_TRANSPORT ";

/** Observes the existing transport, without replacing fetch, altering arguments or handling its errors. */
export const transportObserverSource = `
import { channel } from 'node:diagnostics_channel';
const names = ${JSON.stringify(names)};
const codes = ${JSON.stringify(codes)};
const starts = new WeakMap();
let count = 0;
const emit = (value) => {
  try { process.stderr.write(${JSON.stringify(prefix)} + JSON.stringify(value) + '\\n'); } catch {}
};
channel('undici:request:create').subscribe(({request}) => {
  try {
    if (count >= 64) return;
    const record = {request: ++count, at: performance.now()};
    starts.set(request, record);
    emit({request: record.request, outcome: 'started', elapsedMs: 0});
  } catch {}
});
for (const outcome of ['headers', 'error']) {
  channel('undici:request:' + outcome).subscribe(({request, response, error}) => {
    try {
      const record = starts.get(request);
      if (!record) return;
      starts.delete(request);
      const value = {request: record.request, outcome, elapsedMs: Math.min(3600000, Math.max(0, Math.round(performance.now() - record.at)))};
      if (outcome === 'headers') value.status = response.statusCode;
      else {
        value.causes = [];
        const seen = new Set();
        while (error && typeof error === 'object' && !seen.has(error) && value.causes.length < 6) {
          seen.add(error);
          value.causes.push({name: names.includes(error.name) ? error.name : 'OTHER', code: codes.includes(error.code) ? error.code : 'OTHER'});
          error = error.cause;
        }
      }
      emit(value);
    } catch {}
  });
}`;

/** Revalidate child records and bound partial lines; arbitrary stderr is discarded. */
export class ReplayDiagnostics {
  private partial = "";
  private observations: z.infer<typeof Observation>[] = [];
  readonly stages: { stage: "stop" | "boot" | "connect" | "replay"; elapsedMs: number }[] = [];
  private discarded = false;

  readonly capture = (chunk: Buffer) => {
    for (const character of chunk.toString()) {
      if (character === "\n") {
        if (!this.discarded && this.partial.startsWith(prefix)) {
          try {
            const record = Observation.safeParse(JSON.parse(this.partial.slice(prefix.length)));
            if (record.success) this.observations = [...this.observations, record.data].slice(-16);
          } catch {
            /* Not a diagnostic record. */
          }
        }
        this.partial = "";
        this.discarded = false;
      } else if (!this.discarded) {
        if (this.partial.length >= 2048) {
          this.partial = "";
          this.discarded = true;
        } else this.partial += character;
      }
    }
  };

  async measure<T>(stage: "stop" | "boot" | "connect" | "replay", action: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try {
      return await action();
    } finally {
      this.stages.push({ stage, elapsedMs: Math.round(performance.now() - at) });
    }
  }

  async evidence(
    fixture: ProductionFixture,
    previousDaemon: ProductionFixture["daemon"],
    operationId: string,
    runId: string,
  ) {
    const paths = [
      ["retry-catalog", join(fixture.dir, "state/admission-retries/catalog.lock")],
      ["retry-operation", join(fixture.dir, "state/admission-retries", `${operationId}.lock`)],
      ["run-events", join(fixture.dir, "state/runs", `${runId}.jsonl.lock`)],
      [
        "run-lease-mutation",
        join(fixture.dir, "state/leases", `${encodeURIComponent(`run:${runId}`)}.json.mutation.lock`),
      ],
    ] as const;
    const daemon = (child: ProductionFixture["daemon"]) => ({ exitCode: child.exitCode, signal: child.signalCode });
    // Local reads only; a diagnostic failure must never replace the original failure or delay cleanup unboundedly.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const locks = await Promise.race([
        Promise.all(
          paths.map(async ([role, path]) => ({
            role,
            ...(await lockMetadata(path, previousDaemon.pid, fixture.daemon.pid)),
          })),
        ),
        new Promise<"unavailable">((resolve) => {
          timer = setTimeout(() => resolve("unavailable"), 500);
        }),
      ]);
      return {
        stages: this.stages,
        transport: this.observations,
        previousDaemon: daemon(previousDaemon),
        currentDaemon: daemon(fixture.daemon),
        locks,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read at most two entries and 2 KiB plus an oversize sentinel; never follow symlinks or block on special owners. */
export async function lockMetadata(path: string, previousPid?: number, currentPid?: number) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return { state: info.isSymbolicLink() ? "symlink" : "non-directory" };
    const dir = await opendir(path);
    let name: string | undefined;
    let entries = 0;
    try {
      for await (const entry of dir) {
        entries++;
        name ??= entry.name;
        if (entries === 2) break;
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    if (entries !== 1 || !/^owner\.\d+\.[a-f0-9-]+\.json$/.test(name ?? ""))
      return { state: "directory", entries, owner: "unavailable" };
    // A FIFO can otherwise occupy a filesystem worker before fstat rejects it;
    // the diagnostic deadline does not cancel that open or free workers for cleanup.
    // Windows has no O_NONBLOCK flag or filesystem FIFOs; still validate the opened handle.
    const handle = await open(
      join(path, name!),
      constants.O_RDONLY | constants.O_NOFOLLOW | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
    );
    let raw: unknown;
    try {
      if (!(await handle.stat()).isFile()) return { state: "directory", entries, owner: "unavailable" };
      const bytes = Buffer.alloc(2049);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 2048) return { state: "directory", entries, owner: "unavailable" };
      raw = JSON.parse(bytes.subarray(0, bytesRead).toString());
    } finally {
      await handle.close();
    }
    const parsed = z
      .object({ pid: z.number().int().positive(), at: z.number().finite(), host: z.string() })
      .safeParse(raw);
    if (!parsed.success) return { state: "directory", entries, owner: "unavailable" };
    const { pid, at, host } = parsed.data;
    const sameHost = host === hostname();
    let alive: boolean | "unknown" = "unknown";
    if (sameHost) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown";
      }
    }
    return {
      state: "directory",
      entries,
      owner: {
        sameHost,
        alive,
        ageMs: Math.round(Date.now() - at),
        previousDaemon: pid === previousPid,
        currentDaemon: pid === currentPid,
      },
    };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable" };
  }
}
