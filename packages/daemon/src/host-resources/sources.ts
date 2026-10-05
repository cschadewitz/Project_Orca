/** Fixed native source adapters; raw paths and errors stay inside the collector. */
import { endianness } from "node:os";
import { createNativeResourceIo, NativeIoError, type NativeResourceIo } from "./native-io.js";
import type { ResourceReason } from "@orca/protocol";
import { cpusetCount, natural, quota, SourceError } from "./parsers.js";

export interface StorageReading {
  totalBytes: number;
  availableBytes: number;
  device: string;
  backing: "disk" | "tmpfs" | "unknown";
}
type CgroupResult<T> = { ok: true; value: T } | { ok: false; reason: ResourceReason };
export interface CgroupReading {
  cpu: CgroupResult<{
    effectiveCores: number;
    quotaCores: number | null;
    cpusetCores: number;
    scope: "visible-cgroup-hierarchy";
  }>;
  memory: CgroupResult<{
    limitBytes: number | null;
    currentBytes: number;
    headroomBytes: number | null;
    scope: "visible-cgroup-hierarchy";
  }>;
}
export interface HostResourceSources {
  platform: string;
  close?: () => void;
  read: (path: string) => Promise<string>;
  pageSize: () => Promise<number>;
  cgroup: () => Promise<CgroupReading>;
  storage: (path: string) => Promise<StorageReading>;
}
export function failureReason(error: unknown): ResourceReason {
  if (error instanceof SourceError || error instanceof NativeIoError) return error.reason;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  )
    return "permission-denied";
  return "source-failed";
}
/** No process spawning: AT_PAGESZ is supplied by the kernel to this process. */
async function pageSize(io: NativeResourceIo): Promise<number> {
  if (!["x64", "arm64", "riscv64", "ppc64", "s390x", "ia32", "arm"].includes(process.arch))
    throw new SourceError("unsupported-source");
  const word = ["ia32", "arm"].includes(process.arch) ? 4 : 8;
  const bytes = await io.read("/proc/self/auxv");
  const read = (offset: number) =>
    word === 8
      ? Number(endianness() === "LE" ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset))
      : endianness() === "LE"
        ? bytes.readUInt32LE(offset)
        : bytes.readUInt32BE(offset);
  for (let offset = 0; offset + 2 * word <= bytes.length; offset += 2 * word) {
    const key = read(offset);
    if (key === 0) break;
    if (key === 6) {
      const value = read(offset + word);
      if (!Number.isSafeInteger(value) || value < 512 || value > 1_048_576 || !Number.isInteger(Math.log2(value)))
        throw new SourceError("invalid-source");
      return value;
    }
  }
  throw new SourceError("unsupported-source");
}
/** Only the daemon's own cgroup and at most eight visible ancestors are read. */
export async function readCgroup(read: HostResourceSources["read"]): Promise<CgroupReading> {
  const membership = await read("/proc/self/cgroup");
  const matches = membership.trim().split("\n");
  if (matches.length !== 1 || !matches[0]!.startsWith("0::/")) throw new SourceError("unsupported-source");
  const path = matches[0]!.slice(3);
  const parts = path.split("/").filter(Boolean);
  if (path.includes("\\") || parts.some((p) => p === "." || p === ".." || !/^[\w.@:-]+$/.test(p)))
    throw new SourceError("scope-unverified");
  if (parts.length === 0 || parts.length > 8) throw new SourceError("scope-unverified");
  const mounts = (await read("/proc/self/mountinfo")).split("\n").filter((line) => line.includes(" - cgroup2 "));
  if (mounts.length !== 1) throw new SourceError("scope-unverified");
  const fields = mounts[0]!.split(" ");
  // A subtree mount hides ancestor restrictions. A namespace-root membership cannot
  // establish whether parents are hidden. Both remain explicitly unverified.
  if (fields[3] !== "/" || fields[4] !== "/sys/fs/cgroup") throw new SourceError("scope-unverified");
  const roots = Array.from({ length: parts.length + 1 }, (_, i) => {
    const depth = parts.length - i;
    return `/sys/fs/cgroup${depth ? `/${parts.slice(0, depth).join("/")}` : ""}`;
  });
  const missing = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  // Discovery above is shared and fail-closed. Controller failures below affect
  // only their own metric; absent files never imply unlimited capacity.
  const capture = async <T>(operation: () => Promise<T>): Promise<CgroupResult<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, reason: missing(error) ? "unsupported-source" : failureReason(error) };
    }
  };
  const optionalRoot = async (root: string, name: string): Promise<string | undefined> => {
    try {
      return await read(`${root}/${name}`);
    } catch (error) {
      // Namespace roots may expose controls. Only ENOENT permits their absence.
      if (root === "/sys/fs/cgroup" && missing(error)) return undefined;
      throw error;
    }
  };
  const cpu = await capture(async () => {
    let quotaCores: number | null = null,
      cpusetCores = Number.MAX_SAFE_INTEGER;
    for (const root of roots) {
      cpusetCores = Math.min(cpusetCores, cpusetCount(await read(`${root}/cpuset.cpus.effective`)));
      const cpuMax = await optionalRoot(root, "cpu.max");
      if (cpuMax === undefined) continue;
      const q = quota(cpuMax);
      if (q !== null) quotaCores = Math.min(quotaCores ?? q, q);
    }
    return {
      effectiveCores: Math.min(cpusetCores, quotaCores ?? cpusetCores),
      quotaCores,
      cpusetCores,
      scope: "visible-cgroup-hierarchy" as const,
    };
  });
  const memory = await capture(async () => {
    let limitBytes: number | null = null,
      headroomBytes: number | null = null,
      currentBytes = 0;
    for (const root of roots) {
      const memoryMaxText = await optionalRoot(root, "memory.max"),
        memoryCurrent = await optionalRoot(root, "memory.current");
      if (memoryMaxText === undefined && memoryCurrent === undefined) continue;
      if (memoryMaxText === undefined || memoryCurrent === undefined) throw new SourceError("scope-unverified");
      const memoryMax = memoryMaxText.trim();
      const current = natural(memoryCurrent.trim());
      if (root === roots[0]) currentBytes = current;
      if (memoryMax !== "max") {
        const limit = natural(memoryMax);
        limitBytes = Math.min(limitBytes ?? limit, limit);
        headroomBytes = Math.min(headroomBytes ?? limit, Math.max(0, limit - current));
      }
    }
    return { limitBytes, currentBytes, headroomBytes, scope: "visible-cgroup-hierarchy" as const };
  });
  return { cpu, memory };
}
export function nodeHostResourceSources(
  options: { storagePaths?: readonly string[]; io?: NativeResourceIo } = {},
): HostResourceSources {
  const io = options.io ?? createNativeResourceIo(options.storagePaths);
  const read = async (path: string) => (await io.read(path)).toString("utf8");
  return {
    platform: process.platform,
    read,
    pageSize: () => pageSize(io),
    cgroup: () => readCgroup(read),
    storage: (path) => io.storage(path),
    close: () => io.close(),
  };
}
