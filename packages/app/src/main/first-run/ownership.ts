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
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  WriterSchema,
  FenceBootSchema,
  fenceBoot,
  firstRunLayout,
  holdsFirstRunOwnership,
} from "@orca/protocol/first-run-fence";
import type { HelloResult } from "@orca/protocol";
import type { BundledDaemon } from "../daemon-process.js";
import { ConnectionRefusal } from "../connection-target.js";

export const OWNERSHIP_DIRECTORY = ".orca-first-run-ownership";
export const OWNERSHIP_ANCHOR = ".orca-first-run-ownership.json";
export class FirstRunOwnershipRefusal extends ConnectionRefusal {
  constructor(
    cause?: unknown,
    message = "Local startup ownership requires reconciliation. Preserve the selected workspace and its .orca-first-run-ownership evidence. Review same-boot recovery, then reconcile the retained reservation while its writer is quiescent. Retrying or checking a PID cannot clear it. Missing or altered evidence requires operator review; preserve all files.",
  ) {
    super(message, { cause });
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
/** Settled history folded out of the journal: the claim chain head and effective config it ended on. */
const checkpointSchema = z
  .object({
    version: z.literal(1),
    authority: z.literal("settled-history-compaction"),
    workspace: directorySchema,
    anchorHash: digest,
    through: z.number().int().positive().max(999999),
    head: digest,
    configHash: digest,
    // Whether any folded attempt was settled by explicit recovery or a person-confirmed end: the CLI keeps such a
    // store's continuations parked.
    recovered: z.boolean(),
    // The reservation that wrote it. Its attempt follows `through` and is retained until a later checkpoint.
    reservationId: z.string().uuid(),
  })
  .strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
/** A person's confirmation that an attempt claimed on an earlier boot of this host ended. Never written automatically:
 * a restart ends every process of that boot, but only the person knows the session is over and its work may wait. */
export const REBOOT_SETTLEMENT = "ended-after-reboot.json";
export const rebootSettlementSchema = z
  .object({
    version: z.literal(1),
    reservationId: z.string().uuid(),
    claimHash: digest,
    anchorHash: digest,
    // Every other record of the attempt as confirmed, so nothing can be added to it afterwards.
    evidenceHash: digest,
    configHash: digest,
    store: directorySchema.nullable(),
    // The boot it was confirmed on: the claim's host, a later boot.
    boot: FenceBootSchema,
    reason: z.literal("person-confirmed-after-reboot"),
    observation: z.literal("fence-free-after-reboot"),
    actor: z.object({ kind: z.literal("person"), surface: z.literal("desktop-app"), uid: z.string() }).strict(),
  })
  .strict();
const ATTEMPT = /^[0-9]{6}$/;
const CHECKPOINT = /^checkpoint-([0-9]{6})\.json$/;
// Inert compaction state: a checkpoint not yet renamed into place, and folded attempts awaiting removal.
const PENDING = /^checkpoint-[0-9]{6}\.pending$/;
const DISCARDED = /^discarded-([0-9]{6})$/;
const pad = (number: number) => String(number).padStart(6, "0");
/** A reservation folds settled history once more attempts than this follow the last checkpoint… */
const COMPACT_AT = 64;
/** …keeping this many of the newest settled attempts besides its own. */
const RETAINED = 16;
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
  /** This reservation, and the hash of the claim it wrote: what an updater stop hands off. */
  readonly reservationId: string;
  readonly claimHash: string;
  /** The claim this reservation's directly follows in the journal (`claim.previous`), if any. */
  readonly previous?: string | null;
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
    if (holdsFirstRunOwnership(current)) refuse();
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

/** Read-only bounded inspection. Only the final intact attempt may be unsettled.
 * Settled history before the newest checkpoint may be folded away; the retained chain must continue from its head and
 * effective config. Folded attempts an interrupted compaction left behind must still verify and end on that head. */
export function inspectFirstRunOwnership(path: string, allowUnsettled = false, allowChangedConfig = false) {
  try {
    if (resolve(path) !== path) return refuse();
    const workspace = directory(path);
    const root = directory(firstRunLayout(path).journal, workspace);
    const anchorText = read(firstRunLayout(path).anchor, workspace);
    const anchor = anchorSchema.parse(JSON.parse(anchorText));
    if (!sameDirectory(anchor.workspace, workspace) || !sameDirectory(anchor.journal, root)) return refuse();
    const configHash = hash(read(firstRunLayout(path).config, workspace, 1024 * 1024));
    const names = readdirSync(root.path).sort();
    // Bounds this read. Compaction keeps a journal far below it; one that reached the former limit of 256 attempts
    // still reads, so its next reservation can fold it.
    if (names.length > 512) return refuse();
    const attempts = names.filter((name) => ATTEMPT.test(name));
    const checkpoints = names.filter((name) => CHECKPOINT.test(name));
    if (
      names.some(
        (name) => !ATTEMPT.test(name) && !CHECKPOINT.test(name) && !PENDING.test(name) && !DISCARDED.test(name),
      )
    )
      return refuse();
    let checkpoint: Checkpoint | undefined;
    for (const name of checkpoints) {
      const parsed = checkpointSchema.parse(JSON.parse(read(join(root.path, name), root)));
      if (
        name !== `checkpoint-${pad(parsed.through)}.json` ||
        parsed.anchorHash !== hash(anchorText) ||
        !sameDirectory(parsed.workspace, workspace)
      )
        return refuse();
      checkpoint = parsed; // Sorted by number: the newest checkpoint is the last.
    }
    const through = checkpoint?.through ?? 0;
    if (names.some((name) => Number(DISCARDED.exec(name)?.[1] ?? 0) > through)) return refuse();
    const first = attempts.length ? Number(attempts[0]) : through + 1;
    // History starts at 000001 or right after the checkpoint; anything it folded may remain only up to its head.
    if (first < 1 || first > through + 1 || (first <= through && Number(attempts.at(-1)) < through)) return refuse();
    let previous: string | null = first === through + 1 && checkpoint ? checkpoint.head : null;
    let effectiveHash: string | undefined = first === through + 1 ? checkpoint?.configHash : undefined;
    let compactor = !checkpoint;
    let latest:
      { attempt: Directory; reservationId: string; texts: Record<string, string>; settled: boolean } | undefined;
    const history: {
      name: string;
      number: number;
      reservationId: string;
      claimHash: string;
      effectiveHash: string;
      recovered: boolean;
    }[] = [];
    for (const [index, name] of attempts.entries()) {
      const number = first + index;
      if (name !== pad(number)) return refuse();
      // Left by an interrupted compaction: its predecessor is already folded, so its link is checked at the head.
      const unanchored = index === 0 && number > 1 && number <= through;
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
        REBOOT_SETTLEMENT,
      ]);
      const bindings = entries.filter((entry) => /^config-rebind-[0-9]{6}\.json$/.test(entry));
      if (bindings.length > 32 || entries.some((entry) => !allowed.has(entry) && !bindings.includes(entry)))
        return refuse();
      const texts = Object.fromEntries(entries.map((entry) => [entry, read(join(attempt.path, entry), attempt)]));
      const claim = claimSchema.parse(JSON.parse(texts["claim.json"]!));
      if (
        !sameDirectory(claim.workspace, workspace) ||
        (!unanchored &&
          (claim.previous !== previous || (effectiveHash !== undefined && claim.configHash !== effectiveHash)))
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
          writer.store.path !== firstRunLayout(path).store ||
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
      if (texts[REBOOT_SETTLEMENT]) {
        const ended = rebootSettlementSchema.parse(JSON.parse(texts[REBOOT_SETTLEMENT]));
        if (
          settled ||
          claim.version !== 2 ||
          ended.reservationId !== claim.reservationId ||
          ended.claimHash !== hash(texts["claim.json"]!) ||
          ended.anchorHash !== hash(anchorText) ||
          ended.evidenceHash !== rebootEvidenceHash(texts) ||
          ended.configHash !== effectiveHash ||
          ended.boot.hostHash !== claim.boot?.hostHash ||
          ended.boot.bootId === claim.boot.bootId ||
          ended.actor.uid !== workspace.uid
        )
          return refuse();
        settled = true;
      }
      if (!settled && (!allowUnsettled || index !== attempts.length - 1)) return refuse();
      latest = { attempt, reservationId: claim.reservationId, texts, settled };
      previous = hash(texts["claim.json"]!);
      const recovered = !!texts["recovery.json"] || !!texts[REBOOT_SETTLEMENT];
      if (checkpoint && number <= through && recovered && !checkpoint.recovered) return refuse();
      if (checkpoint && number === through && (previous !== checkpoint.head || effectiveHash !== checkpoint.configHash))
        return refuse();
      if (checkpoint && number > through && claim.reservationId === checkpoint.reservationId) compactor = true;
      history.push({ name, number, reservationId: claim.reservationId, claimHash: previous, effectiveHash, recovered });
    }
    // Deleting the retained tail after a checkpoint would otherwise go unnoticed.
    if (!compactor) return refuse();
    if (!allowChangedConfig && effectiveHash !== undefined && effectiveHash !== configHash) return refuse();
    const next = first + attempts.length;
    return {
      workspace,
      root,
      anchorText,
      names,
      previous,
      latest,
      configHash,
      effectiveHash,
      checkpoint,
      history,
      next,
    };
  } catch {
    return refuse();
  }
}
export function rebootEvidenceHash(texts: Record<string, string>): string {
  return hash(
    JSON.stringify(
      Object.entries(texts)
        .filter(([name]) => name !== REBOOT_SETTLEMENT)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
export function recoveryEvidenceHash(texts: Record<string, string>): string {
  return hash(
    JSON.stringify(
      Object.entries(texts)
        // A request left pending at a restart is resolved by the later settlement, which therefore follows it.
        .filter(([name]) => name !== "recovery-request.json" && name !== "recovery.json" && name !== REBOOT_SETTLEMENT)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/** Fold settled history into one checkpoint and remove what it folds, so the journal stays bounded.
 * Only a reservation that has just written its claim calls this. Its exclusive attempt directory is the journal's
 * append position, so no other reservation or compaction runs until it settles, and every earlier attempt is
 * settled (strict inspection preceded it). Its own unsettled attempt is never folded. Each step leaves a journal
 * that verifies: the checkpoint is renamed into place whole, then folded attempts leave oldest first. */
function compactSettledHistory(path: string, reservationId: string): void {
  const { root, workspace, anchorText, checkpoint, history, latest } = inspectFirstRunOwnership(path, true);
  if (latest?.reservationId !== reservationId || latest.settled) return refuse();
  let through = checkpoint?.through ?? 0;
  const following = history.filter((attempt) => attempt.number > through);
  if (following.length > COMPACT_AT) {
    const head = following[following.length - RETAINED - 2]!;
    through = head.number;
    const pending = join(root.path, `checkpoint-${pad(through)}.pending`);
    const target = join(root.path, `checkpoint-${pad(through)}.json`);
    const value: Checkpoint = {
      version: 1,
      authority: "settled-history-compaction",
      workspace,
      anchorHash: hash(anchorText),
      through,
      head: head.claimHash,
      configHash: head.effectiveHash,
      recovered: !!checkpoint?.recovered || history.some((attempt) => attempt.number <= through && attempt.recovered),
      reservationId,
    };
    if (!absent(pending) || !absent(target)) return refuse();
    write(pending, JSON.stringify(checkpointSchema.parse(value)) + "\n", root);
    renameSync(pending, target);
    syncDirectory(root.path);
  }
  for (const attempt of history)
    if (attempt.number <= through)
      renameSync(join(root.path, attempt.name), join(root.path, `discarded-${attempt.name}`));
  syncDirectory(root.path);
  for (const name of readdirSync(root.path)) {
    if (DISCARDED.test(name)) rmSync(join(root.path, name), { recursive: true });
    else if (PENDING.test(name) || (CHECKPOINT.test(name) && name !== `checkpoint-${pad(through)}.json`))
      unlinkSync(join(root.path, name));
  }
  syncDirectory(root.path);
}

export function reserveFirstRunOwnership(path: string): FirstRunOwnership {
  try {
    if (resolve(path) !== path) return refuse();
    const workspace = directory(path);
    let configHash = hash(read(firstRunLayout(path).config, workspace, 1024 * 1024));
    const rootPath = firstRunLayout(path).journal;
    const anchorPath = firstRunLayout(path).anchor;
    if (absent(rootPath)) {
      // Pre-ledger or lost-ledger runtime state is uncertain. Do not silently migrate/adopt it.
      if (!absent(anchorPath) || !absent(firstRunLayout(path).store) || !absent(join(path, "auth"))) return refuse();
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
    const { previous, next } = inspectFirstRunOwnership(path);
    const attemptName = pad(next);
    const attemptPath = join(rootPath, attemptName);
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
      store: absent(firstRunLayout(path).store) ? null : directory(firstRunLayout(path).store, workspace),
    });
    try {
      compactSettledHistory(path, reservationId);
    } catch {
      // An interrupted compaction still verifies, and the next reservation finishes it. Never block startup on it.
    }
    const journal = inspectFirstRunOwnership(path, true);
    if (journal.latest?.reservationId !== reservationId) return refuse();
    const names = journal.names.filter((name) => name !== attemptName);
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
            !sameDirectory(writer.store, directory(firstRunLayout(path).store, workspace)) ||
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
          readdirSync(rootPath).sort().join(",") !== [...names, attemptName].sort().join(",") ||
          readdirSync(attemptPath).sort().join(",") !== [...texts.keys()].sort().join(",") ||
          (checkConfig && hash(read(firstRunLayout(path).config, workspace, 1024 * 1024)) !== configHash)
        )
          return refuse();
        for (const [name, text] of texts) if (read(join(attemptPath, name), attempt) !== text) return refuse();
      } catch {
        refuse();
      }
    };
    return {
      reservationId,
      claimHash: hash(texts.get("claim.json")!),
      previous,
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
          hash(read(firstRunLayout(path).config, workspace, 1024 * 1024)) !== savedHash
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
          hello.storeDir !== firstRunLayout(path).store
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
