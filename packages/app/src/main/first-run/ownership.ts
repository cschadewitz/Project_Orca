/** Append-only, store-local startup reservations. Only the captured direct child can settle one. */
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
import type { HelloResult } from "@orca/protocol";
import type { BundledDaemon } from "../daemon-process.js";
import { ConnectionRefusal } from "../connection-target.js";

export const OWNERSHIP_DIRECTORY = ".orca-first-run-ownership";
export const OWNERSHIP_ANCHOR = ".orca-first-run-ownership.json";
export class FirstRunOwnershipRefusal extends ConnectionRefusal {
  constructor(cause?: unknown) {
    super(
      "Local startup ownership requires reconciliation. Preserve the selected workspace and its .orca-first-run-ownership evidence. This app has no supported orphan reconciliation action; restarting, retrying or checking a PID cannot clear it. Use a separately reviewed fresh empty app workspace for new work, or obtain an operator recovery decision for this store.",
      { cause },
    );
  }
}
const refuse = (): never => {
  throw new FirstRunOwnershipRefusal();
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const directorySchema = z.object({ path: z.string(), dev: z.string(), ino: z.string(), uid: z.string() }).strict();
const anchorSchema = z.object({ version: z.literal(1), workspace: directorySchema, journal: directorySchema }).strict();
const claimSchema = z
  .object({
    version: z.literal(1),
    reservationId: z.string().uuid(),
    workspace: directorySchema,
    configHash: digest,
    previous: digest.nullable(),
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
  })
  .strict();
type Directory = z.infer<typeof directorySchema>;
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    return refuse();
  }
}
function directory(path: string, parent?: Directory): Directory {
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
function sameDirectory(a: Directory, b: Directory): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function read(path: string, parent: Directory): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd, { bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      String(info.dev) !== parent.dev ||
      String(info.uid) !== parent.uid ||
      info.size > 4096n
    )
      return refuse();
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function write(path: string, text: string, parent: Directory): void {
  directory(parent.path, parent);
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

export function reserveFirstRunOwnership(path: string): FirstRunOwnership {
  try {
    if (resolve(path) !== path) return refuse();
    const workspace = directory(path);
    const configHash = hash(read(join(path, "orca.config.yaml"), workspace));
    const rootPath = join(path, OWNERSHIP_DIRECTORY);
    const anchorPath = join(path, OWNERSHIP_ANCHOR);
    if (absent(rootPath)) {
      // Pre-ledger or lost-ledger runtime state is uncertain. Do not silently migrate/adopt it.
      if (!absent(anchorPath) || !absent(join(path, ".orca")) || !absent(join(path, "auth"))) return refuse();
      mkdirSync(rootPath, { mode: 0o700 });
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
    const names = readdirSync(rootPath).sort();
    // Bounded synchronous inspection; exhaustion requires an explicit archival/recovery decision.
    if (names.length >= 256) return refuse();
    let previous: string | null = null;
    for (const [index, name] of names.entries()) {
      if (name !== String(index + 1).padStart(6, "0")) return refuse();
      const attempt = directory(join(rootPath, name), root);
      const entries = readdirSync(attempt.path).sort();
      if (
        entries.join(",") !== "child.json,claim.json,terminal.json" &&
        entries.join(",") !== "child.json,claim.json,identity.json,terminal.json"
      )
        return refuse();
      const claimText = read(join(attempt.path, "claim.json"), attempt);
      const claim = claimSchema.parse(JSON.parse(claimText));
      const childText = read(join(attempt.path, "child.json"), attempt);
      const child = childSchema.parse(JSON.parse(childText));
      const identityText = entries.includes("identity.json")
        ? read(join(attempt.path, "identity.json"), attempt)
        : null;
      const identity = identityText ? identitySchema.parse(JSON.parse(identityText)) : undefined;
      const terminal = terminalSchema.parse(JSON.parse(read(join(attempt.path, "terminal.json"), attempt)));
      if (
        !sameDirectory(claim.workspace, workspace) ||
        claim.configHash !== configHash ||
        claim.previous !== previous ||
        child.reservationId !== claim.reservationId ||
        terminal.reservationId !== claim.reservationId ||
        (identity && identity.reservationId !== claim.reservationId) ||
        terminal.childHash !== hash(childText) ||
        terminal.identityHash !== (identityText ? hash(identityText) : null)
      )
        return refuse();
      previous = hash(claimText);
    }
    const attemptPath = join(rootPath, String(names.length + 1).padStart(6, "0"));
    // Exclusive mkdir is arbitration, not a PID-based lock with stale-owner removal.
    mkdirSync(attemptPath, { mode: 0o700 });
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
    put("claim.json", { version: 1, reservationId, workspace, configHash, previous });
    let child: BundledDaemon | undefined;
    let completed = false;
    const check = () => {
      try {
        if (
          !sameDirectory(workspace, directory(path)) ||
          !sameDirectory(root, directory(rootPath, workspace)) ||
          !sameDirectory(attempt, directory(attemptPath, root)) ||
          read(anchorPath, workspace) !== anchorText ||
          readdirSync(rootPath).sort().join(",") !== [...names, String(names.length + 1).padStart(6, "0")].join(",") ||
          readdirSync(attemptPath).sort().join(",") !== [...texts.keys()].sort().join(",") ||
          hash(read(join(path, "orca.config.yaml"), workspace)) !== configHash
        )
          return refuse();
        for (const [name, text] of texts) if (read(join(attemptPath, name), attempt) !== text) return refuse();
      } catch {
        refuse();
      }
    };
    return {
      check,
      attach: (owned) => {
        check();
        if (child || completed) return refuse();
        child = owned;
        put("child.json", {
          reservationId,
          processId: Number.isSafeInteger(owned.pid) && owned.pid! > 0 ? owned.pid : null,
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
        });
        completed = true;
        return true;
      },
    };
  } catch {
    return refuse();
  }
}
