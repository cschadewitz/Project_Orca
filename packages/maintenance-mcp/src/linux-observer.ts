/** Opt-in fixed Linux observations; unresolved user-manager identities refuse service/log reads. */
import { z } from "zod";
import type { ObservationAdapter, ReadBudget, ReadRequest } from "./adapter.js";
import { HostObservation, LogRecord, ServiceObservation } from "./contracts.js";
import { POLICY, SERVICES, type ServiceAlias } from "./policy.js";
import { Acquisition, linuxObserverIO, SourceError, type ObserverIO, type UnitSource } from "./observer-io.js";

function text(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function encode(value: unknown, acquisition: Acquisition) {
  acquisition.check();
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > acquisition.budget.maxBytes) throw new SourceError("oversized_source");
  return bytes;
}
async function boot(io: ObserverIO, acquisition: Acquisition) {
  acquisition.check();
  const value = text(await io.kernel("boot", acquisition)).trim();
  acquisition.check();
  if (!z.uuid().safeParse(value).success) throw new SourceError("invalid_source");
  return value;
}
function safeCount(value: bigint) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new SourceError("invalid_source");
  return Number(value);
}

export class LinuxObservationAdapter implements ObservationAdapter {
  readonly sourceMode = "fixed_linux_preparation" as const;
  // Trusted seam only, never selected through MCP arguments, environment or launcher flags.
  constructor(private readonly io: ObserverIO = linuxObserverIO) {}
  async read(request: ReadRequest, budget: ReadBudget): Promise<Uint8Array | null> {
    const acquisition = new Acquisition(budget);
    acquisition.check();
    if (this.io.platform() !== "linux") return null;
    if (request.host !== "agent-01") throw new SourceError("invalid_source");
    if (request.kind !== "host") {
      const identity = POLICY.services.find((item) => item.alias === request.service);
      // No system-manager/root/other-user fallback. Foreground ORCA never has an inferred unit.
      if (
        !identity ||
        identity.configuredManager !== "user" ||
        identity.configuredUid === null ||
        identity.configuredUnit !== `${request.service}.service` ||
        request.service === "orca-daemon"
      )
        return null;
      return readUserUnit(
        this.io,
        request.kind === "logs" ? "logs" : "health",
        request.service,
        identity.configuredUid,
        acquisition,
      );
    }
    if (request.mount !== "root") throw new SourceError("invalid_source");
    const bootId = await boot(this.io, acquisition);
    const uptime = text(await this.io.kernel("uptime", acquisition));
    if (!/^\d+(?:\.\d+)? \d+(?:\.\d+)?\n?$/.test(uptime)) throw new SourceError("invalid_source");
    const memory = text(await this.io.kernel("memory", acquisition));
    const memoryValue = (key: string) => {
      const lines = memory.split("\n").filter((line) => line.startsWith(`${key}:`));
      const match = lines.length === 1 ? new RegExp(`^${key}:[ \\t]+(\\d+) kB$`).exec(lines[0]!) : null;
      if (!match) throw new SourceError("invalid_source");
      return safeCount(BigInt(match[1]!) * 1024n);
    };
    const root = await this.io.root(acquisition);
    if ((await boot(this.io, acquisition)) !== bootId) throw new SourceError("invalid_source");
    const observation = HostObservation.safeParse({
      observedAt: new Date().toISOString(),
      bootId,
      uptimeSeconds: Math.floor(Number(uptime.split(" ")[0])),
      memoryTotalBytes: memoryValue("MemTotal"),
      memoryAvailableBytes: memoryValue("MemAvailable"),
      rootTotalBytes: safeCount(root.totalBytes),
      rootAvailableBytes: safeCount(root.availableBytes),
    });
    if (!observation.success) throw new SourceError("invalid_source");
    return encode(observation.data, acquisition);
  }
}

/** Internal source preparation API: fixed aliases; approved UID must equal the unprivileged observer. */
export async function readUserUnit(
  io: ObserverIO,
  source: UnitSource,
  service: ServiceAlias,
  approvedUid: number,
  acquisition: Acquisition,
): Promise<Uint8Array | null> {
  acquisition.check();
  if (
    io.platform() !== "linux" ||
    !Number.isSafeInteger(approvedUid) ||
    approvedUid <= 0 ||
    io.uid() !== approvedUid ||
    !SERVICES.includes(service) ||
    service === "orca-daemon" ||
    (source !== "health" && source !== "logs")
  )
    return null;
  const bootId = await boot(io, acquisition);
  // Capture the log window's end before acquisition; a slow read must not make old data fresh.
  const observedAt = new Date().toISOString();
  const raw = text(await io.unit(source, service, approvedUid, bootId.replaceAll("-", ""), acquisition));
  if ((await boot(io, acquisition)) !== bootId) throw new SourceError("invalid_source");
  if (source === "health") {
    const fields = raw.trim().split("\n");
    if (
      fields.length !== 3 ||
      fields.some((field) => field.split("=").length !== 2) ||
      new Set(fields.map((field) => field.split("=")[0])).size !== 3
    )
      throw new SourceError("invalid_source");
    const values = Object.fromEntries(fields.map((field) => field.split("=")));
    if (values.Id !== `${service}.service` || values.LoadState !== "loaded") throw new SourceError("invalid_source");
    const observation = ServiceObservation.safeParse({ observedAt, state: values.ActiveState });
    if (!observation.success) throw new SourceError("invalid_source");
    return encode(observation.data, acquisition);
  }
  const lines = raw === "" ? [] : raw.trimEnd().split("\n");
  if (lines.length > acquisition.budget.maxRecords) throw new SourceError("oversized_source");
  const records = lines.map((line) => {
    const row: unknown = JSON.parse(line);
    const target = z
      .object({
        _UID: z.literal(String(approvedUid)),
        _BOOT_ID: z.literal(bootId.replaceAll("-", "")),
        _SYSTEMD_USER_UNIT: z.literal(`${service}.service`),
      })
      .safeParse(row);
    if (!target.success) throw new SourceError("invalid_source");
    const fields = row as Record<string, unknown>;
    const timestamp = fields.__REALTIME_TIMESTAMP;
    if (typeof timestamp !== "string" || !/^\d{1,17}$/.test(timestamp)) return null;
    const ms = Number(BigInt(timestamp) / 1000n);
    if (ms > 8640000000000000) return null;
    const category = fields.ORCA_MAINTENANCE_CATEGORY;
    const percent = fields.ORCA_MAINTENANCE_USED_PERCENT;
    const safe = LogRecord.safeParse({
      observedAt: new Date(ms).toISOString(),
      category,
      ...(category === "lifecycle" ? { state: fields.ORCA_MAINTENANCE_STATE } : {}),
      ...(category === "readiness"
        ? {
            ready:
              fields.ORCA_MAINTENANCE_READY === "true"
                ? true
                : fields.ORCA_MAINTENANCE_READY === "false"
                  ? false
                  : null,
          }
        : {}),
      ...(category === "resource"
        ? {
            resource: fields.ORCA_MAINTENANCE_RESOURCE,
            usedPercent:
              typeof percent === "string" && /^(?:\d{1,3})(?:\.\d+)?$/.test(percent) ? Number(percent) : null,
          }
        : {}),
    });
    // Message bodies, paths, cursors, PID, argv and unknown fields never leave this boundary.
    return safe.success ? safe.data : null;
  });
  return encode({ observedAt, records, truncated: lines.length === acquisition.budget.maxRecords }, acquisition);
}
