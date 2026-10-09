/** Append-only startup reservations; direct-child exit or exclusive same-boot writer fencing settles ownership. */
import { windowsDirectory, windowsRead, windowsWrite, windowsPrivateChild } from "@orca/protocol/first-run-fence";

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { WriterSchema, FenceBootSchema, fenceBoot } from "@orca/protocol/first-run-fence";
import type { HelloResult } from "@orca/protocol";
import type { BundledDaemon } from "../daemon-process.js";
import { ConnectionRefusal } from "../connection-target.js";

export const OWNERSHIP_DIRECTORY = ".orca-first-run-ownership";
export const OWNERSHIP_ANCHOR = ".orca-first-run-ownership.json";
export class FirstRunOwnershipRefusal extends ConnectionRefusal {
  constructor(cause?: unknown) {
    super(
      "Local startup ownership requires reconciliation. Preserve the selected workspace and its .orca-first-run-ownership evidence. Review same-boot recovery, then reconcile the retained reservation while its writer is quiescent. Retrying or checking a PID cannot clear it. Missing or altered evidence requires operator review; preserve all files.",
      { cause },
    );
  }
}
export const refuse = (): never => {
  throw new FirstRunOwnershipRefusal();
};
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const directorySchema = z
  .object({ path: z.string(), dev: z.string(), ino: z.string(), uid: z.string() })
  .strict();
const anchorSchema = z.object({ version: z.literal(1), workspace: directorySchema, journal: directorySchema }).strict();
const claimSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    reservationId: z.string().uuid(),
    workspace: directorySchema,
    configHash: digest,
    previous: digest.nullable(),
    launchHash: digest.optional(),
    fence: z.literal("kernel-lifetime-v1").optional(),
    boot: FenceBootSchema.optional(),
    store: directorySchema.nullable().optional(),
  })
  .strict();
const childSchema = z
  .object({ reservationId: z.string().uuid(), processId: z.number().int().positive().nullable() })
  .strict();
const identitySchema = z
  .object({ reservationId: z.string().uuid(), workspaceId: z.string().uuid(), instanceId: z.string().uuid() })
  .strict();
const terminalSchema = z
  .object({
    reservationId: z.string().uuid(),
    childHash: digest,
    identityHash: digest.nullable(),
    observation: z.literal("direct-child-terminal"),
    configHash: digest.optional(),
  })
  .strict();
export type Directory = z.infer<typeof directorySchema>;
export function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    return refuse();
  }
}
export function directory(path: string, parent?: Directory): Directory {
  if (process.platform === "win32") {
    const identity = windowsDirectory(path);
    if (parent && (identity.dev !== parent.dev || identity.uid !== parent.uid)) return refuse();
    return identity;
  }
  const info = lstatSync(path, { bigint: true });
  if (
    typeof process.getuid !== "function" ||
    !info.isDirectory() ||
    info.ino <= 0n ||
    info.uid !== BigInt(process.getuid()) ||
    realpathSync(path) !== path ||
    (parent && String(info.dev) !== parent.dev)
  )
    return refuse();
  return { path, dev: String(info.dev), ino: String(info.ino), uid: String(info.uid) };
}
export function sameDirectory(a: Directory, b: Directory): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function read(path: string, parent: Directory, limit = 4096): string {
  if (process.platform === "win32") {
    directory(parent.path, parent);
    return windowsRead(path, limit);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd, { bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      String(info.dev) !== parent.dev ||
      String(info.uid) !== parent.uid ||
      info.size > BigInt(limit)
    )
      return refuse();
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") {
    windowsDirectory(path);
    return;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function write(path: string, text: string, parent: Directory): void {
  directory(parent.path, parent);
  if (process.platform === "win32") {
    windowsWrite(path, text);
    return;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(parent.path);
}

export interface FirstRunOwnership {
  check(): void;
  /** Launch capability stays in main and the exact child environment, never in the journal. */
  launchToken?(): string;
  /** Only the surviving exact owner can bind an explicitly reviewed saved config revision. */
  rebindConfig?(expectedHash: string, savedHash: string): void;
  attach(child: BundledDaemon): void;
  verify(hello: HelloResult): void;
  /** Returns false for an unobserved exit. This is terminal evidence, never clean updater-stop proof. */
  complete(): boolean;
}

/** Legacy/read-only starts must not bypass a first-run reservation, even in another app profile. */
export function assertNoFirstRunOwnership(path: string): void {
  // Legacy config discovery walks upward; a nested cwd or symlink must not evade the fence.
  let current = resolve(path);
  for (let depth = 0; depth < 256; depth++) {
    if (!absent(join(current, OWNERSHIP_DIRECTORY)) || !absent(join(current, OWNERSHIP_ANCHOR))) refuse();
    if (!absent(current)) {
      const canonical = realpathSync(current);
      if (canonical !== current) {
        current = canonical;
        continue;
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  refuse();
}

const rebindSchema = z
  .object({
    reservationId: z.string().uuid(),
    previousHash: digest,
    savedHash: digest,
    authority: z.enum(["reviewed-config-read", "reviewed-quiescent-config"]),
  })
  .strict();
export const recoveryRequestSchema = z
  .object({
    version: z.literal(2),
    requestId: z.string().uuid(),
    reservationId: z.string().uuid(),
    anchorHash: digest,
    evidenceHash: digest,
    configHash: digest,
    store: directorySchema.nullable(),
    writerHash: digest.nullable(),
    authority: z.literal("explicit-same-boot-fence"),
  })
  .strict();
export const recoveryResolutionSchema = z
  .object({
    requestHash: digest,
    reservationId: z.string().uuid(),
    writerHash: digest.nullable(),
    store: directorySchema.nullable(),
    observation: z.literal("exclusive-writer-quiescent"),
  })
  .strict();

/** Read-only bounded inspection. Only the final intact attempt may be unsettled. */
export function inspectFirstRunOwnership(path: string, allowUnsettled = false, allowChangedConfig = false) {
  try {
    if (resolve(path) !== path) return refuse();
    const workspace = directory(path);
    const root = directory(join(path, OWNERSHIP_DIRECTORY), workspace);
    const anchorText = read(join(path, OWNERSHIP_ANCHOR), workspace);
    const anchor = anchorSchema.parse(JSON.parse(anchorText));
    if (!sameDirectory(anchor.workspace, workspace) || !sameDirectory(anchor.journal, root)) return refuse();
    const configHash = hash(read(join(path, "orca.config.yaml"), workspace, 1024 * 1024));
    const names = readdirSync(root.path).sort();
    if (names.length >= 256) return refuse();
    let previous: string | null = null;
    let effectiveHash: string | undefined;
    let latest:
      { attempt: Directory; reservationId: string; texts: Record<string, string>; settled: boolean } | undefined;
    for (const [index, name] of names.entries()) {
      if (name !== String(index + 1).padStart(6, "0")) return refuse();
      const attempt = directory(join(root.path, name), root);
      const entries = readdirSync(attempt.path).sort();
      const allowed = new Set([
        "claim.json",
        "child.json",
        "identity.json",
        "writer.json",
        "terminal.json",
        "recovery-request.json",
        "recovery.json",
      ]);
      const bindings = entries.filter((entry) => /^config-rebind-[0-9]{6}\.json$/.test(entry));
      if (bindings.length > 32 || entries.some((entry) => !allowed.has(entry) && !bindings.includes(entry)))
        return refuse();
      const texts = Object.fromEntries(entries.map((entry) => [entry, read(join(attempt.path, entry), attempt)]));
      const claim = claimSchema.parse(JSON.parse(texts["claim.json"]!));
      if (
        !sameDirectory(claim.workspace, workspace) ||
        claim.previous !== previous ||
        (effectiveHash !== undefined && claim.configHash !== effectiveHash)
      )
        return refuse();
      if (claim.version === 2 && (!claim.launchHash || !claim.fence || !claim.boot || claim.store === undefined))
        return refuse();
      if (process.platform === "win32" && claim.version !== 2) return refuse();
      if (claim.version === 1 && (claim.launchHash || claim.fence || claim.boot || claim.store !== undefined))
        return refuse();
      effectiveHash = claim.configHash;
      for (const [i, binding] of bindings.entries()) {
        if (binding !== `config-rebind-${String(i + 1).padStart(6, "0")}.json`) return refuse();
        const rebound = rebindSchema.parse(JSON.parse(texts[binding]!));
        if (rebound.reservationId !== claim.reservationId || rebound.previousHash !== effectiveHash) return refuse();
        effectiveHash = rebound.savedHash;
      }
      const child = texts["child.json"] ? childSchema.parse(JSON.parse(texts["child.json"])) : undefined;
      const identity = texts["identity.json"] ? identitySchema.parse(JSON.parse(texts["identity.json"])) : undefined;
      if (
        (child && child.reservationId !== claim.reservationId) ||
        (identity && (!child || identity.reservationId !== claim.reservationId))
      )
        return refuse();
      const writer = texts["writer.json"] ? WriterSchema.parse(JSON.parse(texts["writer.json"])) : undefined;
      if (
        writer &&
        (claim.version !== 2 ||
          writer.claimHash !== hash(texts["claim.json"]!) ||
          JSON.stringify(claim.boot) !==
            JSON.stringify({ bootId: writer.bootId, hostHash: writer.hostHash, kernelDomain: writer.kernelDomain }) ||
          writer.reservationId !== claim.reservationId ||
          !sameDirectory(writer.workspace, workspace) ||
          writer.store.path !== join(path, ".orca") ||
          writer.store.dev !== workspace.dev ||
          (child && child.processId !== writer.processId))
      )
        return refuse();
      let settled = false;
      if (texts["terminal.json"]) {
        const terminal = terminalSchema.parse(JSON.parse(texts["terminal.json"]));
        if (
          !child ||
          terminal.reservationId !== claim.reservationId ||
          terminal.childHash !== hash(texts["child.json"]!) ||
          terminal.identityHash !== (texts["identity.json"] ? hash(texts["identity.json"]) : null) ||
          (bindings.length && terminal.configHash !== effectiveHash) ||
          (terminal.configHash !== undefined && terminal.configHash !== effectiveHash)
        )
          return refuse();
        settled = true;
      }
      if (texts["recovery-request.json"]) {
        const request = recoveryRequestSchema.parse(JSON.parse(texts["recovery-request.json"]));
        if (
          request.reservationId !== claim.reservationId ||
          request.anchorHash !== hash(anchorText) ||
          request.evidenceHash !== recoveryEvidenceHash(texts) ||
          request.configHash !== effectiveHash ||
          claim.version !== 2 ||
          request.writerHash !== (texts["writer.json"] ? hash(texts["writer.json"]) : null)
        )
          return refuse();
        // A pending explicit request also fences a formerly terminal attempt.
        settled = false;
        if (texts["recovery.json"]) {
          const resolution = recoveryResolutionSchema.parse(JSON.parse(texts["recovery.json"]));
          if (
            resolution.reservationId !== claim.reservationId ||
            resolution.requestHash !== hash(texts["recovery-request.json"]) ||
            resolution.writerHash !== request.writerHash ||
            JSON.stringify(resolution.store) !== JSON.stringify(request.store)
          )
            return refuse();
          settled = true;
        }
      } else if (texts["recovery.json"]) return refuse();
      if (!settled && (!allowUnsettled || index !== names.length - 1)) return refuse();
      latest = { attempt, reservationId: claim.reservationId, texts, settled };
      previous = hash(texts["claim.json"]!);
    }
    if (!allowChangedConfig && effectiveHash !== undefined && effectiveHash !== configHash) return refuse();
    return { workspace, root, anchorText, names, previous, latest, configHash, effectiveHash };
  } catch {
    return refuse();
  }
}
export function recoveryEvidenceHash(texts: Record<string, string>): string {
  return hash(
    JSON.stringify(
      Object.entries(texts)
        .filter(([name]) => name !== "recovery-request.json" && name !== "recovery.json")
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

export function reserveFirstRunOwnership(path: string): FirstRunOwnership {
  try {
    if (resolve(path) !== path) return refuse();
    const workspace = directory(path);
    let configHash = hash(read(join(path, "orca.config.yaml"), workspace, 1024 * 1024));
    const rootPath = join(path, OWNERSHIP_DIRECTORY);
    const anchorPath = join(path, OWNERSHIP_ANCHOR);
    if (absent(rootPath)) {
      // Pre-ledger or lost-ledger runtime state is uncertain. Do not silently migrate/adopt it.
      if (!absent(anchorPath) || !absent(join(path, ".orca")) || !absent(join(path, "auth"))) return refuse();
      if (process.platform === "win32") windowsPrivateChild(rootPath);
      else mkdirSync(rootPath, { mode: 0o700 });
      syncDirectory(path);
      write(
        anchorPath,
        JSON.stringify({ version: 1, workspace, journal: directory(rootPath, workspace) }) + "\n",
        workspace,
      );
    }
    const root = directory(rootPath, workspace);
    const anchorText = read(anchorPath, workspace);
    const anchor = anchorSchema.parse(JSON.parse(anchorText));
    if (!sameDirectory(anchor.workspace, workspace) || !sameDirectory(anchor.journal, root)) return refuse();
    const inspected = inspectFirstRunOwnership(path);
    const { names, previous } = inspected;
    const attemptPath = join(rootPath, String(names.length + 1).padStart(6, "0"));
    // Exclusive mkdir is arbitration, not a PID-based lock with stale-owner removal.
    if (process.platform === "win32") windowsPrivateChild(attemptPath);
    else mkdirSync(attemptPath, { mode: 0o700 });
    syncDirectory(rootPath);
    const attempt = directory(attemptPath, root);
    const reservationId = randomUUID();
    const texts = new Map<string, string>();
    const put = (name: string, value: unknown) => {
      const text = JSON.stringify(value) + "\n";
      try {
        write(join(attemptPath, name), text, attempt);
      } catch {
        return refuse();
      }
      texts.set(name, text);
    };
    const launchToken = randomUUID();
    put("claim.json", {
      version: 2,
      reservationId,
      workspace,
      configHash,
      previous,
      launchHash: hash(launchToken),
      fence: "kernel-lifetime-v1",
      boot: fenceBoot(),
      store: absent(join(path, ".orca")) ? null : directory(join(path, ".orca"), workspace),
    });
    let child: BundledDaemon | undefined;
    let completed = false;
    const check = (checkConfig = true) => {
      try {
        const writerPath = join(attemptPath, "writer.json");
        if (!texts.has("writer.json") && !absent(writerPath)) {
          const text = read(writerPath, attempt);
          const writer = WriterSchema.parse(JSON.parse(text));
          if (
            writer.reservationId !== reservationId ||
            writer.claimHash !== hash(texts.get("claim.json")!) ||
            JSON.stringify({ bootId: writer.bootId, hostHash: writer.hostHash, kernelDomain: writer.kernelDomain }) !==
              JSON.stringify(fenceBoot()) ||
            !sameDirectory(writer.workspace, workspace) ||
            !sameDirectory(writer.store, directory(join(path, ".orca"), workspace)) ||
            (child && writer.processId !== child.pid)
          )
            return refuse();
          texts.set("writer.json", text);
        }
        if (
          !sameDirectory(workspace, directory(path)) ||
          !sameDirectory(root, directory(rootPath, workspace)) ||
          !sameDirectory(attempt, directory(attemptPath, root)) ||
          read(anchorPath, workspace) !== anchorText ||
          readdirSync(rootPath).sort().join(",") !== [...names, String(names.length + 1).padStart(6, "0")].join(",") ||
          readdirSync(attemptPath).sort().join(",") !== [...texts.keys()].sort().join(",") ||
          (checkConfig && hash(read(join(path, "orca.config.yaml"), workspace, 1024 * 1024)) !== configHash)
        )
          return refuse();
        for (const [name, text] of texts) if (read(join(attemptPath, name), attempt) !== text) return refuse();
      } catch {
        refuse();
      }
    };
    return {
      check,
      launchToken: () => {
        check();
        return launchToken;
      },
      rebindConfig: (expectedHash, savedHash) => {
        check(false);
        if (
          completed ||
          !child ||
          child.exited === true ||
          configHash !== expectedHash ||
          hash(read(join(path, "orca.config.yaml"), workspace, 1024 * 1024)) !== savedHash
        )
          return refuse();
        digest.parse(savedHash);
        const count = [...texts.keys()].filter((name) => name.startsWith("config-rebind-")).length;
        if (count >= 32) return refuse();
        put(`config-rebind-${String(count + 1).padStart(6, "0")}.json`, {
          reservationId,
          previousHash: configHash,
          savedHash,
          authority: "reviewed-config-read",
        });
        configHash = savedHash;
        check();
      },
      attach: (owned) => {
        check();
        if (child || completed) return refuse();
        const writerText = texts.get("writer.json");
        if (!writerText || WriterSchema.parse(JSON.parse(writerText)).processId !== owned.pid) return refuse();
        child = owned;
        put("child.json", {
          reservationId,
          processId: Number.isSafeInteger(owned.pid) && owned.pid > 0 ? owned.pid : null,
        });
      },
      verify: (hello) => {
        check();
        if (
          completed ||
          !child ||
          child.exited === true ||
          !hello.identity ||
          hello.processId !== child.pid ||
          hello.storeDir !== join(path, ".orca")
        )
          return refuse();
        const value = { reservationId, ...hello.identity };
        const existing = texts.get("identity.json");
        if (existing) {
          if (existing !== JSON.stringify(value) + "\n") return refuse();
        } else put("identity.json", value);
      },
      complete: () => {
        if (completed) return true;
        check();
        if (!child || child.exited !== true) return false;
        if (!texts.has("child.json")) return refuse();
        put("terminal.json", {
          reservationId,
          childHash: hash(texts.get("child.json")!),
          identityHash: texts.has("identity.json") ? hash(texts.get("identity.json")!) : null,
          observation: "direct-child-terminal",
          configHash,
        });
        completed = true;
        return true;
      },
    };
  } catch {
    return refuse();
  }
}
